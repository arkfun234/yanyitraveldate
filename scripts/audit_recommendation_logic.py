#!/usr/bin/env python3
"""Audit recommendation classification inputs and simulated cluster behavior."""

from __future__ import annotations

import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
REPORT_PATH = ROOT / "data" / "audit_recommendation_logic_report.json"


def load_json(path: str) -> Any:
    with (ROOT / path).open("r", encoding="utf-8") as f:
        return json.load(f)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def numeric_items(mapping: dict[str, Any]) -> dict[str, float]:
    return {k: float(v) for k, v in mapping.items() if is_number(v)}


def cosine_similarity(a: dict[str, float], b: dict[str, float], fields: list[str]) -> float:
    dot = sum(a.get(field, 0.0) * b.get(field, 0.0) for field in fields)
    na = sum(a.get(field, 0.0) ** 2 for field in fields)
    nb = sum(b.get(field, 0.0) ** 2 for field in fields)
    if na == 0 or nb == 0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def normalize_place(value: str) -> str:
    return (
        str(value or "")
        .lower()
        .replace(" エリア", "")
        .replace("エリア", "")
        .replace("　", "")
        .replace(" ", "")
        .strip()
    )


def option_sort_key(qid: str) -> tuple[int, str]:
    digits = "".join(ch for ch in qid if ch.isdigit())
    return (int(digits) if digits else 9999, qid)


def get_question_ids(questions: Any, q2psych: dict[str, Any]) -> list[str]:
    if isinstance(questions, list):
        ids = [str(q.get("id")) for q in questions if isinstance(q, dict) and q.get("id")]
        normalized = [qid if qid.startswith("Q") else f"Q{qid}" for qid in ids]
        if normalized:
            return sorted(normalized, key=option_sort_key)
    return sorted(q2psych.keys(), key=option_sort_key)


def collect_used_tags(q2psych: dict[str, dict[str, list[str]]]) -> Counter[str]:
    used = Counter()
    for options in q2psych.values():
        for tags in options.values():
            used.update(tags or [])
    return used


def generated_tags_for_answers(
    q2psych: dict[str, dict[str, list[str]]], answers: dict[str, str]
) -> Counter[str]:
    tags = Counter()
    for qid, option in answers.items():
        tags.update(q2psych.get(qid, {}).get(option, []))
    return tags


def behavior_vector_for_tags(
    tag_counts: Counter[str], weights: dict[str, dict[str, float]]
) -> dict[str, float]:
    vector: dict[str, float] = defaultdict(float)
    for tag, count in tag_counts.items():
        for field, weight in weights.get(tag, {}).items():
            if is_number(weight):
                vector[field] += count * float(weight)
    return dict(vector)


def choose_keyword_pattern(
    qids: list[str], q2psych: dict[str, dict[str, list[str]]], keywords: list[str]
) -> dict[str, str]:
    answers: dict[str, str] = {}
    lowered_keywords = [kw.lower() for kw in keywords]
    for qid in qids:
        best_option = "option_1"
        best_score = -1
        for option, tags in sorted(q2psych.get(qid, {}).items()):
            haystack = " ".join(tags or []).lower()
            score = sum(haystack.count(keyword) for keyword in lowered_keywords)
            if score > best_score:
                best_score = score
                best_option = option
        answers[qid] = best_option
    return answers


def summarize_cluster_fields(cluster_profiles: dict[str, Any]) -> tuple[dict[str, dict[str, float]], dict[str, dict[str, float]]]:
    cluster_vectors = {
        cluster_id: numeric_items(profile)
        for cluster_id, profile in cluster_profiles.items()
        if isinstance(profile, dict)
    }
    fields = sorted({field for vector in cluster_vectors.values() for field in vector})
    stats: dict[str, dict[str, float]] = {}
    for field in fields:
        values = [vector[field] for vector in cluster_vectors.values() if field in vector]
        if not values:
            continue
        stats[field] = {
            "min": min(values),
            "max": max(values),
            "mean": statistics.fmean(values),
            "range": max(values) - min(values),
            "stddev": statistics.pstdev(values) if len(values) > 1 else 0.0,
        }
    return cluster_vectors, stats


def detect_large_scale_fields(field_stats: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    keywords = ["NPS", "満足", "年代", "同行", "県内消費", "消費", "宿泊", "訪問", "回数"]
    rows = []
    for field, stats in field_stats.items():
        keyword_hit = any(keyword in field for keyword in keywords)
        scale_hit = max(abs(stats["min"]), abs(stats["max"]), abs(stats["mean"])) >= 2
        if keyword_hit or scale_hit:
            rows.append({"field": field, "keyword_hit": keyword_hit, **stats})
    return sorted(rows, key=lambda row: (abs(row["max"]), row["range"]), reverse=True)


def detect_cosine_dominance(field_stats: dict[str, dict[str, float]]) -> list[dict[str, Any]]:
    if not field_stats:
        return []
    ranges = [stats["range"] for stats in field_stats.values()]
    stddevs = [stats["stddev"] for stats in field_stats.values()]
    median_range = statistics.median(ranges) or 1.0
    median_stddev = statistics.median(stddevs) or 1.0
    rows = []
    for field, stats in field_stats.items():
        max_abs = max(abs(stats["min"]), abs(stats["max"]))
        dominance_score = (stats["range"] / median_range) + (stats["stddev"] / median_stddev) + (max_abs / 5)
        if dominance_score >= 4 or max_abs >= 5 or stats["range"] >= median_range * 4:
            rows.append({
                "field": field,
                "dominance_score": dominance_score,
                **stats,
            })
    return sorted(rows, key=lambda row: row["dominance_score"], reverse=True)


def top_numeric_fields(vector: dict[str, float], limit: int = 10) -> list[dict[str, float]]:
    return [
        {"field": field, "value": value}
        for field, value in sorted(vector.items(), key=lambda item: item[1], reverse=True)[:limit]
    ]


def main() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    questions = load_json("questions12.json")
    q2psych = load_json("questions12_to_psych144.json")
    weights = load_json("psych144_to_53_weights.fixed-new.json")
    cluster_profiles = load_json("cluster_profiles.json")
    top_places_data = load_json("20_top_places.json")

    qids = get_question_ids(questions, q2psych)
    used_tag_counts = collect_used_tags(q2psych)
    used_tags = set(used_tag_counts)
    weight_tags = set(weights)
    tags_used_and_weighted = sorted(used_tags & weight_tags)
    tags_missing_from_weights = sorted(used_tags - weight_tags)
    unused_weight_tags = sorted(weight_tags - used_tags)

    cluster_vectors, field_stats = summarize_cluster_fields(cluster_profiles)
    cluster_fields = set(field_stats)
    weight_fields = sorted({
        field
        for tag_weights in weights.values()
        if isinstance(tag_weights, dict)
        for field, value in tag_weights.items()
        if is_number(value)
    })
    weight_field_set = set(weight_fields)

    clusters_by_numeric_id = {}
    for cluster_id, vector in cluster_vectors.items():
        digits = "".join(ch for ch in cluster_id if ch.isdigit())
        if digits:
            clusters_by_numeric_id[int(digits)] = (cluster_id, vector)

    top_place_clusters = top_places_data.get("clusters", []) if isinstance(top_places_data, dict) else []
    place_counter: Counter[str] = Counter()
    place_display: dict[str, str] = {}
    cluster_place_rows = []
    for cluster in top_place_clusters:
        places = [p.get("place", "") for p in cluster.get("top_places", []) if isinstance(p, dict)]
        normalized_places = [normalize_place(place) for place in places]
        for place, normalized in zip(places, normalized_places):
            if normalized:
                place_counter[normalized] += 1
                place_display.setdefault(normalized, place)
        numeric_id = cluster.get("id")
        cluster_key, vector = clusters_by_numeric_id.get(numeric_id, (f"cluster_{numeric_id}", {}))
        cluster_place_rows.append({
            "cluster_id": cluster_key,
            "cluster_name": cluster.get("name", ""),
            "top_places": places,
            "top_10_highest_numeric_feature_fields": top_numeric_fields(vector),
        })

    most_repeated_top_places = [
        {"place": place_display[key], "normalized_place": key, "cluster_count": count}
        for key, count in place_counter.most_common()
        if count > 1
    ]

    simulation_specs = {
        "all option_1": {qid: "option_1" for qid in qids},
        "all option_2": {qid: "option_2" for qid in qids},
        "all option_3": {qid: "option_3" for qid in qids},
        "all option_4": {qid: "option_4" for qid in qids},
        "nature-oriented pattern": choose_keyword_pattern(qids, q2psych, ["nature", "tranquility", "outdoor", "flower"]),
        "relaxation-oriented pattern": choose_keyword_pattern(qids, q2psych, ["relaxation", "stress", "slow", "stay", "quality", "tranquility"]),
        "experience-oriented pattern": choose_keyword_pattern(qids, q2psych, ["experience", "novelty", "culture", "activity", "exploratory"]),
        "food-oriented pattern": choose_keyword_pattern(qids, q2psych, ["food", "local_culture", "consumption", "spending", "value"]),
    }

    common_similarity_fields = sorted(cluster_fields & weight_field_set)
    simulations = []
    for name, answers in simulation_specs.items():
        tag_counts = generated_tags_for_answers(q2psych, answers)
        vector = behavior_vector_for_tags(tag_counts, weights)
        non_zero_fields = [
            {"field": field, "value": value}
            for field, value in sorted(vector.items(), key=lambda item: abs(item[1]), reverse=True)
            if abs(value) > 1e-12
        ]
        closest = []
        for cluster_id, cluster_vector in cluster_vectors.items():
            closest.append({
                "cluster_id": cluster_id,
                "cosine_similarity": cosine_similarity(vector, cluster_vector, common_similarity_fields),
            })
        closest.sort(key=lambda row: row["cosine_similarity"], reverse=True)
        simulations.append({
            "pattern": name,
            "answers": answers,
            "generated_tags": dict(sorted(tag_counts.items())),
            "behavior_vector_non_zero_fields": non_zero_fields,
            "top_5_closest_clusters": closest[:5],
        })

    report = {
        "input_files": [
            "questions12.json",
            "questions12_to_psych144.json",
            "psych144_to_53_weights.fixed-new.json",
            "cluster_profiles.json",
            "20_top_places.json",
        ],
        "tag_audit": {
            "question_used_tag_count_total_occurrences": sum(used_tag_counts.values()),
            "question_used_tag_count_unique": len(used_tags),
            "used_tags_existing_in_weights_count": len(tags_used_and_weighted),
            "tags_used_by_questions_missing_from_weights": tags_missing_from_weights,
            "tags_in_weights_never_used_by_questions": unused_weight_tags,
        },
        "behavior_field_audit": {
            "cluster_profile_numeric_field_count": len(cluster_fields),
            "weight_numeric_field_count": len(weight_field_set),
            "fields_in_weights_not_in_cluster_profiles": sorted(weight_field_set - cluster_fields),
            "fields_in_cluster_profiles_never_generated_by_weights": sorted(cluster_fields - weight_field_set),
            "cluster_field_min_max_mean": field_stats,
            "large_scale_fields": detect_large_scale_fields(field_stats),
            "possible_cosine_dominating_fields": detect_cosine_dominance(field_stats),
        },
        "top_place_overlap": {
            "cluster_count": len(top_place_clusters),
            "unique_normalized_top_place_count": len(place_counter),
            "most_repeated_top_places": most_repeated_top_places,
        },
        "clusters": cluster_place_rows,
        "simulated_answer_patterns": simulations,
    }

    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    with REPORT_PATH.open("w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    print("Recommendation Logic Audit")
    print("=" * 30)
    print(f"Unique question tags: {len(used_tags)}")
    print(f"Tags covered by weights: {len(tags_used_and_weighted)}")
    print(f"Question tags missing from weights: {len(tags_missing_from_weights)}")
    print(f"Unused weighted tags: {len(unused_weight_tags)}")
    print(f"Cluster numeric fields: {len(cluster_fields)}")
    print(f"Weight numeric fields: {len(weight_field_set)}")
    print(f"Fields in weights but not clusters: {len(weight_field_set - cluster_fields)}")
    print(f"Fields in clusters but not weights: {len(cluster_fields - weight_field_set)}")
    print(f"Repeated top places: {len(most_repeated_top_places)}")
    print("\nMost repeated top places:")
    for row in most_repeated_top_places[:10]:
        print(f"  - {row['place']}: {row['cluster_count']} clusters")
    print("\nPossible cosine-dominating fields:")
    for row in report["behavior_field_audit"]["possible_cosine_dominating_fields"][:10]:
        print(f"  - {row['field']}: max={row['max']:.3f}, range={row['range']:.3f}, score={row['dominance_score']:.2f}")
    print("\nSimulation top clusters:")
    for sim in simulations:
        top = ", ".join(f"{r['cluster_id']} ({r['cosine_similarity']:.3f})" for r in sim["top_5_closest_clusters"][:3])
        print(f"  - {sim['pattern']}: {top}")
    print(f"\nWrote report: {REPORT_PATH}")


if __name__ == "__main__":
    main()
