#!/bin/bash
# 旧入口 —— 保留作 fallback。日常请用：
#   node scripts/regression/run-regression.cjs [--suites=... | --module=... | --changed]
#
#   bash scripts/regression/harness/run-all.sh            → mock（默认）：同源假 DAV，零坚果云额度
#   bash scripts/regression/harness/run-all.sh --real     → 真坚果云：发版前跑一次，每套之间停 60 秒
#   bash scripts/regression/harness/run-all.sh --real stage5-image.cjs stage6-source.cjs
#
# 用法说明见 docs/regression-workflow.md 与 docs/regression-harness.md。
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
cd "$HERE/../suites" || exit 1

export NODE_PATH="${DONOTE_NODE_PATH:-${NODE_PATH:-}}"
export BASE="${BASE:-http://localhost:5173}"
NODE="${NODE:-node}"

MODE=mock
TAG=mock
GAP=0
if [ "${1:-}" = "--real" ]; then
  MODE=real
  TAG=real
  GAP=60
  export USE_REAL_DAV=1
  shift
  echo "== 真实坚果云模式：9 套连跑会超出免费版 30 分钟 600 次额度，只该在发版前跑一次 =="
else
  echo "== mock 模式：同源假 DAV，不耗坚果云额度 =="
fi

# mock 模式下先确认 dev server 在跑；真实模式同理
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/" 2>/dev/null)
if [ "$code" != "200" ]; then
  echo "dev server 不可用（$BASE → $code），先起 pnpm dev"
  exit 1
fi

SUITES="${*:-notes-e2e.cjs attach-e2e.cjs life-e2e.cjs stage2-editor.cjs stage4-toolbar.cjs stage5-image.cjs stage6-source.cjs stage7-walk.cjs actions-e2e.fixed.cjs}"

LOG="${DONOTE_LOG_DIR:-$HERE/../.logs}"
mkdir -p "$LOG"

T0=$(date +%s)
SUMMARY=""
TOTAL_PASS=0
TOTAL_FAIL=0
BROKEN=""

for f in $SUITES; do
  S0=$(date +%s)
  timeout 600 "$NODE" "$f" > "$LOG/$TAG-$f.log" 2>&1
  rc=$?
  S1=$(date +%s)
  pass=$(grep -cE '^PASS' "$LOG/$TAG-$f.log")
  fail=$(grep -cE '^FAIL' "$LOG/$TAG-$f.log")
  TOTAL_PASS=$((TOTAL_PASS + pass))
  TOTAL_FAIL=$((TOTAL_FAIL + fail))
  if [ "$fail" != "0" ] || [ "$pass" = "0" ]; then BROKEN="$BROKEN $f"; fi
  printf '%-26s exit=%-3s %3ss  PASS=%-3s FAIL=%s\n' "$f" "$rc" "$((S1 - S0))" "$pass" "$fail"
  SUMMARY="$SUMMARY$f|$pass|$fail|$((S1 - S0))
"
  if [ "$fail" != "0" ]; then grep -E '^FAIL' "$LOG/$TAG-$f.log" | head -8 | sed 's/^/    /'; fi
  [ "$GAP" != "0" ] && sleep "$GAP"
done

T1=$(date +%s)
echo
echo "==================== $TAG 模式汇总 ===================="
printf '%-26s %6s %6s %8s\n' 套件 PASS FAIL 用时
echo "$SUMMARY" | while IFS='|' read -r name p q secs; do
  [ -z "$name" ] && continue
  printf '%-26s %6s %6s %7ss\n' "$name" "$p" "$q" "$secs"
done
echo "-----------------------------------------------------"
printf '合计 PASS=%s FAIL=%s 总用时=%ss\n' "$TOTAL_PASS" "$TOTAL_FAIL" "$((T1 - T0))"
if [ -n "$BROKEN" ]; then
  echo "有问题：$BROKEN"
  exit 1
fi
echo "全部通过"
