// ===== 全局数据 =====
window.currentLang = 'ja';

let QUESTIONS     = [];
let Q2PSYCH       = {};
let TAG_WEIGHTS   = {};
let CLUSTERS      = {};
let TOPPLACES     = null;
let SPOT_WEIGHTS  = {};   // 同行者×季节 → 景点权重
let HOTELS        = [];   // 住宿数据

let answers = {};
let behaviorVector = [];
let lastSummaryPayload = null;  // 用于重试

// ===== 1. 加载所有数据 =====
Promise.all([
  fetch("questions12.json").then(r => r.json()),
  fetch("questions12_to_psych144.json").then(r => r.json()),
  fetch("psych144_to_53_weights.fixed-new.json").then(r => r.json()),
  fetch("cluster_profiles.json").then(r => r.json()),
  fetch("20_top_places.json").then(r => r.json()),
  fetch("spot_weights_by_companion_season.json").then(r => r.json()),
  fetch("hotels.json").then(r => r.json()),
]).then(([qData, mapData, weightsData, clusters, topPlacesData, spotWeights, hotels]) => {
  QUESTIONS    = qData;
  Q2PSYCH      = mapData;
  TAG_WEIGHTS  = weightsData;
  CLUSTERS     = clusters;
  TOPPLACES    = topPlacesData;
  SPOT_WEIGHTS = spotWeights;
  HOTELS       = hotels;
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

  // Top Spots
  const spotsList = document.getElementById("spotsList");
  spotsList.innerHTML = "";
  const rankClass = ["r1", "r2", "r3"];
  recommendedSpots.slice(0, 3).forEach((spot, i) => {
    const label = window.currentLang === "zh" ? `No.${i+1}` : `Top${i+1}`;
    spotsList.innerHTML += `
      <div class="spot-item">
        <div class="spot-rank ${rankClass[i]}">${i+1}</div>
        <div class="spot-name">${spot.place}</div>
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
        </div>`;
    });
  }

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
