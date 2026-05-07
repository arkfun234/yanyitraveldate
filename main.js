// ===== 全局数据 =====
window.currentLang = window.currentLang || 'ja';

let QUESTIONS     = [];
let Q2PSYCH       = {};
let TAG_WEIGHTS   = {};
let CLUSTERS      = {};
let TOPPLACES     = null;
let SPOT_WEIGHTS  = {};   // 同行者×季节 → 景点权重
let HOTELS        = [];   // 住宿数据
let DATA_SUMMARY  = null; // 2025年度AI推薦データの要約

let answers = {};
let behaviorVector = [];
let lastSummaryPayload = null;  // 用于重试
let lastTagCounts = {};          // 旅行者画像分析用

// ===== 1. 加载所有数据 =====
Promise.all([
  fetch("questions12.json").then(r => r.json()),
  fetch("questions12_to_psych144.json").then(r => r.json()),
  fetch("psych144_to_53_weights.fixed-new.json").then(r => r.json()),
  fetch("cluster_profiles.json").then(r => r.json()),
  fetch("20_top_places.json").then(r => r.json()),
  fetch("spot_weights_by_companion_season.json").then(r => r.json()),
  fetch("hotels.json").then(r => r.json()),
  fetch("data_summary_2025.json").then(r => r.ok ? r.json() : null).catch(() => null),
]).then(([qData, mapData, weightsData, clusters, topPlacesData, spotWeights, hotels, dataSummary]) => {
  QUESTIONS    = qData;
  Q2PSYCH      = mapData;
  TAG_WEIGHTS  = weightsData;
  CLUSTERS     = clusters;
  TOPPLACES    = topPlacesData;
  SPOT_WEIGHTS = spotWeights;
  HOTELS       = hotels;
  DATA_SUMMARY = dataSummary;
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
    const bestCluster = findBestCluster(behaviorVector);

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

    const recommendedSpots = getRecommendedSpots(
      clusterInfo,
      window.userCompanion,
      window.userSeason,
      window.userVisitedPlaces
    );

    const recommendedHotels = getRecommendedHotels(recommendedSpots);

    lastSummaryPayload = {
      cluster: clusterInfo
        ? { id: clusterIndex, name: clusterInfo.name, description: clusterInfo.description }
        : bestCluster,
      companion: window.userCompanion,
      season: window.userSeason,
      visited_before: window.userVisited === 'yes',
      visited_places: window.userVisitedPlaces || null,
      recommended_spots: recommendedSpots,
    };

    showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels);
  });
});

// ===== 4. 展示结果页 =====
function showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels) {
  document.getElementById("quizSection").style.display = "none";
  document.getElementById("resultSection").style.display = "block";
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
  const sourceLabel =
    spot.source === 'global' ? langText('全体傾向', '整体趋势') :
    spot.source === 'global_mid' ? langText('中位候補', '中位候选') :
    spot.source === 'cluster' ? langText('クラスター', 'Cluster') :
    langText('条件別傾向', '条件趋势');

  spotsList.innerHTML += `
    <div class="spot-item">
      <div class="spot-rank ${rankClass[i]}">${i + 1}</div>
      <div class="spot-main">
        <div class="spot-category">${categoryLabel}</div>
        <div class="spot-name">${spot.place}</div>
        <div class="spot-reason">${getSpotReason(spot)}</div>
      </div>
      <div class="spot-users">📊 ${sourceLabel}</div>
    </div>`;
});

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

  const aiResult = document.getElementById("aiResult");
  aiResult.innerHTML = `<div class="ai-loading"><div class="spinner"></div><span>${
    window.currentLang === "zh" ? "AI 正在生成你的旅行方案…" : "AI が旅行プランを作成しています…"
  }</span></div>`;

  const retryBtn = document.getElementById("retryBtn");
  if (retryBtn) retryBtn.classList.remove("show");

  callGeminiAI(lastSummaryPayload)
    .then(text => {
      aiResult.style.whiteSpace = "pre-wrap";
      aiResult.textContent = text;
    })
    .catch(err => {
      aiResult.innerHTML = `<span style="color:#ef4444">${
        window.currentLang === "zh" ? "生成失败，请稍后重试" : "生成に失敗しました。しばらく後にお試しください"
      }</span><br><small style="color:#94a3b8">${err.message}</small>`;
      if (retryBtn) retryBtn.classList.add("show");
    });
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
    @media (max-width: 600px) {
      .profile-grid, .data-kpis, .process-flow { grid-template-columns: 1fr; }
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

// ===== 6. 景点筛选逻辑 =====
// 优先级：同行者×季节 > 同行者 > 季节 > Cluster Top3（兜底）
function getRecommendedSpots(clusterInfo, companion, season, visitedPlaces) {
  const visited = visitedPlaces
    ? visitedPlaces.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)
    : [];

  const isVisited = (place) => {
    if (!visited.length) return false;
    return visited.some(v => place.includes(v) || (v.length > 1 && place.includes(v)));
  };

  const used = new Set();

  // 1. 定番推薦：2025年度推薦ログ全体で高頻度のスポット
  const globalTop = (DATA_SUMMARY?.top_spots || [])
    .filter(s => s && s.place && !isVisited(s.place));

  let classic = null;
  for (const s of globalTop) {
    if (!used.has(s.place)) {
      classic = {
        place: s.place,
        score: s.count || 0,
        source: 'global',
        category: 'classic',
        categoryJa: '定番推薦',
        categoryZh: '经典推荐'
      };
      used.add(s.place);
      break;
    }
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
      source: 'data',
      category: 'personalized',
      categoryJa: '個性化推薦',
      categoryZh: '个性化推荐'
    }))
    .sort((a, b) => b.score - a.score);

  let personalized = null;
  for (const s of personalizedCandidates) {
    if (!used.has(s.place)) {
      personalized = s;
      used.add(s.place);
      break;
    }
  }

  // 3. 発見推薦：人気上位に偏りすぎないよう、クラスター候補や中位候補から補完
  const discoveryCandidates = [];

  // Cluster由来の候補
  if (clusterInfo && Array.isArray(clusterInfo.top_places)) {
    clusterInfo.top_places.forEach(p => {
      if (!p.place || isVisited(p.place)) return;
      discoveryCandidates.push({
        place: p.place,
        score: p.users || 0,
        source: 'cluster',
        category: 'discovery',
        categoryJa: '発見推薦',
        categoryZh: '发现推荐'
      });
    });
  }

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
      source: 'global_mid',
      category: 'discovery',
      categoryJa: '発見推薦',
      categoryZh: '发现推荐'
    });
  });

  let discovery = null;
  for (const s of discoveryCandidates) {
    if (!used.has(s.place)) {
      discovery = s;
      used.add(s.place);
      break;
    }
  }

  // 兜底：如果某一类缺失，就从已有候选中补齐
  const result = [];

  if (classic) result.push(classic);
  if (personalized) result.push(personalized);
  if (discovery) result.push(discovery);

  const fallbackCandidates = [
    ...personalizedCandidates,
    ...globalTop.map(s => ({
      place: s.place,
      score: s.count || 0,
      source: 'global',
      category: 'classic',
      categoryJa: '定番推薦',
      categoryZh: '经典推荐'
    })),
    ...discoveryCandidates
  ];

  for (const s of fallbackCandidates) {
    if (result.length >= 3) break;
    if (!s.place || used.has(s.place) || isVisited(s.place)) continue;
    result.push(s);
    used.add(s.place);
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
function calcBehaviorVectorFromWeights(tagCounts) {
  const clusterKeys = Object.keys(CLUSTERS);
  if (!clusterKeys.length) return [];

  const firstCluster = CLUSTERS[clusterKeys[0]];
  const fields = Object.keys(firstCluster)
    .filter(k => typeof firstCluster[k] === "number" && !Number.isNaN(firstCluster[k]));

  const vec = Array(fields.length).fill(0);

  for (const tag in tagCounts) {
    const count = tagCounts[tag];
    const weightDef = TAG_WEIGHTS[tag];
    if (!weightDef) continue;

    for (const field in weightDef) {
      const idx = fields.indexOf(field);
      if (idx !== -1) vec[idx] += count * weightDef[field];
    }
  }

  return vec;
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
function findBestCluster(realVec) {
  if (!CLUSTERS || !realVec.length) return null;

  let best = null;
  let bestScore = -Infinity;

  Object.entries(CLUSTERS).forEach(([key, obj]) => {
    const vals = Object.values(obj).filter(v => typeof v === "number" && !Number.isNaN(v));
    if (vals.length !== realVec.length) return;

    const score = cosineSimilarity(realVec, vals);
    if (score > bestScore) {
      bestScore = score;
      best = { id: key, score, raw: obj };
    }
  });

  return best;
}

// ===== 12. 调用 Gemini AI =====
async function callGeminiAI(payload) {
  const apiKey = "AIzaSyB0tLavtrAxgZ_c5PmBgRBNNVK0HRwhBio";
  const model  = "gemini-2.0-flash";
  const url    = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

  const lang = window.currentLang === "zh" ? "中国語（簡体字）" : "日本語";

  const systemPrompt =
    `あなたは福井県専門のプロ旅行プランナーです。必ず${lang}で回答してください。` +
    `ユーザーの旅行タイプ診断結果と「推薦スポットリスト」をもとに、具体的で実用的な旅行プランを提案してください。` +
    `重要：推薦スポットは必ずrecommended_spotsに含まれる場所のみを使ってください。AIが独自に場所を追加・変更しないでください。` +
    `営業時間・交通状況・料金などの変動情報は断定しないでください。`;

  const visitedNote = payload.visited_before && payload.visited_places
    ? `\n※ ユーザーはすでに「${payload.visited_places}」を訪れたことがあります。これらは推薦から除外済みです。`
    : payload.visited_before
      ? "\n※ ユーザーは福井を訪れたことがあります。定番スポット以外の提案も歓迎します。"
      : "";

  const userPrompt =
    `以下は旅行タイプ診断の結果です。${visitedNote}\n\n` +
    `■ 旅行者タイプ: ${payload.cluster?.name || ''}\n` +
    `■ 同行者: ${payload.companion || '未回答'}\n` +
    `■ 旅行時期: ${payload.season || '未定'}\n` +
    `■ recommended_spots（このリストの場所のみ使用すること）:\n` +
    payload.recommended_spots.map((s, i) => `  ${i + 1}. ${s.place}`).join('\n') +
    `\n\n【提案フォーマット】\n` +
    `1) 2〜3文でユーザーの旅行スタイルを要約（タイプ名を含める）\n` +
    `2) recommended_spotsのTop3を使って、具体的な過ごし方を3つ箇条書きで提案\n` +
    `   各提案に「おすすめ内容」「理由」「ヒント」を2〜3行で記載\n` +
    `3) 最後に「実際の営業時間・交通情報は事前確認が必要です」と自然に付記する\n`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: { temperature: 0.7, maxOutputTokens: 900, topP: 0.9 }
    })
  });

  if (!resp.ok) {
    throw new Error(`Gemini API エラー: ${resp.status}`);
  }

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "（AIからの返答がありません）";
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
  document.getElementById('dataBasisSection')?.remove();

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
