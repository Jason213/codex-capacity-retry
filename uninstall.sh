#!/bin/bash
# codex-capacity-retry 卸载脚本
# 恢复 codex 原生直连、停止并移除 launchd 服务、删除代理文件与切换脚本
set -euo pipefail

CONFIG="$HOME/.codex/config.toml"
DEST="$HOME/.codex/capacity-retry-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/com.codex.capacity-retry-proxy.plist"
SERVICE="gui/$(id -u)/com.codex.capacity-retry-proxy"

echo "==> 恢复 codex 原生直连配置"
if [ -f "$CONFIG" ]; then
  cp "$CONFIG" "${CONFIG}.bak-uninstall-$(date +%Y%m%d%H%M%S)"
  python3 - "$CONFIG" <<'EOF'
import sys, pathlib, re
p = pathlib.Path(sys.argv[1])
s = p.read_text()
# 移除顶层 model_provider 设置与整个代理 provider 定义段
s = re.sub(r'(?m)^\s*#?\s*model_provider\s*=\s*"openai-proxy"\s*\n', '', s)
s = re.sub(
    r'(?ms)^\[model_providers\.openai-proxy\]\n.*?(?=^\[|\Z)',
    '',
    s,
)
p.write_text(s.lstrip('\n'))
EOF
fi

echo "==> 停止并移除 launchd 服务"
if [ "${SKIP_LAUNCHCTL:-0}" != "1" ]; then
  launchctl bootout "$SERVICE" 2>/dev/null || true
  launchctl disable "$SERVICE" 2>/dev/null || true
fi
rm -f "$PLIST_PATH"

echo "==> 删除代理程序与日志"
rm -rf "$DEST"

echo "==> 删除切换脚本"
rm -f "$HOME/.local/bin/cx_proxy" "$HOME/.local/bin/cx_office"

echo "✅ 卸载完成。codex 已恢复原生直连（config.toml 有卸载前备份）"
