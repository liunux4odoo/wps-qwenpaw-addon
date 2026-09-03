#!/bin/bash
# Noop script for wps-office-mcp on Linux.
#
# 原因：WPS-qwenpaw-addon 部署下，WPS 由用户手动管理。
# wps-mcp 的强制应用切换会 pkill 强杀用户已打开的 WPS，破坏工作流。
#
# 见 docs/ARCHITECTURE.md §12.1 完整根因分析 + §12.2 D++ 方案。
#
# 长期方案：wps-mcp issue（ISSUE-20260903-01）合并后切回标准部署。
# 切换步骤见 docs/ARCHITECTURE.md §12.2.2。

# 接收 wps-mcp 传入的参数：switch <app> / start <app> 等
# 不做任何操作，直接返回成功（exit 0）
# wps-mcp 会认为切换成功，currentApp 被赋值为目标 app，
# 后续同类型命令不再触发切换。

case "$1" in
    switch|start)
        # 假成功：啥也不做
        exit 0
        ;;
    *)
        # 未知命令：打印日志便于调试，仍然返回 0
        echo "noop: $*" >&2
        exit 0
        ;;
esac
