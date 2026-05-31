#!/usr/bin/env python3
"""Simulate A-plan cluster assignment distribution for random 12-question users."""

from __future__ import annotations

import csv
import json
import math
import random
import statistics
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
QUESTIONS_PATH = ROOT / "questions12.json"
Q2PSYCH_PATH = ROOT / "questions12_to_psych144.json"
WEIGHTS_PATH = ROOT / "psych144_to_53_weights.fixed-new.json"
CLUSTERS_PATH = ROOT / "cluster_profiles.json"
TRAIT_PROFILES_PATH = ROOT / "data" / "cluster_trait_profiles.json"
JSON_OUTPUT_PATH = ROOT / "data" / "audit_cluster_distribution.json"
CSV_OUTPUT_PATH = ROOT / "data" / "audit_cluster_distribution.csv"

SIMULATION_COUNT = 1000
RANDOM_SEED = 20260531
BEHAVIOR_WEIGHT = 0.55
TRAIT_WEIGHT = 0.45
TOP3_DOMINANCE_WARNING_THRESHOLD = 0.60

TRAVEL_TRAIT_KEYS = [
    "planning",
    "relaxation",
    "exploration_experience",
    "food_value",
    "nature",
    "efficiency_touring",
]

TAG_TRAIT_KEYWORDS = {
    "planning": [
        "planning",
        "plan_",
        "preparedness",
        "structure",
        "control",
        "official_info",
        "information",
        "validation",
        "logical",
        "risk_minimization",
        "risk_awareness",
    ],
    "relaxation": [
        "relaxation",
        "stress",
        "slow",
        "stay_based",
        "tranquility",
        "privacy",
        "quality_priority",
        "presence_focus",
        "subjective_satisfaction",
        "low_control",
    ],
    "exploration_experience": [
        "experience",
        "explor",
        "novelty",
        "local_culture",
        "activity",
        "spontaneity",
        "uncertainty",
        "intuition",
        "emotion",
        "opportunistic",
        "situational",
    ],
    "food_value": [
        "consumption",
        "cost",
        "value",
        "budget",
        "price",
        "spending",
        "willingness_to_pay",
        "cost_benefit",
    ],
    "nature": [
        "nature",
        "outdoor",
        "tranquility_seeking",
        "mixed_environment",
    ],
    "efficiency_touring": [
        "schedule_density_high",
        "multi_spot",
        "pace_fast",
        "efficiency",
        "time_optimization",
        "coverage",
        "hopping",
    ],
}


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def option_sort_key(option_key: str) -> tuple[int, str]:
    digits = "".join(ch for ch in option_key if ch.isdigit())
    return (int(digits) if digits else 9999, option_key)


def get_question_option_keys(question: dict[str, Any], mapping: dict[str, Any]) -> list[str]:
    qid = str(question.get("id") or "")
    mapped_options = mapping.get(qid, {})
    if isinstance(mapped_options, dict) and mapped_options:
        return sorted(mapped_options, key=option_sort_key)

    options = question.get("options") or question.get("options_zh") or question.get("options_jp") or []
    return [f"option_{index}" for index in range(1, len(options) + 1)]


def is_post_trip_evaluation_field(field: str) -> bool:
    name = str(field or "")
    keywords = [
        "NPS",
        "満足度",
        "満足度の理由",
        "満足度(商品・サービス)の理由",
        "今後の来訪意向",
        "不便さ",
        "不便さの内容",
        "エリア訪問回数",
    ]
    return any(keyword in name for keyword in keywords)


def numeric_cluster_vectors(cluster_profiles: dict[str, Any]) -> dict[str, dict[str, float]]:
    return {
        cluster_id: {
            field: float(value)
            for field, value in profile.items()
            if is_number(value)
        }
        for cluster_id, profile in cluster_profiles.items()
        if isinstance(profile, dict)
    }


def generated_behavior_fields(weights: dict[str, Any]) -> set[str]:
    fields: set[str] = set()
    for weight_def in weights.values():
        if not isinstance(weight_def, dict):
            continue
        for field, value in weight_def.items():
            if is_number(value):
                fields.add(field)
    return fields


def classification_feature_keys(
    cluster_vectors: dict[str, dict[str, float]],
    weights: dict[str, Any],
) -> list[str]:
    cluster_fields = {field for vector in cluster_vectors.values() for field in vector}
    return sorted(
        field
        for field in generated_behavior_fields(weights)
        if field in cluster_fields and not is_post_trip_evaluation_field(field)
    )


def calc_tag_counts(answers: dict[str, str], q2psych: dict[str, Any]) -> Counter[str]:
    counts: Counter[str] = Counter()
    for qid, option_key in answers.items():
        mapping = q2psych.get(qid, {})
        if not isinstance(mapping, dict):
            continue
        for tag in mapping.get(option_key, []) or []:
            counts[str(tag)] += 1
    return counts


def calc_behavior_vector(
    tag_counts: Counter[str],
    weights: dict[str, Any],
    feature_keys: list[str],
) -> dict[str, float]:
    vector = {field: 0.0 for field in feature_keys}
    valid_fields = set(feature_keys)
    for tag, count in tag_counts.items():
        weight_def = weights.get(tag)
        if not isinstance(weight_def, dict):
            continue
        for field, value in weight_def.items():
            if field in valid_fields and is_number(value):
                vector[field] += count * float(value)
    return vector


def compute_user_trait_scores(tag_counts: Counter[str]) -> dict[str, float]:
    raw_scores = {trait: 0.0 for trait in TRAVEL_TRAIT_KEYS}
    for tag, count in tag_counts.items():
        normalized_tag = str(tag or "").lower()
        for trait in TRAVEL_TRAIT_KEYS:
            hit_count = sum(
                1
                for keyword in TAG_TRAIT_KEYWORDS.get(trait, [])
                if keyword in normalized_tag
            )
            if hit_count > 0:
                raw_scores[trait] += count * hit_count

    max_score = max(raw_scores.values(), default=0.0)
    if max_score <= 0:
        return {trait: 0.0 for trait in TRAVEL_TRAIT_KEYS}
    return {trait: raw_scores[trait] / max_score for trait in TRAVEL_TRAIT_KEYS}


def cosine_similarity(a: list[float], b: list[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a)
    nb = sum(y * y for y in b)
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


def trait_profile_map(trait_profiles: dict[str, Any]) -> dict[str, dict[str, float]]:
    profiles = trait_profiles.get("clusters", []) if isinstance(trait_profiles, dict) else []
    result: dict[str, dict[str, float]] = {}
    for profile in profiles:
        if not isinstance(profile, dict):
            continue
        cluster_id = profile.get("cluster_id")
        scores = profile.get("trait_scores")
        if cluster_id and isinstance(scores, dict):
            result[str(cluster_id)] = {
                trait: float(scores.get(trait, 0.0)) if is_number(scores.get(trait, 0.0)) else 0.0
                for trait in TRAVEL_TRAIT_KEYS
            }
    return result


def find_best_cluster(
    behavior_vector: dict[str, float],
    user_trait_scores: dict[str, float],
    cluster_vectors: dict[str, dict[str, float]],
    cluster_trait_scores: dict[str, dict[str, float]],
    feature_keys: list[str],
) -> tuple[str, float, float, float]:
    user_behavior_values = [behavior_vector.get(field, 0.0) for field in feature_keys]
    user_trait_values = [user_trait_scores.get(trait, 0.0) for trait in TRAVEL_TRAIT_KEYS]
    has_trait_profiles = bool(cluster_trait_scores)

    best_cluster_id = ""
    best_final_score = -math.inf
    best_behavior_similarity = 0.0
    best_trait_similarity = 0.0

    for cluster_id, cluster_vector in cluster_vectors.items():
        cluster_behavior_values = [cluster_vector.get(field, 0.0) for field in feature_keys]
        behavior_similarity = cosine_similarity(user_behavior_values, cluster_behavior_values)
        cluster_traits = cluster_trait_scores.get(cluster_id)
        if cluster_traits:
            cluster_trait_values = [cluster_traits.get(trait, 0.0) for trait in TRAVEL_TRAIT_KEYS]
            trait_similarity = cosine_similarity(user_trait_values, cluster_trait_values)
        else:
            trait_similarity = behavior_similarity

        final_score = (
            behavior_similarity * BEHAVIOR_WEIGHT + trait_similarity * TRAIT_WEIGHT
            if has_trait_profiles
            else behavior_similarity
        )
        if final_score > best_final_score:
            best_cluster_id = cluster_id
            best_final_score = final_score
            best_behavior_similarity = behavior_similarity
            best_trait_similarity = trait_similarity

    return best_cluster_id, best_final_score, best_behavior_similarity, best_trait_similarity


def entropy(counts: Counter[str], total: int) -> float:
    if total <= 0:
        return 0.0
    return -sum((count / total) * math.log2(count / total) for count in counts.values() if count > 0)


def cluster_sort_key(cluster_id: str) -> tuple[int, str]:
    digits = "".join(ch for ch in cluster_id if ch.isdigit())
    return (int(digits) if digits else 9999, cluster_id)


def top_traits(scores: dict[str, float]) -> list[str]:
    return sorted(TRAVEL_TRAIT_KEYS, key=lambda trait: (-scores.get(trait, 0.0), TRAVEL_TRAIT_KEYS.index(trait)))[:3]


def main() -> None:
    questions = load_json(QUESTIONS_PATH)
    q2psych = load_json(Q2PSYCH_PATH)
    weights = load_json(WEIGHTS_PATH)
    cluster_profiles = load_json(CLUSTERS_PATH)
    trait_profiles = load_json(TRAIT_PROFILES_PATH)

    cluster_vectors = numeric_cluster_vectors(cluster_profiles)
    feature_keys = classification_feature_keys(cluster_vectors, weights)
    cluster_trait_scores = trait_profile_map(trait_profiles)
    rng = random.Random(RANDOM_SEED)

    question_options = {
        str(question.get("id")): get_question_option_keys(question, q2psych)
        for question in questions
        if isinstance(question, dict) and question.get("id")
    }
    qids = sorted(question_options, key=option_sort_key)

    cluster_counts: Counter[str] = Counter()
    score_rows: dict[str, list[float]] = {cluster_id: [] for cluster_id in cluster_vectors}
    behavior_rows: dict[str, list[float]] = {cluster_id: [] for cluster_id in cluster_vectors}
    trait_rows: dict[str, list[float]] = {cluster_id: [] for cluster_id in cluster_vectors}
    simulations: list[dict[str, Any]] = []

    for simulation_id in range(1, SIMULATION_COUNT + 1):
        answers = {
            qid: rng.choice(question_options[qid])
            for qid in qids
            if question_options.get(qid)
        }
        tag_counts = calc_tag_counts(answers, q2psych)
        behavior_vector = calc_behavior_vector(tag_counts, weights, feature_keys)
        user_trait_scores = compute_user_trait_scores(tag_counts)
        best_cluster_id, final_score, behavior_similarity, trait_similarity = find_best_cluster(
            behavior_vector,
            user_trait_scores,
            cluster_vectors,
            cluster_trait_scores,
            feature_keys,
        )

        cluster_counts[best_cluster_id] += 1
        score_rows[best_cluster_id].append(final_score)
        behavior_rows[best_cluster_id].append(behavior_similarity)
        trait_rows[best_cluster_id].append(trait_similarity)
        simulations.append(
            {
                "simulation_id": simulation_id,
                "answers": answers,
                "generated_psych_tags": dict(sorted(tag_counts.items())),
                "behavior_vector_nonzero": {
                    field: round(value, 6)
                    for field, value in behavior_vector.items()
                    if value != 0
                },
                "trait_scores": {
                    trait: round(user_trait_scores.get(trait, 0.0), 6)
                    for trait in TRAVEL_TRAIT_KEYS
                },
                "best_cluster_id": best_cluster_id,
                "final_score": round(final_score, 6),
                "behavior_similarity": round(behavior_similarity, 6),
                "trait_similarity": round(trait_similarity, 6),
            }
        )

    all_cluster_ids = sorted(cluster_vectors, key=cluster_sort_key)
    selected_cluster_ids = [cluster_id for cluster_id in all_cluster_ids if cluster_counts[cluster_id] > 0]
    never_selected = [cluster_id for cluster_id in all_cluster_ids if cluster_counts[cluster_id] == 0]
    top_clusters = cluster_counts.most_common()
    top3_count = sum(count for _, count in top_clusters[:3])
    top3_share = top3_count / SIMULATION_COUNT if SIMULATION_COUNT else 0.0
    concentration_warning = top3_share >= TOP3_DOMINANCE_WARNING_THRESHOLD
    distribution_entropy = entropy(cluster_counts, SIMULATION_COUNT)
    max_entropy = math.log2(len(all_cluster_ids)) if all_cluster_ids else 0.0

    distribution_rows = []
    for cluster_id in all_cluster_ids:
        count = cluster_counts[cluster_id]
        scores = score_rows[cluster_id]
        distribution_rows.append(
            {
                "cluster_id": cluster_id,
                "selected_count": count,
                "selected_share": round(count / SIMULATION_COUNT, 6),
                "avg_final_score": round(statistics.fmean(scores), 6) if scores else 0.0,
                "avg_behavior_similarity": round(statistics.fmean(behavior_rows[cluster_id]), 6) if scores else 0.0,
                "avg_trait_similarity": round(statistics.fmean(trait_rows[cluster_id]), 6) if scores else 0.0,
                "cluster_trait_top3": " | ".join(top_traits(cluster_trait_scores.get(cluster_id, {}))),
            }
        )

    payload = {
        "summary": {
            "total_simulations": SIMULATION_COUNT,
            "random_seed": RANDOM_SEED,
            "classification_feature_count": len(feature_keys),
            "total_clusters": len(all_cluster_ids),
            "clusters_selected_at_least_once": len(selected_cluster_ids),
            "clusters_never_selected": never_selected,
            "top_10_most_selected_clusters": [
                {
                    "cluster_id": cluster_id,
                    "selected_count": count,
                    "selected_share": round(count / SIMULATION_COUNT, 6),
                }
                for cluster_id, count in top_clusters[:10]
            ],
            "entropy": round(distribution_entropy, 6),
            "max_entropy": round(max_entropy, 6),
            "entropy_ratio": round(distribution_entropy / max_entropy, 6) if max_entropy else 0.0,
            "top3_selected_count": top3_count,
            "top3_selected_share": round(top3_share, 6),
            "concentration_warning": concentration_warning,
            "concentration_warning_threshold": TOP3_DOMINANCE_WARNING_THRESHOLD,
            "hybrid_formula": f"finalScore = behaviorSimilarity * {BEHAVIOR_WEIGHT} + traitSimilarity * {TRAIT_WEIGHT}",
        },
        "cluster_distribution": distribution_rows,
        "simulations": simulations,
    }

    with JSON_OUTPUT_PATH.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")

    with CSV_OUTPUT_PATH.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=list(distribution_rows[0].keys()))
        writer.writeheader()
        writer.writerows(distribution_rows)

    print(f"total simulations: {SIMULATION_COUNT}")
    print(f"number of clusters selected at least once: {len(selected_cluster_ids)}")
    print("top 10 most selected clusters:")
    for cluster_id, count in top_clusters[:10]:
        print(f"- {cluster_id}: {count} ({count / SIMULATION_COUNT:.1%})")
    print(f"clusters never selected: {', '.join(never_selected) if never_selected else 'none'}")
    print(f"entropy: {distribution_entropy:.4f} / max {max_entropy:.4f}")
    print(f"top 3 selected share: {top3_share:.1%}")
    if concentration_warning:
        print("concentration warning: top 3 clusters dominate the simulated assignments")
    else:
        print("concentration warning: none")
    print(f"JSON output path: {JSON_OUTPUT_PATH}")
    print(f"CSV output path: {CSV_OUTPUT_PATH}")


if __name__ == "__main__":
    main()
