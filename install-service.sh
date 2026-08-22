#!/usr/bin/env bash
# 把 Cockpit 装成 systemd user service：开机自启、常驻、静默、崩溃自动重启。
# 装完就不用再手动 ./start.sh，也不占 tmux session。
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNIT_NAME=wikified-cockpit.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wikified-cockpit"

usage() {
  cat <<EOF
用法: ./install-service.sh [install|uninstall|status|logs]

  install    构建前端 + 安装并启动服务（默认）
  uninstall  停止并移除服务（不删代码）
  status     看服务状态
  logs       跟踪日志
EOF
}

cmd_install() {
  command -v bun >/dev/null || { echo "找不到 bun"; exit 1; }
  command -v systemctl >/dev/null || { echo "此系统无 systemd，请改用 ./start.sh"; exit 1; }

  [ -d "$REPO/node_modules" ] || (cd "$REPO" && bun install)
  echo "构建前端…"
  (cd "$REPO" && bun run build >/dev/null)

  mkdir -p "$UNIT_DIR" "$LOG_DIR"
  # 安装到 systemd 用户目录。用复制而非软链，避免 repo 移动后服务失效。
  sed "s|%h/wikified-cockpit|$REPO|g" "$REPO/$UNIT_NAME" > "$UNIT_DIR/$UNIT_NAME"

  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME"

  sleep 2
  if systemctl --user is-active --quiet "$UNIT_NAME"; then
    PORT=$(grep -oP 'COCKPIT_PORT=\K[0-9]+' "$UNIT_DIR/$UNIT_NAME" || echo 4177)
    echo
    echo "  ✓ Cockpit 已作为 systemd 服务常驻运行"
    echo "  ├─ 浏览器访问   http://localhost:$PORT"
    echo "  ├─ 开机自启     已启用（enable）"
    echo "  ├─ 崩溃自动重启 已启用（Restart=on-failure）"
    echo "  ├─ 日志         $LOG_DIR/server.log"
    echo "  └─ 状态         systemctl --user status $UNIT_NAME"
    echo
    # 退出登录后仍保持运行需要 linger；不静默替用户改系统状态，只提示。
    if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || echo no)" != "yes" ]; then
      echo "  提示：退出所有登录会话后服务会停止。要让它始终常驻，执行一次："
      echo "        sudo loginctl enable-linger $USER"
      echo
    fi
  else
    echo "启动失败，最近日志："
    systemctl --user status "$UNIT_NAME" --no-pager -l | tail -20
    exit 1
  fi
}

cmd_uninstall() {
  systemctl --user disable --now "$UNIT_NAME" 2>/dev/null || true
  rm -f "$UNIT_DIR/$UNIT_NAME"
  systemctl --user daemon-reload
  echo "已移除服务（代码保留在 $REPO）"
}

case "${1:-install}" in
  install) cmd_install ;;
  uninstall) cmd_uninstall ;;
  status) systemctl --user status "$UNIT_NAME" --no-pager -l ;;
  logs) tail -f "$LOG_DIR/server.log" ;;
  -h | --help | help) usage ;;
  *) usage; exit 1 ;;
esac
