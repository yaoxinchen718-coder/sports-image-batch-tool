const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const GETTY_API_KEY = process.env.GETTY_API_KEY || "";
const SEARCH_ENDPOINTS = ["editorial", "creative"];

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const SPORT_TERMS = {
  any: [],
  football: ["soccer", "football"],
  basketball: ["basketball", "NBA"],
  baseball: ["baseball", "MLB"],
};

const TRANSLATION_HINTS = [
  { tests: [/\u6885\u897f|\bmessi\b/i], value: "Lionel Messi" },
  { tests: [/\u8fc8\u963f\u5bc6\u56fd\u9645|inter\s*miami/i], value: "Inter Miami" },
  { tests: [/c\u7f57|cristiano|ronaldo/i], value: "Cristiano Ronaldo" },
  { tests: [/\u5185\u9a6c\u5c14|neymar/i], value: "Neymar" },
  { tests: [/\u59c6\u5df4\u4f69|mbappe/i], value: "Kylian Mbappe" },
  { tests: [/\u54c8\u5170\u5fb7|haaland/i], value: "Erling Haaland" },
  { tests: [/\u8a00\u6d6a|\u51fa\u73b0/i], value: "" },
  { tests: [/\u8a79\u59c6\u65af|\u52d2\u5e03\u6717|lebron/i], value: "LeBron James" },
  { tests: [/\u5e93\u91cc|curry/i], value: "Stephen Curry" },
  { tests: [/\u675c\u5170\u7279|durant/i], value: "Kevin Durant" },
  { tests: [/\u7ea6\u57fa\u5947|jokic/i], value: "Nikola Jokic" },
  { tests: [/\u4e1c\u5951\u5947|doncic/i], value: "Luka Doncic" },
  { tests: [/\u79d1\u6bd4|kobe/i], value: "Kobe Bryant" },
  { tests: [/\u4e54\u4e39|jordan/i], value: "Michael Jordan" },
  { tests: [/\u5927\u8c37\u7fd4\u5e73|ohtani/i], value: "Shohei Ohtani" },
  { tests: [/\u6e56\u4eba|lakers/i], value: "Los Angeles Lakers" },
  { tests: [/\u52c7\u58eb|warriors/i], value: "Golden State Warriors" },
  { tests: [/\u51ef\u5c14\u7279\u4eba|celtics/i], value: "Boston Celtics" },
  { tests: [/\u5c3c\u514b\u65af|knicks/i], value: "New York Knicks" },
  { tests: [/\u626c\u57fa|yankees/i], value: "New York Yankees" },
  { tests: [/\u7ebd\u7ea6\u626c\u57fa|new york yankees/i], value: "New York Yankees" },
  { tests: [/\u9053\u5947|dodgers/i], value: "Los Angeles Dodgers" },
  { tests: [/\u8d1d\u514b\u6c49\u59c6|beckham/i], value: "David Beckham" },
  { tests: [/\u66fc\u8054|manchester\s*united/i], value: "Manchester United" },
  { tests: [/\u7687\u9a6c|real\s*madrid/i], value: "Real Madrid" },
  { tests: [/\u5df4\u8428|barcelona/i], value: "Barcelona" },
  { tests: [/\u963f\u6839\u5ef7|argentina/i], value: "Argentina" },
  { tests: [/\u6cd5\u56fd|france/i], value: "France" },
  { tests: [/\u8461\u8404\u7259|portugal/i], value: "Portugal" },
];

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, statusCode, text) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function cleanText(value = "") {
  return String(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileName(input, fallback = "image") {
  const safe = cleanText(input)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
  return safe || fallback;
}

function uniqueStrings(items, limit = 16) {
  const result = [];
  const seen = new Set();

  for (const item of items) {
    const value = cleanText(item);
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
    if (result.length >= limit) break;
  }

  return result;
}

function extractReferralUrl(value) {
  if (!value) return "";
  if (typeof value === "string") {
    return /^https?:\/\//i.test(value) ? value : "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractReferralUrl(item);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    if (typeof value.uri === "string" && /^https?:\/\//i.test(value.uri)) return value.uri;
    for (const entry of Object.values(value)) {
      const found = extractReferralUrl(entry);
      if (found) return found;
    }
  }
  return "";
}

function translateHints(text) {
  const value = cleanText(text);
  const hints = [];

  for (const hint of TRANSLATION_HINTS) {
    if (hint.tests.some((pattern) => pattern.test(value))) {
      if (hint.value) hints.push(hint.value);
    }
  }

  return uniqueStrings([value, ...hints], 8);
}

function buildGettyPhrases({ query, team, sport }) {
  const queryHints = translateHints(query);
  const teamHints = translateHints(team);
  const sportTerms = SPORT_TERMS[sport] || [];
  const primaryQuery = queryHints[1] || queryHints[0] || query;
  const primaryTeam = teamHints[1] || teamHints[0] || team;

  return uniqueStrings(
    [
      `${primaryQuery} ${primaryTeam}`.trim(),
      `${primaryQuery} ${sportTerms[0] || ""}`.trim(),
      `${primaryQuery}`.trim(),
      `${query} ${team}`.trim(),
      ...queryHints,
      ...teamHints.map((value) => `${primaryQuery} ${value}`.trim()),
      ...sportTerms.map((term) => `${primaryQuery} ${term}`.trim()),
    ],
    8
  );
}

async function fetchGettyJson(url) {
  const response = await fetch(url, {
    headers: {
      "Api-Key": GETTY_API_KEY,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(20000),
  });

  const text = await response.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!response.ok) {
    const message =
      body?.ErrorMessage ||
      body?.message ||
      body?.error_description ||
      `Getty API request failed: ${response.status}`;
    throw new Error(message);
  }

  return body;
}

function pickBestSize(sizes = []) {
  return [...sizes]
    .filter((size) => size?.uri)
    .sort((a, b) => (Number(b.width) || 0) - (Number(a.width) || 0))[0];
}

function normalizeGettyImage(image, source) {
  const displaySizes = Array.isArray(image.display_sizes) ? image.display_sizes : [];
  const display = pickBestSize(displaySizes);
  const fallbackUri = image.preview || image.comp || image.thumb || "";
  const maxDimensions = image.max_dimensions || {};
  const largest = pickBestSize([
    ...displaySizes,
    image.preview ? { uri: image.preview, width: 612, height: 0 } : null,
    image.comp ? { uri: image.comp, width: 1024, height: 0 } : null,
    image.thumb ? { uri: image.thumb, width: 170, height: 0 } : null,
  ].filter(Boolean));

  const width = Number(maxDimensions.width || largest?.width || display?.width || 0);
  const height = Number(maxDimensions.height || largest?.height || display?.height || 0);
  const title = cleanText(image.title || image.caption || image.id || "Getty result");
  const caption = cleanText(image.caption || "");
  const date = cleanText(image.date_created || image.date_submitted || "");
  const location = cleanText([image.city, image.state_province, image.country].filter(Boolean).join(", "));
  const referralUrl = extractReferralUrl(image.referral_destinations);
  const searchFallback = `https://www.gettyimages.com/search/2/image?phrase=${encodeURIComponent(title)}`;

  return {
    id: String(image.id),
    pageTitle: title,
    title,
    width,
    height,
    longEdge: Math.max(width, height),
    shortEdge: Math.min(width, height),
    area: width * height,
    mime: "image/jpeg",
    ext: "jpg",
    previewUrl: display?.uri || fallbackUri,
    originalUrl: display?.uri || fallbackUri,
    descriptionUrl: referralUrl || searchFallback,
    license: cleanText(image.license_model || "Getty Images"),
    author: cleanText(image.artist || image.credit_line || "Getty Images"),
    credit: cleanText(image.credit_line || ""),
    sourceName: source,
    reason: [image.collection_name, date, location].filter(Boolean).join(" | ") || source,
    caption,
    qualityRank: Number(image.quality_rank ?? 99),
    orientation: cleanText(image.orientation || ""),
    assetFamily: cleanText(image.asset_family || ""),
  };
}

function scoreGettyResult(item, phrase, endpoint, query, team) {
  const haystack = `${item.title} ${item.caption} ${item.reason}`.toLowerCase();
  let score = 0;

  if (cleanText(query) && haystack.includes(cleanText(query).toLowerCase())) score += 25;
  if (cleanText(team) && haystack.includes(cleanText(team).toLowerCase())) score += 14;
  if (cleanText(phrase) && haystack.includes(cleanText(phrase).toLowerCase())) score += 12;
  if (endpoint === "editorial") score += 10;
  if (item.assetFamily === "editorial") score += 8;
  score += Math.max(0, 30 - item.qualityRank * 8);
  score += Math.min(item.longEdge / 120, 30);
  score += Math.min(item.area / 500000, 20);
  return score;
}

async function searchGettyEndpoint(endpoint, phrase, pageSize = 25) {
  const url = new URL(`https://api.gettyimages.com/v3/search/images/${endpoint}`);
  url.searchParams.set("phrase", phrase);
  url.searchParams.set("page_size", String(pageSize));
  url.searchParams.set("sort_order", "best_match");
  url.searchParams.set("fields", "detail_set,display_set");

  const data = await fetchGettyJson(url.toString());
  return Array.isArray(data.images) ? data.images : [];
}

async function searchGettyImages({ query, team, sport, minLongEdge, limit }) {
  if (!GETTY_API_KEY) {
    const error = new Error(
      "Missing GETTY_API_KEY. Add it to the Render environment variables and redeploy."
    );
    error.code = "MISSING_GETTY_API_KEY";
    throw error;
  }

  const phrases = buildGettyPhrases({ query, team, sport });
  const endpointOrder = ["editorial", "creative"];
  const rawImages = [];

  for (const endpoint of endpointOrder) {
    for (const phrase of phrases.slice(0, 5)) {
      try {
        const images = await searchGettyEndpoint(endpoint, phrase, Math.min(limit * 2, 50));
        for (const image of images) {
          rawImages.push({ image, endpoint, phrase });
        }
      } catch (error) {
        rawImages.push({
          image: {
            id: `${endpoint}-${phrase}`,
            title: phrase,
            caption: error.message,
            display_sizes: [],
            max_dimensions: { width: 0, height: 0 },
          },
          endpoint,
          phrase,
          error: error.message,
        });
      }
    }
  }

  const byId = new Map();
  for (const entry of rawImages) {
    const item = normalizeGettyImage(entry.image, entry.endpoint);
    if (!item.id) continue;
    if (item.longEdge > 0 && item.longEdge < minLongEdge) continue;
    const existing = byId.get(item.id);
    if (!existing) {
      byId.set(item.id, {
        ...item,
        score: scoreGettyResult(item, entry.phrase, entry.endpoint, query, team),
      });
      continue;
    }

    const candidateScore = scoreGettyResult(item, entry.phrase, entry.endpoint, query, team);
    if (candidateScore > existing.score) {
      byId.set(item.id, { ...item, score: candidateScore });
    }
  }

  const results = [...byId.values()]
    .sort((a, b) => b.score - a.score || b.longEdge - a.longEdge || a.qualityRank - b.qualityRank)
    .slice(0, limit);

  return {
    results,
    debug: {
      source: "Getty Images",
      phrases,
      endpoints: endpointOrder,
      minLongEdge,
      total: results.length,
    },
  };
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function handleSearch(req, res, requestUrl) {
  const query = cleanText(requestUrl.searchParams.get("q") || "");
  const team = cleanText(requestUrl.searchParams.get("team") || "");
  const sport = cleanText(requestUrl.searchParams.get("sport") || "any");
  const minLongEdge = Math.max(
    720,
    Math.min(8000, Number(requestUrl.searchParams.get("minLongEdge") || 1080))
  );
  const limit = Math.max(1, Math.min(60, Number(requestUrl.searchParams.get("limit") || 24)));

  if (!query) {
    return sendJson(res, 400, { error: "Please enter a player name or description." });
  }

  try {
    const payload = await searchGettyImages({
      query,
      team,
      sport,
      minLongEdge,
      limit,
    });

    sendJson(res, 200, {
      query,
      team,
      sport,
      minLongEdge,
      limit,
      ...payload,
    });
  } catch (error) {
    sendJson(res, error.code === "MISSING_GETTY_API_KEY" ? 400 : 500, {
      error: error.message || "Getty Images search failed.",
      detail: error.message,
      source: "Getty Images",
    });
  }
}

async function handleDownload(req, res) {
  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const items = Array.isArray(body.items) ? body.items.slice(0, 80) : [];

    if (!items.length) {
      return sendJson(res, 400, { error: "Select items before exporting." });
    }

    const rows = [
      ["Index", "Getty ID", "Title", "Size", "Getty URL", "Detail URL", "Source"].join(","),
      ...items.map((item, index) =>
        [
          index + 1,
          item.id,
          `"${String(item.title || "").replace(/"/g, '""')}"`,
          `${item.width || 0}x${item.height || 0}`,
          item.originalUrl || "",
          item.descriptionUrl || "",
          "Getty Images",
        ].join(",")
      ),
    ];

    const csv = `\uFEFF${rows.join("\n")}`;
    const fileName = `${sanitizeFileName(body.bundleName || "getty-images-results")}.csv`;

    res.writeHead(200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Content-Length": Buffer.byteLength(csv),
      "Cache-Control": "no-store",
    });
    res.end(csv);
  } catch (error) {
    sendJson(res, 500, {
      error: "Export failed.",
      detail: error.message,
    });
  }
}

async function readStaticFile(resolvedPath) {
  const data = await fsp.readFile(resolvedPath);
  const ext = path.extname(resolvedPath).toLowerCase();
  return {
    data,
    contentType: MIME_TYPES[ext] || "application/octet-stream",
  };
}

async function resolveStaticPath(requestPath) {
  const name = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const candidates = [path.join(PUBLIC_DIR, name), path.join(__dirname, name)];
  for (const candidate of candidates) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      // ignore
    }
  }
  return "";
}

async function serveStatic(res, requestPath) {
  const resolvedPath = await resolveStaticPath(requestPath);
  if (!resolvedPath) {
    sendText(res, 404, "Not Found");
    return;
  }

  const staticFile = await readStaticFile(resolvedPath);
  res.writeHead(200, {
    "Content-Type": staticFile.contentType,
    "Cache-Control": staticFile.contentType.includes("text/html")
      ? "no-store"
      : "public, max-age=300",
  });
  res.end(staticFile.data);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && requestUrl.pathname === "/api/search") {
    return handleSearch(req, res, requestUrl);
  }

  if (req.method === "POST" && requestUrl.pathname === "/api/download") {
    return handleDownload(req, res);
  }

  if (req.method === "GET") {
    return serveStatic(res, requestUrl.pathname);
  }

  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Getty-only image search tool running on http://localhost:${PORT}`);
});
