#!/usr/bin/env bash
# Wikified Cockpit 启动器：构建前端（如需）并启动本机 Bun server。
# 仅绑 127.0.0.1；Windows 浏览器经 WSL2 localhost 转发访问。
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$REPO"

PORT="${COCKPIT_PORT:-4177}"
BUN_BIN=$(command -v bun 2>/dev/null || true)
if [[ -z "$BUN_BIN" && -x "$HOME/.bun/bin/bun" ]]; then
  BUN_BIN="$HOME/.bun/bin/bun"
fi
if [[ -z "$BUN_BIN" ]]; then
  echo "找不到 bun。安装：curl -fsSL https://bun.sh/install | bash" >&2
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "首次运行：安装依赖…"
  "$BUN_BIN" install
fi

if [ ! -f dist/index.html ] || [ "${1:-}" = "--rebuild" ]; then
  echo "构建前端…"
  "$BUN_BIN" run build
fi

echo "启动 Cockpit（端口 $PORT）…"
echo "Windows 浏览器打开：http://localhost:$PORT"
COCKPIT_PORT="$PORT" exec "$BUN_BIN" run server/index.ts
