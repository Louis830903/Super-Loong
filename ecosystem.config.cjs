/**
 * PM2 Ecosystem File — Super Agent 生产环境进程管理
 *
 * 管理 4 个进程（平级，PM2 统一负责崩溃重启和日志收集）：
 * - super-agent-api        : Node.js API 服务 (Fastify)，DISABLE_IM_GATEWAY=true + DISABLE_VIDEO_FORGE=true + DISABLE_KB_PARSER_SIDECAR=true
 * - super-agent-web        : Next.js 前端 (生产模式)
 * - super-agent-gateway    : IM Gateway (Python)，由 PM2 直接管理，避免嵌套 spawn 权限问题
 * - super-agent-video-forge: 视频生成引擎 (Python)，由 PM2 直接管理，避免嵌套 spawn 权限问题
 *
 * 架构说明：
 *   Windows 上 PM2 fork 模式子进程环境与交互式终端不一致，Node.js 嵌套 spawn Python
 *   会因 PATH/权限隔离失败。改为 PM2 直接管理 Python 进程，通过 interpreter 启动。
 *
 * 使用方式：
 *   pm2 start ecosystem.config.cjs --env production
 *   pm2 status
 *   pm2 logs super-agent-api
 *
 * @see https://pm2.keymetrics.io/docs/usage/application-declaration/
 */

module.exports = {
  apps: [
    {
      name: "super-agent-api",
      script: "packages/api/dist/index.js",
      // 生产环境变量
      env_production: {
        NODE_ENV: "production",
        // 禁用 API 内置 GatewayLauncher，由 PM2 直接管理 Gateway 进程（见 super-agent-gateway）
        DISABLE_IM_GATEWAY: "true",
        // 禁用 API 内置 VideoForgeSupervisor，由 PM2 直接管理 video-forge 进程
        DISABLE_VIDEO_FORGE: "true",
        // 禁用 API 内置 KbParserSupervisor（知识库 Docling 懒启动 sidecar），
        // Windows PM2 fork 模式下 spawn Python 同样可能因 PATH/权限隔离失败
        DISABLE_KB_PARSER_SIDECAR: "true",
      },
      // 内存限制：超过 512MB 自动重启
      max_memory_restart: "512M",
      // 崩溃保护：10 秒内崩溃超过 5 次则停止重试
      max_restarts: 5,
      min_uptime: 10000,
      // 等待 process.send('ready') 信号确认就绪（由 Task 1b 注入）
      wait_ready: true,
      listen_timeout: 60000, // 最多等 60 秒
      // 日志
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-api-error.log",
      out_file: "./logs/pm2-api-out.log",
      merge_logs: true,
      // 生产环境不热重载
      watch: false,
      // 重启时延迟 2 秒，避免端口未释放
      kill_timeout: 5000,
    },
    {
      name: "super-agent-web",
      // 直接引用 Next.js 二进制（避免 Windows 上 npx.cmd 被 PM2 当 JS 解析引发 SyntaxError）
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      // 必须在 web 包目录下运行 Next.js
      cwd: "./packages/web",
      env_production: {
        NODE_ENV: "production",
      },
      max_restarts: 5,
      min_uptime: 10000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-web-error.log",
      out_file: "./logs/pm2-web-out.log",
      merge_logs: true,
      watch: false,
      kill_timeout: 5000,
    },
    {
      name: "super-agent-gateway",
      // PM2 直接管理 Python 进程，避免 Node.js 嵌套 spawn 的 PATH/权限问题
      interpreter: "python",
      script: "server.py",
      args: "-u",
      cwd: "./services/im-gateway",
      env_production: {
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      max_restarts: 5,
      min_uptime: 10000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-gateway-error.log",
      out_file: "./logs/pm2-gateway-out.log",
      merge_logs: true,
      watch: false,
      kill_timeout: 5000,
    },
    {
      name: "super-agent-video-forge",
      // PM2 直接管理 Python 视频生成引擎，避免 Node.js 嵌套 spawn 的 PATH/权限问题
      interpreter: "python",
      script: "main.py",
      cwd: "./services/video-forge",
      env_production: {
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
        // 生产环境不启用 uvicorn reload
        VIDEO_FORGE_RELOAD: "0",
      },
      max_restarts: 5,
      min_uptime: 10000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-video-forge-error.log",
      out_file: "./logs/pm2-video-forge-out.log",
      merge_logs: true,
      watch: false,
      kill_timeout: 5000,
    },
  ],
};
