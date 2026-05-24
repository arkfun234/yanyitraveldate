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
import sys
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

TRANSPORT_KEYWORDS = [
    "バス停",
    "バス",
    "駅",
    "駐車場",
    "レンタカー",
    "交通",
    "タクシー",
]

FACILITY_KEYWORDS = [
    "トイレ",
    "案内所",
    "観光案内所",
    "休憩所",
    "待合所",
    "駐輪場",
]

TRANSPORT_FACILITY_KEYWORDS = TRANSPORT_KEYWORDS + FACILITY_KEYWORDS

SPOT_TYPE_RULES = [
    (
        "hot_spring",
        ["温泉", "露天風呂", "日帰り湯", "湯めぐり", "湯宿"],
    ),
    (
        "shrine_temple",
        ["寺社仏閣", "神社", "寺", "寺院", "仏閣", "大師", "観音", "不動尊"],
    ),
    (
        "history_culture",
        ["歴史", "文化", "史跡", "城", "城跡", "遺跡", "古墳", "重要文化財", "伝統"],
    ),
    (
        "museum_themepark",
        ["博物館", "美術館", "資料館", "恐竜", "水族館", "動物園", "遊園地", "テーマパーク", "科学館"],
    ),
    (
        "nature",
        ["自然", "公園", "山", "川", "湖", "海", "海岸", "岬", "滝", "渓谷", "花", "桜", "紅葉", "景勝地", "展望", "森", "清水"],
    ),
    (
        "activity_experience",
        ["体験", "手作り", "工房", "クラフト", "釣り", "登山", "海水浴", "サイクリング", "アクティビティ", "あそび"],
    ),
    (
        "food",
        ["グルメ", "食", "そば", "蕎麦", "カニ", "海鮮", "酒", "スイーツ", "カフェ", "市場"],
    ),
    (
        "shopping",
        ["買い物", "アウトレット", "物産", "お土産", "道の駅", "商店", "市場"],
    ),
    (
        "city_walk",
        ["まちあるき", "街歩き", "散策", "商店街", "町並み", "宿場町", "伝統的建造物群"],
    ),
]

CORE_TOURISM_TYPES = {
    "nature",
    "history_culture",
    "shrine_temple",
    "museum_themepark",
    "hot_spring",
    "food",
    "activity_experience",
    "shopping",
    "city_walk",
}

CORE_TOURISM_KEYWORDS = [
    keyword
    for spot_type, keywords in SPOT_TYPE_RULES
    if spot_type in CORE_TOURISM_TYPES
    for keyword in keywords
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


def has_any_keyword(text: str, keywords: list[str]) -> bool:
    return any(keyword in text for keyword in keywords)


def derive_spot_type(categories: list[str], name: str, description: str, area_text: str, access: str) -> str:
    searchable_text = " ".join(categories + [name, description, area_text])
    tourism_keyword_hit = has_any_keyword(searchable_text, CORE_TOURISM_KEYWORDS)

    if has_any_keyword(searchable_text, FACILITY_KEYWORDS) and not tourism_keyword_hit:
        return "facility"
    if has_any_keyword(searchable_text, TRANSPORT_KEYWORDS) and not tourism_keyword_hit:
        return "transport"

    for spot_type, keywords in SPOT_TYPE_RULES:
        if has_any_keyword(searchable_text, keywords):
            return spot_type

    if has_any_keyword(searchable_text, FACILITY_KEYWORDS):
        return "facility"
    if has_any_keyword(searchable_text, TRANSPORT_KEYWORDS):
        return "transport"
    return "other"


def derive_is_core_tourism_spot(spot_type: str, categories: list[str], name: str, description: str) -> bool:
    searchable_text = " ".join(categories + [name, description])
    if spot_type in {"transport", "facility", "other"}:
        return False
    return spot_type in CORE_TOURISM_TYPES or has_any_keyword(searchable_text, CORE_TOURISM_KEYWORDS)


def derive_main_recommendation_penalty(spot_type: str, name: str, categories: list[str], description: str, access: str) -> float:
    searchable_text = " ".join(categories + [name, description])
    transport_facility_hits = sum(
        1 for keyword in TRANSPORT_FACILITY_KEYWORDS if keyword in searchable_text
    )
    if spot_type == "transport":
        penalty = 0.85
    elif spot_type == "facility":
        penalty = 0.75
    elif spot_type == "other":
        penalty = 0.25
    else:
        penalty = 0.0

    if transport_facility_hits:
        penalty += min(0.15, transport_facility_hits * 0.05)
    return round(max(0.0, min(1.0, penalty)), 2)


def derive_quality_score(
    *,
    image: str,
    url: str,
    description: str,
    lat,
    lng,
    is_core_tourism_spot: bool,
    spot_type: str,
    main_recommendation_penalty: float,
) -> float:
    score = 0.5
    if image:
        score += 0.15
    if url:
        score += 0.10
    if description:
        score += 0.10
    if lat is not None and lng is not None:
        score += 0.10
    if is_core_tourism_spot:
        score += 0.15
    if spot_type in {"transport", "facility"}:
        score -= 0.30
    score -= main_recommendation_penalty * 0.20
    return round(max(0.0, min(1.0, score)), 2)


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
            access = clean(row.get("access"))
            lat = to_float(row.get("lat"))
            lng = to_float(row.get("lng"))
            url = clean(row.get("url"))
            image = clean(row.get("image"))
            spot_type = derive_spot_type(categories, name, description, area_text, access)
            is_core_tourism_spot = derive_is_core_tourism_spot(spot_type, categories, name, description)
            main_recommendation_penalty = derive_main_recommendation_penalty(
                spot_type, name, categories, description, access
            )
            quality_score = derive_quality_score(
                image=image,
                url=url,
                description=description,
                lat=lat,
                lng=lng,
                is_core_tourism_spot=is_core_tourism_spot,
                spot_type=spot_type,
                main_recommendation_penalty=main_recommendation_penalty,
            )
            raw_text = f"{name} {description}"

            spots.append(
                {
                    "id": clean(row.get("id")),
                    "name": name,
                    "kana": clean(row.get("kana")),
                    "areas": areas,
                    "primary_area": areas[0] if areas else "",
                    "categories": categories,
                    "lat": lat,
                    "lng": lng,
                    "url": url,
                    "image": image,
                    "description": description[:220] + ("…" if len(description) > 220 else ""),
                    "address": clean(row.get("address")),
                    "access": access[:180] + ("…" if len(access) > 180 else ""),
                    "opening_hours": clean(row.get("opening_hours")),
                    "closed_days": clean(row.get("closed_days")),
                    "fees": clean(row.get("fees")),
                    "parking": clean(row.get("parking")),
                    "website": split_urls(row.get("website")),
                    "purpose_tags": purpose_tags,
                    "trait_tags": trait_tags,
                    "is_low_priority_candidate": any(keyword in raw_text for keyword in LOW_PRIORITY_KEYWORDS),
                    "spot_type": spot_type,
                    "quality_score": quality_score,
                    "is_core_tourism_spot": is_core_tourism_spot,
                    "main_recommendation_penalty": main_recommendation_penalty,
                }
            )

    category_counter = Counter(category for spot in spots for category in spot["categories"])
    area_counter = Counter(area for spot in spots for area in spot["areas"])
    purpose_counter = Counter(purpose for spot in spots for purpose in spot["purpose_tags"])
    trait_counter = Counter(trait for spot in spots for trait in spot["trait_tags"])
    spot_type_counter = Counter(spot["spot_type"] for spot in spots)
    core_tourism_count = sum(1 for spot in spots if spot["is_core_tourism_spot"])
    low_quality_examples = sorted(
        spots,
        key=lambda spot: (spot["quality_score"], -spot["main_recommendation_penalty"], spot["name"]),
    )[:10]

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
            "spot_type": "名称・カテゴリ・説明文・エリア・アクセスからルールベースで推定したスポット種別",
            "quality_score": "画像、URL、説明文、緯度経度、観光スポット性、交通・施設ペナルティから算出した0〜1の品質スコア",
            "is_core_tourism_spot": "主推薦として扱いやすい観光目的地ならtrue、交通・施設・その他のみならfalse",
            "main_recommendation_penalty": "主推薦の候補として下げたい度合い。0はペナルティなし、1はほぼ主推薦にしない",
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
            "spot_type_counts": [
                {"spot_type": key, "count": count} for key, count in spot_type_counter.most_common()
            ],
            "core_tourism_spot_count": core_tourism_count,
            "low_quality_examples": [
                {
                    "id": spot["id"],
                    "name": spot["name"],
                    "spot_type": spot["spot_type"],
                    "quality_score": spot["quality_score"],
                    "main_recommendation_penalty": spot["main_recommendation_penalty"],
                }
                for spot in low_quality_examples
            ],
        },
        "spots": spots,
    }


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(errors="replace")
    spot_master = build_spot_master()
    OUTPUT_JSON.write_text(json.dumps(spot_master, ensure_ascii=False, indent=2), encoding="utf-8")
    summary = spot_master["summary"]
    print(f"Total spots: {spot_master['meta']['record_count']}")
    print("Count by spot_type:")
    for item in summary["spot_type_counts"]:
        print(f"  - {item['spot_type']}: {item['count']}")
    print(f"Core tourism spots: {summary['core_tourism_spot_count']}")
    print("Top examples with low quality score:")
    for spot in summary["low_quality_examples"][:5]:
        print(
            "  - "
            f"{spot['name']} "
            f"({spot['spot_type']}, quality={spot['quality_score']}, "
            f"penalty={spot['main_recommendation_penalty']})"
        )
    print(f"Generated output path: {OUTPUT_JSON}")


if __name__ == "__main__":
    main()
