#!/usr/bin/env bash
# =============================================================================
# install.sh — WPS-QwenPaw 加载项一键安装/配置脚本
#
# 完成：
#   1. 环境自检（git / node / npm / python3 / qwenpaw / WPS）
#   2. submodule 初始化（third_party/opencode-wps）
#   3. 构建 wps-office-mcp（npm install + npm run build）
#   4. 打 POLL_PORT 补丁 + 重建（幂等，路线 P 必需）
#   5. 部署 noop 脚本（防 WPS 被强杀）
#   6. 同步加载项文件到 WPS jsaddons 目录
#   7. 启动 acp-bridge 并自检
#
# 用法：
#   ./scripts/install.sh              # 完整安装
#   ./scripts/install.sh --skip-bridge  # 不启动 bridge（只装文件）
#   ./scripts/install.sh --bridge-only   # 只启动 bridge
#
# 说明见 docs/INSTALL.md
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── 可配置项（可用环境变量覆盖）──────────────────────────────
PYTHON="${PYTHON:-python3}"                      # acp-bridge 解释器（建议 py312）
BRIDGE_HTTP_PORT="${BRIDGE_HTTP_PORT:-8766}"
BRIDGE_WS_PORT="${BRIDGE_WS_PORT:-8765}"
BRIDGE_AGENT="${BRIDGE_AGENT:-default}"
WPS_ADDON_DIR="${WPS_ADDON_DIR:-$HOME/.local/share/Kingsoft/wps/jsaddons/wps-qwenpaw-addon_}"
WPS_MCP_DIR="$REPO_ROOT/third_party/opencode-wps/wps-office-mcp"
WPS_AUTO_SH="$REPO_ROOT/third_party/opencode-wps/opencode-wps-linux/wps-auto.sh"

BRIDGE_ONLY=0
SKIP_BRIDGE=0

for arg in "$@"; do
  case "$arg" in
    --bridge-only) BRIDGE_ONLY=1 ;;
    --skip-bridge) SKIP_BRIDGE=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

# ── 工具函数 ───────────────────────────────────────────────
say()  { printf '\033[1;36m[install]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m  ✔\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m  ⚠\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m  ✘ %s\033[0m\n' "$*"; exit 1; }

require_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    ok "$1: $(command -v "$1")"
  else
    fail "缺少命令: $1（请先安装 $2）"
  fi
}

# ── 环境自检 ──────────────────────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== 环境自检 =="
  require_cmd git "git"
  require_cmd node "Node.js >= 18"
  require_cmd npm "npm"
  require_cmd "$PYTHON" "Python 3.12"
  command -v qwenpaw >/dev/null 2>&1 || warn "PATH 中未找到 qwenpaw（若装在 conda 环境请先激活，或设置 PYTHON 指向该环境解释器）"
fi

# ── 2. submodule 初始化 ────────────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== 初始化 submodule (third_party/opencode-wps) =="
  if [ -d "$WPS_MCP_DIR/.git" ] || [ -f "$WPS_MCP_DIR/package.json" ]; then
    ok "submodule 已就绪"
  else
    git submodule update --init --recursive
    ok "submodule 已初始化"
  fi
fi

# ── 3. 构建 wps-office-mcp ─────────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== 构建 wps-office-mcp =="
  if [ ! -f "$WPS_MCP_DIR/package.json" ]; then
    fail "未找到 $WPS_MCP_DIR/package.json（submodule 初始化失败？）"
  fi
  if [ ! -d "$WPS_MCP_DIR/node_modules" ]; then
    say "  npm install ..."
    ( cd "$WPS_MCP_DIR" && npm install )
  else
    ok "node_modules 已存在，跳过 npm install"
  fi
  say "  npm run build ..."
  ( cd "$WPS_MCP_DIR" && npm run build )
  [ -f "$WPS_MCP_DIR/dist/index.js" ] && ok "dist/index.js 已生成" || fail "构建失败：未生成 dist/index.js"
fi

# ── 4. POLL_PORT 补丁（幂等） ──────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== POLL_PORT 补丁（路线 P） =="
  WPS_CLIENT="$WPS_MCP_DIR/src/client/wps-client.ts"
  if grep -q 'process.env.WPS_POLL_PORT' "$WPS_CLIENT" 2>/dev/null; then
    ok "补丁已存在，跳过"
  else
    sed -i 's/const POLL_PORT = 58891;/const POLL_PORT = Number(process.env.WPS_POLL_PORT) || 58891;/' "$WPS_CLIENT"
    ok "补丁已应用，rebuild ..."
    ( cd "$WPS_MCP_DIR" && npm run build )
  fi
fi

# ── 5. noop 脚本部署 ───────────────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== noop 脚本部署（防 WPS 强杀） =="
  if [ -f "$WPS_AUTO_SH" ]; then
    if grep -q "noop" "$WPS_AUTO_SH" 2>/dev/null; then
      ok "noop 已部署"
    else
      cp "$REPO_ROOT/scripts/wps-auto-noop.sh" "$WPS_AUTO_SH"
      chmod +x "$WPS_AUTO_SH"
      ok "已替换 $WPS_AUTO_SH 为 noop 脚本"
    fi
  else
    warn "未找到 $WPS_AUTO_SH（跳过 noop 部署）"
  fi
fi

# ── 6. 同步加载项到 WPS ────────────────────────────────────
if [ "$BRIDGE_ONLY" -eq 0 ]; then
  say "== 同步加载项到 WPS =="
  mkdir -p "$WPS_ADDON_DIR"
  for f in manifest.xml ribbon.xml index.html taskpane.html; do
    cp "$REPO_ROOT/$f" "$WPS_ADDON_DIR/"
  done
  cp -r "$REPO_ROOT/css" "$REPO_ROOT/js" "$WPS_ADDON_DIR/"
  ok "已同步到 $WPS_ADDON_DIR"
  warn "请完全重启 WPS（关闭所有窗口后重开），加载项才会重新加载"
fi

# ── 7. 启动 acp-bridge ─────────────────────────────────────
if [ "$SKIP_BRIDGE" -eq 0 ]; then
  say "== 启动 acp-bridge =="
  # 端口占用检查
  if ss -tln 2>/dev/null | grep -q ":${BRIDGE_HTTP_PORT} "; then
    ok "bridge 已在运行（HTTP :${BRIDGE_HTTP_PORT}）"
  else
    # 后台启动（日志到 /tmp）
    LOG_FILE="/tmp/acp-bridge.log"
    nohup "$PYTHON" "$REPO_ROOT/bridge/acp-bridge.py" \
      --http-port "$BRIDGE_HTTP_PORT" --port "$BRIDGE_WS_PORT" \
      --agent "$BRIDGE_AGENT" --log-file "$LOG_FILE" > /dev/null 2>&1 &
    echo "  bridge 后台启动 pid=$!（日志: $LOG_FILE）"
    # 等待就绪
    for i in $(seq 1 15); do
      if ss -tln 2>/dev/null | grep -q ":${BRIDGE_HTTP_PORT} "; then
        ok "bridge 就绪: http://127.0.0.1:${BRIDGE_HTTP_PORT}"
        break
      fi
      sleep 1
    done
  fi

  # 自检
  say "== 自检 =="
  curl -s "http://127.0.0.1:${BRIDGE_HTTP_PORT}/status" && echo
  curl -s "http://127.0.0.1:${BRIDGE_HTTP_PORT}/config" && echo
  WPS_ENTRY="$(curl -s "http://127.0.0.1:${BRIDGE_HTTP_PORT}/config" | sed -n 's/.*"wpsMcpEntry": "\([^"]*\)".*/\1/p')"
  if [ -n "$WPS_ENTRY" ] && [ -f "$WPS_ENTRY" ]; then
    ok "wpsMcpEntry 存在: $WPS_ENTRY"
  else
    warn "wpsMcpEntry 文件不存在: $WPS_ENTRY（wps-office-mcp 未构建？）"
  fi
fi

say "== 完成 =="
echo
echo "  1. 启动 WPS 并打开一个文档"
echo "  2. 功能区点击「QwenPaw AI」→「AI 侧边栏」"
echo "  3. 输入指令（如：把第三段润色一下）"
echo
echo "  常用命令："
echo "    ${PYTHON} ${REPO_ROOT}/bridge/acp-bridge.py --agent ${BRIDGE_AGENT}   # 手动前台启动 bridge"
echo "    tail -f /tmp/acp-bridge.log                                            # bridge 日志"
echo "    curl -s http://127.0.0.1:${BRIDGE_HTTP_PORT}/status                    # 状态"
