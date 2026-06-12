"""Generate a local-only personalized Fukui travel plan with Azure OpenAI.

Run from the project root:

Step 1:
    py -m pip install -r requirements-local-ai.txt

Step 2:
    Create .env with:
    AZURE_OPENAI_ENDPOINT=...
    AZURE_OPENAI_API_KEY=...
    AZURE_OPENAI_DEPLOYMENT=gpt-4o
    AZURE_OPENAI_API_VERSION=2025-01-01-preview

Step 3:
    py scripts/generate_azure_travel_plan.py abtest_results/sample.json

This script is local-only. Never expose the .env file or Azure credentials in
browser code or commit them to Git.
"""

from __future__ import annotations

import csv
import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv
except ImportError:
    print(
        "python-dotenv is not installed. Run: py -m pip install python-dotenv",
        file=sys.stderr,
    )
    raise

try:
    from openai import AzureOpenAI
except ImportError:
    print(
        "openai is not installed. Run: py -m pip install openai",
        file=sys.stderr,
    )
    raise

PROJECT_ROOT = Path(__file__).resolve().parents[1]
ENV_PATH = PROJECT_ROOT / ".env"
OUTPUT_DIR = PROJECT_ROOT / "generated_plans"
MAX_SOURCE_CHARS = 12_000
MAX_AB_SECTION_CHARS = 8_000

PROJECT_DATA_PATHS = (
    Path("data/cluster_profiles.json"),
    Path("data/auto_clustering_baseline/auto_cluster_profiles_from_teacher.json"),
    Path("data/auto_clustering_baseline/cluster_summaries.csv"),
    Path("20_top_places.json"),
)

AB_FIELD_GROUPS = {
    "user_answers": (
        "user_answers",
        "useranswers",
        "answers",
        "responses",
        "question_answers",
        "回答",
    ),
    "plan1_recommendations": (
        "plan1",
        "plan_1",
        "recommendations1",
        "recommendations_1",
        "案1",
        "プラン1",
    ),
    "plan2_recommendations": (
        "plan2",
        "plan_2",
        "recommendations2",
        "recommendations_2",
        "案2",
        "プラン2",
    ),
    "scores": ("scores", "score", "ratings", "rating", "評価", "点数"),
    "comparison_choice": (
        "comparison_choice",
        "choice",
        "selected_plan",
        "preferred_plan",
        "winner",
        "選択",
        "比較",
    ),
    "free_comment": (
        "free_comment",
        "freecomment",
        "comment",
        "comments",
        "feedback",
        "自由記述",
        "感想",
    ),
    "baseline_debug": ("baseline_debug", "baselinedebug"),
}


def eprint(message: str) -> None:
    print(message, file=sys.stderr)


def json_text(value: Any, max_chars: int) -> str:
    text = json.dumps(value, ensure_ascii=False, indent=2)
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + "\n...（長いため省略）"


def read_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8-sig") as file:
            return json.load(file)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"JSONの解析に失敗しました: {path} (行 {exc.lineno}, 列 {exc.colno})"
        ) from exc
    except OSError as exc:
        raise ValueError(f"ファイルを読み込めませんでした: {path} ({exc})") from exc


def read_csv_preview(path: Path, max_rows: int = 50) -> list[dict[str, str]]:
    last_error: UnicodeDecodeError | None = None
    for encoding in ("utf-8-sig", "cp932"):
        try:
            with path.open("r", encoding=encoding, newline="") as file:
                return list(csv.DictReader(file))[:max_rows]
        except UnicodeDecodeError as exc:
            last_error = exc
        except OSError as exc:
            raise ValueError(f"ファイルを読み込めませんでした: {path} ({exc})") from exc
    raise ValueError(f"CSVの文字コードを判定できませんでした: {path} ({last_error})")


def load_project_data() -> dict[str, str]:
    loaded: dict[str, str] = {}
    for relative_path in PROJECT_DATA_PATHS:
        path = PROJECT_ROOT / relative_path
        if not path.is_file():
            continue
        try:
            value = read_csv_preview(path) if path.suffix.lower() == ".csv" else read_json(path)
            loaded[relative_path.as_posix()] = json_text(value, MAX_SOURCE_CHARS)
        except ValueError as exc:
            eprint(f"警告: {exc}")

    # Some repository versions keep this file at the project root.
    root_cluster_profiles = PROJECT_ROOT / "cluster_profiles.json"
    if (
        "data/cluster_profiles.json" not in loaded
        and root_cluster_profiles.is_file()
    ):
        try:
            loaded["cluster_profiles.json"] = json_text(
                read_json(root_cluster_profiles), MAX_SOURCE_CHARS
            )
        except ValueError as exc:
            eprint(f"警告: {exc}")
    return loaded


def normalized_key(key: Any) -> str:
    return str(key).strip().lower().replace("-", "_").replace(" ", "_")


def collect_matching_values(
    value: Any, aliases: tuple[str, ...], path: str = "$"
) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    normalized_aliases = tuple(normalized_key(alias) for alias in aliases)

    if isinstance(value, dict):
        for key, child in value.items():
            child_path = f"{path}.{key}"
            key_text = normalized_key(key)
            if any(alias in key_text for alias in normalized_aliases):
                matches.append({"path": child_path, "value": child})
            matches.extend(collect_matching_values(child, aliases, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            matches.extend(collect_matching_values(child, aliases, f"{path}[{index}]"))
    return matches


def extract_ab_test_context(ab_result: Any) -> dict[str, Any]:
    extracted: dict[str, Any] = {}
    for group_name, aliases in AB_FIELD_GROUPS.items():
        matches = collect_matching_values(ab_result, aliases)
        if matches:
            extracted[group_name] = matches
    return extracted


def build_prompt(
    ab_result: Any, extracted: dict[str, Any], project_data: dict[str, str]
) -> str:
    extracted_sections = "\n\n".join(
        f"### {name}\n{json_text(value, MAX_AB_SECTION_CHARS)}"
        for name, value in extracted.items()
    )
    if not extracted_sections:
        extracted_sections = "抽出対象フィールドは見つかりませんでした。元データを参照してください。"

    project_sections = "\n\n".join(
        f"### {name}\n{content}" for name, content in project_data.items()
    )
    if not project_sections:
        project_sections = "利用可能なプロジェクト補助データはありません。"

    return f"""あなたは福井県観光に詳しい旅行プランナーです。
以下のABテスト結果とプロジェクト内の既存データだけを主な根拠として、
ユーザー向けの福井県内1日旅行プランを日本語のMarkdownで作成してください。

## 重要な制約
- plan1・plan2、クラスター情報、既存スポットデータに含まれる場所を優先してください。
- 根拠データにない場所を大量に追加しないでください。
- 営業時間、料金、移動時間、季節イベントなど変動しうる情報は断定せず、
  旅行前に公式情報を確認するよう注意書きを入れてください。
- 情報が不足している場合は、推測で埋めず「不明」「要確認」と明記してください。
- 実行可能性を意識し、詰め込みすぎない1日プランにしてください。

## 必須の見出し
1. ユーザー傾向の要約
2. 参考にした推薦案・クラスター情報
3. 福井県内の1日旅行プラン
4. 時間帯ごとの行程
5. 各スポットを選んだ理由
6. このプランがユーザーに合う理由
7. 注意点・改善余地

## ABテストから抽出した情報
{extracted_sections}

## ABテスト元データ（長い場合は省略）
{json_text(ab_result, MAX_SOURCE_CHARS)}

## 利用可能なプロジェクトデータ（各ファイルは長い場合省略）
{project_sections}
"""


def validate_environment() -> dict[str, str]:
    if not ENV_PATH.is_file():
        raise ValueError(
            f".env が見つかりません: {ENV_PATH}\n"
            "プロジェクトルートに Azure OpenAI の設定を含む .env を作成してください。"
        )

    load_dotenv(ENV_PATH)
    variable_names = (
        "AZURE_OPENAI_ENDPOINT",
        "AZURE_OPENAI_API_KEY",
        "AZURE_OPENAI_DEPLOYMENT",
        "AZURE_OPENAI_API_VERSION",
    )
    values = {name: os.getenv(name, "").strip() for name in variable_names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise ValueError(".env に必要な設定がありません: " + ", ".join(missing))
    return values


def call_azure_openai(settings: dict[str, str], prompt: str) -> str:
    client = AzureOpenAI(
        azure_endpoint=settings["AZURE_OPENAI_ENDPOINT"],
        api_key=settings["AZURE_OPENAI_API_KEY"],
        api_version=settings["AZURE_OPENAI_API_VERSION"],
    )
    try:
        response = client.chat.completions.create(
            model=settings["AZURE_OPENAI_DEPLOYMENT"],
            messages=[
                {
                    "role": "system",
                    "content": (
                        "既存の推薦根拠を尊重し、事実と推測を区別する"
                        "福井県観光の旅行プランナーとして回答してください。"
                    ),
                },
                {"role": "user", "content": prompt},
            ],
            temperature=0.3,
        )
    except Exception as exc:
        raise RuntimeError(f"Azure OpenAI API 呼び出しに失敗しました: {exc}") from exc

    content = response.choices[0].message.content if response.choices else None
    if not content:
        raise RuntimeError("Azure OpenAI API から旅行プラン本文が返されませんでした。")
    return content.strip()


def save_outputs(
    input_path: Path,
    plan_markdown: str,
    extracted: dict[str, Any],
    project_data: dict[str, str],
    deployment: str,
) -> tuple[Path, Path]:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    base_name = f"{input_path.stem}_azure_plan"
    markdown_path = OUTPUT_DIR / f"{base_name}.md"
    json_path = OUTPUT_DIR / f"{base_name}.json"

    markdown_path.write_text(plan_markdown + "\n", encoding="utf-8")
    result = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "input_file": str(input_path.resolve()),
        "azure_openai_deployment": deployment,
        "project_data_sources": list(project_data.keys()),
        "extracted_ab_test_context": extracted,
        "plan_markdown": plan_markdown,
    }
    json_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return markdown_path, json_path


def main() -> int:
    if len(sys.argv) != 2:
        eprint(
            "Usage: py scripts/generate_azure_travel_plan.py "
            "abtest_results/sample.json"
        )
        return 2

    input_path = Path(sys.argv[1])
    if not input_path.is_absolute():
        input_path = PROJECT_ROOT / input_path
    if not input_path.is_file():
        eprint(f"エラー: 入力JSONファイルが見つかりません: {input_path}")
        return 1

    try:
        settings = validate_environment()
        ab_result = read_json(input_path)
        extracted = extract_ab_test_context(ab_result)
        project_data = load_project_data()
        prompt = build_prompt(ab_result, extracted, project_data)
        plan_markdown = call_azure_openai(settings, prompt)
        markdown_path, json_path = save_outputs(
            input_path,
            plan_markdown,
            extracted,
            project_data,
            settings["AZURE_OPENAI_DEPLOYMENT"],
        )
    except (ValueError, RuntimeError) as exc:
        eprint(f"エラー: {exc}")
        return 1

    print(f"Markdownを保存しました: {markdown_path}")
    print(f"JSONを保存しました: {json_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
