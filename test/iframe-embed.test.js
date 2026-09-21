// 内嵌场景回归：页面在 /app/ima2api/ 子路径下，请求必须带前缀，地址必须完整含端口
//
// 依赖：本机 127.0.0.1:18066 上跑着一个 ima2api 实例（测试脚本会自己拉起）。
// jsdom 可选：缺失时跳过。
let JSDOM;
try {
  ({ JSDOM } = require("jsdom"));
} catch {
  console.log("跳过 iframe-embed：未安装 jsdom（npm install jsdom --no-save）");
  process.exit(0);
}

const PORT = 18066;
const BASE = `http://127.0.0.1:${PORT}`;

const STATE = {
  ok: true,
  accounts: [{ id: "a1", name: "nuli", state: "ok", enabled: true }],
  active_accounts: 1,
  api_keys: [{ masked: "sk-ima...c7ba", value: "sk-ima-ea55ad3e7ad35b7248a2dd86be505fb0ef54c7ba" }],
  models: { "glm-5.2-think": { name: "glm-5.2-think" } },
  default_model: "glm-5.2-think",
  port: 8088,
  base_url: "http://192.168.9.102:8088",
  openai_base: "http://192.168.9.102:8088/v1",
  anthropic_base: "http://192.168.9.102:8088/v1",
  lan_ips: ["192.168.9.102"],
  public_base: "",
  config_file: "/x/config.json",
};

let pass = 0, fail = 0;
const chk = (n, c, ex = "") => { c ? pass++ : fail++; console.log(`  ${c ? "✓" : "✗"} ${n}${ex ? "  " + ex : ""}`); };

async function run({ name, pageUrl, basePathMeta, wantPrefix, wantPort, statePatch }) {
  console.log(`\n=== ${name} ===`);
  console.log(`    页面地址: ${pageUrl}`);
  const raw = await (await fetch(`${BASE}/`)).text();
  // 服务端注入 meta；内嵌场景下手动指定 basepath 以模拟网关
  let html = raw.replace(
    /<meta name="ima2api-basepath"[^>]*>/,
    `<meta name="ima2api-basepath" content="${basePathMeta}">`
  );
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  const calls = [];
  w.fetch = async (p, o) => {
    calls.push(p);
    // 真实转发：把请求原样送到服务（含前缀，验证剥离逻辑）
    const r = await fetch(BASE + p, {
      method: (o && o.method) || "GET",
      headers: (o && o.headers) || {},
      body: o && o.body,
    });
    const body = await r.json();
    // statePatch 用于模拟"服务端字段是坏的"，验证前端兜底链
    if (statePatch && String(p).includes("/admin/state")) Object.assign(body, statePatch);
    return { ok: r.ok, status: r.status, json: async () => body };
  };
  w.eval(html.match(/<script>([\s\S]*)<\/script>/)[1]);
  await new Promise(r => setTimeout(r, 1500));

  const q = id => w.document.getElementById(id);
  const o = q("openaiBase").textContent, a = q("anthropicBase").textContent, k = q("apiKey").textContent;
  const raw1 = q("openaiBase").dataset.raw;
  const wrap = w.document.querySelector(".wrap").textContent;
  console.log(`    请求路径   : ${JSON.stringify(calls)}`);
  console.log(`    OpenAI     : ${o}`);
  console.log(`    构建标记   : ${q("buildTag").textContent}`);

  const expect = wantPort ? `http://192.168.9.102:${wantPort}/v1` : null;
  const fmt = /^https?:\/\/\d+\.\d+\.\d+\.\d+:\d+\/v1$/;
  chk(`请求路径前缀正确（内嵌需带 /app/ima2api）`,
    calls.length > 0 && calls.every(c => wantPrefix ? c.startsWith("/app/ima2api/") : !c.startsWith("/app/")),
    `实际 ${JSON.stringify(calls)}`);
  chk("★ 地址确实带端口号", fmt.test(o), `实际 ${o}`);
  if (expect) {
    chk("★ 地址格式 = http://内网IP:端口/v1", o === expect, `期望 ${expect}`);
    chk("Anthropic 同样完整", a === expect);
  } else {
    // 服务端字段坏掉时只能退到浏览器地址；至少要保证是「协议+主机+端口+/v1」的完整形态
    chk("★ 兜底仍是完整可用形态（含端口）", fmt.test(o), `实际 ${o}`);
    chk("Anthropic 同样完整", a === o && fmt.test(a));
  }
  chk("复制原始值与显示一致", raw1 === o);
  chk("Key 完整 47 字符", k.length === 47, `实际 ${k.length}`);
  chk("无报错", !/加载失败/.test(wrap));
  chk("版本标记 v1.0.9", q("buildTag").textContent === "v1.0.9");
}

(async () => {
  // 自拉一个测试实例，避免依赖外部已启动的服务
  const { spawn } = require("child_process");
  const fs = require("fs");
  const os = require("os");
  const path = require("path");

  const ROOT = path.resolve(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ima2api-iframe-"));
  for (const f of ["server.js", "admin.html", "package.json"]) {
    fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  }
  // 复用仓库的 node_modules（express 等）
  fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(tmp, "node_modules"));
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({
    server: { port: PORT },
    // 用真实格式的 Key（sk-ima- + 40 位 hex = 47 字符），否则"Key 完整"断言测不到真东西
    api_keys: ["sk-ima-" + "0".repeat(40)],
    accounts: [],
  }, null, 2));

  const child = spawn(process.execPath, ["server.js"], {
    cwd: tmp,
    stdio: ["ignore", "pipe", "pipe"],
    // BASE_PATH 让服务剥离 /app/ima2api 前缀 —— 这正是飞牛网关内嵌时的行为。
    // 不设它的话带前缀的请求会被当成未知路径拒绝（401），场景1/3 测不出来。
    env: { ...process.env, IMA2API_BASE_PATH: "/app/ima2api" },
  });
  let log = "";
  child.stdout.on("data", d => { log += d; });
  child.stderr.on("data", d => { log += d; });

  const cleanup = () => { try { child.kill("SIGKILL"); } catch {} 
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} };
  process.on("exit", cleanup);

  // 等服务就绪
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) { ready = true; break; }
    } catch { /* 还没起来 */ }
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) {
    console.log("✗ 测试服务未能在 " + PORT + " 端口就绪");
    console.log(log.slice(-800));
    cleanup();
    process.exit(1);
  }

  // 场景1：飞牛 App 内嵌（页面在 /app/ima2api/ 下，host 是网关端口 5666）
  await run({
    name: "场景1：飞牛 App 内嵌（iframe，host=网关 5666）",
    pageUrl: "http://192.168.9.102:5666/app/ima2api/",
    basePathMeta: "/app/ima2api",
    wantPrefix: true,
    wantPort: 18066,
  });

  // 场景2：直接开端口访问（老方式，无前缀）
  await run({
    name: "场景2：直接访问端口（无前缀）",
    pageUrl: "http://192.168.9.102:18066/",
    basePathMeta: "",
    wantPrefix: false,
    wantPort: 18066,
  });

  // 场景3：内嵌且服务端地址字段是坏的（只有 /v1）——仍须给出完整可用地址
  await run({
    name: "场景3：内嵌（服务端地址字段异常时的兜底）",
    pageUrl: "http://192.168.9.102:5666/app/ima2api/",
    basePathMeta: "/app/ima2api",
    wantPrefix: true,
    // 故意不设 wantPort：服务端字段坏掉后应退到浏览器地址，不再断言服务端端口
    statePatch: { base_url: "/v1", openai_base: "/v1", anthropic_base: "/v1" },
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  cleanup();
  process.exit(fail ? 1 : 0);
})();
