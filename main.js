// ===== 全局数据 =====
window.currentLang = 'ja';

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
      html += `
        <label class="option-label">
          <input type="radio" name="${q.id}" value="${value}">
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
window.renderQuestions = renderQuestions;

// ===== 3. 提交按钮 =====
document.getElementById("submitBtn").addEventListener("click", () => {
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

  // 计算
  const tagCounts = calcTagCounts();
  lastTagCounts = tagCounts;
  behaviorVector = calcBehaviorVectorFromWeights(tagCounts);
  const bestCluster = findBestCluster(behaviorVector);

  // Cluster信息
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

  // 根据同行者×季节 筛选推荐景点（去掉去过的地方）
  const recommendedSpots = getRecommendedSpots(
    clusterInfo,
    window.userCompanion,
    window.userSeason,
    window.userVisitedPlaces
  );

  // 推荐住宿
  const recommendedHotels = getRecommendedHotels(recommendedSpots);

  // 构建给AI的payload
  lastSummaryPayload = {
    cluster: clusterInfo ? { id: clusterIndex, name: clusterInfo.name, description: clusterInfo.description } : bestCluster,
    companion: window.userCompanion,
    season: window.userSeason,
    visited_before: window.userVisited === 'yes',
    visited_places: window.userVisitedPlaces || null,
    recommended_spots: recommendedSpots,
  };

  // 切换到结果页
  showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels);
});

// ===== 4. 展示结果页 =====
function showResult(clusterInfo, clusterIndex, recommendedSpots, recommendedHotels) {
  document.getElementById("quizSection").style.display = "none";
  document.getElementById("resultSection").style.display = "block";
  window.scrollTo({ top: 0, behavior: "smooth" });

  // Cluster badge
  const name = clusterInfo
    ? (window.currentLang === "zh"
        ? `第 ${clusterIndex} 类：${clusterInfo.name}`
        : `第${clusterIndex}クラスター：${clusterInfo.name}`)
    : "—";
  document.getElementById("clusterName").textContent = name;
  document.getElementById("clusterDesc").textContent =
    clusterInfo ? clusterInfo.description.split("旅行中に訪れた")[0].trim() : "";

  renderProfileAnalysis(lastTagCounts, clusterInfo, clusterIndex);

  // Top Spots
  const spotsList = document.getElementById("spotsList");
  spotsList.innerHTML = "";
  const rankClass = ["r1", "r2", "r3"];
  recommendedSpots.slice(0, 3).forEach((spot, i) => {
    const label = window.currentLang === "zh" ? `No.${i+1}` : `Top${i+1}`;
    spotsList.innerHTML += `
      <div class="spot-item">
        <div class="spot-rank ${rankClass[i]}">${i+1}</div>
        <div class="spot-main">
          <div class="spot-name">${spot.place}</div>
          <div class="spot-reason">${getSpotReason(spot, i)}</div>
        </div>
        <div class="spot-users">${spot.source === 'data' ? `📊 ${spot.score}pt` : '📌 クラスター'}</div>
      </div>`;
  });

  // Hotels
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

  renderDataBasis(recommendedSpots);

  // AI部分：显示loading
  const aiResult = document.getElementById("aiResult");
  aiResult.innerHTML = `<div class="ai-loading"><div class="spinner"></div><span>${
    window.currentLang === "zh" ? "AI 正在生成你的旅行方案…" : "AI が旅行プランを作成しています…"
  }</span></div>`;
  document.getElementById("retryBtn").classList.remove("show");

  // 调用AI
  callGeminiAI(lastSummaryPayload)
    .then(text => {
      aiResult.style.whiteSpace = "pre-wrap";
      aiResult.textContent = text;
    })
    .catch(err => {
      aiResult.innerHTML = `<span style="color:#ef4444">${
        window.currentLang === "zh" ? "生成失败，请稍后重试" : "生成に失敗しました。しばらく後にお試しください"
      }</span><br><small style="color:#94a3b8">${err.message}</small>`;
      document.getElementById("retryBtn").classList.add("show");
    });
}

// ===== 5. 重试AI =====
function retryAI() {
  if (!lastSummaryPayload) return;
  const aiResult = document.getElementById("aiResult");
  aiResult.innerHTML = `<div class="ai-loading"><div class="spinner"></div><span>${
    window.currentLang === "zh" ? "AI 正在重新生成…" : "再生成しています…"
  }</span></div>`;
  document.getElementById("retryBtn").classList.remove("show");

  callGeminiAI(lastSummaryPayload)
    .then(text => {
      aiResult.style.whiteSpace = "pre-wrap";
      aiResult.textContent = text;
    })
    .catch(err => {
      aiResult.innerHTML = `<span style="color:#ef4444">${err.message}</span>`;
      document.getElementById("retryBtn").classList.add("show");
    });
}
window.retryAI = retryAI;

// ===== 5.5 研究展示：旅行者画像・推薦理由・データ根拠 =====
function installResearchStyles() {
  if (document.getElementById('researchStyles')) return;
  const style = document.createElement('style');
  style.id = 'researchStyles';
  style.textContent = `
    .spot-main { flex: 1; min-width: 0; }
    .spot-reason, .hotel-reason { font-size: 11.5px; color: var(--text-sub); margin-top: 4px; line-height: 1.5; }
    .profile-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .trait-card { background: #f8fafc; border: 1px solid #e8edf5; border-radius: 12px; padding: 12px 14px; }
    .trait-head { display: flex; justify-content: space-between; gap: 8px; font-size: 12.5px; font-weight: 700; color: var(--text); margin-bottom: 8px; }
    .trait-score { color: var(--primary); }
    .trait-bar-bg { height: 7px; background: #e2e8f0; border-radius: 99px; overflow: hidden; }
    .trait-bar { height: 100%; background: linear-gradient(90deg, #2563eb, #0ea5e9); border-radius: 99px; }
    .profile-note, .data-note { margin-top: 14px; padding: 12px 14px; background: #eff6ff; border: 1px solid #bfdbfe; color: #1e3a8a; border-radius: 12px; font-size: 12.5px; line-height: 1.7; }
    .data-kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 14px; }
    .data-kpi { background: #f8fafc; border: 1px solid #e8edf5; border-radius: 12px; padding: 12px; text-align: center; }
    .data-kpi-value { font-size: 20px; font-weight: 800; color: var(--primary); }
    .data-kpi-label { font-size: 11.5px; color: var(--text-sub); margin-top: 3px; }
    .data-top-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .data-chip { background: #f8fafc; border: 1px solid #e8edf5; border-radius: 999px; padding: 6px 10px; font-size: 12px; color: var(--text); }
    @media (max-width: 600px) { .profile-grid, .data-kpis { grid-template-columns: 1fr; } }
  `;
  document.head.appendChild(style);
}

function langText(ja, zh) {
  return window.currentLang === 'zh' ? zh : ja;
}

function getSpotReason(spot, index) {
  if (spot.source === 'data') {
    return langText(
      '推薦理由：同行者・旅行時期に近い過去データで出現頻度が高く、今回の旅行条件と合いやすいエリアです。',
      '推荐理由：在同行者和旅行季节相近的历史数据中出现频率较高，和本次旅行条件匹配度较高。'
    );
  }
  return langText(
    '推薦理由：あなたに近い旅行者クラスターの代表的な訪問エリアとして抽出されました。',
    '推荐理由：该地点来自与你相近的旅行者类型 cluster 的代表性访问区域。'
  );
}

function getHotelReason(hotel, recommendedSpots) {
  const relatedSpot = recommendedSpots.find(s => {
    const kw = s.place.replace(/ エリア$/, '').replace(/エリア$/, '').replace(/道の駅「.*?」/, '道の駅').trim();
    const area = hotel.area.replace(/（.*?）/, '').replace(/エリア$/, '').trim();
    return area.includes(kw) || kw.includes(area) || hotel.area.includes('あわら');
  });
  if (relatedSpot) {
    return langText(
      `宿泊理由：推薦エリア「${relatedSpot.place}」への移動を考慮して抽出しました。`,
      `住宿理由：根据推荐区域「${relatedSpot.place}」周边移动便利性筛选。`
    );
  }
  return langText('宿泊理由：推薦エリア周辺の登録宿泊施設から抽出しました。', '住宿理由：从推荐景点周边已登录住宿设施中筛选。');
}

function insertSectionAfter(newEl, afterEl) {
  if (!afterEl || !afterEl.parentNode) return;
  const old = document.getElementById(newEl.id);
  if (old) old.remove();
  afterEl.parentNode.insertBefore(newEl, afterEl.nextSibling);
}

function calcTraitScores(tagCounts) {
  const groups = {
    plan: ['advance_planning', 'plan_adherence', 'control_orientation', 'information_preparedness', 'structure_preference', 'risk_minimization'],
    relax: ['schedule_density_low', 'stay_based_travel', 'pace_slow', 'relaxation_focus', 'stress_reduction_goal', 'tranquility_seeking', 'quality_priority'],
    explore: ['spontaneity_level', 'intuitive_exploration', 'exploratory_behavior', 'novelty_seeking', 'experience_embrace', 'experience_driven_choice', 'local_culture_interest'],
    food: ['consumption_experience', 'cost_benefit_analysis', 'value_seeking'],
    nature: ['nature_preference', 'nature_dominant_preference', 'tranquility_seeking'],
    efficiency: ['schedule_density_high', 'multi_spot_hopping', 'pace_fast', 'efficiency_focus', 'time_optimization', 'coverage_maximization']
  };
  const labels = {
    plan: langText('計画性', '计划性'),
    relax: langText('リラックス志向', '放松倾向'),
    explore: langText('探索・体験志向', '探索/体验倾向'),
    food: langText('美食・価値志向', '美食/价值倾向'),
    nature: langText('自然志向', '自然倾向'),
    efficiency: langText('効率・周遊志向', '效率/多点游览倾向')
  };
  return Object.entries(groups).map(([key, tags]) => {
    const raw = tags.reduce((sum, tag) => sum + (tagCounts[tag] || 0), 0);
    return { key, label: labels[key], score: Math.min(100, Math.round(raw * 34)) };
  }).sort((a, b) => b.score - a.score);
}

function renderProfileAnalysis(tagCounts, clusterInfo, clusterIndex) {
  const section = document.createElement('div');
  section.id = 'profileAnalysisSection';
  section.className = 'section-card';
  const traits = calcTraitScores(tagCounts || {});
  const traitHtml = traits.map(t => `
    <div class="trait-card">
      <div class="trait-head"><span>${t.label}</span><span class="trait-score">${t.score}%</span></div>
      <div class="trait-bar-bg"><div class="trait-bar" style="width:${t.score}%"></div></div>
    </div>`).join('');

  section.innerHTML = `
    <div class="section-header">
      <div class="section-icon blue">🧭</div>
      <div>
        <h2>${langText('旅行者画像分析', '旅行者画像分析')}</h2>
        <p>${langText('回答内容から旅行傾向を可視化します', '根据回答内容可视化你的旅行倾向')}</p>
      </div>
    </div>
    <div class="section-body">
      <div class="profile-grid">${traitHtml}</div>
      <div class="profile-note">
        ${langText(
          `この画像は、12問の回答を心理・行動タグに変換し、福井観光データの旅行者クラスター（${clusterIndex ?? '-'}）と照合して作成しています。`,
          `该画像由12道问卷回答转换为心理/行为标签，并与福井观光数据中的旅行者 cluster（${clusterIndex ?? '-'}）进行匹配后生成。`
        )}
      </div>
    </div>`;

  insertSectionAfter(section, document.getElementById('clusterBadge'));
}

function renderDataBasis(recommendedSpots) {
  if (!DATA_SUMMARY) return;
  const section = document.createElement('div');
  section.id = 'dataBasisSection';
  section.className = 'section-card';
  const topSpots = (DATA_SUMMARY.top_spots || []).slice(0, 6)
    .map(s => `<span class="data-chip">${s.place}：${s.count}</span>`).join('');

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
        <div class="data-kpi"><div class="data-kpi-value">${DATA_SUMMARY.record_count || '-'}</div><div class="data-kpi-label">${langText('推薦ログ件数', '推荐记录数')}</div></div>
        <div class="data-kpi"><div class="data-kpi-value">${DATA_SUMMARY.unique_user_count || '-'}</div><div class="data-kpi-label">${langText('ユニークユーザー', '唯一用户数')}</div></div>
        <div class="data-kpi"><div class="data-kpi-value">${(DATA_SUMMARY.top_spots || []).length}</div><div class="data-kpi-label">${langText('主要推薦エリア', '主要推荐区域')}</div></div>
      </div>
      <div class="data-top-list">${topSpots}</div>
      <div class="data-note">
        ${langText(
          '本システムは、旅行者タイプ・同行者・旅行時期・過去の推薦傾向を組み合わせて、観光エリアと宿泊候補を提示します。',
          '本系统综合旅行者类型、同行者、旅行季节和过去推荐趋势，生成观光区域与住宿候选。'
        )}
      </div>
    </div>`;

  insertSectionAfter(section, document.getElementById('hotelSection'));
}

// ===== 6. 景点筛选逻辑（核心） =====
// 优先级：同行者×季节 > 同行者 > 季节 > Cluster Top3（兜底）
function getRecommendedSpots(clusterInfo, companion, season, visitedPlaces) {
  const visited = visitedPlaces
    ? visitedPlaces.split(/[、,，\s]+/).map(s => s.trim()).filter(Boolean)
    : [];

  // 确定权重key优先顺序
  const keys = [];
  if (companion && season) keys.push(`${companion}×${season}`);
  if (companion) keys.push(`companion:${companion}`);
  if (season) keys.push(`season:${season}`);

  // 从权重表取出候选景点（合并评分）
  const scoreMap = {};
  keys.forEach((key, priority) => {
    const spots = SPOT_WEIGHTS[key] || [];
    spots.forEach(s => {
      if (!scoreMap[s.place]) scoreMap[s.place] = 0;
      // 优先级越高（key越前），权重越大
      scoreMap[s.place] += s.score * (3 - priority);
    });
  });

  // 排序
  let sorted = Object.entries(scoreMap)
    .map(([place, score]) => ({ place, score: Math.round(score), source: 'data' }))
    .sort((a, b) => b.score - a.score);

  // 过滤去过的地方
  if (visited.length > 0) {
    sorted = sorted.filter(s =>
      !visited.some(v => s.place.includes(v) || v.length > 1 && s.place.includes(v))
    );
  }

  // 如果数据不足3个，用Cluster Top3兜底补充
  const result = sorted.slice(0, 5);
  if (result.length < 3 && clusterInfo && Array.isArray(clusterInfo.top_places)) {
    clusterInfo.top_places.forEach(p => {
      if (result.length >= 5) return;
      const already = result.some(r => r.place === p.place);
      if (!already) {
        result.push({ place: p.place, score: p.users, source: 'cluster' });
      }
    });
  }

  return result.slice(0, 5);
}

// ===== 7. 住宿匹配 =====
function getRecommendedHotels(recommendedSpots) {
  if (!HOTELS || HOTELS.length === 0) return [];

  // 从景点エリア名提取关键词
  const areaKeywords = recommendedSpots.map(s =>
    s.place.replace(/ エリア$/, '').replace(/エリア$/, '').replace(/道の駅「.*?」/, '道の駅').trim()
  );

  const matched = [];
  const seen = new Set();

  // 对每个关键词找住宿
  areaKeywords.forEach(kw => {
    HOTELS.forEach(h => {
      if (seen.has(h.name)) return;
      const areaClean = h.area.replace(/（.*?）/, '').replace(/エリア$/, '').trim();
      if (areaClean.includes(kw) || kw.includes(areaClean)) {
        matched.push(h);
        seen.add(h.name);
      }
    });
  });

  // 如果匹配太少，补充あわら湯のまち（最多住宿）
  if (matched.length < 3) {
    HOTELS.forEach(h => {
      if (seen.has(h.name)) return;
      if (h.area.includes('あわら')) {
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
  const fields = Object.keys(firstCluster).filter(k => typeof firstCluster[k] === "number" && !Number.isNaN(firstCluster[k]));
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
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return (na === 0 || nb === 0) ? 0 : dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ===== 11. 找最近Cluster =====
function findBestCluster(realVec) {
  if (!CLUSTERS || !realVec.length) return null;
  let best = null, bestScore = -Infinity;
  Object.entries(CLUSTERS).forEach(([key, obj]) => {
    const vals = Object.values(obj).filter(v => typeof v === "number" && !Number.isNaN(v));
    if (vals.length !== realVec.length) return;
    const score = cosineSimilarity(realVec, vals);
    if (score > bestScore) { bestScore = score; best = { id: key, score, raw: obj }; }
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
    `重要：推薦スポットは必ずrecommended_spotsに含まれる場所のみを使ってください。AIが独自に場所を追加・変更しないでください。`;

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
    payload.recommended_spots.map((s, i) => `  ${i+1}. ${s.place}`).join('\n') +
    `\n\n【提案フォーマット】\n` +
    `1) 2〜3文でユーザーの旅行スタイルを要約（タイプ名を含める）\n` +
    `2) recommended_spotsのTop3を使って、具体的な過ごし方を3つ箇条書きで提案\n` +
    `   各提案に「おすすめ内容」「理由」「ヒント」を2〜3行で記載\n` +
    `3) 旅行時期（${payload.season || '未定'}）に合わせた注意点やアドバイスを1〜2文で締める\n`;

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
    const text = await resp.text();
    throw new Error(`Gemini API エラー: ${resp.status}`);
  }

  const data = await resp.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "（AIからの返答がありません）";
}
