# -*- coding: utf-8 -*-
"""
Build spot_master.json from data/fukui_spots_900.csv.

Purpose:
- Convert the raw Fukui tourism spot CSV into a lightweight JSON master file.
- Keep only fields useful for the recommendation prototype.
- Add derived purpose_tags and trait_tags for later spot-level recommendation.

Run from project root:
    python scripts/build_spot_master.py
"""

from __future__ import annotations

import csv
import json
import math
import re
from collections import Counter
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
INPUT_CSV = PROJECT_ROOT / "data" / "fukui_spots_900.csv"
OUTPUT_JSON = PROJECT_ROOT / "data" / "spot_master.json"


def clean(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    if text.lower() == "nan":
        return ""
    return text


def split_list(value: str) -> list[str]:
    text = clean(value)
    if not text:
        return []
    return [x.strip() for x in re.split(r"[,、]", text) if x.strip()]


def split_urls(value: str) -> list[str]:
    return [x for x in split_list(value) if x.startswith("http")]


def to_float(value):
    text = clean(value)
    if not text:
        return None
    try:
        number = float(text)
        if math.isnan(number):
            return None
        return number
    except ValueError:
        return None


PURPOSE_RULES = [
    (
        ["自然・公園", "山・川・湖", "海岸・岬", "花", "桜", "紅葉", "水仙", "湖", "海", "山", "滝"],
        ["自然鑑賞"],
        ["自然志向"],
    ),
    (
        ["アウトドア", "キャンプ", "釣り", "登山", "海水浴", "サイクリング"],
        ["アウトドア"],
        ["自然志向", "探索・体験志向"],
    ),
    (
        ["温泉", "露天風呂", "宿泊", "旅館", "ホテル"],
        ["温泉や露天風呂", "宿でのんびり過ごす"],
        ["リラックス志向"],
    ),
    (
        ["グルメ", "食", "そば", "蟹", "カニ", "海鮮", "酒", "スイーツ", "カフェ", "市場"],
        ["地元の美味しいものを食べる"],
        ["美食・価値志向"],
    ),
    (
        ["歴史・文化・史跡", "寺社仏閣", "城", "神社", "寺", "遺跡", "資料館"],
        ["名所、旧跡の観光"],
        ["探索・体験志向"],
    ),
    (
        ["博物館", "美術館", "恐竜", "水族館", "動物園", "遊園地", "テーマパーク"],
        ["テーマパーク"],
        ["探索・体験志向"],
    ),
    (
        ["体験", "手作り", "果物狩り", "工房", "クラフト", "ものづくり"],
        ["各種体験"],
        ["探索・体験志向"],
    ),
    (
        ["まちあるき", "街歩き", "散策", "商店街", "町並み", "宿場町"],
        ["まちあるき、都市散策"],
        ["探索・体験志向"],
    ),
    (
        ["道の駅", "ドライブ", "ツーリング", "レインボーライン"],
        ["ドライブ・ツーリング"],
        ["効率・周遊志向"],
    ),
    (
        ["買い物", "アウトレット", "物産", "お土産"],
        ["買い物、アウトレット"],
        ["美食・価値志向"],
    ),
]

LOW_PRIORITY_KEYWORDS = [
    "おもてなし特集",
    "PR隊",
    "ボランティア",
    "保存会",
    "協議会",
    "研究会",
]


def unique_extend(target: list[str], values: list[str]) -> None:
    for value in values:
        if value not in target:
            target.append(value)


def derive_tags(categories: list[str], name: str, description: str, area_text: str) -> tuple[list[str], list[str]]:
    searchable_text = " ".join(categories + [name, description, area_text])
    purpose_tags: list[str] = []
    trait_tags: list[str] = []

    for keywords, purposes, traits in PURPOSE_RULES:
        if any(keyword in searchable_text for keyword in keywords):
            unique_extend(purpose_tags, purposes)
            unique_extend(trait_tags, traits)

    return purpose_tags, trait_tags


def build_spot_master() -> dict:
    if not INPUT_CSV.exists():
        raise FileNotFoundError(f"Input CSV not found: {INPUT_CSV}")

    spots = []
    with INPUT_CSV.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            name = clean(row.get("name"))
            area_text = clean(row.get("area"))
            categories = split_list(row.get("category"))
            areas = split_list(area_text)
            description = clean(row.get("description"))
            purpose_tags, trait_tags = derive_tags(categories, name, description, area_text)
            raw_text = f"{name} {description}"

            spots.append(
                {
                    "id": clean(row.get("id")),
                    "name": name,
                    "kana": clean(row.get("kana")),
                    "areas": areas,
                    "primary_area": areas[0] if areas else "",
                    "categories": categories,
                    "lat": to_float(row.get("lat")),
                    "lng": to_float(row.get("lng")),
                    "url": clean(row.get("url")),
                    "image": clean(row.get("image")),
                    "description": description[:220] + ("…" if len(description) > 220 else ""),
                    "address": clean(row.get("address")),
                    "access": clean(row.get("access"))[:180] + ("…" if len(clean(row.get("access"))) > 180 else ""),
                    "opening_hours": clean(row.get("opening_hours")),
                    "closed_days": clean(row.get("closed_days")),
                    "fees": clean(row.get("fees")),
                    "parking": clean(row.get("parking")),
                    "website": split_urls(row.get("website")),
                    "purpose_tags": purpose_tags,
                    "trait_tags": trait_tags,
                    "is_low_priority_candidate": any(keyword in raw_text for keyword in LOW_PRIORITY_KEYWORDS),
                }
            )

    category_counter = Counter(category for spot in spots for category in spot["categories"])
    area_counter = Counter(area for spot in spots for area in spot["areas"])
    purpose_counter = Counter(purpose for spot in spots for purpose in spot["purpose_tags"])
    trait_counter = Counter(trait for spot in spots for trait in spot["trait_tags"])

    return {
        "meta": {
            "source_file": "data/fukui_spots_900.csv",
            "record_count": len(spots),
            "created_for": "Fukui tourism recommendation prototype",
            "description": "福井県観光スポットCSVをWeb推薦用に整形したスポット候補マスター。個別スポット推薦、エリア推薦の具体化、目的タグによる候補抽出に利用する。",
        },
        "schema": {
            "areas": "CSVのareaをカンマ区切りで分割したエリア・市町村ラベル",
            "categories": "CSVのcategoryをカンマ区切りで分割した観光カテゴリ",
            "purpose_tags": "カテゴリ・名称・説明文から推定した旅行目的タグ",
            "trait_tags": "purpose_tagsに基づく6つの旅行傾向に近い補助タグ",
            "is_low_priority_candidate": "団体紹介やおもてなし特集など、通常の観光スポット推薦では優先度を下げたい候補",
        },
        "summary": {
            "top_categories": [
                {"category": key, "count": count} for key, count in category_counter.most_common(20)
            ],
            "top_areas": [
                {"area": key, "count": count} for key, count in area_counter.most_common(20)
            ],
            "purpose_tag_counts": [
                {"purpose": key, "count": count} for key, count in purpose_counter.most_common()
            ],
            "trait_tag_counts": [
                {"trait": key, "count": count} for key, count in trait_counter.most_common()
            ],
        },
        "spots": spots,
    }


def main() -> None:
    spot_master = build_spot_master()
    OUTPUT_JSON.write_text(json.dumps(spot_master, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Created: {OUTPUT_JSON}")
    print(f"Spot count: {spot_master['meta']['record_count']}")


if __name__ == "__main__":
    main()
