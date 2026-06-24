#!/usr/bin/env python3
"""Compare A-plan hand-designed clusters against B-plan automatic clusters.

This comparison is retained for the preliminary A/B Test stage.
The current research direction uses B as a free-text clustering baseline
to support explanation, reproducibility, and diversity in A+B integration.
"""

from __future__ import annotations

import csv
import json
import math
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
A_INPUT_PATH = ROOT / "data" / "cluster_trait_profiles.json"
B_INPUT_PATH = ROOT / "data" / "auto_clustering_baseline" / "auto_cluster_profiles_from_teacher.json"
OUTPUT_DIR = ROOT / "data" / "ab_comparison"
JSON_OUTPUT_PATH = OUTPUT_DIR / "ab_cluster_comparison.json"
CSV_OUTPUT_PATH = OUTPUT_DIR / "ab_cluster_comparison.csv"

TRAITS = [
    "planning",
    "relaxation",
    "exploration_experience",
    "food_value",
    "nature",
    "efficiency_touring",
]

WEAK_MATCH_THRESHOLD = 0.6


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def as_float(value: Any) -> float:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return 0.0


def trait_vector(cluster: dict[str, Any]) -> list[float]:
    scores = cluster.get("trait_scores", {})
    if not isinstance(scores, dict):
        return [0.0 for _ in TRAITS]
    return [as_float(scores.get(trait)) for trait in TRAITS]


def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    a_norm = math.sqrt(sum(x * x for x in a))
    b_norm = math.sqrt(sum(y * y for y in b))
    if a_norm == 0.0 or b_norm == 0.0:
        return 0.0
    return dot / (a_norm * b_norm)


def top_traits(cluster: dict[str, Any]) -> list[str]:
    explicit = cluster.get("top_traits")
    if isinstance(explicit, list) and explicit:
        return [str(trait) for trait in explicit[:3]]

    scores = cluster.get("trait_scores", {})
    if not isinstance(scores, dict):
        return []
    return sorted(TRAITS, key=lambda trait: (-as_float(scores.get(trait)), TRAITS.index(trait)))[:3]


def top_places(cluster: dict[str, Any]) -> list[str]:
    places = cluster.get("top_places", [])
    if not isinstance(places, list):
        return []

    names: list[str] = []
    for place in places[:3]:
        if isinstance(place, dict):
            name = place.get("place") or place.get("name") or place.get("spot_name")
            if name:
                names.append(str(name))
        elif place:
            names.append(str(place))
    return names


def get_a_clusters(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, dict) and isinstance(data.get("clusters"), list):
        return data["clusters"]
    if isinstance(data, list):
        return data
    raise ValueError("A input must be a list or a dict with a 'clusters' list.")


def get_b_clusters(data: Any) -> list[dict[str, Any]]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict) and isinstance(data.get("clusters"), list):
        return data["clusters"]
    raise ValueError("B input must be a list or a dict with a 'clusters' list.")


def b_cluster_id(cluster: dict[str, Any]) -> str:
    return str(cluster.get("auto_cluster_id") or cluster.get("cluster_id") or cluster.get("source_cluster_id"))


def compare_clusters(a_clusters: list[dict[str, Any]], b_clusters: list[dict[str, Any]]) -> list[dict[str, Any]]:
    comparisons: list[dict[str, Any]] = []
    b_vectors = [(cluster, trait_vector(cluster)) for cluster in b_clusters]

    for a_cluster in a_clusters:
        a_vector = trait_vector(a_cluster)
        scored_matches = []
        for b_cluster, b_vector in b_vectors:
            scored_matches.append(
                {
                    "b_cluster_id": b_cluster_id(b_cluster),
                    "b_sample_count": int(as_float(b_cluster.get("sample_count"))),
                    "b_top_traits": top_traits(b_cluster),
                    "b_summary": str(b_cluster.get("summary") or ""),
                    "similarity_score": round(cosine_similarity(a_vector, b_vector), 4),
                }
            )

        matched_b_clusters = sorted(
            scored_matches,
            key=lambda match: (-match["similarity_score"], match["b_cluster_id"]),
        )[:3]

        comparisons.append(
            {
                "a_cluster_id": str(a_cluster.get("cluster_id") or a_cluster.get("auto_cluster_id")),
                "a_cluster_name": str(a_cluster.get("cluster_name") or a_cluster.get("name") or ""),
                "a_top_traits": top_traits(a_cluster),
                "a_top_places": top_places(a_cluster),
                "matched_b_clusters": matched_b_clusters,
            }
        )

    return comparisons


def build_summary(comparisons: list[dict[str, Any]], total_b_clusters: int) -> dict[str, Any]:
    best_scores = [
        comparison["matched_b_clusters"][0]["similarity_score"]
        for comparison in comparisons
        if comparison["matched_b_clusters"]
    ]
    best_match_counts = Counter(
        comparison["matched_b_clusters"][0]["b_cluster_id"]
        for comparison in comparisons
        if comparison["matched_b_clusters"]
    )

    return {
        "total_a_clusters": len(comparisons),
        "total_b_clusters": total_b_clusters,
        "average_best_match_similarity": round(sum(best_scores) / len(best_scores), 4) if best_scores else 0.0,
        "weak_match_threshold": WEAK_MATCH_THRESHOLD,
        "a_clusters_with_weak_b_matches": [
            {
                "a_cluster_id": comparison["a_cluster_id"],
                "a_cluster_name": comparison["a_cluster_name"],
                "best_b_cluster_id": comparison["matched_b_clusters"][0]["b_cluster_id"],
                "best_similarity_score": comparison["matched_b_clusters"][0]["similarity_score"],
            }
            for comparison in comparisons
            if comparison["matched_b_clusters"]
            and comparison["matched_b_clusters"][0]["similarity_score"] < WEAK_MATCH_THRESHOLD
        ],
        "b_clusters_matched_by_multiple_a_clusters": [
            {"b_cluster_id": cluster_id, "matched_a_cluster_count": count}
            for cluster_id, count in sorted(best_match_counts.items())
            if count > 1
        ],
    }


def write_json(summary: dict[str, Any], comparisons: list[dict[str, Any]]) -> None:
    payload = {
        "summary": summary,
        "comparisons": comparisons,
        "similarity_method": "cosine_similarity_over_trait_scores",
        "traits": TRAITS,
        "inputs": {
            "a_plan": str(A_INPUT_PATH.relative_to(ROOT)),
            "b_plan": str(B_INPUT_PATH.relative_to(ROOT)),
        },
    }
    with JSON_OUTPUT_PATH.open("w", encoding="utf-8", newline="\n") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.write("\n")


def write_csv(comparisons: list[dict[str, Any]]) -> None:
    fieldnames = [
        "a_cluster_id",
        "a_cluster_name",
        "a_top_traits",
        "a_top_places",
        "match_rank",
        "b_cluster_id",
        "b_sample_count",
        "b_top_traits",
        "b_summary",
        "similarity_score",
    ]
    with CSV_OUTPUT_PATH.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        for comparison in comparisons:
            for rank, match in enumerate(comparison["matched_b_clusters"], start=1):
                writer.writerow(
                    {
                        "a_cluster_id": comparison["a_cluster_id"],
                        "a_cluster_name": comparison["a_cluster_name"],
                        "a_top_traits": " | ".join(comparison["a_top_traits"]),
                        "a_top_places": " | ".join(comparison["a_top_places"]),
                        "match_rank": rank,
                        "b_cluster_id": match["b_cluster_id"],
                        "b_sample_count": match["b_sample_count"],
                        "b_top_traits": " | ".join(match["b_top_traits"]),
                        "b_summary": match["b_summary"],
                        "similarity_score": match["similarity_score"],
                    }
                )


def print_summary(summary: dict[str, Any], comparisons: list[dict[str, Any]]) -> None:
    print("A/B cluster comparison summary")
    print(f"total A clusters: {summary['total_a_clusters']}")
    print(f"total B clusters: {summary['total_b_clusters']}")
    print(f"average best-match similarity: {summary['average_best_match_similarity']}")
    print(f"weak B matches (< {summary['weak_match_threshold']}): {len(summary['a_clusters_with_weak_b_matches'])}")
    print(f"B clusters matched by multiple A clusters: {len(summary['b_clusters_matched_by_multiple_a_clusters'])}")
    print()
    print("Top B matches by A cluster:")
    for comparison in comparisons:
        best = comparison["matched_b_clusters"][0]
        top3 = ", ".join(
            f"{match['b_cluster_id']}={match['similarity_score']}"
            for match in comparison["matched_b_clusters"]
        )
        print(
            f"- {comparison['a_cluster_id']} ({comparison['a_cluster_name']}): "
            f"best {best['b_cluster_id']} score {best['similarity_score']} | top3 {top3}"
        )
    print()
    print(f"JSON output path: {JSON_OUTPUT_PATH}")
    print(f"CSV output path: {CSV_OUTPUT_PATH}")


def main() -> None:
    a_clusters = get_a_clusters(load_json(A_INPUT_PATH))
    b_clusters = get_b_clusters(load_json(B_INPUT_PATH))
    comparisons = compare_clusters(a_clusters, b_clusters)
    summary = build_summary(comparisons, len(b_clusters))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    write_json(summary, comparisons)
    write_csv(comparisons)
    print_summary(summary, comparisons)


if __name__ == "__main__":
    main()
