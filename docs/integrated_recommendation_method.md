# A+B統合観光スポット推薦アルゴリズム

## 1. 目的

本システムの観光スポット推薦は、固定されたTop3を提示する方式ではない。また、A案とB案を単純に比較してどちらか一方を採用するA/B比較でもない。

本システムでは、A案の12問アンケートに基づく旅行者画像、B案の自由記述自動クラスタによる旅行ニーズ、そして `spot_master` に登録された観光スポット特徴を統合し、回答者ごとに異なる観光スポット推薦を生成する。

これにより、旅行者の性格・行動傾向だけでなく、実際の観光客が自由記述で表明した関心、不便さ、改善要望、旅行目的を補助情報として反映できる。

## 2. 利用データ

統合推薦では、主に以下のデータを利用する。

- `12問アンケート回答`
- `questions12_to_psych144.json`
- `psych144_to_53_weights.fixed-new.json`
- `cluster_profiles` / `cluster_trait_profiles`
- `data/auto_need_clusters.json`
- `data/spot_master.json`
- `spot_weights_by_companion_season.json`

12問アンケート回答は、旅行者の心理・行動傾向を推定するために用いる。`questions12_to_psych144.json` は回答選択肢を心理タグへ変換するための対応表であり、`psych144_to_53_weights.fixed-new.json` は心理タグから行動特徴量を生成するための重みである。

`cluster_profiles` および `cluster_trait_profiles` は、A案の旅行者クラスタ分類に利用される。`data/auto_need_clusters.json` は、実際の観光客アンケートの自由記述から自動生成されたB案の旅行ニーズクラスタである。`data/spot_master.json` は、推薦候補となる観光スポットの特徴データである。`spot_weights_by_companion_season.json` は、同行者や季節に応じた既存のスポット重みとして利用される。

## 3. A案：12問アンケートによる旅行者画像

A案では、12問アンケートの回答から旅行者画像を生成する。

まず、各回答は `questions12_to_psych144.json` により心理タグへ変換され、タグごとの出現数として `tag_counts` が計算される。次に、`tag_counts` と `psych144_to_53_weights.fixed-new.json` の重みを用いて、旅行者の行動傾向を表す `behavior_vector` を生成する。

この `behavior_vector` とA案クラスタ側の特徴ベクトルとの余弦相似度を計算し、最も近いクラスタを `matched_a_cluster` として決定する。`cluster_trait_profiles` が利用できる場合は、行動ベクトルの相似度に加えて、旅行者traitの相似度も補助的に組み合わせる。

また、`tag_counts` から以下の6種類の `trait_scores` を生成する。

- `planning`
- `relaxation`
- `food_value`
- `nature`
- `exploration_experience`
- `efficiency_touring`

統合推薦では、A cluster の `name`、`description`、および `related_places` が推薦スコアに反映される。具体的には、A cluster に関連する地名や説明語とスポット情報が近い場合、`a_cluster_related_score` として加点される。

## 4. B案：自由記述自動クラスタによる旅行ニーズ

B案では、`data/auto_need_clusters.json` を読み込む。このファイルは、実際の観光客アンケートの自由記述をもとに自動生成された旅行ニーズクラスタである。

各B cluster には、主に以下の情報が含まれる。

- `top_keywords`
- `purpose_tags`
- `trait_scores`
- `cluster_theme_tags`
- `representative_comments`
- `summary`

統合推薦では、まずA案から得られた旅行者の `trait_scores` と、B cluster 側の `trait_scores` との余弦相似度を計算する。これに加えて、回答内容、タグ傾向、同行者、季節、B cluster のキーワードや目的タグとの一致を考慮し、最も近いB cluster を `matched_b_cluster` として選定する。

通常時は `data/auto_need_clusters.json` を優先して利用する。読み込みに失敗した場合、または有効なクラスタ配列を取得できない場合のみ、旧来の legacy teacher cluster に fallback する。

## 5. spot_master：観光スポット候補

`data/spot_master.json` は、統合推薦で実際に提示される観光スポット候補を保持するデータである。各スポットは、主に以下の情報を持つ。

- `name`
- `area`
- `description`
- `purpose_tags`
- `trait_tags`
- `spot_type`
- `quality_score`
- `main_recommendation_penalty`

統合推薦では、観光スポットとして主推薦に適している候補を優先する。そのため、観光案内所、駅、道の駅、ロゴオブジェ、交通手段、補助施設などは、主推薦から除外または降点される。具体的には、`spot_type` が `transport`、`facility`、`other` である候補や、低優先度フラグ、強い penalty を持つ候補は、主推薦に入りにくくなる。

一方で、`is_core_tourism_spot` が true のスポットや、`quality_score` が高いスポット、画像・URL・説明文などが充実しているスポットは加点される。

## 6. 統合推薦のスコアリング

統合推薦では、各 `spot_master` 候補に対して複数の観点からスコアを計算し、最終的な `final_score` を求める。

基本的な式は以下の通りである。

```text
final_score =
  a_cluster_related_score
+ condition_score
+ b_keyword_match_score
+ b_purpose_tag_score
+ b_trait_similarity_score
+ b_theme_tag_score
+ spot_quality_score
+ representative_bonus
+ diversity_score
- visited_penalty
- low_priority_penalty
```

各項目の意味は以下の通りである。

- `a_cluster_related_score`
  A案の旅行者クラスタとスポットの関連性を表す。A cluster の関連地名、説明語、上位訪問地とスポット名・エリア・説明が近い場合に加点される。

- `condition_score`
  同行者や季節に応じた適合度を表す。`spot_weights_by_companion_season.json` の既存重みや、季節・同行者に関連する語彙との一致により加点される。

- `b_keyword_match_score`
  B cluster の `top_keywords` とスポット情報の一致を表す。自由記述クラスタで頻出した関心語がスポット情報に含まれる場合に加点される。

- `b_purpose_tag_score`
  B cluster の `purpose_tags` とスポットの `purpose_tags` の一致を表す。旅行目的が近い場合に加点される。

- `b_trait_similarity_score`
  B cluster の高い `trait_scores` を、スポット側の `trait_tags`、`purpose_tags`、`description` などに対応付けて計算するスコアである。たとえば `food_value` が高いB cluster では、「美食・価値志向」「地元の美味しいものを食べる」「そば」「海鮮」などに該当するスポットが加点される。

- `b_theme_tag_score`
  B cluster の `cluster_theme_tags` とスポット情報の一致を表す。たとえば `public_transport_access`、`onsen_lodging_relaxation`、`nature_scenic_drive` などのテーマタグに対応する語がスポット情報に含まれる場合に加点される。

- `spot_quality_score`
  スポット自体の品質や主推薦への適性を表す。`quality_score`、`is_core_tourism_spot`、`spot_type`、画像、URL、説明文、penalty などから計算される。

- `representative_bonus`
  代表的な観光スポットとして提示しやすい候補に対する補助加点である。画像、詳細リンク、高い品質、主要観光スポットフラグなどがある場合に加点される。

- `diversity_score`
  推薦結果が同一エリアや同一タイプに偏りすぎないようにするための調整である。同じエリア・同じ `spot_type`・類似名称の候補が続く場合は抑制される。

- `visited_penalty`
  既訪問地を再推薦しないための減点である。ユーザーがすでに訪問した場所に該当する候補は推薦対象から外す、または減点する。

- `low_priority_penalty`
  主推薦に適さない候補に対する減点である。低優先度候補、案内所、交通手段、施設、ロゴオブジェ、強い penalty を持つ候補などが対象となる。

## 7. 余弦相似度・ベクトル相似度の使用箇所

本システムでは、余弦相似度を複数の段階で利用している。

A案では、12問アンケートから生成した `behavior_vector` と、A cluster 側の cluster vector との余弦相似度を用いて、`matched_a_cluster` を決定する。

B案では、A案から得られた user `trait_scores` と、B cluster 側の `trait_scores` との余弦相似度を用いて、自由記述ニーズとして最も近い `matched_b_cluster` を選定する。

一方、spot推薦段階では、B cluster の高い trait を、スポット側の `trait_tags`、`purpose_tags`、`description`、`spot_type` に対応付けて `b_trait_similarity_score` に反映する。これは、B cluster の英語trait keyと、spot_master 側の日語タグ体系を接続するための処理である。

したがって、本システムは単純なキーワード推薦ではない。A案・B案それぞれでクラスタマッチングを行い、その結果を `spot_master` の特徴量と組み合わせてスコアリングする、cluster matching + spot scoring の統合推薦である。

## 8. なぜこの観光地を推薦するのか

保存されるJSONには、各推薦スポットの説明可能性を高めるために、以下の情報が含まれる。

- `recommendation_reason`
- `a_relationship`
- `b_need_match`
- `matched_a_cluster`
- `matched_b_cluster`
- `score_debug`

`recommendation_reason` は、そのスポットを推薦した総合的な理由を示す。`a_relationship` は、A案の旅行者タイプとの関係を説明する。`b_need_match` は、B案の自由記述クラスタとスポット特徴の一致内容を説明する。

`matched_a_cluster` と `matched_b_cluster` により、どの旅行者画像・旅行ニーズに基づいて推薦されたかを確認できる。さらに `score_debug` には、`a_cluster_related_score`、`b_keyword_match_score`、`b_trait_similarity_score`、`b_theme_tag_score`、`spot_quality_score` などの内部スコアが保存されるため、推薦理由を後から検証できる。

## 9. 固定Top3ではなく個人化推薦である理由

本システムの推薦結果は、固定されたTop3ではない。理由は以下の通りである。

- 12問回答が異なると、`tag_counts` が変わる。
- `tag_counts` が変わると、`behavior_vector` が変わる。
- `behavior_vector` が変わると、A cluster が変わる。
- user `trait_scores` が変わると、選ばれるB cluster が変わる。
- 同行者、季節、既訪問地が変わると、条件スコアや除外対象が変わる。
- A案・B案・spot_master の一致度が変わるため、各spotの `final_score` と順位が変わる。

したがって、本システムはあらかじめ固定した3件の観光地を表示するのではなく、回答者ごとの旅行者画像と旅行ニーズに応じて、スポット候補の順位を再計算する個人化推薦である。

## 10. 現在の制限と今後の改善

現在の統合推薦には、いくつかの制限がある。

第一に、`spot_type` の標注が不正確な場合、交通手段や補助施設が主推薦に入りやすくなる可能性がある。たとえば、実質的には交通手段である候補が `transport` として分類されていない場合、除外や降点が十分に働かない可能性がある。

第二に、B cluster の `public_transport_access` が選ばれた場合、交通、移動、アクセス、バス、駐車場などの語が強く反映される。その結果、公共交通に関する関心が、主目的地としての観光スポット推薦に過度に影響する可能性がある。

今後は、交通手段、観光案内所、道の駅などを主推薦スポットとして扱うのではなく、旅行ルート上の補助情報として分離して提示することが望ましい。また、`spot_master` に対して明示的な6次元 trait vector を生成すれば、B cluster の `trait_scores` と spot 側 trait vector の相似度を直接計算でき、より説明しやすい推薦モデルに発展させることができる。

本手法により、A案の手作業設計による旅行者分類を、B案の実観光客自由記述から得られた旅行ニーズで補完し、説明可能な統合推薦として提示できる。
