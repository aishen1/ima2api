// 前端回归：状态接口正常 / 失败两种情况下，地址与诊断显示
const { JSDOM } = require("/tmp/v/node_modules/jsdom");
const fs = require("fs");

const HTML = fs.readFileSync("/vol2/@apphome/hermes-studio/hermes-home/workspace/ima2api-repo/admin.html", "utf-8")
  .replace("</head>", '<meta name="ima2api-build" content="1.0.5"></head>');

const STATE_OK = {
  ok: true,
  accounts: [],
  active_accounts: 0,
  api_keys: [{ masked: "sk-ima...c7ba", value: "sk-ima-ea55ad3e7ad35b7248a2dd86be505fb0ef54c7ba" }],
  models: { "glm-5.2-think": {}, "hy3-preview": {} },
  default_model: "glm-5.2-think",
  port: 8088,
  base_url: "http://192.168.9.102:8088",
  openai_base: "http://192.168.9.102:8088/v1",
  anthropic_base: "http://192.168.9.102:8088/v1",
  lan_ips: ["192.168.9.102"],
  public_base: "",
  config_file: "/x/config.json",
};

const FAIL_403 = {
  status: 403,
  body: { error: "管理接口仅允许内网访问", peer: "192.168.9.103", forwarded_for: "111.163.88.123" },
};

async function render({ url, resp }) {
  const dom = new JSDOM(HTML, { url, runScripts: "outside-only", pretendToBeVisual: true });
  const w = dom.window;
  w.fetch = async (p) => {
    if (resp.status === 200) return { ok: true, status: 200, json: async () => STATE_OK, headers: { get: () => null } };
    return { ok: false, status: resp.status, json: async () => FAIL_403.body, headers: { get: () => null } };
  };
  // 捕获未处理异常，避免 jsdom 静默
  w.eval(HTML.match(/<script>([\s\S]*)<\/script>/)[1]);
  await new Promise(r => setTimeout(r, 400));
  const q = id => w.document.getElementById(id);
  const wrap = w.document.querySelector(".wrap").textContent;
  return {
    openai: q("openaiBase") ? q("openaiBase").textContent : null,
    openaiRaw: q("openaiBase") ? q("openaiBase").dataset.raw : null,
    anthropic: q("anthropicBase") ? q("anthropicBase").textContent : null,
    apiKey: q("apiKey") ? q("apiKey").textContent : null,
    build: q("buildTag") ? q("buildTag").textContent : null,
    hasError: /加载失败/.test(wrap),
    wrap,
  };
}

let pass = 0, fail = 0;
const chk = (name, cond, extra = "") => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
};

(async () => {
  console.log("=== 场景1：状态接口正常（手机用内网地址打开）===");
  let r = await render({ url: "http://192.168.9.102:8088/", resp: { status: 200 } });
  console.log(`    OpenAI 地址: ${JSON.stringify(r.openai)}`);
  console.log(`    API Key   : ${r.apiKey ? r.apiKey.length + " 字符" : "(空)"}`);
  console.log(`    构建标记   : ${r.build}`);
  chk("地址含协议+IP+端口+/v1", r.openai === "http://192.168.9.102:8088/v1");
  chk("Anthropic 同样完整", r.anthropic === "http://192.168.9.102:8088/v1");
  chk("Key 完整 47 字符", r.apiKey && r.apiKey.length === 47);
  chk("复制用原始值完整", r.openaiRaw === "http://192.168.9.102:8088/v1");
  chk("构建标记显示 v1.0.5", r.build === "v1.0.5");
  chk("无错误框", !r.hasError);

  console.log("\n=== 场景2：状态接口 403（你遇到的这一屏）===");
  r = await render({ url: "http://192.168.9.102:8088/", resp: { status: 403 } });
  console.log(`    OpenAI 地址: ${JSON.stringify(r.openai)}`);
  console.log(`    错误框内容 : ${r.hasError ? r.wrap.split("加载失败").slice(1).join("").split("账号与")[0].trim() : "(无)"}`);
  chk("★ 状态失败时地址仍完整可用", r.openai === "http://192.168.9.102:8088/v1");
  chk("★ Anthropic 同样可用", r.anthropic === "http://192.168.9.102:8088/v1");
  chk("★ 错误信息含来源诊断", r.wrap.includes("192.168.9.103") && r.wrap.includes("111.163.88.123"));

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
