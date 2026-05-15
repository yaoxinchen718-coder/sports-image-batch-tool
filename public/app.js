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
  ? new window.FaceDetector({ fastMode: true, maxDetectedFaces: 8 })
  : null;

const MULTI_PERSON_KEYWORDS = [
  " team",
  "squad",
  "group",
  "celebration",
  "huddle",
  "lineup",
  "bench",
  "players",
  "teammates",
  "with ",
  " and ",
  " vs ",
  "group portrait",
  "team photo",
];

const SINGLE_PERSON_KEYWORDS = [
  "portrait",
  "headshot",
  "pose",
  "posing",
  "profile",
  "arrives",
  "speaks",
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
];

const HALF_BODY_KEYWORDS = [
  "half body",
  "half-body",
  "upper body",
  "upper-body",
  "waist up",
  "torso",
  "posed",
  "posing",
  "presentation",
  "media day",
];

const ACTION_KEYWORDS = [
  "match",
  "game",
  "action",
  "training",
  "warm-up",
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
  selectionText.textContent = `Selected ${selectedIds.size}`;
}

function setAnalysisText(text) {
  if (analysisText) analysisText.textContent = text;
}

function normalizeHaystack(item) {
  return ` ${item.title || ""} ${item.reason || ""} ${item.caption || ""} ${item.license || ""} `
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
  if (MULTI_PERSON_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "multi";
  if (SINGLE_PERSON_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "single";
  return "unknown";
}

function classifySceneByText(item) {
  const haystack = normalizeHaystack(item);
  if (HEADSHOT_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "headshot";
  if (HALF_BODY_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "halfbody";
  if (ACTION_KEYWORDS.some((keyword) => haystack.includes(keyword))) return "action";
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
  if (type === "single") return "Single";
  if (type === "multi") return "Multiple";
  return "Unknown";
}

function getSceneLabel(type) {
  if (type === "headshot") return "Headshot";
  if (type === "halfbody") return "Half body";
  if (type === "action") return "Match action";
  return "Other";
}

function getDetectionSourceLabel(item) {
  const visual = getVisualTags(item);
  if (!visual) return "Text";
  if (visual.mode === "face-detector") return "Visual";
  return "Text";
}

function applyClientFilters() {
  const keyword = filterKeywordInput.value.trim().toLowerCase();
  const orientation = orientationFilter.value;
  const people = peopleFilter.value;
  const scene = sceneFilter.value;

  visibleResults = allResults.filter((item) => {
    const haystack = normalizeHaystack(item);
    const matchesKeyword = !keyword || haystack.includes(keyword);
    const matchesOrientation =
      orientation === "all" || classifyOrientation(item) === orientation;
    const matchesPeople = people === "all" || getPeopleCountType(item) === people;
    const matchesScene = scene === "all" || getSceneType(item) === scene;
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
    renderEmpty("No open-image results match the filters", "Try a broader query, a lower size filter, or English player and team names.");
    statusText.textContent = `Found ${allResults.length}, showing 0.`;
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

    imageLink.href = item.descriptionUrl;
    image.src = item.previewUrl;
    image.alt = item.title;

    title.textContent = item.title;
    dimensions.textContent =
      item.longEdge > 0
        ? `${item.width} x ${item.height} | long edge ${item.longEdge}px`
        : "Size depends on source result";
    reason.textContent = item.reason || item.sourceName || "Open image source";
    peopleMeta.textContent = `People: ${getPeopleCountLabel(getPeopleCountType(item))}`;
    sceneMeta.textContent = `Shot: ${getSceneLabel(getSceneType(item))}`;
    analysisMeta.textContent = `Analysis: ${getDetectionSourceLabel(item)}`;
    license.textContent = `Source: ${item.sourceName || "Open image source"} | ${item.license || "Check license"} | ${item.author || "Unknown author"}`;
    detailLink.href = item.descriptionUrl;

    copyLinkButton.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(item.originalUrl || item.descriptionUrl);
        statusText.textContent = "Link copied.";
      } catch {
        statusText.textContent = "Copy failed. Open the source page manually.";
      }
    });

    fragment.appendChild(node);
  });

  resultsGrid.appendChild(fragment);
  statusText.textContent = `Found ${allResults.length}, showing ${visibleResults.length}.`;
  syncCheckboxes();
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.referrerPolicy = "no-referrer";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Image failed to load"));
    image.src = url;
  });
}

function classifySceneFromFaces(faces, imageWidth, imageHeight) {
  if (!faces.length || !imageWidth || !imageHeight) return null;
  const faceAreas = faces.map((face) => face.boundingBox.width * face.boundingBox.height);
  const largestFace = Math.max(...faceAreas);
  const ratio = largestFace / (imageWidth * imageHeight);
  if (ratio >= 0.14) return "headshot";
  if (ratio >= 0.045) return "halfbody";
  return "action";
}

async function analyzeImageVisually(item) {
  if (!supportsFaceDetection || !faceDetector || !item.previewUrl) return null;
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
    sceneType:
      classifySceneFromFaces(faces, image.naturalWidth, image.naturalHeight) ||
      classifySceneByText(item),
  };
}

async function analyzeSingleItem(item) {
  const id = String(item.id);
  if (visualAnalysisCache.has(id) || pendingAnalysisIds.has(id)) return;

  pendingAnalysisIds.add(id);
  try {
    const visual = await analyzeImageVisually(item);
    if (visual) visualAnalysisCache.set(id, visual);
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
    setAnalysisText("Waiting for results.");
    return;
  }

  if (!supportsFaceDetection) {
    setAnalysisText("Visual detection is unavailable. Using text analysis.");
    return;
  }

  const uncached = visibleResults
    .filter((item) => !visualAnalysisCache.has(String(item.id)))
    .slice(0, 18);

  if (!uncached.length) {
    const visualCount = visibleResults.filter(
      (item) => getVisualTags(item)?.mode === "face-detector"
    ).length;
    setAnalysisText(`Visual analysis done for ${visualCount} visible results.`);
    return;
  }

  setAnalysisText(`Analyzing ${uncached.length} visible results...`);
  await Promise.allSettled(uncached.map((item) => analyzeSingleItem(item)));
  const visualCount = visibleResults.filter(
    (item) => getVisualTags(item)?.mode === "face-detector"
  ).length;
  setAnalysisText(`Visual analysis done for ${visualCount} visible results.`);
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
  visualAnalysisCache.clear();
  updateSelectionText();
  setBusy(true, "Searching open image sources...");
  setAnalysisText("Waiting for results...");

  try {
    const params = new URLSearchParams({ q: query, team, sport, minLongEdge, limit });
    const response = await fetch(`/api/search?${params.toString()}`);
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || "Search failed");

    allResults = data.results || [];
    visibleResults = [...allResults];
    filterKeywordInput.value = "";
    orientationFilter.value = "all";
    peopleFilter.value = "all";
    sceneFilter.value = "all";

    if (!allResults.length) {
      renderEmpty("No qualifying open images", "Try English player and team names, or lower the size filter.");
      statusText.textContent = "No open-image results matched this search.";
      setAnalysisText("No results to analyze.");
      return;
    }

    renderResults();
    void enhanceVisibleResults();
  } catch (error) {
    allResults = [];
    visibleResults = [];
    renderEmpty("Search failed", error.message || "Please try again later.");
    statusText.textContent = "Open image search failed.";
    setAnalysisText("Analysis did not start.");
  } finally {
    setBusy(false);
  }
}

async function downloadSelected() {
  const chosen = allResults.filter((item) => selectedIds.has(String(item.id)));
  if (!chosen.length) {
    statusText.textContent = "Select results before exporting.";
    return;
  }

  setBusy(true, `Downloading ${chosen.length} selected images...`);

  try {
    const response = await fetch("/api/download", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bundleName: `${document.getElementById("query").value || "sports-images"}-${Date.now()}`,
        items: chosen,
      }),
    });

    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Export failed");
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

    statusText.textContent = `Started downloading ${chosen.length} selected images.`;
  } catch (error) {
    statusText.textContent = error.message || "Export failed.";
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
    ? "Visual analysis available after search."
    : "Visual analysis unavailable. Text analysis will be used."
);
