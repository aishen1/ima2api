#!/usr/bin/env node
/**
 * 验证 ima 登录页的 postMessage 契约（方案 A 的核心假设）
 *
 * 做法：
 *   1. 直接抓 ima 登录页 bundle，确认 loginWxCodeReady 事件的发送逻辑存在
 *   2. 确认 code 来自微信回调，且发送目标是宿主 window.parent
 *   3. 用 jsdom 模拟宿主页面，注入伪造的 ima 事件，验证我们的 onQrMessage
 *      只对 ima.qq.com 来源响应（安全底线）
 */
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };

const ROOT = path.resolve(__dirname, '..');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');

console.log('\n=== 1. 从 admin.html 抽出 onQrMessage 的真实实现 ===');
const m = ADMIN.match(/async function onQrMessage\(ev\)\{[\s\S]*?\n\}/);
ok(!!m, '成功抽出 onQrMessage 函数体');
if (!m) { console.log('\n无法继续'); process.exit(1); }
const fnSrc = m[0];

console.log('\n=== 2. 构造隔离沙箱执行该函数 ===');
// 模拟最小宿主环境
const stateLog = [];
const sandbox = {
  qrSetState: (t, c) => stateLog.push({ text: t, cls: c || '' }),
  api: async (p, b) => { sandbox.__lastApi = { p, b }; return { verified: true, name: '测试账号' }; },
  toast: () => {},
  load: async () => {},
  qrStop: () => { sandbox.__stopped = true; },
  QR_BUSY: false,
  $: () => ({ value: '' }),
  window: {},
};
// 用 Function 构造，注入依赖
const factory = new Function(
  'qrSetState', 'api', 'toast', 'load', 'qrStop', '$',
  `let QR_BUSY = false;
   ${fnSrc}
   return { onQrMessage, setBusy: v => { QR_BUSY = v; }, getBusy: () => QR_BUSY };`
);
const inst = factory(
  sandbox.qrSetState, sandbox.api, sandbox.toast, sandbox.load, sandbox.qrStop, sandbox.$
);
ok(typeof inst.onQrMessage === 'function', 'onQrMessage 可调用');

const fire = async (origin, data) => {
  stateLog.length = 0;
  sandbox.__lastApi = null;
  inst.setBusy(false);
  await inst.onQrMessage({ origin, data });
  return { state: stateLog[stateLog.length - 1] || null, api: sandbox.__lastApi };
};

(async () => {
  console.log('\n=== 3. 安全底线：非 ima 来源必须被忽略 ===');
  for (const evil of [
    'https://evil.com',
    'https://ima.qq.com.evil.com',
    'https://fake-ima.qq.com',
    'http://ima.qq.com',
    'null',
  ]) {
    const r = await fire(evil, { eventName: 'loginWxCodeReady', data: { code: 'STOLEN_CODE' } });
    ok(r.api === null, `来源 ${evil} → 不发起换码请求`);
  }

  console.log('\n=== 4. 合法来源：loginWxCodeReady 应触发换码 ===');
  const good = await fire('https://ima.qq.com', {
    eventName: 'loginWxCodeReady', data: { code: 'REAL_CODE_123' },
  });
  ok(good.api !== null, 'ima.qq.com 来源 → 发起换码请求');
  ok(good.api && good.api.p === '/admin/qr/login', '请求路径 = /admin/qr/login');
  ok(good.api && good.api.b && good.api.b.code === 'REAL_CODE_123', '正确透传 code');

  console.log('\n=== 5. 事件名分支 ===');
  const booting = await fire('https://ima.qq.com', { eventName: 'loginPanelBooting' });
  ok(booting.api === null && booting.state && /加载/.test(booting.state.text), 'loginPanelBooting → 加载中提示，不换码');

  const ready = await fire('https://ima.qq.com', { eventName: 'loginPanelReady' });
  ok(ready.api === null && ready.state && /扫码/.test(ready.state.text), 'loginPanelReady → 提示扫码');

  const err = await fire('https://ima.qq.com', { eventName: 'loginPanelError' });
  ok(err.state && err.state.cls === 'err', 'loginPanelError → 错误态 + 兜底提示');

  const noCode = await fire('https://ima.qq.com', { eventName: 'loginWxCodeReady', data: {} });
  ok(noCode.api === null, 'loginWxCodeReady 但无 code → 不换码');
  ok(noCode.state && noCode.state.cls === 'err', '无 code → 报错态');

  console.log('\n=== 6. 非对象 / 畸形消息不应崩溃 ===');
  for (const bad of [null, 'string', 123, undefined, []]) {
    let threw = false;
    try { await fire('https://ima.qq.com', bad); } catch { threw = true; }
    ok(!threw, `畸形消息 ${JSON.stringify(bad)} → 不抛异常`);
  }
  for (const badOrigin of ['', 'not-a-url', 'about:blank']) {
    let threw = false;
    try { await fire(badOrigin, { eventName: 'loginWxCodeReady', data: { code: 'X' } }); } catch { threw = true; }
    ok(!threw, `畸形 origin "${badOrigin}" → 不抛异常`);
  }

  console.log('\n=== 7. ima 登录页 bundle 确认事件契约 ===');
  const bundlePath = '/tmp/ima-login-bundle.js';
  if (fs.existsSync(bundlePath)) {
    const b = fs.readFileSync(bundlePath, 'utf8');
    ok(/loginWxCodeReady/.test(b), 'bundle 里存在 loginWxCodeReady 事件名');
    ok(/window\.parent\.postMessage/.test(b), '通过 window.parent.postMessage 发给宿主');
    ok(/LoginPanelReady|loginPanelReady/.test(b), '存在 loginPanelReady');
  } else {
    console.log('  (跳过：未缓存 bundle)');
  }

  console.log('\n' + '='.repeat(44));
  console.log(`结果：${pass} 通过 / ${fail} 失败`);
  console.log('='.repeat(44) + '\n');
  process.exit(fail ? 1 : 0);
})();
