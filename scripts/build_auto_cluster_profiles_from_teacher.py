#!/usr/bin/env python3
"""Build B-plan automatic clustering baseline profiles from teacher summaries."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
INPUT_PATH = ROOT / "data" / "auto_clustering_baseline" / "cluster_summaries.csv"
OUTPUT_PATH = ROOT / "data" / "auto_clustering_baseline" / "auto_cluster_profiles_from_teacher.json"
SOURCE = "teacher_auto_clustering_baseline"

TRAITS = [
    "planning",
    "relaxation",
    "exploration_experience",
    "food_value",
    "nature",
    "efficiency_touring",
]

TRAIT_KEYWORDS = {
    "planning": [
        "予約",
        "計画",
        "情報",
        "案内",
        "便利",
        "分かりやすい",
        "スムーズ",
        "利便性",
        "快適",
        "安心",
    ],
    "relaxation": [
        "温泉",
        "露天風呂",
        "宿",
        "宿泊",
        "癒し",
        "癒やし",
        "ゆっくり",
        "ゆったり",
        "のんびり",
        "静か",
        "落ち着き",
        "リフレッシュ",
        "休憩",
    ],
    "exploration_experience": [
        "体験",
        "博物館",
        "水族館",
        "恐竜",
        "歴史",
        "文化",
        "寺",
        "神社",
        "城",
        "史跡",
        "旧跡",
        "名所",
        "まちあるき",
        "街歩き",
        "散策",
        "イベント",
        "動物",
        "伝統",
    ],
    "food_value": [
        "食",
        "グルメ",
        "そば",
        "海鮮",
        "カニ",
        "蟹",
        "酒",
        "カフェ",
        "市場",
        "地元",
        "美味しい",
        "買い物",
    ],
    "nature": [
        "自然",
        "山",
        "海",
        "湖",
        "川",
        "渓谷",
        "花",
        "紅葉",
        "桜",
        "水仙",
        "景色",
        "絶景",
        "公園",
        "美しい",
    ],
    "efficiency_touring": [
        "ドライブ",
        "周遊",
        "車",
        "道の駅",
        "駅",
        "交通",
        "アクセス",
        "移動",
        "ツーリング",
    ],
}

PURPOSE_KEYWORDS = {
    "温泉や露天風呂": ["温泉", "露天風呂"],
    "宿でのんびり過ごす": ["宿", "宿泊", "ゆっくり", "ゆったり", "のんびり", "静か", "落ち着き", "癒し", "癒やし"],
    "地元の美味しいものを食べる": ["食", "グルメ", "そば", "海鮮", "カニ", "蟹", "酒", "カフェ", "市場", "地元", "美味しい"],
    "花見や紅葉などの自然鑑賞": ["自然", "花", "紅葉", "桜", "水仙", "景色", "絶景", "公園", "山", "海", "湖", "川", "渓谷"],
    "名所、旧跡の観光": ["名所", "旧跡", "史跡", "寺", "神社", "城", "歴史", "文化", "伝統"],
    "テーマパーク": ["テーマパーク", "遊園地", "レジャー"],
    "まちあるき、都市散策": ["まちあるき", "街歩き", "散策", "都市"],
    "各種体験": ["体験", "博物館", "水族館", "恐竜", "イベント", "動物"],
    "ドライブ・ツーリング": ["ドライブ", "ツーリング", "周遊", "車", "道の駅", "駅", "交通", "アクセス", "移動"],
}


def parse_int(value: Any, field_name: str) -> int:
    text = str(value or "").strip().replace(",", "")
    if not text:
        return 0
    try:
        return int(text)
    except ValueError as exc:
        raise ValueError(f"Invalid integer in {field_name}: {value!r}") from exc


def find_keywords(text: str, keywords: list[str]) -> list[str]:
    return [keyword for keyword in keywords if keyword in text]


def normalize_scores(raw_scores: dict[str, int]) -> dict[str, float]:
    max_score = max(raw_scores.values(), default=0)
    if max_score <= 0:
        return {trait: 0.0 for trait in TRAITS}
    return {trait: round(raw_scores[trait] / max_score, 4) for trait in TRAITS}


def top_traits(trait_scores: dict[str, float]) -> list[str]:
    return sorted(TRAITS, key=lambda trait: (-trait_scores[trait], TRAITS.index(trait)))[:3]


def purpose_tags(summary: str) -> list[str]:
    return [
        purpose
        for purpose, keywords in PURPOSE_KEYWORDS.items()
        if find_keywords(summary, keywords)
    ]


def build_profile(row: dict[str, str]) -> dict[str, Any]:
    source_cluster_id = parse_int(row.get("クラスタID"), "クラスタID")
    summary = str(row.get("要約") or "").strip()
    matched_keywords = {
        trait: find_keywords(summary, keywords)
        for trait, keywords in TRAIT_KEYWORDS.items()
    }
    raw_scores = {trait: len(keywords) for trait, keywords in matched_keywords.items()}
    trait_scores = normalize_scores(raw_scores)

    return {
        "auto_cluster_id": f"teacher_auto_cluster_{source_cluster_id}",
        "source_cluster_id": source_cluster_id,
        "sample_count": parse_int(row.get("所属件数"), "所属件数"),
        "summary": summary,
        "trait_scores": trait_scores,
        "top_traits": top_traits(trait_scores),
        "purpose_tags": purpose_tags(summary),
        "matched_keywords": matched_keywords,
        "source": SOURCE,
    }


def load_rows() -> list[dict[str, str]]:
    with INPUT_PATH.open("r", encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def main() -> None:
    rows = load_rows()
    profiles = [build_profile(row) for row in rows]

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with OUTPUT_PATH.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(profiles, f, ensure_ascii=False, indent=2)
        f.write("\n")

    print(f"total cluster count: {len(profiles)}")
    for profile in profiles:
        print(
            "cluster id: {cluster_id}, sample count: {sample_count}, top 3 traits: {top_traits}".format(
                cluster_id=profile["auto_cluster_id"],
                sample_count=profile["sample_count"],
                top_traits=", ".join(profile["top_traits"]),
            )
        )
    print(f"output path: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
