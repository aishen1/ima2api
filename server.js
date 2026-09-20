
"use strict";

const https = require("https");
const http = require("http");
const crypto = require("crypto");

// ============================================================
// 1. 配置（支持多账号账号池）
// ============================================================
const fs = require("fs");
const path = require("path");
const os = require("os");

const BASE_HOST = "ima.qq.com";
const BASE_URL = "https://ima.qq.com";

// 配置目录：优先环境变量 IMA2API_CONFIG_DIR（fpk 里指向 TRIM_PKGVAR），
// 否则退回脚本所在目录（兼容旧用法）。
const CONFIG_DIR = process.env.IMA2API_CONFIG_DIR
  ? path.resolve(process.env.IMA2API_CONFIG_DIR)
  : __dirname;
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");
const CONFIG_EXAMPLE = path.join(__dirname, "config.example.json");

// 页面构建标记：注入到 <head>，用于确认手机/浏览器实际加载的是哪一版页面
const BUILD_VERSION = "1.0.5";
const ADMIN_HTML = (() => {
  let html;
  try { html = fs.readFileSync(path.join(__dirname, "admin.html"), "utf-8"); }
  catch { return "<h1>admin.html 缺失</h1>"; }
  const meta = `<meta name="ima2api-build" content="${BUILD_VERSION}">`;
  return html.includes("</head>") ? html.replace("</head>", meta + "</head>") : meta + html;
})();

function defaultConfig() {
  return {
    server: { port: Number(process.env.IMA2API_PORT) || 8081, host: "0.0.0.0" },
    api_keys: [genApiKey()],
    default_model: "hy3-preview",
    accounts: [],
    models: defaultModels(),
  };
}

function defaultModels() {
  return {
    "hy3-preview": { type: 0, id: "official_0", name: "Tencent Hy3 preview" },
    "hy3-preview-think": { type: 2, id: "official_2", name: "Tencent Hy3 preview (Think)" },
    "deepseek-v4-flash": { type: 3, id: "official_3", name: "DeepSeek V4-Flash" },
    "deepseek-v4-flash-think": { type: 1, id: "official_1", name: "DeepSeek V4-Flash (Think)" },
    "glm-5.2": { type: 3000, id: "official_3000", name: "GLM-5.2" },
    "glm-5.2-think": { type: 3001, id: "official_3001", name: "GLM-5.2 (Think)" },
  };
}

function genApiKey() {
  return "sk-ima-" + crypto.randomBytes(20).toString("hex");
}

// ---- 配置读写（原子写） ----
let CONFIG = loadConfig();

function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_FILE, "utf-8");
  } catch (e) {
    // 首次启动：优先用 config.example.json 作模板，否则用默认值
    let cfg;
    try {
      cfg = normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_EXAMPLE, "utf-8")));
    } catch (_) {
      cfg = normalizeConfig(defaultConfig());
    }
    cfg.server = cfg.server || {};
    // 端口优先级：环境变量（fpk 启动时注入） > 模板 > 8081
    cfg.server.port = Number(process.env.IMA2API_PORT) || Number(cfg.server.port) || 8081;
    excludeExampleKeys(cfg);
    try { saveConfig(cfg); } catch (_) {}
    return cfg;
  }
  try {
    const cfg = normalizeConfig(JSON.parse(raw));
    // 规范化可能产生了变更（补 Key 等）→ 立即落盘，
    // 保证界面/客户端拿到的 Key 与磁盘文件一致。
    try { saveConfig(cfg); } catch (_) {}
    return cfg;
  } catch (e) {
    console.error(`配置文件 ${CONFIG_FILE} 解析失败，使用默认配置：${e.message}`);
    const cfg = normalizeConfig(defaultConfig());
    try { saveConfig(cfg); } catch (_) {}
    return cfg;
  }
}

// 示例模板里的 api_keys 为空（不能把别人的 Key 带到新安装里），删掉让 normalize 生成新的
function excludeExampleKeys(cfg) {
  if (Array.isArray(cfg.api_keys) && !cfg.api_keys.length) {
    cfg.api_keys = [genApiKey()];
  }
}

// 把旧版单账号 config（auth.cookie）迁移成 accounts 数组
function normalizeConfig(cfg) {
  cfg.server = cfg.server || {};
  cfg.api_keys = Array.isArray(cfg.api_keys) ? cfg.api_keys : [];
  if (!cfg.api_keys.length) cfg.api_keys.push(genApiKey());
  cfg.models = cfg.models && Object.keys(cfg.models).length ? cfg.models : defaultModels();
  cfg.default_model = cfg.default_model || "hy3-preview";
  if (!Array.isArray(cfg.accounts)) cfg.accounts = [];

  // 迁移旧版 auth.cookie / auth.refresh_token
  if (cfg.auth && cfg.auth.cookie) {
    cfg.accounts.push({
      id: crypto.randomUUID(),
      name: "默认账号",
      cookie: cfg.auth.cookie,
      refresh_token: cfg.auth.refresh_token || "",
      enabled: true,
      created_at: new Date().toISOString(),
    });
    delete cfg.auth;
  }
  for (const a of cfg.accounts) {
    if (!a.id) a.id = crypto.randomUUID();
    if (!a.name) a.name = "账号";
    if (typeof a.enabled !== "boolean") a.enabled = true;
    a.cookie = a.cookie || "";
    a.refresh_token = a.refresh_token || "";
  }
  return cfg;
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(cfg || CONFIG, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
}

// ---- Cookie 工具 ----
function cookieField(cookie, key) {
  if (!cookie) return "";
  const m = String(cookie).match(new RegExp("(?:^|;\\s*)" + key + "=([^;]+)"));
  return m ? m[1] : "";
}

function calcBkn(token) {
  let h = 5381;
  for (let i = 0; i < token.length; i++) h += (h << 5) + token.charCodeAt(i);
  return String(h & 0x7fffffff);
}

function maskKey(k) {
  if (!k || k.length < 12) return "***";
  return k.slice(0, 6) + "..." + k.slice(-4);
}

function maskCookie(c) {
  if (!c) return "";
  const tok = cookieField(c, "IMA-TOKEN");
  const uid = cookieField(c, "IMA-UID");
  return `IMA-UID=${uid || "?"} IMA-TOKEN=${tok ? tok.slice(0, 6) + "…" + tok.slice(-4) : "?"}`;
}

// ============================================================
// 2. 账号池（多账号 + 轮换 + 故障切换）
// ============================================================
function activeAccounts() {
  return (CONFIG.accounts || []).filter(a => a.enabled !== false && a.cookie);
}

function headersFor(account) {
  const token = cookieField(account.cookie, "IMA-TOKEN");
  return {
    "from_browser_ima": "1",
    "x-ima-cookie": account.cookie,
    "x-ima-bkn": calcBkn(token),
    referer: BASE_URL,
    origin: BASE_URL,
    "User-Agent": "okhttp/4.12.0",
    "Content-Type": "application/json; charset=utf-8",
    "Accept-Encoding": "gzip",
  };
}

// 轮换游标
let _rrCursor = 0;
function pickAccounts() {
  const list = activeAccounts();
  if (!list.length) return [];
  // 从游标处开始，返回一个轮换顺序的副本，用于逐个尝试（故障切换）
  const n = list.length;
  const start = _rrCursor % n;
  _rrCursor = (_rrCursor + 1) % Math.max(n, 1);
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[(start + i) % n]);
  return out;
}

// 账号统计（供管理页展示）
// 账号有效性判定。取值：
//   disabled  已停用      —— 用户手动停用，不参与轮换
//   nocookie  缺凭据      —— 没有 cookie，不可用
//   invalid   已失效      —— 上游明确回鉴权失败（登录过期/账号被踢）
//   error     异常        —— 网络/超时/上游其他错误，不代表凭据坏了
//   ok        有效        —— 最近一次真实调用成功
//   unknown   未验证      —— 刚添加还没跑过任何请求
function accountState(a) {
  if (a.enabled === false) return "disabled";
  if (!a.cookie) return "nocookie";
  if (a.last_error) return a.last_error_kind === "auth" ? "invalid" : "error";
  if (a.last_ok) return "ok";
  return "unknown";
}

// token 剩余有效期：由「最近成功续期时间 + 接口返回的有效秒数」推算。
// 没有续期记录时返回 null（此时凭据可能仍有效，只是无法推算，如实显示"未验证"）。
function accountExpiry(a) {
  const valid = Number(a.token_valid_time) || 0;
  if (!a.last_refresh || !valid) return null;
  const expireAt = new Date(a.last_refresh).getTime() + valid * 1000;
  return {
    expire_at: new Date(expireAt).toISOString(),
    remain_seconds: Math.round((expireAt - Date.now()) / 1000),
  };
}

function accountStats() {
  return (CONFIG.accounts || []).map(a => {
    const exp = accountExpiry(a);
    return {
      id: a.id,
      name: a.name,
      enabled: a.enabled !== false,
      state: accountState(a),
      has_cookie: !!a.cookie,
      has_refresh_token: !!a.refresh_token,
      cookie_masked: maskCookie(a.cookie),
      last_ok: a.last_ok || null,
      last_check: a.last_check || null,
      last_error: a.last_error || null,
      last_error_kind: a.last_error_kind || null,
      last_refresh: a.last_refresh || null,
      token_valid_time: Number(a.token_valid_time) || null,
      expire_at: exp ? exp.expire_at : null,
      remain_seconds: exp ? exp.remain_seconds : null,
      ok_count: a.ok_count || 0,
      fail_count: a.fail_count || 0,
    };
  });
}

// 记录一次真实探测结果（供"一键检测"用，与业务调用的统计分开标注）
function markChecked(account, ok, errOrMsg) {
  if (!account) return;
  const live = (CONFIG.accounts || []).find(x => x.id === account.id);
  if (!live) return;
  live.last_check = new Date().toISOString();
  touchAccount(account, ok, errOrMsg);
  saveConfig();
}

// 记录失败：ok=false 时 errOrMsg 可以是 Error（能取到 imaCode）或字符串
function touchAccount(account, ok, errOrMsg) {
  if (!account) return;
  const live = (CONFIG.accounts || []).find(x => x.id === account.id);
  if (!live) return;
  if (ok) {
    live.ok_count = (live.ok_count || 0) + 1;
    live.last_ok = new Date().toISOString();
    live.last_error = null;
    live.last_error_kind = null;
  } else {
    const msg = (errOrMsg && errOrMsg.message) || String(errOrMsg || "unknown");
    live.fail_count = (live.fail_count || 0) + 1;
    live.last_error = msg.slice(0, 300);
    // 区分"凭据失效"与"网络/上游抖动"——前者要重新登录，后者重试即可
    live.last_error_kind = isAuthError(errOrMsg) ? "auth" : "other";
  }
}

// ============================================================
// 2b. HTTP 客户端（每个请求绑定账号）
// ============================================================
function imaPost(path, body, account, extraH = {}, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: BASE_HOST, port: 443, path, method: "POST",
      headers: { ...headersFor(account), ...extraH, "Content-Length": Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      const zlib = require("zlib");
      const encoding = res.headers["content-encoding"] || "";
      let stream = res;
      if (encoding === "gzip") stream = res.pipe(zlib.createGunzip());
      else if (encoding === "deflate") stream = res.pipe(zlib.createInflate());
      const chunks = [];
      stream.on("data", (c) => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload); req.end();
  });
}

function imaSse(path, body, account) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = https.request({
      hostname: BASE_HOST, port: 443, path, method: "POST",
      headers: { ...headersFor(account), Accept: "text/event-stream", "Content-Length": Buffer.byteLength(payload) },
      timeout: 180000,
    }, (res) => {
      if (res.statusCode !== 200) {
        let e = ""; res.on("data", c => e += c);
        res.on("end", () => reject(new Error(`HTTP ${res.statusCode}: ${e}`)));
        return;
      }
      resolve(parseSSE(res));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("SSE timeout")); });
    req.write(payload); req.end();
  });
}

function parseSSEBlock(part) {
  let event = "";
  const dataLines = [];
  for (const line of part.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    else if (line.startsWith("data")) dataLines.push("");
  }
  return { event, data: dataLines.join("\n") };
}

async function* parseSSE(readable) {
  let buf = "";
  for await (const chunk of readable) {
    buf += chunk.toString("utf-8");
    const parts = buf.split(/\r?\n\r?\n/); buf = parts.pop() || "";
    for (const part of parts) {
      if (!part.trim()) continue;
      const evt = parseSSEBlock(part);
      if (evt.event || evt.data) yield evt;
    }
  }
  if (buf.trim()) {
    const evt = parseSSEBlock(buf);
    if (evt.event || evt.data) yield evt;
  }
}

const CONTROL_EVENTS = new Set(["COMPLETED", "CLOSE", "INNER_EXCEPTION", "ERROR", "FAILED"]);
const DEBUG_SSE = process.env.IMA_DEBUG === "1";

function extractEventText(d) {
  if (d == null) return "";
  if (typeof d === "string") return d;
  if (typeof d !== "object") return String(d);
  for (const k of ["Text", "text", "Content", "content", "Delta", "delta", "Msg", "msg", "reply", "Reply", "answer", "Answer"]) {
    const v = d[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

function eventText(evt) {
  const raw = evt && evt.data;
  if (!raw) return "";
  let d;
  try { d = JSON.parse(raw); }
  catch { try { d = tryRepairJson(raw); } catch { d = null; } }
  if (d == null) return "";
  return extractEventText(d);
}

// ============================================================
// 3. IMA API
// ============================================================
async function imaInitSession(question, account) {
  const { data } = await imaPost("/cgi-bin/session_logic/init_session", {
    env_info: { interact_type: 2, robot_type: 10000 },
    name: (question || "新对话").slice(0, 50),
    msgs_limit: 20,  // IMA 上限为 20（超过会报 code=51）
  }, account);
  if (data.code === 0) return data.session_id;
  const err = new Error(`InitSession failed: code=${data.code} msg=${data.msg}`);
  err.imaCode = data.code;
  throw err;
}

function imaQaStream(sessionId, question, modelType, modelId, account) {
  return imaSse("/cgi-bin/assistant/qa", {
    session_id: sessionId,
    robot_type: 10000,
    question,
    question_type: 2,
    command_info: { question_info: {} },
    client_id: crypto.randomUUID(),
    model_info: { model_type: modelType, model_id: modelId },
  }, account);
}

async function collectResponseText(events) {
  let text = "";
  const seen = [];
  for await (const evt of events) {
    if (CONTROL_EVENTS.has(evt.event)) break;
    text += eventText(evt);
    if (DEBUG_SSE) seen.push(evt.event || "(none)");
  }
  if (DEBUG_SSE && !text) console.error(`[SSE-EMPTY] events=${JSON.stringify(seen)}`);
  return text;
}

// ============================================================
// 4. 会话缓存（按 账号+会话 绑定，避免多账号串台）
// ============================================================
const sessions = new Map();
const SESSION_TTL = 30 * 60 * 1000;
const sessionKey = (convId, account) => `${account ? account.id : "_"}::${convId || "_"}`;

function getCachedSession(convId, account) {
  const now = Date.now();
  for (const [k, v] of sessions) { if (now - v.ts > SESSION_TTL) sessions.delete(k); }
  const key = sessionKey(convId, account);
  if (sessions.has(key)) { sessions.get(key).ts = now; return sessions.get(key).id; }
  return null;
}

async function ensureSession(convId, question, account, forceNew = false) {
  if (!forceNew) {
    const c = getCachedSession(convId, account);
    if (c) return c;
  }
  const id = await imaInitSession(question, account);
  if (convId) sessions.set(sessionKey(convId, account), { id, ts: Date.now() });
  return id;
}

// 判断错误是否属于"该换账号了"（登录过期 / 凭据失效）
function isAuthError(err) {
  const msg = (err && err.message) || "";
  const code = err && err.imaCode;
  // 41/600001: 登录失败/登录过期；5/51: 会话无效
  if (code === 41 || code === 600001 || code === 5 || code === 51) return true;
  return /登录过期|重新登录|登录失败|Session init failed|unauthor|invalid.*token|401|403/i.test(msg);
}

// ⭐ 多账号：逐个账号尝试；当前账号鉴权失败则自动切下一个。
//    IMA 会话达到 msgs_limit 后自动重建，避免"突然结束"。
async function imaQaStreamWithRetry(convId, question, modelType, modelId) {
  const candidates = pickAccounts();
  if (!candidates.length) {
    throw new Error("没有可用账号：请在配置页添加至少一个 Cookie 账号");
  }
  let lastErr = null;
  for (let i = 0; i < candidates.length; i++) {
    const account = candidates[i];
    try {
      let sessionId = await ensureSession(convId, question, account);
      const events = await imaQaStream(sessionId, question, modelType, modelId, account);
      touchAccount(account, true);
      // 包装成生成器，出错时若属鉴权错误则切换下一账号
      return await (async function*() {
        for await (const evt of events) {
          if (evt.event === "INNER_EXCEPTION" || evt.event === "ERROR" || evt.event === "FAILED") {
            // IMA 会话满了通常返回 INNER_EXCEPTION，此时重建 session 重试一次
            try {
              const newId = await ensureSession(convId, question, account, true);
              const retryEvents = await imaQaStream(newId, question, modelType, modelId, account);
              for await (const e2 of retryEvents) yield e2;
            } catch (_) {
              yield evt; // 重试也失败，把原始事件透传出去
            }
            return;
          }
          yield evt;
        }
      })();
    } catch (e) {
      lastErr = e;
      const canFailover = isAuthError(e) || /timeout|ECONN|socket hang up/i.test(e.message || "");
      touchAccount(account, false, e);
      console.error(`[ACCOUNT-FAIL] ${account.name}: ${e.message}${canFailover ? " → 尝试下一账号" : ""}`);
      if (!canFailover) throw e;
      // 继续循环尝试下一个账号
    }
  }
  throw lastErr || new Error("所有账号均不可用");
}

// ============================================================
// 5. 模型（配置可热更新，故用 getter）
// ============================================================
function getModels() { return CONFIG.models || {}; }
function getDefaultModel() { return CONFIG.default_model || Object.keys(getModels())[0]; }

function resolveModel(requested) {
  const MODELS = getModels();
  const DEFAULT_MODEL = getDefaultModel();
  if (!requested) return MODELS[DEFAULT_MODEL];
  if (MODELS[requested]) return MODELS[requested];
  const lower = requested.toLowerCase();
  for (const [k, v] of Object.entries(MODELS)) {
    if (k.toLowerCase() === lower || String(v.type) === lower) return v;
  }
  return MODELS[DEFAULT_MODEL];
}

// ============================================================
// 6. 认证 & 工具
// ============================================================
function checkAuth(req) {
  const keys = new Set(CONFIG.api_keys || []);
  const bearer = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
  if (bearer && keys.has(bearer)) return true;
  return keys.has(req.headers["x-api-key"] || "");
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers",
    "Content-Type, Authorization, x-api-key, x-conversation-id, x-session-id, x-request-id, x-stainless-*");
}

function json(res, code, obj) {
  cors(res);
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
  if (code >= 400) {
    console.error(`[RESP] ${code} ${JSON.stringify(obj).slice(0, 200)}`);
  }
}

function extractContent(msg) {
  if (typeof msg.content === "string") return msg.content;
  if (Array.isArray(msg.content))
    return msg.content.map(c => {
      if (c.type === "text") return c.text;
      if (c.type === "tool_result") {
        // Anthropic tool_result content 可能是 string 或 content_block[]
        const tc = typeof c.content === "string" ? c.content
          : Array.isArray(c.content) ? c.content.map(cc => cc.text || "").join("") : "";
        return `Tool result:\n${tc}`;
      }
      if (c.type === "tool_use") return `Tool call: ${c.name}(${JSON.stringify(c.input)})`;
      return "";
    }).filter(Boolean).join("\n");
  return String(msg.content || "");
}

// ============================================================
// 7. Function Calling — Prompt 注入引擎
// ============================================================

function escapeRawCtrlInStrings(s) {
  let out = "", inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === "\\") { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (inStr) {
      if (c === "\n") { out += "\\n"; continue; }
      if (c === "\r") { out += "\\r"; continue; }
      if (c === "\t") { out += "\\t"; continue; }
    }
    out += c;
  }
  return out;
}

// 修复 LLM 常见的 JSON 错误 (未转义引号、尾逗号、缺括号、字符串内裸换行)
function tryRepairJson(raw) {
  try { return JSON.parse(raw); } catch (e) { /* continue */ }
  let fixed = raw;
  // 0. 转义字符串内的裸控制符 (写文件时 content 含真实换行 → 否则 JSON.parse 失败)
  fixed = escapeRawCtrlInStrings(fixed);
  try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  // 1. 去尾逗号
  fixed = fixed.replace(/,(\s*[}\]])/g, '$1');
  try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  // 2. 补缺失的闭合括号
  let depth = 0;
  for (const c of fixed) {
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') depth--;
  }
  if (depth > 0) {
    const lastChar = fixed.trim().slice(-1);
    const closer = lastChar === '}' ? ']' : '}';
    fixed += closer.repeat(Math.min(depth, 5));
    try { return JSON.parse(fixed); } catch (e) { /* continue */ }
  }
  // 3. 提取 name + arguments (即使 JSON 破损也能尽可能恢复)
  const nameMatch = fixed.match(/"name"\s*:\s*"([^"]+)"/);
  if (nameMatch) {
    const argsStart = fixed.indexOf('{', fixed.indexOf('"arguments"'));
    if (argsStart >= 0) {
      let d = 0, end = -1;
      for (let i = argsStart; i < fixed.length; i++) {
        if (fixed[i] === '{' || fixed[i] === '[') d++;
        if (fixed[i] === '}' || fixed[i] === ']') { d--; if (d === 0) { end = i + 1; break; } }
      }
      try { return { name: nameMatch[1], arguments: JSON.parse(fixed.slice(argsStart, end)) }; } catch (e) { /* fall through */ }
    }
    return { name: nameMatch[1], arguments: {} };
  }
  return null;
}

// 压缩 JSON Schema: 去掉 $schema/$defs/$ref 等元数据，单行紧凑输出
function compactSchema(schema) {
  if (!schema || typeof schema !== "object") return "{}";
  // 深拷贝后递归清理
  function clean(obj) {
    if (Array.isArray(obj)) return obj.map(clean);
    if (obj && typeof obj === "object") {
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k.startsWith("$")) continue;  // 去掉 $schema, $defs, $ref, $dynamicAnchor 等
        out[k] = clean(v);
      }
      return out;
    }
    return obj;
  }
  return JSON.stringify(clean(schema));  // 单行，无缩进
}

function buildToolsPrompt(tools) {
  if (!tools || tools.length === 0) return "";

  const funcDefs = tools
    .filter(t => t.type === "function" && t.function)
    .map(t => {
      const fn = t.function;
      const params = compactSchema(fn.parameters);
      return `<function name="${fn.name}">
<description>${fn.description || "No description"}</description>
<parameters>${params}</parameters>
</function>`;
    })
    .join("\n");

  return `## ⚠️ CRITICAL — YOU MUST USE FUNCTION CALLING

You have access to these functions. When the user asks you to do something
that a function can handle, you MUST call the function. NEVER say "I cannot"
or "I don't have the ability". NEVER tell the user to save a file, run a
command, or do any step themselves — DO IT by calling the function (e.g. use
Write to create files, Bash to run commands). ALWAYS use a function instead.

${funcDefs}

## HOW TO CALL A FUNCTION

Output EXACTLY this format, then STOP:

<function_call>
{"name": "<function_name>", "arguments": {<args_as_json>}}
</function_call>

Rules:
- arguments MUST be a valid JSON object matching the function's parameters
- For file content, put the FULL content in the string value (newlines allowed)
- Do NOT add any text before or after the <function_call> block
- NEVER output file content or code for the user to copy — write it via Write`;
}

// ⭐ 工具结果回传轮专用 — "继续行动"版工具提示。
// 修复历史: ① 旧的强制版 ("YOU MUST call / 不要输出任何文本") 让模型回传轮要么再发多余
// 调用要么沉默; ② 过软版 ("有足够信息就用纯文本作答") 又走向另一极端 —— 模型把"让我先读
// 取文件"这种【意图叙述】当成回答然后停手, 多步任务半途而废。
// 本版核心原则: 叙述意图 ≠ 完成任务。只要还有未完成的步骤, 必须【在本轮就发出函数调用】,
// 不能只说"我接下来要做 X"。只有当任务真正全部完成时, 才用纯文本给出最终答复。
function buildToolsPromptSoft(tools) {
  if (!tools || tools.length === 0) return "";

  const funcDefs = tools
    .filter(t => t.type === "function" && t.function)
    .map(t => {
      const fn = t.function;
      return `<function name="${fn.name}">
<description>${fn.description || "No description"}</description>
<parameters>${compactSchema(fn.parameters)}</parameters>
</function>`;
    })
    .join("\n");

  return `## Available functions

${funcDefs}

## CRITICAL — keep going until the task is fully done

The user's request may need MULTIPLE steps. After each function result, decide:
the task is NOT finished yet → call the next function NOW; the task IS fully
finished → give the final answer in plain text.

NEVER reply with only your intention (e.g. "Let me read the file", "I'll now
start the server", "下一步我将…"). Stating intent is NOT an action and NOT an
answer. If you intend to do something, you MUST emit the function call for it
in THIS SAME reply.

## To call a function
Output EXACTLY: <function_call>{"name":"...","arguments":{...}}</function_call> then stop.
(For file content, put the FULL content in the string value; newlines allowed.)

## To finish
Only when every step is done, reply to the user in plain text WITHOUT any
<function_call> block.`;
}

// ⭐ StreamFilter: 实时过滤流式输出中的 <function_call> 块
// 防止 Claude Code 客户端因看到 XML 标记而截停
class StreamFilter {
  constructor() {
    this._buf = '';           // 未决缓冲区
    this._emitted = '';       // 已输出的纯净文本
    this._funcBlocks = [];    // 捕获的 function_call JSON
    this._inFunc = false;     // 是否在 <function_call> 内部
    this._tagLen = 16;        // '<function_call>'.length
    this._leftover = '';      // ⭐ parseCalls 无法解析的残留文本 (供流式层兜底输出)
  }

  // 喂入新文本块，返回应发送给客户端的纯净文本 (可能为空)
  feed(chunk) {
    this._buf += chunk;
    const out = [];
    const startTag = '<function_call>';
    const endTag = '</function_call>';

    while (this._buf.length > 0) {
      if (!this._inFunc) {
        const idx = this._buf.indexOf(startTag);
        if (idx === -1) {
          // 没有发现开始标签 — 但先检查尾部是否部分匹配
          const partialLen = this._partialMatch(startTag);
          if (partialLen > 0) {
            // 保留可能的部分标签在缓冲区
            const safe = this._buf.slice(0, -partialLen);
            if (safe) out.push(safe);
            this._buf = this._buf.slice(-partialLen);
            break;
          }
          // 完全安全，全部输出
          out.push(this._buf);
          this._buf = '';
          break;
        }
        // 发现开始标签 — 输出标签之前的文本
        if (idx > 0) out.push(this._buf.slice(0, idx));
        this._buf = this._buf.slice(idx + startTag.length);
        this._inFunc = true;
      }

      if (this._inFunc) {
        const idx = this._buf.indexOf(endTag);
        if (idx === -1) {
          // 还没找到结束标签 — 全部抑制
          break;
        }
        // 找到结束标签 — 捕获函数调用 JSON
        const json = this._buf.slice(0, idx).trim();
        if (json) this._funcBlocks.push(json);
        this._buf = this._buf.slice(idx + endTag.length);
        this._inFunc = false;
        // 继续循环，可能后面还有文本或更多 function_call
      }
    }

    const text = out.join('');
    if (text) this._emitted += text;
    return text;
  }

  // 检查缓冲区末尾是否部分匹配 tag
  _partialMatch(tag) {
    for (let i = tag.length - 1; i > 0; i--) {
      if (this._buf.endsWith(tag.slice(0, i))) return i;
    }
    return 0;
  }

  // 流结束时调用 — 返回可能残留的缓冲区内容 (不含 function_call 部分)
  flush() {
    if (this._inFunc) {
      // ⭐ 修复: 流在 </function_call> 到达前就结束了 (IMA 截断 / 模型漏写闭合标签)。
      // 旧逻辑直接丢弃缓冲区, 导致"调用命令后无任何回复" — 这里改为把残留 JSON
      // 当作一个 function block 捕获, 交给 parseCalls() 去尽力修复。
      const pending = this._buf.trim();
      if (pending) this._funcBlocks.push(pending);
      this._buf = '';
      this._inFunc = false;
      return '';
    }
    if (this._buf) {
      this._emitted += this._buf;
      const r = this._buf;
      this._buf = '';
      return r;
    }
    return '';
  }

  // 解析已捕获的所有 function_call 块
  parseCalls() {
    const calls = [];
    for (const raw of this._funcBlocks) {
      const parsed = tryRepairJson(raw);
      if (parsed && parsed.name) {
        calls.push({
          id: 'toolu_' + crypto.randomUUID().slice(0, 12),
          type: 'function',
          function: {
            name: parsed.name || '',
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        });
      } else if (raw.length > 0) {
        // ⭐ JSON 修复失败 — 累积到 _leftover, 由流式层兜底输出, 避免对话静默中断。
        // (非流式走 cleanText/_emitted; 流式层需读取 leftover 单独 emit)
        const note = '\n[Function call (malformed)]:\n' + raw + '\n';
        this._emitted += note;
        this._leftover += note;
      }
    }
    return calls;
  }

  get cleanText() { return this._emitted; }
  get hasFunc() { return this._funcBlocks.length > 0; }
  get leftover() { return this._leftover; }
}

function parseFunctionCalls(text) {
  if (!text) return { found: false, text: "" };

  // 也匹配 ```json {...} ``` 格式 (模型可能输出 JSON 代码块)
  const jsonBlockRegex = /```(?:json)?\s*\n?\s*(\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})\s*\n?\s*```/g;

  const regex = /<function_call>\s*\n?\s*(\{[\s\S]*?\})\s*\n?\s*<\/function_call>/g;
  const calls = [];
  let cleanText = text;

  // 尝试两种格式: <function_call> 和 ```json name/arguments
  const patterns = [
    regex,
    /```(?:json)?\s*\n?\s*\{[^{}]*"name"\s*:\s*"[^"]+"[^{}]*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}\s*\n?\s*```/g,
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const parsed = tryRepairJson(match[1].trim());
      if (parsed && parsed.name) {
        calls.push({
          id: "toolu_" + crypto.randomUUID().slice(0, 12),
          type: "function",
          function: {
            name: parsed.name || "",
            arguments: JSON.stringify(parsed.arguments || parsed.parameters || {}),
          },
        });
      }
    }
    if (calls.length > 0) break;
  }

  if (calls.length > 0) {
    cleanText = text.replace(regex, "").replace(/```(?:json)?\s*\n?\s*\{[\s\S]*?\}\s*\n?\s*```/g, "").trim();
    return { found: true, calls, text: cleanText };
  }

  // 调试: 检查模型是否输出了近似的 function call 格式
  if (text.includes('function') || text.includes('tool') || text.includes('bash') || text.includes('read_file')) {
  }
  return { found: false, text };
}

// ============================================================
// 8. OpenAI /v1/chat/completions
// ============================================================
async function openaiChat(req, res, body) {
  const modelKey = body.model || getDefaultModel();
  const model = resolveModel(modelKey);
  const stream = !!body.stream;
  const messages = body.messages || [];
  const tools = body.tools || null;
  const toolChoice = body.tool_choice || null;

  // --- 构建 question ---
  const hasToolResults = messages.some(m => m.role === "tool");
  const hasToolCalls = messages.some(m => m.role === "assistant" && m.tool_calls);
  let question;

  // 确定工具集 (两个分支共用)
  let effectiveTools = tools;
  if ((!effectiveTools || effectiveTools.length === 0) && toolChoice !== "none") {
    effectiveTools = [
      {type: "function", function: {name: "Bash", description: "Execute bash command", parameters: {type: "object", properties: {command: {type: "string"}}, required: ["command"]}}},
      {type: "function", function: {name: "Read", description: "Read a file", parameters: {type: "object", properties: {file_path: {type: "string"}}, required: ["file_path"]}}},
      {type: "function", function: {name: "Write", description: "Write to a file", parameters: {type: "object", properties: {file_path: {type: "string"}, content: {type: "string"}}, required: ["file_path", "content"]}}},
      {type: "function", function: {name: "Glob", description: "Find files by pattern", parameters: {type: "object", properties: {pattern: {type: "string"}}, required: ["pattern"]}}},
      {type: "function", function: {name: "Grep", description: "Search file contents", parameters: {type: "object", properties: {pattern: {type: "string"}, path: {type: "string"}}, required: ["pattern"]}}},
    ];
  }
  // ⭐ 标题生成请求不需要 tools
  const _sysParts = messages.filter(m => m.role === "system").map(m => extractContent(m));
  const _sysPrompt = _sysParts.length > 0 ? _sysParts.join("\n") : "";
  const isTitleGenOAI = _sysPrompt.includes('Generate a concise, sentence-case title');

  // ⭐ 限制工具数量，防止 prompt 超出限制
  const MAX_TOOLS_OAI = 8;
  const ESSENTIAL_OAI = new Set(['Bash', 'Read', 'Write', 'Glob', 'Grep']);
  if (isTitleGenOAI) {
    effectiveTools = [];  // 标题生成不需要工具
  } else if (effectiveTools && effectiveTools.length > MAX_TOOLS_OAI) {
    const essential = effectiveTools.filter(t => ESSENTIAL_OAI.has(t.function?.name));
    const others = effectiveTools.filter(t => !ESSENTIAL_OAI.has(t.function?.name));
    const available = MAX_TOOLS_OAI - essential.length;
    effectiveTools = [...essential, ...others.slice(0, Math.max(0, available))];
  }
  const toolsPrompt = (effectiveTools && effectiveTools.length > 0 && toolChoice !== "none")
    ? buildToolsPrompt(effectiveTools) : "";

  let toolResultPathOAI = false;

  if (hasToolResults && hasToolCalls) {
    toolResultPathOAI = true;
    // 工具结果回传轮 — 单段系统通知格式
    const lastUserOAI = messages.filter(m => m.role === "user").pop();
    const lastUserTextOAI = extractContent(lastUserOAI || {});
    const cjkOAI = /[一-鿿㐀-䶿]/.test(lastUserTextOAI);

    // 收集函数调用和结果
    const calledOAI = [], resultsOAI = [];
    for (const m of messages) {
      if (m.role === "assistant" && m.tool_calls) {
        for (const tc of m.tool_calls) calledOAI.push(tc.function.name + "(" + tc.function.arguments + ")");
      }
      if (m.role === "tool") {
        resultsOAI.push(extractContent(m).slice(0, 3000));
      }
    }
    // 找到用户原始提问
    const userQsOAI = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some(c => c.type === "tool_result")) continue;
      const q = extractContent(m);
      if (q && !q.startsWith("<session") && !q.startsWith("<system-reminder")) userQsOAI.push(q);
    }
    const origQ = userQsOAI.length > 0 ? userQsOAI[userQsOAI.length - 1] : (lastUserTextOAI || "");

    if (cjkOAI) {
      question = "⚠️ 系统通知：你刚才调用了以下函数，返回结果如下：\n\n";
      for (let i = 0; i < calledOAI.length; i++) {
        question += "函数调用: " + calledOAI[i] + "\n返回结果:\n\"\"\"\n" + (resultsOAI[i] || "") + "\n\"\"\"\n\n";
      }
      question += "用户原始提问: \"" + origQ + "\"\n\n请用简体中文直接回答用户的问题。说出答案即可。不要说\"你分享了\"或\"看起来像是\"。上面用 \"\"\" 包裹的内容是你自己调用函数得到的返回结果。";
    } else {
      question = "⚠️ SYSTEM: You just called these functions and received these outputs:\n\n";
      for (let i = 0; i < calledOAI.length; i++) {
        question += "Function: " + calledOAI[i] + "\nOutput:\n\"\"\"\n" + (resultsOAI[i] || "") + "\n\"\"\"\n\n";
      }
      question += "User's original question: \"" + origQ + "\"\n\nAnswer DIRECTLY based on the outputs. Do NOT say \"you shared\" or \"it looks like\". The \"\"\" content is YOUR function output, NOT user input.";
    }

    // 工具结果回传轮: 不携带完整 sysPrompt, 仅 5 个核心工具
    // ⭐ 用软版提示 — 允许模型直接用文字作答, 避免被强制再发 function_call 而沉默
    const minimalOAI = buildToolsPromptSoft(
      (effectiveTools || []).filter(t => ESSENTIAL_OAI.has(t.function?.name)).slice(0, 5)
    );
    question = minimalOAI + "\n\n---\n" + question;
  } else {
    // 普通问答 / 首轮 tool calling
    let sysPrompt = "";
    const sysParts = messages.filter(m => m.role === "system").map(m => extractContent(m));
    if (sysParts.length > 0) sysPrompt = sysParts.join("\n");

    const nonSys = messages.filter(m => m.role !== "system" && m.role !== "tool");
    const userMsgs = nonSys.filter(m => m.role === "user");
    if (userMsgs.length === 0) {
      return json(res, 400, { error: { message: "No user message", type: "invalid_request_error" } });
    }

    // ⭐ 跳过系统注入消息 (<session>, <system-reminder>)
    const realUserMsgs = userMsgs.filter(m => {
      const c = extractContent(m);
      return !c.startsWith('<session') && !c.startsWith('<system-reminder') && c.length > 10;
    });
    const lastUserMsg = realUserMsgs.length > 0
      ? extractContent(realUserMsgs[realUserMsgs.length - 1])
      : extractContent(userMsgs[userMsgs.length - 1]);

    // ⭐ 语言检测
    const hasCJKOAI = /[一-鿿㐀-䶿]/.test(lastUserMsg);
    const langHintOAI = hasCJKOAI ? "\n## Language\nRespond in the same language as the user's message. The user is writing in Chinese — respond in Chinese (简体中文).\n" : "";

    // IMA question 字段限制 10240 字符
    const MAX_QUESTION = 10000;

    if (nonSys.length > 1 && realUserMsgs.length >= 1) {
      const realMsgs = nonSys.filter(m => {
        const c = extractContent(m);
        return c.length > 10 && !c.startsWith('<session') && !c.startsWith('<system-reminder');
      });
      if (realMsgs.length > 1) {
        // ⭐ 修复: 扩展到 20 条，按字符数动态裁剪
        const MAX_HISTORY_CHARS = 6000;
        const recentMsgs = realMsgs
          .filter(m => m.role === "user" || m.role === "assistant")
          .slice(-20);
        let historyParts = [];
        let historyLen = 0;
        for (let i = recentMsgs.length - 1; i >= 0; i--) {
          const m = recentMsgs[i];
          const line = `${m.role === "user" ? "User" : "Assistant"}: ${extractContent(m)}`;
          if (historyLen + line.length > MAX_HISTORY_CHARS && historyParts.length > 0) break;
          historyParts.unshift(line);
          historyLen += line.length + 1;
        }
        const history = historyParts.join("\n");
        question = (sysPrompt ? sysPrompt + "\n\n" : "") + (toolsPrompt ? toolsPrompt + "\n\n---\n" : "") + history;
      } else {
        question = `${sysPrompt ? "(Background)\n" + sysPrompt + "\n\n" : ""}${toolsPrompt}\n\n---\nUser message (respond to this):\n${lastUserMsg}`;
      }
    } else {
      // ⭐ 智能压缩 system prompt (保留 toolsPrompt 完整)
      let context = sysPrompt;
      const overhead = toolsPrompt.length + lastUserMsg.length + 200;
      const remaining = MAX_QUESTION - overhead;

      if (context && context.length > remaining && remaining > 0) {
        // ⭐ 修复: 保留头尾，中间裁剪（保留核心规则 + 最新文件信息）
        const layoutMatch = context.match(/<project_layout>([\s\S]*?)<\/project_layout>/);
        const layoutSummary = layoutMatch
          ? layoutMatch[1].trim().split("\n").slice(0, 30).join("\n")
          : "";
        const headLen = Math.min(800, Math.floor(remaining * 0.6));
        const tailLen = Math.min(400, remaining - headLen);
        const head = context.slice(0, headLen);
        const tail = context.length > headLen + tailLen ? context.slice(-tailLen) : "";
        const layoutPart = layoutSummary ? "\n\nDirectory (summary):\n" + layoutSummary.slice(0, Math.min(300, remaining - headLen - tailLen - 50)) : "";
        context = tail ? head + "\n...[truncated]..." + layoutPart + "\n" + tail : head + layoutPart;
        context = context.slice(0, remaining);
      }

      question = `${context ? "(Background)\n" + context + "\n\n" : ""}${toolsPrompt}\n\n---\nUser message (respond to this):\n${lastUserMsg}`;
    }

    // ⭐ 注入语言提示 & 截断 (工具结果回传轮跳过)
    if (!toolResultPathOAI) {
      question += langHintOAI;

      // 最终截断 — 始终保留 toolsPrompt，否则模型看不到 function 定义
      if (question.length > MAX_QUESTION) {
        const minTemplate = "\n\n---\nUser message (respond to this):\n";
        const compact = toolsPrompt + minTemplate + lastUserMsg + langHintOAI;
        if (compact.length > MAX_QUESTION) {
          const availForUser = Math.max(500, MAX_QUESTION - toolsPrompt.length - minTemplate.length - langHintOAI.length);
          question = toolsPrompt + minTemplate + lastUserMsg.slice(0, Math.max(0, availForUser)) + langHintOAI;
        } else {
          question = compact;
        }
      }
    }
  }

  if (!question) {
    return json(res, 400, { error: { message: "Empty question", type: "invalid_request_error" } });
  }


  // 会话 — 复用 IMA session 保持对话记忆
  // ⭐ 修复: 用系统 prompt 作为稳定锚点（同 Anthropic 路径保持一致）
  let oaiConvId = req.headers["x-conversation-id"] || req.headers["x-session-id"] || "";
  if (!oaiConvId && messages.length > 0) {
    const sysMsg = messages.find(m => m.role === "system");
    const anchor = sysMsg
      ? extractContent(sysMsg).slice(0, 200)
      : extractContent(messages[0]).slice(0, 200);
    oaiConvId = "conv-" + crypto.createHash("md5").update(anchor).digest("hex").slice(0, 12);
  }
  // 前置检查：内部多账号流已自管 session，这里仅用于提前暴露"无账号"错误
  if (!activeAccounts().length) {
    return json(res, 503, { error: { message: "没有可用账号：请在配置页添加至少一个 Cookie 账号", type: "api_error" } });
  }

  // --- 非流式 ---
  if (!stream) {
    try {
      const events = await imaQaStreamWithRetry(oaiConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text);

      const choice = { index: 0, message: {}, finish_reason: "stop" };

      if (parsed.found && parsed.calls.length > 0) {
        choice.message = {
          role: "assistant",
          content: parsed.text || null,
          tool_calls: parsed.calls,
        };
        choice.finish_reason = "tool_calls";
      } else {
        // ⭐ 兜底: 空文本时给出占位, 避免客户端收到完全空的回复
        choice.message = { role: "assistant", content: text || "(本轮没有生成内容，请重试或换一种问法。)" };
      }

      return json(res, 200, {
        id: "chatcmpl-" + crypto.randomUUID().slice(0, 8),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: modelKey,
        choices: [choice],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
    } catch (e) {
      return json(res, 502, { error: { message: "IMA error: " + e.message, type: "api_error" } });
    }
  }

  // --- 流式 ---
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "x-request-id": "chatcmpl-" + crypto.randomUUID().slice(0, 8),
  });

  const chatId = "chatcmpl-" + crypto.randomUUID().slice(0, 8);
  const created = Math.floor(Date.now() / 1000);
  let resClosed = false;
  let sentText = false;   // ⭐ 是否已向客户端发送过任何文本/工具内容 (兜底判断)
  res.on('close', () => { resClosed = true; });

  function emit(delta, finishReason, toolCalls) {
    if (resClosed) return;
    try {
      const d = toolCalls && toolCalls.length > 0
        ? { role: "assistant", tool_calls: toolCalls }
        : { role: "assistant", content: delta };
      if ((delta && delta.length > 0) || (toolCalls && toolCalls.length > 0)) sentText = true;
      res.write("data: " + JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created, model: modelKey,
        choices: [{ index: 0, delta: d, finish_reason: finishReason }],
      }) + "\n\n");
    } catch (e) { resClosed = true; }
  }

  try {
    const events = await imaQaStreamWithRetry(oaiConvId, question, model.type, model.id);
    const filter = new StreamFilter();
    let done = false;

    let sawEvent = false;
    for await (const evt of events) {
      if (resClosed) break;
      if (CONTROL_EVENTS.has(evt.event)) {
        if (evt.event === "COMPLETED" || evt.event === "CLOSE") done = true;
        break;
      }
      sawEvent = true;
      const txt = eventText(evt);
      if (txt) {
        const clean = filter.feed(txt);
        if (clean) emit(clean, null, null);
      }
    }
    if (DEBUG_SSE && !sawEvent) console.error("[SSE-EMPTY] openai stream: no data events");

    // 冲刷残留缓冲
    const flushed = filter.flush();
    if (flushed && !resClosed) emit(flushed, null, null);

    // 检测并发送函数调用
    if (!resClosed) {
      const calls = filter.parseCalls();
      // ⭐ 无法解析的 function_call 残留 — 作为文本输出, 避免静默丢失
      if (filter.leftover) emit(filter.leftover, null, null);
      if (calls.length > 0) {
        // ⭐ OpenAI streaming tool_calls: 逐个发送
        for (let i = 0; i < calls.length; i++) {
          const tc = calls[i];
          if (resClosed) break;
          try {
            sentText = true;
            res.write("data: " + JSON.stringify({
              id: chatId, object: "chat.completion.chunk", created, model: modelKey,
              choices: [{ index: 0, delta: { tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, finish_reason: null }],
            }) + "\n\n");
          } catch (e) { resClosed = true; }
        }
        if (!resClosed) {
          res.write("data: " + JSON.stringify({
            id: chatId, object: "chat.completion.chunk", created, model: modelKey,
            choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
          }) + "\n\n");
        }
      } else {
        // ⭐ 兜底: 流正常结束但既无文本也无工具调用 (模型只回了被过滤的内容 /
        // 空响应 / 异常中断)。绝不让客户端收到完全空的回复 — 这是"无回复就结束"的根因。
        if (!sentText && !resClosed) {
          const fb = done
            ? "(本轮没有生成内容，请重试或换一种问法。)"
            : "(响应在完成前被中断，请重试。)";
          emit(fb, null, null);
        }
        // done 为 true 表示正常完成
        res.write("data: " + JSON.stringify({
          id: chatId, object: "chat.completion.chunk", created, model: modelKey,
          choices: [{ index: 0, delta: {}, finish_reason: done ? "stop" : "length" }],
        }) + "\n\n");
      }
    }
  } catch (e) {
    if (!resClosed) {
      try { res.write("data: " + JSON.stringify({
        id: chatId, object: "chat.completion.chunk", created, model: modelKey,
        choices: [{ index: 0, delta: {}, finish_reason: "error" }],
      }) + "\n\n"); } catch {}
    }
    console.error(`[STREAM-ERR] ${e.message}`);
  }
  if (!resClosed) {
    try { res.write("data: [DONE]\n\n"); res.end(); } catch {}
  }
}

// ============================================================
// 9. Anthropic /v1/messages
// ============================================================
async function anthropicMessages(req, res, body) {
  const modelKey = body.model || getDefaultModel();
  const model = resolveModel(modelKey);
  const stream = !!body.stream;
  const messages = body.messages || [];

  // system prompt
  let sysPrompt = "";
  if (typeof body.system === "string") sysPrompt = body.system;
  else if (Array.isArray(body.system))
    sysPrompt = body.system.filter(s => s.type === "text").map(s => s.text).join("\n");

  // tools → prompt injection
  // 如果 Claude Code 没发送 tools，注入默认工具集
  let tools = body.tools;
  if (!tools || tools.length === 0) {
    tools = [
      {name: "Bash", description: "Execute a bash command. Use for: reading files (cat/ls), system info (uname/df/free), git, npm, find, grep, etc.", input_schema: {type: "object", properties: {command: {type: "string", description: "The bash command to execute"}}, required: ["command"]}},
      {name: "Read", description: "Read contents of a file. Use for: inspecting file contents, reading configs, source code.", input_schema: {type: "object", properties: {file_path: {type: "string", description: "Absolute path to the file"}}, required: ["file_path"]}},
      {name: "Write", description: "Write content to a file. Use for: creating new files, overwriting existing files.", input_schema: {type: "object", properties: {file_path: {type: "string", description: "Absolute path"}, content: {type: "string", description: "Content to write"}}, required: ["file_path", "content"]}},
      {name: "Glob", description: "Find files matching a pattern. Use for: searching for files by name.", input_schema: {type: "object", properties: {pattern: {type: "string", description: "Glob pattern like **/*.js"}}, required: ["pattern"]}},
      {name: "Grep", description: "Search file contents for a pattern. Use for: finding code, searching logs.", input_schema: {type: "object", properties: {pattern: {type: "string", description: "Regex pattern to search for"}, path: {type: "string", description: "Directory or file to search in"}}, required: ["pattern"]}},
    ];
  }

  // ⭐ 标题生成请求不需要 tools (Claude Code 首轮请求)
  const isTitleGen = sysPrompt.includes('Generate a concise, sentence-case title');

  // ⭐ 限制工具数量，防止 prompt 超出 IMA 10240 字符限制
  const MAX_TOOLS = 8;
  const ESSENTIAL_TOOLS = new Set(['Bash', 'Read', 'Write', 'Glob', 'Grep']);
  let displayTools = tools;
  if (isTitleGen) {
    displayTools = [];  // 标题生成不需要工具
  } else if (displayTools.length > MAX_TOOLS) {
    // 优先保留核心工具，再按原顺序补充其他工具
    const essential = displayTools.filter(t => ESSENTIAL_TOOLS.has(t.name));
    const others = displayTools.filter(t => !ESSENTIAL_TOOLS.has(t.name));
    const available = MAX_TOOLS - essential.length;
    displayTools = [...essential, ...others.slice(0, Math.max(0, available))];
  }
  // —— 过滤消息 ——
  // ⭐ 检测 Anthropic 格式的 tool_use / tool_result (多轮回传)
  function msgHasType(msg, type) {
    if (Array.isArray(msg.content)) return msg.content.some(c => c.type === type);
    return false;
  }
  const hasToolUses = messages.some(m => m.role === "assistant" && msgHasType(m, "tool_use"));
  const hasToolResults = messages.some(m => m.role === "user" && msgHasType(m, "tool_result"));

  // ⭐ 清理用户消息中的系统注入元数据
  function stripMetadata(text) {
    return text
      // 删除元数据块 (含内容一起删)
      .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
      .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '')
      .replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '')
      // 删除单行命令元数据
      .replace(/<command-name>[^<]*<\/command-name>/g, '')
      .replace(/<command-message>[^<]*<\/command-message>/g, '')
      .replace(/<command-args>[^<]*<\/command-args>/g, '')
      // ⭐ <session> 只删标签、保留内容 (用户消息在 session 内)
      .replace(/<\/?session>/g, '')
      .trim();
  }

  const nonSys = messages.filter(m => m.role !== "system");
  const userMsgs = nonSys.filter(m => m.role === "user");
  if (userMsgs.length === 0)
    return json(res, 400, { type: "error", error: { type: "invalid_request_error", message: "No user message" } });

  // ⭐ 提取最后一条用户消息的实质内容
  const realUserMsgs = userMsgs.filter(m => {
    const c = stripMetadata(extractContent(m));
    return c.length > 5;
  });
  const lastUserMsg = realUserMsgs.length > 0
    ? stripMetadata(extractContent(realUserMsgs[realUserMsgs.length - 1]))
    : stripMetadata(extractContent(userMsgs[userMsgs.length - 1]));

  if (!lastUserMsg) {
  }

  // ⭐ 语言检测: 用户用中文则要求中文回复
  const hasCJK = /[一-鿿㐀-䶿]/.test(lastUserMsg);
  const langHint = hasCJK ? "\n## Language\nRespond in the same language as the user's message. The user is writing in Chinese — respond in Chinese (简体中文).\n" : "";

  // 工具通过 toolsPrompt 单独注入 (见下方 question 构建)
  const toolsPrompt = (displayTools && displayTools.length > 0) ? buildToolsPrompt(
    displayTools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }))
  ) : "";

  let question;
  let toolResultPath = false;  // 工具结果回传轮标记 (跳过 langHint 和截断)
  const MAX_QUESTION = 10000;

  if (hasToolResults && hasToolUses) {
    toolResultPath = true;  // 标记: 后续跳过 langHint 注入和通用截断
    // ⭐ 工具结果回传轮 — 单段系统通知格式，让模型把结果当作系统提供的信息
    const isCJK = hasCJK;

    // 收集工具调用名+结果
    const calledFuncs = [];
    const results = [];
    for (const m of messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "tool_use") calledFuncs.push(c.name + "(" + JSON.stringify(c.input) + ")");
        }
      }
      if (m.role === "user" && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c.type === "tool_result") {
            const tc = typeof c.content === "string" ? c.content
              : Array.isArray(c.content) ? c.content.map(cc => cc.text || "").join("") : "";
            results.push(tc);
          }
        }
      }
    }

    // 找到用户的原始提问 (第一条非 tool_result 的用户消息)
    const userQs = [];
    for (const m of messages) {
      if (m.role !== "user") continue;
      if (Array.isArray(m.content) && m.content.some(c => c.type === "tool_result")) continue;
      const q = stripMetadata(extractContent(m));
      if (q) userQs.push(q);
    }
    const originalQuestion = userQs.length > 0 ? userQs[userQs.length - 1] : (lastUserMsg || "");

    // 构建通知: 系统消息 + 函数调用 + 结果
    if (isCJK) {
      question = "⚠️ 系统通知：你刚才调用了以下函数，返回结果如下：\n\n";
      for (let i = 0; i < calledFuncs.length; i++) {
        question += "函数调用: " + calledFuncs[i] + "\n";
        question += "返回结果:\n\"\"\"\n" + (results[i] || "") + "\n\"\"\"\n\n";
      }
      question += "用户原始提问: \"" + originalQuestion + "\"\n\n";
      question += "请用简体中文直接回答用户的问题。说出答案即可。不要说\"你分享了\"或\"看起来像是\"或\"I see you've shared\"。上面用 \"\"\" 包裹的内容是你自己调用函数得到的返回结果，不是用户发给你的。";
    } else {
      question = "⚠️ SYSTEM: You just called these functions and received these outputs:\n\n";
      for (let i = 0; i < calledFuncs.length; i++) {
        question += "Function: " + calledFuncs[i] + "\n";
        question += "Output:\n\"\"\"\n" + (results[i] || "") + "\n\"\"\"\n\n";
      }
      question += "User's original question: \"" + originalQuestion + "\"\n\n";
      question += "Answer the user's question DIRECTLY based on the outputs above. Do NOT say \"you shared\" or \"I see you've shared\" or \"it looks like\". The content inside \"\"\" blocks is YOUR function output, NOT content the user sent you.";
    }

    // ⭐ 工具结果回传轮: 不携带完整 sysPrompt 和大量 tools (⚠️ 通知已提供足够上下文)
    // 仅保留 5 个核心工具, 确保总长度 < 10000 不会被后面的通用截断逻辑破坏
    // ⭐ 用软版提示 — 允许模型基于结果直接用文字回答, 而非被强制再发 function_call
    const minimalToolsPrompt = buildToolsPromptSoft(
      displayTools.filter(t => ESSENTIAL_TOOLS.has(t.name)).slice(0, 5)
        .map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema || {} } }))
    );
    question = minimalToolsPrompt + "\n\n---\n" + question;
    // 跳过后续的 langHint 注入和通用截断 — 此路径的 question 已包含语言指令且 < 10000
  } else if (nonSys.length > 1 && realUserMsgs.length >= 1) {
    // 取真正的用户消息（过滤掉系统注入的元数据）
    const realMsgs = nonSys
      .filter(m => {
        const c = stripMetadata(extractContent(m));
        return c.length > 5;
      });
    if (realMsgs.length > 1) {
      // ⭐ 修复: 从 6 条扩展到 20 条，并按总字符限制动态裁剪（保留最新的消息）
      const MAX_HISTORY_CHARS = 6000; // 留出空间给 sysPrompt + toolsPrompt
      const recentMsgs = realMsgs.slice(-20);
      let historyParts = [];
      let historyLen = 0;
      for (let i = recentMsgs.length - 1; i >= 0; i--) {
        const m = recentMsgs[i];
        const line = (m.role === "user" ? "User" : "Assistant") + ": " + stripMetadata(extractContent(m));
        if (historyLen + line.length > MAX_HISTORY_CHARS && historyParts.length > 0) break;
        historyParts.unshift(line);
        historyLen += line.length + 1;
      }
      question = historyParts.join("\n");
      question = (sysPrompt ? sysPrompt + "\n\n" : "") + (toolsPrompt ? toolsPrompt + "\n\n---\n" : "") + question;
    } else {
      // 只有一条真正消息，走单轮路径
      question = (sysPrompt ? "(Background)\n" + sysPrompt + "\n\n" : "") + toolsPrompt + "\n\n---\nUser message (respond to this):\n" + lastUserMsg;
    }
  } else {
    let context = sysPrompt;
    const overhead = toolsPrompt.length + lastUserMsg.length + 200;
    const remaining = MAX_QUESTION - overhead;
    if (context && context.length > remaining && remaining > 0) {
      // ⭐ 修复: 保留头部（核心规则）+ 尾部（最新文件列表），中间裁剪
      // 而非旧逻辑的"只保留前500字+目录"，那样会丢失大量重要指令
      const layoutMatch = context.match(/<project_layout>([\s\S]*?)<\/project_layout>/);
      const layoutSummary = layoutMatch ? layoutMatch[1].trim().split("\n").slice(0, 30).join("\n") : "";
      const headLen = Math.min(800, Math.floor(remaining * 0.6));
      const tailLen = Math.min(400, remaining - headLen);
      const head = context.slice(0, headLen);
      const tail = context.length > headLen + tailLen ? context.slice(-tailLen) : "";
      const layoutPart = layoutSummary ? "\n\nDirectory (summary):\n" + layoutSummary.slice(0, Math.min(300, remaining - headLen - tailLen - 50)) : "";
      context = tail ? head + "\n...[truncated]..." + layoutPart + "\n" + tail : head + layoutPart;
      context = context.slice(0, remaining);
    }
    question = (context ? "(Background)\n" + context + "\n\n" : "") + toolsPrompt + "\n\n---\nUser message (respond to this):\n" + lastUserMsg;
  }

  // ⭐ 注入语言提示 & 截断 (工具结果回传轮跳过 — 已自带语言指令且 < 10000)
  if (!toolResultPath) {
    question += langHint;

    if (question.length > MAX_QUESTION) {
      const minTemplate = "\n\n---\nUser message (respond to this):\n";
      const compact = toolsPrompt + minTemplate + lastUserMsg + langHint;
      if (compact.length > MAX_QUESTION) {
        const availForUser = Math.max(500, MAX_QUESTION - toolsPrompt.length - minTemplate.length - langHint.length);
        question = toolsPrompt + minTemplate + lastUserMsg.slice(0, Math.max(0, availForUser)) + langHint;
      } else {
        question = compact;
      }
    }
  }


  // 会话 — ⭐ 关键: 必须复用 IMA session 才能保持对话记忆
  const convId = req.headers["x-conversation-id"] || req.headers["x-session-id"] || "";
  // ⭐ 修复: 用系统 prompt + 第一条用户消息的 hash 作为稳定会话锚点
  // Claude Code 不发 x-conversation-id, 但同一对话的 system prompt 内容固定
  let effectiveConvId = convId;
  if (!effectiveConvId && messages.length > 0) {
    // 优先用 system prompt (Claude Code 在 system 里放项目路径等固定信息)
    const sysMsg = messages.find(m => m.role === "system");
    const anchor = sysMsg
      ? extractContent(sysMsg).slice(0, 200)           // system prompt 前200字，通常含项目路径
      : extractContent(messages[0]).slice(0, 200);      // fallback: 第一条消息
    effectiveConvId = "conv-" + crypto.createHash("md5").update(anchor).digest("hex").slice(0, 12);
  }
  if (!activeAccounts().length) {
    return json(res, 503, { type: "error", error: { type: "api_error", message: "没有可用账号：请在配置页添加至少一个 Cookie 账号" } });
  }
  const isNewSession = !getCachedSession(effectiveConvId, null);

  // --- 非流式 ---
  if (!stream) {
    try {
      const events = await imaQaStreamWithRetry(effectiveConvId, question, model.type, model.id);
      const text = await collectResponseText(events);
      const parsed = parseFunctionCalls(text);

      if (parsed.found && parsed.calls.length > 0) {
        const content = [];
        if (parsed.text) content.push({ type: "text", text: parsed.text });
        for (const c of parsed.calls) {
          content.push({
            type: "tool_use", id: c.id,
            name: c.function.name,
            input: JSON.parse(c.function.arguments || "{}"),
          });
        }
        return json(res, 200, {
          id: "msg_" + crypto.randomUUID().slice(0, 8),
          type: "message", role: "assistant", model: modelKey,
          content, stop_reason: "tool_use", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        });
      }

      return json(res, 200, {
        id: "msg_" + crypto.randomUUID().slice(0, 8),
        type: "message", role: "assistant", model: modelKey,
        // ⭐ 兜底: 空文本时给出占位, 避免客户端收到空 content
        content: [{ type: "text", text: text || "(本轮没有生成内容，请重试或换一种问法。)" }],
        stop_reason: "end_turn", stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      });
    } catch (e) {
      console.error(`[ANTHROPIC-NONSTREAM-ERR] ${e.message}`);
      return json(res, 502, { type: "error", error: { type: "api_error", message: "IMA error: " + e.message } });
    }
  }

  // --- 流式 ---
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const msgId = "msg_" + crypto.randomUUID().slice(0, 8);
  let resClosed = false;
  res.on('close', () => { resClosed = true; });

  const em = (e, d) => {
    if (resClosed) return;
    try {
      if (e) res.write(`event: ${e}\n`);
      res.write(`data: ${JSON.stringify(d)}\n\n`);
    } catch (_) { resClosed = true; }
  };

  em("message_start", {
    type: "message_start",
    message: { id: msgId, type: "message", role: "assistant", model: modelKey, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } },
  });
  em("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });

  let stopReason = "end_turn";
  let done = false;
  let sentText = false;   // ⭐ 是否已发送过任何文本 delta (兜底判断)
  const filter = new StreamFilter();
  let calls = [];  // 在 try 外声明，供后续 tool_use 发送使用
  try {
    const events = await imaQaStreamWithRetry(effectiveConvId, question, model.type, model.id);

    for await (const evt of events) {
      if (resClosed) break;
      if (CONTROL_EVENTS.has(evt.event)) {
        if (evt.event === "COMPLETED" || evt.event === "CLOSE") done = true;
        break;
      }
      const txt = eventText(evt);
      if (txt) {
        const clean = filter.feed(txt);
        if (clean) { em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: clean } }); sentText = true; }
      }
    }

    // 冲刷残留缓冲
    const flushed = filter.flush();
    if (flushed && !resClosed) { em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: flushed } }); sentText = true; }

    calls = filter.parseCalls();
    // ⭐ 无法解析的 function_call 残留 — 作为文本输出, 避免静默丢失
    if (filter.leftover && !resClosed) { em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: filter.leftover } }); sentText = true; }

    // ⭐ 兜底: 流结束但既无文本也无工具调用 — 绝不让客户端收到完全空的回复。
    // 这是 Claude Code "执行命令后无任何回复就结束" 的最终防线。
    if (!sentText && calls.length === 0 && !resClosed) {
      const fb = done
        ? "(本轮没有生成内容，请重试或换一种问法。)"
        : "(响应在完成前被中断，请重试。)";
      em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: fb } });
      sentText = true;
    }
  } catch (e) {
    console.error(`[ANTHROPIC-STREAM-ERR] ${e.message}`);
    // ⭐ 异常路径同样兜底, 保证至少有一段文本
    if (!sentText && !resClosed) {
      try { em("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "(响应处理出错，请重试。)" } }); sentText = true; } catch {}
    }
  }

  // 结束文本块 (仅在未截停时)
  if (!resClosed) em("content_block_stop", { type: "content_block_stop", index: 0 });

  // ⭐ 发送函数调用 — 使用上面已解析的 calls (避免重复解析)
  if (!resClosed && calls.length > 0) {
    stopReason = "tool_use";
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      const idx = i + 1;
      if (resClosed) break;
      em("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: c.id, name: c.function.name, input: {} } });
      em("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: c.function.arguments } });
      em("content_block_stop", { type: "content_block_stop", index: idx });
    }
  }

  if (!resClosed) {
    em("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 0 } });
    em("message_stop", { type: "message_stop" });
    try { res.end(); } catch {}
  }
}

// ============================================================
// 10. 路由
// ============================================================
async function router(req, res) {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = req.url;
  const urlPath = url.split("?")[0];

  if (urlPath === "/health") return json(res, 200, { status: "ok" });

  // ---- 本地管理 API（仅允许来自本机/内网访问，公网来源拒绝） ----
  if (urlPath === "/admin" || urlPath.startsWith("/admin/")) {
    if (!isLocalRequest(req)) {
      const ci = clientInfo(req);
      return json(res, 403, {
        error: "管理接口仅允许内网访问",
        peer: ci.peer || "(未知)",
        forwarded_for: ci.xff || "(无)",
        hint: "若你是从内网/App 访问却被拒，请把上面两行信息发给开发者",
      });
    }
    return await adminApi(req, res, urlPath);
  }

  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store, no-cache, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    return res.end(ADMIN_HTML);
  }

  if (urlPath === "/info") return json(res, 200, {
    service: "ima2api",
    version: "3.0.0",
    endpoints: {
      openai: ["POST /v1/chat/completions (tools / function calling)", "GET /v1/models"],
      anthropic: ["POST /v1/messages (tools / tool_use)"],
    },
    models: Object.keys(getModels()),
    auth: "Bearer <api_key> or x-api-key header",
  });

  if (!checkAuth(req)) {
    return json(res, 401, { error: { type: "authentication_error", message: "Invalid API key" } });
  }

  let body = {};
  if (req.method === "POST") {
    try {
      const raw = await new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", c => chunks.push(c));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
        req.on("error", reject);
      });
      body = raw ? JSON.parse(raw) : {};

      // body 已解析
    } catch (e) {
      return json(res, 400, { error: { type: "invalid_request_error", message: "Invalid JSON body" } });
    }
  }

  if (req.method === "GET" && urlPath === "/v1/models") {
    const modelList = Object.entries(getModels()).map(([id, info]) => ({
      id, object: "model", created: 1700000000, owned_by: "ima",
      type: "model", display_name: info.name,
      created_at: "2024-01-01T00:00:00Z",
    }));
    const ids = modelList.map(m => m.id);
    return json(res, 200, {
      object: "list",
      data: modelList,
      has_more: false,
      first_id: ids[0] || null,
      last_id: ids[ids.length - 1] || null,
    });
  }

  // Anthropic SDK: GET /v1/models/{model_id}
  if (req.method === "GET" && urlPath.startsWith("/v1/models/")) {
    const modelId = url.slice("/v1/models/".length);
    const model = resolveModel(modelId);
    if (!model) return json(res, 404, { error: { type: "error", error: { type: "not_found_error", message: `Model not found: ${modelId}` } } });
    return json(res, 200, {
      id: modelId,
      type: "model",
      display_name: model.name,
      created_at: "2024-01-01T00:00:00Z",
    });
  }

  if (req.method === "POST" && urlPath === "/v1/chat/completions") {
    try { return await openaiChat(req, res, body); }
    catch (e) {
      console.error(`[OPENAI-FATAL] ${e.message}\n${e.stack}`);
      if (!res.headersSent) return json(res, 500, { error: { type: "api_error", message: e.message } });
      else { try { res.end(); } catch {} }
    }
  }
  if (req.method === "POST" && urlPath === "/v1/messages") {
    try { return await anthropicMessages(req, res, body); }
    catch (e) {
      console.error(`[ANTHROPIC-FATAL] ${e.message}\n${e.stack}`);
      if (!res.headersSent) return json(res, 500, { error: { type: "api_error", message: e.message } });
      else { try { res.end(); } catch {} }
    }
  }

  json(res, 404, { error: { message: `Not found: ${req.method} ${url}` } });
}

// ============================================================
// 11. 管理 API（本机/内网）
// ============================================================
// 规范化对端地址：去掉 IPv4-mapped IPv6 前缀（::ffff:192.168.1.5）
function normalizeIp(s) {
  s = String(s || "").trim();
  if (!s) return "";
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (m) return m[1];
  const h = s.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (h) {
    const n = (((parseInt(h[1], 16) << 16) >>> 0) | parseInt(h[2], 16)) >>> 0;
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
  }
  return s;
}

function isLoopbackIp(ip) {
  return ip === "::1" || /^127\./.test(ip);
}

function isPrivateIp(ip) {
  if (!ip) return false;
  return /^10\./.test(ip)
    || /^192\.168\./.test(ip)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    || /^169\.254\./.test(ip)
    || /^fe80:/i.test(ip)
    || /^(fc|fd)[0-9a-f]{2}:/i.test(ip);
}

// 对端信息，用于 403 时把服务端实际看到的东西写进错误里（便于自查，不用翻日志）
function clientInfo(req) {
  const peer = normalizeIp((req.socket && (req.socket.remoteAddress || "")) || "");
  const xff = String(req.headers["x-forwarded-for"] || "").trim();
  return { peer, xff };
}

// 管理接口来源判定：只看 TCP 对端地址（socket），不信任 X-Forwarded-For。
// 原因：fnOS App 从外网打开本页时，请求由本机网关/中转到 8088，
// 此时 TCP 对端是 127.0.0.1（本机），而 XFF 里写的是手机的公网出口 IP。
// 若按 XFF 判定，用户自己会被拦掉；而真正的公网直连，TCP 对端本身就是公网地址，仍会被拒。
function isLocalRequest(req) {
  const peer = normalizeIp((req.socket && (req.socket.remoteAddress || "")) || "");
  if (!peer) return true; // 拿不到对端（unix socket 等）按本机处理
  return isLoopbackIp(peer) || isPrivateIp(peer);
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

// 实际监听端口（env 优先，其次 config）
function activePort() {
  return Number(process.env.IMA2API_PORT) || CONFIG.server?.port || 8081;
}

// 本机内网 IPv4（缓存）。手机等外部设备访问时不能给 127.0.0.1。
let _lanIpCache = null;
function lanIp() {
  if (_lanIpCache !== null) return _lanIpCache;
  _lanIpCache = "";
  try {
    const cands = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of (ifaces[name] || [])) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        if (/^169\.254\./.test(ni.address)) continue; // link-local，没用
        cands.push(ni.address);
      }
    }
    const pick =
      cands.find(a => /^192\.168\./.test(a)) ||
      cands.find(a => /^10\./.test(a)) ||
      cands.find(a => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
      cands[0];
    if (pick) _lanIpCache = pick;
  } catch { /* 拿不到就退回 127.0.0.1 */ }
  return _lanIpCache;
}

// 全部候选内网 IPv4（供页面提示用）
function lanIpAll() {
  const out = [];
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of (ifaces[name] || [])) {
        if (ni.family !== "IPv4" || ni.internal) continue;
        if (/^169\.254\./.test(ni.address)) continue;
        out.push(ni.address);
      }
    }
  } catch { /* ignore */ }
  return out;
}

// 调用地址：优先用户显式配置的 public_base，
// 否则用请求的 Host；Host 缺失或指向 loopback 时换成本机内网 IP。
function serverBase(req) {
  const override = (CONFIG.server?.public_base || "").trim().replace(/\/+$/, "");
  if (override) return override;
  const rawHost = ((req && req.headers && req.headers.host) || "").trim().split(":")[0];
  let host = rawHost;
  if (!host || /^(127\.|localhost$|::1$|0\.0\.0\.0$)/i.test(host)) {
    host = lanIp() || host || "127.0.0.1";
  }
  return `http://${host}:${activePort()}`;
}

async function adminApi(req, res, urlPath) {
  // GET /admin/state — 服务状态 + 账号列表（cookie 打码）+ 调用信息
  if (req.method === "GET" && urlPath === "/admin/state") {
    return json(res, 200, {
      ok: true,
      accounts: accountStats(),
      active_accounts: activeAccounts().length,
      api_keys: (CONFIG.api_keys || []).map(k => ({ masked: maskKey(k), value: k })),
      models: getModels(),
      default_model: getDefaultModel(),
      port: activePort(),
      base_url: serverBase(req),
      openai_base: serverBase(req) + "/v1",
      anthropic_base: serverBase(req) + "/v1",
      lan_ips: lanIpAll(),
      public_base: CONFIG.server?.public_base || "",
      config_file: CONFIG_FILE,
    });
  }

  const body = req.method === "POST" ? await readBody(req) : {};

  // POST /admin/server/base — 设置对外调用地址前缀（留空=自动检测）
  if (req.method === "POST" && urlPath === "/admin/server/base") {
    const v = (body.public_base || "").trim().replace(/\/+$/, "");
    if (v && !/^https?:\/\/[^\s/]+/i.test(v)) {
      return json(res, 400, { ok: false, error: "格式不对，示例：http://192.168.1.10:8088" });
    }
    CONFIG.server = CONFIG.server || {};
    if (v) CONFIG.server.public_base = v; else delete CONFIG.server.public_base;
    saveConfig();
    return json(res, 200, {
      ok: true,
      base_url: serverBase(req),
      openai_base: serverBase(req) + "/v1",
      anthropic_base: serverBase(req) + "/v1",
    });
  }

  // POST /admin/account/add — 新增账号
  if (req.method === "POST" && urlPath === "/admin/account/add") {
    const cookie = (body.cookie || "").trim();
    if (!cookie) return json(res, 400, { ok: false, error: "Cookie 不能为空" });
    if (!/IMA-TOKEN=/.test(cookie)) {
      return json(res, 400, { ok: false, error: "Cookie 里没有找到 IMA-TOKEN，请确认复制的是完整 x-ima-cookie" });
    }
    // refresh_token：优先用显式传入，否则尝试从 cookie 的 IMA-REFRESH-TOKEN 提取
    let refresh = (body.refresh_token || "").trim();
    if (!refresh) refresh = cookieField(cookie, "IMA-REFRESH-TOKEN");
    const account = {
      id: crypto.randomUUID(),
      name: (body.name || "").trim() || `账号 ${ (CONFIG.accounts || []).length + 1 }`,
      cookie,
      refresh_token: refresh,
      enabled: true,
      created_at: new Date().toISOString(),
    };
    CONFIG.accounts = CONFIG.accounts || [];
    CONFIG.accounts.push(account);
    saveConfig();
    return json(res, 200, { ok: true, id: account.id, name: account.name });
  }

  // POST /admin/account/update — 改名 / 启停 / 更新 cookie
  if (req.method === "POST" && urlPath === "/admin/account/update") {
    const a = (CONFIG.accounts || []).find(x => x.id === body.id);
    if (!a) return json(res, 404, { ok: false, error: "账号不存在" });
    if (typeof body.name === "string") a.name = body.name.trim() || a.name;
    if (typeof body.enabled === "boolean") a.enabled = body.enabled;
    if (typeof body.cookie === "string" && body.cookie.trim()) {
      if (!/IMA-TOKEN=/.test(body.cookie)) return json(res, 400, { ok: false, error: "Cookie 无效" });
      a.cookie = body.cookie.trim();
      a.refresh_token = body.refresh_token ? body.refresh_token.trim() : cookieField(a.cookie, "IMA-REFRESH-TOKEN");
      a.last_error = null;
    }
    saveConfig();
    return json(res, 200, { ok: true });
  }

  // POST /admin/account/delete — 删除账号
  if (req.method === "POST" && urlPath === "/admin/account/delete") {
    const before = (CONFIG.accounts || []).length;
    CONFIG.accounts = (CONFIG.accounts || []).filter(x => x.id !== body.id);
    if (CONFIG.accounts.length === before) return json(res, 404, { ok: false, error: "账号不存在" });
    saveConfig();
    return json(res, 200, { ok: true });
  }

  // POST /admin/account/test — 测试某个账号是否可用
  if (req.method === "POST" && urlPath === "/admin/account/test") {
    const a = (CONFIG.accounts || []).find(x => x.id === body.id);
    if (!a) return json(res, 404, { ok: false, error: "账号不存在" });
    try {
      const sid = await imaInitSession("连通性测试", a);
      markChecked(a, true);
      saveConfig();
      return json(res, 200, { ok: true, session_id: sid ? "ok" : "" });
    } catch (e) {
      markChecked(a, false, e);
      saveConfig();
      return json(res, 200, { ok: false, error: e.message });
    }
  }

  // POST /admin/account/test-all — 检测全部账号（并发探测）
  if (req.method === "POST" && urlPath === "/admin/account/test-all") {
    const targets = (CONFIG.accounts || []).filter(a => a.enabled !== false && a.cookie);
    const results = await Promise.all(targets.map(async (a) => {
      try {
        await imaInitSession("连通性测试", a);
        markChecked(a, true);
        return { id: a.id, name: a.name, ok: true };
      } catch (e) {
        markChecked(a, false, e);
        return { id: a.id, name: a.name, ok: false, error: e.message };
      }
    }));
    saveConfig();
    const okN = results.filter(r => r.ok).length;
    return json(res, 200, {
      ok: true,
      total: results.length,
      available: okN,
      failed: results.length - okN,
      results,
      accounts: accountStats(),
    });
  }

  // POST /admin/account/refresh — 立即用 refresh_token 刷新该账号
  if (req.method === "POST" && urlPath === "/admin/account/refresh") {
    const a = (CONFIG.accounts || []).find(x => x.id === body.id);
    if (!a) return json(res, 404, { ok: false, error: "账号不存在" });
    if (!a.refresh_token) return json(res, 400, { ok: false, error: "该账号没有 refresh_token，无法自动刷新（只能重新粘贴 Cookie）" });
    const r = await refreshAccount(a);
    saveConfig();
    return json(res, 200, r);
  }

  // POST /admin/keys/add — 生成新 Key 并替换（只保留这一个，旧 Key 立即失效）
  if (req.method === "POST" && urlPath === "/admin/keys/add") {
    const k = (body.key || "").trim() || genApiKey();
    CONFIG.api_keys = [k];
    saveConfig();
    return json(res, 200, { ok: true, key: k });
  }

  // POST /admin/keys/delete — 删除调用 Key（删空则自动补一个新的，避免服务无 Key 可用）
  if (req.method === "POST" && urlPath === "/admin/keys/delete") {
    CONFIG.api_keys = (CONFIG.api_keys || []).filter(k => k !== body.key);
    if (!CONFIG.api_keys.length) CONFIG.api_keys.push(genApiKey());
    saveConfig();
    return json(res, 200, { ok: true, api_keys: CONFIG.api_keys });
  }

  // POST /admin/config — 改默认模型 / 端口等
  if (req.method === "POST" && urlPath === "/admin/config") {
    if (body.default_model) CONFIG.default_model = body.default_model;
    saveConfig();
    return json(res, 200, { ok: true, default_model: CONFIG.default_model });
  }

  return json(res, 404, { ok: false, error: "unknown admin endpoint" });
}

// ============================================================
// 12. 账号自动刷新（用 refresh_token）
// ============================================================
function calcBknAlt(t) {
  let h = 5381;
  for (let i = 0; i < t.length; i++) h = h + (h << 5) + t.charCodeAt(i);
  return h & 0x7fffffff;
}

function httpPostJson(hostname, path, headers, bodyObj, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(bodyObj);
    const req = https.request({
      hostname, port: 443, path, method: "POST",
      headers: { ...headers, "Content-Length": Buffer.byteLength(payload) },
      timeout,
    }, (res) => {
      const zlib = require("zlib");
      let stream = res;
      const enc = res.headers["content-encoding"] || "";
      if (enc === "gzip") stream = res.pipe(zlib.createGunzip());
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf-8");
        try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, data: raw }); }
      });
      stream.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
    req.write(payload); req.end();
  });
}

// 调 ima.qq.com/auth_login/refresh 换新 token（实测服务端不校验 registration_id）
async function refreshAccount(a) {
  if (!a.refresh_token) return { ok: false, error: "缺少 refresh_token" };
  const uid = cookieField(a.cookie, "IMA-UID");
  const token = cookieField(a.cookie, "IMA-TOKEN");
  const bkn = String(calcBknAlt(token));
  try {
    const { data } = await httpPostJson(
      "ima.qq.com",
      "/auth_login/refresh",
      {
        "from_browser_ima": "1",
        "x-ima-cookie": a.cookie,
        "x-ima-bkn": bkn,
        referer: BASE_URL,
        origin: BASE_URL,
        "User-Agent": "okhttp/4.12.0",
        "Content-Type": "application/json; charset=utf-8",
        "Accept-Encoding": "gzip",
      },
      { refresh_token: a.refresh_token, user_id: uid, registration_id: a.registration_id || "" }
    );
    if (data && data.code === 0 && data.token) {
      a.cookie = replaceCookieToken(a.cookie, data.token);
      a.last_refresh = new Date().toISOString();
      a.token_valid_time = Number(data.token_valid_time) || 7200;
      a.last_error = null;
      saveConfig();
      return { ok: true, token_valid_time: data.token_valid_time || null };
    }
    const msg = (data && (data.msg || data.message)) ? `${data.code}: ${data.msg || data.message}` : JSON.stringify(data).slice(0, 200);
    a.last_error = `refresh failed: ${msg}`;
    saveConfig();
    return { ok: false, error: a.last_error };
  } catch (e) {
    a.last_error = `refresh error: ${e.message}`;
    saveConfig();
    return { ok: false, error: a.last_error };
  }
}

function replaceCookieToken(cookie, newToken) {
  if (/IMA-TOKEN=/.test(cookie)) return cookie.replace(/IMA-TOKEN=[^;]*/, `IMA-TOKEN=${newToken}`);
  return cookie + `; IMA-TOKEN=${newToken}`;
}

// 后台自动刷新循环：每 2 分钟检查，提前刷新快过期的
function startRefresher() {
  const INTERVAL = 2 * 60 * 1000;
  setInterval(async () => {
    for (const a of (CONFIG.accounts || [])) {
      if (a.enabled === false || !a.refresh_token || !a.cookie) continue;
      // 若上次刷新在 100 分钟内，则跳过（token 有效期约 2h）
      if (a.last_refresh && (Date.now() - new Date(a.last_refresh).getTime()) < 100 * 60 * 1000) continue;
      // 尝试刷新
      const r = await refreshAccount(a);
      if (r.ok) console.log(`[REFRESH] ${a.name} ok (valid ${r.token_valid_time || "?"}s)`);
      else console.error(`[REFRESH] ${a.name} failed: ${r.error}`);
    }
  }, INTERVAL).unref();
}

// ============================================================
// 13. 启动
// ============================================================
const PORT = Number(process.env.IMA2API_PORT) || CONFIG.server?.port || 8081;
const HOST = CONFIG.server?.host || "0.0.0.0";

const server = http.createServer(router);
server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    console.error(`启动失败：端口 ${PORT} 已被占用。请改用其他端口（环境变量 IMA2API_PORT 或 config.json 的 server.port）。`);
  } else {
    console.error(`启动失败：${e.message}`);
  }
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  console.log(`ima2api 已启动: http://${HOST}:${PORT}`);
  console.log(`配置页: http://<NAS_IP>:${PORT}/   | 配置文件: ${CONFIG_FILE}`);
  console.log(`账号数: ${(CONFIG.accounts || []).length}（可用 ${activeAccounts().length}）`);
  if (!activeAccounts().length) {
    console.log(`没有可用账号，请打开 http://<NAS_IP>:${PORT}/ 添加 Cookie`);
  }
  startRefresher();
});
