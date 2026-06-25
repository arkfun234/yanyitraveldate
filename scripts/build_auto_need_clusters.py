#!/usr/bin/env python3
"""Build automatic travel-need clusters from raw monthly survey free text."""

from __future__ import annotations

import argparse
import csv
import json
import math
import re
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd
from sklearn.cluster import KMeans
from sklearn.feature_extraction.text import TfidfVectorizer


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT_DIR = ROOT / "data" / "monthly_surveys"
DEFAULT_OUTPUT_JSON = ROOT / "data" / "auto_need_clusters.json"
DEFAULT_OUTPUT_CSV = ROOT / "data" / "auto_need_clusters_summary.csv"

FREE_TEXT_CANDIDATES = [
    "福井県内での交通手段の満足度の理由",
    "満足度(商品・サービス)の理由",
    "満足度の理由",
    "不便さの内容",
    "推奨項目",
    "施設に求めるもの",
    "福井県に求めるもの",
    "その他",
    "アンケート回答前に訪問した主な場所FA",
]

MEANINGLESS_TEXTS = {
    "",
    "0",
    "０",
    "なし",
    "無し",
    "ない",
    "特になし",
    "特に無し",
    "特にない",
    "とくになし",
    "選択なし",
    "該当なし",
    "該当無し",
    "未記入",
    "無記入",
    "不明",
    "na",
    "n/a",
    "nan",
    "none",
    "-",
    "ー",
    "―",
}

TRAIT_RULES = {
    "relaxation": {
        "keywords": ["温泉", "風呂", "露天", "宿", "宿泊", "ゆっくり", "静か", "癒し", "清潔", "休憩", "のんびり"],
        "purpose_tags": ["温泉や露天風呂", "宿でのんびり過ごす"],
    },
    "food_value": {
        "keywords": ["食", "そば", "蕎麦", "海鮮", "蟹", "かに", "カニ", "甘エビ", "美味しい", "おいしい", "市場", "グルメ", "料理"],
        "purpose_tags": ["地元の美味しいものを食べる"],
    },
    "nature": {
        "keywords": ["自然", "景色", "海", "山", "湖", "紅葉", "桜", "花", "水仙", "公園", "絶景", "川", "海岸"],
        "purpose_tags": ["自然鑑賞"],
    },
    "exploration_experience": {
        "keywords": ["体験", "工芸", "博物館", "学び", "恐竜", "子供", "子ども", "家族", "歴史", "文化", "まち", "散策"],
        "purpose_tags": ["各種体験", "テーマパーク（遊園地、動物園、博物館など）", "名所、旧跡の観光"],
    },
    "efficiency_touring": {
        "keywords": ["ドライブ", "周遊", "駐車場", "交通", "便利", "駅", "バス", "アクセス", "車", "道路", "移動"],
        "purpose_tags": ["ドライブ・ツーリング"],
    },
    "planning": {
        "keywords": ["情報", "案内", "分かりやすい", "わかりやすい", "安心", "スタッフ", "接客", "トイレ", "説明", "予約"],
        "purpose_tags": ["旅行計画・現地情報の分かりやすさ"],
    },
}

THEME_RULES = [
    {
        "tag": "dinosaur_museum_family_experience",
        "name": "恐竜博物館・家族体験ニーズ層",
        "keywords": ["恐竜", "博物館", "子供", "子ども", "家族", "体験", "学び"],
    },
    {
        "tag": "echizen_soba_local_food",
        "name": "越前そば・地元食ニーズ層",
        "keywords": ["そば", "蕎麦", "越前そば", "美味しい", "料理", "食"],
    },
    {
        "tag": "seafood_market_gourmet",
        "name": "海鮮・市場グルメニーズ層",
        "keywords": ["海鮮", "かに", "カニ", "蟹", "甘エビ", "市場"],
    },
    {
        "tag": "onsen_lodging_relaxation",
        "name": "温泉・宿泊リラックスニーズ層",
        "keywords": ["温泉", "風呂", "宿泊", "宿", "ゆっくり", "静か", "癒し"],
    },
    {
        "tag": "public_transport_access",
        "name": "公共交通アクセス改善ニーズ層",
        "keywords": ["バス", "交通", "駅", "アクセス", "移動", "新幹線"],
    },
    {
        "tag": "car_parking_touring",
        "name": "車移動・駐車場利便ニーズ層",
        "keywords": ["駐車場", "車", "ドライブ", "周遊", "道路"],
    },
    {
        "tag": "facility_comfort_safety",
        "name": "施設快適性・安心ニーズ層",
        "keywords": ["トイレ", "清潔", "案内", "スタッフ", "接客", "安心", "便利"],
    },
    {
        "tag": "nature_scenic_drive",
        "name": "自然景観・ドライブニーズ層",
        "keywords": ["自然", "景色", "海", "山", "湖", "紅葉", "桜", "絶景", "水仙"],
    },
]

NAME_FALLBACKS = [
    ("relaxation", "温泉・宿泊リラックスニーズ層"),
    ("food_value", "地元グルメ・名物食ニーズ層"),
    ("nature", "自然景観・季節鑑賞ニーズ層"),
    ("exploration_experience", "体験・学び・家族向け観光層"),
    ("efficiency_touring", "周遊効率・アクセス重視層"),
    ("planning", "案内・安心感・施設利便性重視層"),
]

COMPLAINT_COLUMNS = {
    "不便さの内容",
    "施設に求めるもの",
    "福井県に求めるもの",
    "福井県内での交通手段の満足度の理由",
}
COMPLAINT_KEYWORDS = [
    "不便",
    "困る",
    "少ない",
    "不足",
    "高い",
    "分かりにくい",
    "わかりにくい",
    "混雑",
    "遠い",
    "改善",
    "増や",
    "欲しい",
    "ほしい",
    "必要",
    "駐車場",
    "バス",
    "交通",
    "トイレ",
    "案内",
]

SPLIT_PATTERN = re.compile(r"[、,;/／\n\r\t]+")
USEFUL_SHORT_KEYWORDS = {"そば", "かに", "カニ", "蟹", "海", "山", "湖", "宿", "駅", "車", "花", "桜"}
GENERIC_KEYWORD_FRAGMENTS = {
    "いま",
    "います",
    "した",
    "ました",
    "でした",
    "です",
    "ます",
    "った",
    "かった",
    "た。",
    "い。",
    "す。",
    "。。",
    "から",
    "ない",
    "てい",
    "しい",
    "まし",
    "でし",
    "と思",
    "たです",
    "ったです",
    "たで",
    "ったで",
    "あり",
    "ある",
    "こと",
    "もの",
    "よう",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Build automatic free-text travel-need clusters from monthly survey CSV files."
    )
    parser.add_argument("--input-dir", default=str(DEFAULT_INPUT_DIR))
    parser.add_argument("--n-clusters", type=int, default=12)
    parser.add_argument("--output-json", default=str(DEFAULT_OUTPUT_JSON))
    parser.add_argument("--output-csv", default=str(DEFAULT_OUTPUT_CSV))
    return parser.parse_args()


def resolve_path(path_text: str) -> Path:
    path = Path(path_text)
    return path if path.is_absolute() else ROOT / path


def safe_relative(path: Path) -> str:
    try:
        return str(path.relative_to(ROOT))
    except ValueError:
        return str(path)


def read_csv_auto_encoding(path: Path) -> tuple[pd.DataFrame, str]:
    last_error: Exception | None = None
    for encoding in ("utf-8-sig", "cp932"):
        try:
            return pd.read_csv(path, encoding=encoding, dtype=str).fillna(""), encoding
        except UnicodeDecodeError as exc:
            last_error = exc
    if last_error:
        raise last_error
    raise ValueError(f"Could not read CSV: {path}")


def source_month_from_path(path: Path) -> str:
    match = re.search(r"(\d{6})", path.stem)
    return match.group(1) if match else path.stem


def normalize_text(value: Any) -> str:
    text = str(value or "").strip()
    return re.sub(r"\s+", " ", text)


def is_meaningful_text(text: str) -> bool:
    normalized = normalize_text(text)
    compact = re.sub(r"[\s　。．.、,]+", "", normalized).lower()
    if compact in MEANINGLESS_TEXTS:
        return False
    if len(compact) < 3:
        return False
    if re.fullmatch(r"[0０\-ー―]+", compact):
        return False
    return True


def combine_free_text(row: pd.Series, columns: list[str]) -> str:
    values: list[str] = []
    seen: set[str] = set()
    for column in columns:
        text = normalize_text(row.get(column, ""))
        if not is_meaningful_text(text):
            continue
        if text in seen:
            continue
        seen.add(text)
        values.append(text)
    return "。".join(values)


def collect_source_columns(row: pd.Series, columns: list[str]) -> list[str]:
    source_columns: list[str] = []
    for column in columns:
        if is_meaningful_text(normalize_text(row.get(column, ""))):
            source_columns.append(column)
    return source_columns


def load_monthly_surveys(input_dir: Path) -> tuple[pd.DataFrame, list[dict[str, str]]]:
    frames: list[pd.DataFrame] = []
    read_files: list[dict[str, str]] = []
    for csv_path in sorted(input_dir.glob("*.csv")):
        frame, encoding = read_csv_auto_encoding(csv_path)
        source_month = source_month_from_path(csv_path)
        frame["source_month"] = source_month
        frame["source_file"] = csv_path.name
        frames.append(frame)
        read_files.append({"file": csv_path.name, "encoding": encoding, "rows": str(len(frame))})
    if not frames:
        return pd.DataFrame(), read_files
    return pd.concat(frames, ignore_index=True, sort=False).fillna(""), read_files


def detected_free_text_columns(frame: pd.DataFrame) -> list[str]:
    return [column for column in FREE_TEXT_CANDIDATES if column in frame.columns]


def numeric_average(values: pd.Series) -> float | None:
    numbers: list[float] = []
    for value in values:
        text = normalize_text(value).replace(",", "")
        if not text:
            continue
        try:
            number = float(text)
        except ValueError:
            continue
        if math.isfinite(number):
            numbers.append(number)
    if not numbers:
        return None
    return round(sum(numbers) / len(numbers), 3)


def split_multi_values(value: Any) -> list[str]:
    text = normalize_text(value)
    if not text:
        return []
    parts = [part.strip() for part in SPLIT_PATTERN.split(text)]
    return [part for part in parts if is_meaningful_text(part)]


def top_counter_items(counter: Counter[str], limit: int = 8) -> list[dict[str, Any]]:
    return [{"value": value, "count": count} for value, count in counter.most_common(limit)]


def distribution(series: pd.Series, split_values: bool = False, limit: int = 8) -> list[dict[str, Any]]:
    counter: Counter[str] = Counter()
    for value in series:
        values = split_multi_values(value) if split_values else [normalize_text(value)]
        for item in values:
            if is_meaningful_text(item):
                counter[item] += 1
    return top_counter_items(counter, limit)


def list_distribution(values: list[list[str]], limit: int = 8) -> list[dict[str, Any]]:
    counter: Counter[str] = Counter()
    for row_values in values:
        for value in row_values:
            if is_meaningful_text(value):
                counter[value] += 1
    return top_counter_items(counter, limit)


def satisfaction_distribution(frame: pd.DataFrame) -> list[dict[str, Any]]:
    if "満足度" not in frame.columns:
        return []
    return distribution(frame["満足度"], split_values=False, limit=10)


def compute_trait_scores(texts: list[str]) -> tuple[dict[str, float], dict[str, list[str]]]:
    combined_text = "\n".join(texts)
    raw_scores: dict[str, int] = {}
    matched_keywords: dict[str, list[str]] = {}
    for trait, rule in TRAIT_RULES.items():
        keywords = [keyword for keyword in rule["keywords"] if keyword in combined_text]
        raw_scores[trait] = sum(combined_text.count(keyword) for keyword in keywords)
        matched_keywords[trait] = keywords[:12]

    max_score = max(raw_scores.values(), default=0)
    if max_score <= 0:
        trait_scores = {trait: 0.0 for trait in TRAIT_RULES}
    else:
        trait_scores = {trait: round(score / max_score, 4) for trait, score in raw_scores.items()}
    return trait_scores, matched_keywords


def keyword_count(texts: list[str], keyword: str) -> int:
    joined = "\n".join(texts)
    return joined.count(keyword)


def is_good_keyword(keyword: str) -> bool:
    text = keyword.strip(" 。、,.・/／-ー―")
    if len(text) < 2:
        return False
    if text in USEFUL_SHORT_KEYWORDS:
        return True
    if text.lower() in GENERIC_KEYWORD_FRAGMENTS or text in GENERIC_KEYWORD_FRAGMENTS:
        return False
    if re.fullmatch(r"[ぁ-んー]{2,5}", text):
        return False
    if re.search(r"(です|ます|ました|でした|だった|かった|して|した|ない|たい|から|ので|けど|思う|思い)$", text):
        return False
    return bool(re.search(r"[一-龯ァ-ンA-Za-z0-9]", text))


def merge_top_keywords(
    texts: list[str], matched_keywords: dict[str, list[str]], tfidf_keywords: list[str], limit: int = 12
) -> list[str]:
    all_rule_keywords = [
        keyword
        for keywords in matched_keywords.values()
        for keyword in keywords
        if is_good_keyword(keyword)
    ]
    ranked_rule_keywords = [
        keyword
        for keyword, _count in Counter({kw: keyword_count(texts, kw) for kw in all_rule_keywords}).most_common()
    ]

    merged: list[str] = []
    for keyword in [*ranked_rule_keywords, *tfidf_keywords]:
        cleaned = keyword.strip(" 。、,.・/／-ー―")
        if not is_good_keyword(cleaned):
            continue
        if any(cleaned in existing or existing in cleaned for existing in merged):
            continue
        merged.append(cleaned)
        if len(merged) >= limit:
            break
    return merged


def compute_purpose_tags(trait_scores: dict[str, float]) -> list[str]:
    tags: list[str] = []
    ranked_traits = sorted(trait_scores, key=lambda trait: (-trait_scores[trait], trait))
    for trait in ranked_traits:
        if trait_scores[trait] <= 0:
            continue
        for tag in TRAIT_RULES[trait]["purpose_tags"]:
            if tag not in tags:
                tags.append(tag)
    return tags[:8]


def theme_scores(top_keywords: list[str], cluster_texts: list[str]) -> list[dict[str, Any]]:
    keyword_text = " ".join(top_keywords[:10])
    scores: list[dict[str, Any]] = []
    for rule_index, rule in enumerate(THEME_RULES):
        matched = [keyword for keyword in rule["keywords"] if keyword in keyword_text]
        weighted_score = 0
        for keyword in matched:
            if keyword in top_keywords[:3]:
                weighted_score += 5
            elif keyword in top_keywords[:8]:
                weighted_score += 3
            else:
                weighted_score += 1
        if weighted_score > 0:
            scores.append(
                {
                    "tag": rule["tag"],
                    "name": rule["name"],
                    "score": weighted_score,
                    "matched_keywords": matched,
                    "rule_index": rule_index,
                }
            )
    return sorted(scores, key=lambda item: (-item["score"], item["rule_index"]))


def cluster_theme_tags(scored_themes: list[dict[str, Any]], limit: int = 4) -> list[str]:
    return [theme["tag"] for theme in scored_themes[:limit]]


def primary_theme_tag_from_name(name: str) -> str | None:
    if name.startswith("恐竜博物館"):
        return "dinosaur_museum_family_experience"
    if name.startswith("越前そば"):
        return "echizen_soba_local_food"
    if name.startswith("海鮮"):
        return "seafood_market_gourmet"
    if name.startswith("温泉"):
        return "onsen_lodging_relaxation"
    if name.startswith("公共交通"):
        return "public_transport_access"
    if name.startswith("車移動"):
        return "car_parking_touring"
    if name.startswith("施設快適性"):
        return "facility_comfort_safety"
    if name.startswith("自然景観"):
        return "nature_scenic_drive"
    return None


def ordered_theme_tags(name: str, scored_themes: list[dict[str, Any]], limit: int = 4) -> list[str]:
    tags = cluster_theme_tags(scored_themes, limit=limit)
    primary = primary_theme_tag_from_name(name)
    if not primary:
        return tags
    return [primary, *[tag for tag in tags if tag != primary]][:limit]


def theme_confidence(scored_themes: list[dict[str, Any]]) -> float:
    if not scored_themes:
        return 0.0
    best = scored_themes[0]["score"]
    total = sum(theme["score"] for theme in scored_themes)
    return round(min(1.0, best / max(total, 1) + min(best, 8) / 16), 3)


def base_cluster_name(trait_scores: dict[str, float], scored_themes: list[dict[str, Any]], top_keywords: list[str]) -> str:
    first = top_keywords[0] if top_keywords else ""
    leading_text = " ".join(top_keywords[:5])
    if first in {"温泉", "風呂", "宿泊", "宿"}:
        return "温泉・宿泊リラックスニーズ層"
    if first in {"そば", "蕎麦", "越前そば"}:
        return "越前そば・地元食ニーズ層"
    if first in {"海鮮", "かに", "カニ", "蟹", "甘エビ", "市場"}:
        return "海鮮・市場グルメニーズ層"
    if first in {"美味しい", "おいしい", "料理", "食"}:
        if any(keyword in leading_text for keyword in ["海鮮", "かに", "カニ", "蟹", "甘エビ", "市場"]):
            return "海鮮・市場グルメニーズ層"
        if any(keyword in leading_text for keyword in ["そば", "蕎麦", "越前そば"]):
            return "越前そば・地元食ニーズ層"
        return "地元グルメ・名物食ニーズ層"
    if first in {"恐竜", "博物館"}:
        return "恐竜博物館・家族体験ニーズ層"
    if first in {"バス", "交通", "駅", "アクセス", "移動"}:
        return "公共交通アクセス改善ニーズ層"
    if first in {"駐車場", "車", "ドライブ", "周遊"}:
        return "車移動・駐車場利便ニーズ層"
    if first in {"トイレ", "清潔", "案内", "スタッフ", "接客", "安心", "便利"}:
        return "施設快適性・安心ニーズ層"
    if first in {"自然", "景色", "海", "山", "湖", "紅葉", "桜", "絶景", "水仙"}:
        return "自然景観・ドライブニーズ層"

    if scored_themes:
        return scored_themes[0]["name"]
    best_trait = max(trait_scores, key=lambda trait: trait_scores[trait], default="")
    if best_trait and trait_scores.get(best_trait, 0) > 0:
        for trait, name in NAME_FALLBACKS:
            if trait == best_trait:
                return name
    if top_keywords:
        return f"{top_keywords[0]} 関連ニーズ層"
    return "自由記述ニーズ層"


def is_complaint_or_improvement_cluster(
    cluster_texts: list[str], dominant_columns: list[dict[str, Any]], top_keywords: list[str]
) -> bool:
    column_values = {item["value"] for item in dominant_columns[:4]}
    if column_values & COMPLAINT_COLUMNS:
        return True
    text = "\n".join(cluster_texts + top_keywords)
    return any(keyword in text for keyword in COMPLAINT_KEYWORDS)


def duplicate_suffix(cluster: dict[str, Any]) -> str:
    tags = set(cluster.get("cluster_theme_tags", []))
    keywords = " ".join(cluster.get("top_keywords", [])[:10])
    columns = {item["value"] for item in cluster.get("dominant_text_columns", [])[:3]}
    if {"不便さの内容", "福井県に求めるもの", "施設に求めるもの"} & columns:
        return "改善要望中心"
    if "満足度の理由" in columns or "満足度(商品・サービス)の理由" in columns:
        return "満足理由中心"
    if "public_transport_access" in tags or any(word in keywords for word in ["バス", "交通", "駅", "移動"]):
        return "交通不便言及"
    if "car_parking_touring" in tags or "駐車場" in keywords:
        return "駐車場言及"
    if "facility_comfort_safety" in tags:
        return "施設快適性言及"
    if "dinosaur_museum_family_experience" in tags:
        return "家族体験寄り"
    if "seafood_market_gourmet" in tags:
        return "海鮮寄り"
    if "onsen_lodging_relaxation" in tags:
        return "温泉寄り"
    if "nature_scenic_drive" in tags:
        return "自然景観寄り"
    return "サブテーマ分化"


def uniquify_cluster_names(clusters: list[dict[str, Any]]) -> None:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for cluster in clusters:
        grouped.setdefault(cluster["name"], []).append(cluster)

    for name, same_name_clusters in grouped.items():
        if len(same_name_clusters) <= 1:
            continue
        used_names = {name}
        for cluster in same_name_clusters[1:]:
            suffix = duplicate_suffix(cluster)
            candidate = f"{name}（{suffix}）"
            serial = 2
            while candidate in used_names:
                candidate = f"{name}（{suffix}{serial}）"
                serial += 1
            cluster["name"] = candidate
            used_names.add(candidate)


def compact_distribution_text(items: list[dict[str, Any]], limit: int = 3) -> str:
    values = [item["value"] for item in items[:limit] if item.get("value")]
    return "・".join(values) if values else "特定傾向なし"


def cluster_summary(
    name: str,
    top_keywords: list[str],
    size: int,
    top_areas: list[dict[str, Any]],
    top_companions: list[dict[str, Any]],
    top_purposes: list[dict[str, Any]],
    is_improvement: bool,
) -> str:
    keyword_text = "・".join(top_keywords[:6]) if top_keywords else "自由記述"
    improvement_text = "不便さや改善要望も強く含む" if is_improvement else "満足理由や訪問動機の記述が中心"
    return (
        f"{name}。このクラスタは「{keyword_text}」への関心が目立ち、"
        f"主に{compact_distribution_text(top_areas)}エリア、"
        f"{compact_distribution_text(top_companions)}の回答に多く見られます。"
        f"目的は{compact_distribution_text(top_purposes)}が中心で、{improvement_text}クラスタです。"
        f"該当コメントは{size}件です。"
    )


def top_tfidf_keywords(vectorizer: TfidfVectorizer, matrix: Any, row_indexes: list[int], limit: int = 12) -> list[str]:
    if not row_indexes:
        return []
    feature_names = vectorizer.get_feature_names_out()
    centroid = matrix[row_indexes].mean(axis=0)
    weights = centroid.A1 if hasattr(centroid, "A1") else centroid.toarray().ravel()
    ranked_indexes = weights.argsort()[::-1]
    keywords: list[str] = []
    for index in ranked_indexes:
        keyword = str(feature_names[index]).strip()
        if not is_good_keyword(keyword):
            continue
        if keyword not in keywords:
            keywords.append(keyword)
        if len(keywords) >= limit:
            break
    return keywords


def representative_comments(
    frame: pd.DataFrame, row_indexes: list[int], distances: Any, label: int, limit: int = 5
) -> list[str]:
    ranked = sorted(row_indexes, key=lambda idx: float(distances[idx][label]))
    comments: list[str] = []
    seen: set[str] = set()
    for index in ranked:
        text = str(frame.iloc[index]["text_for_clustering"])
        if text in seen:
            continue
        seen.add(text)
        comments.append(text[:220])
        if len(comments) >= limit:
            break
    return comments


def build_clusters(frame: pd.DataFrame, requested_clusters: int) -> tuple[list[dict[str, Any]], int]:
    texts = frame["text_for_clustering"].tolist()
    effective_clusters = max(1, min(requested_clusters, len(texts)))
    if len(texts) < 2:
        effective_clusters = 1

    vectorizer = TfidfVectorizer(
        analyzer="char_wb",
        ngram_range=(2, 5),
        min_df=2 if len(texts) >= 20 else 1,
        max_df=0.9,
        max_features=6000,
        sublinear_tf=True,
    )
    matrix = vectorizer.fit_transform(texts)

    if effective_clusters == 1:
        labels = [0] * len(texts)
        distances = [[0.0] for _ in texts]
    else:
        model = KMeans(n_clusters=effective_clusters, random_state=42, n_init=20)
        labels = model.fit_predict(matrix).tolist()
        distances = model.transform(matrix)

    frame = frame.copy()
    frame["cluster_label"] = labels
    clusters: list[dict[str, Any]] = []

    for label in sorted(set(labels)):
        cluster_frame = frame[frame["cluster_label"] == label]
        row_indexes = cluster_frame.index.tolist()
        cluster_texts = cluster_frame["text_for_clustering"].tolist()
        tfidf_keywords = top_tfidf_keywords(vectorizer, matrix, row_indexes)
        trait_scores, matched_keywords = compute_trait_scores(cluster_texts)
        top_keywords = merge_top_keywords(cluster_texts, matched_keywords, tfidf_keywords)
        scored_themes = theme_scores(top_keywords, cluster_texts)
        purpose_tags = compute_purpose_tags(trait_scores)
        top_areas = distribution(cluster_frame.get("回答エリア", pd.Series(dtype=str)), limit=8)
        top_companions = distribution(cluster_frame.get("同行者", pd.Series(dtype=str)), split_values=True, limit=8)
        top_purposes = distribution(cluster_frame.get("訪問目的ALL", pd.Series(dtype=str)), split_values=True, limit=10)
        dominant_columns = list_distribution(cluster_frame["text_source_columns"].tolist(), limit=8)
        is_improvement = is_complaint_or_improvement_cluster(cluster_texts, dominant_columns, top_keywords)
        name = base_cluster_name(trait_scores, scored_themes, top_keywords)
        theme_tags = ordered_theme_tags(name, scored_themes)
        cluster_id = f"auto_need_cluster_{len(clusters) + 1:02d}"
        clusters.append(
            {
                "id": cluster_id,
                "name": name,
                "summary": cluster_summary(
                    name,
                    top_keywords,
                    len(cluster_frame),
                    top_areas,
                    top_companions,
                    top_purposes,
                    is_improvement,
                ),
                "size": int(len(cluster_frame)),
                "top_keywords": top_keywords,
                "cluster_theme_tags": theme_tags,
                "is_complaint_or_improvement_cluster": is_improvement,
                "dominant_text_columns": dominant_columns,
                "theme_confidence": theme_confidence(scored_themes),
                "representative_comments": representative_comments(frame, row_indexes, distances, label),
                "purpose_tags": purpose_tags,
                "trait_scores": trait_scores,
                "matched_keywords": matched_keywords,
                "top_areas": top_areas,
                "top_companions": top_companions,
                "top_purposes": top_purposes,
                "top_months": distribution(cluster_frame["source_month"], limit=13),
                "avg_nps": numeric_average(cluster_frame.get("NPS", pd.Series(dtype=str))),
                "satisfaction_distribution": satisfaction_distribution(cluster_frame),
            }
        )

    clusters.sort(key=lambda cluster: cluster["size"], reverse=True)
    for index, cluster in enumerate(clusters, start=1):
        cluster["id"] = f"auto_need_cluster_{index:02d}"
    uniquify_cluster_names(clusters)
    for cluster in clusters:
        cluster["summary"] = cluster_summary(
            cluster["name"],
            cluster["top_keywords"],
            cluster["size"],
            cluster["top_areas"],
            cluster["top_companions"],
            cluster["top_purposes"],
            cluster["is_complaint_or_improvement_cluster"],
        )
    return clusters, effective_clusters


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_summary_csv(path: Path, clusters: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8-sig", newline="") as handle:
        writer = csv.DictWriter(
            handle,
            fieldnames=[
                "id",
                "name",
                "size",
                "top_keywords",
                "cluster_theme_tags",
                "is_complaint_or_improvement_cluster",
                "dominant_text_columns",
                "theme_confidence",
                "purpose_tags",
                "top_areas",
                "top_companions",
                "top_purposes",
                "top_months",
                "avg_nps",
                "summary",
            ],
        )
        writer.writeheader()
        for cluster in clusters:
            writer.writerow(
                {
                    "id": cluster["id"],
                    "name": cluster["name"],
                    "size": cluster["size"],
                    "top_keywords": " / ".join(cluster["top_keywords"]),
                    "cluster_theme_tags": " / ".join(cluster["cluster_theme_tags"]),
                    "is_complaint_or_improvement_cluster": cluster["is_complaint_or_improvement_cluster"],
                    "dominant_text_columns": " / ".join(item["value"] for item in cluster["dominant_text_columns"]),
                    "theme_confidence": cluster["theme_confidence"],
                    "purpose_tags": " / ".join(cluster["purpose_tags"]),
                    "top_areas": " / ".join(item["value"] for item in cluster["top_areas"]),
                    "top_companions": " / ".join(item["value"] for item in cluster["top_companions"]),
                    "top_purposes": " / ".join(item["value"] for item in cluster["top_purposes"]),
                    "top_months": " / ".join(item["value"] for item in cluster["top_months"]),
                    "avg_nps": "" if cluster["avg_nps"] is None else cluster["avg_nps"],
                    "summary": cluster["summary"],
                }
            )


def main() -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = parse_args()
    input_dir = resolve_path(args.input_dir)
    output_json = resolve_path(args.output_json)
    output_csv = resolve_path(args.output_csv)

    frame, read_files = load_monthly_surveys(input_dir)
    if frame.empty:
        raise SystemExit(f"No CSV files found in {input_dir}")

    free_text_columns = detected_free_text_columns(frame)
    if not free_text_columns:
        raise SystemExit("No free-text columns were detected.")

    frame["text_source_columns"] = frame.apply(lambda row: collect_source_columns(row, free_text_columns), axis=1)
    frame["text_for_clustering"] = frame.apply(lambda row: combine_free_text(row, free_text_columns), axis=1)
    valid_frame = frame[frame["text_for_clustering"].map(is_meaningful_text)].copy()
    valid_frame.reset_index(drop=True, inplace=True)
    if valid_frame.empty:
        raise SystemExit("No valid free-text rows remained after cleaning.")

    clusters, effective_cluster_count = build_clusters(valid_frame, args.n_clusters)
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "free_text_tfidf_kmeans",
        "input_dir": safe_relative(input_dir),
        "csv_file_count": len(read_files),
        "read_files": read_files,
        "merged_row_count": int(len(frame)),
        "valid_text_count": int(len(valid_frame)),
        "detected_free_text_columns": free_text_columns,
        "requested_cluster_count": int(args.n_clusters),
        "effective_cluster_count": int(effective_cluster_count),
        "notes": [
            "Satisfaction and NPS are not used as clustering features.",
            "Cluster names and summaries are generated by keyword rules, without OpenAI API calls.",
        ],
        "clusters": clusters,
    }

    write_json(output_json, payload)
    write_summary_csv(output_csv, clusters)

    print(f"csv_file_count: {len(read_files)}")
    print(f"merged_row_count: {len(frame)}")
    print(f"valid_text_count: {len(valid_frame)}")
    print("detected_free_text_columns:")
    for column in free_text_columns:
        print(f"- {column}")
    print(f"effective_cluster_count: {effective_cluster_count}")
    for cluster in clusters:
        print(
            f"{cluster['id']} | {cluster['name']} | size={cluster['size']} | "
            f"top_keywords={', '.join(cluster['top_keywords'][:8])} | "
            f"theme_tags={', '.join(cluster['cluster_theme_tags'])}"
        )
    print(f"output_json: {output_json}")
    print(f"output_csv: {output_csv}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
