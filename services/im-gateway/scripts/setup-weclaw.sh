#!/usr/bin/env bash
#
# Super Agent - 微信 ClawBot 接入安装脚本 (WeClaw)
#
# 自动安装 WeClaw 桥接工具，配置连接到 Super Agent IM 网关，
# 启动服务并提示用户扫码绑定微信 ClawBot。
#
# 前置条件:
#   - 微信已安装 ClawBot 插件
#   - Node.js 18+ 环境
#   - Super Agent IM 网关已启动 (默认 :8642)
#
# 用法: bash setup-weclaw.sh [--gateway-url URL] [--api-key KEY] [--skip-install]

set -euo pipefail

# ── 参数解析 ──────────────────────────────────────────────
GATEWAY_URL="${GATEWAY_URL:-http://localhost:8642}"
API_KEY=""
SKIP_INSTALL=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --gateway-url) GATEWAY_URL="$2"; shift 2 ;;
    --api-key)     API_KEY="$2"; shift 2 ;;
    --skip-install) SKIP_INSTALL=true; shift ;;
    *) echo "未知参数: $1"; exit 1 ;;
  esac
done

# ── 辅助函数 ──────────────────────────────────────────────
step()  { printf "\n\033[36m==> %s\033[0m\n" "$1"; }
ok()    { printf "  \033[32m[OK]\033[0m %s\n" "$1"; }
warn()  { printf "  \033[33m[!]\033[0m %s\n"  "$1"; }
fail()  { printf "  \033[31m[X]\033[0m %s\n"  "$1"; }

echo ""
echo -e "\033[35m========================================\033[0m"
echo -e "\033[35m  Super Agent - WeChat ClawBot Setup\033[0m"
echo -e "\033[35m========================================\033[0m"
echo ""

# ── Step 1: 检测 Node.js ─────────────────────────────────
step "检测 Node.js 环境"
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
  if [ "$MAJOR" -ge 18 ]; then
    ok "Node.js $NODE_VER (>= 18)"
  else
    fail "Node.js 版本过低 ($NODE_VER)，需要 18+"
    exit 1
  fi
else
  fail "未找到 Node.js，请先安装 Node.js 18+ (https://nodejs.org)"
  exit 1
fi

# ── Step 2: 检测 IM 网关连通性 ────────────────────────────
step "检测 IM Gateway 连通性"
if command -v curl &>/dev/null; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$GATEWAY_URL/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "IM Gateway 在线 ($GATEWAY_URL)"
  else
    fail "无法连接 IM Gateway ($GATEWAY_URL) [HTTP $HTTP_CODE]"
    echo "  请先启动 IM 网关: cd services/im-gateway && python server.py"
    exit 1
  fi
else
  warn "未找到 curl，跳过网关连通性检测"
fi

# ── Step 3: 安装 WeClaw ──────────────────────────────────
if [ "$SKIP_INSTALL" = false ]; then
  step "安装 WeClaw 桥接工具"

  if command -v weclaw &>/dev/null; then
    WECLAW_VER=$(weclaw --version 2>&1 || echo "unknown")
    ok "WeClaw 已安装 ($WECLAW_VER)"
  else
    echo "  正在下载并安装 WeClaw..."

    # 检测操作系统和架构
    OS=$(uname -s | tr '[:upper:]' '[:lower:]')
    ARCH=$(uname -m)
    case "$ARCH" in
      x86_64)  ARCH="amd64" ;;
      aarch64|arm64) ARCH="arm64" ;;
      *) fail "不支持的架构: $ARCH"; exit 1 ;;
    esac

    INSTALL_URL="https://github.com/fastclaw-ai/weclaw/releases/latest/download/weclaw-${OS}-${ARCH}"
    INSTALL_DIR="${HOME}/.local/bin"
    mkdir -p "$INSTALL_DIR"

    if curl -fSL "$INSTALL_URL" -o "$INSTALL_DIR/weclaw" 2>/dev/null; then
      chmod +x "$INSTALL_DIR/weclaw"
      ok "WeClaw 已安装到 $INSTALL_DIR/weclaw"

      # 检查 PATH
      if [[ ":$PATH:" != *":$INSTALL_DIR:"* ]]; then
        warn "请将 $INSTALL_DIR 添加到 PATH:"
        echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
        export PATH="$INSTALL_DIR:$PATH"
      fi
    else
      warn "自动安装失败，请手动安装 WeClaw"
      echo "  参考: https://github.com/fastclaw-ai/weclaw"
    fi
  fi
fi

# ── Step 4: 生成配置文件 ─────────────────────────────────
step "生成 WeClaw 配置文件"
CONFIG_DIR="$HOME/.weclaw"
CONFIG_PATH="$CONFIG_DIR/config.json"
mkdir -p "$CONFIG_DIR"

# 构建 headers JSON
if [ -n "$API_KEY" ]; then
  HEADERS_JSON="{\"X-API-Key\": \"$API_KEY\"}"
else
  HEADERS_JSON="{}"
fi

cat > "$CONFIG_PATH" <<EOF
{
  "agents": {
    "super-agent": {
      "type": "http",
      "endpoint": "${GATEWAY_URL}/weclaw/chat",
      "headers": ${HEADERS_JSON},
      "default": true
    }
  }
}
EOF

ok "配置已写入 $CONFIG_PATH"
echo "  endpoint: ${GATEWAY_URL}/weclaw/chat"

# ── Step 5: 启动提示 ─────────────────────────────────────
step "启动 WeClaw"
echo ""
echo -e "  \033[33m请执行以下命令启动 WeClaw 并扫码绑定微信:\033[0m"
echo ""
echo "    weclaw start"
echo ""
echo "  启动后:"
echo "    1. 用微信扫描终端显示的二维码"
echo "    2. 在微信 ClawBot 插件中确认绑定"
echo "    3. 发送消息测试 (例: '你好')"
echo ""

# ── Step 6: 验证连通性 ──────────────────────────────────
step "验证 WeClaw 端点"
if command -v curl &>/dev/null; then
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --connect-timeout 5 "$GATEWAY_URL/weclaw/status" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    ok "WeClaw 端点正常 (/weclaw/status)"
  else
    warn "WeClaw 端点暂不可达 (可能需要先启动 weclaw start)"
  fi
fi

echo ""
echo -e "\033[32m========================================\033[0m"
echo -e "\033[32m  安装完成!\033[0m"
echo -e "\033[32m========================================\033[0m"
echo ""
echo "  常用命令:"
echo "    weclaw start     - 启动 WeClaw (前台运行)"
echo "    weclaw start -d  - 后台启动"
echo "    weclaw status    - 查看运行状态"
echo "    weclaw stop      - 停止服务"
echo ""
