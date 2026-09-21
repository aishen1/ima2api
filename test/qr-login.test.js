#!/usr/bin/env node
/**
 * 扫码登录回归测试（服务端纯 HTTP 长轮询方案）
 *
 * 背景（必读，别再改回去）：
 *   1.0.8 用的是「内嵌 ima 官方登录页 + 监听 postMessage」，
 *   实测永远转圈。根因有两条，且都无解：
 *     a) #/login-qr-only 路由根本不发 loginWxCodeReady，
 *        它自己调 verifyWxCode 把 code 塞进 ima 自己的登录弹窗，对宿主静默。
 *        只有 #/universal-login-qr-only 会经 #/qr-code-scanned 中转页转发 code。
 *     b) 即使换成 universal 路由，中转页转发时 targetOrigin 取 Bs()，
 *        而 Bs() 在普通浏览器里恒等于常量 Nm="https://ima.qq.com"
 *        （G2 白名单里没有 ima.qq.com，必然落到兜底常量）。
 *        我们页面源是 http://NAS:8088，永远匹配不上 → 浏览器丢弃消息。
 *        targetOrigin 白名单 XS 也只有 ima 自家域名。
 *   所以必须把整条链路搬到服务端：自己取 uuid、自己长轮询、自己换 token。
 *
 * 本测试锁住新架构，防止有人改回 iframe 方案。
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

console.log('\n=== 1. 前端结构（改为 <img> 二维码，不再用 iframe）===');
ok(/id="qrImg"/.test(ADMIN), '存在二维码图片 #qrImg');
ok(/id="qrWrap"/.test(ADMIN), '存在容器 #qrWrap');
ok(/id="qrState"/.test(ADMIN), '存在状态位 #qrState');
ok(/function qrStart\(/.test(ADMIN), '存在 qrStart()');
ok(/function qrLoad\(/.test(ADMIN), '存在 qrLoad()');
ok(/function qrStop\(/.test(ADMIN), '存在 qrStop()');
ok(/function qrReload\(/.test(ADMIN), '存在 qrReload()');
ok(/function qrPoll\(/.test(ADMIN), '存在 qrPoll()（长轮询）');
ok(/function qrExchange\(/.test(ADMIN), '存在 qrExchange()（换凭证）');

console.log('\n=== 2. 反向断言：iframe / postMessage 方案必须已彻底移除 ===');
ok(!/qrFrame/.test(ADMIN), '不再有 #qrFrame iframe');
ok(!/onQrMessage|addEventListener\('message'/.test(ADMIN), '不再监听 postMessage');
ok(!/loginWxCodeReady/.test(ADMIN), '不再依赖 loginWxCodeReady 事件');
ok(!/universal-login-qr-only|login-qr-only/.test(ADMIN), '不再引用 ima 登录页路由');
ok(!/ima\.qq\.com\/login/.test(ADMIN), '不再内嵌 ima 登录页');

console.log('\n=== 3. 前端调用新的服务端接口 ===');
ok(/api\('\/admin\/qr\/create'/.test(ADMIN), "调用 /admin/qr/create 取二维码");
ok(/admin\/qr\/poll\?session=/.test(ADMIN), "轮询 /admin/qr/poll?session=");
ok(/api\('\/admin\/qr\/login'/.test(ADMIN), "调用 /admin/qr/login 换凭证");
ok(/session: QR_SESSION/.test(ADMIN), '换凭证时传 session（前端不碰 code）');
ok(/qr_data_url/.test(ADMIN), '使用服务端返回的 qr_data_url');
ok(/verify/.test(ADMIN) || /verified/.test(ADMIN), '处理 verified 字段');

console.log('\n=== 4. 前端状态机覆盖各扫码状态 ===');
for (const st of ['confirmed', 'scanned', 'canceled', 'expired', 'error']) {
  ok(new RegExp(`case '${st}'`).test(ADMIN), `处理 state='${st}'`);
}
ok(/qrStopTimer/.test(ADMIN), '收起/刷新时清理轮询定时器（防止泄漏）');
ok(/if\(!QR_SESSION\) return;/.test(ADMIN), '轮询回调检查会话是否已失效');

console.log('\n=== 5. 后端：新的扫码会话实现 ===');
ok(/urlPath === "\/admin\/qr\/create"/.test(SERVER), '路由 POST /admin/qr/create');
ok(/urlPath === "\/admin\/qr\/poll"/.test(SERVER), '路由 GET /admin/qr/poll');
ok(/urlPath === "\/admin\/qr\/login"/.test(SERVER), '路由 POST /admin/qr/login');
ok(/async function qrCreateSession/.test(SERVER), '实现 qrCreateSession()');
ok(/async function qrPollSession/.test(SERVER), '实现 qrPollSession()');
ok(/const qrSessions = new Map\(\)/.test(SERVER), '用 Map 存扫码会话');
ok(/QR_SESSION_TTL/.test(SERVER), '会话有过期时间（防内存泄漏）');
ok(/function qrSweep/.test(SERVER), '有会话清理逻辑');
ok(/function httpGetRaw/.test(SERVER), '有原始字节 GET（二维码是 JPEG，不能当文本读）');

console.log('\n=== 6. 后端：微信 qrconnect 链路要素 ===');
ok(/wx0d63f5de059f1d52/.test(SERVER), '使用 ima 的微信 appid');
ok(/https:\/\/ima\.qq\.com\/login/.test(SERVER), 'redirect_uri = ima.qq.com/login（微信白名单内）');
ok(/snsapi_login/.test(SERVER), 'scope=snsapi_login');
ok(/open\.weixin\.qq\.com/.test(SERVER), '访问 open.weixin.qq.com');
ok(/connect\/qrconnect/.test(SERVER), '拉 qrconnect 页面');
ok(/connect\/qrcode\//.test(SERVER), '拉二维码图片');
ok(/long\.open\.weixin\.qq\.com/.test(SERVER), '长轮询 long.open.weixin.qq.com');
ok(/wx_errcode/.test(SERVER), '解析 wx_errcode');
ok(/wx_code/.test(SERVER), '解析 wx_code');
// 关键错误码分支
ok(/case 405/.test(SERVER), '处理 405（已确认，含 code）');
ok(/case 404/.test(SERVER), '处理 404（已扫码待确认）');
ok(/case 403/.test(SERVER), '处理 403（用户取消）');
ok(/case 402/.test(SERVER), '处理 402（二维码过期）');
ok(/case 408/.test(SERVER), '处理 408（未扫码，继续轮询）');
ok(/data:image\/jpeg|image\/jpeg/.test(SERVER), '二维码以 data URL 返回');
ok(/base64/.test(SERVER), '二维码 base64 内联（不需额外接口/落盘）');

console.log('\n=== 7. 后端：换 token 逻辑保持完整 ===');
ok(/\/auth_login\/login/.test(SERVER), '调用 ima /auth_login/login');
ok(/account_type/.test(SERVER), '传 account_type');
ok(/client_info/.test(SERVER), '传 client_info');
ok(/data\.refreshToken \|\| data\.refresh_token/.test(SERVER), '兼容 refreshToken 两种命名');
ok(/data\.userId \|\| data\.user_id/.test(SERVER), '兼容 userId 两种命名');
ok(/IMA-TOKEN=\$\{token\}/.test(SERVER), '组装 IMA-TOKEN');
ok(/IMA-REFRESH-TOKEN=\$\{refresh\}/.test(SERVER), '组装 IMA-REFRESH-TOKEN');
ok(/created_via: "qr"/.test(SERVER), '标记 created_via=qr');
ok(/imaInitSession\("ping", account\)/.test(SERVER), '落库前实测校验（无效凭证不静默入库）');
ok(/缺少 code/.test(SERVER), '缺 code → 400');
ok(/尚未拿到微信 code/.test(SERVER), '会话还没 code 时给明确提示');
ok(/uid_masked/.test(SERVER), '返回脱敏 uid');
ok(!/return json\(res, 200, \{[\s\S]{0,300}cookie\s*:/.test(SERVER), '响应不回传完整 cookie');

console.log('\n=== 8. UI 精简：移除「高级：当前调用的 Key」===');
ok(!/当前调用的 Key/.test(ADMIN), '页面不再出现「高级：当前调用的 Key」');
ok(!/id="keyList"/.test(ADMIN), '不再有 #keyList 容器');
ok(!/\$\('keyList'\)/.test(ADMIN), '不再有引用 #keyList 的 JS');

console.log('\n=== 9. UI 精简：账号列表只显示账号名 + 有效性 ===');
ok(/<span class="name">\$\{esc\(a\.name\)\}<\/span>\$\{pill\}/.test(ADMIN),
   '账号行 = 账号名 + 有效性徽标');
ok(!/cookie_masked/.test(ADMIN), '不显示 Cookie');
ok(!/ok_count|fail_count/.test(ADMIN), '不显示成功/失败次数');
ok(!/remain_seconds|预计失效/.test(ADMIN), '不显示有效期');
ok(!/last_refresh|last_check|last_ok/.test(ADMIN), '不显示最近续期/检测时间');
ok(!/立即续期/.test(ADMIN), '去掉「立即续期」按钮');
ok(/STATE_LABEL/.test(ADMIN), '保留有效性徽标定义');

console.log('\n=== 10. 账号管理操作仍可用 ===');
for (const [fn, label] of [['testAcct','测试'],['toggleAcct','停用/启用'],
                           ['renameAcct','改名'],['updateCookie','更新 Cookie'],['delAcct','删除']]) {
  ok(new RegExp(`function ${fn}|${fn}\\('\${a\\.id}'`).test(ADMIN), `保留「${label}」`);
}

console.log('\n=== 11. 版本号 ===');
const VER = (SERVER.match(/BUILD_VERSION = "([\d.]+)"/) || [])[1];
ok(VER === '1.0.9', `BUILD_VERSION = 1.0.9（实际 ${VER}）`);
const MVER = (fs.readFileSync(path.join(ROOT, 'fpk/manifest'), 'utf8')
  .match(/^version\s*=\s*([\d.]+)$/m) || [])[1];
ok(MVER === '1.0.9', `manifest version = 1.0.9（实际 ${MVER}）`);

console.log('\n=== 12. 1.0.7 的模型同步未被回退 ===');
ok(/MODEL_LIST_PATH = "\/cgi-bin\/model_manage\/get_models"/.test(SERVER), '模型列表接口仍在');
ok(/async function syncModels/.test(SERVER), 'syncModels 仍在');

console.log('\n' + '='.repeat(44));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
console.log('='.repeat(44) + '\n');
process.exit(fail ? 1 : 0);
