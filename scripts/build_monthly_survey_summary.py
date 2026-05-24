#!/usr/bin/env python3
"""Build aggregate monthly tourism survey summary JSON files.

Raw survey CSVs can contain personal-related fields. This script reads them
locally and writes aggregated JSON summaries only.
"""

from __future__ import annotations

import csv
import json
import re
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from statistics import mean
from typing import Any


ROOT_DIR = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT_DIR / "data"
SURVEY_DIR = DATA_DIR / "monthly_surveys"
MONTHLY_PATTERN = re.compile(r"^(?P<year>\d{4})(?P<month>0[1-9]|1[0-2])$")

SENSITIVE_FIELDS = {
    "会員ID",
    "生まれ年",
    "世帯年収",
    "会員市町村",
}

DISTRIBUTION_FIELDS = {
    "top_areas": "回答エリア",
    "area2_top": "回答エリア2",
    "city_distribution": "市町村",
    "region_distribution": "6分類",
    "companion_distribution": "同行者",
    "age_distribution": "年代",
    "satisfaction_distribution": "満足度",
    "visited_before_top": "アンケート回答前に訪問した主な場所",
    "planned_after_top": "アンケート回答後に訪問する予定の主な場所",
    "transportation_to_fukui_distribution": "福井県までの交通手段ALL",
    "transportation_inside_fukui_distribution": "福井県内での交通手段ALL",
    "stay_nights_distribution": "宿泊数（全体）",
    "stay_area_distribution": "宿泊エリア（県内）",
    "information_source_distribution": "情報収集ALL",
    "revisit_intention_distribution": "今後の来訪意向",
    "inconvenience_distribution": "不便さ",
}

MULTI_VALUE_FIELDS = {
    "アンケート回答前に訪問した主な場所",
    "アンケート回答後に訪問する予定の主な場所",
    "福井県までの交通手段ALL",
    "福井県内での交通手段ALL",
    "宿泊エリア（県内）",
    "情報収集ALL",
    "不便さ",
}

PURPOSE_TO_TRAIT_MAPPING = {
    "温泉や露天風呂": "relaxation",
    "宿でのんびり過ごす": "relaxation",
    "癒し・リフレッシュ": "relaxation",
    "自然や風景を楽しむ": "nature",
    "花・紅葉・景勝地": "nature",
    "海・山・川などの自然": "nature",
    "歴史・文化・まち歩き": "exploration_experience",
    "観光施設・テーマパーク": "exploration_experience",
    "体験・アクティビティ": "exploration_experience",
    "イベント・祭り": "exploration_experience",
    "食・グルメ": "food_value",
    "買い物・お土産": "food_value",
    "地酒・地元食材": "food_value",
    "ドライブ・周遊": "efficiency_touring",
    "複数エリアを効率よく回る": "efficiency_touring",
    "移動しやすさ": "efficiency_touring",
}

PURPOSE_KEYWORD_TRAITS = (
    ("温泉", "relaxation"),
    ("癒", "relaxation"),
    ("リフレッシュ", "relaxation"),
    ("のんびり", "relaxation"),
    ("自然", "nature"),
    ("風景", "nature"),
    ("景観", "nature"),
    ("花", "nature"),
    ("紅葉", "nature"),
    ("海", "nature"),
    ("山", "nature"),
    ("歴史", "exploration_experience"),
    ("文化", "exploration_experience"),
    ("まち歩", "exploration_experience"),
    ("体験", "exploration_experience"),
    ("アクティビティ", "exploration_experience"),
    ("イベント", "exploration_experience"),
    ("祭", "exploration_experience"),
    ("食", "food_value"),
    ("グルメ", "food_value"),
    ("買い物", "food_value"),
    ("土産", "food_value"),
    ("酒", "food_value"),
    ("ドライブ", "efficiency_touring"),
    ("周遊", "efficiency_touring"),
    ("効率", "efficiency_touring"),
    ("交通", "efficiency_touring"),
    ("移動", "efficiency_touring"),
)


def main() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    summaries = []

    csv_files = sorted(SURVEY_DIR.glob("*.csv"))
    for csv_path in csv_files:
        month = month_from_filename(csv_path)
        if month is None:
            print(f"Skipping {csv_path.name}: filename is not YYYYMM.csv")
            continue

        rows, fieldnames = read_csv(csv_path)
        summary = build_summary(month, csv_path, rows, fieldnames)
        output_path = DATA_DIR / f"survey_summary_{month.replace('-', '')}.json"
        write_json(output_path, summary)
        summaries.append(summary)

    combined = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_directory": str(SURVEY_DIR.relative_to(ROOT_DIR)),
        "month_count": len(summaries),
        "months": summaries,
    }
    write_json(DATA_DIR / "survey_monthly_summary.json", combined)

    record_total = sum(summary["record_count"] for summary in summaries)
    print(
        f"Generated {len(summaries)} monthly survey summaries "
        f"from {record_total} records."
    )
    if summaries:
        month_list = ", ".join(summary["month"] for summary in summaries)
        print(f"Months: {month_list}")
    print(f"Combined output: {DATA_DIR / 'survey_monthly_summary.json'}")


def month_from_filename(csv_path: Path) -> str | None:
    match = MONTHLY_PATTERN.match(csv_path.stem)
    if not match:
        return None
    return f"{match.group('year')}-{match.group('month')}"


def read_csv(csv_path: Path) -> tuple[list[dict[str, str]], list[str]]:
    last_error: UnicodeDecodeError | None = None
    for encoding in ("utf-8-sig", "cp932", "utf-8"):
        try:
            with csv_path.open("r", encoding=encoding, newline="") as handle:
                reader = csv.DictReader(handle)
                fieldnames = [name for name in (reader.fieldnames or []) if name]
                rows = [
                    {key: normalize_cell(value) for key, value in row.items() if key}
                    for row in reader
                ]
            return rows, fieldnames
        except UnicodeDecodeError as exc:
            last_error = exc
    if last_error:
        raise last_error
    return [], []


def build_summary(
    month: str,
    csv_path: Path,
    rows: list[dict[str, str]],
    fieldnames: list[str],
) -> dict[str, Any]:
    available_fields = set(fieldnames)
    purpose_columns = detect_purpose_columns(rows, fieldnames)
    purpose_mapping = {
        column: trait_for_purpose_column(column) for column in purpose_columns
    }

    summary: dict[str, Any] = {
        "month": month,
        "source_file": str(csv_path.relative_to(ROOT_DIR)),
        "record_count": len(rows),
        "field_count": len(fieldnames),
    }

    for output_key, source_column in DISTRIBUTION_FIELDS.items():
        if source_column in available_fields:
            summary[output_key] = distribution(
                rows,
                source_column,
                split_values=source_column in MULTI_VALUE_FIELDS,
            )
        else:
            summary[output_key] = []

    summary["purpose_distribution"] = purpose_distribution(rows, purpose_columns)
    summary["purpose_to_trait_mapping"] = purpose_mapping
    summary["nps_average"] = numeric_average(rows, "NPS")
    summary["nps_distribution"] = nps_distribution(rows)
    summary["area_purpose_matrix"] = group_purpose_matrix(
        rows, "回答エリア", purpose_columns
    )
    summary["companion_purpose_matrix"] = group_purpose_matrix(
        rows, "同行者", purpose_columns
    )
    summary["area_satisfaction_summary"] = grouped_numeric_summary(
        rows, "回答エリア", "満足度"
    )
    summary["area_nps_summary"] = grouped_numeric_summary(rows, "回答エリア", "NPS")

    return summary


def normalize_cell(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip()


def distribution(
    rows: list[dict[str, str]],
    column: str,
    *,
    split_values: bool = False,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    counter: Counter[str] = Counter()
    for row in rows:
        raw_value = row.get(column, "")
        values = split_multi_value(raw_value) if split_values else [raw_value]
        for value in values:
            if value:
                counter[value] += 1
    return counter_to_items(counter, denominator=len(rows), limit=limit)


def split_multi_value(value: str) -> list[str]:
    if not value:
        return []
    parts = re.split(r"[;,、／/|｜\n\r\t]+", value)
    return [part.strip() for part in parts if part.strip()]


def counter_to_items(
    counter: Counter[str],
    *,
    denominator: int,
    limit: int | None = None,
) -> list[dict[str, Any]]:
    items = counter.most_common(limit)
    return [
        {
            "value": value,
            "count": count,
            "ratio": round(count / denominator, 4) if denominator else 0,
        }
        for value, count in items
    ]


def detect_purpose_columns(
    rows: list[dict[str, str]], fieldnames: list[str]
) -> list[str]:
    purpose_columns = []
    for column in fieldnames:
        if column in SENSITIVE_FIELDS or column in DISTRIBUTION_FIELDS.values():
            continue
        if column == "NPS":
            continue
        if not looks_like_binary_column(rows, column):
            continue
        if is_known_or_likely_purpose(column):
            purpose_columns.append(column)
    return purpose_columns


def looks_like_binary_column(rows: list[dict[str, str]], column: str) -> bool:
    values = {normalize_binary_value(row.get(column, "")) for row in rows}
    values.discard(None)
    return bool(values) and values <= {0, 1}


def normalize_binary_value(value: str) -> int | None:
    normalized = normalize_cell(value)
    if normalized in {"", "NA", "N/A", "null", "None"}:
        return None
    if normalized in {"1", "1.0", "true", "TRUE", "True", "○", "◯", "有"}:
        return 1
    if normalized in {"0", "0.0", "false", "FALSE", "False", "×", "無"}:
        return 0
    return None


def is_known_or_likely_purpose(column: str) -> bool:
    if column in PURPOSE_TO_TRAIT_MAPPING:
        return True
    purpose_markers = ("目的", "訪問目的", "旅行目的", "楽しみ", "体験")
    if any(marker in column for marker in purpose_markers):
        return True
    return trait_for_purpose_column(column) != "exploration_experience"


def trait_for_purpose_column(column: str) -> str:
    if column in PURPOSE_TO_TRAIT_MAPPING:
        return PURPOSE_TO_TRAIT_MAPPING[column]
    normalized = re.sub(r"^(目的|訪問目的|旅行目的)[_:：\-\s]*", "", column)
    for keyword, trait in PURPOSE_KEYWORD_TRAITS:
        if keyword in normalized:
            return trait
    return "exploration_experience"


def purpose_distribution(
    rows: list[dict[str, str]], purpose_columns: list[str]
) -> list[dict[str, Any]]:
    denominator = len(rows)
    items = []
    for column in purpose_columns:
        count = sum(
            1
            for row in rows
            if normalize_binary_value(row.get(column, "")) == 1
        )
        items.append(
            {
                "purpose": column,
                "trait": trait_for_purpose_column(column),
                "count": count,
                "ratio": round(count / denominator, 4) if denominator else 0,
            }
        )
    return sorted(items, key=lambda item: (-item["count"], item["purpose"]))


def numeric_average(rows: list[dict[str, str]], column: str) -> float | None:
    values = numeric_values(rows, column)
    return round(mean(values), 2) if values else None


def numeric_values(rows: list[dict[str, str]], column: str) -> list[float]:
    values = []
    for row in rows:
        value = parse_number(row.get(column, ""))
        if value is not None:
            values.append(value)
    return values


def parse_number(value: str) -> float | None:
    normalized = normalize_cell(value)
    if not normalized:
        return None
    normalized = normalized.replace(",", "")
    match = re.search(r"-?\d+(?:\.\d+)?", normalized)
    if not match:
        return None
    return float(match.group(0))


def nps_distribution(rows: list[dict[str, str]]) -> dict[str, Any]:
    scores = [int(value) for value in numeric_values(rows, "NPS") if 0 <= value <= 10]
    score_counter = Counter(str(score) for score in scores)
    category_counter: Counter[str] = Counter()
    for score in scores:
        if score >= 9:
            category_counter["promoter"] += 1
        elif score >= 7:
            category_counter["passive"] += 1
        else:
            category_counter["detractor"] += 1

    denominator = len(scores)
    return {
        "score": counter_to_items(score_counter, denominator=denominator),
        "category": counter_to_items(category_counter, denominator=denominator),
        "valid_count": denominator,
    }


def group_purpose_matrix(
    rows: list[dict[str, str]],
    group_column: str,
    purpose_columns: list[str],
) -> list[dict[str, Any]]:
    if not purpose_columns:
        return []

    grouped_rows: dict[str, list[dict[str, str]]] = defaultdict(list)
    for row in rows:
        group_value = row.get(group_column, "")
        if group_value:
            grouped_rows[group_value].append(row)

    matrix = []
    for group_value, group_rows in grouped_rows.items():
        purposes = {
            column: sum(
                1
                for row in group_rows
                if normalize_binary_value(row.get(column, "")) == 1
            )
            for column in purpose_columns
        }
        matrix.append(
            {
                "value": group_value,
                "record_count": len(group_rows),
                "purposes": dict(
                    sorted(purposes.items(), key=lambda item: (-item[1], item[0]))
                ),
            }
        )
    return sorted(matrix, key=lambda item: (-item["record_count"], item["value"]))


def grouped_numeric_summary(
    rows: list[dict[str, str]], group_column: str, numeric_column: str
) -> list[dict[str, Any]]:
    grouped_values: dict[str, list[float]] = defaultdict(list)
    for row in rows:
        group_value = row.get(group_column, "")
        numeric_value = parse_number(row.get(numeric_column, ""))
        if group_value and numeric_value is not None:
            grouped_values[group_value].append(numeric_value)

    summaries = []
    for group_value, values in grouped_values.items():
        counter = Counter(format_number(value) for value in values)
        summaries.append(
            {
                "value": group_value,
                "valid_count": len(values),
                "average": round(mean(values), 2),
                "min": min(values),
                "max": max(values),
                "distribution": counter_to_items(
                    counter, denominator=len(values)
                ),
            }
        )
    return sorted(summaries, key=lambda item: (-item["valid_count"], item["value"]))


def format_number(value: float) -> str:
    return str(int(value)) if value.is_integer() else str(value)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
