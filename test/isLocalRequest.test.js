// 回归测试：isLocalRequest 来源判定（含 fnOS App 外网经网关转发的场景）
const fs = require("fs");
const vm = require("vm");
const src = fs.readFileSync("/vol2/@apphome/hermes-studio/hermes-home/workspace/ima2api-repo/server.js", "utf-8");

// 从真实源码里抽出被测函数（不复制代码，避免测试与实现漂移）
const wanted = ["normalizeIp", "isLoopbackIp", "isPrivateIp", "clientInfo", "isLocalRequest"];
let code = "";
for (const name of wanted) {
  const re = new RegExp(`^function ${name}\\([\\s\\S]*?\\n\\}`, "m");
  const m = src.match(re);
  if (!m) { console.error(`✗ 未能从 server.js 抽出 ${name}`); process.exit(1); }
  code += m[0] + "\n";
}
const ctx = vm.createContext({ console });
vm.runInContext(code, ctx);
const { isLocalRequest, normalizeIp } = ctx;

function req(peer, xff) {
  return { socket: { remoteAddress: peer }, headers: xff === undefined ? {} : { "x-forwarded-for": xff } };
}

const cases = [
  // [说明, 对端地址, XFF, 期望放行]
  ["本机 curl（127.0.0.1，无 XFF）", "127.0.0.1", undefined, true],
  ["本机 curl（::1）", "::1", undefined, true],
  ["局域网手机直连（192.168.9.103）", "192.168.9.103", undefined, true],
  ["局域网 + 映射型 IPv6 对端", "::ffff:192.168.9.103", undefined, true],
  ["docker 网桥对端 172.17.0.1", "172.17.0.1", undefined, true],
  ["VPN 10.x 对端", "10.8.0.2", undefined, true],
  ["★ App 外网经网关转发：对端=本机，XFF=公网", "127.0.0.1", "111.163.88.123", true],
  ["★ 同上但 XFF 是映射 IPv6 公网", "127.0.0.1", "::ffff:111.163.88.123", true],
  ["★ 同上但 XFF 多级链", "127.0.0.1", "111.163.88.123, 10.0.0.1", true],
  ["★ 网关用 docker IP 转发", "172.17.0.1", "111.163.88.123", true],
  ["公网直连（端口映射暴露）", "111.163.88.123", undefined, false],
  ["公网直连 + 伪造 XFF 想混进来", "111.163.88.123", "192.168.9.5", false],
  ["公网直连 + 伪造 XFF 回环", "8.8.8.8", "127.0.0.1", false],
  ["公网 IPv6 直连", "2408:8207::1", undefined, false],
  ["连接信息缺失（unix socket）", "", undefined, true],
];

let pass = 0, fail = 0;
console.log("=== isLocalRequest 回归 ===");
for (const [desc, peer, xff, want] of cases) {
  const got = isLocalRequest(req(peer, xff));
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${desc}  → ${got ? "放行" : "拒绝"}${ok ? "" : `（期望${want ? "放行" : "拒绝"}）`}`);
}

console.log("\n=== normalizeIp ===");
for (const [inp, want] of [
  ["::ffff:192.168.9.103", "192.168.9.103"],
  ["::ffff:111.163.88.123", "111.163.88.123"],
  ["::ffff:c0a8:0967", "192.168.9.103"],
  ["127.0.0.1", "127.0.0.1"],
  ["::1", "::1"],
]) {
  const got = normalizeIp(inp);
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? "✓" : "✗"} ${inp} → ${got}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
