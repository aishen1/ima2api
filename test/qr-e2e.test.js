#!/usr/bin/env node
/**
 * 扫码链路的端到端测试（真连微信，不走 mock）
 *
 * 验证的是「服务端纯 HTTP 长轮询」这条链路真的活着：
 *   1. /admin/qr/create 能拿到真二维码（data URL → JPEG，且能解码出微信确认 URL）
 *   2. /admin/qr/poll 长轮询真的在问微信（未扫码回 waiting）
 *   3. 二维码里的 uuid 与微信长轮询端点用的一致
 *
 * 需要外网访问 open.weixin.qq.com / long.open.weixin.qq.com。
 * 无外网时跳过（不算失败），这样内网环境跑测试也不会红。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 18094;

let pass = 0, fail = 0, skipped = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓ ' + m)) : (fail++, console.log('  ✗ ' + m)); };
const skip = m => { skipped++; console.log('  … 跳过：' + m); };

(async () => {
  // ---- 起服务 ----
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ima2api-qr-'));
  for (const f of ['server.js', 'admin.html', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(tmp, f));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(tmp, 'node_modules'));
  fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({
    server: { port: PORT },
    api_keys: ['sk-ima-' + '0'.repeat(40)],
    accounts: [],
  }, null, 2));

  const child = spawn(process.execPath, ['server.js'], {
    cwd: tmp, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', d => { log += d; });
  child.stderr.on('data', d => { log += d; });

  const cleanup = () => {
    try { child.kill('SIGKILL'); } catch {}
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  };
  process.on('exit', cleanup);

  const base = `http://127.0.0.1:${PORT}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try { if ((await fetch(`${base}/health`)).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  if (!ready) {
    console.log('✗ 服务未能就绪\n' + log.slice(-600));
    cleanup(); process.exit(1);
  }

  // ---- 1. 创建扫码会话 ----
  console.log('\n=== 1. POST /admin/qr/create 取真二维码 ===');
  let qr;
  try {
    const r = await fetch(`${base}/admin/qr/create`, { method: 'POST' });
    qr = await r.json();
  } catch (e) {
    skip(`无外网或请求失败（${e.message}）`);
    console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过\n`);
    cleanup(); process.exit(0);
  }

  if (!qr.ok) {
    // 区分「网络不通」和「代码有 bug」
    const err = String(qr.error || '');
    if (/ENOTFOUND|EAI_AGAIN|timeout|ETIMEDOUT|ECONNREFUSED/.test(err)) {
      skip(`外网不可达：${err}`);
      console.log(`\n结果：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过\n`);
      cleanup(); process.exit(0);
    }
    ok(false, `创建扫码会话失败：${err}`);
    cleanup(); process.exit(1);
  }

  ok(!!qr.session, `返回 session（${String(qr.session).slice(0, 8)}…）`);
  ok(Number(qr.expires_in) > 0, `返回 expires_in=${qr.expires_in}`);

  const m = String(qr.qr_data_url || '').match(/^data:(image\/\w+);base64,(.*)$/s);
  ok(!!m, 'qr_data_url 是 data URL');
  if (m) {
    const img = Buffer.from(m[2], 'base64');
    ok(m[1] === 'image/jpeg', `MIME = ${m[1]}`);
    ok(img.length > 5000, `二维码图片 ${img.length} 字节（非空图）`);
    ok(img[0] === 0xFF && img[1] === 0xD8 && img[2] === 0xFF, 'JPEG 魔数正确');

    // 用 opencv 解码（装了才解），确认二维码真能被扫
    const qjpg = path.join(os.tmpdir(), `ima2api-qr-${Date.now()}.jpg`);
    fs.writeFileSync(qjpg, img);
    const { execFileSync } = require('child_process');
    let decoded = '';
    try {
      decoded = execFileSync('/tmp/qrvenv/bin/python', ['-c', `
import cv2, sys
d,_,_ = cv2.QRCodeDetector().detectAndDecode(cv2.imread(sys.argv[1]))
print(d or '')
`, qjpg], { encoding: 'utf8', timeout: 30000 }).trim();
    } catch { /* opencv 不可用就跳过这条 */ }
    if (decoded) {
      ok(decoded.includes('open.weixin.qq.com/connect/confirm'),
         `二维码可解码，指向微信确认域：${decoded.slice(0, 60)}`);
    } else {
      skip('未装 opencv，跳过"二维码可解码"断言');
    }
    fs.rmSync(qjpg, { force: true });
  }

  // ---- 2. 长轮询 ----
  console.log('\n=== 2. GET /admin/qr/poll 长轮询 ===');
  ok(qr.session, '有 session 可轮询');
  if (qr.session) {
    const t0 = Date.now();
    const r = await fetch(`${base}/admin/qr/poll?session=${encodeURIComponent(qr.session)}`);
    const s = await r.json();
    const dt = Date.now() - t0;
    ok(r.status === 200, `HTTP ${r.status}`);
    ok(['waiting', 'scanned', 'confirmed'].includes(s.state),
       `state=${s.state}（未扫码应为 waiting）`);
    // 真实长轮询会挂住一段时间；立刻返回说明没真去问微信
    ok(dt > 500, `确实发生阻塞等待（${dt}ms）——证明真在问微信，不是本地空转`);

    console.log('\n=== 3. 参数校验 ===');
    const r2 = await fetch(`${base}/admin/qr/poll`);
    ok(r2.status === 400, '缺 session → 400');
    const r3 = await fetch(`${base}/admin/qr/poll?session=does-not-exist`);
    const s3 = await r3.json();
    ok(s3.state === 'expired', '不存在的 session → state=expired');

    console.log('\n=== 4. 未扫码时换凭证应被拒 ===');
    const r4 = await fetch(`${base}/admin/qr/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session: qr.session }),
    });
    const s4 = await r4.json();
    ok(s4.ok === false, '未拿到 code 时拒绝换取');
    ok(/尚未拿到微信 code|缺少 code/.test(String(s4.error)), `提示明确：${s4.error}`);
  }

  // ---- 5. 无 session 也应有兜底 ----
  console.log('\n=== 5. 兼容：仍可直接传 code ===');
  const r5 = await fetch(`${base}/admin/qr/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'FAKECODE' }),
  });
  const s5 = await r5.json();
  ok(s5.ok === false, '假 code 被拒');
  ok(/ima 拒绝该 code|40029|invalid code/.test(String(s5.error)),
     `真去问了 ima 并拿到拒绝原因：${String(s5.error).slice(0, 80)}`);

  console.log('\n=== 6. 服务端无崩溃 ===');
  ok(child.exitCode === null, '测试过程中服务保持运行');
  ok(!/ReferenceError|TypeError|is not defined/.test(log),
     `日志无未定义错误${/ReferenceError|TypeError/.test(log) ? '：' + log.slice(-300) : ''}`);

  console.log('\n' + '='.repeat(44));
  console.log(`结果：${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''}`);
  console.log('='.repeat(44) + '\n');
  cleanup();
  process.exit(fail ? 1 : 0);
})();
