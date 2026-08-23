#!/usr/bin/env bash
# 隔离 HOME 验证 installer 会把真实 Bun 路径写入 unit，不调用真实 systemd。
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d "${TMPDIR:-/tmp}/cockpit-installer.XXXXXX")
trap 'rm -rf "$WORK"' EXIT

TEST_HOME="$WORK/home"
FAKE_BIN="$WORK/bin"
ROOT="$WORK/wiki"
mkdir -p "$TEST_HOME/.bun/bin" "$FAKE_BIN" "$ROOT"

cat >"$TEST_HOME/.bun/bin/bun" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$FAKE_BIN/systemctl" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF
cat >"$FAKE_BIN/loginctl" <<'EOF'
#!/usr/bin/env bash
printf 'yes\n'
EOF
chmod +x "$TEST_HOME/.bun/bin/bun" "$FAKE_BIN/systemctl" "$FAKE_BIN/loginctl"

env HOME="$TEST_HOME" PATH="$FAKE_BIN:/usr/bin:/bin" LLM_WIKI_ROOT="$ROOT" \
  "$REPO/install-service.sh" install >/dev/null

UNIT="$TEST_HOME/.config/systemd/user/wikified-cockpit.service"
[[ -f "$UNIT" ]] || { printf 'FAIL  installer 未生成 unit\n'; exit 1; }
grep -Fq "ExecStart=$TEST_HOME/.bun/bin/bun run $REPO/server/index.ts" "$UNIT" \
  || { printf 'FAIL  unit 未使用实际 Bun 路径\n'; exit 1; }
grep -Fq "WorkingDirectory=$REPO" "$UNIT" \
  || { printf 'FAIL  unit 未写入实际仓库路径\n'; exit 1; }
grep -Fq "Environment=LLM_WIKI_ROOT=$ROOT" "$UNIT" \
  || { printf 'FAIL  unit 未保留自定义数据根\n'; exit 1; }

printf 'PASS  installer 解析 ~/.bun/bin/bun 并生成可运行 unit\n'
