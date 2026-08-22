#!/usr/bin/env bash
# Cockpit server 冒烟 + 安全边界测试。自建隔离 wiki 根，绝不碰真实 ~/llm-wiki。
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cockpit-test.XXXXXX")
trap 'kill "${SRV:-0}" 2>/dev/null || true; rm -rf "$WORK"' EXIT

ROOT="$WORK/wiki"
mkdir -p "$ROOT/wiki/context" "$ROOT/memory/events" "$ROOT/raw/notes"
printf '# SCHEMA\n' >"$ROOT/SCHEMA.md"
printf '# index\n[[llm-wiki]]\n' >"$ROOT/wiki/index.md"
printf '# secret page\n' >"$ROOT/wiki/context/CRITICAL_FACTS.md"
printf '# Open Loops\n## 组A\n- 待办一\n- ✅ 已完成\n' >"$ROOT/wiki/context/open-loops.md"

PORT=4199
COCKPIT_PORT="$PORT" LLM_WIKI_ROOT="$ROOT" bun run "$REPO/server/index.ts" >"$WORK/server.log" 2>&1 &
SRV=$!

# 等端口就绪
for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$PORT/api/tree" >/dev/null 2>&1 && break
  sleep 0.2
done

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; exit 1; }

code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

# 1. review API 返回合法 JSON 且读的是隔离库
curl -sf "http://127.0.0.1:$PORT/api/review" \
  | python3 -c 'import json,sys; json.load(sys.stdin)' \
  && pass "review API 返回合法 JSON" || fail "review API"

# 2. 路径逃逸 -> 403
[ "$(code "http://127.0.0.1:$PORT/api/page?path=../../../etc/passwd")" = "403" ] \
  && pass "../ 逃逸被拒 403" || fail "path traversal not blocked"

# 3. 非 .md -> 403
[ "$(code "http://127.0.0.1:$PORT/api/page?path=SCHEMA")" = "403" ] \
  && pass "非 .md 被拒 403" || fail "non-md not blocked"

# 4. 命令注入型 correction id -> 400
INJ=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
  "http://127.0.0.1:$PORT/api/corrections/resolve" \
  -H 'content-type: application/json' -d '{"id":"; rm -rf /","status":"promoted"}')
[ "$INJ" = "400" ] && pass "命令注入型 id 被拒 400" || fail "injection id not rejected ($INJ)"

# 5. 合法页可读
curl -sf "http://127.0.0.1:$PORT/api/page?path=wiki/index.md" \
  | python3 -c 'import json,sys; assert "index" in json.load(sys.stdin)["content"]' \
  && pass "合法 md 页可读" || fail "valid page read"

# 6. open-loops 可读
curl -sf "http://127.0.0.1:$PORT/api/open-loops" \
  | python3 -c 'import json,sys; assert json.load(sys.stdin)["exists"]' \
  && pass "open-loops 可读" || fail "open-loops"

printf '\n--- result: all cockpit server tests PASS ---\n'
