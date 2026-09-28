const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const vm = require("vm");

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const SITE_FILE = path.join(DATA_DIR, "site.json");
const STATS_FILE = path.join(DATA_DIR, "stats.json");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "neno-tota-admin";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 6;
const sessions = new Map();
const loginAttempts = new Map();

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".ico": "image/x-icon"
};

const securityHeaders = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; media-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), bluetooth=()"
};

function ensureStorage() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  if (!fs.existsSync(SITE_FILE)) writeJson(SITE_FILE, extractInitialSite());
  if (!fs.existsSync(STATS_FILE)) writeJson(STATS_FILE, { totalViews: 0, todayViews: {}, lastViews: [] });
}

function extractInitialSite() {
  const script = fs.readFileSync(path.join(ROOT, "script.js"), "utf8");
  const setup = script.slice(0, script.indexOf("const $ ="));
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${setup}\nglobalThis.__SITE__ = { config: CONFIG, i18n: I18N };`, context);
  return context.__SITE__;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function send(res, status, data, headers = {}) {
  const body = typeof data === "string" || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": typeof data === "string" || Buffer.isBuffer(data) ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...securityHeaders,
    ...headers
  });
  res.end(body);
  return true;
}

function parseCookies(req) {
  return Object.fromEntries((req.headers.cookie || "").split(";").filter(Boolean).map((cookie) => {
    const index = cookie.indexOf("=");
    return [cookie.slice(0, index).trim(), decodeURIComponent(cookie.slice(index + 1).trim())];
  }));
}

function cookieHeader(req, token, maxAge) {
  const secure = req.headers["x-forwarded-proto"] === "https" || process.env.NODE_ENV === "production";
  return [
    `admin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    secure ? "Secure" : "",
    `Max-Age=${maxAge}`,
  ].filter(Boolean).join("; ");
}

function setSessionCookie(req, res, token) {
  res.setHeader("Set-Cookie", cookieHeader(req, token, Math.floor(SESSION_TTL_MS / 1000)));
}

function clearSessionCookie(req, res) {
  res.setHeader("Set-Cookie", cookieHeader(req, "deleted", 0));
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function verifyPassword(password) {
  if (ADMIN_PASSWORD_HASH) {
    const [salt, expected] = ADMIN_PASSWORD_HASH.split(":");
    if (!salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(String(password), salt, 120000, 32, "sha256").toString("hex");
    return safeEqual(actual, expected);
  }
  return safeEqual(password || "", ADMIN_PASSWORD);
}

function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
}

function checkLoginLimit(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  if (record.resetAt < now) {
    loginAttempts.set(ip, { count: 0, resetAt: now + LOGIN_WINDOW_MS });
    return true;
  }
  return record.count < MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW_MS };
  record.count += 1;
  loginAttempts.set(ip, record);
}

function clearLoginAttempts(req) {
  loginAttempts.delete(clientIp(req));
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const buffer = Buffer.concat(chunks);
      if (!buffer.length) return resolve({});
      try {
        resolve(JSON.parse(buffer.toString("utf8")));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    const boundaryMatch = type.match(/boundary=(.+)$/);
    if (!boundaryMatch) return reject(new Error("Missing multipart boundary"));
    const boundary = `--${boundaryMatch[1]}`;
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const parts = body.toString("binary").split(boundary).slice(1, -1);
      const fields = {};
      const files = [];
      for (const rawPart of parts) {
        const cleanPart = rawPart.replace(/^\r\n/, "").replace(/\r\n$/, "");
        const headerEnd = cleanPart.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const rawHeaders = cleanPart.slice(0, headerEnd);
        const content = cleanPart.slice(headerEnd + 4);
        const disposition = rawHeaders.match(/content-disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?/i);
        if (!disposition) continue;
        const name = disposition[1];
        const filename = disposition[2];
        const contentType = rawHeaders.match(/content-type: ([^\r\n]+)/i)?.[1] || "application/octet-stream";
        const value = Buffer.from(content, "binary");
        if (filename) {
          files.push({ name, filename, contentType, data: value });
        } else {
          fields[name] = value.toString("utf8");
        }
      }
      resolve({ fields, files });
    });
    req.on("error", reject);
  });
}

function sanitizeFilename(filename) {
  const ext = path.extname(filename).toLowerCase();
  const base = path.basename(filename, ext).replace(/[^\p{L}\p{N}._-]+/gu, "-").replace(/-+/g, "-").slice(0, 80) || "upload";
  return `${Date.now()}-${base}${ext}`;
}

function requireAdmin(req, res) {
  const token = parseCookies(req).admin_session || (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const session = token ? sessions.get(token) : null;
  if (!session || session.expiresAt < Date.now()) {
    if (token) sessions.delete(token);
    clearSessionCookie(req, res);
    send(res, 401, { error: "Unauthorized" });
    return false;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  sessions.set(token, session);
  setSessionCookie(req, res, token);
  return true;
}

function getSite() {
  return readJson(SITE_FILE, extractInitialSite());
}

function saveSite(site) {
  writeJson(SITE_FILE, site);
  return site;
}

function withCollection(site, collection, action) {
  if (!["story", "gallery"].includes(collection)) throw new Error("Unknown collection");
  const key = collection === "story" ? "story" : "photos";
  const list = site.config[key] || [];
  action(list);
  site.config[key] = list;
  if (collection === "story") {
    site.i18n.en.story = list.map(({ title, date, text }) => ({ title, date, text }));
  }
  return saveSite(site);
}

function updateStats(req) {
  const stats = readJson(STATS_FILE, { totalViews: 0, todayViews: {}, lastViews: [] });
  const day = new Date().toISOString().slice(0, 10);
  const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
  stats.totalViews += 1;
  stats.todayViews[day] = (stats.todayViews[day] || 0) + 1;
  stats.lastViews.unshift({ at: new Date().toISOString(), ip, userAgent: req.headers["user-agent"] || "" });
  stats.lastViews = stats.lastViews.slice(0, 50);
  writeJson(STATS_FILE, stats);
  return stats;
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/site") return send(res, 200, getSite());
  if (req.method === "POST" && url.pathname === "/api/views") return send(res, 200, updateStats(req));

  if (req.method === "POST" && url.pathname === "/api/admin/login") {
    if (!checkLoginLimit(req)) return send(res, 429, { error: "Too many login attempts. Try again later." });
    const body = await parseBody(req);
    if (!verifyPassword(body.password)) {
      recordFailedLogin(req);
      return send(res, 401, { error: "Wrong password" });
    }
    clearLoginAttempts(req);
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS });
    setSessionCookie(req, res, token);
    return send(res, 200, { ok: true });
  }

  if (!url.pathname.startsWith("/api/admin/")) return false;
  if (!requireAdmin(req, res)) return true;

  if (req.method === "POST" && url.pathname === "/api/admin/logout") {
    const token = parseCookies(req).admin_session;
    if (token) sessions.delete(token);
    clearSessionCookie(req, res);
    return send(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/api/admin/stats") return send(res, 200, readJson(STATS_FILE, {}));
  if (req.method === "GET" && url.pathname === "/api/admin/site") return send(res, 200, getSite());

  if (req.method === "PUT" && url.pathname === "/api/admin/site") {
    const body = await parseBody(req);
    return send(res, 200, saveSite(body));
  }

  if (req.method === "POST" && url.pathname === "/api/admin/upload") {
    const { files } = await parseMultipart(req);
    const file = files[0];
    if (!file) return send(res, 400, { error: "No file uploaded" });
    if (!/^(image|audio|video)\//.test(file.contentType)) return send(res, 400, { error: "Unsupported file type" });
    const filename = sanitizeFilename(file.filename);
    fs.writeFileSync(path.join(UPLOAD_DIR, filename), file.data);
    return send(res, 201, { file: `uploads/${filename}`, contentType: file.contentType });
  }

  const match = url.pathname.match(/^\/api\/admin\/(story|gallery)(?:\/(\d+))?$/);
  if (match) {
    const [, collection, indexValue] = match;
    const site = getSite();
    const key = collection === "story" ? "story" : "photos";
    const list = site.config[key] || [];
    const index = Number(indexValue);

    if (req.method === "GET") return send(res, 200, indexValue === undefined ? list : list[index]);
    if (req.method === "POST" && indexValue === undefined) {
      const item = await parseBody(req);
      return send(res, 201, withCollection(site, collection, (items) => items.push(item)));
    }
    if (req.method === "PUT" && Number.isInteger(index)) {
      const item = await parseBody(req);
      return send(res, 200, withCollection(site, collection, (items) => { items[index] = item; }));
    }
    if (req.method === "DELETE" && Number.isInteger(index)) {
      return send(res, 200, withCollection(site, collection, (items) => { items.splice(index, 1); }));
    }
  }

  send(res, 404, { error: "Not found" });
  return true;
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const safePath = path.normalize(requested).replace(/^(\.\.[/\\])+/, "");
  if (/^\/?(data|\.git|\.codex|\.agents)(\/|$)/.test(safePath) || /^\/?(server\.js|package\.json|package-lock\.json)$/.test(safePath)) {
    send(res, 404, "Not found");
    return;
  }
  const filePath = path.join(ROOT, safePath);
  if (!filePath.startsWith(ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(res, 404, "Not found");
    return;
  }
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    "Content-Type": mimeTypes[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    ...securityHeaders
  });
  fs.createReadStream(filePath).pipe(res);
}

ensureStorage();

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const handled = await handleApi(req, res, url);
    if (!handled) serveStatic(req, res, url);
  } catch (error) {
    send(res, 500, { error: error.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Wedding backend running on http://${HOST}:${PORT}`);
  console.log(`Admin: http://${HOST}:${PORT}/admin.html`);
});
