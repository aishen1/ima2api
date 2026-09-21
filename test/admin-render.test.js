#!/usr/bin/env node
/**
 * 用 jsdom 真实渲染 admin.html 的账号列表，确认：
 *   - 只剩「账号名 + 有效性徽标」
 *   - 不再出现 Cookie / 时间 / 次数 / 剩余有效期
 *   - 页面里没有「高级：当前调用的 Key」
 *
 * 关键：fetch 必须在 beforeParse 里注入 —— 页面脚本一解析完就会立刻调 load()，
 * 事后覆盖 window.fetch 已经来不及（会渲染出空列表，让"不显示"类断言假通过）。
 */
const fs = require('fs');
const path = require('path');

// jsdom 是可选依赖（仅渲染测试需要）。缺失时优雅跳过，
// 这样 CI 里跑 `node test/*.js` 不会因为环境差异整体失败。
let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.log('\n=== 跳过：未安装 jsdom ===');
  console.log('  安装后本测试会真实渲染账号列表：');
  console.log('    npm install jsdom --no-save\n');
  process.exit(0);
}

const ROOT = path.resolve(__dirname, '..');
let html = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
html = html.replace(/<link[^>]*>/g, '').replace(/<script src[^>]*><\/script>/g, '');

const STATE = {
  accounts: [
    {
      id: 'acc-ok', name: '主号', state: 'ok', enabled: true,
      has_refresh_token: true, cookie_masked: 'IMA-UID=SECRETMASK123',
      ok_count: 42, fail_count: 1,
      last_ok: '2025-09-21T10:00:00Z', last_refresh: '2025-09-21T09:00:00Z',
      last_check: '2025-09-21T10:01:00Z', remain_seconds: 3600,
      expire_at: '2025-09-21T11:00:00Z',
    },
    {
      id: 'acc-bad', name: '小号', state: 'invalid', enabled: true,
      has_refresh_token: false, cookie_masked: 'IMA-UID=SECRETMASK999',
      ok_count: 0, fail_count: 7, last_error: 'TOKEN_EXPIRED_DETAIL',
      last_error_kind: 'auth', remain_seconds: 0,
    },
  ],
  api_keys: [{ value: 'sk-ima-testkey' }],
  active_accounts: 1,
  models: { 'hy4-preview': {}, 'glm-5.3': {} },
  default_model: 'hy4-preview',
  port: 8088,
  lan_ips: ['192.168.9.102'],
  base_url: 'http://192.168.9.102:8088',
  public_base: '',
};

let errored = [];
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  beforeParse(w) {
    w.addEventListener('error', e => errored.push(e.message));
    w.fetch = async (url) => {
      const u = String(url);
      const body = u.includes('/admin/state') ? STATE : { ok: true };
      return { ok: true, status: 200, json: async () => body };
    };
    w.alert = () => {};
    w.confirm = () => true;
    w.prompt = () => null;
  },
});

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };

setTimeout(() => {
  const doc = dom.window.document;
  const list = doc.getElementById('acctList');
  const htmlOfList = list ? list.innerHTML : '';
  const txt = list ? list.textContent.replace(/\s+/g, ' ').trim() : '';

  console.log('\n=== 渲染出的账号区文本 ===');
  console.log('  ' + txt);
  console.log();

  // 前置护栏：列表必须真的渲染出内容，否则后面的"不显示"断言全是假通过
  console.log('=== 0. 前置护栏（防空列表假通过）===');
  ok(htmlOfList.length > 0, `账号列表已渲染（innerHTML ${htmlOfList.length} 字符）`);
  ok(/主号/.test(htmlOfList) && /小号/.test(htmlOfList), '两个账号都已渲染');
  ok(errored.length === 0, `页面无 JS 错误${errored.length ? '：' + errored.join('; ') : ''}`);

  console.log('\n=== 1. 只保留账号名 + 有效性 ===');
  ok(/主号/.test(txt), '显示账号名「主号」');
  ok(/小号/.test(txt), '显示账号名「小号」');
  ok(/有效/.test(txt), '显示「有效」徽标');
  ok(/已失效/.test(txt), '显示「已失效」徽标');

  console.log('\n=== 2. 高级信息已隐藏 ===');
  // 注意：按钮「更新 Cookie」里的 Cookie 字样是必要的操作入口，不算泄露
  ok(!/Cookie[：:]\s*\S/.test(txt), '不显示 Cookie 的具体内容行');
  ok(!/SECRETMASK/.test(txt), '不泄露脱敏 Cookie 内容');
  ok(!/成功\s*\d+\s*次/.test(txt), '不显示成功次数');
  ok(!/失败\s*\d+\s*次/.test(txt), '不显示失败次数');
  ok(!/剩余\s*\d+h/.test(txt), '不显示剩余有效期');
  ok(!/\d{4}-\d{2}-\d{2}/.test(txt), '不显示任何日期时间');
  ok(!/最近/.test(txt), '不显示「最近成功/续期/检测」');
  ok(!/预计失效/.test(txt), '不显示「预计失效」');
  ok(!/TOKEN_EXPIRED_DETAIL/.test(txt), '不显示最近错误详情');
  ok(!/可自动续期|无续期票据/.test(txt), '不显示续期票据徽标');
  // 源代码层面再确认一次（防 CSS 隐藏式的"假隐藏"）
  ok(!/cookie_masked/.test(html), '源码不再引用 cookie_masked');
  ok(!/ok_count|fail_count/.test(html), '源码不再引用 ok_count / fail_count');
  ok(!/remain_seconds/.test(html), '源码不再引用 remain_seconds');

  console.log('\n=== 3. 管理按钮仍在（功能没被砍掉）===');
  for (const b of ['测试', '停用', '改名', '更新 Cookie', '删除']) {
    ok(htmlOfList.includes(b), `保留「${b}」按钮`);
  }
  ok(!htmlOfList.includes('立即续期'), '已去掉「立即续期」按钮');

  console.log('\n=== 4. 页面级移除项 ===');
  const pageTxt = doc.body.textContent;
  ok(!/当前调用的 Key/.test(pageTxt), '页面无「高级：当前调用的 Key」');
  ok(!doc.getElementById('keyList'), '#keyList 已不存在');
  ok(!/#qrFrame|onQrMessage/.test(html), 'iframe + postMessage 方案已移除');
  ok(/id="qrImg"/.test(html), '二维码改用 <img id="qrImg"> 显示');
  ok(/\/admin\/qr\/create/.test(html), '前端走服务端 /admin/qr/create 取码');
  // 调用地址与 Key 仍要显示（用户明确要保留的部分）
  ok(/192\.168\.9\.102:8088\/v1/.test(pageTxt), '调用地址仍完整显示（含端口）');
  ok(/sk-ima-testkey/.test(pageTxt), 'API Key 仍在页面上显示');

  console.log('\n' + '='.repeat(44));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(44) + '\n');
  process.exit(fail ? 1 : 0);
}, 1500);
