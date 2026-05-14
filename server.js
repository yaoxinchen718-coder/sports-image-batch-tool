const http = require("http");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const ROOT_STATIC_FILES = new Set(["index.html", "app.js", "styles.css"]);

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

const SPORT_TERMS = {
  any: [],
  football: ["football", "soccer", "足球"],
  basketball: ["basketball", "NBA", "篮球"],
  baseball: ["baseball", "MLB", "棒球"],
};

const USER_AGENT =
  "SportsImageBatchTool/1.0 (Wikimedia search and batch download)";

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let j = 0; j < 8; j += 1) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c >>> 0;
  }
  return table;
})();

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

function toArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15000),
  });

  if (!response.ok) {
    throw new Error(`Remote request failed: ${response.status}`);
  }

  return response.json();
}

async function fetchBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(30000),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: response.headers.get("content-type") || "application/octet-stream",
  };
}

function uniqueStrings(items, limit = 12) {
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

function getClaimValues(entity, property) {
  const claims = entity?.claims?.[property] || [];
  return claims
    .map((claim) => claim?.mainsnak?.datavalue?.value)
    .filter(Boolean);
}

function extractEntityContext(entity) {
  const labels = [
    entity?.labels?.zh?.value,
    entity?.labels?.en?.value,
    ...toArray(entity?.aliases?.zh).map((item) => item.value),
    ...toArray(entity?.aliases?.en).map((item) => item.value),
  ];

  const commonsCategoryClaims = getClaimValues(entity, "P373");
  const commonsSitelink = entity?.sitelinks?.commonswiki?.title;
  const imageClaims = getClaimValues(entity, "P18");

  return {
    id: entity.id,
    labels: uniqueStrings(labels, 8),
    commonsCategories: uniqueStrings(
      [
        ...commonsCategoryClaims,
        commonsSitelink?.startsWith("Category:") ? commonsSitelink.slice(9) : "",
      ],
      4
    ),
    images: uniqueStrings(imageClaims, 3),
  };
}

async function searchWikidata(term, language = "zh", limit = 5) {
  if (!cleanText(term)) return [];

  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbsearchentities");
  url.searchParams.set("search", term);
  url.searchParams.set("language", language);
  url.searchParams.set("uselang", "zh");
  url.searchParams.set("type", "item");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const data = await fetchJson(url.toString());
  return data.search || [];
}

async function getWikidataEntities(ids) {
  const cleanedIds = uniqueStrings(ids, 10);
  if (!cleanedIds.length) return [];

  const url = new URL("https://www.wikidata.org/w/api.php");
  url.searchParams.set("action", "wbgetentities");
  url.searchParams.set("ids", cleanedIds.join("|"));
  url.searchParams.set("props", "labels|aliases|claims|sitelinks");
  url.searchParams.set("languages", "zh|en");
  url.searchParams.set("format", "json");
  url.searchParams.set("origin", "*");

  const data = await fetchJson(url.toString());
  return Object.values(data.entities || {});
}

function buildSearchTerms({ query, team, sport, personContexts, teamContexts }) {
  const sportTerms = SPORT_TERMS[sport] || [];
  const personLabels = personContexts.flatMap((item) => item.labels);
  const teamLabels = teamContexts.flatMap((item) => item.labels);

  return uniqueStrings(
    [
      `${query} ${team}`.trim(),
      `${query} ${team} ${sportTerms[0] || ""}`.trim(),
      `${query} ${sportTerms[0] || ""}`.trim(),
      query,
      ...personLabels.map((label) => `${label} ${team}`.trim()),
      ...personLabels.map((label) => `${label} ${teamLabels[0] || ""}`.trim()),
      ...personLabels,
      ...teamLabels.map((label) => `${query} ${label}`.trim()),
      ...sportTerms.map((term) => `${query} ${term}`.trim()),
    ],
    12
  );
}

function commonsApiBase() {
  const url = new URL("https://commons.wikimedia.org/w/api.php");
  url.searchParams.set("action", "query");
  url.searchParams.set("prop", "imageinfo|info");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "800");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");
  return url;
}

function normalizeCommonsPage(page, reason) {
  const info = page?.imageinfo?.[0];
  if (!page || !info?.url) return null;

  const width = Number(info.width || 0);
  const height = Number(info.height || 0);
  const title = cleanText(page.title?.replace(/^File:/, ""));
  const mime = info.mime || "image/jpeg";
  const ext = mime.split("/")[1] || "jpg";
  const meta = info.extmetadata || {};

  return {
    id: page.pageid || title,
    pageTitle: page.title,
    title,
    width,
    height,
    longEdge: Math.max(width, height),
    shortEdge: Math.min(width, height),
    area: width * height,
    mime,
    ext,
    previewUrl: info.thumburl || info.url,
    originalUrl: info.url,
    descriptionUrl: page.fullurl || `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
    license: cleanText(meta.LicenseShortName?.value || meta.License?.value || "Unknown"),
    author: cleanText(meta.Artist?.value || "Unknown"),
    credit: cleanText(meta.Credit?.value || ""),
    sourceName: "Wikimedia Commons",
    reason,
  };
}

async function searchCommonsFiles(term, limit = 18) {
  const url = commonsApiBase();
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrsearch", term);
  url.searchParams.set("gsrlimit", String(limit));

  const data = await fetchJson(url.toString());
  const pages = data?.query?.pages || [];
  return pages
    .map((page) => normalizeCommonsPage(page, `关键词匹配: ${term}`))
    .filter(Boolean);
}

async function searchCommonsCategory(categoryName, limit = 18) {
  const url = commonsApiBase();
  url.searchParams.set("generator", "categorymembers");
  url.searchParams.set("gcmtitle", `Category:${categoryName}`);
  url.searchParams.set("gcmtype", "file");
  url.searchParams.set("gcmlimit", String(limit));

  const data = await fetchJson(url.toString());
  const pages = data?.query?.pages || [];
  return pages
    .map((page) => normalizeCommonsPage(page, `分类匹配: ${categoryName}`))
    .filter(Boolean);
}

function buildWikidataImageUrl(fileName) {
  const title = `File:${fileName}`;
  return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}`;
}

function scoreResult(item, query, team) {
  const title = `${item.title} ${item.reason}`.toLowerCase();
  let score = 0;

  if (cleanText(query) && title.includes(cleanText(query).toLowerCase())) score += 24;
  if (cleanText(team) && title.includes(cleanText(team).toLowerCase())) score += 16;
  if (item.reason.startsWith("分类匹配")) score += 18;
  if (item.reason.startsWith("Wikidata")) score += 20;
  score += Math.min(item.longEdge / 150, 30);
  score += Math.min(item.area / 400000, 20);
  return score;
}

async function gatherSearchResults({ query, team, sport, minLongEdge, limit }) {
  const [personSearch, teamSearch] = await Promise.all([
    searchWikidata(query, "zh", 5),
    team ? searchWikidata(team, "zh", 5) : Promise.resolve([]),
  ]);

  const personEntities = await getWikidataEntities(personSearch.map((item) => item.id));
  const teamEntities = await getWikidataEntities(teamSearch.map((item) => item.id));
  const personContexts = personEntities.map(extractEntityContext);
  const teamContexts = teamEntities.map(extractEntityContext);
  const searchTerms = buildSearchTerms({
    query,
    team,
    sport,
    personContexts,
    teamContexts,
  });

  const categoryNames = uniqueStrings(
    [
      ...personContexts.flatMap((item) => item.commonsCategories),
      ...teamContexts.flatMap((item) => item.commonsCategories),
    ],
    4
  );

  const wikidataImages = uniqueStrings(
    personContexts.flatMap((item) => item.images),
    3
  ).map((fileName) => ({
    id: `wikidata-${fileName}`,
    pageTitle: `File:${fileName}`,
    title: fileName,
    width: 0,
    height: 0,
    longEdge: 0,
    shortEdge: 0,
    area: 0,
    mime: "image/jpeg",
    ext: path.extname(fileName).replace(".", "") || "jpg",
    previewUrl: buildWikidataImageUrl(fileName),
    originalUrl: buildWikidataImageUrl(fileName),
    descriptionUrl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(fileName)}`,
    license: "See file page",
    author: "See file page",
    credit: "",
    sourceName: "Wikidata image",
    reason: "Wikidata 人物图",
  }));

  const termJobs = searchTerms.slice(0, 6).map((term) => searchCommonsFiles(term, 18));
  const categoryJobs = categoryNames.slice(0, 3).map((category) => searchCommonsCategory(category, 18));
  const settled = await Promise.allSettled([...termJobs, ...categoryJobs]);

  const merged = [...wikidataImages];
  for (const result of settled) {
    if (result.status === "fulfilled") {
      merged.push(...result.value);
    }
  }

  const byUrl = new Map();
  for (const item of merged) {
    if (!item.originalUrl) continue;
    const key = item.originalUrl;
    const existing = byUrl.get(key);
    if (!existing) {
      byUrl.set(key, item);
      continue;
    }

    if (item.reason.startsWith("分类匹配") && !existing.reason.startsWith("分类匹配")) {
      byUrl.set(key, item);
    }
  }

  const results = [...byUrl.values()]
    .filter((item) => item.longEdge >= minLongEdge || item.longEdge === 0)
    .map((item) => ({
      ...item,
      score: scoreResult(item, query, team),
    }))
    .sort((a, b) => b.score - a.score || b.longEdge - a.longEdge)
    .slice(0, limit);

  return {
    results,
    debug: {
      searchTerms,
      categoryNames,
      personCandidates: personSearch.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
      })),
      teamCandidates: teamSearch.map((item) => ({
        id: item.id,
        label: item.label,
        description: item.description,
      })),
    },
  };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    ((date.getHours() & 0x1f) << 11) |
    ((date.getMinutes() & 0x3f) << 5) |
    ((Math.floor(date.getSeconds() / 2)) & 0x1f);
  const dosDate =
    (((year - 1980) & 0x7f) << 9) |
    (((date.getMonth() + 1) & 0x0f) << 5) |
    (date.getDate() & 0x1f);
  return { dosDate, dosTime };
}

function createZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosDate, dosTime } = dosDateTime();

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, "utf8");
    const data = file.data;
    const crc = crc32(data);
    const size = data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    const localPart = Buffer.concat([localHeader, nameBuffer, data]);
    localParts.push(localPart);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    const centralPart = Buffer.concat([centralHeader, nameBuffer]);
    centralParts.push(centralPart);
    offset += localPart.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const localDirectory = Buffer.concat(localParts);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(files.length, 8);
  endRecord.writeUInt16LE(files.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(localDirectory.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localDirectory, centralDirectory, endRecord]);
}

async function handleSearch(req, res, requestUrl) {
  const query = cleanText(requestUrl.searchParams.get("q") || "");
  const team = cleanText(requestUrl.searchParams.get("team") || "");
  const sport = cleanText(requestUrl.searchParams.get("sport") || "any");
  const minLongEdge = Math.max(
    1000,
    Math.min(8000, Number(requestUrl.searchParams.get("minLongEdge") || 2048))
  );
  const limit = Math.max(1, Math.min(60, Number(requestUrl.searchParams.get("limit") || 24)));

  if (!query) {
    return sendJson(res, 400, { error: "请输入人物名称或人物描述。" });
  }

  try {
    const payload = await gatherSearchResults({
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
    sendJson(res, 500, {
      error: "搜索失败，请稍后重试。",
      detail: error.message,
    });
  }
}

function inferExtension(item, contentType) {
  const contentTypeMap = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  if (item.ext) return item.ext.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (contentTypeMap[contentType]) return contentTypeMap[contentType];

  try {
    const pathname = new URL(item.originalUrl).pathname;
    return path.extname(pathname).replace(".", "") || "jpg";
  } catch {
    return "jpg";
  }
}

async function handleDownload(req, res) {
  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const items = Array.isArray(body.items) ? body.items.slice(0, 50) : [];

    if (!items.length) {
      return sendJson(res, 400, { error: "请先勾选需要下载的图片。" });
    }

    const allowedHosts = new Set([
      "upload.wikimedia.org",
      "commons.wikimedia.org",
    ]);

    const downloadedFiles = [];

    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (!item?.originalUrl) continue;

      const parsedUrl = new URL(item.originalUrl);
      if (!allowedHosts.has(parsedUrl.hostname)) continue;

      const { buffer, contentType } = await fetchBuffer(item.originalUrl);
      const ext = inferExtension(item, contentType);
      const baseName = sanitizeFileName(item.title || `image-${index + 1}`, `image-${index + 1}`);
      downloadedFiles.push({
        name: `${String(index + 1).padStart(2, "0")}-${baseName}.${ext}`,
        data: buffer,
      });
    }

    if (!downloadedFiles.length) {
      return sendJson(res, 400, { error: "没有可下载的有效图片。" });
    }

    const zipBuffer = createZip(downloadedFiles);
    const fileName = `${sanitizeFileName(body.bundleName || "sports-images")}.zip`;

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Content-Length": zipBuffer.length,
      "Cache-Control": "no-store",
    });
    res.end(zipBuffer);
  } catch (error) {
    sendJson(res, 500, {
      error: "打包下载失败，请稍后再试。",
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

async function serveStatic(res, filePath) {
  try {
    const resolvedPath = path.normalize(filePath);
    const isPublicFile = resolvedPath.startsWith(PUBLIC_DIR);
    const isRootFallbackFile =
      path.dirname(resolvedPath) === __dirname &&
      ROOT_STATIC_FILES.has(path.basename(resolvedPath));

    if (!isPublicFile && !isRootFallbackFile) {
      return sendText(res, 403, "Forbidden");
    }

    let staticFile;
    try {
      staticFile = await readStaticFile(resolvedPath);
    } catch (error) {
      const fallbackPath = path.join(__dirname, path.basename(resolvedPath));
      const canFallbackToRoot =
        isPublicFile && ROOT_STATIC_FILES.has(path.basename(resolvedPath));

      if (!canFallbackToRoot) {
        throw error;
      }

      staticFile = await readStaticFile(fallbackPath);
    }

    res.writeHead(200, {
      "Content-Type": staticFile.contentType,
      "Cache-Control": staticFile.contentType.includes("text/html")
        ? "no-store"
        : "public, max-age=300",
    });
    res.end(staticFile.data);
  } catch {
    sendText(res, 404, "Not Found");
  }
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
    const staticName = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const requestedPath =
      requestUrl.pathname === "/" || ROOT_STATIC_FILES.has(staticName)
        ? path.join(PUBLIC_DIR, staticName)
        : path.join(PUBLIC_DIR, requestUrl.pathname);
    return serveStatic(res, requestedPath);
  }

  sendText(res, 405, "Method Not Allowed");
});

server.listen(PORT, () => {
  console.log(`Sports image batch tool running on http://localhost:${PORT}`);
});
