#!/usr/bin/env node
/**
 * 扫码登录（方案 A）回归测试
 *
 * 覆盖：
 *   1. 前端 postMessage 处理：只认 ima.qq.com，正确解析 loginWxCodeReady 并拿到 code
 *   2. 伪造来源（其它域）必须被忽略 —— 这是安全底线
 *   3. 各事件名（booting/ready/error/codeReady）的状态文案
 *   4. 重复事件去重（QR_BUSY）
 *   5. 后端 /admin/qr/login 的代码结构（字段、cookie 组装、失败分支）
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const ADMIN = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

let pass = 0, fail = 0;
const ok = (cond, msg) => {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; console.log('  ✗ ' + msg); }
};

console.log('\n=== 1. admin.html 结构 ===');
ok(/id="qrFrame"/.test(ADMIN), '存在二维码 iframe #qrFrame');
ok(/id="qrWrap"/.test(ADMIN), '存在容器 #qrWrap');
ok(/id="qrState"/.test(ADMIN), '存在状态位 #qrState');
ok(/function qrStart\(/.test(ADMIN), '存在 qrStart()');
ok(/function qrLoad\(/.test(ADMIN), '存在 qrLoad()');
ok(/function qrStop\(/.test(ADMIN), '存在 qrStop()');
ok(/function qrReload\(/.test(ADMIN), '存在 qrReload()');
ok(/function onQrMessage\(/.test(ADMIN), '存在 onQrMessage()');
ok(/addEventListener\('message',\s*onQrMessage/.test(ADMIN), '已注册 message 监听');

console.log('\n=== 2. 二维码入口 URL ===');
ok(/ima\.qq\.com\/login#\/login-qr-only/.test(ADMIN), 'iframe 指向 ima 纯扫码路由 #/login-qr-only');
ok(/ts=' \+ Date\.now\(\)/.test(ADMIN), 'URL 带时间戳（防缓存，保证"刷新二维码"生效）');

console.log('\n=== 3. 来源校验（安全底线）===');
ok(/new URL\(ev\.origin\)/.test(ADMIN), '从 ev.origin 构造 URL');
ok(/u\.hostname !== 'ima\.qq\.com'/.test(ADMIN), '域名必须精确等于 ima.qq.com');
ok(/u\.protocol !== 'https:'/.test(ADMIN), '协议必须是 https（防明文劫持 code）');
// 反向：不能只靠 data 判断，必须校验 origin
ok(!/if\s*\(\s*!d\s*\|\|\s*typeof d !== 'object'\s*\)\s*return;\s*\n\s*if\s*\(\s*d\.eventName === 'loginWxCodeReady'/.test(ADMIN),
   '解析 code 前先过了 origin 校验（顺序正确）');

console.log('\n=== 4. 事件名覆盖 ===');
ok(/loginWxCodeReady/.test(ADMIN), '处理 loginWxCodeReady（扫码成功，含 code）');
ok(/loginPanelReady/.test(ADMIN), '处理 loginPanelReady');
ok(/loginPanelError/.test(ADMIN), '处理 loginPanelError');
ok(/loginPanelBooting|loginPanelInitializing/.test(ADMIN), '处理启动中事件');

console.log('\n=== 5. code 提取与去重 ===');
ok(/d\.data && d\.data\.code/.test(ADMIN), '从 d.data.code 取 code');
ok(/if\(QR_BUSY\) return;/.test(ADMIN), 'QR_BUSY 去重，防重复换码');
ok(/QR_BUSY = false;/.test(ADMIN), 'qrLoad() 重置 QR_BUSY');

console.log('\n=== 6. 前端调用后端接口 ===');
ok(/api\('\/admin\/qr\/login'/.test(ADMIN), "调用 /admin/qr/login");
ok(/verified/.test(ADMIN), '处理 verified 字段');
ok(/r\.warning/.test(ADMIN), '展示 warning（校验未通过时）');

console.log('\n=== 7. 兜底路径 ===');
ok(/新窗口打开登录页/.test(ADMIN), '提供"新窗口打开登录页"兜底链接');
ok(/手动粘贴 Cookie|粘贴 Cookie|newCookie/.test(ADMIN), '保留手动粘贴 Cookie 入口');

console.log('\n=== 8. 后端 /admin/qr/login ===');
ok(/urlPath === "\/admin\/qr\/login"/.test(SERVER), '路由存在');
ok(/\/auth_login\/login/.test(SERVER), '调用 ima /auth_login/login');
ok(/account_type/.test(SERVER), '传 account_type');
ok(/client_info/.test(SERVER), '传 client_info');
ok(/data\.token/.test(SERVER), '读取返回的 token');
ok(/data\.refreshToken \|\| data\.refresh_token/.test(SERVER), '读取 refreshToken（兼容两种命名）');
ok(/data\.userId \|\| data\.user_id/.test(SERVER), '读取 userId（兼容两种命名）');
ok(/IMA-TOKEN=\$\{token\}/.test(SERVER), '组装 IMA-TOKEN');
ok(/IMA-UID=\$\{uid\}/.test(SERVER), '组装 IMA-UID');
ok(/IMA-REFRESH-TOKEN=\$\{refresh\}/.test(SERVER), '组装 IMA-REFRESH-TOKEN');
ok(/created_via: "qr"/.test(SERVER), '标记 created_via=qr');
ok(/imaInitSession\("ping", account\)/.test(SERVER), '落库前用 init_session 实测校验');
ok(/缺少 code/.test(SERVER), '缺 code → 400');
ok(/ima 拒绝该 code/.test(SERVER), '上游非 0 → 提示明确');
ok(/未返回 token\/userId/.test(SERVER), '缺 token/uid → 502');
ok(/uid_masked/.test(SERVER), '返回脱敏 uid（不泄露完整 uid）');
// 安全：不应把完整 cookie/token 回给前端
ok(!/return json\(res, 200, \{[\s\S]{0,300}cookie\s*:/.test(SERVER), '响应里不回传完整 cookie');

console.log('\n=== 9. 版本号 ===');
ok(/BUILD_VERSION = "1\.0\.8"/.test(SERVER), 'BUILD_VERSION = 1.0.8');
const MANIFEST = fs.readFileSync(path.join(ROOT, 'fpk/manifest'), 'utf8');
ok(/^version\s*=\s*1\.0\.8$/m.test(MANIFEST), 'manifest version = 1.0.8');

console.log('\n=== 10. 1.0.7 的模型同步未被回退 ===');
ok(/MODEL_LIST_PATH = "\/cgi-bin\/model_manage\/get_models"/.test(SERVER), '模型列表接口仍在');
ok(/async function syncModels/.test(SERVER), 'syncModels 仍在');
ok(/function modelsFromUpstream/.test(SERVER), 'modelsFromUpstream 仍在');

console.log('\n' + '='.repeat(44));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(44) + '\n');
process.exit(fail ? 1 : 0);
