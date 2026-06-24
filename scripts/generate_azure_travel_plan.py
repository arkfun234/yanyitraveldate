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
    "integrated_recommendations": (
        "integrated_recommendations",
        "integratedrecommendations",
        "統合推薦",
    ),
    "integration_debug": ("integration_debug", "integrationdebug"),
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
    extracted_sections_new = "\n\n".join(
        f"### {name}\n{json_text(value, MAX_AB_SECTION_CHARS)}"
        for name, value in extracted.items()
    )
    if not extracted_sections_new:
        extracted_sections_new = "抽出対象フィールドは見つかりませんでした。元データを参照してください。"

    project_sections_new = "\n\n".join(
        f"### {name}\n{content}" for name, content in project_data.items()
    )
    if not project_sections_new:
        project_sections_new = "利用可能なプロジェクト補助データはありません。"

    return f"""あなたは福井県観光に詳しい旅行プランナーであり、説明可能な観光推薦システムの支援者です。
本システムでは、A案の旅行者タイプ推定を基盤とし、B案の自由記述クラスタリング結果を補助情報として用いて、統合推薦候補を再ランキングしています。

以下のデータを根拠として、対象ユーザー専用の福井県内1日旅行プランを日本語Markdownで作成してください。

## 推薦情報の使い方
- integrated_recommendations を最優先で使ってください。
- plan1_recommendations / plan2_recommendations / internal_reference は内部参考情報です。推薦案1と推薦案2の比較として出力しないでください。
- integrated_recommendations に含まれない観光スポットを、主な訪問先として勝手に追加しないでください。
- integrated candidates に道の駅、観光案内所、ターミナル、駅などが含まれる場合、それらは休憩・交通・補助点としてのみ扱い、主要目的地にしないでください。
- 交通、飲食、休憩地点を追加する必要がある場合は、必ず「補助点」と明記してください。
- 候補から3〜4か所を選び、現実的な1日旅行ルートにしてください。
- 各地点がユーザーに合う理由を説明してください。
- A cluster の旅行者タイプ、特徴、上位傾向のどこを参考にしたか説明してください。
- B cluster summary / purpose_tags / top_traits / matched_keywords から、どの旅行ニーズを参考にしたか説明してください。
- 移動距離と時間配分が現実的になるようにしてください。位置関係を断定できない場合は「要確認」としてください。

## 出力形式
# 福井県1日旅行プラン

## 利用した推薦情報
- A案で推定された旅行者タイプ：
- B案から補助的に参照した旅行ニーズ：
- 統合推薦で重視した点：

## 1日の流れ
09:30 ...
11:00 ...
12:30 ...
14:00 ...
16:00 ...

## このプランを推薦する理由
...

## 注意点
...

## 抽出された推薦情報
{extracted_sections_new}

## 元データ（長い場合は省略）
{json_text(ab_result, MAX_SOURCE_CHARS)}

## 利用可能なプロジェクトデータ
{project_sections_new}
"""

    return f"""あなたは福井県観光に詳しい旅行プランナーであり、説明可能な観光推薦システムの支援者です。
本システムでは、A案の旅行者タイプ推定を基盤とし、B案の自由記述クラスタリング結果を補助情報として用いて、推薦候補を再ランキングしています。

以下のデータを根拠として、対象ユーザー専用の福井県内1日旅行プランを日本語Markdownで作成してください。

## 推薦情報の使い方
- integrated_recommendations を最優先で使ってください。
- integrated_recommendations に含まれない観光スポットを、主な訪問先として勝手に追加しないでください。
- 交通、飲食、休憩地点を追加する必要がある場合は、必ず「補助点」と明記してください。
- 候補から3〜4か所を選び、現実的な1日旅行ルートにしてください。
- 各地点がユーザーに合う理由を説明してください。
- A cluster の旅行者タイプ、特徴、上位傾向のどこを参考にしたか説明してください。
- B cluster summary / purpose_tags / top_traits / matched_keywords から、どの旅行ニーズを参考にしたか説明してください。
- 移動距離と時間配分が現実的になるようにしてください。位置関係を断定できない場合は「要確認」としてください。
- A/B Test の評価情報は予備評価として参照してよいですが、最終判断は A+B integrated recommendation を中心にしてください。

## 出力形式
# 福井県1日旅行プラン

## 利用した推薦情報
- A案で推定された旅行者タイプ：
- B案から補助的に参照した旅行ニーズ：
- 統合推薦で重視した点：

## 1日の流れ
09:30 ...
11:00 ...
12:30 ...
14:00 ...
16:00 ...

## このプランを推薦する理由
...

## 注意点
...

## 抽出された推薦・評価情報
{extracted_sections_new}

## 元データ（長い場合は省略）
{json_text(ab_result, MAX_SOURCE_CHARS)}

## 利用可能なプロジェクトデータ
{project_sections_new}
"""

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

    return f"""あなたは福井県観光に詳しい旅行プランナーであり、説明可能な観光推薦システムの支援者です。
以下のABテスト結果とクラスター情報を根拠として、対象ユーザー専用の福井県内1日旅行プランを
日本語のMarkdownで作成してください。一般的な観光ガイドではなく、入力データのどの証拠を
どう旅程へ反映したかが読み手に明確に伝わる内容にしてください。

## 根拠の使い方（必須）
- ABテストの plan1 recommendations と plan2 recommendations を必ず比較し、両案の具体的な
  スポット・体験・特徴を把握してください。
- selected/preferred plan、user scores、free comment（存在する場合）を最重要の個人根拠として扱い、
  選好、避けたいこと、満足・不満の理由を旅程に反映してください。
- A cluster profile（cluster_profiles.json）、B auto-cluster summary
  （auto_cluster_profiles_from_teacher.json）、cluster_summaries.csv の要約を必ず参照し、
  共通する傾向と異なる傾向を区別してください。
- ABテストの本人回答とクラスター傾向が食い違う場合は、本人の選択・スコア・自由コメントを優先し、
  その判断を説明してください。
- 根拠は「人気だから」「おすすめだから」のように一般化せず、入力にある選択、スコア、
  コメント、クラスター特徴へ具体的に結び付けてください。

## スポット選定の制約
- 主な訪問先は plan1 または plan2 に含まれるスポットから選んでください。
- selected/preferred plan のスポットを優先しつつ、スコアや自由コメントから有効と判断できる場合は
  非選択案のスポットも検討してください。ただし、主経路から地理的に遠いスポットは行程に
  組み合わせず、別ルートとして扱ってください。
- plan1・plan2 と無関係なスポットを勝手に主要行程へ追加しないでください。
- 追加立ち寄り先が必要な場合のみ既存プロジェクトデータから選び、名称の先頭に
  「補助候補：」と明記し、追加した理由も説明してください。
- 根拠データ内で正式名称を確認できない場所は創作せず、「不明」「要確認」としてください。

## 地理的整合性の制約（必須）
- 時間帯ごとの行程を作る前に、各候補スポットの所在地・エリア・位置関係を確認してください。
  正確な位置関係を確認できない場合は推測で近いと判断せず、「要確認」としてください。
- 主行程は同じ旅行エリアまたは自然につながる隣接エリアのスポットを優先し、大きな逆戻り、
  往復、遠回りを避けてください。推薦案のスポットをすべて採用する必要はありません。
- 例として、永平寺・大野・勝山エリアは一つの経路として検討できますが、
  南越前・河野エリアは、明確な理由と無理のない移動根拠がない限り同じ主行程へ混在させないでください。
- plan2 または補助データに魅力的なスポットがあっても、主経路から地理的に遠い場合は
  「時間帯ごとの行程」に入れないでください。
- 主経路から遠いスポットは「別ルート候補」または
  「補助候補（今回は距離の都合で行程には入れない）」としてのみ紹介してください。
- 特に、越前大野城と勝山方面のスポットを結ぶ行程の途中へ、南越前・河野方面のスポットを
  挿入するような大きな迂回は禁止します。

## 行程設計の制約
- 詰め込みすぎない実行可能な1日プランにしてください。
- 各移動時間は根拠データに正確な値がなければ「推定」と明記してください。
- 訪問順について、移動の重複を減らす、希望体験を良い時間帯に置く、休憩を確保するなど、
  なぜその順番にしたかを具体的に説明してください。
- 行程全体が「ゆったり型」か「効率重視型」かを明記し、ABテストとクラスター情報から
  その設計を選んだ理由を説明してください。
- 「ゆったり型」とする場合は、同一・隣接エリア中心の短く自然な移動を優先し、
  推薦スポットを追加するためだけの不要な迂回を一切含めないでください。
- 営業時間、料金、移動時間、季節イベントなど変動しうる情報は断定せず、
  旅行前に公式情報を確認するよう注意書きを入れてください。

## 必須の見出し（この名称をそのまま使用）
1. ユーザー傾向の要約
2. 類似観光客コメントから読み取れるニーズ
3. 推薦案1・推薦案2との関係
4. 福井県内の1日旅行プラン
5. 時間帯ごとの行程
6. 移動順とスケジュール設計の理由
7. 地理的整合性の確認
8. 各スポットを選んだ理由
9. このプランがユーザーに合う理由
10. 注意点・改善余地

## 出力時の具体的な要件
- 「類似観光客コメントから読み取れるニーズ」では、A cluster profile、B auto-cluster summary、
  cluster_summaries.csv にある類似観光客の傾向・コメント要約を、今回のユーザーに関連する
  ニーズとして整理してください。データにコメント本文がない場合は、その旨を明記してください。
- 「推薦案1・推薦案2との関係」では、plan1 と plan2 の特徴、選択された案、各スコア、
  自由コメントを整理し、最終旅程に採用・不採用・組み合わせた要素と理由を明記してください。
  地理的に遠いため不採用とした候補は「別ルート候補」または
  「補助候補（今回は距離の都合で行程には入れない）」として明示してください。
- 「時間帯ごとの行程」は、時刻、スポット名、過ごし方、滞在時間の目安、次地点への推定移動、
  根拠となるABテストまたはクラスター情報が分かる表にしてください。
- 「地理的整合性の確認」では、各スポットの旅行エリア、訪問順が自然な理由、大きな逆戻りが
  ないこと、遠方候補を除外した判断、ゆったり型または効率重視型との整合性を説明してください。
- 個人データから読み取れない嗜好を断定せず、情報不足は明示してください。

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
