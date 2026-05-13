#!/usr/bin/env bash
# ============================================================
#  Super Agent 生产环境一键启动脚本 (Linux / macOS)
#  自动检查/安装 PM2，构建项目，启动服务，配置开机自启
# ============================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

print_banner() {
  echo ""
  echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}  ║     Super Agent 生产模式一键启动         ║${NC}"
  echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
  echo ""
}

# 子命令处理
case "${1:-}" in
  stop)
    echo "停止所有服务..."
    pm2 stop ecosystem.config.cjs
    pm2 save
    echo -e "${GREEN}已停止${NC}"
    exit 0
    ;;
  restart)
    echo "重启所有服务..."
    pm2 restart ecosystem.config.cjs
    echo -e "${GREEN}已重启${NC}"
    exit 0
    ;;
  status)
    pm2 status
    exit 0
    ;;
  logs)
    echo "查看日志 (Ctrl+C 退出)..."
    pm2 logs
    exit 0
    ;;
  save)
    pm2 save
    echo -e "${GREEN}进程列表已保存${NC}"
    exit 0
    ;;
  help|--help|-h)
    echo ""
    echo "  Super Agent 生产环境管理脚本"
    echo ""
    echo "  用法: ./start.sh [命令]"
    echo ""
    echo "  命令:"
    echo "    (无参数)  一键启动所有服务"
    echo "    status    查看服务运行状态"
    echo "    logs      实时查看日志"
    echo "    restart   重启所有服务"
    echo "    stop      停止所有服务"
    echo "    save      保存当前进程列表"
    echo "    help      显示此帮助"
    echo ""
    exit 0
    ;;
esac

print_banner

# [1/3] 检查 PM2
echo -e "${YELLOW}[1/3] 检查 PM2...${NC}"
if ! command -v pm2 &> /dev/null; then
  echo "   PM2 未安装，正在安装..."
  npm i -g pm2
  if [ $? -ne 0 ]; then
    echo -e "${RED}   [错误] PM2 安装失败，请检查 Node.js 和 npm 环境${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}   PM2 已就绪${NC}"

# [2/3] 检查构建产物
echo ""
echo -e "${YELLOW}[2/3] 检查构建产物...${NC}"
if [ ! -f "packages/api/dist/index.js" ]; then
  echo "   未找到构建产物，正在构建..."
  pnpm build
  if [ $? -ne 0 ]; then
    echo -e "${RED}   [错误] 构建失败，请检查代码错误${NC}"
    exit 1
  fi
fi
echo -e "${GREEN}   构建产物已就绪${NC}"

# [3/3] 启动 PM2
echo ""
echo -e "${YELLOW}[3/3] 启动服务...${NC}"
# 先停掉旧实例（如果存在），避免端口冲突
pm2 delete super-agent-api 2>/dev/null || true
pm2 delete super-agent-web 2>/dev/null || true
pm2 delete super-agent-gateway 2>/dev/null || true
pm2 delete super-agent-video-forge 2>/dev/null || true
pm2 start ecosystem.config.cjs --env production
pm2 save

# 配置开机自启
if command -v systemctl &> /dev/null; then
  pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null || true
  echo -e "${GREEN}   systemd 开机自启已配置${NC}"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  pm2 startup launchd -u "$(whoami)" --hp "$HOME" 2>/dev/null || true
  echo -e "${GREEN}   launchd 开机自启已配置${NC}"
else
  echo -e "${YELLOW}   [警告] 无法检测系统类型，跳过开机自启配置${NC}"
fi

# 显示结果
echo ""
echo -e "${CYAN}  ╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}  ║     Super Agent 生产模式已启动！         ║${NC}"
echo -e "${CYAN}  ╚══════════════════════════════════════════╝${NC}"
echo ""
echo "   管理面板: http://localhost:3000"
echo "   API 服务:  http://localhost:3001"
echo "   IM 网关:   http://localhost:8642"
echo ""
echo "   常用命令:"
echo "     ./start.sh status   - 查看服务状态"
echo "     ./start.sh logs     - 查看日志"
echo "     ./start.sh restart  - 重启所有服务"
echo "     ./start.sh stop     - 停止所有服务"
echo "     ./start.sh save     - 保存当前进程列表"
echo "     ./start.sh help     - 显示帮助"
echo ""
