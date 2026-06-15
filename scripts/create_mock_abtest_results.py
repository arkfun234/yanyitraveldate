"""Create local-only mock AB-test results for technical pre-validation.

These records represent assumed young adult profiles. They are not real survey
responses and must not be presented as participant data.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SPOT_MASTER_PATH = PROJECT_ROOT / "data" / "spot_master.json"
OUTPUT_DIR = PROJECT_ROOT / "abtest_results" / "mock_young_adult"

PROFILES: list[dict[str, Any]] = [
    {
        "slug": "01_university_friends_nature_history",
        "profile_type": "university_friends_nature_history_trip",
        "plan1": ["大本山永平寺", "越前大野城", "七間朝市"],
        "plan2": ["一乗谷朝倉氏遺跡", "龍双ヶ滝", "道の駅　恐竜渓谷かつやま"],
        "scores1": [5, 5, 4, 5, 5],
        "scores2": [4, 4, 4, 4, 4],
        "choice": "plan1",
        "comment": "友人同士で自然と歴史を話しながら巡りたい。大野の町歩きに時間を取りたい。",
        "cluster": "nature_history_social",
    },
    {
        "slug": "02_food_focused_couple",
        "profile_type": "food_focused_couple_trip",
        "plan1": ["日本海さかな街", "氣比神宮", "敦賀赤レンガ倉庫"],
        "plan2": ["越前そばの里", "あわら温泉屋台村「湯けむり横丁」", "東尋坊"],
        "scores1": [5, 5, 4, 4, 5],
        "scores2": [4, 5, 3, 4, 4],
        "choice": "plan1",
        "comment": "二人で海鮮と写真を楽しみたい。食事を急がず、敦賀周辺でまとまる案が良い。",
        "cluster": "local_food_couple",
    },
    {
        "slug": "03_relaxed_hot_spring",
        "profile_type": "relaxed_hot_spring_trip",
        "plan1": ["あわら温泉「芦湯」", "あわら温泉屋台村「湯けむり横丁」", "東尋坊"],
        "plan2": ["永平寺温泉 禅の里", "大本山永平寺", "永平寺参ろーど"],
        "scores1": [5, 4, 5, 5, 5],
        "scores2": [4, 3, 4, 4, 4],
        "choice": "plan1",
        "comment": "温泉街でのんびりしたい。移動を増やすより足湯と食事の時間を長くしたい。",
        "cluster": "relaxed_hot_spring",
    },
    {
        "slug": "04_efficient_multi_spot_photo",
        "profile_type": "efficient_multi_spot_photo_trip",
        "plan1": ["福井駅西口広場（恐竜広場）", "名勝　養浩館庭園", "一乗谷朝倉氏遺跡　復原町並"],
        "plan2": ["東尋坊", "丸岡城", "あわら温泉「芦湯」"],
        "scores1": [4, 5, 4, 4, 4],
        "scores2": [5, 5, 4, 5, 5],
        "choice": "plan2",
        "comment": "写真映えする場所を効率良く回りたい。移動順が自然なら少し忙しくてもよい。",
        "cluster": "efficient_photo_spots",
    },
    {
        "slug": "05_solo_quiet_healing",
        "profile_type": "solo_quiet_healing_trip",
        "plan1": ["大本山永平寺", "永平寺参ろーど", "永平寺温泉 禅の里"],
        "plan2": ["名勝　養浩館庭園", "一乗谷朝倉氏遺跡", "道の駅　一乗谷あさくら水の駅"],
        "scores1": [5, 4, 5, 5, 5],
        "scores2": [4, 4, 4, 4, 4],
        "choice": "plan1",
        "comment": "一人で静かに過ごしたい。観光地を詰め込まず、禅と温泉で気分転換したい。",
        "cluster": "solo_quiet_healing",
    },
    {
        "slug": "06_dinosaur_family_memory",
        "profile_type": "dinosaur_family_memory_activity_trip",
        "plan1": ["福井県立恐竜博物館", "かつやまディノパーク", "道の駅　恐竜渓谷かつやま"],
        "plan2": ["野外恐竜博物館", "越前大野城", "七間朝市"],
        "scores1": [5, 5, 5, 5, 5],
        "scores2": [4, 4, 4, 3, 4],
        "choice": "plan1",
        "comment": "子どもの頃に家族と見た恐竜展示を友人ともう一度楽しみたい。体験時間を優先したい。",
        "cluster": "dinosaur_activity_memory",
    },
    {
        "slug": "07_sea_coast_drive",
        "profile_type": "sea_coast_drive_trip",
        "plan1": ["東尋坊", "越前松島水族館", "あわら温泉「芦湯」"],
        "plan2": ["越前岬", "呼鳥門", "越前岬水仙ランド"],
        "scores1": [4, 4, 4, 4, 4],
        "scores2": [5, 5, 4, 5, 5],
        "choice": "plan2",
        "comment": "海沿いを車で走り、景色の良い場所でゆっくり写真を撮りたい。",
        "cluster": "coast_drive_scenery",
    },
    {
        "slug": "08_culture_history_exploration",
        "profile_type": "culture_history_exploration_trip",
        "plan1": ["一乗谷朝倉氏遺跡博物館", "一乗谷朝倉氏遺跡　復原町並", "一乗谷朝倉氏遺跡"],
        "plan2": ["丸岡城", "越前大野城", "大本山永平寺"],
        "scores1": [5, 5, 5, 5, 5],
        "scores2": [4, 5, 4, 4, 4],
        "choice": "plan1",
        "comment": "展示を見てから遺跡を歩きたい。歴史の流れが理解できる順番を重視する。",
        "cluster": "deep_culture_history",
    },
    {
        "slug": "09_local_shopping_market",
        "profile_type": "local_shopping_market_trip",
        "plan1": ["日本海さかな街", "敦賀赤レンガ倉庫", "氣比神宮"],
        "plan2": ["ふくい鮮いちば（福井市中央卸売市場）", "福井市にぎわい交流施設（ハピリン）", "福井駅西口広場（恐竜広場）"],
        "scores1": [5, 5, 4, 4, 5],
        "scores2": [4, 4, 4, 4, 4],
        "choice": "plan1",
        "comment": "地元の食べ物とお土産を比較して買いたい。市場での滞在時間を確保したい。",
        "cluster": "local_market_shopping",
    },
    {
        "slug": "10_hidden_spot_discovery",
        "profile_type": "hidden_spot_discovery_trip",
        "plan1": ["御誕生寺", "龍双ヶ滝", "越前大野城"],
        "plan2": ["北前船主の館  右近家", "河野北前船主通りガイドツアー", "道の駅河野"],
        "scores1": [5, 5, 4, 5, 5],
        "scores2": [4, 4, 5, 4, 4],
        "choice": "plan1",
        "comment": "定番だけでなく静かな発見がある場所へ行きたい。ただし遠い候補は別ルートでよい。",
        "cluster": "hidden_spot_discovery",
    },
    {
        "slug": "11_cafe_photo_friendly",
        "profile_type": "cafe_photo_friendly_trip",
        "plan1": ["ESHIKOTO", "大本山永平寺", "永平寺参ろーど"],
        "plan2": ["福井駅西口広場（恐竜広場）", "名勝　養浩館庭園", "福井市にぎわい交流施設（ハピリン）"],
        "scores1": [5, 5, 4, 5, 5],
        "scores2": [4, 5, 4, 4, 4],
        "choice": "plan1",
        "comment": "落ち着いた空間と写真を楽しみたい。カフェ的な休憩時間を削らないでほしい。",
        "cluster": "cafe_photo_relaxed",
    },
    {
        "slug": "12_low_budget_day",
        "profile_type": "low_budget_day_trip",
        "plan1": ["福井駅西口広場（恐竜広場）", "福井市にぎわい交流施設（ハピリン）", "名勝　養浩館庭園"],
        "plan2": ["西山公園", "道の駅西山公園", "めがねミュージアム"],
        "scores1": [4, 4, 5, 4, 4],
        "scores2": [5, 4, 4, 5, 5],
        "choice": "plan2",
        "comment": "交通費と入場料を抑えたい。無料や低価格で楽しめて移動が簡単な案が良い。",
        "cluster": "low_budget_day_trip",
    },
    {
        "slug": "13_first_time_fukui",
        "profile_type": "first_time_fukui_visitor_trip",
        "plan1": ["福井県立恐竜博物館", "大本山永平寺", "東尋坊"],
        "plan2": ["越前大野城", "一乗谷朝倉氏遺跡", "越前そばの里"],
        "scores1": [5, 5, 4, 5, 5],
        "scores2": [4, 4, 4, 4, 4],
        "choice": "plan1",
        "comment": "初めてなので代表的な場所を見たいが、一日で無理に全部回る必要はない。",
        "cluster": "first_time_highlights",
    },
    {
        "slug": "14_car_drive",
        "profile_type": "car_drive_trip",
        "plan1": ["越前大野城", "福井県立恐竜博物館", "道の駅　恐竜渓谷かつやま"],
        "plan2": ["レインボーライン山頂公園～三方五湖に浮かぶ天空のテラス～", "三方五湖", "道の駅 三方五湖"],
        "scores1": [5, 5, 4, 5, 5],
        "scores2": [5, 4, 4, 4, 4],
        "choice": "plan1",
        "comment": "車移動を楽しみたいが、奥越ルートと若狭ルートは同じ日に混ぜず、走りやすい方を選びたい。",
        "cluster": "car_route_scenery",
    },
    {
        "slug": "15_train_based_easy",
        "profile_type": "train_based_easy_trip",
        "plan1": ["福井駅西口広場（恐竜広場）", "福井市にぎわい交流施設（ハピリン）", "名勝　養浩館庭園"],
        "plan2": ["あわら温泉「芦湯」", "あわら温泉屋台村「湯けむり横丁」", "東尋坊"],
        "scores1": [5, 4, 5, 5, 5],
        "scores2": [4, 4, 3, 4, 4],
        "choice": "plan1",
        "comment": "車なしで迷いにくい旅が良い。駅周辺と徒歩移動を中心にして余裕を持ちたい。",
        "cluster": "public_transport_easy",
    },
]

SCORE_KEYS = (
    "answer_fit",
    "visit_interest",
    "reason_clarity",
    "personalized_feeling",
    "overall_satisfaction",
)


def load_spot_names() -> set[str]:
    data = json.loads(SPOT_MASTER_PATH.read_text(encoding="utf-8-sig"))
    return {spot["name"] for spot in data["spots"] if spot.get("name")}


def recommendation(name: str, profile_type: str, method: str) -> dict[str, str]:
    return {
        "name": name,
        "reason": f"{profile_type} の想定嗜好を技術検証するための {method} 推薦候補。",
        "source_place": name,
    }


def scores(values: list[int]) -> dict[str, int]:
    return dict(zip(SCORE_KEYS, values, strict=True))


def build_result(profile: dict[str, Any], index: int) -> dict[str, Any]:
    return {
        "timestamp": f"2026-06-15T09:{index:02d}:00+09:00",
        "data_classification": "mock_pre_validation_not_real_participant_data",
        "respondent_profile": {
            "age_range": "20-25",
            "profile_type": profile["profile_type"],
            "note": "mock_pre_validation",
        },
        "plan1_method": "A_handcrafted_matrix",
        "plan2_method": "B_auto_clustering_baseline",
        "recommendation_plan_1_spots": [
            recommendation(name, profile["profile_type"], "plan1")
            for name in profile["plan1"]
        ],
        "recommendation_plan_2_spots": [
            recommendation(name, profile["profile_type"], "plan2")
            for name in profile["plan2"]
        ],
        "plan1_scores": scores(profile["scores1"]),
        "plan2_scores": scores(profile["scores2"]),
        "comparison_choice": profile["choice"],
        "free_comment": profile["comment"],
        "baseline_debug": {
            "mode": "mock_pre_validation",
            "assumed_cluster_label": profile["cluster"],
            "purpose": "technical validation before participant testing",
            "is_real_participant_data": False,
        },
    }


def main() -> int:
    spot_names = load_spot_names()
    referenced_names = {
        name
        for profile in PROFILES
        for plan_key in ("plan1", "plan2")
        for name in profile[plan_key]
    }
    unknown_names = sorted(referenced_names - spot_names)
    if unknown_names:
        raise ValueError("Unknown spot names in mock profiles: " + ", ".join(unknown_names))

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for index, profile in enumerate(PROFILES, start=1):
        output_path = OUTPUT_DIR / f"mock_pre_validation_{profile['slug']}.json"
        output_path.write_text(
            json.dumps(build_result(profile, index), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(output_path)
    print(f"Generated {len(PROFILES)} mock pre-validation AB-test files.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
