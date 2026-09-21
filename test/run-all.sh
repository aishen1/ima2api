#!/usr/bin/env bash
# 跑全部测试并汇总。
#   - jsdom 缺失时 admin-render / admin-ui / iframe-embed 会自行跳过
#   - qr-e2e 需要外网访问微信；无外网时自行跳过
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/var/apps/nodejs_v24/target/bin:$PATH"

tp=0; tf=0; failed=()
for f in test/*.test.js; do
  out=$(node "$f" 2>&1)
  line=$(echo "$out" | grep "结果：" | tail -1)
  printf "%-28s %s\n" "$(basename "$f")" "${line:-（无汇总，可能已跳过）}"
  p=$(echo "$line" | grep -oP '：\K\d+')
  fl=$(echo "$line" | grep -oP '通过 / \K\d+')
  tp=$((tp + ${p:-0})); tf=$((tf + ${fl:-0}))
  if [ -n "${fl:-}" ] && [ "$fl" != "0" ]; then failed+=("$f"); fi
done

echo "----------------------------------------------"
echo "合计：$tp 通过 / $tf 失败"
if [ ${#failed[@]} -gt 0 ]; then
  echo "失败：${failed[*]}"
  exit 1
fi
echo "全部通过 ✓"
