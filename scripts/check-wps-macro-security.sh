#!/usr/bin/env bash
# =============================================================================
# check-wps-macro-security.sh — WPS 宏安全性检查/调整（插件加载必需）
#
# 背景（实机验证结论 2026-09-03）：WPS 宏安全性未调到最低时，jsaddon 加载项
# 不加载（功能区不出现「QwenPaw AI」标签/侧边栏空白）。
# 最低 = wps/wpp 的 VbaSecurityLevel 与 et 的 KDESecurityLevel 均为 1。
#
# 用法：
#   ./scripts/check-wps-macro-security.sh            # 只检查并报告当前级别
#   ./scripts/check-wps-macro-security.sh --apply    # 检查 + 自动调到最低（需先关闭 WPS）
#
# 注意：WPS 重启时会重写 Office.conf，因此 --apply 前必须完全关闭 WPS，
# 否则修改会被覆盖。
# =============================================================================
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WPS_CONF="${WPS_CONF:-$HOME/.config/Kingsoft/Office.conf}"
APPLY=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    *) echo "未知参数: $arg" >&2; exit 1 ;;
  esac
done

ok()   { printf '  \033[1;32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[1;33m⚠\033[0m %s\n' "$*"; }

if [ ! -f "$WPS_CONF" ]; then
  echo "未找到 $WPS_CONF（WPS 尚未启动过？）。"
  echo "请先启动一次 WPS 生成配置，再运行本脚本或按 docs/INSTALL.md 手动设置。"
  exit 1
fi

# 读取当前宏安全级别（无该键时 grep 返回非零，|| true 兜底）
wps_sec="$(grep -F 'wps\Application%20Settings\VbaSecurityLevel=' "$WPS_CONF" | head -1 | cut -d= -f2 || true)"
wpp_sec="$(grep -F 'wpp\Application%20Settings\VbaSecurityLevel=' "$WPS_CONF" | head -1 | cut -d= -f2 || true)"
et_sec="$(grep -F 'et\Application%20Settings\KDESecurityLevel=' "$WPS_CONF" | head -1 | cut -d= -f2 || true)"

need_fix=0
check_one() {
  local app="$1" val="$2"
  if [ -z "$val" ]; then
    warn "$app: 未找到宏安全级别配置（可先打开一次该应用文档再设置）"
    need_fix=1
  elif [ "$val" = "1" ]; then
    ok "$app: 宏安全性 = $val（最低，OK）"
  else
    warn "$app: 宏安全性 = $val（非最低，插件可能不加载）"
    need_fix=1
  fi
}

echo "WPS 配置: $WPS_CONF"
check_one "wps" "$wps_sec"
check_one "wpp" "$wpp_sec"
check_one "et"  "$et_sec"

if [ "$need_fix" = "0" ]; then
  echo "宏安全性已全部为最低，无需调整。"
  exit 0
fi

if [ "$APPLY" != "1" ]; then
  echo
  echo "存在非最低项。可运行："
  echo "  $0 --apply"
  echo "（--apply 前必须完全关闭 WPS，否则修改会被 WPS 重启覆盖）"
  echo "或在 WPS 界面设置：文件 → 选项 → 安全 → 宏安全性 → 低（允许所有宏），三个应用都要设。"
  exit 2
fi

# ── 自动调整（需 WPS 已关闭） ─────────────────────────────
# 只按进程名精确匹配 WPS 主程序（wps/et/wpp/wpsoffice），不匹配其它含该子串的系统进程
if pgrep -l -i -x 'wps|et|wpp|wpsoffice' >/dev/null 2>&1; then
  echo
  echo "检测到 WPS 相关进程正在运行："
  pgrep -a -i -x 'wps|et|wpp|wpsoffice' 2>/dev/null | head -10
  echo "请先完全退出 WPS，再重新运行：$0 --apply"
  exit 3
fi

cp "$WPS_CONF" "$WPS_CONF.bak-macrosecurity-$(date +%Y%m%d%H%M%S)"
sed -i 's/\(^wps\\Application%20Settings\\VbaSecurityLevel=\).*/\11/' "$WPS_CONF"
sed -i 's/\(^wpp\\Application%20Settings\\VbaSecurityLevel=\).*/\11/' "$WPS_CONF"
sed -i 's/\(^et\\Application%20Settings\\KDESecurityLevel=\).*/\11/' "$WPS_CONF"

# 应用后验证：sed 只替换已存在的行，键缺失时静默 no-op——必须复查，防止误报成功
apply_failed=0
verify_one() {
  local app="$1" key="$2"
  local now
  now="$(grep -F "$key=" "$WPS_CONF" | head -1 | cut -d= -f2 || true)"
  if [ "$now" != "1" ]; then
    warn "$app: 设置后仍非最低（当前='${now:-缺失}'）。请先打开一次 $app 生成配置，再重试。"
    apply_failed=1
  fi
}
verify_one "wps" 'wps\Application%20Settings\VbaSecurityLevel'
verify_one "wpp" 'wpp\Application%20Settings\VbaSecurityLevel'
verify_one "et"  'et\Application%20Settings\KDESecurityLevel'

if [ "$apply_failed" = "1" ]; then
  echo "⚠ 宏安全性未全部设置成功，请先打开 WPS 对应应用生成配置后重试。"
  echo "  备份: $WPS_CONF.bak-macrosecurity-*"
  exit 4
fi

echo
echo "已调整 wps/wpp 的 VbaSecurityLevel 与 et 的 KDESecurityLevel 为 1（最低）。"
echo "备份: $WPS_CONF.bak-macrosecurity-*"
echo "请启动 WPS，功能区出现「QwenPaw AI」标签即加载成功。"
