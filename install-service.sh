#!/usr/bin/env bash
# 把 Cockpit 装成 systemd user service：开机自启、常驻、静默、崩溃自动重启。
# 装完就不用再手动 ./start.sh，也不占 tmux session。
set -euo pipefail

REPO=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
UNIT_NAME=wikified-cockpit.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/wikified-cockpit"

resolve_bun() {
  if command -v bun >/dev/null 2>&1; then
    command -v bun
    return 0
  fi
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    printf '%s\n' "$HOME/.bun/bin/bun"
    return 0
  fi
  return 1
}

sed_replacement() {
  printf '%s' "$1" | sed 's/[&|\\]/\\&/g'
}

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
  local bun_bin
  bun_bin=$(resolve_bun) || {
    echo "找不到 bun。安装：curl -fsSL https://bun.sh/install | bash"
    exit 1
  }
  if ! command -v systemctl >/dev/null; then
    cat <<'EOM'
此系统没有 systemd（macOS 或精简容器），无法装成 systemd 服务。

替代方案：
  · 临时前台跑：      ./start.sh
  · 后台跑（通用）：   nohup ./start.sh > cockpit.log 2>&1 &
  · macOS 常驻：       用 launchd，把 start.sh 包成 ~/Library/LaunchAgents 里的 plist

功能完全一样，只是少了开机自启和崩溃自愈。
EOM
    exit 1
  fi

  [ -d "$REPO/node_modules" ] || (cd "$REPO" && "$bun_bin" install)
  echo "构建前端…"
  (cd "$REPO" && "$bun_bin" run build >/dev/null)

  # 数据根不存在就别装——服务必然起不来，且此处的报错比服务日志清楚得多。
  # 这个检查必须在动既有 unit 之前，否则重装失败会毁掉用户已装好的服务。
  ROOT_CHECK="${LLM_WIKI_ROOT:-$HOME/llm-wiki}"
  if [ ! -d "$ROOT_CHECK" ]; then
    echo
    echo "找不到 Wikified 数据目录：$ROOT_CHECK"
    echo "  · 已装 Wikified 但路径不同：LLM_WIKI_ROOT=/你的/路径 ./install-service.sh"
    echo "  · 还没装：见 https://github.com/zhangyu0806/wikified"
    exit 1
  fi

  mkdir -p "$UNIT_DIR" "$LOG_DIR"
  # 先写临时文件、装配完再原子替换，避免中途失败留下半成品 unit。
  TMP_UNIT=$(mktemp "$UNIT_DIR/.$UNIT_NAME.XXXXXX")
  repo_sed=$(sed_replacement "$REPO")
  bun_sed=$(sed_replacement "$bun_bin")
  sed -e "s|@REPO@|$repo_sed|g" -e "s|@BUN_BIN@|$bun_sed|g" \
    "$REPO/$UNIT_NAME" > "$TMP_UNIT"

  # 安装时的 LLM_WIKI_ROOT / COCKPIT_PORT 要写进 unit，否则服务起来读不到自定义位置。
  if [ -n "${LLM_WIKI_ROOT:-}" ]; then
    sed -i "/^Environment=COCKPIT_PORT/a Environment=LLM_WIKI_ROOT=$LLM_WIKI_ROOT" "$TMP_UNIT"
    echo "数据根：$LLM_WIKI_ROOT"
  fi
  if [ -n "${COCKPIT_PORT:-}" ]; then
    sed -i "s|^Environment=COCKPIT_PORT=.*|Environment=COCKPIT_PORT=$COCKPIT_PORT|" "$TMP_UNIT"
  fi
  mv "$TMP_UNIT" "$UNIT_DIR/$UNIT_NAME"

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
