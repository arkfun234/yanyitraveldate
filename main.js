// ===== 全局数据 =====
window.currentLang = window.currentLang || 'ja';

let QUESTIONS     = [];
let Q2PSYCH       = {};
let TAG_WEIGHTS   = {};
let CLUSTERS      = {};
let TOPPLACES     = null;
let SPOT_WEIGHTS  = {};   // 同行者×季节 → 景点权重
let SPOT_MASTER   = [];   // data/spot_master.json の具体スポット候補
let HOTELS        = [];   // 住宿数据
let DATA_SUMMARY  = null; // 2025年度AI推薦データの要約
let CLUSTER_TRAIT_PROFILES = null; // 6軸のクラスタートレイト分類補助データ
let AUTO_NEED_CLUSTERS = []; // B案: free-text travel-need clusters from raw monthly surveys
let AUTO_CLUSTER_PROFILES = []; // B方案 automatic clustering baseline profiles

let answers = {};
let behaviorVector = [];
let lastSummaryPayload = null;  // 用于重试
let lastTagCounts = {};          // 旅行者画像分析用
let lastLocalAIPlan = null;      // ABテスト結果と一緒に保存するローカルAI旅行プラン

function extractAutoNeedClusters(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.clusters)) return data.clusters;
  if (Array.isArray(data?.auto_need_clusters)) return data.auto_need_clusters;
  if (Array.isArray(data?.results)) return data.results;
  if (Array.isArray(data?.data)) return data.data;
  return [];
}

// ===== 1. 加载所有数据 =====
Promise.all([
  fetch("questions12.json").then(r => r.json()),
  fetch("questions12_to_psych144.json").then(r => r.json()),
  fetch("psych144_to_53_weights.fixed-new.json").then(r => r.json()),
  fetch("cluster_profiles.json").then(r => r.json()),
  fetch("20_top_places.json").then(r => r.json()),
  fetch("spot_weights_by_companion_season.json").then(r => r.json()),
  fetch("data/spot_master.json").then(r => r.json()),
  fetch("hotels.json").then(r => r.json()),
  fetch("data/cluster_trait_profiles.json").then(r => r.ok ? r.json() : null).catch(() => null),
  fetch("data_summary_2025.json").then(r => r.ok ? r.json() : null).catch(() => null),
  fetch("data/auto_need_clusters.json").then(r => r.ok ? r.json() : null).catch(() => null),
  fetch("data/auto_clustering_baseline/auto_cluster_profiles_from_teacher.json").then(r => r.ok ? r.json() : []).catch(() => []),
]).then(([qData, mapData, weightsData, clusters, topPlacesData, spotWeights, spotMaster, hotels, clusterTraitProfiles, dataSummary, autoNeedClusters, autoClusterProfiles]) => {
  QUESTIONS    = qData;
  Q2PSYCH      = mapData;
  TAG_WEIGHTS  = weightsData;
  CLUSTERS     = clusters;
  TOPPLACES    = topPlacesData;
  SPOT_WEIGHTS = spotWeights;
  SPOT_MASTER  = Array.isArray(spotMaster?.spots) ? spotMaster.spots : [];
  HOTELS       = hotels;
  CLUSTER_TRAIT_PROFILES = clusterTraitProfiles;
  DATA_SUMMARY = dataSummary;
  AUTO_NEED_CLUSTERS = extractAutoNeedClusters(autoNeedClusters);
  console.log("Loaded auto need clusters:", AUTO_NEED_CLUSTERS.length);
  AUTO_CLUSTER_PROFILES = Array.isArray(autoClusterProfiles) ? autoClusterProfiles : [];
  installResearchStyles();
  renderQuestions();
  setTimeout(updateProgress, 100);
}).catch(e => {
  console.error("加载失败:", e);
});

// ===== 2. 渲染问卷 =====
function renderQuestions() {
  const box = document.getElementById("questions");
  if (!box) return;
  box.innerHTML = "";

  QUESTIONS.forEach(q => {
    const div = document.createElement("div");
    div.className = "question";

    const titleText = window.currentLang === "zh" ? q.zh : (q.jp || q.zh);
    const opts = window.currentLang === "zh"
      ? (q.options_zh || q.options)
      : (q.options_jp || q.options);

    let html = `
      <div class="question-header">
        <div class="q-num">${q.id}</div>
        <h3>${titleText}</h3>
      </div>
      <div class="options-grid">`;

    opts.forEach((optText, idx) => {
      const value = idx + 1;
      const checked = answers[q.id] === String(value) ? 'checked' : '';
      const selected = answers[q.id] === String(value) ? 'selected' : '';
      html += `
        <label class="option-label ${selected}">
          <input type="radio" name="${q.id}" value="${value}" ${checked}>
          <div class="option-dot"></div>
          ${optText}
        </label>`;
    });

    html += `</div>`;
    div.innerHTML = html;
    box.appendChild(div);
  });

  attachOptionHighlight();
}

// ===== 3. 提交按钮 =====
document.addEventListener("DOMContentLoaded", () => {
  const submitBtn = document.getElementById("submitBtn");
  if (!submitBtn) return;

  submitBtn.addEventListener("click", () => {
    answers = {};
    QUESTIONS.forEach(q => {
      const checked = document.querySelector(`input[name="${q.id}"]:checked`);
      if (checked) answers[q.id] = checked.value;
    });

    if (Object.keys(answers).length !== QUESTIONS.length) {
      const msg = window.currentLang === "zh"
        ? `还有 ${QUESTIONS.length - Object.keys(answers).length} 题未回答，请全部作答后提交。`
        : `まだ ${QUESTIONS.length - Object.keys(answers).length} 問答えていません。すべて回答してから送信してください。`;
      alert(msg);
      return;
    }

    const tagCounts = calcTagCounts();
    lastTagCounts = tagCounts;
    behaviorVector = calcBehaviorVectorFromWeights(tagCounts);
    const bestCluster = findBestCluster(behaviorVector, tagCounts);

    let clusterIndex = null;
    let clusterInfo = null;

    if (bestCluster) {
      if (typeof bestCluster.id === "string") {
        const m = bestCluster.id.match(/(\d+)/);
        if (m) clusterIndex = Number(m[1]);
      } else if (typeof bestCluster.id === "number") {
        clusterIndex = bestCluster.id;
      }

      if (TOPPLACES && Array.isArray(TOPPLACES.clusters) && clusterIndex !== null) {
        clusterInfo = TOPPLACES.clusters.find(c => c.id === clusterIndex);
      }
    }

    const recommendedSpots = attachSelectedSpots(getRecommendedSpots(
      clusterInfo,
      window.userCompanion,
      window.userSeason,
      window.userVisitedPlaces
    ));

    const recommendedHotels = getRecommendedHotels(recommendedSpots);
    const userTraitScores = computeUserTraitScores(tagCounts);
    const psychologicalProfile = buildPsychologicalProfile(userTraitScores);
    const legacyBaselineDebug = buildAutoBaselineRecommendation(
      userTraitScores,
      window.userVisitedPlaces
    );
    const baselineDebug = buildBClusterMatch({
      userTraitScores,
      tagCounts,
      questionnaireAnswers: answers,
      companion: window.userCompanion,
      season: window.userSeason,
      visitedPlaces: window.userVisitedPlaces
    });
    const integratedBundle = buildIntegratedRecommendation({
      aClusterInfo: clusterInfo ? { ...clusterInfo, id: clusterIndex } : null,
      aRecommendations: recommendedSpots,
      baselineDebug,
      userTraitScores,
      companion: window.userCompanion,
      season: window.userSeason,
      visitedPlaces: window.userVisitedPlaces
    });
    const integratedRecommendations = integratedBundle.recommendations || [];

    lastSummaryPayload = {
      cluster: clusterInfo
        ? { id: clusterIndex, name: clusterInfo.name, description: clusterInfo.description }
        : bestCluster,
      companion: window.userCompanion,
      season: window.userSeason,
      visited_before: window.userVisited === 'yes',
      visited_places: window.userVisitedPlaces || null,
      recommended_spots: recommendedSpots,
      classification_debug: bestCluster?.classificationDebug || null,
      baseline_debug: legacyBaselineDebug,
      b_cluster_debug: baselineDebug,
      integrated_recommendations: integratedRecommendations,
      matched_a_cluster: integratedBundle.matched_a_cluster || null,
      matched_b_cluster: integratedBundle.matched_b_cluster || null,
      integration_debug: integratedBundle.integration_debug || null,
      psychological_profile: psychologicalProfile,
    };
    window.__AB_BASELINE_RECOMMENDATION__ = legacyBaselineDebug;
    window.__INTEGRATED_RECOMMENDATIONS__ = integratedRecommendations;
    window.__LAST_SUMMARY_PAYLOAD__ = lastSummaryPayload;

    showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels);
  });
});

// ===== 4. 展示结果页 =====
function showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels) {
  document.getElementById("quizSection").style.display = "none";
  document.getElementById("resultSection").style.display = "block";
  document.body.classList.add("result-mode");
  window.scrollTo({ top: 0, behavior: "smooth" });

  const name = clusterInfo
    ? (window.currentLang === "zh"
        ? `第 ${clusterIndex} 类：${clusterInfo.name}`
        : `第${clusterIndex}クラスター：${clusterInfo.name}`)
    : "—";

  document.getElementById("clusterName").textContent = name;
  document.getElementById("clusterDesc").textContent =
    clusterInfo ? clusterInfo.description.split("旅行中に訪れた")[0].trim() : "";

  renderProfileAnalysis(lastTagCounts, clusterInfo, clusterIndex);
  renderProcessVisualization();

  const spotsList = document.getElementById("spotsList");
  spotsList.innerHTML = "";
  const rankClass = ["r1", "r2", "r3"];

 recommendedSpots.slice(0, 3).forEach((spot, i) => {
  const categoryLabel = window.currentLang === 'zh' ? spot.categoryZh : spot.categoryJa;
  const selectedSpot = spot.selectedSpot;
  const spotName = selectedSpot?.name || spot.place;
  const spotImage = selectedSpot?.image
    ? `<img class="spot-image" src="${escapeHtml(selectedSpot.image)}" alt="${escapeHtml(spotName)}" loading="lazy">`
    : "";
  const spotLink = selectedSpot?.url
    ? `<a class="spot-link" href="${escapeHtml(selectedSpot.url)}" target="_blank" rel="noopener noreferrer">${langText('公式・詳細ページ', '官方/详情页面')}</a>`
    : "";
  const sourceLabel =
    spot.source === 'global' ? langText('全体傾向', '整体趋势') :
    spot.source === 'global_mid' ? langText('中位候補', '中位候选') :
    spot.source === 'cluster' ? langText('クラスター', 'Cluster') :
    langText('条件別傾向', '条件趋势');

  spotsList.innerHTML += `
    <div class="spot-item">
      ${spotImage}
      <div class="spot-rank ${rankClass[i]}">${i + 1}</div>
      <div class="spot-main">
        <div class="spot-category">${escapeHtml(categoryLabel)}</div>
        <div class="spot-name">${escapeHtml(spotName)}</div>
        <div class="spot-area">${langText('所属エリア', '所属区域')}：${escapeHtml(spot.place)}</div>
        <div class="spot-reason">${escapeHtml(getSpotReason(spot))}</div>
        ${spotLink}
      </div>
      <div class="spot-users">📊 ${sourceLabel}</div>
    </div>`;
});

  window.__AB_TEST_PLAN1_SPOTS__ = (recommendedSpots || []).slice(0, 3);
  window.__AB_TEST_PLAN2_SPOTS__ = getBaselineRecommendationSpots();
  renderIntegratedRecommendationSection(window.__INTEGRATED_RECOMMENDATIONS__ || []);

  const hotelGrid = document.getElementById("hotelGrid");
  hotelGrid.innerHTML = "";

  if (recommendedHotels.length === 0) {
    hotelGrid.innerHTML = `<div class="no-hotel">${
      window.currentLang === "zh" ? "周边暂无登录住宿信息" : "周辺に登録された宿泊施設がありません"
    }</div>`;
  } else {
    recommendedHotels.slice(0, 6).forEach(h => {
      hotelGrid.innerHTML += `
        <div class="hotel-card">
          <div class="hotel-type-badge">${h.type}</div>
          <div class="hotel-name">${h.name}</div>
          <div class="hotel-area">📍 ${h.area}</div>
          <div class="hotel-reason">${getHotelReason(h, recommendedSpots)}</div>
        </div>`;
    });
  }

  renderDataBasis();
  setupResultDashboardUI();
  const spotsSection = document.getElementById("spotsSection") || document.getElementById("spotsList")?.closest(".section-card");
  const hotelSection = document.getElementById("hotelSection");
  if (spotsSection) spotsSection.style.display = "none";
  if (hotelSection) hotelSection.style.display = "none";

  const aiResult = document.getElementById("aiResult");
  const aiSection = aiResult?.closest(".section-card");
  if (aiResult) aiResult.textContent = "";
  if (aiSection) aiSection.style.display = "none";
  const retryBtn = document.getElementById("retryBtn");
  if (retryBtn) retryBtn.classList.remove("show");
}

// ===== 5. 重试AI =====
function retryAI() {
  if (!lastSummaryPayload) return;
  const aiResult = document.getElementById("aiResult");
  aiResult.innerHTML = `<div class="ai-loading"><div class="spinner"></div><span>${
    window.currentLang === "zh" ? "AI 正在重新生成…" : "再生成しています…"
  }</span></div>`;

  const retryBtn = document.getElementById("retryBtn");
  if (retryBtn) retryBtn.classList.remove("show");

  callGeminiAI(lastSummaryPayload)
    .then(text => {
      aiResult.style.whiteSpace = "pre-wrap";
      aiResult.textContent = text;
    })
    .catch(err => {
      aiResult.innerHTML = `<span style="color:#ef4444">${err.message}</span>`;
      if (retryBtn) retryBtn.classList.add("show");
    });
}

// ===== 5.5 研究展示：旅行者画像・推薦理由・データ根拠 =====
function installResearchStyles() {
  if (document.getElementById('researchStyles')) return;

  const style = document.createElement('style');
  style.id = 'researchStyles';
  style.textContent = `
      /* ===== UI v2: Dashboard Layout + Tabs ===== */
    body.result-mode main {
      max-width: 1060px;
      padding-top: 32px;
    }

    body.result-mode #resultSection {
      animation: resultFadeIn 0.45s ease both;
    }

    .result-tabs {
      position: sticky;
      top: 58px;
      z-index: 90;
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      margin: 0 0 20px;
      padding: 10px;
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.82);
      backdrop-filter: blur(14px);
      border: 1px solid rgba(226, 232, 240, 0.9);
      box-shadow: 0 12px 34px rgba(15, 23, 42, 0.10);
    }

    .result-tab {
      border: none;
      cursor: pointer;
      border-radius: 14px;
      padding: 12px 10px;
      background: transparent;
      color: #64748b;
      font-size: 13px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      transition: all 0.22s ease;
      white-space: nowrap;
    }

    .result-tab:hover {
      background: #eff6ff;
      color: #2563eb;
      transform: translateY(-1px);
    }

    .result-tab.active {
      color: white;
      background: linear-gradient(135deg, #2563eb, #0ea5e9);
      box-shadow: 0 8px 22px rgba(37, 99, 235, 0.30);
    }

    .tab-icon {
      font-size: 15px;
    }

    .tab-hidden {
      display: none !important;
    }

    .tab-active-section {
      animation: tabContentIn 0.35s ease both;
    }

    @keyframes tabContentIn {
      from {
        opacity: 0;
        transform: translateY(12px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    body.result-mode .cluster-badge-card {
      min-height: 170px;
      display: flex;
      flex-direction: column;
      justify-content: center;
      background:
        radial-gradient(circle at 82% 20%, rgba(255,255,255,0.25), transparent 28%),
        radial-gradient(circle at 12% 86%, rgba(14,165,233,0.28), transparent 30%),
        linear-gradient(135deg, #0f172a 0%, #1d4ed8 48%, #0ea5e9 100%);
      box-shadow: 0 20px 48px rgba(15, 23, 42, 0.25);
      border: 1px solid rgba(255,255,255,0.22);
    }

    body.result-mode .cluster-badge-card h3 {
      font-size: 26px;
      letter-spacing: -0.02em;
      margin-bottom: 8px;
    }

    body.result-mode .cluster-badge-card p {
      max-width: 700px;
      line-height: 1.75;
    }

    body.result-mode .section-card {
      box-shadow: 0 14px 38px rgba(15, 23, 42, 0.08);
      border: 1px solid #e8edf5;
      transition: transform 0.22s ease, box-shadow 0.22s ease;
    }

    body.result-mode .section-card:hover {
      box-shadow: 0 18px 48px rgba(15, 23, 42, 0.12);
    }

    body.result-mode #spotsList {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 14px;
    }

    body.result-mode #spotsList .spot-item {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-height: 230px;
      padding: 18px;
      border-radius: 20px;
      background:
        linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
      border: 1px solid #dbeafe;
      box-shadow: 0 12px 30px rgba(37, 99, 235, 0.10);
      transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
      overflow: hidden;
    }

    body.result-mode #spotsList .spot-item::before {
      content: '';
      position: absolute;
      top: -42px;
      right: -42px;
      width: 118px;
      height: 118px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.08);
    }

    body.result-mode #spotsList .spot-item:hover {
      transform: translateY(-6px);
      box-shadow: 0 18px 42px rgba(37, 99, 235, 0.18);
      border-color: #93c5fd;
    }

    body.result-mode #spotsList .spot-rank {
      width: 36px;
      height: 36px;
      border-radius: 13px;
      margin-bottom: 12px;
      z-index: 1;
    }

    body.result-mode #spotsList .spot-main {
      z-index: 1;
      width: 100%;
    }

    body.result-mode #spotsList .spot-category {
      margin-bottom: 8px;
    }

    body.result-mode #spotsList .spot-name {
      font-size: 15.5px;
      font-weight: 850;
      line-height: 1.45;
      margin-bottom: 8px;
    }

    body.result-mode #spotsList .spot-reason {
      font-size: 12px;
      line-height: 1.7;
      color: #475569;
    }

    body.result-mode #spotsList .spot-users {
      margin-top: auto;
      padding-top: 14px;
      font-size: 11.5px;
      font-weight: 800;
      color: #2563eb;
      z-index: 1;
    }

    body.result-mode .hotel-grid {
      grid-template-columns: repeat(3, 1fr);
    }

    body.result-mode .hotel-card {
      transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
    }

    body.result-mode .hotel-card:hover {
      transform: translateY(-4px);
      box-shadow: 0 14px 32px rgba(15, 23, 42, 0.12);
      border-color: #bfdbfe;
    }

    @media (max-width: 860px) {
      body.result-mode main {
        max-width: 700px;
      }

      body.result-mode #spotsList {
        grid-template-columns: 1fr;
      }

      body.result-mode .hotel-grid {
        grid-template-columns: 1fr;
      }

      .result-tabs {
        grid-template-columns: repeat(2, 1fr);
        top: 52px;
      }
    }

    @media (max-width: 520px) {
      .result-tabs {
        grid-template-columns: 1fr 1fr;
        gap: 8px;
        padding: 8px;
      }

      .result-tab {
        font-size: 12px;
        padding: 10px 8px;
      }

      body.result-mode .cluster-badge-card h3 {
        font-size: 22px;
      }
    }
      /* ===== UI v2 Dashboard Enhancement ===== */
    #resultSection {
      animation: resultFadeIn 0.45s ease both;
    }

    @keyframes resultFadeIn {
      from {
        opacity: 0;
        transform: translateY(14px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    #resultSection .section-card,
    #resultSection .cluster-badge-card {
      animation: cardRise 0.55s ease both;
    }

    #resultSection .section-card:nth-child(2) { animation-delay: 0.05s; }
    #resultSection .section-card:nth-child(3) { animation-delay: 0.10s; }
    #resultSection .section-card:nth-child(4) { animation-delay: 0.15s; }

    @keyframes cardRise {
      from {
        opacity: 0;
        transform: translateY(18px);
      }
      to {
        opacity: 1;
        transform: translateY(0);
      }
    }

    #clusterBadge {
      background:
        radial-gradient(circle at 85% 20%, rgba(255,255,255,0.22), transparent 28%),
        linear-gradient(135deg, #0f172a 0%, #1d4ed8 48%, #0ea5e9 100%);
      box-shadow: 0 18px 42px rgba(15, 23, 42, 0.25);
      border: 1px solid rgba(255,255,255,0.24);
    }

    #clusterBadge h3 {
      font-size: 24px;
      letter-spacing: -0.02em;
    }

    #clusterBadge p {
      max-width: 560px;
      line-height: 1.7;
    }

    #spotsList {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 12px;
    }

    #spotsList .spot-item {
      position: relative;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      min-height: 210px;
      padding: 16px;
      border-radius: 18px;
      background:
        linear-gradient(180deg, #ffffff 0%, #f8fbff 100%);
      border: 1px solid #dbeafe;
      box-shadow: 0 10px 28px rgba(37, 99, 235, 0.10);
      transition: transform 0.22s ease, box-shadow 0.22s ease, border-color 0.22s ease;
      overflow: hidden;
    }

    #spotsList .spot-item::before {
      content: '';
      position: absolute;
      top: -40px;
      right: -40px;
      width: 110px;
      height: 110px;
      border-radius: 999px;
      background: rgba(59, 130, 246, 0.08);
    }

    #spotsList .spot-item:hover {
      transform: translateY(-5px);
      box-shadow: 0 16px 38px rgba(37, 99, 235, 0.18);
      border-color: #93c5fd;
    }

    #spotsList .spot-rank {
      width: 34px;
      height: 34px;
      border-radius: 12px;
      margin-bottom: 10px;
      z-index: 1;
    }

    #spotsList .spot-main {
      z-index: 1;
      width: 100%;
    }

    #spotsList .spot-category {
      margin-bottom: 8px;
    }

    #spotsList .spot-name {
      font-size: 15px;
      font-weight: 800;
      line-height: 1.45;
      margin-bottom: 8px;
    }

    #spotsList .spot-image {
      width: 100%;
      aspect-ratio: 16 / 9;
      object-fit: cover;
      border-radius: 12px;
      margin-bottom: 12px;
      z-index: 1;
      background: #e2e8f0;
    }

    #spotsList .spot-area {
      font-size: 11.5px;
      font-weight: 700;
      color: #64748b;
      margin-bottom: 8px;
    }

    #spotsList .spot-reason {
      font-size: 12px;
      line-height: 1.65;
      color: #475569;
    }

    #spotsList .spot-link {
      display: inline-flex;
      margin-top: 10px;
      font-size: 11.5px;
      font-weight: 800;
      color: #1d4ed8;
      text-decoration: none;
      border-bottom: 1px solid rgba(29, 78, 216, 0.35);
    }

    #spotsList .spot-users {
      margin-top: auto;
      padding-top: 12px;
      font-size: 11.5px;
      font-weight: 700;
      color: #2563eb;
      z-index: 1;
    }

    .trait-bar {
      width: 0;
      animation: traitGrow 0.9s ease forwards;
    }

    @keyframes traitGrow {
      from {
        width: 0;
      }
    }

    .hotel-card {
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }

    .hotel-card:hover {
      transform: translateY(-3px);
      box-shadow: 0 10px 26px rgba(15, 23, 42, 0.10);
    }

    @media (max-width: 780px) {
      #spotsList {
        grid-template-columns: 1fr;
      }

      #spotsList .spot-item {
        min-height: auto;
      }
    }
    .spot-main { flex: 1; min-width: 0; }
        .spot-category {
      display: inline-block;
      font-size: 10.5px;
      font-weight: 800;
      color: #1d4ed8;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      padding: 2px 8px;
      border-radius: 999px;
      margin-bottom: 4px;
    }
    .spot-reason, .hotel-reason {
      font-size: 11.5px;
      color: var(--text-sub);
      margin-top: 4px;
      line-height: 1.5;
    }
    .profile-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 12px;
    }
    .trait-card {
      background: #f8fafc;
      border: 1px solid #e8edf5;
      border-radius: 12px;
      padding: 12px 14px;
    }
    .trait-head {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text);
      margin-bottom: 8px;
    }
    .trait-score {
      color: var(--primary);
      white-space: nowrap;
    }
    .trait-bar-bg {
      height: 7px;
      background: #e2e8f0;
      border-radius: 99px;
      overflow: hidden;
    }
    .trait-bar {
      height: 100%;
      background: linear-gradient(90deg, #2563eb, #0ea5e9);
      border-radius: 99px;
    }
    .profile-note, .data-note {
      margin-top: 14px;
      padding: 12px 14px;
      background: #eff6ff;
      border: 1px solid #bfdbfe;
      color: #1e3a8a;
      border-radius: 12px;
      font-size: 12.5px;
      line-height: 1.7;
    }
    .data-kpis {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-bottom: 14px;
    }
    .data-kpi {
      background: #f8fafc;
      border: 1px solid #e8edf5;
      border-radius: 12px;
      padding: 12px;
      text-align: center;
    }
    .data-kpi-value {
      font-size: 20px;
      font-weight: 800;
      color: var(--primary);
    }
    .data-kpi-label {
      font-size: 11.5px;
      color: var(--text-sub);
      margin-top: 3px;
    }
    .data-top-list {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
        .process-flow {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 10px;
    }
    .process-step {
      display: flex;
      gap: 10px;
      align-items: flex-start;
      background: #f8fafc;
      border: 1px solid #e8edf5;
      border-radius: 12px;
      padding: 12px;
    }
    .process-no {
      width: 32px;
      height: 32px;
      border-radius: 10px;
      background: #eff6ff;
      color: #2563eb;
      font-size: 12px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .process-title {
      font-size: 12.8px;
      font-weight: 800;
      color: var(--text);
      margin-bottom: 4px;
    }
    .process-desc {
      font-size: 11.5px;
      color: var(--text-sub);
      line-height: 1.55;
    }
        
    .data-chip {
      background: #f8fafc;
      border: 1px solid #e8edf5;
      border-radius: 999px;
      padding: 6px 10px;
      font-size: 12px;
      color: var(--text);
    }

    .ab-comparison-section .section-body {
      display: grid;
      gap: 22px;
    }

    .ab-plan-grid,
    .ab-form-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
    }

    .ab-plan-block,
    .ab-form-block,
    .ab-comparison-question {
      border: 1px solid #e8edf5;
      border-radius: 12px;
      background: #f8fafc;
      padding: 16px;
    }

    .ab-plan-block h3,
    .ab-form-block h3,
    .ab-comparison-question h3 {
      font-size: 14px;
      color: var(--text);
      margin-bottom: 12px;
      font-weight: 800;
    }

    .ab-spots-list {
      display: grid;
      gap: 12px;
    }

    .ab-spot-card {
      display: grid;
      grid-template-columns: 34px minmax(0, 1fr) 112px;
      align-items: start;
      gap: 12px;
      background: #fff;
      box-shadow: none;
      margin: 0;
      padding: 12px;
      border: 1px solid #e8edf5;
      border-radius: 12px;
    }

    .ab-spot-rank {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      background: #eff6ff;
      color: #1d4ed8;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 900;
      flex-shrink: 0;
    }

    .ab-spot-main {
      min-width: 0;
      display: grid;
      gap: 7px;
    }

    .ab-spot-name {
      font-size: 14px;
      line-height: 1.35;
      font-weight: 850;
      color: var(--text);
      overflow-wrap: anywhere;
    }

    .ab-spot-reason {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-sub);
      overflow-wrap: anywhere;
    }

    .ab-spot-link {
      width: fit-content;
      color: var(--primary);
      font-size: 12px;
      font-weight: 800;
      text-decoration: none;
    }

    .ab-spot-link:hover {
      text-decoration: underline;
    }

    .ab-spot-thumb {
      width: 112px;
      height: 84px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid #e8edf5;
      background: #f1f5f9;
      justify-self: end;
    }

    .ab-evaluation-form {
      display: grid;
      gap: 18px;
    }

    .ab-score-row {
      display: grid;
      gap: 8px;
      padding: 10px 0;
      border-top: 1px solid #e8edf5;
    }

    .ab-score-row:first-of-type {
      border-top: 0;
      padding-top: 0;
    }

    .ab-score-label {
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text);
    }

    .ab-score-options,
    .ab-choice-options {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .ab-score-options label,
    .ab-choice-options label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border: 1px solid #dbe3ef;
      background: #fff;
      border-radius: 999px;
      padding: 7px 10px;
      font-size: 12.5px;
      font-weight: 700;
      color: var(--text);
      cursor: pointer;
    }

    .ab-score-options input,
    .ab-choice-options input {
      accent-color: var(--primary);
    }

    .ab-comment-label {
      font-size: 13px;
      font-weight: 800;
      color: var(--text);
    }

    .ab-comment {
      width: 100%;
      resize: vertical;
      border: 1px solid #dbe3ef;
      border-radius: 12px;
      padding: 12px;
      font: inherit;
      line-height: 1.5;
      color: var(--text);
      background: #fff;
    }

    .ab-save-btn {
      width: fit-content;
      border: none;
      border-radius: 999px;
      background: var(--primary);
      color: #fff;
      padding: 11px 18px;
      font-size: 13px;
      font-weight: 800;
      cursor: pointer;
      box-shadow: 0 8px 20px rgba(37, 99, 235, 0.22);
    }

    .ab-save-btn:hover {
      background: var(--primary-dark);
      transform: translateY(-1px);
    }

    .ab-local-ai-btn {
      background: #0f766e;
      box-shadow: 0 8px 20px rgba(15, 118, 110, 0.22);
    }

    .ab-local-ai-btn:hover {
      background: #115e59;
    }

    .ab-local-ai-btn:disabled {
      cursor: wait;
      opacity: 0.65;
      transform: none;
    }

    .ab-save-btn:disabled {
      cursor: not-allowed;
      opacity: 0.55;
      transform: none;
      box-shadow: none;
    }

    .ab-local-ai-section {
      display: grid;
      gap: 12px;
      border: 1px solid #99f6e4;
      border-radius: 16px;
      padding: 18px;
      background: #f0fdfa;
    }

    .ab-local-ai-section h3 {
      margin: 0;
      color: #115e59;
    }

    .ab-save-explanation {
      margin: 0;
      color: #334155;
      font-size: 13px;
      line-height: 1.6;
    }

    .ab-local-ai-section p {
      margin: 0;
      color: var(--text-sub);
      font-size: 13px;
      line-height: 1.6;
    }

    .integrated-recommendation-section .section-body {
      display: grid;
      gap: 14px;
    }

    .integrated-spot-list {
      display: grid;
      gap: 14px;
    }

    .integrated-spot-card {
      display: grid;
      grid-template-columns: 34px 132px minmax(0, 1fr);
      gap: 14px;
      align-items: start;
      border: 1px solid #e8edf5;
      border-radius: 12px;
      padding: 14px;
      background: #fff;
    }

    .integrated-spot-rank {
      width: 30px;
      height: 30px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 13px;
      font-weight: 900;
      color: #0f766e;
      background: #ccfbf1;
    }

    .integrated-spot-image {
      width: 132px;
      height: 96px;
      object-fit: cover;
      border-radius: 8px;
      border: 1px solid #e8edf5;
      background: #f1f5f9;
    }

    .integrated-spot-main {
      min-width: 0;
      display: grid;
      gap: 7px;
    }

    .integrated-spot-name {
      font-size: 15px;
      line-height: 1.35;
      font-weight: 850;
      color: var(--text);
      overflow-wrap: anywhere;
    }

    .integrated-spot-area,
    .integrated-spot-reason,
    .integrated-spot-note {
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-sub);
      overflow-wrap: anywhere;
    }

    .integrated-spot-note strong {
      color: var(--text);
    }

    .ab-local-ai-section .ab-save-explanation {
      color: #334155;
    }

    .ab-local-ai-result {
      min-height: 54px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      max-height: 720px;
      overflow-y: auto;
      border: 1px solid #dbe3ef;
      border-radius: 12px;
      padding: 14px;
      background: #f8fafc;
      color: var(--text);
      font-size: 13px;
      line-height: 1.7;
    }

    .ab-empty {
      border: 1px dashed #cbd5e1;
      border-radius: 12px;
      padding: 14px;
      font-size: 13px;
      color: var(--text-sub);
      background: #fff;
    }

    @media (max-width: 600px) {
      .profile-grid,
      .data-kpis,
      .process-flow,
      .ab-plan-grid,
      .ab-form-grid {
        grid-template-columns: 1fr;
      }

      .ab-spot-card {
        grid-template-columns: 30px minmax(0, 1fr);
      }

      .integrated-spot-card {
        grid-template-columns: 30px minmax(0, 1fr);
      }

      .ab-spot-thumb {
        grid-column: 2;
        justify-self: start;
        width: 96px;
        height: 72px;
      }

      .integrated-spot-image {
        grid-column: 2;
        width: 112px;
        height: 82px;
      }
    }
  `;
  document.head.appendChild(style);
}

function langText(ja, zh) {
  return window.currentLang === 'zh' ? zh : ja;
}

function getSpotReason(spot) {
  if (spot.category === 'classic') {
    return langText(
      '推薦理由：2025年度の推薦ログにおいて高頻度に出現した、安定性の高い定番候補として抽出しました。',
      '推荐理由：该地点在2025年度推荐日志中高频出现，作为稳定性较高的经典候选抽出。'
    );
  }

  if (spot.category === 'personalized') {
    return langText(
      '推薦理由：同行者・旅行時期別の過去推薦傾向、および旅行者タイプとの対応に基づき抽出しました。',
      '推荐理由：根据同行者、旅行时期分类下的过去推荐趋势，以及旅行者类型的匹配关系抽出。'
    );
  }

  if (spot.category === 'discovery') {
    return langText(
      '推薦理由：高頻度スポットに偏りすぎないよう、旅行者クラスターとの関連性を考慮して補完候補として抽出しました。',
      '推荐理由：为了避免过度偏向热门地点，结合旅行者 cluster 的相关性作为发现型候选抽出。'
    );
  }

  return langText(
    '推薦理由：推薦データと旅行者タイプに基づき候補として抽出しました。',
    '推荐理由：基于推荐数据与旅行者类型作为候选抽出。'
  );
}
const AB_EVALUATION_ITEMS = [
  { key: "answer_fit", label: "回答内容に合っているか" },
  { key: "visit_interest", label: "行ってみたいと思うか" },
  { key: "reason_clarity", label: "推薦理由が分かりやすいか" },
  { key: "personalized_feeling", label: "自分向けだと感じるか" },
  { key: "trip_realism", label: "旅行プランとして現実的か" },
  { key: "overall_satisfaction", label: "全体満足度" }
];

function getSpotNameForAB(spot) {
  const selectedSpot = spot?.selectedSpot || spot?.spot || null;
  return selectedSpot?.name || spot?.name || spot?.spot_name || spot?.title || spot?.place || spot?.area || "名称未設定";
}

function truncateJapaneseText(text, maxLength = 82) {
  const cleaned = String(text || "").replace(/\s+/g, " ").trim();
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, maxLength - 1)}…`;
}

function uniqueCompactItems(values, limit = 3) {
  return [...new Set((values || [])
    .map(value => String(value || "").trim())
    .filter(Boolean))]
    .slice(0, limit);
}

function getSpotReasonForAB(spot, planLabel = "") {
  if (spot?.ab_reason) return truncateJapaneseText(spot.ab_reason);

  if (spot?.source === "auto_clustering_baseline" || spot?.baseline_cluster_id || planLabel === "推薦案2") {
    return buildBaselineABReason(spot);
  }

  return buildHandcraftedABReason(spot);
}

function buildHandcraftedABReason(spot) {
  const selectedSpot = spot?.selectedSpot || spot?.spot || {};
  const category = spot?.category;
  const area = spot?.place || selectedSpot?.area || "";
  const tags = uniqueCompactItems([
    ...(selectedSpot?.purpose_tags || []),
    ...(selectedSpot?.trait_tags || [])
  ], 2);

  let reason = "";
  if (category === "classic") {
    reason = "過去データで安定して推薦される定番候補として、回答傾向と合わせて抽出しました。";
  } else if (category === "personalized") {
    reason = "同行者や時期の傾向に合い、回答から見える旅行スタイルにも近いため抽出しました。";
  } else if (category === "discovery") {
    reason = "人気だけに偏らず、回答傾向と関連する発見型スポットとして抽出しました。";
  } else {
    reason = "回答から推定した旅行スタイルと推薦データの近さをもとに抽出しました。";
  }

  if (tags.length) {
    reason = `${tags.join("・")}との関連があり、${reason}`;
  } else if (area) {
    reason = `${area}周辺の候補として、${reason}`;
  }
  return truncateJapaneseText(reason);
}

function buildBaselineABReason(spot) {
  const clusterTraits = uniqueCompactItems(spot?.baseline_top_traits, 3);
  const purposeTags = uniqueCompactItems(spot?.baseline_purpose_tags, 3);
  const keywords = uniqueCompactItems(spot?.baseline_matched_keywords, 3);
  const selectedSpot = spot?.selectedSpot || {};
  const spotTags = uniqueCompactItems([
    ...(selectedSpot?.purpose_tags || []),
    ...(selectedSpot?.trait_tags || [])
  ], 2);
  const summaryHint = truncateJapaneseText(spot?.baseline_summary || "", 28);

  const tendency = purposeTags.length
    ? purposeTags.join("・")
    : keywords.length
      ? keywords.join("・")
      : clusterTraits.length
        ? clusterTraits.join("・")
        : summaryHint || "自由記述クラスタの傾向";
  const spotFit = spotTags.length ? `このスポットは${spotTags.join("・")}に合うため` : "このスポットがその傾向に合うため";
  return truncateJapaneseText(`自由記述クラスタでは${tendency}への関心が高く、${spotFit}抽出しました。`);
}

function getSpotImageForAB(spot) {
  const selectedSpot = spot?.selectedSpot || spot?.spot || null;
  return selectedSpot?.image || selectedSpot?.image_url || spot?.image || spot?.image_url || spot?.thumbnail || "";
}

function getSpotLinkForAB(spot) {
  const selectedSpot = spot?.selectedSpot || spot?.spot || null;
  const selectedWebsite = Array.isArray(selectedSpot?.website) ? selectedSpot.website[0] : selectedSpot?.website;
  const spotWebsite = Array.isArray(spot?.website) ? spot.website[0] : spot?.website;
  return selectedSpot?.url || selectedWebsite || spot?.url || spot?.detail_url || spot?.link || spotWebsite || "";
}

function normalizeABSpotForExport(spot) {
  return {
    name: getSpotNameForAB(spot),
    reason: getSpotReasonForAB(spot),
    image: getSpotImageForAB(spot) || null,
    detail_link: getSpotLinkForAB(spot) || null,
    source_place: spot?.place || spot?.area || spot?.primary_area || null
  };
}

function normalizeIntegratedRecommendationForExport(spot) {
  return {
    name: spot?.name || spot?.selectedSpot?.name || null,
    area: spot?.area || spot?.selectedSpot?.area || null,
    image: spot?.image || spot?.selectedSpot?.image || null,
    detail_link: spot?.url || spot?.selectedSpot?.url || null,
    recommendation_reason: spot?.recommendation_reason || null,
    a_relationship: spot?.a_relationship || null,
    b_need_match: spot?.b_need_match || null,
    purpose_tags: spot?.purpose_tags || spot?.selectedSpot?.purpose_tags || [],
    trait_tags: spot?.trait_tags || spot?.selectedSpot?.trait_tags || [],
    spot_type: spot?.spot_type || spot?.selectedSpot?.spot_type || null,
    score_debug: spot?.recommendationDebug || null
  };
}

function isSpotLikeArray(value) {
  return Array.isArray(value) && value.some(item =>
    item && typeof item === "object" && (
      item.selectedSpot || item.spot || item.name || item.spot_name || item.place || item.reason || item.recommendation_reason
    )
  );
}

function extractRecommendationArray(candidate, depth = 0) {
  if (!candidate || depth > 3) return [];
  if (isSpotLikeArray(candidate)) return candidate;
  if (typeof candidate !== "object") return [];

  const preferredKeys = [
    "recommended_spots",
    "recommendation_spots",
    "baseline_recommended_spots",
    "baseline_spots",
    "spots",
    "recommendations",
    "items",
    "cards"
  ];

  for (const key of preferredKeys) {
    const found = extractRecommendationArray(candidate[key], depth + 1);
    if (found.length) return found;
  }

  for (const value of Object.values(candidate)) {
    const found = extractRecommendationArray(value, depth + 1);
    if (found.length) return found;
  }

  return [];
}

function buildAutoBaselineRecommendation(userTraitScores, visitedPlaces) {
  const profiles = Array.isArray(AUTO_CLUSTER_PROFILES) ? AUTO_CLUSTER_PROFILES : [];
  if (!profiles.length) {
    console.warn("[AB Test] missing B baseline source path: data/auto_clustering_baseline/auto_cluster_profiles_from_teacher.json");
    return {
      source: "auto_clustering_baseline",
      recommendations: [],
      missing_path: "data/auto_clustering_baseline/auto_cluster_profiles_from_teacher.json"
    };
  }

  const scoredProfiles = profiles
    .filter(profile => profile?.trait_scores)
    .map(profile => ({
      profile,
      score: traitSimilarity(userTraitScores, profile.trait_scores)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scoredProfiles[0];
  if (!best) {
    console.warn("[AB Test] missing baseline_debug.recommendations: no usable auto cluster profile trait_scores");
    return {
      source: "auto_clustering_baseline",
      recommendations: [],
      missing_path: "AUTO_CLUSTER_PROFILES[*].trait_scores"
    };
  }

  const recommendations = buildAutoBaselineSpotRecommendations(best.profile, visitedPlaces);
  const keywordGroups = best.profile.matched_keywords && typeof best.profile.matched_keywords === "object"
    ? Object.values(best.profile.matched_keywords).flat()
    : [];
  return {
    source: "auto_clustering_baseline",
    baseline_cluster_id: best.profile.auto_cluster_id || best.profile.source_cluster_id || null,
    baseline_summary: best.profile.summary || "",
    baseline_top_traits: best.profile.top_traits || [],
    baseline_purpose_tags: best.profile.purpose_tags || [],
    baseline_matched_keywords: uniqueCompactItems(keywordGroups, 18),
    matched_keywords: best.profile.matched_keywords || null,
    similarity_score: best.score,
    recommendations,
    recommended_spots: recommendations
  };
}

const AUTO_NEED_THEME_KEYWORDS = {
  dinosaur_museum_family_experience: ["恐竜", "博物館", "子供", "子ども", "家族", "体験", "学び"],
  echizen_soba_local_food: ["そば", "蕎麦", "越前そば", "美味しい", "地元", "食"],
  seafood_market_gourmet: ["海鮮", "かに", "カニ", "蟹", "甘エビ", "市場", "グルメ"],
  onsen_lodging_relaxation: ["温泉", "風呂", "宿泊", "宿", "ゆっくり", "静か", "癒し"],
  public_transport_access: ["バス", "交通", "駅", "アクセス", "移動", "新幹線"],
  car_parking_touring: ["駐車場", "車", "ドライブ", "周遊", "道路"],
  facility_comfort_safety: ["トイレ", "清潔", "案内", "スタッフ", "接客", "安心", "便利"],
  nature_scenic_drive: ["自然", "景色", "海", "山", "湖", "紅葉", "桜", "絶景", "水仙"]
};

function getSelectedAnswerTexts(questionnaireAnswers) {
  return Object.entries(questionnaireAnswers || {}).map(([qid, value]) => {
    const question = (QUESTIONS || []).find(item => item.id === qid);
    const index = Number(value) - 1;
    return question?.options_jp?.[index] || question?.options?.[index] || "";
  }).filter(Boolean);
}

function getUserNeedTokens({ userTraitScores, tagCounts, questionnaireAnswers, companion, season }) {
  const topTraits = Object.entries(userTraitScores || {})
    .filter(([, score]) => Number(score) > 0.15)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([trait]) => trait);
  const traitThemeTokens = {
    relaxation: ["onsen_lodging_relaxation", "温泉", "宿泊", "ゆっくり"],
    food_value: ["echizen_soba_local_food", "seafood_market_gourmet", "そば", "海鮮", "美味しい"],
    nature: ["nature_scenic_drive", "自然", "景色", season === "秋" ? "紅葉" : "", season === "春" ? "桜" : ""],
    exploration_experience: ["dinosaur_museum_family_experience", "恐竜", "博物館", "体験", "家族"],
    efficiency_touring: ["public_transport_access", "car_parking_touring", "交通", "駐車場", "ドライブ"],
    planning: ["facility_comfort_safety", "案内", "安心", "トイレ"]
  };
  const companionTokens = {
    "一人旅": ["自然", "歴史", "まち歩き"],
    "家族": ["家族", "子供", "博物館", "体験", "温泉"],
    "子連れ家族": ["家族", "子供", "博物館", "体験"],
    "友人・グループ": ["体験", "グルメ", "ドライブ"],
    "夫婦・カップル": ["温泉", "自然", "景色", "ゆっくり"]
  };
  const seasonTokens = {
    "春": ["桜", "花", "自然"],
    "夏": ["海", "湖", "アウトドア", "家族"],
    "秋": ["紅葉", "自然", "山", "景色"],
    "冬": ["温泉", "水仙", "海鮮", "蟹"]
  };
  return uniqueCompactItems([
    ...topTraits,
    ...topTraits.flatMap(trait => traitThemeTokens[trait] || []),
    ...Object.keys(tagCounts || {}),
    ...getSelectedAnswerTexts(questionnaireAnswers),
    companion,
    season,
    ...(companionTokens[companion] || []),
    ...(seasonTokens[season] || [])
  ], 80);
}

function itemValues(items) {
  return (items || []).map(item => item?.value || item).filter(Boolean);
}

function scoreAutoNeedCluster(profile, context) {
  const userTraitScores = context.userTraitScores || {};
  const clusterTraitScores = profile?.trait_scores || {};
  const traitScore = traitSimilarity(userTraitScores, clusterTraitScores);
  const userTokens = context.userTokens || [];
  const keywordHits = countTextMatches(userTokens.join(" "), profile?.top_keywords || []);
  const purposeHits = countTextMatches(userTokens.join(" "), profile?.purpose_tags || []);
  const userTopTraits = Object.entries(userTraitScores)
    .filter(([, score]) => Number(score) > 0.2)
    .map(([trait]) => trait);
  const themeHits = (profile?.cluster_theme_tags || []).filter(tag => userTokens.includes(tag) || userTopTraits.some(trait => {
    if (trait === "food_value") return ["echizen_soba_local_food", "seafood_market_gourmet"].includes(tag);
    if (trait === "nature") return tag === "nature_scenic_drive";
    if (trait === "relaxation") return tag === "onsen_lodging_relaxation";
    if (trait === "exploration_experience") return tag === "dinosaur_museum_family_experience";
    if (trait === "efficiency_touring") return ["public_transport_access", "car_parking_touring"].includes(tag);
    if (trait === "planning") return tag === "facility_comfort_safety";
    return false;
  })).length;
  const companionHit = context.companion && itemValues(profile?.top_companions).some(value => String(value).includes(context.companion)) ? 1 : 0;
  const monthSeasonHit = context.season && countTextMatches(context.season, profile?.summary ? [profile.summary] : []);
  return traitScore * 56 + Math.min(keywordHits * 7, 28) + Math.min(purposeHits * 8, 24) + Math.min(themeHits * 12, 36) + companionHit * 10 + monthSeasonHit * 4;
}

function normalizeAutoNeedCluster(profile, similarityScore = 0) {
  return {
    id: profile?.id || null,
    name: profile?.name || "",
    summary: profile?.summary || "",
    size: Number(profile?.size) || 0,
    top_keywords: profile?.top_keywords || [],
    purpose_tags: profile?.purpose_tags || [],
    trait_scores: profile?.trait_scores || {},
    cluster_theme_tags: profile?.cluster_theme_tags || [],
    representative_comments: profile?.representative_comments || [],
    top_areas: profile?.top_areas || [],
    top_companions: profile?.top_companions || [],
    top_purposes: profile?.top_purposes || [],
    dominant_text_columns: profile?.dominant_text_columns || [],
    theme_confidence: Number(profile?.theme_confidence) || 0,
    similarity_score: Number(similarityScore) || 0,
    source: "auto_need_clusters"
  };
}

function buildBClusterMatch({ userTraitScores, tagCounts, questionnaireAnswers, companion, season, visitedPlaces }) {
  const profiles = Array.isArray(AUTO_NEED_CLUSTERS) ? AUTO_NEED_CLUSTERS : [];
  if (profiles.length) {
    const context = {
      userTraitScores,
      tagCounts,
      questionnaireAnswers,
      companion,
      season,
      userTokens: getUserNeedTokens({ userTraitScores, tagCounts, questionnaireAnswers, companion, season })
    };
    const scored = profiles
      .filter(profile => profile?.id)
      .map(profile => ({ profile, score: scoreAutoNeedCluster(profile, context) }))
      .sort((a, b) => b.score - a.score);
    const best = scored[0];
    if (best) {
      const matchedCluster = normalizeAutoNeedCluster(best.profile, best.score);
      console.log("Using B cluster source:", "auto_need_clusters");
      return {
        source: "auto_need_clusters",
        matched_b_cluster: matchedCluster,
        baseline_cluster_id: matchedCluster.id,
        baseline_summary: matchedCluster.summary,
        baseline_top_traits: Object.entries(matchedCluster.trait_scores)
          .sort((a, b) => Number(b[1]) - Number(a[1]))
          .map(([trait]) => trait)
          .slice(0, 6),
        baseline_purpose_tags: matchedCluster.purpose_tags,
        baseline_matched_keywords: matchedCluster.top_keywords,
        baseline_theme_tags: matchedCluster.cluster_theme_tags,
        similarity_score: best.score,
        recommendations: [],
        recommended_spots: []
      };
    }
  }

  const legacy = buildAutoBaselineRecommendation(userTraitScores, visitedPlaces);
  console.log("Using B cluster source:", "legacy_teacher_auto_cluster");
  legacy.source = "legacy_teacher_auto_cluster";
  legacy.matched_b_cluster = {
    id: legacy.baseline_cluster_id || null,
    name: legacy.baseline_cluster_id || "legacy teacher auto cluster",
    summary: legacy.baseline_summary || "",
    size: null,
    top_keywords: legacy.baseline_matched_keywords || [],
    purpose_tags: legacy.baseline_purpose_tags || [],
    trait_scores: {},
    cluster_theme_tags: [],
    representative_comments: [],
    top_areas: [],
    top_companions: [],
    top_purposes: [],
    dominant_text_columns: [],
    theme_confidence: 0,
    source: "legacy_teacher_auto_cluster"
  };
  return legacy;
}

function buildAutoBaselineSpotRecommendations(profile, visitedPlaces) {
  const visited = visitedPlaces
    ? String(visitedPlaces).split(/[、，,\s]+/).map(s => s.trim()).filter(Boolean)
    : [];
  const isVisited = (spot) => {
    const haystack = [
      spot?.name,
      spot?.primary_area,
      ...(spot?.areas || [])
    ].join(" ");
    return visited.some(place => place && haystack.includes(place));
  };

  const purposeTags = Array.isArray(profile?.purpose_tags) ? profile.purpose_tags : [];
  const topTraits = Array.isArray(profile?.top_traits) ? profile.top_traits : [];
  const keywordGroups = profile?.matched_keywords && typeof profile.matched_keywords === "object"
    ? Object.values(profile.matched_keywords).flat()
    : [];
  const matchedKeywords = uniqueCompactItems(keywordGroups, 8);
  const keywords = [...new Set([...purposeTags, ...keywordGroups].map(value => String(value || "").trim()).filter(Boolean))];
  const summary = String(profile?.summary || "");

  const scoredSpots = (SPOT_MASTER || [])
    .filter(spot => spot?.name && !isVisited(spot))
    .map(spot => {
      const selectedSpot = toSelectedSpot(spot);
      const text = [
        spot.name,
        spot.primary_area,
        ...(spot.areas || []),
        ...(spot.categories || []),
        ...(spot.purpose_tags || []),
        ...(spot.trait_tags || []),
        spot.description
      ].join(" ").toLowerCase();

      const purposeHits = purposeTags.filter(tag => tag && text.includes(String(tag).toLowerCase())).length;
      const keywordHits = keywords.filter(keyword => keyword && text.includes(String(keyword).toLowerCase())).length;
      const traitHits = topTraits.filter(trait => {
        const normalizedTrait = String(trait || "").toLowerCase();
        return normalizedTrait && text.includes(normalizedTrait);
      }).length;
      const summaryHits = keywords.filter(keyword => keyword && summary.includes(keyword)).length;
      const qualityScore = getSpotQualityBoost(spot);
      const score = purposeHits * 42 + keywordHits * 24 + traitHits * 12 + Math.min(summaryHits * 4, 20) + qualityScore;

      return {
        place: selectedSpot?.area || spot.primary_area || spot.name,
        score,
        source: "auto_clustering_baseline",
        category: "baseline",
        categoryJa: "推薦案2",
        categoryZh: "推薦案2",
        selectedSpot,
        baseline_cluster_id: profile?.auto_cluster_id || profile?.source_cluster_id || null,
        baseline_summary: profile?.summary || "",
        baseline_top_traits: topTraits,
        baseline_purpose_tags: purposeTags,
        baseline_matched_keywords: matchedKeywords,
        recommendationDebug: {
          purposeHits,
          keywordHits,
          traitHits,
          finalScore: Math.round(score)
        }
      };
    })
    .sort((a, b) => b.score - a.score);

  const selected = [];
  const usedNames = new Set();
  scoredSpots.forEach(candidate => {
    const name = candidate.selectedSpot?.name || candidate.place;
    if (!name || usedNames.has(name) || selected.length >= 3) return;
    usedNames.add(name);
    selected.push(candidate);
  });

  if (selected.length < 3) {
    console.warn("[AB Test] baseline_debug.recommendations has fewer than 3 spots", selected);
  }
  return selected.slice(0, 3);
}

function splitVisitedPlaces(visitedPlaces) {
  return visitedPlaces
    ? String(visitedPlaces).split(/[\s,、，/]+/).map(s => s.trim()).filter(Boolean)
    : [];
}

function spotIncludesAny(masterSpot, values) {
  const haystack = spotTextFields(masterSpot).join(" ").toLowerCase();
  return (values || []).some(value => {
    const needle = String(value || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  });
}

function countSpotMatches(masterSpot, values) {
  const haystack = spotTextFields(masterSpot).join(" ").toLowerCase();
  return uniqueCompactItems(values, 50).filter(value => {
    const needle = String(value || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  }).length;
}

function countTextMatches(text, values) {
  const haystack = String(text || "").toLowerCase();
  return uniqueCompactItems(values, 80).filter(value => {
    const needle = String(value || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  }).length;
}

function collectSpotMatchedValues(masterSpot, values, limit = 5) {
  const haystack = spotTextFields(masterSpot).join(" ").toLowerCase();
  return uniqueCompactItems(values, 80).filter(value => {
    const needle = String(value || "").trim().toLowerCase();
    return needle && haystack.includes(needle);
  }).slice(0, limit);
}

function getSpotFeatureLabels(spot, limit = 5) {
  const fields = [
    ...(spot?.purpose_tags || []),
    ...(spot?.trait_tags || []),
    ...(spot?.categories || []),
    spot?.spot_type || inferSpotType(spot)
  ];
  return uniqueCompactItems(fields, limit);
}

function getSpotTypeLabel(spotType) {
  const labels = {
    shrine_temple: "歴史・文化",
    history_culture: "歴史・文化",
    nature: "自然鑑賞",
    museum_themepark: "学び・体験施設",
    activity_experience: "体験型スポット",
    hot_spring: "温泉・リラックス",
    food: "地元食・グルメ",
    transport: "交通拠点",
    facility: "補助施設",
    other: "補助候補"
  };
  return labels[spotType] || "観光スポット";
}

function hasDetailedSpotLink(spot) {
  return Boolean(spot?.url || (Array.isArray(spot?.website) && spot.website[0]));
}

function getRepresentativeBonus(spot, spotType) {
  let bonus = 0;
  if (spot?.image) bonus += 12;
  if (hasDetailedSpotLink(spot)) bonus += 10;
  if ((Number(spot?.quality_score) || 0) >= 0.8) bonus += 12;
  if (spot?.is_core_tourism_spot === true) bonus += 18;
  if (["nature", "history_culture", "shrine_temple", "museum_themepark", "activity_experience", "hot_spring"].includes(spotType)) {
    bonus += 10;
  }
  return bonus;
}

function getMinorSpotPenalty(spot, spotType) {
  const text = [
    spot?.name,
    ...(spot?.categories || []),
    spot?.description
  ].join(" ");
  let penalty = 0;
  if (/碑|句碑|歌碑|石碑|記念碑|記念像|銅像|像$|モニュメント|跡地|小公園/.test(text)) penalty += 55;
  if ((Number(spot?.quality_score) || 0) < 0.45) penalty += 18;
  if (!spot?.image) penalty += 10;
  if (!hasDetailedSpotLink(spot)) penalty += 8;
  if (spot?.is_low_priority_candidate === true) penalty += 60;
  if (["transport", "facility", "other"].includes(spotType)) penalty += 70;
  return penalty;
}

function countSpotThemeMatches(masterSpot, themeTags) {
  const text = spotTextFields(masterSpot).join(" ");
  return uniqueCompactItems(themeTags, 12).filter(themeTag => {
    const keywords = AUTO_NEED_THEME_KEYWORDS[themeTag] || [themeTag];
    return keywords.some(keyword => keyword && text.includes(keyword));
  }).length;
}

function extractBaselineNeeds(baselineDebug) {
  if (baselineDebug?.matched_b_cluster?.source === "auto_need_clusters") {
    const cluster = baselineDebug.matched_b_cluster;
    const topTraits = Object.entries(cluster.trait_scores || {})
      .sort((a, b) => Number(b[1]) - Number(a[1]))
      .map(([trait]) => trait)
      .slice(0, 8);
    return {
      id: cluster.id || null,
      name: cluster.name || "",
      summary: cluster.summary || "",
      purposeTags: cluster.purpose_tags || [],
      topTraits,
      matchedKeywords: cluster.top_keywords || [],
      themeTags: cluster.cluster_theme_tags || [],
      traitScores: cluster.trait_scores || {},
      source: "auto_need_clusters",
      matchedCluster: cluster
    };
  }

  const baselineSpots = extractRecommendationArray(baselineDebug);
  const purposeTags = uniqueCompactItems([
    ...(baselineDebug?.baseline_purpose_tags || []),
    ...(baselineDebug?.purpose_tags || []),
    ...baselineSpots.flatMap(spot => spot?.baseline_purpose_tags || [])
  ], 12);
  const topTraits = uniqueCompactItems([
    ...(baselineDebug?.baseline_top_traits || []),
    ...(baselineDebug?.top_traits || []),
    ...baselineSpots.flatMap(spot => spot?.baseline_top_traits || [])
  ], 12);
  const keywordValues = baselineDebug?.matched_keywords && typeof baselineDebug.matched_keywords === "object"
    ? Object.values(baselineDebug.matched_keywords).flat()
    : [];
  const matchedKeywords = uniqueCompactItems([
    ...(baselineDebug?.baseline_matched_keywords || []),
    ...(baselineDebug?.matched_keywords_flat || []),
    ...keywordValues,
    ...baselineSpots.flatMap(spot => spot?.baseline_matched_keywords || [])
  ], 18);

  return {
    id: baselineDebug?.baseline_cluster_id || null,
    name: baselineDebug?.matched_b_cluster?.name || baselineDebug?.baseline_cluster_id || "",
    summary: baselineDebug?.baseline_summary || baselineDebug?.summary || "",
    purposeTags,
    topTraits,
    matchedKeywords,
    themeTags: baselineDebug?.baseline_theme_tags || [],
    traitScores: baselineDebug?.matched_b_cluster?.trait_scores || {},
    source: baselineDebug?.source || "legacy_teacher_auto_cluster",
    matchedCluster: baselineDebug?.matched_b_cluster || null
  };
}

function getConditionScoreForSpot(masterSpot, companion, season) {
  const keys = [];
  if (companion && season) keys.push(`${companion}×${season}`);
  if (companion && !season) keys.push(`${companion}×nan`);
  if (companion) keys.push(`companion:${companion}`);
  if (season) keys.push(`season:${season}`);

  let score = 0;
  uniqueCompactItems(keys, 8).forEach((key, index) => {
    const weightRows = SPOT_WEIGHTS[key] || [];
    weightRows.slice(0, 30).forEach(row => {
      const place = row?.place || "";
      if (!place) return;
      if (spotIncludesAny(masterSpot, [place])) {
        score += Math.min(Number(row.score) || 0, 35) * (index === 0 ? 1.2 : 0.8);
      }
    });
  });

  const text = spotTextFields(masterSpot).join(" ");
  const seasonRules = {
    "春": ["桜", "花", "公園"],
    "夏": ["海水浴", "湖", "海岸", "アウトドア", "家族向け屋内施設", "屋内施設", "水遊び"],
    "秋": ["紅葉", "山", "渓谷", "自然"],
    "冬": ["温泉", "水仙", "屋内施設", "美食", "グルメ"]
  };
  const companionRules = {
    "一人旅": ["歴史", "自然", "まち歩き", "城", "史跡"],
    "家族": ["テーマパーク", "体験", "博物館", "温泉", "屋内施設"],
    "子連れ家族": ["テーマパーク", "体験", "博物館", "温泉", "屋内施設"],
    "友人・グループ": ["体験", "アウトドア", "グルメ", "美食"],
    "夫婦・カップル": ["景色", "絶景", "温泉", "自然", "まち歩き"]
  };

  const addRuleScore = (values, unit, max) => {
    const hits = (values || []).filter(value => value && text.includes(value)).length;
    return Math.min(hits * unit, max);
  };
  score += addRuleScore(seasonRules[season], 8, 24);
  score += addRuleScore(companionRules[companion], 7, 21);

  return Math.min(score, 55);
}

function inferSpotType(masterSpot) {
  const existingType = String(masterSpot?.spot_type || "").trim().toLowerCase();
  if (existingType && existingType !== "unknown") return existingType;
  const text = [
    masterSpot?.name,
    masterSpot?.primary_area,
    ...(masterSpot?.areas || []),
    ...(masterSpot?.categories || []),
    masterSpot?.description
  ].join(" ");

  if (/道の駅|駅|ターミナル|観光案内所/.test(text)) {
    return /駅|ターミナル/.test(text) ? "transport" : "facility";
  }
  if (/ロゴオブジェ|ふれあい会館/.test(text)) return "facility";
  if (/イベント|まつり|祭り/.test(text)) return "other";
  if (/温泉/.test(text)) return "hot_spring";
  if (/博物館|美術館|資料館|ミュージアム/.test(text)) return "museum_themepark";
  if (/体験|工芸|陶芸/.test(text)) return "activity_experience";
  if (/海|湖|山|公園|滝|岬|渓谷|高原|海岸/.test(text)) return "nature";
  if (/城|史跡|町並み|寺|神社|仏閣/.test(text)) {
    return /寺|神社|仏閣/.test(text) ? "shrine_temple" : "history_culture";
  }
  if (/食|グルメ|市場|レストラン|そば|海鮮|カフェ/.test(text)) return "food";

  return existingType || "unknown";
}

function hasMainRecommendationBlockName(masterSpot) {
  const text = [
    masterSpot?.name,
    masterSpot?.primary_area,
    ...(masterSpot?.areas || []),
    ...(masterSpot?.categories || [])
  ].join(" ");
  return /観光案内所|ターミナル|駅|道の駅|ロゴオブジェ|ふれあい会館|まつり|祭り|イベント/.test(text);
}

function isMainTourismCandidate(masterSpot) {
  const inferredType = inferSpotType(masterSpot);
  const penalty = Number(masterSpot?.main_recommendation_penalty) || 0;
  if (!masterSpot?.name) return false;
  if (hasMainRecommendationBlockName(masterSpot)) return false;
  if (["transport", "facility", "other"].includes(inferredType)) return false;
  if (masterSpot?.is_low_priority_candidate === true) return false;
  if (penalty > 0.5) return false;
  return true;
}

function getTourismTypeBoost(spotType) {
  const preferred = {
    shrine_temple: 16,
    history_culture: 16,
    nature: 16,
    museum_themepark: 14,
    activity_experience: 14,
    hot_spring: 12,
    food: 8
  };
  return preferred[spotType] || 0;
}

function buildIntegratedRecommendation({
  aClusterInfo,
  aRecommendations,
  baselineDebug,
  userTraitScores,
  companion,
  season,
  visitedPlaces
}) {
  const visited = splitVisitedPlaces(visitedPlaces);
  const isVisited = (spot) => {
    if (!visited.length) return false;
    const text = spotTextFields(spot).join(" ");
    return visited.some(place => place && text.includes(place));
  };

  const baselineNeeds = extractBaselineNeeds(baselineDebug);
  const aPlaces = [
    ...(aRecommendations || []).map(item => item?.selectedSpot?.name || item?.place),
    ...getClusterPlaces(aClusterInfo).map(item => item.place)
  ].filter(Boolean);
  const aTokens = uniqueCompactItems([
    aClusterInfo?.name,
    aClusterInfo?.description,
    ...getClusterTraitTokens(aClusterInfo),
    ...aPlaces
  ], 40);
  const bTokens = uniqueCompactItems([
    baselineNeeds.summary,
    ...baselineNeeds.purposeTags,
    ...baselineNeeds.topTraits,
    ...baselineNeeds.matchedKeywords,
    ...baselineNeeds.themeTags
  ], 50);
  const rawCandidates = (SPOT_MASTER || [])
    .filter(spot => spot?.name && !isVisited(spot))
    .map(spot => {
      const selectedSpot = toSelectedSpot(spot);
      const spotType = inferSpotType(spot);
      const isMainCandidate = isMainTourismCandidate(spot);
      const aPlaceHits = aPlaces.reduce((sum, place) => sum + Math.max(placeSimilarity(spot.name, place), placeSimilarity(spot.primary_area, place)), 0);
      const aTokenHits = countSpotMatches(spot, aTokens);
      const bKeywordHits = countSpotMatches(spot, baselineNeeds.matchedKeywords);
      const bPurposeHits = countSpotMatches(spot, baselineNeeds.purposeTags);
      const bTraitMatch = getBClusterTraitSpotMatch(spot, baselineNeeds.traitScores);
      const bThemeHits = countSpotThemeMatches(spot, baselineNeeds.themeTags);
      const qualityRaw = Number(spot.quality_score) || 0;
      const penaltyRaw = Number(spot.main_recommendation_penalty) || 0;
      const aClusterRelatedScore = Math.min(aPlaceHits * 44 + aTokenHits * 8, 86);
      const conditionScore = getConditionScoreForSpot(spot, companion, season);
      const bKeywordMatchScore = Math.min(bKeywordHits * 18, 54);
      const bPurposeTagScore = Math.min(bPurposeHits * 24, 60);
      const bTraitSimilarityScore = bTraitMatch.score;
      const bThemeTagScore = Math.min(bThemeHits * 18, 54);
      const representativeBonus = getRepresentativeBonus(spot, spotType);
      const minorSpotPenalty = getMinorSpotPenalty(spot, spotType);
      const spotQualityScore =
        qualityRaw * 24 +
        (spot.is_core_tourism_spot === true ? 38 : -22) +
        getTourismTypeBoost(spotType) +
        representativeBonus -
        penaltyRaw * 42;
      const visitedPenalty = 0;
      const lowPriorityPenalty =
        (spot.is_low_priority_candidate ? 80 : 0) +
        (hasMainRecommendationBlockName(spot) ? 120 : 0) +
        (penaltyRaw > 0.5 ? 140 : 0) +
        (["transport", "facility", "other"].includes(spotType) ? 120 : 0) +
        (["shopping"].includes(spotType) ? 35 : 0) +
        minorSpotPenalty;
      const finalScore =
        aClusterRelatedScore +
        conditionScore +
        bKeywordMatchScore +
        bPurposeTagScore +
        bTraitSimilarityScore +
        bThemeTagScore +
        spotQualityScore +
        18 -
        visitedPenalty -
        lowPriorityPenalty;

      return {
        name: selectedSpot?.name || spot.name,
        area: selectedSpot?.area || spot.primary_area || "",
        image: selectedSpot?.image || "",
        url: selectedSpot?.url || "",
        description: selectedSpot?.description || "",
        selectedSpot,
        spot_type: spotType,
        is_main_tourism_candidate: isMainCandidate,
        purpose_tags: spot.purpose_tags || [],
        trait_tags: spot.trait_tags || [],
        recommendation_reason: buildIntegratedReasonText(spot, baselineNeeds, aClusterInfo),
        a_relationship: aClusterInfo?.name
          ? `A案の旅行者タイプ「${aClusterInfo.name}」の方向性と、地域・体験傾向が近い候補です。`
          : "A案で推定した旅行者タイプの上位候補と関連する候補です。",
        b_need_match: buildBNeedMatchText(spot, baselineNeeds),
        matched_a_cluster: {
          id: aClusterInfo?.id ?? null,
          name: aClusterInfo?.name || null,
          related_places: aPlaces.slice(0, 6)
        },
        matched_b_cluster: {
          ...(baselineNeeds.matchedCluster || {}),
          id: baselineNeeds.id,
          name: baselineNeeds.name,
          summary: baselineNeeds.summary,
          top_keywords: baselineNeeds.matchedKeywords,
          purpose_tags: baselineNeeds.purposeTags,
          trait_scores: baselineNeeds.traitScores,
          cluster_theme_tags: baselineNeeds.themeTags,
          source: baselineNeeds.source
        },
        recommendationDebug: {
          matched_b_source: baselineNeeds.source,
          a_cluster_related_score: Math.round(aClusterRelatedScore),
          condition_score: Math.round(conditionScore),
          b_keyword_match_score: Math.round(bKeywordMatchScore),
          b_purpose_tag_score: Math.round(bPurposeTagScore),
          b_trait_similarity_score: Math.round(bTraitSimilarityScore),
          b_trait_tag_score: Math.round(bTraitSimilarityScore),
          b_trait_matched_traits: bTraitMatch.matchedTraits,
          b_trait_matched_terms: bTraitMatch.matchedTerms,
          b_theme_tag_score: Math.round(bThemeTagScore),
          spot_quality_score: Math.round(spotQualityScore),
          representative_bonus: Math.round(representativeBonus),
          minor_spot_penalty: Math.round(minorSpotPenalty),
          diversity_score: 18,
          visited_penalty: visitedPenalty,
          low_priority_penalty: Math.round(lowPriorityPenalty),
          main_candidate: isMainCandidate,
          final_score: Math.round(finalScore)
        }
      };
    })
    .filter(candidate => {
      const debug = candidate.recommendationDebug;
      if (!candidate.is_main_tourism_candidate) return false;
      return debug.final_score > 20;
    })
    .sort((a, b) => b.recommendationDebug.final_score - a.recommendationDebug.final_score);

  const selected = [];
  const usedNames = new Set();
  const areaCounts = {};
  const typeCounts = {};
  rawCandidates.forEach(candidate => {
    if (selected.length >= 8) return;
    if (usedNames.has(candidate.name)) return;
    const areaKey = normalizePlaceName(candidate.selectedSpot?.area || candidate.area) || candidate.area || "unknown";
    const typeKey = candidate.spot_type || "unknown";
    const areaCount = areaCounts[areaKey] || 0;
    const typeCount = typeCounts[typeKey] || 0;
    if (areaCount >= 2) return;
    if (typeCount >= 2) return;
    let diversityScore = 18;
    if (areaCount >= 1) diversityScore -= 18;
    if (areaCount >= 2) diversityScore -= 45;
    if (typeCount >= 2) diversityScore -= 28;
    if (selected.some(item => placeSimilarity(item.name, candidate.name) > 0.82)) diversityScore -= 80;
    const adjustedFinal = candidate.recommendationDebug.final_score + diversityScore - 18;
    if (selected.length < 5 || adjustedFinal >= 65) {
      candidate.recommendationDebug.diversity_score = diversityScore;
      candidate.recommendationDebug.final_score = Math.round(adjustedFinal);
      selected.push(candidate);
      usedNames.add(candidate.name);
      areaCounts[areaKey] = areaCount + 1;
      typeCounts[typeKey] = typeCount + 1;
    }
  });

  if (selected.length < 5) {
    rawCandidates.forEach(candidate => {
      if (selected.length >= 5) return;
      if (usedNames.has(candidate.name)) return;
      if (!candidate.is_main_tourism_candidate) return;
      const areaKey = normalizePlaceName(candidate.selectedSpot?.area || candidate.area) || candidate.area || "unknown";
      const typeKey = candidate.spot_type || "unknown";
      if ((areaCounts[areaKey] || 0) >= 2) return;
      if ((typeCounts[typeKey] || 0) >= 2) return;
      selected.push(candidate);
      usedNames.add(candidate.name);
      areaCounts[areaKey] = (areaCounts[areaKey] || 0) + 1;
      typeCounts[typeKey] = (typeCounts[typeKey] || 0) + 1;
    });
  }

  const recommendations = selected
    .sort((a, b) => b.recommendationDebug.final_score - a.recommendationDebug.final_score)
    .slice(0, Math.min(8, Math.max(5, selected.length)));

  return {
    recommendations,
    matched_a_cluster: recommendations[0]?.matched_a_cluster || {
      id: aClusterInfo?.id ?? null,
      name: aClusterInfo?.name || null,
      related_places: aPlaces.slice(0, 6)
    },
    matched_b_cluster: recommendations[0]?.matched_b_cluster || {
      id: baselineNeeds.id,
      name: baselineNeeds.name,
      summary: baselineNeeds.summary,
      top_keywords: baselineNeeds.matchedKeywords,
      purpose_tags: baselineNeeds.purposeTags,
      trait_scores: baselineNeeds.traitScores,
      cluster_theme_tags: baselineNeeds.themeTags,
      source: baselineNeeds.source
    },
    integration_debug: {
      b_cluster_source: baselineNeeds.source,
      a_cluster_related_score: "A案の旅行者タイプ、上位訪問地、A案推薦との地域・語彙類似度を加点",
      b_keyword_match: "B clusterのsummary / purpose_tags / trait_scores / top_keywords / cluster_theme_tagsと景点情報の一致を加点",
      matched_b_source: baselineNeeds.source,
      condition_score: "同行者・季節別の既存重みと景点情報の一致を加点",
      diversity_score: "同一区域・同一spot_type・同名類似候補の重複を減点",
      main_filter: "観光案内所・ターミナル・駅・道の駅・ロゴオブジェ・ふれあい会館・まつり・イベント、transport/facility/other、penalty>0.5、low_priorityは主推薦から除外",
      diversity_rule: "Top5は同一primary_area最大2件、同一spot_type最大2件を目安に選択",
      candidate_count: recommendations.length,
      spot_master_count: Array.isArray(SPOT_MASTER) ? SPOT_MASTER.length : 0
    }
  };
}

function buildIntegratedReasonText(spot, baselineNeeds, aClusterInfo) {
  const spotType = String(spot?.spot_type || inferSpotType(spot)).toLowerCase();
  const aName = aClusterInfo?.name ? `A案の「${aClusterInfo.name}」` : "A案の旅行者タイプ";
  const aTokens = uniqueCompactItems([
    aClusterInfo?.description,
    ...getClusterTraitTokens(aClusterInfo)
  ], 12);
  const aMatches = collectSpotMatchedValues(spot, aTokens, 3);
  const bPurposes = uniqueCompactItems((spot?.purpose_tags || []).filter(tag => baselineNeeds.purposeTags.includes(tag)), 3);
  const bTraits = uniqueCompactItems((spot?.trait_tags || []).filter(tag => baselineNeeds.topTraits.includes(tag)), 3);
  const bKeywords = collectSpotMatchedValues(spot, baselineNeeds.matchedKeywords, 3);
  const bThemeHits = uniqueCompactItems(baselineNeeds.themeTags || [], 3).filter(themeTag => countSpotThemeMatches(spot, [themeTag]) > 0);
  const featureLabels = getSpotFeatureLabels(spot, 4);
  const typeLabel = getSpotTypeLabel(spotType);
  const bClusterName = baselineNeeds.name || "自由記述クラスタ";

  const reasonParts = [];
  if (featureLabels.length) reasonParts.push(`${featureLabels.join("・")}を持つ${typeLabel}`);
  else reasonParts.push(typeLabel);
  if (aMatches.length) reasonParts.push(`Aクラスタ側の「${aMatches.join("・")}」と近い`);
  if (baselineNeeds.source === "auto_need_clusters" && (bPurposes.length || bTraits.length || bKeywords.length || bThemeHits.length)) {
    reasonParts.push(`自由記述クラスタでは「${bClusterName}」が近く、「${uniqueCompactItems([...bKeywords, ...bPurposes, ...bTraits, ...bThemeHits], 4).join("・")}」への関心が見られる`);
  } else if (bPurposes.length || bTraits.length || bKeywords.length) {
    reasonParts.push(`Bクラスタ側の「${uniqueCompactItems([...bPurposes, ...bTraits, ...bKeywords], 4).join("・")}」にも対応`);
  }
  if (spot?.description) {
    const shortDescription = truncateJapaneseText(spot.description, 54);
    reasonParts.push(`内容面では「${shortDescription}」も判断材料になります`);
  }

  return `${spot?.name || "このスポット"}は、${reasonParts.join("、")}。これらを根拠に、${aName}を基盤にした統合推薦候補として適しています。`;
}

function buildBNeedMatchText(spot, baselineNeeds) {
  const purposeMatches = uniqueCompactItems((spot?.purpose_tags || []).filter(tag => baselineNeeds.purposeTags.includes(tag)), 4);
  const traitMatches = uniqueCompactItems((spot?.trait_tags || []).filter(tag => baselineNeeds.topTraits.includes(tag)), 4);
  const keywordMatches = collectSpotMatchedValues(spot, baselineNeeds.matchedKeywords, 4);
  const themeMatches = uniqueCompactItems(baselineNeeds.themeTags || [], 4).filter(themeTag => countSpotThemeMatches(spot, [themeTag]) > 0);
  const categoryMatches = collectSpotMatchedValues(spot, [...baselineNeeds.purposeTags, ...baselineNeeds.topTraits, ...baselineNeeds.matchedKeywords], 4)
    .filter(value => !purposeMatches.includes(value) && !traitMatches.includes(value) && !keywordMatches.includes(value));
  const details = [];
  if (keywordMatches.length) details.push(`matched_keywords「${keywordMatches.join("・")}」`);
  if (purposeMatches.length) details.push(`purpose_tags「${purposeMatches.join("・")}」`);
  if (traitMatches.length) details.push(`top_traits/trait_tags「${traitMatches.join("・")}」`);
  if (themeMatches.length) details.push(`cluster_theme_tags「${themeMatches.join("・")}」`);
  if (categoryMatches.length) details.push(`説明・カテゴリ内の「${categoryMatches.join("・")}」`);

  if (details.length) {
    if (baselineNeeds.source === "auto_need_clusters") {
      return `自由記述クラスタでは「${baselineNeeds.name || baselineNeeds.id}」が近く、${details.join("、")}がこのスポットの特徴と重なります。`;
    }
    return `Bクラスタとは、${details.join("、")}がこのスポットの特徴と重なります。`;
  }

  const featureLabels = getSpotFeatureLabels(spot, 3);
  if (baselineNeeds.source === "auto_need_clusters" && baselineNeeds.name) {
    return `自由記述クラスタでは「${baselineNeeds.name}」が近いが、この候補は移動利便性や自由記述ニーズとの直接一致よりも、A案の旅行者タイプとの適合性を優先して抽出しました。`;
  }
  if (baselineNeeds.summary && featureLabels.length) {
    return `Bクラスタとの直接的な一致は弱いが、${featureLabels.join("・")}という特徴を持つため、A案の旅行者タイプとの適合性を優先して補完候補として抽出しました。`;
  }
  return "Bクラスタとの直接的な一致は弱いが、A案の旅行者タイプとの適合性を優先して補完候補として抽出しました。";
}

function getBaselineRecommendationSpots() {
  const sources = [
    { path: "lastSummaryPayload.baseline_debug.recommendations", value: lastSummaryPayload?.baseline_debug?.recommendations },
    { path: "lastSummaryPayload.baseline_debug.recommended_spots", value: lastSummaryPayload?.baseline_debug?.recommended_spots },
    { path: "lastSummaryPayload.baseline_debug.baseline_recommendation.recommendations", value: lastSummaryPayload?.baseline_debug?.baseline_recommendation?.recommendations },
    { path: "lastSummaryPayload.baseline_debug.baseline_recommendation.recommended_spots", value: lastSummaryPayload?.baseline_debug?.baseline_recommendation?.recommended_spots },
    { path: "lastSummaryPayload.baseline_debug.recommendation", value: lastSummaryPayload?.baseline_debug?.recommendation },
    { path: "lastSummaryPayload.baseline_debug.result", value: lastSummaryPayload?.baseline_debug?.result },
    { path: "window.__AB_BASELINE_RECOMMENDATION__.recommendations", value: window.__AB_BASELINE_RECOMMENDATION__?.recommendations },
    { path: "window.__AB_BASELINE_RECOMMENDATION__.recommended_spots", value: window.__AB_BASELINE_RECOMMENDATION__?.recommended_spots },
    { path: "window.__AB_BASELINE_RECOMMENDATION__", value: window.__AB_BASELINE_RECOMMENDATION__ }
  ];

  for (const source of sources) {
    const spots = extractRecommendationArray(source.value);
    if (spots.length) return spots.slice(0, 3);
  }

  console.warn(
    "[AB Test] missing baseline recommendations at paths:",
    sources.map(source => source.path).join(", ")
  );
  return [];
}

function renderRecommendationPlanCards(planRecommendations, planLabel) {
  const displaySpots = (planRecommendations || []).slice(0, 3);
  if (!displaySpots.length) {
    return `<div class="ab-empty">推薦案を表示するデータがまだありません。</div>`;
  }

  return displaySpots.map((spot, index) => {
    const name = getSpotNameForAB(spot);
    const reason = getSpotReasonForAB(spot, planLabel);
    const image = getSpotImageForAB(spot);
    const link = getSpotLinkForAB(spot);
    return `
      <div class="ab-spot-card" aria-label="${escapeHtml(planLabel)} ${index + 1}">
        <div class="ab-spot-rank">${index + 1}</div>
        <div class="ab-spot-main">
          <div class="ab-spot-name">${escapeHtml(name)}</div>
          <div class="ab-spot-reason">${escapeHtml(reason)}</div>
          ${link ? `<a class="ab-spot-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">詳細を見る</a>` : ""}
        </div>
        ${image ? `<img class="ab-spot-thumb" src="${escapeHtml(image)}" alt="${escapeHtml(name)}" loading="lazy">` : ""}
      </div>
    `;
  }).join("");
}

function renderIntegratedRecommendationCards(recommendations) {
  const displaySpots = (recommendations || []).slice(0, 5);
  if (!displaySpots.length) {
    return `<div class="ab-empty">統合推薦の候補を生成できませんでした。</div>`;
  }

  return displaySpots.map((spot, index) => {
    const name = spot?.name || spot?.selectedSpot?.name || "名称未設定";
    const image = spot?.image || spot?.selectedSpot?.image || "";
    const area = spot?.area || spot?.selectedSpot?.area || "";
    const link = spot?.url || spot?.selectedSpot?.url || "";
    const reason = spot?.recommendation_reason || "A案とB案の補助情報を統合して抽出した候補です。";
    const aRelation = spot?.a_relationship || "A案の旅行者タイプと関連する候補です。";
    const bMatch = spot?.b_need_match || "Bクラスタの自由記述ニーズを補助的に参照しています。";
    return `
      <div class="integrated-spot-card">
        <div class="integrated-spot-rank">${index + 1}</div>
        ${image ? `<img class="integrated-spot-image" src="${escapeHtml(image)}" alt="${escapeHtml(name)}" loading="lazy">` : ""}
        <div class="integrated-spot-main">
          <div class="integrated-spot-name">${escapeHtml(name)}</div>
          <div class="integrated-spot-area">所属区域：${escapeHtml(area || "不明")}</div>
          <div class="integrated-spot-reason">${escapeHtml(reason)}</div>
          <div class="integrated-spot-note"><strong>A案との関係：</strong>${escapeHtml(aRelation)}</div>
          <div class="integrated-spot-note"><strong>Bクラスタ対応：</strong>${escapeHtml(bMatch)}</div>
          ${link ? `<a class="ab-spot-link" href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">詳細リンク</a>` : ""}
        </div>
      </div>
    `;
  }).join("");
}

function renderIntegratedRecommendationSection(recommendations) {
  document.getElementById("integratedRecommendationSection")?.remove();
  const spotsSection = document.getElementById("spotsList")?.closest(".section-card");
  if (!spotsSection) return;

  const section = document.createElement("div");
  section.id = "integratedRecommendationSection";
  section.className = "section-card integrated-recommendation-section";
  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon blue">統</div>
      <div>
        <h2>統合推薦（A案＋自由記述クラスタリング）</h2>
        <p>A案で推定した旅行者タイプを基盤とし、B案の自由記述クラスタリング結果に含まれる旅行ニーズを用いて推薦候補を再ランキングした結果です。</p>
      </div>
    </div>
    <div class="section-body">
      <div class="integrated-spot-list">${renderIntegratedRecommendationCards(recommendations)}</div>
      ${renderIntegratedEvaluationForm()}
      <div class="ab-local-ai-section integrated-ai-section">
        <h3>AI旅行プラン生成</h3>
        <p>統合推薦の候補をもとに、福井県内の現実的な1日旅行プランを生成します。</p>
        <button type="button" class="ab-save-btn ab-local-ai-btn" id="abLocalAIBtn">AI旅行プランを生成（ローカルAPI）</button>
        <p class="ab-save-explanation">生成されたAI旅行プランと統合推薦結果をまとめて保存できます。</p>
        <button type="button" class="ab-save-btn integrated-save-btn" id="integratedSaveBtn">統合推薦結果を保存</button>
        <button type="button" class="ab-save-btn" id="abSaveWithAIPlanBtn" disabled>統合推薦とAI旅行プランを保存</button>
        <div class="ab-local-ai-result" id="abLocalAIResult" aria-live="polite">生成結果がここに表示されます。</div>
      </div>
    </div>
  `;

  insertSectionAfter(section, spotsSection);
  document.getElementById("abLocalAIBtn")?.addEventListener("click", generateLocalAITravelPlan);
  document.getElementById("integratedSaveBtn")?.addEventListener("click", saveABEvaluationResult);
  document.getElementById("abSaveWithAIPlanBtn")?.addEventListener("click", saveABEvaluationResultWithAIPlan);
}

function renderABScoreRows(planKey) {
  return AB_EVALUATION_ITEMS.map(item => `
    <div class="ab-score-row">
      <div class="ab-score-label">${escapeHtml(item.label)}</div>
      <div class="ab-score-options" role="radiogroup" aria-label="${escapeHtml(item.label)}">
        ${[1, 2, 3, 4, 5].map(score => `
          <label>
            <input type="radio" name="ab_${planKey}_${item.key}" value="${score}">
            <span>${score}</span>
          </label>
        `).join("")}
      </div>
    </div>
  `).join("");
}

function renderIntegratedEvaluationForm() {
  return `
    <div class="ab-evaluation-form integrated-evaluation-form">
      <div class="ab-form-block">
        <h3>統合推薦の評価</h3>
        ${renderABScoreRows("integrated")}
      </div>
      <label class="ab-comment-label" for="integratedComment">コメント・気づいた点</label>
      <textarea id="integratedComment" class="ab-comment" rows="4"></textarea>
    </div>
  `;
}

function renderABTestComparisonSection(recommendedSpots) {
  lastLocalAIPlan = null;
  const spotsSection = document.getElementById("spotsList")?.closest(".section-card");
  if (!spotsSection) return;

  const plan1Spots = (recommendedSpots || []).slice(0, 3);
  const plan2Spots = getBaselineRecommendationSpots();
  console.log("[AB Test] plan1", plan1Spots);
  console.log("[AB Test] plan2", plan2Spots);
  window.__AB_TEST_PLAN1_SPOTS__ = plan1Spots;
  window.__AB_TEST_PLAN2_SPOTS__ = plan2Spots;

  const section = document.createElement("div");
  section.id = "abComparisonSection";
  section.className = "section-card ab-comparison-section";
  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon blue">比</div>
      <div>
        <h2>推薦結果の比較テスト</h2>
        <p>2つの推薦案を見比べて評価してください。</p>
      </div>
    </div>
    <div class="section-body">
      <div class="ab-plan-grid">
        <div class="ab-plan-block">
          <h3>推薦案1</h3>
          <div class="spots-list ab-spots-list">${renderRecommendationPlanCards(plan1Spots, "推薦案1")}</div>
        </div>
        <div class="ab-plan-block">
          <h3>推薦案2</h3>
          <div class="spots-list ab-spots-list">${renderRecommendationPlanCards(plan2Spots, "推薦案2")}</div>
        </div>
      </div>

      <div class="ab-evaluation-form">
        <div class="ab-form-grid">
          <div class="ab-form-block">
            <h3>推薦案1の評価</h3>
            ${renderABScoreRows("plan1")}
          </div>
          <div class="ab-form-block">
            <h3>推薦案2の評価</h3>
            ${renderABScoreRows("plan2")}
          </div>
        </div>

        <div class="ab-comparison-question">
          <h3>どちらの推薦案をより参考にしたいですか？</h3>
          <div class="ab-choice-options">
            <label><input type="radio" name="ab_comparison_choice" value="推薦案1"> 推薦案1</label>
            <label><input type="radio" name="ab_comparison_choice" value="推薦案2"> 推薦案2</label>
            <label><input type="radio" name="ab_comparison_choice" value="どちらとも言えない"> どちらとも言えない</label>
          </div>
        </div>

        <label class="ab-comment-label" for="abComment">コメント・気づいた点</label>
        <textarea id="abComment" class="ab-comment" rows="4"></textarea>

        <div class="ab-local-ai-section">
          <h3>ローカルAI旅行プラン生成</h3>
          <p>この機能は、ローカルAIサーバーが起動している場合のみ利用できます。</p>
          <button type="button" class="ab-save-btn ab-local-ai-btn" id="abLocalAIBtn">AI旅行プランを生成（ローカルAPI）</button>
          <p class="ab-save-explanation">推薦案1・推薦案2の評価結果と、生成されたAI旅行プランをまとめて保存します。</p>
          <button type="button" class="ab-save-btn" id="abSaveWithAIPlanBtn" disabled>評価結果とAI旅行プランを保存</button>
          <div class="ab-local-ai-result" id="abLocalAIResult" aria-live="polite">生成結果がここに表示されます。</div>
        </div>
      </div>
    </div>
  `;

  insertSectionAfter(section, spotsSection);
  document.getElementById("abLocalAIBtn")?.addEventListener("click", generateLocalAITravelPlan);
  document.getElementById("abSaveWithAIPlanBtn")?.addEventListener("click", saveABEvaluationResultWithAIPlan);
  renderIntegratedRecommendationSection(window.__INTEGRATED_RECOMMENDATIONS__ || []);
}

function collectABScores(planKey) {
  const scores = {};
  AB_EVALUATION_ITEMS.forEach(item => {
    const checked = document.querySelector(`input[name="ab_${planKey}_${item.key}"]:checked`);
    scores[item.key] = checked ? Number(checked.value) : null;
  });
  return scores;
}

function collectIntegratedEvaluationScores() {
  return {
    scores: collectABScores("integrated"),
    comment: document.getElementById("integratedComment")?.value?.trim() || ""
  };
}

function mirrorIntegratedSavePayloadForTesting(payload) {
  let el = document.getElementById("__integratedSavePayloadDebug");
  if (!el) {
    el = document.createElement("script");
    el.id = "__integratedSavePayloadDebug";
    el.type = "application/json";
    el.hidden = true;
    document.body.appendChild(el);
  }
  el.textContent = JSON.stringify(payload || {});
}

function collectABEvaluationResult() {
  const integratedRecommendations = window.__INTEGRATED_RECOMMENDATIONS__ || [];
  const profileContext = collectQuestionnaireProfileContext();
  const savedAt = new Date().toISOString();
  const payload = {
    questionnaire_answers: { ...answers },
    user_profile: profileContext.user_profile,
    psychological_profile: profileContext.psychological_profile,
    integrated_recommendations: integratedRecommendations.map(normalizeIntegratedRecommendationForExport),
    matched_a_cluster: lastSummaryPayload?.matched_a_cluster || lastSummaryPayload?.cluster || null,
    matched_b_cluster: lastSummaryPayload?.matched_b_cluster || lastSummaryPayload?.baseline_debug || null,
    integration_debug: lastSummaryPayload?.integration_debug || {
      a_cluster_related_score: "A cluster relation score",
      b_keyword_match: "B cluster keyword match",
      condition_score: "companion / season condition score",
      diversity_score: "area / type diversity score",
      main_filter: "low-priority transport/facility/event candidates are excluded from main recommendations"
    },
    integrated_evaluation_scores: collectIntegratedEvaluationScores(),
    legacy_ab_debug: {
      plan1_method: "A_handcrafted_matrix",
      plan2_method: "B_auto_clustering_baseline",
      plan1_recommendations: (window.__AB_TEST_PLAN1_SPOTS__ || []).slice(0, 3).map(normalizeABSpotForExport),
      plan2_recommendations: (window.__AB_TEST_PLAN2_SPOTS__ || []).slice(0, 3).map(normalizeABSpotForExport),
      baseline_debug: lastSummaryPayload?.baseline_debug || null
    },
    local_ai_plan: null,
    saved_at: savedAt
  };
  window.__LAST_INTEGRATED_SAVE_PAYLOAD__ = payload;
  mirrorIntegratedSavePayloadForTesting(payload);
  return payload;
}

function collectQuestionnaireProfileContext() {
  const traitScores = computeUserTraitScores(lastTagCounts || {});
  const psychologicalProfile = lastSummaryPayload?.psychological_profile || buildPsychologicalProfile(traitScores);
  return {
    questionnaire_answers: { ...answers },
    psychological_profile: psychologicalProfile,
    user_profile: lastSummaryPayload
      ? {
          cluster: lastSummaryPayload.cluster || null,
          companion: lastSummaryPayload.companion || window.userCompanion || null,
          season: lastSummaryPayload.season || window.userSeason || null,
          visited_before: lastSummaryPayload.visited_before ?? (window.userVisited === "yes"),
          visited_places: lastSummaryPayload.visited_places || window.userVisitedPlaces || null,
          tag_counts: { ...lastTagCounts },
          behavior_vector: Array.isArray(behaviorVector) ? [...behaviorVector] : [],
          trait_scores: traitScores,
          psychological_profile: psychologicalProfile
        }
      : null
  };
}

function collectABEvaluationWithAIPlanResult() {
  const integratedPayload = collectABEvaluationResult();
  return {
    questionnaire_answers: integratedPayload.questionnaire_answers || {},
    user_profile: integratedPayload.user_profile || null,
    psychological_profile: integratedPayload.psychological_profile || null,
    integrated_recommendations: integratedPayload.integrated_recommendations || [],
    matched_a_cluster: integratedPayload.matched_a_cluster || null,
    matched_b_cluster: integratedPayload.matched_b_cluster || null,
    integration_debug: integratedPayload.integration_debug || null,
    integrated_evaluation_scores: integratedPayload.integrated_evaluation_scores || null,
    legacy_ab_debug: integratedPayload.legacy_ab_debug || null,
    local_ai_plan: lastLocalAIPlan
      ? {
          ok: lastLocalAIPlan.ok === true,
          plan_markdown: lastLocalAIPlan.plan_markdown || "",
          model: lastLocalAIPlan.model || null,
          generated_at: lastLocalAIPlan.generated_at || null,
          source: "local_azure_openai"
        }
      : {
          ok: false,
          plan_markdown: "",
          model: null,
          generated_at: null,
          source: "local_azure_openai"
        },
    saved_at: integratedPayload.saved_at || new Date().toISOString()
  };
}

function saveABEvaluationResult() {
  const payload = collectABEvaluationResult();

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `integrated_recommendation_${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function saveABEvaluationResultWithAIPlan() {
  if (!lastLocalAIPlan?.ok) return;

  const payload = collectABEvaluationWithAIPlanResult();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  link.href = url;
  link.download = `integrated_recommendation_with_ai_plan_${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function generateLocalAITravelPlan() {
  const button = document.getElementById("abLocalAIBtn");
  const resultBox = document.getElementById("abLocalAIResult");
  const saveWithAIPlanButton = document.getElementById("abSaveWithAIPlanBtn");
  if (!button || !resultBox) return;

  const payload = {
    ...collectABEvaluationResult(),
    integrated_recommendations: window.__INTEGRATED_RECOMMENDATIONS__ || [],
    integration_debug: lastSummaryPayload?.integration_debug || null,
    internal_reference: {
      plan1_recommendations: (window.__AB_TEST_PLAN1_SPOTS__ || []).slice(0, 3).map(normalizeABSpotForExport),
      plan2_recommendations: (window.__AB_TEST_PLAN2_SPOTS__ || []).slice(0, 3).map(normalizeABSpotForExport)
    },
    research_context: {
      cluster: lastSummaryPayload?.cluster || null,
      matched_a_cluster: lastSummaryPayload?.matched_a_cluster || null,
      matched_b_cluster: lastSummaryPayload?.matched_b_cluster || null,
      integration_debug: lastSummaryPayload?.integration_debug || null,
      psychological_profile: lastSummaryPayload?.psychological_profile || null
    }
  };
  button.disabled = true;
  if (saveWithAIPlanButton) saveWithAIPlanButton.disabled = true;
  lastLocalAIPlan = null;
  resultBox.textContent = "AI旅行プランを生成しています…";

  try {
    const response = await fetch("http://localhost:8000/generate-plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) {
      throw new Error(data?.error || `ローカルAI APIエラー (${response.status})`);
    }
    lastLocalAIPlan = {
      ok: true,
      plan_markdown: data.plan_markdown || "",
      model: data.model || null,
      generated_at: data.generated_at || null
    };
    if (saveWithAIPlanButton) saveWithAIPlanButton.disabled = false;
    resultBox.textContent = data.plan_markdown || "旅行プラン本文が返されませんでした。";
  } catch (error) {
    const isConnectionError = error instanceof TypeError;
    resultBox.textContent = isConnectionError
      ? "ローカルAIサーバーが起動していません"
      : `AI旅行プランの生成に失敗しました: ${error.message}`;
  } finally {
    button.disabled = false;
  }
}

function getHotelReason(hotel, recommendedSpots) {
  return langText(
    '宿泊理由：推薦エリアと同一または関連するQR設置エリアに登録された宿泊施設から抽出しました。',
    '住宿理由：从与推荐区域相同或相关的QR设置区域中登记的住宿设施里抽出。'
  );
}


function insertSectionAfter(newEl, afterEl) {
  if (!afterEl || !afterEl.parentNode) return;
  const old = document.getElementById(newEl.id);
  if (old) old.remove();
  afterEl.parentNode.insertBefore(newEl, afterEl.nextSibling);
}

function calcTraitScores(tagCounts) {
  const groups = {
    plan: [
      'advance_planning',
      'plan_adherence',
      'control_orientation',
      'information_preparedness',
      'structure_preference',
      'risk_minimization'
    ],
    relax: [
      'schedule_density_low',
      'stay_based_travel',
      'pace_slow',
      'relaxation_focus',
      'stress_reduction_goal',
      'tranquility_seeking',
      'quality_priority'
    ],
    explore: [
      'spontaneity_level',
      'intuitive_exploration',
      'exploratory_behavior',
      'novelty_seeking',
      'experience_embrace',
      'experience_driven_choice',
      'local_culture_interest'
    ],
    food: [
      'consumption_experience',
      'cost_benefit_analysis',
      'value_seeking'
    ],
    nature: [
      'nature_preference',
      'nature_dominant_preference',
      'tranquility_seeking'
    ],
    efficiency: [
      'schedule_density_high',
      'multi_spot_hopping',
      'pace_fast',
      'efficiency_focus',
      'time_optimization',
      'coverage_maximization'
    ]
  };

  const labels = {
    plan: langText('計画性', '计划性'),
    relax: langText('リラックス志向', '放松倾向'),
    explore: langText('探索・体験志向', '探索/体验倾向'),
    food: langText('美食・価値志向', '美食/价值倾向'),
    nature: langText('自然志向', '自然倾向'),
    efficiency: langText('効率・周遊志向', '效率/多点游览倾向')
  };

  const rawItems = Object.entries(groups).map(([key, tags]) => {
    const raw = tags.reduce((sum, tag) => sum + (tagCounts[tag] || 0), 0);
    return { key, label: labels[key], raw };
  });

  const maxRaw = Math.max(...rawItems.map(item => item.raw), 1);

  return rawItems.map(item => {
    const ratio = item.raw / maxRaw;
    let level;
    let width;

    if (item.raw === 0) {
      level = langText('参考程度', '参考程度');
      width = 24;
    } else if (ratio >= 0.75) {
      level = langText('相対的に高い', '相对较高');
      width = 88;
    } else if (ratio >= 0.4) {
      level = langText('中程度', '中等');
      width = 58;
    } else {
      level = langText('やや低い', '略低');
      width = 38;
    }

    return { ...item, level, width };
  }).sort((a, b) => b.raw - a.raw);
}

function renderProfileAnalysis(tagCounts, clusterInfo, clusterIndex) {
  const section = document.createElement('div');
  section.id = 'profileAnalysisSection';
  section.className = 'section-card';

  const traits = calcTraitScores(tagCounts || {});

  const traitHtml = traits.map(t => `
    <div class="trait-card">
      <div class="trait-head">
        <span>${t.label}</span>
        <span class="trait-score">${t.level}</span>
      </div>
      <div class="trait-bar-bg">
        <div class="trait-bar" style="width:${t.width}%"></div>
      </div>
    </div>
  `).join('');

  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon blue">🧭</div>
      <div>
        <h2>${langText('旅行者画像分析', '旅行者画像分析')}</h2>
        <p>${langText('回答内容から旅行傾向を相対的に可視化します', '根据回答内容相对地可视化旅行倾向')}</p>
      </div>
    </div>

    <div class="section-body">
      <div class="profile-grid">${traitHtml}</div>

      <div class="profile-note">
        ${langText(
          `この画像は、12問の回答を心理・行動タグに変換し、福井観光データの旅行者クラスター（${clusterIndex ?? '-'}）と照合して作成した相対的な傾向です。心理尺度としての絶対値ではありません。`,
          `该画像由12道问卷回答转换为心理/行为标签，并与福井观光数据中的旅行者 cluster（${clusterIndex ?? '-'}）进行匹配后生成。它表示相对倾向，不是严格心理量表的绝对值。`
        )}
      </div>
    </div>
  `;

  insertSectionAfter(section, document.getElementById('clusterBadge'));
}
function renderProcessVisualization() {
  const section = document.createElement('div');
  section.id = 'processVisualizationSection';
  section.className = 'section-card';

  const steps = [
    {
      no: '01',
      titleJa: '12問の回答取得',
      titleZh: '获取12道问卷回答',
      descJa: 'ユーザーの旅行スタイルに関する回答を取得します。',
      descZh: '获取用户关于旅行风格的回答。'
    },
    {
      no: '02',
      titleJa: '心理・行動タグへの変換',
      titleZh: '转换为心理/行为标签',
      descJa: '各回答を旅行傾向を表す心理・行動タグに変換します。',
      descZh: '将每个回答转换为表示旅行倾向的心理/行为标签。'
    },
    {
      no: '03',
      titleJa: '53次元特徴量への変換',
      titleZh: '转换为53维特征量',
      descJa: 'タグ重みを用いて、観光行動を表す特徴量に変換します。',
      descZh: '利用标签权重，将其转换为表示观光行为的特征量。'
    },
    {
      no: '04',
      titleJa: '旅行者クラスターとの照合',
      titleZh: '与旅行者Cluster进行匹配',
      descJa: '特徴量ベクトルと既存クラスターを比較し、近い旅行者タイプを推定します。',
      descZh: '比较特征向量与既有Cluster，推定相近的旅行者类型。'
    },
    {
      no: '05',
      titleJa: '推薦傾向データの参照',
      titleZh: '参考推荐趋势数据',
      descJa: '同行者・旅行時期別の過去推薦傾向を参照します。',
      descZh: '参考同行者与旅行时期分类下的过去推荐趋势。'
    },
    {
      no: '06',
      titleJa: '推薦結果の提示',
      titleZh: '输出推荐结果',
      descJa: '推薦エリア、宿泊施設、AI旅行プランを提示します。',
      descZh: '输出推荐区域、住宿设施与AI旅行计划。'
    }
  ];

  const stepHtml = steps.map(step => `
    <div class="process-step">
      <div class="process-no">${step.no}</div>
      <div class="process-content">
        <div class="process-title">
          ${langText(step.titleJa, step.titleZh)}
        </div>
        <div class="process-desc">
          ${langText(step.descJa, step.descZh)}
        </div>
      </div>
    </div>
  `).join('');

  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon blue">🔎</div>
      <div>
        <h2>${langText('推薦プロセス', '推荐流程')}</h2>
        <p>${langText('本システムにおける推薦結果生成の流れ', '本系统生成推荐结果的处理流程')}</p>
      </div>
    </div>

    <div class="section-body">
      <div class="process-flow">
        ${stepHtml}
      </div>

      <div class="profile-note">
        ${langText(
          '本システムでは、AIに直接推薦を任せるのではなく、回答データ、旅行者タイプ、過去推薦傾向、宿泊施設データを段階的に組み合わせて推薦結果を生成します。',
          '本系统并不是直接把推荐交给AI生成，而是分阶段结合回答数据、旅行者类型、过去推荐趋势与住宿设施数据来生成推荐结果。'
        )}
      </div>
    </div>
  `;

  insertSectionAfter(section, document.getElementById('profileAnalysisSection'));
}

function renderDataBasis() {
  if (!DATA_SUMMARY) return;

  const section = document.createElement('div');
  section.id = 'dataBasisSection';
  section.className = 'section-card';

  const topSpots = (DATA_SUMMARY.top_spots || []).slice(0, 6)
    .map(s => `<span class="data-chip">${s.place}：${s.count}</span>`)
    .join('');

  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon orange">📊</div>
      <div>
        <h2>${langText('推薦に用いたデータ根拠', '推荐所使用的数据依据')}</h2>
        <p>${langText('2025年度の福井県観光AI推薦データを参照', '参考2025年度福井县观光AI推荐数据')}</p>
      </div>
    </div>

    <div class="section-body">
      <div class="data-kpis">
        <div class="data-kpi">
          <div class="data-kpi-value">${DATA_SUMMARY.record_count || '-'}</div>
          <div class="data-kpi-label">${langText('推薦ログ件数', '推荐记录数')}</div>
        </div>

        <div class="data-kpi">
          <div class="data-kpi-value">${DATA_SUMMARY.unique_user_count || '-'}</div>
          <div class="data-kpi-label">${langText('ユニークユーザー', '唯一用户数')}</div>
        </div>

        <div class="data-kpi">
          <div class="data-kpi-value">${(DATA_SUMMARY.top_spots || []).length}</div>
          <div class="data-kpi-label">${langText('主要推薦エリア', '主要推荐区域')}</div>
        </div>
      </div>

      <div class="data-top-list">${topSpots}</div>

      <div class="data-note">
        ${langText(
          '本データは2025年度の福井県観光AI推薦ログを集計したものです。今年度データが未整備のため、本研究では推薦傾向を把握するための基礎資料として用いています。',
          '本数据是对2025年度福井县观光AI推荐日志的汇总。由于今年度数据尚未整理，本研究将其作为把握推荐趋势的基础资料使用。'
        )}
      </div>
    </div>
  `;

  insertSectionAfter(section, document.getElementById('hotelSection'));
}
function setupResultDashboardUI() {
  const clusterBadge = document.getElementById("clusterBadge");
  const spotsSection = document.getElementById("spotsList")?.closest(".section-card");
  const hotelSection = document.getElementById("hotelSection");
  const aiSection = document.getElementById("aiResult")?.closest(".section-card");

  if (spotsSection) spotsSection.id = "spotsSection";
  if (aiSection) aiSection.id = "aiPlanSection";

  const oldTabs = document.getElementById("resultTabs");
  if (oldTabs) oldTabs.remove();

  const tabs = document.createElement("div");
  tabs.id = "resultTabs";
  tabs.className = "result-tabs";

  tabs.innerHTML = `
    <button class="result-tab active" data-tab="overview">
      <span class="tab-icon">🏆</span>
      <span>${langText("おすすめ", "推荐结果")}</span>
    </button>
    <button class="result-tab" data-tab="profile">
      <span class="tab-icon">🧭</span>
      <span>${langText("旅行者画像", "旅行者画像")}</span>
    </button>
    <button class="result-tab" data-tab="data">
      <span class="tab-icon">📊</span>
      <span>${langText("データ根拠", "数据依据")}</span>
    </button>
  `;

  if (clusterBadge && clusterBadge.parentNode) {
    clusterBadge.parentNode.insertBefore(tabs, clusterBadge.nextSibling);
  }

  tabs.querySelectorAll(".result-tab").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      tabs.querySelectorAll(".result-tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      setResultTab(tab);
    });
  });

  setResultTab("overview");
}

function setResultTab(tab) {
  const sectionGroups = {
    overview: ["integratedRecommendationSection"],
    profile: ["profileAnalysisSection", "processVisualizationSection"],
    data: ["dataBasisSection"]
  };

  const allSectionIds = [
    "spotsSection",
    "integratedRecommendationSection",
    "abComparisonSection",
    "hotelSection",
    "profileAnalysisSection",
    "processVisualizationSection",
    "dataBasisSection",
    "aiPlanSection"
  ];

  allSectionIds.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.add("tab-hidden");
    el.classList.remove("tab-active-section");
  });

  (sectionGroups[tab] || []).forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("tab-hidden");
    el.classList.add("tab-active-section");
  });

  const tabs = document.getElementById("resultTabs");
  if (tabs) {
    tabs.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[ch]));
}

function normalizeSpotName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/（[^）]*）|\([^)]*\)/g, '')
    .replace(/エリア/g, '')
    .replace(/[ \t\r\n　・･\-ー−_]/g, '')
    .replace(/(福井県|県|市|町|村|地区|地域|周辺|方面|観光|温泉郷|温泉)$/g, '')
    .trim();
}

function spotTextFields(masterSpot) {
  return [
    masterSpot.name,
    masterSpot.primary_area,
    ...(masterSpot.areas || []),
    ...(masterSpot.categories || []),
    ...(masterSpot.purpose_tags || []),
    ...(masterSpot.trait_tags || []),
    masterSpot.description
  ].filter(Boolean);
}

function getSpotQualityBoost(masterSpot) {
  const qualityScore = Number(masterSpot?.quality_score) || 0;
  const penalty = Number(masterSpot?.main_recommendation_penalty) || 0;
  const spotType = String(masterSpot?.spot_type || '').toLowerCase();
  let score = qualityScore * 4;

  if (masterSpot?.is_core_tourism_spot === true) score += 30;
  score -= penalty * 20;

  if (spotType === 'transport') score -= 45;
  else if (spotType === 'facility') score -= 35;
  else if (spotType) score += 8;

  if (masterSpot?.image) score += 8;
  if (masterSpot?.url || (masterSpot?.website || [])[0]) score += 5;
  if (masterSpot?.description) score += 4;

  return score;
}

function scoreSpotCandidate(masterSpot, areaRecommendation, target, targetParts) {
  const normalizedAreaNames = [masterSpot.primary_area, ...(masterSpot.areas || [])]
    .filter(Boolean)
    .map(normalizeSpotName)
    .filter(Boolean);
  const normalizedFields = spotTextFields(masterSpot).map(normalizeSpotName).filter(Boolean);
  const normalizedCategories = (masterSpot.categories || []).map(normalizeSpotName).filter(Boolean);
  const normalizedPurposeTags = (masterSpot.purpose_tags || []).map(normalizeSpotName).filter(Boolean);
  const normalizedTraitTags = (masterSpot.trait_tags || []).map(normalizeSpotName).filter(Boolean);

  let areaScore = 0;
  normalizedAreaNames.forEach(area => {
    if (!area || !target) return;
    if (area === target) areaScore = Math.max(areaScore, 60);
    else if (area.includes(target) || target.includes(area)) areaScore = Math.max(areaScore, 42);
    targetParts.forEach(part => {
      if (area.includes(part) || part.includes(area)) areaScore = Math.max(areaScore, 22);
    });
  });

  let textScore = 0;
  normalizedFields.forEach(field => {
    if (!field || !target) return;
    if (field === target) textScore += 24;
    else if (field.includes(target) || target.includes(field)) textScore += 12;
    targetParts.forEach(part => {
      if (field.includes(part) || part.includes(field)) textScore += 4;
    });
  });

  normalizedCategories.forEach(category => {
    if (targetParts.some(part => category.includes(part) || part.includes(category))) textScore += 3;
  });
  normalizedPurposeTags.forEach(tag => {
    if (targetParts.some(part => tag.includes(part) || part.includes(tag))) textScore += 4;
  });
  normalizedTraitTags.forEach(tag => {
    if (targetParts.some(part => tag.includes(part) || part.includes(tag))) textScore += 4;
  });

  const recommendationScore = Number(areaRecommendation?.score) || 0;
  const score = areaScore + textScore + getSpotQualityBoost(masterSpot) + Math.min(recommendationScore / 10, 8);

  return {
    spot: masterSpot,
    score,
    areaScore,
    textScore,
    isTransportOrFacility: ['transport', 'facility'].includes(String(masterSpot?.spot_type || '').toLowerCase())
  };
}

function toSelectedSpot(masterSpot) {
  if (!masterSpot) return null;
  const area = masterSpot.primary_area || (masterSpot.areas || []).join('、') || '';
  const inferredType = inferSpotType(masterSpot);
  return {
    name: masterSpot.name || '',
    area,
    category: (masterSpot.categories || [])[0] || '',
    image: masterSpot.image || '',
    url: masterSpot.url || (masterSpot.website || [])[0] || '',
    description: masterSpot.description || '',
    lat: masterSpot.lat ?? null,
    lng: masterSpot.lng ?? null,
    purpose_tags: masterSpot.purpose_tags || [],
    trait_tags: masterSpot.trait_tags || [],
    spot_type: inferredType,
    quality_score: Number(masterSpot.quality_score) || 0,
    is_core_tourism_spot: masterSpot.is_core_tourism_spot === true,
    main_recommendation_penalty: Number(masterSpot.main_recommendation_penalty) || 0
  };
}

function findSpotFromMaster(areaRecommendation, usedSpotNames = new Set()) {
  if (!Array.isArray(SPOT_MASTER) || SPOT_MASTER.length === 0 || !areaRecommendation?.place) {
    return null;
  }

  const target = normalizeSpotName(areaRecommendation.place);
  const availableSpots = SPOT_MASTER.filter(s => s?.name && !usedSpotNames.has(s.name));

  const targetParts = String(areaRecommendation.place || '')
    .split(/[、,・･\s　/]+/)
    .map(normalizeSpotName)
    .filter(part => part.length >= 2);

  const scoredCandidates = availableSpots
    .map(s => scoreSpotCandidate(s, areaRecommendation, target, targetParts))
    .filter(candidate => candidate.areaScore > 0 || candidate.textScore > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredCandidates.length === 0) return null;

  return scoredCandidates[0].spot;
}

function attachSelectedSpots(recommendedSpots) {
  const usedSpotNames = new Set();
  return (recommendedSpots || []).map(areaRecommendation => {
    const masterSpot = findSpotFromMaster(areaRecommendation, usedSpotNames);
    const selectedSpot = toSelectedSpot(masterSpot) || {
      name: areaRecommendation.place || '',
      area: areaRecommendation.place || '',
      category: '',
      image: '',
      url: '',
      description: '',
      lat: null,
      lng: null,
      purpose_tags: [],
      trait_tags: [],
      spot_type: '',
      quality_score: 0,
      is_core_tourism_spot: false,
      main_recommendation_penalty: 0
    };

    if (selectedSpot.name) usedSpotNames.add(selectedSpot.name);
    return { ...areaRecommendation, selectedSpot };
  });
}

// ===== 6. 景点筛选逻辑 =====
// 优先级：同行者×季节 > 同行者 > 季节 > Cluster Top3（兜底）
function normalizePlaceName(value) {
  return normalizeSpotName(value)
    .replace(/(駅|空港|バス停|駐車場|案内所|センター|施設|交通)$/g, '')
    .trim();
}

function getClusterPlaces(clusterInfo) {
  if (!clusterInfo || !Array.isArray(clusterInfo.top_places)) return [];
  return clusterInfo.top_places
    .filter(p => p?.place)
    .map((p, index) => ({
      place: p.place,
      normalized: normalizePlaceName(p.place),
      users: Number(p.users) || 0,
      rank: index + 1
    }))
    .filter(p => p.normalized);
}

function placeSimilarity(placeA, placeB) {
  const a = normalizePlaceName(placeA);
  const b = normalizePlaceName(placeB);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.86;

  const splitParts = value => String(value || '')
    .split(/[、,・･\s　/]+/)
    .map(normalizePlaceName)
    .filter(part => part.length >= 2);
  const partsA = splitParts(placeA);
  const partsB = splitParts(placeB);
  if (!partsA.length || !partsB.length) return 0;

  const matches = partsA.filter(aPart =>
    partsB.some(bPart => aPart === bPart || aPart.includes(bPart) || bPart.includes(aPart))
  ).length;

  return matches / Math.max(partsA.length, partsB.length);
}

function getCandidateMasterSpot(candidate) {
  return findSpotFromMaster(candidate, new Set());
}

function getPlaceAreaTokens(place) {
  const normalized = normalizePlaceName(place);
  const compact = String(normalized || '').replace(/(エリア|地域|方面|周辺)$/g, '');
  return String(compact || '')
    .split(/[、,・･\s　/]+/)
    .map(normalizePlaceName)
    .filter(part => part.length >= 2);
}

function getClusterTraitTokens(clusterInfo) {
  if (!clusterInfo) return [];
  const values = [
    clusterInfo.name,
    clusterInfo.description,
    ...(clusterInfo.tags || []),
    ...(clusterInfo.keywords || [])
  ];
  return values
    .flatMap(value => String(value || '').split(/[、,，.。・･\s　/]+/))
    .map(normalizePlaceName)
    .filter(token => token.length >= 2);
}

function scoreRecommendationCandidate(candidate, context) {
  const clusterPlaces = context.clusterPlaces || [];
  const normalizedPlace = normalizePlaceName(candidate.place);
  const masterSpot = candidate.masterSpot || getCandidateMasterSpot(candidate);
  const selectedSpot = toSelectedSpot(masterSpot);
  const candidateAreaTokens = [
    ...getPlaceAreaTokens(candidate.place),
    ...getPlaceAreaTokens(selectedSpot?.area)
  ];
  const clusterAreaTokens = clusterPlaces.flatMap(p => getPlaceAreaTokens(p.place));
  const clusterTraitTokens = context.clusterTraitTokens || [];
  const spotTagTokens = [
    ...(selectedSpot?.purpose_tags || []),
    ...(selectedSpot?.trait_tags || [])
  ].map(normalizePlaceName).filter(Boolean);

  let bestClusterSimilarity = 0;
  clusterPlaces.forEach(clusterPlace => {
    const similarity = placeSimilarity(candidate.place, clusterPlace.place);
    if (similarity > bestClusterSimilarity) {
      bestClusterSimilarity = similarity;
    }
  });

  const sameAreaHits = candidateAreaTokens.filter(token =>
    clusterAreaTokens.some(clusterToken =>
      token === clusterToken || token.includes(clusterToken) || clusterToken.includes(token)
    )
  ).length;
  const areaScore = Math.min(sameAreaHits * 18, 36);

  const tagMatches = spotTagTokens.filter(tag =>
    clusterTraitTokens.some(token =>
      tag === token || tag.includes(token) || token.includes(tag)
    )
  ).length;
  const traitScore = Math.min(tagMatches * 14, 42);

  const qualityRaw = Number(selectedSpot?.quality_score) || 0;
  const penalty = Number(selectedSpot?.main_recommendation_penalty) || 0;
  const qualityScore =
    qualityRaw * 8 +
    (selectedSpot?.is_core_tourism_spot ? 42 : 0) -
    penalty * 35 +
    (selectedSpot?.image ? 7 : 0) +
    (selectedSpot?.url ? 5 : 0) +
    (selectedSpot?.description ? 4 : 0);

  const companionSeasonScore = Number(candidate.companionSeasonScore ?? candidate.baseScore ?? candidate.score) || 0;
  let diversityScore = 24;
  (context.selectedRecommendations || []).forEach(selected => {
    const similarity = placeSimilarity(candidate.place, selected.place);
    if (similarity >= 0.86) diversityScore -= 80;
    else if (similarity >= 0.5) diversityScore -= 32;
  });
  if (selectedSpot?.name && context.usedSpotNames?.has(selectedSpot.name)) diversityScore -= 90;
  if (context.usedPlaceKeys?.has(normalizedPlace)) diversityScore -= 90;

  const globalCommonScore = candidate.globalRank
    ? Math.max(0, 28 - candidate.globalRank * 2)
    : Math.min((Number(candidate.globalCount) || 0) / 6, 22);
  const nonGlobalDiscoveryBoost = candidate.category === 'discovery' && !context.globalTopFiveKeys?.has(normalizedPlace) ? 24 : 0;
  const clusterScore = bestClusterSimilarity * 145 + areaScore;
  const finalScore =
    clusterScore +
    Math.min(companionSeasonScore, 80) +
    qualityScore +
    traitScore +
    diversityScore +
    globalCommonScore +
    nonGlobalDiscoveryBoost;

  return {
    ...candidate,
    masterSpot,
    selectedSpot,
    score: Math.round(finalScore),
    recommendationDebug: {
      clusterScore: Math.round(clusterScore),
      companionSeasonScore: Math.round(companionSeasonScore),
      qualityScore: Math.round(qualityScore + traitScore),
      diversityScore: Math.round(diversityScore),
      finalScore: Math.round(finalScore)
    }
  };
}

function getRecommendedSpots(clusterInfo, companion, season, visitedPlaces) {
  const visited = visitedPlaces
    ? visitedPlaces.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)
    : [];

  const isVisited = (place) => {
    if (!visited.length) return false;
    return visited.some(v => place.includes(v) || (v.length > 1 && place.includes(v)));
  };

  const used = new Set();
  const usedKey = place => normalizePlaceName(place) || String(place || '').trim();
  const isUsed = place => used.has(usedKey(place));
  const markUsed = place => used.add(usedKey(place));
  const clusterPlaces = getClusterPlaces(clusterInfo);
  const usedSpotNames = new Set();
  const selectedRecommendations = [];
  const selectBestCandidate = (candidates, options = {}) => {
    const scored = candidates
      .filter(s => s?.place && !isVisited(s.place))
      .map(s => scoreRecommendationCandidate(s, {
        clusterInfo,
        clusterPlaces,
        clusterTraitTokens: getClusterTraitTokens(clusterInfo),
        globalTopFiveKeys,
        selectedRecommendations,
        usedPlaceKeys: used,
        usedSpotNames
      }))
      .filter(s => {
        if (isUsed(s.place)) return false;
        if (s.selectedSpot?.name && usedSpotNames.has(s.selectedSpot.name)) return false;
        if (options.requireClusterRelated && s.recommendationDebug.clusterScore < 45) return false;
        return true;
      })
      .sort((a, b) => b.recommendationDebug.finalScore - a.recommendationDebug.finalScore);

    const selected = scored[0] || null;
    if (selected) {
      markUsed(selected.place);
      if (selected.selectedSpot?.name) usedSpotNames.add(selected.selectedSpot.name);
      selectedRecommendations.push(selected);
    }
    return selected;
  };

  // 1. 定番推薦：2025年度推薦ログ全体で高頻度のスポット
  const globalTop = (DATA_SUMMARY?.top_spots || [])
    .filter(s => s && s.place && !isVisited(s.place));
  const globalTopFiveKeys = new Set(globalTop.slice(0, 5).map(s => usedKey(s.place)));

  const makeClassicCandidate = (s, index) => ({
    place: s.place,
    score: s.count || 0,
    globalRank: index + 1,
    source: 'global',
    category: 'classic',
    categoryJa: '定番推薦',
    categoryZh: '经典推荐'
  });

  const classicGlobalPool = globalTop.slice(0, 18).map(makeClassicCandidate);
  let classic = selectBestCandidate(classicGlobalPool, { requireClusterRelated: true });

  if (!classic) {
    classic = selectBestCandidate(globalTop.map(makeClassicCandidate));
  }

  // 2. 個性化推薦：同行者×季節、同行者、季節の推薦傾向
  const keys = [];
  if (companion && season) keys.push(`${companion}×${season}`);
  if (companion) keys.push(`companion:${companion}`);
  if (season) keys.push(`season:${season}`);

  const scoreMap = {};
  keys.forEach((key, priority) => {
    const spots = SPOT_WEIGHTS[key] || [];
    spots.forEach(s => {
      if (!s.place || isVisited(s.place)) return;
      if (!scoreMap[s.place]) scoreMap[s.place] = 0;
      scoreMap[s.place] += s.score * (3 - priority);
    });
  });

  const personalizedCandidates = Object.entries(scoreMap)
    .map(([place, score]) => ({
      place,
      score: Math.round(score),
      baseScore: Math.round(score),
      companionSeasonScore: Math.round(score),
      source: 'data',
      category: 'personalized',
      categoryJa: '個性化推薦',
      categoryZh: '个性化推荐'
    }))
    .sort((a, b) => b.companionSeasonScore - a.companionSeasonScore);

  const personalized = selectBestCandidate(personalizedCandidates);

  // 3. 発見推薦：人気上位に偏りすぎないよう、クラスター候補や中位候補から補完
  const discoveryCandidates = [];

  // Cluster由来の候補
  clusterPlaces
    .filter(p => !globalTopFiveKeys.has(usedKey(p.place)))
    .concat(clusterPlaces.filter(p => globalTopFiveKeys.has(usedKey(p.place))))
    .forEach(p => {
      if (!p.place || isVisited(p.place)) return;
      discoveryCandidates.push({
        place: p.place,
        score: p.users || 0,
        baseScore: p.users || 0,
        companionSeasonScore: p.users || 0,
        clusterRank: p.rank,
        source: 'cluster',
        category: 'discovery',
        categoryJa: '発見推薦',
        categoryZh: '发现推荐'
      });
    });

  // 条件別推薦の下位候補も発見候補に使う
  personalizedCandidates.slice(2, 8).forEach(p => {
    discoveryCandidates.push({
      ...p,
      category: 'discovery',
      categoryJa: '発見推薦',
      categoryZh: '发现推荐'
    });
  });

  // 全体高頻度の中位候補も発見候補に使う
  globalTop.slice(5, 12).forEach(s => {
    discoveryCandidates.push({
      place: s.place,
      score: s.count || 0,
      baseScore: s.count || 0,
      companionSeasonScore: 0,
      globalCount: s.count || 0,
      source: 'global_mid',
      category: 'discovery',
      categoryJa: '発見推薦',
      categoryZh: '发现推荐'
    });
  });

  const discovery = selectBestCandidate(discoveryCandidates);

  // 兜底：如果某一类缺失，就从已有候选中补齐
  const result = [];

  if (classic) result.push(classic);
  if (personalized) result.push(personalized);
  if (discovery) result.push(discovery);

  const fallbackCandidates = [
    ...personalizedCandidates,
    ...globalTop.map(makeClassicCandidate),
    ...discoveryCandidates
  ];

  while (result.length < 3) {
    const fallback = selectBestCandidate(fallbackCandidates);
    if (!fallback) break;
    result.push(fallback);
  }

  return result.slice(0, 3);
}

// ===== 7. 住宿匹配 =====
function getRecommendedHotels(recommendedSpots) {
  if (!HOTELS || HOTELS.length === 0) return [];

  const areaKeywords = recommendedSpots.map(s =>
    s.place.replace(/ エリア$/, '').replace(/エリア$/, '').replace(/道の駅「.*?」/, '道の駅').trim()
  );

  const matched = [];
  const seen = new Set();

  areaKeywords.forEach(kw => {
    HOTELS.forEach(h => {
      if (seen.has(h.name)) return;
      const areaClean = (h.area || '').replace(/（.*?）/, '').replace(/エリア$/, '').trim();
      if (areaClean.includes(kw) || kw.includes(areaClean)) {
        matched.push(h);
        seen.add(h.name);
      }
    });
  });

  if (matched.length < 3) {
    HOTELS.forEach(h => {
      if (seen.has(h.name)) return;
      if ((h.area || '').includes('あわら')) {
        matched.push(h);
        seen.add(h.name);
      }
    });
  }

  return matched;
}

// ===== 8. 心理标签计数 =====
function calcTagCounts() {
  const counts = {};

  for (const qid in answers) {
    const optKey = `option_${answers[qid]}`;
    const mapping = Q2PSYCH[qid];
    if (!mapping) continue;

    (mapping[optKey] || []).forEach(tag => {
      counts[tag] = (counts[tag] || 0) + 1;
    });
  }

  return counts;
}

// ===== 9. 53维行为向量 =====
function isPostTripEvaluationField(field) {
  const name = String(field || '');
  return [
    'NPS',
    '満足度',
    '満足度の理由',
    '今後の来訪意向',
    '不便さ',
    '不便さの内容',
    'エリア訪問回数',
    '婧€瓒冲害',
    '婧€瓒冲害銇悊鐢?',
    '浠婂緦銇潵瑷剰鍚?',
    '涓嶄究',
    '銈ㄣ儶銈㈣í鍟忓洖鏁?'
  ].some(keyword => name.includes(keyword));
}

function getNumericClusterFields() {
  const clusterKeys = Object.keys(CLUSTERS || {});
  if (!clusterKeys.length) return [];
  const fieldSet = new Set();
  clusterKeys.forEach(key => {
    const cluster = CLUSTERS[key];
    if (!cluster || typeof cluster !== 'object') return;
    Object.entries(cluster).forEach(([field, value]) => {
      if (typeof value === "number" && !Number.isNaN(value)) fieldSet.add(field);
    });
  });
  return Array.from(fieldSet);
}

function getGeneratedBehaviorFields() {
  const fields = new Set();
  Object.values(TAG_WEIGHTS || {}).forEach(weightDef => {
    if (!weightDef || typeof weightDef !== 'object') return;
    Object.entries(weightDef).forEach(([field, value]) => {
      if (typeof value === "number" && !Number.isNaN(value)) fields.add(field);
    });
  });
  return Array.from(fields);
}

function getClassificationFeatureKeys() {
  const clusterFields = new Set(getNumericClusterFields());
  return getGeneratedBehaviorFields()
    .filter(field => clusterFields.has(field))
    .filter(field => !isPostTripEvaluationField(field))
    .sort();
}

function getIgnoredClusterFields(classificationFeatureKeys = getClassificationFeatureKeys()) {
  const valid = new Set(classificationFeatureKeys);
  return getNumericClusterFields()
    .filter(field => !valid.has(field))
    .sort();
}

function calcBehaviorVectorFromWeights(tagCounts) {
  const featureKeys = getClassificationFeatureKeys();
  const vec = {};
  featureKeys.forEach(field => {
    vec[field] = 0;
  });

  for (const tag in tagCounts) {
    const count = tagCounts[tag];
    const weightDef = TAG_WEIGHTS[tag];
    if (!weightDef) continue;

    for (const field in weightDef) {
      if (Object.prototype.hasOwnProperty.call(vec, field)) {
        vec[field] += count * weightDef[field];
      }
    }
  }

  return vec;
}

const TRAVEL_TRAIT_KEYS = [
  'planning',
  'relaxation',
  'exploration_experience',
  'food_value',
  'nature',
  'efficiency_touring'
];

const TAG_TRAIT_KEYWORDS = {
  planning: [
    'planning',
    'plan_',
    'preparedness',
    'structure',
    'control',
    'official_info',
    'information',
    'validation',
    'logical',
    'risk_minimization',
    'risk_awareness'
  ],
  relaxation: [
    'relaxation',
    'stress',
    'slow',
    'stay_based',
    'tranquility',
    'privacy',
    'quality_priority',
    'presence_focus',
    'subjective_satisfaction',
    'low_control'
  ],
  exploration_experience: [
    'experience',
    'explor',
    'novelty',
    'local_culture',
    'activity',
    'spontaneity',
    'uncertainty',
    'intuition',
    'emotion',
    'opportunistic',
    'situational'
  ],
  food_value: [
    'consumption',
    'cost',
    'value',
    'budget',
    'price',
    'spending',
    'willingness_to_pay',
    'cost_benefit'
  ],
  nature: [
    'nature',
    'outdoor',
    'tranquility_seeking',
    'mixed_environment'
  ],
  efficiency_touring: [
    'schedule_density_high',
    'multi_spot',
    'pace_fast',
    'efficiency',
    'time_optimization',
    'coverage',
    'hopping'
  ]
};

function computeUserTraitScores(tagCounts) {
  const rawScores = {};
  TRAVEL_TRAIT_KEYS.forEach(trait => {
    rawScores[trait] = 0;
  });

  Object.entries(tagCounts || {}).forEach(([tag, count]) => {
    const normalizedTag = String(tag || '').toLowerCase();
    TRAVEL_TRAIT_KEYS.forEach(trait => {
      const hitCount = (TAG_TRAIT_KEYWORDS[trait] || [])
        .filter(keyword => normalizedTag.includes(keyword))
        .length;
      if (hitCount > 0) rawScores[trait] += count * hitCount;
    });
  });

  const maxScore = Math.max(...TRAVEL_TRAIT_KEYS.map(trait => rawScores[trait]), 0);
  const traitScores = {};
  TRAVEL_TRAIT_KEYS.forEach(trait => {
    traitScores[trait] = maxScore > 0 ? rawScores[trait] / maxScore : 0;
  });
  return traitScores;
}

function normalizeTraitScoreValue(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function getPsychologicalTraitLabelJa(key) {
  const labels = {
    planning: "計画性",
    relaxation: "リラックス志向",
    food_value: "美食・価値志向",
    nature: "自然志向",
    exploration_experience: "探索・体験志向",
    efficiency_touring: "効率・周遊志向"
  };
  return labels[key] || key;
}

function getPsychologicalTraitLevelJa(score) {
  const value = normalizeTraitScoreValue(score);
  if (value >= 0.7) return "高い";
  if (value >= 0.4) return "中程度";
  return "低い";
}

function buildPsychologicalProfileText(userTraitScores = {}) {
  return TRAVEL_TRAIT_KEYS
    .map(key => ({
      key,
      label: getPsychologicalTraitLabelJa(key),
      score: normalizeTraitScoreValue(userTraitScores[key])
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(item => `${item.label}が${getPsychologicalTraitLevelJa(item.score)}（${item.score.toFixed(2)}）`)
    .join("、");
}

function buildPsychologicalPlanInstruction(userTraitScores = {}) {
  const instructions = [];

  const planning = normalizeTraitScoreValue(userTraitScores.planning);
  const relaxation = normalizeTraitScoreValue(userTraitScores.relaxation);
  const foodValue = normalizeTraitScoreValue(userTraitScores.food_value);
  const nature = normalizeTraitScoreValue(userTraitScores.nature);
  const exploration = normalizeTraitScoreValue(userTraitScores.exploration_experience);
  const efficiency = normalizeTraitScoreValue(userTraitScores.efficiency_touring);

  if (planning >= 0.6) {
    instructions.push("計画性が高いため、時間配分、移動順序、滞在時間を明確にしてください。");
  }

  if (relaxation >= 0.6) {
    instructions.push("リラックス志向が高いため、移動を詰め込みすぎず、温泉・休憩・ゆったりした滞在を重視してください。");
  }

  if (foodValue >= 0.6) {
    instructions.push("美食・価値志向が高いため、越前そば、海鮮、地元名物、食事体験を重視してください。");
  }

  if (nature >= 0.6) {
    instructions.push("自然志向が高いため、海・山・湖・景色など自然を楽しめる場所を優先してください。");
  }

  if (exploration >= 0.6) {
    instructions.push("探索・体験志向が高いため、博物館、体験施設、まち歩き、学びの要素を含めてください。");
  }

  if (efficiency >= 0.6) {
    instructions.push("効率・周遊志向が高いため、移動効率を考慮し、複数スポットを無理なく回れる順序にしてください。");
  }

  if (!instructions.length) {
    instructions.push("ユーザーの心理・旅行傾向を参考にし、推薦理由と行程順序に自然に反映してください。");
  }

  return instructions.join("\n");
}

function buildPsychologicalProfile(userTraitScores = {}) {
  return {
    trait_scores: { ...(userTraitScores || {}) },
    profile_text: buildPsychologicalProfileText(userTraitScores),
    plan_instruction: buildPsychologicalPlanInstruction(userTraitScores)
  };
}

function getClusterTraitProfileMap() {
  const map = {};
  const profiles = Array.isArray(CLUSTER_TRAIT_PROFILES?.clusters)
    ? CLUSTER_TRAIT_PROFILES.clusters
    : [];
  profiles.forEach(profile => {
    if (profile?.cluster_id) map[profile.cluster_id] = profile;
  });
  return map;
}

function traitSimilarity(userTraitScores, clusterTraitScores) {
  const userVals = TRAVEL_TRAIT_KEYS.map(trait => userTraitScores?.[trait] || 0);
  const clusterVals = TRAVEL_TRAIT_KEYS.map(trait => clusterTraitScores?.[trait] || 0);
  return cosineSimilarity(userVals, clusterVals);
}

const SPOT_TRAIT_MATCH_KEYWORDS = {
  planning: ["計画", "情報", "案内", "安心", "分かりやすさ", "旅行計画"],
  relaxation: ["リラックス志向", "温泉", "露天風呂", "宿", "のんびり", "癒し"],
  food_value: ["美食・価値志向", "地元の美味しいものを食べる", "そば", "蕎麦", "海鮮", "カニ", "料理"],
  nature: ["自然志向", "自然鑑賞", "海", "山", "湖", "景色", "公園", "滝"],
  exploration_experience: ["探索・体験志向", "各種体験", "テーマパーク", "博物館", "資料館", "体験", "歴史", "文化"],
  efficiency_touring: ["効率・周遊志向", "ドライブ", "ツーリング", "アクセス", "駐車場", "移動", "交通"]
};

function getHighBClusterTraits(traitScores, limit = 3, threshold = 0.15) {
  const sortedTraits = TRAVEL_TRAIT_KEYS
    .map(trait => ({ trait, score: Number(traitScores?.[trait]) || 0 }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const highTraits = sortedTraits.filter(item => item.score > threshold);
  return (highTraits.length ? highTraits : sortedTraits)
    .slice(0, limit)
    .map(item => item.trait);
}

function getBClusterTraitSpotMatch(masterSpot, traitScores) {
  const targetTraits = getHighBClusterTraits(traitScores);
  const haystack = [
    ...spotTextFields(masterSpot),
    masterSpot?.spot_type || inferSpotType(masterSpot)
  ].join(" ").toLowerCase();
  const matchedTraits = [];
  const matchedTerms = [];

  targetTraits.forEach(trait => {
    const terms = (SPOT_TRAIT_MATCH_KEYWORDS[trait] || [])
      .filter(term => {
        const needle = String(term || "").trim().toLowerCase();
        return needle && haystack.includes(needle);
      });
    if (terms.length) {
      matchedTraits.push(trait);
      matchedTerms.push(...terms);
    }
  });

  return {
    score: Math.min(matchedTraits.length * 14, 42),
    matchedTraits: uniqueCompactItems(matchedTraits, 6),
    matchedTerms: uniqueCompactItems(matchedTerms, 12)
  };
}

// ===== 10. 余弦相似度 =====
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;

  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }

  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ===== 11. 找最近Cluster =====
function findBestCluster(realVec, tagCounts = lastTagCounts) {
  const featureKeys = getClassificationFeatureKeys();
  if (!CLUSTERS || !featureKeys.length || !realVec) return null;

  let best = null;
  let bestScore = -Infinity;
  const similarities = [];
  const realVals = featureKeys.map(field => realVec[field] || 0);
  const userTraitScores = computeUserTraitScores(tagCounts || {});
  const traitProfilesByCluster = getClusterTraitProfileMap();
  const hasTraitProfiles = Object.keys(traitProfilesByCluster).length > 0;

  Object.entries(CLUSTERS).forEach(([key, obj]) => {
    const vals = featureKeys.map(field => {
      const value = obj?.[field];
      return typeof value === "number" && !Number.isNaN(value) ? value : 0;
    });
    const behaviorSimilarity = cosineSimilarity(realVals, vals);
    const clusterTraitScores = traitProfilesByCluster[key]?.trait_scores || null;
    const clusterTraitSimilarity = clusterTraitScores
      ? traitSimilarity(userTraitScores, clusterTraitScores)
      : behaviorSimilarity;
    const finalScore = hasTraitProfiles
      ? behaviorSimilarity * 0.55 + clusterTraitSimilarity * 0.45
      : behaviorSimilarity;

    similarities.push({
      id: key,
      behaviorSimilarity,
      traitSimilarity: clusterTraitSimilarity,
      finalScore,
      score: finalScore
    });
    if (finalScore > bestScore) {
      bestScore = finalScore;
      best = {
        id: key,
        score: finalScore,
        behaviorSimilarity,
        traitSimilarity: clusterTraitSimilarity,
        raw: obj
      };
    }
  });

  if (best) {
    similarities.sort((a, b) => b.finalScore - a.finalScore);
    best.classificationDebug = {
      top5ClusterSimilarities: similarities.slice(0, 5),
      classificationFeatureCount: featureKeys.length,
      ignoredClusterFields: getIgnoredClusterFields(featureKeys),
      userTraitScores,
      behaviorSimilarity: best.behaviorSimilarity,
      traitSimilarity: best.traitSimilarity,
      finalScore: best.score
    };
  }

  return best;
}

// ===== 12. Legacy browser AI plan is disabled for participant data collection =====
async function callGeminiAI() {
  throw new Error("Legacy browser AI plan generation is disabled. Use the local AI travel plan section.");
}

// ===== 13. 选项高亮与进度 =====
function attachOptionHighlight() {
  document.querySelectorAll('.option-label input[type="radio"]').forEach(input => {
    input.addEventListener('change', () => {
      const name = input.name;
      document.querySelectorAll(`input[name="${name}"]`).forEach(radio => {
        radio.closest('.option-label')?.classList.toggle('selected', radio.checked);
      });
      answers[name] = input.value;
      updateProgress();
    });
  });
}

function updateProgress() {
  const answered = document.querySelectorAll('#questions input[type="radio"]:checked').length;
  const total = QUESTIONS.length || 12;

  const label = document.getElementById('progressLabel');
  const fill = document.getElementById('progressFill');

  if (label) label.textContent = `${answered} / ${total}`;
  if (fill) fill.style.width = `${Math.round((answered / total) * 100)}%`;
}

// ===== 14. 重开问卷 =====
function restartQuiz() {
  answers = {};
  behaviorVector = [];
  lastSummaryPayload = null;
  lastTagCounts = {};
  lastLocalAIPlan = null;
  window.__AB_TEST_PLAN1_SPOTS__ = [];
  window.__AB_TEST_PLAN2_SPOTS__ = [];
  window.__INTEGRATED_RECOMMENDATIONS__ = [];

  document.querySelectorAll('#questions input[type="radio"]').forEach(input => {
    input.checked = false;
  });
  document.querySelectorAll('.option-label.selected').forEach(label => {
    label.classList.remove('selected');
  });

  const resultSection = document.getElementById('resultSection');
  const quizSection = document.getElementById('quizSection');

  if (resultSection) resultSection.style.display = 'none';
  if (quizSection) quizSection.style.display = 'block';

  document.getElementById('profileAnalysisSection')?.remove();
  document.getElementById('processVisualizationSection')?.remove();
  document.getElementById('dataBasisSection')?.remove();
  document.getElementById('abComparisonSection')?.remove();
  document.getElementById('integratedRecommendationSection')?.remove();
  document.getElementById('resultTabs')?.remove();
  document.body.classList.remove("result-mode");

  updateProgress();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ===== 15. 语言切换兜底 =====
// 如果 index.html 已经定义了 toggleLanguage，则这里不会覆盖。
if (typeof window.toggleLanguage !== 'function') {
  window.toggleLanguage = function toggleLanguage() {
    window.currentLang = window.currentLang === 'ja' ? 'zh' : 'ja';

    document.querySelectorAll('.ja-text').forEach(el => {
      el.style.display = window.currentLang === 'ja' ? '' : 'none';
    });
    document.querySelectorAll('.zh-text').forEach(el => {
      el.style.display = window.currentLang === 'zh' ? '' : 'none';
    });

    renderQuestions();
    updateProgress();
  };
}

// 暴露给 HTML onclick
window.retryAI = retryAI;
window.restartQuiz = restartQuiz;
window.renderQuestions = renderQuestions;
window.updateProgress = updateProgress;
