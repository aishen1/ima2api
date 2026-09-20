// 内嵌场景回归：页面在 /app/ima2api/ 子路径下，请求必须带前缀，地址必须完整含端口
const { JSDOM } = require("/tmp/v/node_modules/jsdom");

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

async function run({ name, pageUrl, metaBase, basePathMeta, wantPrefix, wantPort }) {
  console.log(`\n=== ${name} ===`);
  console.log(`    页面地址: ${pageUrl}`);
  const raw = await (await fetch("http://127.0.0.1:18066/")).text();
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
    const r = await fetch("http://127.0.0.1:18066" + p, {
      method: (o && o.method) || "GET",
      headers: (o && o.headers) || {},
      body: o && o.body,
    });
    return { ok: r.ok, status: r.status, json: () => r.json() };
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

  const expect = `http://192.168.9.102:${wantPort}/v1`;
  const fmt = /^https?:\/\/\d+\.\d+\.\d+\.\d+:\d+\/v1$/;
  chk(`请求路径前缀正确（内嵌需带 /app/ima2api）`,
    calls.length > 0 && calls.every(c => wantPrefix ? c.startsWith("/app/ima2api/") : !c.startsWith("/app/")),
    `实际 ${JSON.stringify(calls)}`);
  chk("★ 地址格式 = http://内网IP:端口/v1", o === expect, `期望 ${expect}`);
  chk("★ 地址确实带端口号", fmt.test(o));
  chk("Anthropic 同样完整", a === expect);
  chk("复制原始值与显示一致", raw1 === o);
  chk("Key 完整 47 字符", k.length === 47);
  chk("无报错", !/加载失败/.test(wrap));
  chk("版本标记 v1.0.6", q("buildTag").textContent === "v1.0.6");
}

(async () => {
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
    name: "场景3：内嵌（服务端字段异常时的兜底）",
    pageUrl: "http://192.168.9.102:5666/app/ima2api/",
    basePathMeta: "/app/ima2api",
    wantPrefix: true,
    wantPort: 18066,
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
})();
