#!/bin/bash
# 从本仓库构建 ima2api.fpk
#
# 用法：
#   ./fpk/build.sh                     # 用应用中心 Node.js 作为内置运行时
#   NODE_BIN=/path/to/node ./fpk/build.sh
#
# 说明：
#   - app/ 下的源码在构建时从仓库根目录同步，仓库里不存副本
#   - node 运行时会被 strip 后塞进包内（约 100MB），使安装环境无需预装 Node
#   - 需要 fnpack（飞牛应用打包工具）：https://developer.fnnas.com/

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKG="$ROOT/fpk"
APP="$PKG/app"
OUT="$PKG/ima2api.fpk"

# 找 node：优先环境变量，其次应用中心，最后 PATH
find_node() {
    if [ -n "${NODE_BIN:-}" ] && [ -x "${NODE_BIN}" ]; then echo "${NODE_BIN}"; return; fi
    for c in /var/apps/nodejs_v24/target/bin/node \
             /var/apps/nodejs_v22/target/bin/node \
             /var/apps/nodejs_v20/target/bin/node; do
        [ -x "$c" ] && { echo "$c"; return; }
    done
    command -v node 2>/dev/null || true
}

NODE="$(find_node)"
if [ -z "$NODE" ]; then
    echo "ERROR: 找不到 node，请用 NODE_BIN=/path/to/node 指定" >&2
    exit 1
fi
echo "[1/5] node = $NODE ($("$NODE" -v))"

if ! command -v fnpack >/dev/null 2>&1; then
    echo "ERROR: 找不到 fnpack（飞牛应用打包工具）" >&2
    exit 1
fi

# ---- 同步源码到 app/ ----
echo "[2/5] 同步源码"
mkdir -p "$APP"
cp "$ROOT/server.js" "$ROOT/admin.html" "$ROOT/config.example.json" \
   "$ROOT/package.json" "$ROOT/package-lock.json" "$APP/"
# 桌面入口与图标（源在 fpk/ui/，纳入版本管理）
mkdir -p "$APP/ui/images"
cp "$ROOT/fpk/ui/config" "$APP/ui/"
cp "$ROOT/fpk/ui/images/"*.png "$APP/ui/images/"
# fpk 内配置端口走 8088（避免与常见的 8081 占用冲突）
sed -i 's/"port": 8081/"port": 8088/' "$APP/config.example.json"

# ---- 安装生产依赖 ----
echo "[3/5] 安装生产依赖"
if [ ! -d "$APP/node_modules/express" ]; then
    # npm 是 js 脚本，需要同目录的 node 在 PATH 里（应用中心的 node 未加入 PATH）
    (
        cd "$APP"
        PATH="$(dirname "$NODE"):$PATH" \
            "$(dirname "$NODE")/npm" install --omit=dev --no-audit --no-fund 2>&1 | tail -3
    )
else
    echo "      node_modules 已存在，跳过"
fi

# ---- 内置 node 运行时 ----
echo "[4/5] 内置 node 运行时"
mkdir -p "$APP/runtime/bin"
if [ ! -x "$APP/runtime/bin/node" ]; then
    cp "$NODE" "$APP/runtime/bin/node"
    command -v strip >/dev/null 2>&1 && strip "$APP/runtime/bin/node" 2>/dev/null || true
fi
echo "      $(du -h "$APP/runtime/bin/node" | cut -f1)"

# ---- 打包 ----
echo "[5/5] fnpack build"
chmod +x "$PKG"/cmd/*
( cd "$PKG" && rm -f ima2api.fpk && fnpack build 2>&1 | tail -3 )

echo
echo "完成：$OUT ($(du -h "$OUT" 2>/dev/null | cut -f1))"
echo
echo "安装："
echo "  appcenter-cli install-local enable"
echo "  appcenter-cli install-fpk $OUT"
