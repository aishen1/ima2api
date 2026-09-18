#!/usr/bin/env python3
"""
IMA Cookie 自动刷新器（不依赖 registration_id）

背景：原版 ima_runner.py 要求 auth.registration_id 非空，否则拒绝刷新。
      实测 ima.qq.com/auth_login/refresh 根本不校验该字段 —— 传空串或省略均可成功。
      本脚本去掉那个限制，改为「只要 refresh_token 在就工作」。

它同时负责把 server.js 管起来：进程死了自动拉起，token 快过期就刷新并重启。

用法:
    python3 ima_autorefresh.py            # 前台运行
    python3 ima_autorefresh.py --once     # 只刷新一次后退出（可交给 cron）
    python3 ima_autorefresh.py --check    # 只检查状态，不改动

日志: 同目录 ima_autorefresh.log
"""
import argparse
import json
import os
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

# ---------------- 路径配置 ----------------
BASE = "/vol2/@apphome/hermes-agent/data/workspace/ima2api"
CONFIG_PATH = "/vol2/@apphome/hermes-agent/data/workspace/ima2api/config.json"
NODE_BIN = "/vol2/@apphome/hermes-agent/data/node/bin/node"
SERVER_JS = "server.js"
LOG_PATH = "/vol2/@apphome/hermes-agent/data/workspace/ima2api/ima_autorefresh.log"
# ------------------------------------------

REFRESH_ADVANCE_SECONDS = 600   # 提前 10 分钟刷新
CHECK_INTERVAL = 120            # 每 2 分钟检查一次
DEFAULT_VALID = 7200            # 接口未给有效期时的兜底值


def ts():
    return time.strftime("%H:%M:%S")


def log(msg):
    line = f"[{ts()}] {msg}"
    print(line, flush=True)
    try:
        with open(LOG_PATH, "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def parse_cookie(s):
    out = {}
    for part in s.split(";"):
        part = part.strip()
        if "=" in part:
            k, v = part.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def build_cookie(fields):
    order = ["PLATFORM", "CLIENT-TYPE", "WEB-VERSION", "IMA-GUID", "IMA-Q36",
             "IMA-IUA", "IMA-UID", "IMA-TOKEN", "IMA-REFRESH-TOKEN",
             "UID-TYPE", "TOKEN-TYPE"]
    parts = [f"{k}={fields[k]}" for k in order if k in fields]
    parts += [f"{k}={v}" for k, v in fields.items() if k not in order]
    return "; ".join(parts)


def calc_bkn(token):
    h = 5381
    for ch in token:
        h += (h << 5) + ord(ch)
    return h & 0x7FFFFFFF


def read_config():
    with open(CONFIG_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def write_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, ensure_ascii=False, indent=2)
    os.replace(tmp, CONFIG_PATH)   # 原子替换，避免写一半被读到
    os.chmod(CONFIG_PATH, 0o644)


def do_refresh(cfg):
    """刷新 IMA-TOKEN。成功返回 (新cookie, 有效期秒)；失败返回 None。"""
    auth = cfg["auth"]
    refresh_token = auth.get("refresh_token", "")
    if not refresh_token:
        log("[ERROR] config.json 缺少 auth.refresh_token —— 必须重新抓包")
        return None

    fields = parse_cookie(auth["cookie"])
    token = fields.get("IMA-TOKEN", "")
    uid = fields.get("IMA-UID", "")
    if not uid:
        log("[ERROR] cookie 中缺少 IMA-UID")
        return None

    # 注意：registration_id 故意不传 —— 服务端不校验，传空串也能成功
    payload = json.dumps({
        "user_id": uid,
        "refresh_token": refresh_token,
        "token_type": 14,
    }).encode("utf-8")

    headers = {
        "from_browser_ima": "1",
        "x-ima-cookie": auth["cookie"],
        "x-ima-bkn": str(calc_bkn(token)),
        "referer": "https://ima.qq.com",
        "origin": "https://ima.qq.com",
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "identity",
        "Connection": "Keep-Alive",
    }
    req = urllib.request.Request("https://ima.qq.com/auth_login/refresh",
                                 data=payload, headers=headers, method="POST")

    for attempt in (1, 2, 3):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                body = json.loads(resp.read().decode("utf-8"))
            break
        except (urllib.error.URLError, TimeoutError) as e:
            log(f"[WARN] 刷新请求失败（第 {attempt}/3 次）: {e}")
            if attempt == 3:
                return None
            time.sleep(5 * attempt)
    else:
        return None

    if body.get("code") != 0:
        log(f"[ERROR] 刷新被拒: code={body.get('code')} msg={body.get('msg')}")
        return None

    new_token = body.get("token")
    if not new_token:
        log(f"[ERROR] 返回里没有 token 字段: {json.dumps(body, ensure_ascii=False)[:200]}")
        return None

    valid = int(body.get("token_valid_time") or DEFAULT_VALID)
    fields["IMA-TOKEN"] = new_token
    log(f"[OK] Token 已刷新，有效期 {valid}s（{valid/3600:.1f}h）")
    return build_cookie(fields), valid


def port_busy(port=8081):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        return s.connect_ex(("127.0.0.1", port)) == 0


def api_ok(port=8081, api_key=None):
    """探活：真发一条最小请求，确认 token 真的能用。"""
    if not api_key:
        try:
            api_key = read_config()["api_keys"][0]
        except Exception:
            return False, "读不到 api_key"
    payload = json.dumps({
        "model": read_config().get("default_model", "glm-5.2"),
        "messages": [{"role": "user", "content": "hi"}],
        "max_tokens": 1,
    }).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{port}/v1/chat/completions",
                                 data=payload,
                                 headers={"Authorization": f"Bearer {api_key}",
                                          "Content-Type": "application/json"},
                                 method="POST")
    try:
        with urllib.request.urlopen(req, timeout=45) as r:
            body = json.loads(r.read().decode())
        if "error" in body:
            return False, str(body["error"])[:120]
        return True, "ok"
    except urllib.error.HTTPError as e:
        return False, f"HTTP {e.code}: {e.read().decode()[:120]}"
    except Exception as e:
        return False, f"{type(e).__name__}: {e}"


server_proc = None


def start_server():
    global server_proc
    log("启动 server.js ...")
    server_proc = subprocess.Popen(
        [NODE_BIN, SERVER_JS],
        cwd=BASE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )
    log(f"server.js 已启动 PID={server_proc.pid}")
    time.sleep(3)
    if port_busy():
        log("8081 已监听 ✅")
        return True
    log("[WARN] 启动后 8081 仍未监听（可能端口被别处占用）")
    return False


def stop_server():
    global server_proc
    if server_proc and server_proc.poll() is None:
        try:
            os.killpg(os.getpgid(server_proc.pid), signal.SIGTERM)
            server_proc.wait(timeout=10)
            log("server.js 已停止")
        except Exception as e:
            log(f"[WARN] 停止 server.js 出错: {e}")
    # 兜底：按端口找残留
    try:
        out = subprocess.run(["pgrep", "-f", f"{BASE}/{'server.js'}"],
                             capture_output=True, text=True).stdout.split()
        for pid in out:
            os.kill(int(pid), signal.SIGTERM)
    except Exception:
        pass
    server_proc = None


def wait_port_release(port=8081, timeout=15):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not port_busy(port):
            return True
        time.sleep(0.5)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true", help="刷新一次后退出（给 cron 用）")
    ap.add_argument("--check", action="store_true", help="只检查状态，不改动")
    args = ap.parse_args()

    cfg = read_config()
    fields = parse_cookie(cfg["auth"]["cookie"])

    if args.check:
        ok, detail = api_ok()
        log(f"API 探活: {'✅ 正常' if ok else '❌ ' + detail}")
        log(f"8081 监听: {port_busy()}")
        return 0 if ok else 1

    if args.once:
        log("=== 单次刷新模式 ===")
        result = do_refresh(cfg)
        if not result:
            log("刷新失败")
            return 1
        new_cookie, _ = result
        cfg["auth"]["cookie"] = new_cookie
        write_config(cfg)
        log("config.json 已更新（需要重启 server.js 才生效）")
        return 0

    # ---- 常驻模式 ----
    log("=" * 50)
    log(f"IMA 自动刷新器启动  UID={fields.get('IMA-UID','?')}")
    log(f"refresh_token: {'有 ✅' if cfg['auth'].get('refresh_token') else '无 ❌'}")
    log(f"registration_id: {cfg['auth'].get('registration_id') or '(空，不影响刷新)'}")

    if not cfg["auth"].get("refresh_token"):
        log("[FATAL] 没有 refresh_token，无法自动刷新 —— 请重新抓包填入")
        return 1

    # 首次先刷一次，拿到准确有效期
    result = do_refresh(cfg)
    if result:
        new_cookie, valid = result
        cfg["auth"]["cookie"] = new_cookie
        write_config(cfg)
        expire_at = time.time() + valid
    else:
        log("[WARN] 首次刷新失败，沿用现有 token（可能已过期）")
        expire_at = time.time() + 1800

    if not port_busy():
        start_server()
    else:
        log("8081 已在监听，复用现有进程")

    # 探活
    ok, detail = api_ok()
    log(f"首次探活: {'✅ 通过' if ok else '❌ ' + detail}")
    if not ok and not port_busy():
        start_server()

    signal.signal(signal.SIGTERM, lambda *_: (stop_server(), sys.exit(0)))

    log(f"进入循环，每 {CHECK_INTERVAL}s 检查一次")
    while True:
        time.sleep(CHECK_INTERVAL)

        # server 挂了就拉起
        if not port_busy():
            log("[WARN] 8081 不可达，重新拉起 server.js")
            start_server()
            continue

        # 还没到刷新时间
        remain = expire_at - time.time()
        if remain > REFRESH_ADVANCE_SECONDS:
            log(f"token 有效，剩余 {int(remain)}s")
            continue

        log(f"token 剩余 {int(remain)}s，开始刷新...")
        cfg = read_config()          # 重读，防止外部改过
        result = do_refresh(cfg)
        if not result:
            log("刷新失败，60s 后重试")
            time.sleep(60)
            continue

        new_cookie, valid = result
        cfg["auth"]["cookie"] = new_cookie
        write_config(cfg)
        expire_at = time.time() + valid

        log("重启 server.js 以加载新 token ...")
        stop_server()
        wait_port_release()
        start_server()
        ok, detail = api_ok()
        log(f"重启后探活: {'✅ 通过' if ok else '❌ ' + detail}")


if __name__ == "__main__":
    sys.exit(main())
