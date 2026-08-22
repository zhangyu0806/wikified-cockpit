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

# 7. 勾选写回：'- 待办一' 在第 2 行（0-based）
TOGGLE=$(curl -s -X POST "http://127.0.0.1:$PORT/api/open-loops/toggle" \
  -H 'content-type: application/json' -d '{"line":2,"expect":"- 待办一"}')
python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["ok"] and d["done"], d' <<<"$TOGGLE" \
  && pass "勾选写回成功" || fail "toggle failed: $TOGGLE"
grep -q '✅ 待办一' "$ROOT/wiki/context/open-loops.md" \
  && pass "文件已写入完成标记" || fail "done mark not written"

# 8. 写前备份存在
[ -f "$ROOT/wiki/context/.open-loops.bak" ] \
  && pass "写前自动备份生成" || fail "backup missing"

# 9. 乐观锁：expect 与实际不符必须拒绝（409），不能改错行
STALE=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/open-loops/toggle" \
  -H 'content-type: application/json' -d '{"line":2,"expect":"- 完全不匹配的内容"}')
[ "$STALE" = "409" ] && pass "内容不符时拒绝写入 409" || fail "stale write not rejected ($STALE)"

# 10. 加项到指定分组
curl -sf -X POST "http://127.0.0.1:$PORT/api/open-loops/add" \
  -H 'content-type: application/json' -d '{"group":"组A","text":"新增待办"}' >/dev/null \
  && grep -q '^- 新增待办$' "$ROOT/wiki/context/open-loops.md" \
  && pass "加项写入正确分组" || fail "add failed"

# 11. 不存在的分组必须拒绝
NOGRP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/open-loops/add" \
  -H 'content-type: application/json' -d '{"group":"不存在的组","text":"x"}')
[ "$NOGRP" = "404" ] && pass "未知分组被拒 404" || fail "unknown group not rejected ($NOGRP)"

# 12. 空内容 / 含换行必须拒绝
EMPTY=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/open-loops/add" \
  -H 'content-type: application/json' -d '{"group":"组A","text":"   "}')
NL=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/open-loops/add" \
  -H 'content-type: application/json' -d '{"group":"组A","text":"a\nb"}')
[ "$EMPTY" = "400" ] && [ "$NL" = "400" ] \
  && pass "空内容与含换行被拒 400" || fail "invalid text not rejected ($EMPTY/$NL)"

# 13. 写操作不能触及 open-loops 之外的文件（无路径参数可传）
BEFORE=$(md5sum "$ROOT/wiki/context/CRITICAL_FACTS.md" | cut -d' ' -f1)
curl -s -X POST "http://127.0.0.1:$PORT/api/open-loops/add" \
  -H 'content-type: application/json' \
  -d '{"group":"组A","text":"probe","path":"wiki/context/CRITICAL_FACTS.md"}' >/dev/null
AFTER=$(md5sum "$ROOT/wiki/context/CRITICAL_FACTS.md" | cut -d' ' -f1)
[ "$BEFORE" = "$AFTER" ] \
  && pass "写操作无法影响白名单外文件" || fail "unrelated file was modified"

printf '\n--- result: all cockpit server tests PASS ---\n'
