# 自由記述に基づく自動旅行ニーズクラスタリングについて

## 概要

本システムでは、B案を旧来の `teacher_auto_cluster` から、原始アンケートの自由記述に基づく「自動旅行ニーズクラスタ」へ変更した。

従来のB案は、教師側で整理されたクラスタ要約を利用する補助的な分類であった。一方、現在のB案は、実際の観光客がアンケート内で記述した自由記述テキストを対象に、テキスト特徴量化と自動クラスタリングを行うことで生成している。これにより、B案は満足度や任意の手作業分類ではなく、観光客の生の記述から抽出された旅行ニーズを表すものになっている。

## データ來源

使用したデータは、以下の13か月分の原始アンケートCSVである。

- `data/monthly_surveys/202504.csv`
- `data/monthly_surveys/202505.csv`
- `data/monthly_surveys/202506.csv`
- `data/monthly_surveys/202507.csv`
- `data/monthly_surveys/202508.csv`
- `data/monthly_surveys/202509.csv`
- `data/monthly_surveys/202510.csv`
- `data/monthly_surveys/202511.csv`
- `data/monthly_surveys/202512.csv`
- `data/monthly_surveys/202601.csv`
- `data/monthly_surveys/202602.csv`
- `data/monthly_surveys/202603.csv`
- `data/monthly_surveys/202604.csv`

対象データは合計 23,548 行であり、無効な自由記述を除外した後の有効自由記述は 9,977 件である。

## 処理手順

処理は `scripts/build_auto_need_clusters.py` により、オフラインで実行する。

1. `data/monthly_surveys/` 配下の原始CSVを読み込む。
2. 文字コードは `utf-8-sig` を優先し、失敗した場合は `cp932` を試行する。
3. 各月のCSVを結合し、元ファイルに基づいて `source_month` を付与する。
4. 自由記述列を自動抽出する。対象には、交通手段の満足度理由、商品・サービス満足度理由、不便さの内容、推奨項目、施設や福井県に求めるもの、その他、訪問場所FAなどを含める。
5. 同一回答行の複数の自由記述列を結合し、`text_for_clustering` を作成する。
6. 「なし」「特になし」「選択なし」「該当なし」などの無効回答や、極端に短い記述を除外する。
7. 満足度やNPSはクラスタリングの主特徴量としては使用せず、クラスタ解釈のための統計情報としてのみ扱う。
8. TF-IDF により自由記述テキストを特徴量化する。
9. KMeans により自動クラスタリングを行う。
10. 各クラスタについて、上位キーワード、代表コメント、目的タグ、トレイトスコア、訪問エリア、同行者、訪問目的、月別分布などを集計し、解釈可能なクラスタ情報として出力する。

## 出力ファイル

生成される主な出力は以下の2つである。

- `data/auto_need_clusters.json`
- `data/auto_need_clusters_summary.csv`

`auto_need_clusters.json` はフロントエンドで利用する詳細データであり、各クラスタの `id`、`name`、`summary`、`size`、`top_keywords`、`representative_comments`、`purpose_tags`、`trait_scores`、`cluster_theme_tags` などを含む。

`auto_need_clusters_summary.csv` は研究確認や説明用の一覧表であり、クラスタ名、件数、上位キーワード、テーマタグ、代表的な属性分布などを確認するために使用する。

## フロントエンドでの利用

フロントエンドでは、`main.js` が `data/auto_need_clusters.json` を読み込む。

読み込まれたB案クラスタは、A案で得られる12問アンケート由来の旅行者画像と照合される。具体的には、A案側の `trait_scores`、タグ傾向、回答内容、同行者、季節などを用いて、B案クラスタの以下の情報と類似度を計算する。

- `top_keywords`
- `purpose_tags`
- `trait_scores`
- `cluster_theme_tags`
- `summary`

統合推薦では、B案クラスタとの一致を以下のようなスコアとして反映する。

- `b_trait_similarity_score`
- `b_keyword_match_score`
- `b_purpose_tag_score`
- `b_theme_tag_score`

これにより、A案の旅行者分類だけでなく、実際の観光客自由記述から得られた旅行ニーズも推薦スコアに反映される。

## フォールバック処理

`data/auto_need_clusters.json` が読み込めない場合、または有効なクラスタ配列を取得できない場合のみ、旧B案である legacy teacher cluster を使用する。

legacy ファイルである `data/auto_clustering_baseline/auto_cluster_profiles_from_teacher.json` は削除せず、フォールバック用に保持する。ただし、通常時のB案は `auto_need_clusters.json` を優先する。

## 保存JSONでの確認字段

保存されるJSONでは、新しいB案が使用されていることを以下のフィールドで確認できる。

```json
{
  "matched_b_cluster": {
    "source": "auto_need_clusters"
  },
  "integration_debug": {
    "b_cluster_source": "auto_need_clusters"
  }
}
```

また、各推薦スポットの `score_debug` にも以下が含まれる。

```json
{
  "score_debug": {
    "matched_b_source": "auto_need_clusters"
  }
}
```

この3点が `auto_need_clusters` になっていれば、旧 `teacher_auto_cluster` ではなく、新しい自由記述ベースのB案が統合推薦に使用されていることを確認できる。

## 研究上の意義

本システムのA案は、12問アンケートに基づく手作業設計の旅行者分類である。これは旅行者の性格や行動傾向を説明しやすい一方で、実際の観光客が現地で感じた具体的なニーズや不便さを直接反映しにくい。

新しいB案は、13か月分の原始アンケート自由記述から自動生成した旅行ニーズクラスタである。そのため、温泉、地元食、恐竜博物館、公共交通、駐車場、施設快適性など、実際の観光客の記述に現れる具体的な関心や改善要望を補助情報として利用できる。

これにより、A案の手作業設計による旅行者分類を、実際の観光客の自由記述データから得られた旅行ニーズで補完できる。したがって本システムは、単なるA/B比較ではなく、A案とB案を統合した推薦システムとして説明できる。
