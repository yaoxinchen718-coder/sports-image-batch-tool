const http = require("http");
const fsp = require("fs/promises");
const path = require("path");
const zlib = require("zlib");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const COMMONS_API = "https://commons.wikimedia.org/w/api.php";
const USER_AGENT =
  "sports-image-batch-tool/1.0 (no-key demo; Wikimedia Commons image search)";

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

const SPORT_TERMS = {
  any: [],
  football: ["association football", "soccer", "football"],
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
  { tests: [/\u8a79\u59c6\u65af|\u52d2\u5e03\u6717|lebron/i], value: "LeBron James" },
  { tests: [/\u5e93\u91cc|curry/i], value: "Stephen Curry" },
  { tests: [/\u675c\u5170\u7279|durant/i], value: "Kevin Durant" },
  { tests: [/\u7ea6\u57fa\u5947|jokic/i], value: "Nikola Jokic" },
  { tests: [/\u4e1c\u5951\u5947|doncic/i], value: "Luka Doncic" },
  { tests: [/\u79d1\u6bd4|kobe/i], value: "Kobe Bryant" },
  { tests: [/\u4e54\u4e39|jordan/i], value: "Michael Jordan" },
  { tests: [/\u5927\u8c37\u7fd4\u5e73|ohtani/i], value: "Shohei Ohtani" },
  { tests: [/\u8d1d\u514b\u6c49\u59c6|beckham/i], value: "David Beckham" },
  { tests: [/\u6e56\u4eba|lakers/i], value: "Los Angeles Lakers" },
  { tests: [/\u52c7\u58eb|warriors/i], value: "Golden State Warriors" },
  { tests: [/\u51ef\u5c14\u7279\u4eba|celtics/i], value: "Boston Celtics" },
  { tests: [/\u5c3c\u514b\u65af|knicks/i], value: "New York Knicks" },
  { tests: [/\u626c\u57fa|yankees/i], value: "New York Yankees" },
  { tests: [/\u9053\u5947|dodgers/i], value: "Los Angeles Dodgers" },
  { tests: [/\u66fc\u8054|manchester\s*united/i], value: "Manchester United" },
  { tests: [/\u7687\u9a6c|real\s*madrid/i], value: "Real Madrid" },
  { tests: [/\u5df4\u8428|barcelona/i], value: "Barcelona" },
  { tests: [/\u62dc\u4ec1|bayern/i], value: "Bayern Munich" },
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
    .trim()
    .slice(0, 120);
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

function getMeta(meta = {}, key) {
  return cleanText(meta?.[key]?.value || "");
}

function translateHints(text) {
  const value = cleanText(text);
  const hints = [];

  for (const hint of TRANSLATION_HINTS) {
    if (hint.tests.some((pattern) => pattern.test(value))) {
      hints.push(hint.value);
    }
  }

  return uniqueStrings([value, ...hints], 8);
}

function buildSearchPhrases({ query, team, sport }) {
  const queryHints = translateHints(query);
  const teamHints = translateHints(team);
  const sportTerms = SPORT_TERMS[sport] || [];
  const primaryQuery = queryHints.find((value) => /[a-z]/i.test(value)) || queryHints[0] || query;
  const primaryTeam = teamHints.find((value) => /[a-z]/i.test(value)) || teamHints[0] || team;

  return uniqueStrings(
    [
      `${primaryQuery} ${primaryTeam}`.trim(),
      `${primaryQuery} ${sportTerms[0] || ""}`.trim(),
      `${primaryQuery} portrait`.trim(),
      `${primaryQuery} jersey`.trim(),
      `${primaryQuery} match`.trim(),
      `${query} ${team}`.trim(),
      ...teamHints.map((value) => `${primaryQuery} ${value}`.trim()),
      ...sportTerms.map((term) => `${primaryQuery} ${term}`.trim()),
      ...queryHints,
    ],
    10
  );
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
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
    throw new Error(body?.error?.info || body?.message || `Request failed: ${response.status}`);
  }

  return body;
}

async function searchCommonsPhrase(phrase, pageSize) {
  const url = new URL(COMMONS_API);
  url.searchParams.set("action", "query");
  url.searchParams.set("generator", "search");
  url.searchParams.set("gsrsearch", phrase);
  url.searchParams.set("gsrnamespace", "6");
  url.searchParams.set("gsrlimit", String(pageSize));
  url.searchParams.set("prop", "imageinfo");
  url.searchParams.set("iiprop", "url|size|mime|extmetadata");
  url.searchParams.set("iiurlwidth", "1200");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("origin", "*");

  const data = await fetchJson(url.toString());
  return Array.isArray(data?.query?.pages) ? data.query.pages : [];
}

function normalizeCommonsPage(page, phrase) {
  const imageInfo = Array.isArray(page.imageinfo) ? page.imageinfo[0] : null;
  if (!imageInfo?.url) return null;

  const meta = imageInfo.extmetadata || {};
  const title = cleanText(page.title || getMeta(meta, "ObjectName") || "Commons image");
  const readableTitle = title.replace(/^File:/i, "").replace(/\.[a-z0-9]+$/i, "");
  const description = getMeta(meta, "ImageDescription");
  const categories = getMeta(meta, "Categories");
  const date = getMeta(meta, "DateTimeOriginal") || getMeta(meta, "DateTime");
  const author = getMeta(meta, "Artist") || getMeta(meta, "Credit") || "Wikimedia Commons";
  const license =
    getMeta(meta, "LicenseShortName") || getMeta(meta, "UsageTerms") || "Open license";
  const width = Number(imageInfo.width || 0);
  const height = Number(imageInfo.height || 0);
  const sourceId = String(page.pageid || page.title || imageInfo.url);
  const ext = path.extname(new URL(imageInfo.url).pathname).replace(".", "").toLowerCase() || "jpg";

  return {
    id: `commons-${sourceId}`,
    pageTitle: title,
    title: readableTitle,
    width,
    height,
    longEdge: Math.max(width, height),
    shortEdge: Math.min(width, height),
    area: width * height,
    mime: imageInfo.mime || "image/jpeg",
    ext,
    previewUrl: imageInfo.thumburl || imageInfo.url,
    originalUrl: imageInfo.url,
    descriptionUrl: imageInfo.descriptionurl || imageInfo.descriptionshorturl || imageInfo.url,
    license,
    author,
    credit: getMeta(meta, "Credit"),
    sourceName: "Wikimedia Commons",
    reason: [date, categories].filter(Boolean).join(" | ") || phrase,
    caption: description,
    phrase,
  };
}

function scoreResult(item, phrase, query, team, sport) {
  const haystack = `${item.title} ${item.caption} ${item.reason}`.toLowerCase();
  const queryHints = translateHints(query).map((value) => value.toLowerCase());
  const teamHints = translateHints(team).map((value) => value.toLowerCase());
  const sportTerms = (SPORT_TERMS[sport] || []).map((value) => value.toLowerCase());
  let score = 0;

  for (const hint of queryHints) {
    if (hint && haystack.includes(hint)) score += /[a-z]/i.test(hint) ? 35 : 16;
  }

  for (const hint of teamHints) {
    if (hint && haystack.includes(hint)) score += /[a-z]/i.test(hint) ? 18 : 8;
  }

  for (const term of sportTerms) {
    if (term && haystack.includes(term)) score += 8;
  }

  if (phrase && haystack.includes(phrase.toLowerCase())) score += 10;
  if (/portrait|headshot|media day|profile/i.test(haystack)) score += 12;
  if (/team photo|group|lineup|squad/i.test(haystack)) score -= 10;
  if (/logo|svg|icon|flag|map|diagram/i.test(haystack)) score -= 40;
  score += Math.min(item.longEdge / 120, 35);
  score += Math.min(item.area / 500000, 25);
  return score;
}

async function searchImages({ query, team, sport, minLongEdge, limit }) {
  const phrases = buildSearchPhrases({ query, team, sport });
  const rawPages = [];

  for (const phrase of phrases.slice(0, 8)) {
    try {
      const pages = await searchCommonsPhrase(phrase, Math.min(30, Math.max(12, limit)));
      for (const page of pages) rawPages.push({ page, phrase });
    } catch {
      // Keep searching with the next phrase if Commons rejects or times out.
    }
  }

  const byId = new Map();
  for (const entry of rawPages) {
    const item = normalizeCommonsPage(entry.page, entry.phrase);
    if (!item) continue;
    if (!/^image\//i.test(item.mime)) continue;
    if (item.longEdge > 0 && item.longEdge < minLongEdge) continue;
    const score = scoreResult(item, entry.phrase, query, team, sport);
    const existing = byId.get(item.id);
    if (!existing || score > existing.score) byId.set(item.id, { ...item, score });
  }

  const results = [...byId.values()]
    .sort((a, b) => b.score - a.score || b.longEdge - a.longEdge || b.area - a.area)
    .slice(0, limit);

  return {
    results,
    debug: {
      source: "Wikimedia Commons",
      phrases,
      minLongEdge,
      total: results.length,
      noApiKeyRequired: true,
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

async function getRemoteBuffer(url) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(25000),
  });

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const dosTime =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosTime, dosDate };
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const { dosTime, dosDate } = dosDateTime();

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, "utf8");
    const compressed = zlib.deflateRawSync(entry.data);
    const checksum = crc32(entry.data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressed.length, 18);
    localHeader.writeUInt32LE(entry.data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);

    localParts.push(localHeader, nameBuffer, compressed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressed.length, 20);
    centralHeader.writeUInt32LE(entry.data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(entries.length, 8);
  endRecord.writeUInt16LE(entries.length, 10);
  endRecord.writeUInt32LE(centralDirectory.length, 12);
  endRecord.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
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
    const payload = await searchImages({ query, team, sport, minLongEdge, limit });
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
      error: error.message || "Image search failed.",
      detail: error.message,
      source: "Wikimedia Commons",
    });
  }
}

async function handleDownload(req, res) {
  try {
    const rawBody = await readBody(req);
    const body = JSON.parse(rawBody || "{}");
    const items = Array.isArray(body.items) ? body.items.slice(0, 40) : [];

    if (!items.length) {
      return sendJson(res, 400, { error: "Select items before downloading." });
    }

    const entries = [];
    const manifestRows = [
      ["Index", "File", "Title", "Size", "Source", "License", "Author", "Original URL", "Detail URL"].join(","),
    ];

    for (const [index, item] of items.entries()) {
      try {
        const url = item.originalUrl || item.previewUrl;
        if (!url || !/^https?:\/\//i.test(url)) continue;
        const data = await getRemoteBuffer(url);
        const ext = sanitizeFileName(item.ext || path.extname(new URL(url).pathname).replace(".", "") || "jpg");
        const name = `${String(index + 1).padStart(2, "0")}-${sanitizeFileName(item.title, "sports-image")}.${ext}`;
        entries.push({ name, data });
        manifestRows.push(
          [
            index + 1,
            `"${name.replace(/"/g, '""')}"`,
            `"${String(item.title || "").replace(/"/g, '""')}"`,
            `${item.width || 0}x${item.height || 0}`,
            `"${String(item.sourceName || "").replace(/"/g, '""')}"`,
            `"${String(item.license || "").replace(/"/g, '""')}"`,
            `"${String(item.author || "").replace(/"/g, '""')}"`,
            item.originalUrl || "",
            item.descriptionUrl || "",
          ].join(",")
        );
      } catch {
        // Skip individual files that fail, and still return the rest.
      }
    }

    if (!entries.length) {
      return sendJson(res, 502, { error: "No selected images could be downloaded." });
    }

    entries.push({
      name: "image-sources.csv",
      data: Buffer.from(`\uFEFF${manifestRows.join("\n")}`, "utf8"),
    });

    const zip = createZip(entries);
    const fileName = `${sanitizeFileName(body.bundleName || "sports-images")}.zip`;

    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "Content-Length": zip.length,
      "Cache-Control": "no-store",
    });
    res.end(zip);
  } catch (error) {
    sendJson(res, 500, {
      error: "Download failed.",
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
  console.log(`No-key sports image search tool running on http://localhost:${PORT}`);
});
