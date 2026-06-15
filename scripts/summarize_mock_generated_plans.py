"""Summarize existing mock young-adult AB-test inputs and generated plans.

This script is local-only and read-only with respect to source data. It does not
call Azure OpenAI or regenerate travel plans.
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = PROJECT_ROOT / "abtest_results" / "mock_young_adult"
PLAN_DIR = PROJECT_ROOT / "generated_plans"
MARKDOWN_OUTPUT = PLAN_DIR / "mock_young_adult_summary.md"
CSV_OUTPUT = PLAN_DIR / "mock_young_adult_summary.csv"

REQUIRED_SECTIONS = {
    "has_geographic_consistency": "地理的整合性の確認",
    "has_similar_tourist_needs": "類似観光客コメントから読み取れるニーズ",
    "has_plan_relationship": "推薦案1・推薦案2との関係",
}

CSV_FIELDS = (
    "profile_number",
    "profile_type",
    "age_range",
    "comparison_choice",
    "plan1_spots",
    "plan2_spots",
    "generated_plan_title",
    "plan_type",
    "main_route_visited_spots",
    "has_geographic_consistency",
    "has_similar_tourist_needs",
    "has_plan_relationship",
    "markdown_plan_path",
    "json_plan_path",
    "warning",
)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def spot_names(result: dict[str, Any], key: str) -> list[str]:
    return [
        str(spot.get("name", "")).strip()
        for spot in result.get(key, [])
        if isinstance(spot, dict) and spot.get("name")
    ]


def extract_profile_number(path: Path) -> str:
    match = re.search(r"mock_pre_validation_(\d+)_", path.stem)
    return match.group(1) if match else ""


def clean_markdown(text: str) -> str:
    return re.sub(r"^```(?:markdown)?\s*|\s*```$", "", text.strip(), flags=re.I)


def extract_title(text: str) -> str:
    match = re.search(r"(?m)^#\s+(.+?)\s*$", text)
    return match.group(1).strip() if match else ""


def extract_section(text: str, heading_name: str) -> str:
    pattern = re.compile(
        rf"(?ms)^##\s+(?:\d+\.\s*)?{re.escape(heading_name)}\s*$"
        rf"(.*?)(?=^##\s+|\Z)"
    )
    match = pattern.search(text)
    return match.group(1).strip() if match else ""


def extract_plan_type(text: str) -> str:
    candidates = re.findall(r"(ゆったり型|効率重視型)", text)
    return candidates[0] if candidates else ""


def clean_route_value(value: str) -> str:
    value = re.sub(r"\*\*", "", value)
    value = re.sub(r"[。]$", "", value.strip())
    return re.sub(r"\s+", " ", value)


def extract_route_summary(text: str) -> str:
    itinerary = extract_section(text, "時間帯ごとの行程")
    table_spots: list[str] = []
    for line in itinerary.splitlines():
        if not line.lstrip().startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip().strip("|").split("|")]
        if len(cells) < 2 or cells[0] in {"時間帯", "時間", "---"}:
            continue
        if all(set(cell) <= {"-", ":"} for cell in cells):
            continue
        spot = re.sub(r"\*\*", "", cells[1]).strip()
        if spot and spot not in table_spots:
            table_spots.append(spot)
    if table_spots:
        return " → ".join(table_spots)

    for label in ("訪問順", "主な訪問先", "主経路", "訪問エリア"):
        match = re.search(
            rf"(?m)^\s*-\s*\**{re.escape(label)}\**\s*:[ \t]*([^\r\n]+)$", text
        )
        if match:
            return clean_route_value(match.group(1))
    return ""


def relative_path(path: Path) -> str:
    return path.relative_to(PROJECT_ROOT).as_posix()


def load_plan_text(markdown_path: Path, json_path: Path, warnings: list[str]) -> str:
    if markdown_path.is_file():
        return clean_markdown(markdown_path.read_text(encoding="utf-8-sig"))
    warnings.append("generated Markdown missing")
    if json_path.is_file():
        data = read_json(json_path)
        plan_markdown = data.get("plan_markdown", "") if isinstance(data, dict) else ""
        if plan_markdown:
            return clean_markdown(str(plan_markdown))
        warnings.append("plan_markdown missing in generated JSON")
    return ""


def summarize_case(input_path: Path) -> dict[str, str]:
    warnings: list[str] = []
    try:
        result = read_json(input_path)
    except (OSError, json.JSONDecodeError) as exc:
        return {
            field: (
                extract_profile_number(input_path)
                if field == "profile_number"
                else f"input JSON error: {exc}"
                if field == "warning"
                else ""
            )
            for field in CSV_FIELDS
        }

    base_name = f"{input_path.stem}_azure_plan"
    markdown_path = PLAN_DIR / f"{base_name}.md"
    json_path = PLAN_DIR / f"{base_name}.json"
    if not json_path.is_file():
        warnings.append("generated JSON missing")
    plan_text = load_plan_text(markdown_path, json_path, warnings)
    profile = result.get("respondent_profile", {})

    summary = {
        "profile_number": extract_profile_number(input_path),
        "profile_type": str(profile.get("profile_type", "")),
        "age_range": str(profile.get("age_range", "")),
        "comparison_choice": str(result.get("comparison_choice", "")),
        "plan1_spots": " / ".join(
            spot_names(result, "recommendation_plan_1_spots")
        ),
        "plan2_spots": " / ".join(
            spot_names(result, "recommendation_plan_2_spots")
        ),
        "generated_plan_title": extract_title(plan_text),
        "plan_type": extract_plan_type(plan_text),
        "main_route_visited_spots": extract_route_summary(plan_text),
        "markdown_plan_path": relative_path(markdown_path),
        "json_plan_path": relative_path(json_path),
        "warning": "; ".join(warnings),
    }
    for field, section_name in REQUIRED_SECTIONS.items():
        summary[field] = "Yes" if section_name in plan_text else "No"
    return summary


def markdown_cell(value: str) -> str:
    return value.replace("|", r"\|").replace("\n", " ").strip() or "-"


def build_markdown(cases: list[dict[str, str]]) -> str:
    lines = [
        "# Mock Young-Adult Generated Travel Plan Summary",
        "",
        "> This is mock pre-validation data based on assumed young-adult profiles.",
        "> It is not real participant data and must not be presented as survey results.",
        "",
        f"- Cases reviewed: {len(cases)}",
        f"- Missing/warning cases: {sum(bool(case['warning']) for case in cases)}",
        "",
        "## Summary Table",
        "",
        "| No. | Profile Type | Choice | Plan Type | Main Route / Visited Spots | Geo | Similar Needs | Plan Relation | Warning |",
        "|---:|---|---|---|---|:---:|:---:|:---:|---|",
    ]
    for case in cases:
        values = (
            case["profile_number"],
            case["profile_type"],
            case["comparison_choice"],
            case["plan_type"],
            case["main_route_visited_spots"],
            case["has_geographic_consistency"],
            case["has_similar_tourist_needs"],
            case["has_plan_relationship"],
            case["warning"],
        )
        lines.append("| " + " | ".join(markdown_cell(value) for value in values) + " |")

    lines.extend(["", "## Case Details", ""])
    for case in cases:
        md_path = case["markdown_plan_path"]
        md_exists = (PROJECT_ROOT / md_path).is_file()
        md_link = f"[Open full generated plan](../{md_path})" if md_exists else md_path
        lines.extend(
            [
                f"### Case {case['profile_number']}: {case['profile_type']}",
                "",
                f"- **Input profile:** Age {case['age_range']}; `{case['profile_type']}`",
                f"- **Selected plan:** `{case['comparison_choice']}`",
                f"- **Plan1 spots:** {case['plan1_spots'] or 'Not available'}",
                f"- **Plan2 spots:** {case['plan2_spots'] or 'Not available'}",
                f"- **Generated title:** {case['generated_plan_title'] or 'Not available'}",
                f"- **Plan type:** {case['plan_type'] or 'Not detected'}",
                f"- **Generated route summary:** {case['main_route_visited_spots'] or 'Not detected'}",
                f"- **Required sections:** Geographic consistency `{case['has_geographic_consistency']}`, similar-tourist needs `{case['has_similar_tourist_needs']}`, plan relationship `{case['has_plan_relationship']}`",
                f"- **Full Markdown:** {md_link}",
                f"- **Warning:** {case['warning'] or 'None'}",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def write_csv(cases: list[dict[str, str]]) -> None:
    with CSV_OUTPUT.open("w", encoding="utf-8-sig", newline="") as file:
        writer = csv.DictWriter(file, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(cases)


def main() -> int:
    input_paths = sorted(INPUT_DIR.glob("*.json"))
    if not input_paths:
        print(f"No mock input files found in: {INPUT_DIR}")
        return 1

    cases = [summarize_case(input_path) for input_path in input_paths]
    PLAN_DIR.mkdir(parents=True, exist_ok=True)
    MARKDOWN_OUTPUT.write_text(build_markdown(cases), encoding="utf-8")
    write_csv(cases)
    print(MARKDOWN_OUTPUT)
    print(CSV_OUTPUT)
    print(f"Summarized {len(cases)} mock pre-validation cases.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
