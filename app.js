const form = document.getElementById("search-form");
const resultsGrid = document.getElementById("results-grid");
const statusText = document.getElementById("status-text");
const selectionText = document.getElementById("selection-text");
const filterKeywordInput = document.getElementById("filter-keyword");
const orientationFilter = document.getElementById("orientation-filter");
const peopleFilter = document.getElementById("people-filter");
const sceneFilter = document.getElementById("scene-filter");
const analysisText = document.getElementById("analysis-text");
const selectVisibleButton = document.getElementById("select-visible");
const clearSelectionButton = document.getElementById("clear-selection");
const downloadSelectedButton = document.getElementById("download-selected");
const template = document.getElementById("result-card-template");

let allResults = [];
let visibleResults = [];
const selectedIds = new Set();
const visualAnalysisCache = new Map();
const pendingAnalysisIds = new Set();

const supportsFaceDetection = "FaceDetector" in window;
const faceDetector = supportsFaceDetection
  ? new window.FaceDetector({
      fastMode: true,
      maxDetectedFaces: 8,
    })
  : null;

const MULTI_PERSON_KEYWORDS = [
  " team",
  "squad",
  "group",
  "groups",
  "celebration",
  "huddle",
  "lineup",
  "bench",
  "together",
  "duo",
  "trio",
  "pair",
  "players",
  "teammates",
  "with ",
  " and ",
  " vs ",
  " v ",
  "群像",
  "合影",
  "集体",
  "多人",
  "全队",
  "球队",
  "队员",
  "球员们",
  "一起",
  "合照",
  "双人",
];

const SINGLE_PERSON_KEYWORDS = [
  "portrait",
  "headshot",
  "pose",
  "posing",
  "profile",
  "单人",
  "个人",
  "肖像",
  "写真",
  "头像",
  "定妆",
];

const HEADSHOT_KEYWORDS = [
  "headshot",
  "close-up",
  "close up",
  "closeup",
  "portrait",
  "profile",
  "face",
  "facial",
  "media day",
  "头像",
  "脸部",
  "面部",
  "特写",
  "肖像",
  "证件照",
];

const HALF_BODY_KEYWORDS = [
  "half body",
  "half-body",
  "upper body",
  "upper-body",
  "upperbody",
  "waist up",
  "torso",
  "posed",
  "posing",
  "presentation",
  "jersey presentation",
  "media day",
  "半身",
  "上半身",
  "腰部以上",
  "站姿",
  "定妆",
  "宣传照",
];

const ACTION_KEYWORDS = [
  "match",
  "game",
  "action",
  "training",
  "warm-up",
  "warm up",
  "practice",
  "dribble",
  "shooting",
  "kicking",
  "passing",
  "batting",
  "pitching",
  "running",
  "goal",
  "save",
  "dunk",
  "celebration",
  "stadium",
  "比赛",
  "赛场",
  "比赛中",
  "训练",
  "热身",
  "进球",
  "扣篮",
  "投篮",
  "奔跑",
  "扑救",
  "击球",
  "投球",
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setBusy(isBusy, message) {
  form.querySelector('button[type="submit"]').disabled = isBusy;
  downloadSelectedButton.disabled = isBusy;
  if (message) statusText.textContent = message;
}

function updateSelectionText() {
  selectionText.textContent = `已选 ${selectedIds.size} 张`;
}

function setAnalysisText(text) {
  if (analysisText) analysisText.textContent = text;
}

function normalizeHaystack(item) {
  return ` ${item.title || ""} ${item.reason || ""} ${item.license || ""} `
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function classifyOrientation(item) {
  if (!item.width || !item.height) return "unknown";
  const ratio = item.width / item.height;
  if (ratio > 1.15) return "landscape";
  if (ratio < 0.85) return "portrait";
  return "square";
}

function classifyPeopleCountByText(item) {
  const haystack = normalizeHaystack(item);

  if (MULTI_PERSON_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "multi";
  }

  if (SINGLE_PERSON_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "single";
  }

  return "unknown";
}

function classifySceneByText(item) {
  const haystack = normalizeHaystack(item);

  if (HEADSHOT_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "headshot";
  }

  if (HALF_BODY_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "halfbody";
  }

  if (ACTION_KEYWORDS.some((keyword) => haystack.includes(keyword))) {
    return "action";
  }

  if (classifyOrientation(item) === "portrait" && classifyPeopleCountByText(item) !== "multi") {
    return "halfbody";
  }

  return "other";
}

function getVisualTags(item) {
  return visualAnalysisCache.get(String(item.id)) || null;
}

function getPeopleCountType(item) {
  const visual = getVisualTags(item);
  return visual?.peopleType || classifyPeopleCountByText(item);
}

function getSceneType(item) {
  const visual = getVisualTags(item);
  return visual?.sceneType || classifySceneByText(item);
}

function getPeopleCountLabel(type) {
  if (type === "single") return "单人";
  if (type === "multi") return "多人";
  return "未识别";
}

function getSceneLabel(type) {
  if (type === "headshot") return "头像";
  if (type === "halfbody") return "半身";
  if (type === "action") return "比赛照";
  return "其他";
}

function getDetectionSourceLabel(item) {
  const visual = getVisualTags(item);
  if (!visual) return "文字判断";
  if (visual.mode === "face-detector") return "图像识别";
  return "文字判断";
}

function applyClientFilters() {
  const keyword = filterKeywordInput.value.trim().toLowerCase();
  const orientation = orientationFilter.value;
  const people = peopleFilter.value;
  const scene = sceneFilter.value;

  visibleResults = allResults.filter((item) => {
    const haystack = `${item.title} ${item.reason} ${item.license}`.toLowerCase();
    const matchesKeyword = !keyword || haystack.includes(keyword);
    const matchesOrientation =
      orientation === "all" || classifyOrientation(item) === orientation;
    const matchesPeople =
      people === "all" || getPeopleCountType(item) === people;
    const matchesScene =
      scene === "all" || getSceneType(item) === scene;

    return matchesKeyword && matchesOrientation && matchesPeople && matchesScene;
  });

  renderResults();
}

function renderEmpty(title, text) {
  resultsGrid.classList.add("empty");
  resultsGrid.innerHTML = `
    <div class="empty-state">
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(text)}</p>
    </div>
  `;
}

function syncCheckboxes() {
  document.querySelectorAll(".select-checkbox").forEach((checkbox) => {
    const id = checkbox.dataset.id;
    checkbox.checked = selectedIds.has(id);
  });
  updateSelectionText();
}

function renderResults() {
  if (!visibleResults.length) {
    renderEmpty("这轮结果里没有符合筛选的图片", "换个关键词、放宽条件，或者把人数和高级筛选切回全部再试。");
    statusText.textContent = `共找到 ${allResults.length} 张，当前显示 0 张。`;
    updateSelectionText();
    return;
  }

  resultsGrid.classList.remove("empty");
  resultsGrid.innerHTML = "";

  const fragment = document.createDocumentFragment();

  visibleResults.forEach((item) => {
    const node = template.content.firstElementChild.cloneNode(true);
    const checkbox = node.querySelector(".select-checkbox");
    const imageLink = node.querySelector(".image-link");
    const image = node.querySelector(".result-image");
    const title = node.querySelector(".result-title");
    const dimensions = node.querySelector(".dimensions");
    const reason = node.querySelector(".reason");
    const peopleMeta = node.querySelector(".people-meta");
    const sceneMeta = node.querySelector(".scene-meta");
    const analysisMeta = node.querySelector(".analysis-meta");
    const license = node.querySelector(".license");
    const detailLink = node.querySelector(".detail-link");
    const copyLinkButton = node.querySelector(".copy-link-btn");

    checkbox.dataset.id = String(item.id);
    checkbox.checked = selectedIds.has(String(item.id));
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selectedIds.add(String(item.id));
      else selectedIds.delete(String(item.id));
      updateSelectionText();
    });

    imageLink.href = item.originalUrl;
    image.src = item.previewUrl;
    image.alt = item.title;

    title.textContent = item.title;
    dimensions.textContent =
      item.longEdge > 0
        ? `${item.width} × ${item.height} | 长边 ${item.longEdge}px`
        : "尺寸信息以原图页为准";
    reason.textContent = item.reason;
    peopleMeta.textContent = `人数判断: ${getPeopleCountLabel(getPeopleCountType(item))}`;
    sceneMeta.textContent = `画面类型: ${getSceneLabel(getSceneType(item))}`;
    analysisMeta.textContent = `识别方式: ${getDetectionSourceLabel(item)}`;
    license.textContent = `授权: ${item.license}`;
    detailLink.href = item.descriptionUrl;

    copyLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.originalUrl);
        statusText.textContent = "原图链接已复制。";
      } catch {
        statusText.textContent = "复制失败，请手动打开原图页复制。";
      }
    });

    fragment.appendChild(node);
  });

  resultsGrid.appendChild(fragment);
  statusText.textContent = `共找到 ${allResults.length} 张，当前显示 ${visibleResults.length} 张。`;
  syncCheckboxes();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("图片加载失败"));
    image.src = url;
  });
}

function classifySceneFromFaces(faces, imageWidth, imageHeight) {
  if (!faces.length || !imageWidth || !imageHeight) return null;

  const faceAreas = faces.map((face) => face.boundingBox.width * face.boundingBox.height);
  const largestFace = Math.max(...faceAreas);
  const frameArea = imageWidth * imageHeight;
  const ratio = largestFace / frameArea;

  if (ratio >= 0.14) return "headshot";
  if (ratio >= 0.045) return "halfbody";
  return "action";
}

async function analyzeImageVisually(item) {
  if (!supportsFaceDetection || !faceDetector || !item.previewUrl) {
    return null;
  }

  const image = await loadImage(item.previewUrl);
  const faces = await faceDetector.detect(image);
  const faceCount = faces.length;

  let peopleType = "unknown";
  if (faceCount >= 2) peopleType = "multi";
  else if (faceCount === 1) peopleType = "single";

  return {
    mode: "face-detector",
    faceCount,
    peopleType,
    sceneType: classifySceneFromFaces(faces, image.naturalWidth, image.naturalHeight) || classifySceneByText(item),
  };
}

async function analyzeSingleItem(item) {
  const id = String(item.id);
  if (visualAnalysisCache.has(id) || pendingAnalysisIds.has(id)) return;

  pendingAnalysisIds.add(id);
  try {
    const visual = await analyzeImageVisually(item);
    if (visual) {
      visualAnalysisCache.set(id, visual);
    }
  } catch {
    visualAnalysisCache.set(id, {
      mode: "text-fallback",
      peopleType: classifyPeopleCountByText(item),
      sceneType: classifySceneByText(item),
      faceCount: 0,
    });
  } finally {
    pendingAnalysisIds.delete(id);
  }
}

async function enhanceVisibleResults() {
  if (!visibleResults.length) {
    setAnalysisText("等待结果后再做图像识别。");
    return;
  }

  if (!supportsFaceDetection) {
    setAnalysisText("当前浏览器不支持图像识别，已自动使用文字判断。");
    return;
  }

  const uncached = visibleResults.filter((item) => !visualAnalysisCache.has(String(item.id))).slice(0, 18);
  if (!uncached.length) {
    const visualCount = visibleResults.filter((item) => getVisualTags(item)?.mode === "face-detector").length;
    setAnalysisText(`图像识别已完成，本页有 ${visualCount} 张结果使用了看图判断。`);
    return;
  }

  setAnalysisText(`正在增强识别，本页还有 ${uncached.length} 张图片待分析...`);
  await Promise.allSettled(uncached.map((item) => analyzeSingleItem(item)));
  const visualCount = visibleResults.filter((item) => getVisualTags(item)?.mode === "face-detector").length;
  setAnalysisText(`图像识别已完成，本页有 ${visualCount} 张结果使用了看图判断。`);
  applyClientFilters();
}

async function runSearch(event) {
  event.preventDefault();

  const formData = new FormData(form);
  const query = formData.get("query");
  const team = formData.get("team");
  const sport = formData.get("sport");
  const minLongEdge = formData.get("minLongEdge");
  const limit = formData.get("limit");

  selectedIds.clear();
  updateSelectionText();
  setBusy(true, "正在查找并筛选高清图片...");
  setAnalysisText("等待搜索结果...");

  try {
    const params = new URLSearchParams({
      q: query,
      team,
      sport,
      minLongEdge,
      limit,
    });
    const response = await fetch(`/api/search?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "搜索失败");
    }

    allResults = data.results || [];
    visibleResults = [...allResults];
    filterKeywordInput.value = "";
    orientationFilter.value = "all";
    peopleFilter.value = "all";
    sceneFilter.value = "all";

    if (!allResults.length) {
      renderEmpty("没有找到达标结果", "你可以试试只搜人物名，或者换一个球队名后再查。");
      statusText.textContent = "这次没有找到符合条件的高清图片。";
      setAnalysisText("没有结果可供识别。");
      return;
    }

    renderResults();
    void enhanceVisibleResults();
  } catch (error) {
    allResults = [];
    visibleResults = [];
    renderEmpty("搜索失败", error.message || "稍后再试一次。");
    statusText.textContent = "搜索失败，请稍后再试。";
    setAnalysisText("图像识别未开始。");
  } finally {
    setBusy(false);
  }
}

async function downloadSelected() {
  const chosen = allResults.filter((item) => selectedIds.has(String(item.id)));
  if (!chosen.length) {
    statusText.textContent = "请先勾选要下载的图片。";
    return;
  }

  setBusy(true, `正在打包 ${chosen.length} 张图片，请稍等...`);

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        bundleName: `${document.getElementById("query").value || "sports-images"}-${Date.now()}`,
        items: chosen,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "下载失败");
    }

    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `sports-images-${Date.now()}.zip`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    statusText.textContent = `已开始下载 ${chosen.length} 张图片。`;
  } catch (error) {
    statusText.textContent = error.message || "打包下载失败。";
  } finally {
    setBusy(false);
  }
}

form.addEventListener("submit", runSearch);
filterKeywordInput.addEventListener("input", applyClientFilters);
orientationFilter.addEventListener("change", applyClientFilters);
peopleFilter.addEventListener("change", applyClientFilters);
sceneFilter.addEventListener("change", applyClientFilters);

selectVisibleButton.addEventListener("click", () => {
  visibleResults.forEach((item) => selectedIds.add(String(item.id)));
  syncCheckboxes();
});

clearSelectionButton.addEventListener("click", () => {
  selectedIds.clear();
  syncCheckboxes();
});

downloadSelectedButton.addEventListener("click", downloadSelected);

setAnalysisText(
  supportsFaceDetection
    ? "浏览器支持图像识别，搜索后会自动增强判断。"
    : "当前浏览器不支持图像识别，将使用文字判断。"
);
