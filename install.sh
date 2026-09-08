#!/bin/bash
# codex-capacity-retry 安装脚本 (macOS)
# 安装内容:
#   1. ~/.codex/capacity-retry-proxy/proxy.mjs   代理程序
#   2. ~/Library/LaunchAgents/...plist           launchd 常驻服务(开机自启)
#   3. ~/.codex/config.toml                      切换 codex 到代理模式(自动备份)
#   4. ~/.local/bin/cx_proxy / cx_office         模式切换脚本
set -euo pipefail

SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.codex/capacity-retry-proxy"
PLIST_PATH="$HOME/Library/LaunchAgents/com.codex.capacity-retry-proxy.plist"
SERVICE="gui/$(id -u)/com.codex.capacity-retry-proxy"
PORT="${CODEX_RETRY_PORT:-8317}"
SKIP_LAUNCHD="${SKIP_LAUNCHD:-0}"

echo "==> codex-capacity-retry 安装"

# ---- 前置检查 -------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "❌ 未找到 node (需要 Node.js >= 18)，请先安装: https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "❌ Node 版本过低 (当前 $(node -v)，需要 >= 18)" >&2
  exit 1
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ 未找到 python3" >&2
  exit 1
fi
if [ ! -f "$HOME/.codex/auth.json" ]; then
  echo "⚠️  未检测到 ~/.codex/auth.json，请先运行 codex 并完成 ChatGPT 登录，否则代理模式无法使用"
fi

# 端口被占用时(非本工具服务)提示更换
if curl -s --max-time 1 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then
  if ! launchctl print "$SERVICE" >/dev/null 2>&1; then
    echo "❌ 端口 ${PORT} 已被其他程序占用，请换一个端口重新运行:" >&2
    echo "   CODEX_RETRY_PORT=8318 ./install.sh" >&2
    exit 1
  fi
  echo "==> 检测到旧版本服务在运行，将重启升级"
fi

# ---- 安装文件 -------------------------------------------------------------
echo "==> 安装代理程序到 ${DEST}"
mkdir -p "$DEST"
cp "$SRC_DIR/proxy.mjs" "$DEST/proxy.mjs"
echo "$PORT" > "$DEST/port"

# 解析 node 真实路径(跳过 nvm/mise 等 shim，launchd 环境没有用户 PATH)
NODE_BIN="$(node -p 'process.execPath')"

# 网络代理: 若安装时 shell 里有 http(s)_proxy 则写入服务(如中国大陆本地代理场景)
PROXY_ENV_HTTPS="${https_proxy:-${HTTPS_PROXY:-}}"
PROXY_ENV_HTTP="${http_proxy:-${HTTP_PROXY:-}}"
PROXY_ENV_BLOCK=""
if [ -n "$PROXY_ENV_HTTPS" ] || [ -n "$PROXY_ENV_HTTP" ]; then
  echo "==> 检测到系统代理，代理服务将通过其访问 chatgpt.com (https_proxy=${PROXY_ENV_HTTPS:-$PROXY_ENV_HTTP})"
  PROXY_ENV_BLOCK="    <key>NODE_USE_ENV_PROXY</key>
    <string>1</string>
    <key>https_proxy</key>
    <string>${PROXY_ENV_HTTPS:-$PROXY_ENV_HTTP}</string>
    <key>http_proxy</key>
    <string>${PROXY_ENV_HTTP:-$PROXY_ENV_HTTPS}</string>"
fi

echo "==> 生成 launchd 服务配置"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST_PATH" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.codex.capacity-retry-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${DEST}/proxy.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>${PORT}</string>
${PROXY_ENV_BLOCK}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DEST}/proxy.log</string>
  <key>StandardErrorPath</key>
  <string>${DEST}/proxy.log</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
EOF

if [ "$SKIP_LAUNCHD" != "1" ]; then
  echo "==> 启动 launchd 服务"
  launchctl bootout "$SERVICE" 2>/dev/null || true
  launchctl enable "$SERVICE" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"
  # 等待端口就绪
  ok=0
  for _ in $(seq 1 20); do
    if curl -s --max-time 1 -o /dev/null "http://127.0.0.1:${PORT}/" 2>/dev/null; then ok=1; break; fi
    sleep 0.5
  done
  if [ "$ok" != "1" ]; then
    echo "❌ 代理服务启动失败，请查看日志: tail -20 ${DEST}/proxy.log" >&2
    exit 1
  fi
fi

# ---- 修改 codex 配置 -------------------------------------------------------
CONFIG="$HOME/.codex/config.toml"
if [ -f "$CONFIG" ]; then
  BACKUP="${CONFIG}.bak-$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG" "$BACKUP"
  echo "==> 已备份 codex 配置到 ${BACKUP}"
fi

echo "==> 切换 codex 到代理模式"
if [ "$SKIP_LAUNCHD" = "1" ]; then
  SKIP_LAUNCHCTL=1 bash "$SRC_DIR/bin/cx_proxy"
else
  bash "$SRC_DIR/bin/cx_proxy"
fi

# ---- 安装切换脚本 ---------------------------------------------------------
BIN_DIR="$HOME/.local/bin"
if [ -d "$BIN_DIR" ] || mkdir -p "$BIN_DIR" 2>/dev/null; then
  cp "$SRC_DIR/bin/cx_proxy" "$SRC_DIR/bin/cx_office" "$BIN_DIR/"
  chmod +x "$BIN_DIR/cx_proxy" "$BIN_DIR/cx_office"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) echo "⚠️  ${BIN_DIR} 不在 PATH 中，请把它加入 shell 配置后才能直接使用 cx_proxy / cx_office" ;;
  esac
else
  echo "⚠️  无法写入 ${BIN_DIR}，跳过安装切换脚本（可直接运行 $SRC_DIR/bin/cx_proxy）"
fi

echo
echo "✅ 安装完成！codex 的模型请求现在经过本地重试代理 (127.0.0.1:${PORT})"
echo "   - 查看日志: tail -f ${DEST}/proxy.log"
echo "   - 切回原生直连: cx_office    切回代理模式: cx_proxy"
echo "   - 注意: 已在运行的 codex 会话需重启后才会走代理"
[ "$SKIP_LAUNCHD" = "1" ] && echo "   (SKIP_LAUNCHD=1: 本次未启动服务，仅生成了文件)"
