import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { URL, URLSearchParams } from "node:url";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createPhotosPicker } from "./photos-picker.mjs";
import { createUpdateControl } from "./phone-updates.mjs";

const ROOT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(ROOT_DIR, "static");
const APP_MODE = (process.env.APP_MODE || "demo").trim().toLowerCase();
const HOST = process.env.APP_HOST || "0.0.0.0";
const PORT = Number(process.env.APP_PORT || 8080);
const TIMEZONE = process.env.TIMEZONE || "America/Regina";
const SYNC_INTERVAL_MIN = clampInteger(process.env.CALENDAR_SYNC_INTERVAL_MIN || 15, 5, 1440);
const DATA_DIR = path.resolve(process.env.APP_DATA_DIR || path.join(ROOT_DIR, "data"));
const DB_PATH = path.join(DATA_DIR, "calendar.sqlite");
const PHOTO_ORIGINAL_DIR = path.join(DATA_DIR, "photos", "original");
const PHOTO_DISPLAY_DIR = path.join(DATA_DIR, "photos", "display");
const SECRET_DIR = path.join(DATA_DIR, "secrets");
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;
const MAX_PHOTOS = clampInteger(process.env.MAX_PHOTOS || 500, 1, 5000);
const MAX_PHOTO_STORAGE_BYTES = clampNumber(process.env.MAX_PHOTO_STORAGE_BYTES || 2 * 1024 ** 3, 50 * 1024 ** 2, 20 * 1024 ** 3);
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const COOKIE_NAME = "family_calendar_session";
const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()"
};

const DEFAULT_SETTINGS = {
  view: "week",
  anchor_date: todayKey(),
  week_start: "monday",
  slideshow_seconds: "12",
  show_photo_captions: "false",
  overnight_enabled: "true",
  overnight_start: "22:30",
  overnight_end: "06:30",
  display_title: "Our family week"
};

const DEMO_PHOTOS = [
  {
    id: "demo-sunset",
    original_name: "sample-family-sunset.svg",
    url: "/static/demo-photo-sunset.svg",
    width: 1600,
    height: 900,
    demo: true
  },
  {
    id: "demo-picnic",
    original_name: "sample-lake-picnic.svg",
    url: "/static/demo-photo-picnic.svg",
    width: 1600,
    height: 900,
    demo: true
  },
  {
    id: "demo-kitchen",
    original_name: "sample-kitchen.svg",
    url: "/static/demo-photo-kitchen.svg",
    width: 1600,
    height: 900,
    demo: true
  }
];

await initializeStorage();
const db = new DatabaseSync(DB_PATH);
initializeDatabase();
initializeDefaultSettings();
try { fs.chmodSync(DB_PATH, 0o600); } catch { /* Windows does not expose POSIX modes. */ }

let sharp = null;
try {
  const sharpModule = await import("sharp");
  sharp = sharpModule.default;
  sharp.concurrency(1);
  sharp.cache({ memory: 32, files: 0, items: 20 });
} catch {
  // Photo uploads explain the missing optional runtime dependency to the caller.
}

const sessions = new Map();
const oauthStates = new Map();
const loginAttempts = new Map();
const updateClients = new Set();
let syncInProgress = false;
let accountMutationInProgress = false;
let calendarRevision = 0;
let uploadQueue = Promise.resolve();
let pendingUploads = 0;
const INSTANCE_ID = randomBytes(12).toString('hex');
const phoneUpdates = createUpdateControl({ dataDir: DATA_DIR, mode: APP_MODE });
let photosConnecting = false;
const PHOTOS_SCOPE = "https://www.googleapis.com/auth/photospicker.mediaitems.readonly";
const pickerAccount = { token_path: path.join("secrets", "google-photos-picker.json") };
const picker = createPhotosPicker({
  connected: () => fs.existsSync(safeDataPath(pickerAccount.token_path)),
  accessToken: async () => {
    try { return await getAccessToken(pickerAccount); }
    catch { throw httpError(401, "Google Photos access expired. Reconnect Google Photos on the Pi."); }
  },
  api: async (url, options) => {
    try { return await googleJsonForAccount(pickerAccount, url, options); }
    catch (error) {
      if ([404, 410].includes(error.statusCode)) throw httpError(410, "Google Photos selection expired. Start a new selection.");
      if (error.statusCode === 403) throw httpError(403, "Enable Google Photos Picker API in Google Cloud and connect Google Photos again if permission expired.");
      throw httpError(502, "Google Photos could not be reached or its connection expired. Retry, or reconnect Google Photos on the Pi.");
    }
  },
  withSlot: withUploadSlot,
  hasPhoto: (id) => Boolean(db.prepare("SELECT id FROM photos WHERE id=?").get(id)),
  savePhoto: (data, filename, id) => processPhotoPart({ data, filename }, id)
});

function clampInteger(value, min, max) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.min(max, Math.max(min, number));
}

async function initializeStorage() {
  await fsp.mkdir(PHOTO_ORIGINAL_DIR, { recursive: true });
  await fsp.mkdir(PHOTO_DISPLAY_DIR, { recursive: true });
  await fsp.mkdir(SECRET_DIR, { recursive: true });
  for (const directory of [DATA_DIR, PHOTO_ORIGINAL_DIR, PHOTO_DISPLAY_DIR, SECRET_DIR]) {
    try { await fsp.chmod(directory, 0o700); } catch { /* Windows does not expose POSIX modes. */ }
  }
}

function initializeDatabase() {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS photos (
      id TEXT PRIMARY KEY,
      original_name TEXT NOT NULL,
      original_path TEXT NOT NULL,
      display_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      sha256 TEXT NOT NULL UNIQUE,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS google_accounts (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      email TEXT,
      token_path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_error TEXT
    );

    CREATE TABLE IF NOT EXISTS calendar_sources (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      description TEXT,
      color TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      UNIQUE(account_id, calendar_id)
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      account_id TEXT NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
      calendar_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      all_day INTEGER NOT NULL DEFAULT 0,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      start_local TEXT,
      end_local TEXT,
      start_ms INTEGER,
      end_ms INTEGER,
      color TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      updated_at TEXT NOT NULL,
      PRIMARY KEY(account_id, calendar_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS sync_status (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_attempt_at TEXT,
      last_success_at TEXT,
      error TEXT
    );

    INSERT OR IGNORE INTO sync_status(id) VALUES (1);
  `);

  const version = Number(getSetting("schema_version") || 0);
  if (version < 1) setSetting("schema_version", "1");
}

function initializeDefaultSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)").run(key, String(value));
  }
}

function getSetting(key) {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row?.value ?? null;
}

function setSetting(key, value) {
  db.prepare(`
    INSERT INTO settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, String(value));
}

function readSettings() {
  const values = Object.fromEntries(db.prepare("SELECT key, value FROM settings").all().map((row) => [row.key, row.value]));
  return {
    view: values.view === "month" ? "month" : "week",
    anchor_date: isDateKey(values.anchor_date) ? values.anchor_date : todayKey(),
    week_start: values.week_start === "sunday" ? "sunday" : "monday",
    slideshow_seconds: clampInteger(values.slideshow_seconds || 12, 5, 60),
    show_photo_captions: values.show_photo_captions === "true",
    overnight_enabled: values.overnight_enabled !== "false",
    overnight_start: isTimeKey(values.overnight_start) ? values.overnight_start : "22:30",
    overnight_end: isTimeKey(values.overnight_end) ? values.overnight_end : "06:30",
    display_title: String(values.display_title || DEFAULT_SETTINGS.display_title).slice(0, 80)
  };
}

function updateSettings(patch) {
  const current = readSettings();
  const next = { ...current };
  if (patch.view !== undefined) {
    if (!['week', 'month'].includes(patch.view)) throw httpError(400, "view must be week or month");
    next.view = patch.view;
  }
  if (patch.anchor_date !== undefined) {
    if (!isDateKey(patch.anchor_date)) throw httpError(400, "anchor_date must be YYYY-MM-DD");
    next.anchor_date = patch.anchor_date;
  }
  if (patch.week_start !== undefined) {
    if (!['monday', 'sunday'].includes(patch.week_start)) throw httpError(400, "week_start must be monday or sunday");
    next.week_start = patch.week_start;
  }
  if (patch.slideshow_seconds !== undefined) {
    const seconds = Number(patch.slideshow_seconds);
    if (!Number.isInteger(seconds) || seconds < 5 || seconds > 60) {
      throw httpError(400, "slideshow_seconds must be between 5 and 60");
    }
    next.slideshow_seconds = seconds;
  }
  if (patch.overnight_enabled !== undefined) next.overnight_enabled = Boolean(patch.overnight_enabled);
  if (patch.show_photo_captions !== undefined) {
    if (typeof patch.show_photo_captions !== "boolean") throw httpError(400, "show_photo_captions must be true or false");
    next.show_photo_captions = patch.show_photo_captions;
  }
  if (patch.overnight_start !== undefined) {
    if (!isTimeKey(patch.overnight_start)) throw httpError(400, "overnight_start must be HH:MM");
    next.overnight_start = patch.overnight_start;
  }
  if (patch.overnight_end !== undefined) {
    if (!isTimeKey(patch.overnight_end)) throw httpError(400, "overnight_end must be HH:MM");
    next.overnight_end = patch.overnight_end;
  }
  if (patch.display_title !== undefined) next.display_title = String(patch.display_title).trim().slice(0, 80) || DEFAULT_SETTINGS.display_title;

  for (const key of Object.keys(DEFAULT_SETTINGS)) setSetting(key, next[key]);
  return next;
}

function isDateKey(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = dateKeyToDate(value);
  return !Number.isNaN(date.getTime()) && date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}

function isTimeKey(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function todayKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function dateKeyToDate(key) {
  return new Date(`${key}T12:00:00Z`);
}

function dateToKey(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(key, amount) {
  const date = dateKeyToDate(key);
  date.setUTCDate(date.getUTCDate() + amount);
  return dateToKey(date);
}

function addMonths(key, amount) {
  const date = dateKeyToDate(key);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + amount);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return dateToKey(date);
}

function dayOfWeek(key) {
  return dateKeyToDate(key).getUTCDay();
}

function startOfWeek(key, weekStart) {
  const day = dayOfWeek(key);
  const first = weekStart === "sunday" ? 0 : 1;
  const distance = (day - first + 7) % 7;
  return addDays(key, -distance);
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function periodRange(settings = readSettings()) {
  if (settings.view === "month") {
    const anchor = dateKeyToDate(settings.anchor_date);
    const monthStart = `${anchor.getUTCFullYear()}-${String(anchor.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const gridStart = startOfWeek(monthStart, settings.week_start);
    const gridEnd = addDays(gridStart, 42);
    return { start: gridStart, end: gridEnd };
  }
  const start = startOfWeek(settings.anchor_date, settings.week_start);
  return { start, end: addDays(start, 7) };
}

function getPeriodInfo(settings = readSettings()) {
  const range = periodRange(settings);
  return { ...range, view: settings.view };
}

function getSyncStatus() {
  const row = db.prepare("SELECT last_attempt_at, last_success_at, error FROM sync_status WHERE id = 1").get() || {};
  const stale = APP_MODE === "production" && (!row.last_success_at || row.error || Date.now() - Date.parse(row.last_success_at) > SYNC_INTERVAL_MIN * 2 * 60_000);
  return {
    mode: APP_MODE,
    last_attempt_at: row.last_attempt_at || null,
    last_success_at: row.last_success_at || null,
    error: row.error || null,
    stale: Boolean(stale),
    label: APP_MODE === "demo" ? "Demo content" : stale ? "Calendar sync needs attention" : "Calendar synced"
  };
}

function getPhotoRows() {
  const rows = db.prepare(`
    SELECT id, original_name, display_path, mime_type, width, height, bytes, created_at
    FROM photos ORDER BY created_at DESC LIMIT ?
  `).all(MAX_PHOTOS);
  return rows.map((row) => ({
    id: row.id,
    original_name: row.original_name,
    url: `/media/display/${encodeURIComponent(row.id)}.jpg`,
    mime_type: row.mime_type,
    width: row.width,
    height: row.height,
    bytes: row.bytes,
    created_at: row.created_at,
    demo: false
  }));
}

function getPhotos() {
  const uploaded = getPhotoRows();
  return APP_MODE === "demo" ? [...DEMO_PHOTOS, ...uploaded] : uploaded;
}

function getStatePayload() {
  const settings = readSettings();
  return {
    mode: APP_MODE,
    timezone: TIMEZONE,
    today: todayKey(),
    settings,
    period: getPeriodInfo(settings),
    calendar: { ...getSyncStatus(), revision: calendarRevision },
    photo_count: getPhotos().length,
    server_time: new Date().toISOString(),
    instance_id: INSTANCE_ID
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(body);
}

function sendText(res, status, text, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers });
  res.end(text);
}

function redirect(res, location) {
  res.writeHead(302, { ...SECURITY_HEADERS, Location: location, "Cache-Control": "no-store" });
  res.end();
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function parseCookies(value = "") {
  return Object.fromEntries(value.split(";").map((part) => part.trim().split("=")).filter(([key, val]) => key && val).map(([key, ...rest]) => [key, rest.join("=")]));
}

function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie || "")[COOKIE_NAME];
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, ...session };
}

function requireAdmin(req) {
  const session = sessionFromRequest(req);
  if (!session) throw httpError(401, "Pair this browser before using household controls");
  return session;
}

function adminPinIsConfigured() {
  const configured = (process.env.ADMIN_PIN || "").trim();
  return APP_MODE === "demo" || Boolean(configured && configured !== "change-this-before-production");
}

function verifyPin(candidate) {
  const configured = APP_MODE === "demo" ? "1234" : (process.env.ADMIN_PIN || "").trim();
  if (!configured || typeof candidate !== "string") return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(configured);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loginAttemptKey(req) {
  return req.socket?.remoteAddress || "unknown";
}

function checkLoginLimit(req) {
  const key = loginAttemptKey(req);
  const attempt = loginAttempts.get(key);
  if (attempt?.blockedUntil > Date.now()) throw httpError(429, "Too many pairing attempts; wait a minute and try again");
  if (attempt?.blockedUntil) loginAttempts.delete(key);
}

function recordLoginFailure(req) {
  const key = loginAttemptKey(req);
  const current = loginAttempts.get(key) || { count: 0 };
  current.count += 1;
  if (current.count >= 5) current.blockedUntil = Date.now() + 60_000;
  loginAttempts.set(key, current);
}

function clearLoginFailures(req) {
  loginAttempts.delete(loginAttemptKey(req));
}

function setSessionCookie(res, token, maxAge = Math.floor(SESSION_TTL_MS / 1000)) {
  // OAuth returns to this browser through a top-level GET from Google. Lax
  // keeps the session cookie for that callback while still withholding it
  // from cross-site POST requests.
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`);
}

function broadcastState() {
  const payload = `event: state\ndata: ${JSON.stringify(getStatePayload())}\n\n`;
  for (const client of updateClients) {
    try {
      client.write(payload);
    } catch {
      updateClients.delete(client);
    }
  }
}

function readRequestBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        rejected = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (rejected) reject(httpError(413, "Request is larger than the configured upload limit"));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", (error) => reject(error));
  });
}

async function readJson(req, maxBytes = 256 * 1024) {
  const body = await readRequestBody(req, maxBytes);
  try {
    return JSON.parse(body.toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || "");
  if (!match) throw httpError(400, "Multipart boundary is missing");
  const boundary = Buffer.from(`--${match[1] || match[2]}`);
  const parts = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor >= 0) {
    cursor += boundary.length;
    if (buffer.subarray(cursor, cursor + 2).toString() === "--") break;
    if (buffer.subarray(cursor, cursor + 2).toString() === "\r\n") cursor += 2;
    const headersEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), cursor);
    if (headersEnd < 0) break;
    const headers = Object.fromEntries(buffer.subarray(cursor, headersEnd).toString("utf8").split("\r\n").map((line) => {
      const index = line.indexOf(":");
      return index > 0 ? [line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] : ["", ""];
    }).filter(([key]) => key));
    const dataStart = headersEnd + 4;
    const nextBoundary = buffer.indexOf(boundary, dataStart);
    if (nextBoundary < 0) break;
    const dataEnd = buffer.subarray(nextBoundary - 2, nextBoundary).toString() === "\r\n" ? nextBoundary - 2 : nextBoundary;
    const disposition = headers["content-disposition"] || "";
    const name = /(?:^|;)\s*name="([^"]*)"/i.exec(disposition)?.[1] || null;
    const filename = /(?:^|;)\s*filename="([^"]*)"/i.exec(disposition)?.[1] || null;
    parts.push({ name, filename, contentType: headers["content-type"] || "application/octet-stream", data: buffer.subarray(dataStart, dataEnd) });
    cursor = nextBoundary;
  }
  return parts;
}

function sniffImage(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand)) return "image/heic";
    if (["avif", "avis"].includes(brand)) return "image/avif";
  }
  return null;
}

function cleanFileName(name) {
  return String(name || "photo").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").slice(0, 120) || "photo";
}

async function withUploadSlot(task) {
  pendingUploads += 1;
  const previous = uploadQueue;
  let release;
  uploadQueue = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await task();
  } finally {
    pendingUploads -= 1;
    release();
  }
}

async function createPhotoFromRequest(req) {
  return withUploadSlot(() => processPhotoRequest(req));
}

async function processPhotoRequest(req) {
  if (!sharp) throw httpError(503, "Photo processing is not installed. Run npm install before enabling uploads.");
  const contentLength = Number(req.headers["content-length"] || 0);
  if (contentLength > MAX_UPLOAD_BYTES) throw httpError(413, "Photo is larger than the 20 MB upload limit");
  const body = await readRequestBody(req, MAX_UPLOAD_BYTES);
  const part = parseMultipart(body, req.headers["content-type"] || "").find((candidate) => candidate.filename && candidate.data.length);
  if (!part) throw httpError(400, "Choose an image file to upload");
  return processPhotoPart(part);
}

async function processPhotoPart(part, photoId = null) {
  if (!sharp) throw httpError(503, "Photo processing is unavailable. Install the application dependencies first.");
  if (part.data.length > MAX_UPLOAD_BYTES) throw httpError(413, "Photo exceeds the 20 MB limit");
  const sniffedMime = sniffImage(part.data);
  if (!sniffedMime) throw httpError(415, "Unsupported image format. Use JPEG, PNG, GIF, WebP, or a HEIC file supported by this Pi build.");
  const sha256 = createHash("sha256").update(part.data).digest("hex");
  if (db.prepare("SELECT id FROM photos WHERE sha256 = ?").get(sha256)) throw httpError(409, "That photo is already in the family display");
  const totals = db.prepare("SELECT COUNT(*) AS count, COALESCE(SUM(bytes), 0) AS bytes FROM photos").get();
  if (Number(totals.count) >= MAX_PHOTOS) throw httpError(507, `The family display is limited to ${MAX_PHOTOS} photos`);
  if (Number(totals.bytes) + part.data.length > MAX_PHOTO_STORAGE_BYTES) throw httpError(507, "The family photo storage limit has been reached; remove an older photo first");

  const id = photoId || `photo_${Date.now().toString(36)}_${randomBytes(5).toString("hex")}`;
  const originalExtension = extensionForMime(sniffedMime, part.filename);
  const originalRelative = path.join("photos", "original", `${id}.${originalExtension}`);
  const displayRelative = path.join("photos", "display", `${id}.jpg`);
  const originalPath = safeDataPath(originalRelative);
  const displayPath = safeDataPath(displayRelative);
  const tempPath = `${displayPath}.tmp`;

  let metadata;
  try {
    const image = sharp(part.data, { limitInputPixels: MAX_DECODED_PIXELS, failOn: "warning" });
    metadata = await image.metadata();
    if (!metadata.width || !metadata.height || metadata.width * metadata.height > MAX_DECODED_PIXELS) {
      throw httpError(413, "The image dimensions exceed the safe processing limit");
    }
    await image.rotate().resize({ width: 1920, height: 1080, fit: "inside", withoutEnlargement: true }).jpeg({ quality: 86, progressive: true }).toFile(tempPath);
    await fsp.rename(tempPath, displayPath);
    await fsp.writeFile(originalPath, part.data, { flag: "wx" });
    const createdAt = new Date().toISOString();
    db.prepare(`
      INSERT INTO photos(id, original_name, original_path, display_path, mime_type, sha256, width, height, bytes, created_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, cleanFileName(part.filename), originalRelative, displayRelative, sniffedMime, sha256, metadata.width, metadata.height, part.data.length, createdAt);
  } catch (error) {
    await fsp.rm(tempPath, { force: true }).catch(() => {});
    await fsp.rm(displayPath, { force: true }).catch(() => {});
    await fsp.rm(originalPath, { force: true }).catch(() => {});
    if (error.status) throw error;
    if (String(error.message || "").toLowerCase().includes("heif") || sniffedMime === "image/heic") {
      throw httpError(415, "This HEIC file could not be decoded by the installed image processor. Export it as JPEG or install a Pi build with HEIF support.");
    }
    throw httpError(415, "The image could not be decoded. Use a valid JPEG, PNG, GIF, WebP, or supported HEIC file.");
  }
  broadcastState();
  return getPhotoRows().find((row) => row.id === id);
}

function extensionForMime(mime, originalName) {
  if (mime === "image/jpeg") return "jpg";
  if (mime === "image/png") return "png";
  if (mime === "image/gif") return "gif";
  if (mime === "image/webp") return "webp";
  if (mime === "image/avif") return "avif";
  if (mime === "image/heic") {
    const lowerName = String(originalName).toLowerCase();
    return lowerName.endsWith(".heif") ? "heif" : lowerName.endsWith(".heics") ? "heics" : "heic";
  }
  return "img";
}

function safeDataPath(relativePath) {
  const resolved = path.resolve(DATA_DIR, relativePath);
  const prefix = DATA_DIR.endsWith(path.sep) ? DATA_DIR : `${DATA_DIR}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error("Unsafe data path");
  return resolved;
}

async function removePhoto(id) {
  if (!/^photo_[a-z0-9_]+$/.test(id)) throw httpError(400, "Invalid photo id");
  const row = db.prepare("SELECT original_path, display_path FROM photos WHERE id = ?").get(id);
  if (!row) throw httpError(404, "Photo not found");
  await fsp.rm(safeDataPath(row.original_path), { force: true });
  await fsp.rm(safeDataPath(row.display_path), { force: true });
  db.prepare("DELETE FROM photos WHERE id = ?").run(id);
  broadcastState();
}

function makeDemoEvents(start, end) {
  const events = [];
  const addTimed = (id, title, date, startTime, endTime, calendar, color, extra = {}) => events.push({ id: `${id}-${date}`, title, calendar, calendar_color: color, start_date: date, end_date: date, start_time: startTime, end_time: endTime, all_day: false, ...extra });
  const addAllDay = (id, title, date, endDate, calendar, color, extra = {}) => events.push({ id: `${id}-${date}`, title, calendar, calendar_color: color, start_date: date, end_date: endDate, start_time: null, end_time: null, all_day: true, ...extra });
  for (let date = start; date < end; date = addDays(date, 1)) {
    const day = dayOfWeek(date);
    if ([1, 3, 5].includes(day)) addTimed("school-run", "School drop-off", date, "08:30", "09:00", "Family", "#f0a35e");
    if ([2, 4].includes(day)) addTimed("soccer", "Soccer practice", date, "17:30", "18:45", "Kids", "#6d7bea", { location: "East field" });
    if (day === 3) addTimed("family-dinner", "Family dinner", date, "18:30", "20:00", "Family", "#51b89a");
    if (day === 6) addTimed("market", "Farmers market", date, "10:00", "11:30", "Weekend", "#c77dff");
    if (day === 0) addTimed("plan-week", "Plan the week", date, "19:00", "19:30", "Family", "#f0a35e");
    if (day === 5) addAllDay("library-books", "Library books due", date, addDays(date, 1), "Family", "#f0a35e");
  }
  const base = startOfWeek(todayKey(), "monday");
  const appointmentDate = addDays(base, 2);
  if (appointmentDate >= start && appointmentDate < end) addTimed("dentist", "Dentist · Sam", appointmentDate, "15:30", "16:15", "Appointments", "#ef6f6c", { location: "Downtown clinic" });
  const birthday = addDays(base, 5);
  if (birthday >= start && birthday < end) addAllDay("birthday", "Grandma's birthday", birthday, addDays(birthday, 1), "Family", "#ef6f6c");
  const longWeekend = addDays(base, 6);
  if (longWeekend >= start && longWeekend < end) addAllDay("cabin", "Cabin weekend", longWeekend, addDays(longWeekend, 3), "Weekend", "#51b89a");
  return events;
}

function getCachedEvents(start, end) {
  const rangeStartMs = Date.parse(googleBoundary(start));
  const rangeEndMs = Date.parse(googleBoundary(end));
  const rows = db.prepare(`
    SELECT e.*, s.summary AS calendar_summary, s.color AS source_color
    FROM calendar_events e
    LEFT JOIN calendar_sources s ON s.account_id = e.account_id AND s.calendar_id = e.calendar_id
    WHERE s.enabled = 1 AND ((e.all_day = 1 AND e.start_date < ? AND e.end_date > ?)
       OR (e.all_day = 0 AND e.end_ms > ? AND e.start_ms < ?))
    ORDER BY e.start_date, e.start_local, e.title
  `).all(end, start, rangeStartMs, rangeEndMs);
  return rows.map((row) => ({
    id: `${row.account_id}:${row.calendar_id}:${row.event_id}`,
    title: row.title,
    calendar: row.calendar_summary || row.calendar_id,
    calendar_color: row.color || row.source_color || "#6d7bea",
    start_date: row.start_date,
    end_date: row.end_date,
    start_time: row.all_day ? null : row.start_local?.slice(11, 16),
    end_time: row.all_day ? null : row.end_local?.slice(11, 16),
    all_day: Boolean(row.all_day),
    location: row.location || "",
    description: row.description || ""
  }));
}

function validRange(url) {
  const fallback = periodRange(readSettings());
  const start = url.searchParams.get("start") || fallback.start;
  const end = url.searchParams.get("end") || fallback.end;
  if (!isDateKey(start) || !isDateKey(end) || start >= end || Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`) > 62 * 86400000) {
    throw httpError(400, "Invalid event date range");
  }
  return { start, end };
}

function getAccountsAndSources() {
  const accounts = db.prepare("SELECT id, label, email, created_at, last_error FROM google_accounts ORDER BY created_at").all();
  const sources = db.prepare(`SELECT id, account_id, calendar_id, summary, description, color, enabled, updated_at FROM calendar_sources ORDER BY summary`).all().map((source) => ({ ...source, enabled: Boolean(source.enabled) }));
  return { accounts, sources };
}

function readClientSecrets() {
  const configured = process.env.GOOGLE_CLIENT_SECRETS;
  if (!configured) throw httpError(503, "GOOGLE_CLIENT_SECRETS is not configured");
  const filePath = path.resolve(configured);
  if (!fs.existsSync(filePath)) throw httpError(503, "The configured Google client secret file was not found");
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw httpError(503, "The Google client secret file is not valid JSON");
  }
  const config = parsed.web || parsed.installed || parsed;
  if (!config.client_id || !config.client_secret) throw httpError(503, "The Google client secret file is missing client_id or client_secret");
  return { clientId: config.client_id, clientSecret: config.client_secret, authUri: config.auth_uri || "https://accounts.google.com/o/oauth2/v2/auth", tokenUri: config.token_uri || "https://oauth2.googleapis.com/token" };
}

function redirectUri(req) {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  const callbackHost = req.headers.host || `localhost:${PORT}`;
  const rawHost = String(callbackHost);
  const host = rawHost.startsWith("[") ? rawHost.slice(0, rawHost.indexOf("]") + 1).toLowerCase() : rawHost.split(":")[0].toLowerCase();
  if (["localhost", "127.0.0.1", "[::1]"].includes(host)) return `http://${callbackHost}/api/google/callback`;
  throw httpError(503, "Set GOOGLE_REDIRECT_URI. Use an exact HTTPS callback on an owned host, or start the OAuth flow from the Pi itself with http://localhost.");
}

function googleAuthorizeUrl(req, state, scope = "https://www.googleapis.com/auth/calendar.readonly") {
  const client = readClientSecrets();
  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri(req),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope,
    state
  });
  return `${client.authUri}?${params}`;
}

async function exchangeGoogleCode(req, code) {
  const client = readClientSecrets();
  const response = await fetch(client.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri(req), grant_type: "authorization_code" }),
    signal: AbortSignal.timeout(15_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) throw httpError(502, "Google did not return a usable authorization token");
  return { ...payload, expires_at: Date.now() + Number(payload.expires_in || 3600) * 1000 };
}

async function googleJson(url, accessToken, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json", ...(options.headers || {}) },
    signal: AbortSignal.timeout(20_000)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || `Google request failed (${response.status})`);
    error.statusCode = response.status;
    throw error;
  }
  return payload;
}

function tokenPathFor(accountId) {
  return path.join(SECRET_DIR, `${accountId}.json`);
}

function writePrivateJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), { mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch { /* Windows does not expose POSIX modes. */ }
}

function readToken(account) {
  try {
    return JSON.parse(fs.readFileSync(safeDataPath(account.token_path), "utf8"));
  } catch {
    throw httpError(500, "A stored Google token could not be read");
  }
}

async function saveGoogleConnection(token) {
  // Calendar's primary ID identifies the account without requesting profile scopes.
  const primaryUrl = "https://www.googleapis.com/calendar/v3/calendars/primary";
  const primary = await googleJson(primaryUrl, token.access_token);
  if (!primary.id) throw httpError(502, "Google did not return a primary calendar identity");
  const accounts = db.prepare("SELECT * FROM google_accounts ORDER BY created_at, id").all();
  let existing = accounts.find((account) => account.email === primary.id);
  if (!existing) {
    for (const account of accounts.filter((row) => !row.email)) {
      // Older releases did not have permission to retrieve the account email.
      // Resolve legacy identities rather than guessing from shared calendar access.
      let identity;
      try { identity = await googleJsonForAccount(account, primaryUrl); }
      catch { throw httpError(409, "An older connection could not be identified. Disconnect that old connection before reconnecting."); }
      if (identity.id === primary.id) { existing = account; break; }
    }
  }
  const id = existing?.id || `acct_${randomBytes(8).toString("hex")}`;
  const tokenRelative = existing?.token_path || path.join("secrets", `${id}.json`);
  const savedToken = existing ? { ...readToken(existing), ...token } : token;
  writePrivateJson(safeDataPath(tokenRelative), savedToken);
  db.prepare(`INSERT INTO google_accounts(id, label, email, token_path, created_at)
    VALUES(?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
    label=excluded.label, email=excluded.email, last_error=NULL
  `).run(id, primary.id, primary.id, tokenRelative, new Date().toISOString());
  return { id, token_path: tokenRelative };
}

function disconnectGoogleAccount(id) {
  if (syncInProgress || accountMutationInProgress) throw httpError(409, "Calendar sync is running. Wait a moment and try disconnecting again.");
  const account = db.prepare("SELECT * FROM google_accounts WHERE id = ?").get(id);
  if (!account) throw httpError(404, "Google connection not found");
  // Foreign-key cascades remove only this connection's sources and cached events.
  // Do not revoke Google's grant: duplicate connections may share that grant.
  fs.rmSync(safeDataPath(account.token_path), { force: true });
  db.prepare("DELETE FROM google_accounts WHERE id = ?").run(id);
  calendarRevision += 1;
  broadcastState();
}

async function getAccessToken(account) {
  const token = readToken(account);
  if (token.access_token && Number(token.expires_at || 0) > Date.now() + 60_000) return token.access_token;
  if (!token.refresh_token) throw httpError(502, "Google authorization expired; reconnect this account");
  const client = readClientSecrets();
  const response = await fetch(client.tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: token.refresh_token, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15_000)
  });
  const refreshed = await response.json().catch(() => ({}));
  if (!response.ok || !refreshed.access_token) throw httpError(502, "Google refresh failed; reconnect this account");
  const updated = { ...token, ...refreshed, refresh_token: token.refresh_token, expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000 };
  writePrivateJson(safeDataPath(account.token_path), updated);
  return updated.access_token;
}

async function googleJsonForAccount(account, url, options = {}) {
  let token = await getAccessToken(account);
  try {
    return await googleJson(url, token, options);
  } catch (error) {
    if (error.statusCode !== 401) throw error;
    const refreshed = readToken(account);
    refreshed.expires_at = 0;
    writePrivateJson(safeDataPath(account.token_path), refreshed);
    token = await getAccessToken(account);
    return googleJson(url, token, options);
  }
}

async function syncAccountSources(account, sourceRows, range) {
  for (const source of sourceRows) {
    const query = new URL("https://www.googleapis.com/calendar/v3/calendars/" + encodeURIComponent(source.calendar_id) + "/events");
    query.searchParams.set("singleEvents", "true");
    query.searchParams.set("showDeleted", "true");
    query.searchParams.set("orderBy", "startTime");
    query.searchParams.set("maxResults", "2500");
    query.searchParams.set("timeMin", googleBoundary(range.start));
    query.searchParams.set("timeMax", googleBoundary(range.end));

    const items = [];
    let pageToken = null;
    for (let page = 0; page < 5; page += 1) {
      if (pageToken) query.searchParams.set("pageToken", pageToken);
      const payload = await googleJsonForAccount(account, query.toString());
      items.push(...(payload.items || []));
      pageToken = payload.nextPageToken || null;
      if (!pageToken) break;
    }
    const rangeStartMs = Date.parse(googleBoundary(range.start));
    const rangeEndMs = Date.parse(googleBoundary(range.end));
    db.prepare(`
      DELETE FROM calendar_events
      WHERE account_id = ? AND calendar_id = ?
        AND ((all_day = 1 AND start_date < ? AND end_date > ?)
          OR (all_day = 0 AND end_ms > ? AND start_ms < ?))
    `).run(account.id, source.calendar_id, range.end, range.start, rangeStartMs, rangeEndMs);
    const insert = db.prepare(`
      INSERT INTO calendar_events(account_id, calendar_id, event_id, title, description, location, all_day, start_date, end_date, start_local, end_local, start_ms, end_ms, color, status, updated_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, calendar_id, event_id) DO UPDATE SET
        title = excluded.title, description = excluded.description, location = excluded.location,
        all_day = excluded.all_day, start_date = excluded.start_date, end_date = excluded.end_date,
        start_local = excluded.start_local, end_local = excluded.end_local, start_ms = excluded.start_ms,
        end_ms = excluded.end_ms, color = excluded.color, status = excluded.status, updated_at = excluded.updated_at
    `);
    for (const event of items) {
      if (!event.id || event.status === "cancelled") continue;
      const normalized = normalizeGoogleEvent(event, source.color || "#6d7bea");
      if (!normalized) continue;
      insert.run(account.id, source.calendar_id, event.id, normalized.title, normalized.description, normalized.location, normalized.all_day ? 1 : 0, normalized.start_date, normalized.end_date, normalized.start_local, normalized.end_local, normalized.start_ms, normalized.end_ms, normalized.color, event.status || "confirmed", new Date().toISOString());
    }
  }
}

function googleBoundary(dateKey) {
  const noon = dateKeyToDate(dateKey);
  const offset = timeZoneOffsetMinutes(noon);
  const utc = new Date(Date.UTC(noon.getUTCFullYear(), noon.getUTCMonth(), noon.getUTCDate(), 0, 0) - offset * 60_000);
  return utc.toISOString();
}

function timeZoneOffsetMinutes(date) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, timeZoneName: "longOffset", hour: "2-digit" }).formatToParts(date);
  const zone = parts.find((part) => part.type === "timeZoneName")?.value || "GMT-06:00";
  const match = /GMT([+-])(\d{2}):?(\d{2})?/.exec(zone);
  if (!match) return -360;
  const minutes = Number(match[2]) * 60 + Number(match[3] || 0);
  return match[1] === "+" ? minutes : -minutes;
}

function localParts(timestamp) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${values.year}-${values.month}-${values.day}`, time: `${values.hour}:${values.minute}` };
}

function normalizeGoogleEvent(event, color) {
  const startValue = event.start?.date || event.start?.dateTime;
  const endValue = event.end?.date || event.end?.dateTime;
  if (!startValue || !endValue) return null;
  if (event.start.date) {
    return { title: event.summary || "Untitled event", description: event.description || "", location: event.location || "", all_day: true, start_date: event.start.date, end_date: event.end.date || addDays(event.start.date, 1), start_local: null, end_local: null, start_ms: null, end_ms: null, color };
  }
  const startMs = Date.parse(startValue);
  const endMs = Date.parse(endValue);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return null;
  const start = localParts(startMs);
  const end = localParts(endMs);
  return { title: event.summary || "Untitled event", description: event.description || "", location: event.location || "", all_day: false, start_date: start.date, end_date: end.date, start_local: `${start.date}T${start.time}:00`, end_local: `${end.date}T${end.time}:00`, start_ms: startMs, end_ms: endMs, color };
}

async function refreshGoogleSources(account) {
  const payload = await googleJsonForAccount(account, "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&showHidden=false&maxResults=250");
  const now = new Date().toISOString();
  const insert = db.prepare(`
    INSERT INTO calendar_sources(id, account_id, calendar_id, summary, description, color, enabled, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, 0, ?)
    ON CONFLICT(account_id, calendar_id) DO UPDATE SET summary = excluded.summary, description = excluded.description, color = excluded.color, updated_at = excluded.updated_at
  `);
  for (const calendar of payload.items || []) {
    if (!calendar.id || calendar.accessRole === "freeBusyReader") continue;
    const sourceId = `${account.id}::${calendar.id}`;
    insert.run(sourceId, account.id, calendar.id, calendar.summary || calendar.id, calendar.description || "", calendar.backgroundColor || "#6d7bea", now);
  }
}

async function syncCalendars() {
  if (APP_MODE !== "production" || syncInProgress || accountMutationInProgress || phoneUpdates.busy()) return { skipped: true };
  syncInProgress = true;
  const attemptedAt = new Date().toISOString();
  db.prepare("UPDATE sync_status SET last_attempt_at = ?, error = NULL WHERE id = 1").run(attemptedAt);
  const range = { start: addDays(todayKey(), -90), end: addDays(todayKey(), 365) };
  const accounts = db.prepare("SELECT * FROM google_accounts ORDER BY created_at").all();
  const errors = [];
  let sourceCount = 0;
  try {
    for (const account of accounts) {
      try {
        await refreshGoogleSources(account);
        const sources = db.prepare("SELECT * FROM calendar_sources WHERE account_id = ? AND enabled = 1").all(account.id);
        sourceCount += sources.length;
        await syncAccountSources(account, sources, range);
        db.prepare("UPDATE google_accounts SET last_error = NULL WHERE id = ?").run(account.id);
      } catch (error) {
        const message = error.status ? error.message : `Google sync failed for ${account.label}`;
        errors.push(message);
        db.prepare("UPDATE google_accounts SET last_error = ? WHERE id = ?").run(message.slice(0, 300), account.id);
      }
    }
    if (errors.length) {
      db.prepare("UPDATE sync_status SET error = ? WHERE id = 1").run(errors.join("; ").slice(0, 500));
    } else if (accounts.length === 0) {
      db.prepare("UPDATE sync_status SET error = ? WHERE id = 1").run("No Google Calendar account is connected");
    } else {
      db.prepare("UPDATE sync_status SET last_success_at = ?, error = NULL WHERE id = 1").run(new Date().toISOString());
    }
    broadcastState();
    return { accounts: accounts.length, sources: sourceCount, errors };
  } finally {
    syncInProgress = false;
  }
}

async function serveStatic(res, relativePath) {
  const resolved = path.resolve(STATIC_DIR, relativePath);
  const prefix = STATIC_DIR.endsWith(path.sep) ? STATIC_DIR : `${STATIC_DIR}${path.sep}`;
  if (!resolved.startsWith(prefix) && resolved !== STATIC_DIR) throw httpError(404, "Not found");
  let file;
  try { file = await fsp.readFile(resolved); } catch { throw httpError(404, "Not found"); }
  const ext = path.extname(resolved).toLowerCase();
  const contentType = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon" }[ext] || "application/octet-stream";
  const cacheControl = [".html", ".js", ".css"].includes(ext) ? "no-cache" : "public, max-age=3600";
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": contentType, "Cache-Control": cacheControl });
  res.end(file);
}

async function serveMedia(res, url) {
  const match = /^\/media\/display\/(photo_[a-z0-9_]+)\.jpg$/i.exec(url.pathname);
  if (!match) throw httpError(404, "Not found");
  const row = db.prepare("SELECT display_path FROM photos WHERE id = ?").get(match[1]);
  if (!row) throw httpError(404, "Not found");
  const filePath = safeDataPath(row.display_path);
  const file = await fsp.readFile(filePath).catch(() => null);
  if (!file) throw httpError(404, "Not found");
  res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400" });
  res.end(file);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = req.method || "GET";

  if (url.pathname === '/api/system/update') {
    requireAdmin(req);
    if (method === 'GET') return sendJson(res, 200, phoneUpdates.status());
    if (method === 'POST') {
      if (pendingUploads || picker.status().busy || ['selecting', 'ready', 'importing'].includes(picker.status().job?.phase) || photosConnecting || syncInProgress || accountMutationInProgress) {
        throw httpError(409, 'Wait for photo imports, uploads, or calendar syncing to finish before updating.');
      }
      return sendJson(res, 202, phoneUpdates.request());
    }
  }
  if ((method === 'POST' || method === 'DELETE' || url.pathname === '/api/google/start' || url.pathname === '/api/google/callback' || url.pathname === '/api/google-photos/connect')
      && url.pathname !== '/api/auth/login' && phoneUpdates.busy()) {
    throw httpError(503, 'Application update in progress. Try again when the Pi reconnects.');
  }

  if (method === "GET" && url.pathname === "/") return serveStatic(res, "index.html");
  if (method === "GET" && url.pathname === "/control") return serveStatic(res, "control.html");
  if (method === "GET" && url.pathname.startsWith("/static/")) return serveStatic(res, url.pathname.slice("/static/".length));
  if (method === "GET" && url.pathname.startsWith("/media/")) return serveMedia(res, url);

  if (method === "GET" && url.pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, mode: APP_MODE, timezone: TIMEZONE, version: "0.1.0", server_time: new Date().toISOString(), instance_id: INSTANCE_ID });
  }
  if (method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, getStatePayload());
  if (method === "GET" && url.pathname === "/api/events") {
    const range = validRange(url);
    const events = APP_MODE === "demo" ? makeDemoEvents(range.start, range.end) : getCachedEvents(range.start, range.end);
    return sendJson(res, 200, { mode: APP_MODE, range, events });
  }
  if (method === "GET" && url.pathname === "/api/photos") return sendJson(res, 200, { mode: APP_MODE, photos: getPhotos() });
  if (method === "GET" && url.pathname === "/api/updates") {
    res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.write(`event: state\ndata: ${JSON.stringify(getStatePayload())}\n\n`);
    updateClients.add(res);
    req.on("close", () => updateClients.delete(res));
    return;
  }

  if (method === "GET" && url.pathname === "/api/auth/me") {
    return sendJson(res, 200, { authenticated: Boolean(sessionFromRequest(req)), mode: APP_MODE, pin_required: adminPinIsConfigured() });
  }
  if (method === "POST" && url.pathname === "/api/auth/login") {
    checkLoginLimit(req);
    const body = await readJson(req);
    if (!verifyPin(body.pin)) {
      recordLoginFailure(req);
      return sendJson(res, 401, { error: "That pairing PIN was not accepted" });
    }
    clearLoginFailures(req);
    const token = randomBytes(24).toString("base64url");
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(res, token);
    return sendJson(res, 200, { ok: true, expires_in: SESSION_TTL_MS / 1000 });
  }
  if (method === "POST" && url.pathname === "/api/auth/logout") {
    const session = sessionFromRequest(req);
    if (session) sessions.delete(session.token);
    setSessionCookie(res, "", 0);
    return sendJson(res, 200, { ok: true });
  }
  if (method === "POST" && url.pathname === "/api/state") {
    requireAdmin(req);
    const body = await readJson(req);
    let next;
    if (body.action === "navigate") {
      const current = readSettings();
      const amount = body.direction === "previous" ? -1 : body.direction === "next" ? 1 : 0;
      if (!amount) throw httpError(400, "direction must be previous or next");
      next = updateSettings({ anchor_date: current.view === "month" ? addMonths(current.anchor_date, amount) : addDays(current.anchor_date, amount * 7) });
    } else if (body.action === "today") {
      next = updateSettings({ anchor_date: todayKey() });
    } else {
      next = updateSettings(body);
    }
    broadcastState();
    return sendJson(res, 200, { ok: true, state: getStatePayload() });
  }
  if (method === "POST" && url.pathname === "/api/photos") {
    requireAdmin(req);
    const photo = await createPhotoFromRequest(req);
    return sendJson(res, 201, { ok: true, photo });
  }
  if (method === "DELETE" && /^\/api\/photos\//.test(url.pathname)) {
    requireAdmin(req);
    await removePhoto(decodeURIComponent(url.pathname.slice("/api/photos/".length)));
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname.startsWith("/api/google-photos/")) {
    const session = requireAdmin(req);
    const action = url.pathname.slice("/api/google-photos/".length);
    if (method === "GET" && action === "status") return sendJson(res, 200, { ...picker.status(), demo: APP_MODE === "demo" });
    if (APP_MODE === "demo") throw httpError(409, "Google Photos import is disabled in demo mode. Phone file uploads still work.");
    if (photosConnecting) throw httpError(409, "Google Photos connection is being updated. Try again in a moment.");
    if (method === "GET" && action === "connect") {
      picker.ensureIdle();
      const callback = new URL(redirectUri(req));
      if (req.headers.host !== callback.host) return sendText(res, 400, "For initial Google Photos setup, open the control page on the Pi at the same address as GOOGLE_REDIRECT_URI (normally http://localhost:8080/control), enter your PIN, and connect there. Later imports work from your phone.");
      const state = randomBytes(24).toString("base64url");
      const location = googleAuthorizeUrl(req, state, PHOTOS_SCOPE);
      oauthStates.set(state, { createdAt: Date.now(), sessionToken: session.token, purpose: "photos" });
      return redirect(res, location);
    }
    if (method === "POST" && action === "start") {
      if (!sharp) throw httpError(503, "Install the application dependencies before importing photos.");
      return sendJson(res, 200, await picker.start());
    }
    if (method === "POST" && action === "check") return sendJson(res, 200, await picker.check());
    if (method === "POST" && action === "import") return sendJson(res, 202, picker.importSelected());
    if (method === "POST" && action === "cancel") return sendJson(res, 200, await picker.cancel());
    if (method === "DELETE" && action === "connection") {
      photosConnecting = true;
      try {
        await picker.cancel();
        fs.rmSync(safeDataPath(pickerAccount.token_path), { force: true });
      } finally { photosConnecting = false; }
      return sendJson(res, 200, picker.status());
    }
  }

  if (method === "GET" && url.pathname === "/api/google/start") {
    const session = requireAdmin(req);
    const state = randomBytes(24).toString("base64url");
    oauthStates.set(state, { createdAt: Date.now(), sessionToken: session.token });
    return redirect(res, googleAuthorizeUrl(req, state));
  }
  if (method === "GET" && url.pathname === "/api/google/callback") {
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const savedState = state ? oauthStates.get(state) : null;
    oauthStates.delete(state);
    if (!savedState || savedState.createdAt + OAUTH_STATE_TTL_MS < Date.now()) return sendText(res, 400, "This Google pairing link expired. Return to the control page and try again.");
    if (sessionFromRequest(req)?.token !== savedState.sessionToken) return sendText(res, 403, "This Google pairing must be completed in the same paired browser.");
    if (!code) return sendText(res, 400, "Google authorization was not completed. Return to the control page and try again.");
    if (savedState.purpose === "photos") {
      picker.ensureIdle();
      if (photosConnecting) throw httpError(409, "Google Photos connection is already being updated.");
      photosConnecting = true;
      try {
        const token = await exchangeGoogleCode(req, code);
        if (!token.scope?.split(" ").includes(PHOTOS_SCOPE)) throw httpError(403, "Google Photos permission was not granted. Connect again and allow access to selected photos.");
        if (!token.refresh_token) throw httpError(403, "Google did not provide ongoing access. Remove this app's Photos access in Google Account settings, then connect again.");
        await picker.cancel();
        writePrivateJson(safeDataPath(pickerAccount.token_path), token);
      } finally { photosConnecting = false; }
      return redirect(res, "/control?photos=connected");
    }
    if (syncInProgress || accountMutationInProgress) throw httpError(409, "Calendar sync is running. Wait a moment, then start Google connection again.");
    accountMutationInProgress = true;
    try {
      const token = await exchangeGoogleCode(req, code);
      const account = await saveGoogleConnection(token);
      await refreshGoogleSources(account);
    } finally { accountMutationInProgress = false; }
    return redirect(res, "/control?google=connected");
  }
  if (method === "DELETE" && url.pathname.startsWith("/api/google/accounts/")) {
    requireAdmin(req);
    disconnectGoogleAccount(decodeURIComponent(url.pathname.slice("/api/google/accounts/".length)));
    return sendJson(res, 200, { ok: true, ...getAccountsAndSources() });
  }
  if (method === "GET" && url.pathname === "/api/google/accounts") {
    requireAdmin(req);
    return sendJson(res, 200, getAccountsAndSources());
  }
  if (method === "POST" && url.pathname === "/api/google/sources") {
    requireAdmin(req);
    const body = await readJson(req);
    if (!Array.isArray(body.sources)) throw httpError(400, "sources must be an array");
    const update = db.prepare("UPDATE calendar_sources SET enabled = ? WHERE id = ?");
    for (const source of body.sources) {
      if (typeof source.id !== "string") continue;
      update.run(source.enabled ? 1 : 0, source.id);
    }
    calendarRevision += 1;
    broadcastState();
    await syncCalendars();
    broadcastState();
    return sendJson(res, 200, { ok: true, ...getAccountsAndSources() });
  }
  if (method === "POST" && url.pathname === "/api/google/sync") {
    requireAdmin(req);
    const result = await syncCalendars();
    return sendJson(res, 200, { ok: true, result, calendar: getSyncStatus() });
  }

  throw httpError(404, "Not found");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    const status = Number(error.status || 500);
    if (status >= 500) log("error", error.message || "Request failed");
    if (!res.headersSent) sendJson(res, status, { error: error.message || "Unexpected server error" });
    else res.end();
  });
});

server.on("clientError", (error, socket) => {
  log("warn", "HTTP client error", { message: error.message });
  socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
});

function log(level, message, extra = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...extra }));
}

const shouldStartServer = process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT_DIR, "server.mjs");
if (shouldStartServer && APP_MODE === "production" && !adminPinIsConfigured()) {
  log("error", "Production mode requires ADMIN_PIN");
  process.exitCode = 1;
} else if (shouldStartServer) {
  const shutdown = () => {
    for (const client of updateClients) {
      try { client.end(); } catch { /* Client may already be gone. */ }
    }
    server.close(() => {
      try { db.close(); } catch { /* The process is exiting. */ }
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  server.listen(PORT, HOST, () => {
    log("info", "Family calendar server started", { host: HOST, port: PORT, mode: APP_MODE, timezone: TIMEZONE });
  });
  const pingTimer = setInterval(() => {
    for (const client of updateClients) {
      try { client.write(`: ping ${Date.now()}\n\n`); } catch { updateClients.delete(client); }
    }
  }, 25_000);
  pingTimer.unref();
  const syncTimer = setInterval(() => { syncCalendars().catch((error) => log("error", "Scheduled calendar sync failed", { message: error.message })); }, SYNC_INTERVAL_MIN * 60_000);
  syncTimer.unref();
  if (APP_MODE === "production") setTimeout(() => { syncCalendars().catch((error) => log("error", "Initial calendar sync failed", { message: error.message })); }, 1000).unref();
}

export {
  saveGoogleConnection,
  disconnectGoogleAccount,
  getCachedEvents,
  addDays,
  addMonths,
  dayOfWeek,
  getPeriodInfo,
  isDateKey,
  makeDemoEvents,
  periodRange,
  startOfWeek
};
