#!/usr/bin/env python3
"""Build six-dimension trait profiles for traveler clusters."""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = ROOT / "data" / "cluster_trait_profiles.json"

TRAITS = [
    "planning",
    "relaxation",
    "exploration_experience",
    "food_value",
    "nature",
    "efficiency_touring",
]

TRAIT_FIELD_KEYWORDS = {
    "planning": [
        "情報収集",
        "観光パンフレット",
        "インターネット",
        "アプリ",
        "観光協会",
        "案内所",
        "宿泊施設",
        "新聞",
        "雑誌",
        "ガイドブック",
        "旅行会社",
        "宿泊数",
        "交通手段_新幹線",
        "交通手段_レンタカー",
        "交通手段_在来線",
    ],
    "relaxation": [
        "訪問目的_温泉",
        "露天風呂",
        "宿でのんびり",
        "のんびり",
        "施設に求める",
    ],
    "exploration_experience": [
        "訪問目的_各種体験",
        "各種体験",
        "テーマパーク",
        "まちあるき",
        "都市散策",
        "名所",
        "旧跡",
        "お祭り",
        "イベント",
        "スポーツ観戦",
        "芸能鑑賞",
    ],
    "food_value": [
        "地元の美味しい",
        "美味しいもの",
        "食べる",
        "買い物",
        "アウトレット",
        "県内消費額",
    ],
    "nature": [
        "花見",
        "紅葉",
        "自然鑑賞",
        "アウトドア",
        "海水浴",
        "釣り",
        "登山",
    ],
    "efficiency_touring": [
        "ドライブ",
        "ツーリング",
        "交通手段_自家用車",
        "自家用車",
        "エリア訪問回数",
        "訪問回数",
    ],
}

TRAIT_FIELD_WEIGHTS = {
    "relaxation": {
        "瑷晱鐩殑_娓╂硥": 1.8,
        "闇插ぉ棰ㄥ憘": 1.8,
        "瀹裤仹銇倱銇炽倞": 1.8,
    },
    "nature": {
        "鑺辫": 1.8,
        "绱呰憠": 1.8,
        "鑷劧閼戣碁": 1.8,
        "銈偊銉堛儔銈?": 1.7,
    },
    "efficiency_touring": {
        "浜ら€氭墜娈礯鑷鐢ㄨ粖": 0.35,
        "鑷鐢ㄨ粖": 0.35,
        "銈ㄣ儶銈㈣í鍟忓洖鏁?": 0.45,
        "瑷晱鍥炴暟": 0.45,
    },
}

PLACE_KEYWORD_BOOSTS = {
    "nature": ["森", "山", "渓谷", "花", "紅葉", "海", "湖", "水仙", "公園", "自然", "橋"],
    "relaxation": ["温泉", "湯", "露天風呂", "宿", "旅館", "癒し", "滞在", "あわら"],
    "food_value": ["そば", "食", "グルメ", "市場", "海鮮", "酒", "カフェ", "屋台"],
    "exploration_experience": ["恐竜", "博物館", "水族館", "体験", "工房", "城", "史跡", "寺", "神社", "まちあるき", "永平寺"],
    "efficiency_touring": ["道の駅", "駅", "ドライブ", "周遊"],
}

NAME_KEYWORD_BOOSTS = {
    "nature": ["自然"],
    "relaxation": ["温泉", "癒し", "静養", "滞在", "リラックス", "穏やか"],
    "food_value": ["美食", "食"],
    "exploration_experience": ["探索", "体験", "文化", "探究"],
    "efficiency_touring": ["周遊", "効率"],
}

NAME_KEYWORD_BOOST_VALUES = {
    "nature": {
        "自然": 0.85,
    },
    "relaxation": {
        "温泉": 0.85,
        "癒し": 0.85,
        "静養": 0.75,
        "滞在": 0.70,
        "リラックス": 0.80,
        "穏やか": 1.10,
    },
    "food_value": {
        "美食": 0.70,
        "食": 0.55,
    },
    "exploration_experience": {
        "探索": 0.80,
        "体験": 0.75,
        "文化": 0.85,
        "探究": 0.85,
    },
    "efficiency_touring": {
        "周遊": 0.70,
        "効率": 0.70,
    },
}

TRAIT_CAPS = {
    "planning": 0.75,
    "efficiency_touring": 0.80,
}


def load_json(path: str) -> Any:
    with (ROOT / path).open("r", encoding="utf-8") as f:
        return json.load(f)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def numeric_items(profile: dict[str, Any]) -> dict[str, float]:
    return {field: float(value) for field, value in profile.items() if is_number(value)}


def trait_score_for_fields(
    fields: dict[str, float], trait: str, keywords: list[str]
) -> tuple[float, list[dict[str, float | str]]]:
    matched = []
    weighted_values = []
    for field, value in fields.items():
        if any(keyword in field for keyword in keywords):
            weight = 1.0
            for weight_keyword, multiplier in TRAIT_FIELD_WEIGHTS.get(trait, {}).items():
                if weight_keyword in field:
                    weight = multiplier
                    break
            weighted_value = value * weight
            weighted_values.append(weighted_value)
            matched.append({"field": field, "value": value, "weight": weight, "weighted_value": weighted_value})
    matched.sort(key=lambda item: float(item["value"]), reverse=True)
    if not weighted_values:
        return 0.0, matched
    return sum(weighted_values) / len(weighted_values), matched


def keyword_boost(text: str, keywords: list[str], boost_per_hit: float, max_boost: float) -> float:
    hits = sum(1 for keyword in keywords if keyword and keyword in text)
    return min(hits * boost_per_hit, max_boost)


def weighted_name_boost(text: str, trait: str) -> float:
    return sum(value for keyword, value in NAME_KEYWORD_BOOST_VALUES.get(trait, {}).items() if keyword in text)


def apply_context_boosts(
    raw_scores: dict[str, float], cluster_name: str, top_places: list[dict[str, Any]]
) -> tuple[dict[str, float], dict[str, dict[str, float]]]:
    boosted = dict(raw_scores)
    boost_details = {trait: {"name_boost": 0.0, "top_place_boost": 0.0, "cap_applied": 0.0} for trait in TRAITS}
    place_text = " ".join(str(place.get("place", "")) for place in top_places)

    for trait in TRAITS:
        name_boost = weighted_name_boost(cluster_name, trait)
        place_boost = keyword_boost(place_text, PLACE_KEYWORD_BOOSTS.get(trait, []), 0.18, 0.72)
        boosted[trait] = boosted.get(trait, 0.0) + name_boost + place_boost
        boost_details[trait]["name_boost"] = round(name_boost, 6)
        boost_details[trait]["top_place_boost"] = round(place_boost, 6)

    for trait, cap in TRAIT_CAPS.items():
        if boosted.get(trait, 0.0) > cap:
            boost_details[trait]["cap_applied"] = round(boosted[trait] - cap, 6)
            boosted[trait] = cap

    return boosted, boost_details


def normalize_trait_scores(raw_scores: dict[str, float]) -> dict[str, float]:
    max_score = max(raw_scores.values()) if raw_scores else 0.0
    if max_score <= 0:
        return {trait: 0.0 for trait in TRAITS}
    return {trait: round(raw_scores.get(trait, 0.0) / max_score, 4) for trait in TRAITS}


def top_behavior_features(fields: dict[str, float], limit: int = 10) -> list[dict[str, float | str]]:
    return [
        {"field": field, "value": value}
        for field, value in sorted(fields.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]


def top_places_by_cluster(top_places_data: dict[str, Any]) -> dict[str, list[dict[str, Any]]]:
    result = {}
    for cluster in top_places_data.get("clusters", []):
        cluster_id = f"cluster_{cluster.get('id')}"
        places = []
        for place in cluster.get("top_places", []):
            if not isinstance(place, dict):
                continue
            places.append({
                "rank": place.get("rank"),
                "place": place.get("place", ""),
                "users": place.get("users", 0),
            })
        result[cluster_id] = places
    return result


def cluster_names_by_id(top_places_data: dict[str, Any]) -> dict[str, str]:
    return {
        f"cluster_{cluster.get('id')}": cluster.get("name", "")
        for cluster in top_places_data.get("clusters", [])
    }


def top_traits(trait_scores: dict[str, float], limit: int = 3) -> list[tuple[str, float]]:
    return sorted(trait_scores.items(), key=lambda item: item[1], reverse=True)[:limit]


def suspicious_notes(cluster_name: str, trait_scores: dict[str, float]) -> list[str]:
    top2 = {trait for trait, _ in top_traits(trait_scores, 2)}
    rules = [
        ("自然", "nature", "自然 but nature is not top 2"),
        ("温泉", "relaxation", "温泉 but relaxation is not top 2"),
        ("癒し", "relaxation", "癒し but relaxation is not top 2"),
        ("静養", "relaxation", "静養 but relaxation is not top 2"),
        ("滞在", "relaxation", "滞在 but relaxation is not top 2"),
        ("リラックス", "relaxation", "リラックス but relaxation is not top 2"),
        ("穏やか", "relaxation", "穏やか but relaxation is not top 2"),
        ("美食", "food_value", "美食 but food_value is not top 2"),
        ("食", "food_value", "食 but food_value is not top 2"),
        ("探索", "exploration_experience", "探索 but exploration_experience is not top 2"),
        ("体験", "exploration_experience", "体験 but exploration_experience is not top 2"),
        ("文化", "exploration_experience", "文化 but exploration_experience is not top 2"),
        ("探究", "exploration_experience", "探究 but exploration_experience is not top 2"),
        ("周遊", "efficiency_touring", "周遊 but efficiency_touring is not top 2"),
        ("効率", "efficiency_touring", "効率 but efficiency_touring is not top 2"),
    ]
    return [message for keyword, trait, message in rules if keyword in cluster_name and trait not in top2]


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    cluster_profiles = load_json("cluster_profiles.json")
    top_places_data = load_json("20_top_places.json")
    places_by_cluster = top_places_by_cluster(top_places_data)
    names_by_cluster = cluster_names_by_id(top_places_data)

    profiles = []
    for cluster_id in sorted(cluster_profiles, key=lambda value: int(value.split("_")[-1]) if value.split("_")[-1].isdigit() else 9999):
        fields = numeric_items(cluster_profiles[cluster_id])
        raw_scores = {}
        final_raw_scores = {}
        matched_fields = {}
        top_places = places_by_cluster.get(cluster_id, [])
        cluster_name = names_by_cluster.get(cluster_id, "")
        for trait in TRAITS:
            raw_score, matches = trait_score_for_fields(fields, trait, TRAIT_FIELD_KEYWORDS[trait])
            raw_scores[trait] = raw_score
            matched_fields[trait] = matches[:8]

        final_raw_scores, boost_details = apply_context_boosts(raw_scores, cluster_name, top_places)
        trait_scores = normalize_trait_scores(final_raw_scores)
        profiles.append({
            "cluster_id": cluster_id,
            "cluster_name": cluster_name,
            "trait_scores": trait_scores,
            "raw_trait_scores": {trait: round(raw_scores[trait], 6) for trait in TRAITS},
            "final_raw_trait_scores": {trait: round(final_raw_scores[trait], 6) for trait in TRAITS},
            "trait_boosts": boost_details,
            "trait_source_fields": matched_fields,
            "top_behavior_features": top_behavior_features(fields),
            "top_places": top_places,
        })

    output = {
        "traits": TRAITS,
        "source_files": ["cluster_profiles.json", "20_top_places.json"],
        "normalization": "Field evidence is averaged per trait, then cluster-name and top-place boosts are added, planning and efficiency_touring are capped, and final trait scores are normalized to 0-1 within each cluster.",
        "clusters": profiles,
    }

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8") as f:
        json.dump(output, f, ensure_ascii=False, indent=2)

    print(f"Total clusters: {len(profiles)}")
    suspicious = []
    for profile in profiles:
        top_trait_rows = top_traits(profile["trait_scores"], 3)
        trait_text = ", ".join(f"{trait}={score:.4f}" for trait, score in top_trait_rows)
        print(f"- {profile['cluster_id']} {profile['cluster_name']}: {trait_text}")
        notes = suspicious_notes(profile["cluster_name"], profile["trait_scores"])
        if notes:
            suspicious.append({"cluster_id": profile["cluster_id"], "cluster_name": profile["cluster_name"], "notes": notes})
    print(f"Suspicious clusters: {len(suspicious)}")
    for row in suspicious:
        print(f"  - {row['cluster_id']} {row['cluster_name']}: {'; '.join(row['notes'])}")
    print(f"Output path: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
