#!/bin/bash
# start-wps-mcp-http.sh — 启动/停止 wps-office-mcp 的 http 常驻模式（ARCHITECTURE §5.1.1 / §13）
#
# 背景：v0.16 决策 wps MCP 从 stdio 迁移到 streamable http。
#   stdio 模式 qwenpaw 每 session spawn 一个 wps-mcp 子进程，acp 异常路径不清理导致孤儿残留；
#   http 模式 qwenpaw 只连固定 URL（不 spawn 进程），残留从机制上消失。
#
# 用法：
#   scripts/start-wps-mcp-http.sh start   # 后台启动（端口 18765）
#   scripts/start-wps-mcp-http.sh stop    # 停止
#   scripts/start-wps-mcp-http.sh status  # 查看状态
#
# 端口：18765（避免与 acp-bridge :8766/:8765、:58891 冲突，§5.1.1）
set -euo pipefail

PORT="${WPS_MCP_HTTP_PORT:-18765}"
HOST="${WPS_MCP_HTTP_HOST:-127.0.0.1}"
LOG_FILE="${WPS_MCP_HTTP_LOG:-/tmp/wps-mcp-http.log}"
WPS_MCP_ENTRY="/data/myrepo/opencode-wps/wps-office-mcp/dist/index-http.js"

cmd="${1:-status}"

case "$cmd" in
  start)
    if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
      echo "wps-mcp http server 已在运行 (http://${HOST}:${PORT}/mcp)"
      exit 0
    fi
    if [ ! -f "$WPS_MCP_ENTRY" ]; then
      echo "错误：未找到 $WPS_MCP_ENTRY，请先在 wps-office-mcp 仓库执行 npm run build" >&2
      exit 1
    fi
    nohup node "$WPS_MCP_ENTRY" --port "$PORT" --host "$HOST" > "$LOG_FILE" 2>&1 &
    echo "已后台启动 wps-mcp http server (pid=$!)"
    echo "日志: $LOG_FILE"
    echo "等待就绪..."
    for i in $(seq 1 15); do
      if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
        echo "就绪: http://${HOST}:${PORT}/mcp"
        exit 0
      fi
      sleep 1
    done
    echo "警告：${PORT} 端口未在 15s 内就绪，查看日志 $LOG_FILE" >&2
    exit 1
    ;;
  stop)
    pkill -f "index-http.js --port ${PORT}" 2>/dev/null || true
    echo "已停止 wps-mcp http server"
    ;;
  status)
    if ss -tln 2>/dev/null | grep -q ":${PORT} "; then
      echo "运行中: http://${HOST}:${PORT}/mcp"
      pgrep -af "index-http.js" | grep -v bash || true
    else
      echo "未运行"
    fi
    ;;
  *)
    echo "用法: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
