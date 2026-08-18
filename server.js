/* ============================================================
   兽药出入库记录可追溯系统 · 多端同步版 后端
   纯 Node (零依赖) · 记录级按 _u 时间戳合并 · JSON 文件持久化
   ============================================================ */
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const API_TOKEN = process.env.API_TOKEN || ""; // 留空则不鉴权；设置后所有 /api 需带 token
const PUBLIC_DIR = path.join(__dirname, "public");
// 数据目录：默认放项目内 data/；部署到 Render 等平台时挂持久盘到 /data，用 DATA_DIR 覆盖
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

/* ---------------- 数据模型 ----------------
   db 用「按 id 的 map」存储，便于按记录合并：
   { inbound:{}, outbound:{}, slips:{}, drugs:{}, settings:{...}, updatedAt }
*/
function emptyDb() {
  return {
    inbound: {},
    outbound: {},
    slips: {},
    drugs: {},
    settings: {
      name: "兽药出入库记录可追溯系统",
      version: 1,
      handlers: [],
      receivingUnits: [],
      drugTypes: ["疫苗", "普通药品", "器械耗材"],
      units: ["支", "瓶", "盒", "袋", "箱", "头份"],
    },
    updatedAt: 0,
  };
}

function loadDb() {
  try {
    const j = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
    const db = emptyDb();
    if (j.inbound) Object.assign(db.inbound, j.inbound);
    if (j.outbound) Object.assign(db.outbound, j.outbound);
    if (j.slips) Object.assign(db.slips, j.slips);
    if (j.drugs) Object.assign(db.drugs, j.drugs);
    if (j.settings) Object.assign(db.settings, j.settings);
    if (j.updatedAt) db.updatedAt = j.updatedAt;
    return db;
  } catch (e) {
    return emptyDb();
  }
}

let db = loadDb();
let saveTimer = null;
function persist() {
  // 防抖写盘，避免高频请求反复 IO
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) {
      console.error("写入数据库失败:", e.message);
    }
  }, 300);
}

/* ---------------- 合并逻辑 ---------------- */
function applyIncoming(incoming, mode) {
  // mode: "merge" 按 _u 取新；"replace" 整体覆盖
  if (mode === "replace") db = emptyDb();

  const collMap = {
    inbound: incoming.inbound,
    outbound: incoming.outbound,
    slips: incoming.slips,
    drugs: incoming.settings && incoming.settings.drugs,
  };
  for (const coll in collMap) {
    const arr = collMap[coll];
    if (!Array.isArray(arr)) continue;
    const target = db[coll];
    for (const rec of arr) {
      if (!rec || !rec.id) continue;
      if (mode === "replace") {
        target[rec.id] = rec;
      } else {
        const u = Number(rec._u) || 0;
        const cur = target[rec.id];
        if (!cur || u > (Number(cur._u) || 0)) target[rec.id] = rec;
      }
    }
  }

  if (incoming.settings) {
    const s = incoming.settings;
    const ds = db.settings;
    const strSets = ["handlers", "receivingUnits", "drugTypes", "units"];
    if (mode === "replace") {
      for (const k of strSets) if (Array.isArray(s[k])) ds[k] = s[k].slice();
      if (s.name) ds.name = s.name;
      if (s.version) ds.version = s.version;
    } else {
      for (const k of strSets) {
        if (Array.isArray(s[k])) {
          const set = new Set([...(ds[k] || []), ...s[k]]);
          ds[k] = Array.from(set);
        }
      }
      if (s.name) ds.name = s.name;
      if (s.version) ds.version = s.version;
    }
  }
  db.updatedAt = Date.now();
}

function dbToState() {
  return {
    meta: { name: db.settings.name, version: db.settings.version, updatedAt: db.updatedAt },
    settings: {
      name: db.settings.name,
      version: db.settings.version,
      handlers: db.settings.handlers,
      receivingUnits: db.settings.receivingUnits,
      drugTypes: db.settings.drugTypes,
      units: db.settings.units,
      drugs: Object.values(db.drugs),
    },
    inbound: Object.values(db.inbound),
    outbound: Object.values(db.outbound),
    slips: Object.values(db.slips),
  };
}

/* ---------------- HTTP 工具 ---------------- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e8) reject(new Error("body too large"));
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", reject);
  });
}
function tokenOk(req, url) {
  if (!API_TOKEN) return true;
  const h = req.headers["x-token"];
  const q = url.searchParams.get("token");
  return h === API_TOKEN || q === API_TOKEN;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".map": "application/json",
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, 403, { error: "forbidden" });
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

/* ---------------- 路由 ---------------- */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // API
  if (p.startsWith("/api/")) {
    if (!tokenOk(req, url)) return sendJson(res, 403, { error: "token required" });
    try {
      if (p === "/api/state" && req.method === "GET") {
        return sendJson(res, 200, dbToState());
      }
      if (p === "/api/sync" && req.method === "POST") {
        const body = await readBody(req);
        applyIncoming(body, "merge");
        persist();
        return sendJson(res, 200, dbToState());
      }
      if (p === "/api/replace" && req.method === "POST") {
        const body = await readBody(req);
        applyIncoming(body, "replace");
        persist();
        return sendJson(res, 200, dbToState());
      }
      if (p === "/api/reset" && req.method === "POST") {
        db = emptyDb();
        persist();
        return sendJson(res, 200, dbToState());
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (e) {
      return sendJson(res, 400, { error: e.message });
    }
  }

  // 静态资源
  if (req.method === "GET" || req.method === "HEAD") return serveStatic(req, res, url);
  res.writeHead(405);
  res.end("Method Not Allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`兽药台账(多端同步版) 后端已启动: http://${HOST}:${PORT}`);
  if (API_TOKEN) console.log("已启用 token 鉴权，访问需在 URL 带 ?token= 或请求头 x-token");
  else console.log("未启用 token 鉴权（仅限可信内网使用，公网部署请设置 API_TOKEN 环境变量）");
});
