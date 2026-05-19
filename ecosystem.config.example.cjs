/**
 * PM2 Ecosystem 模板（v3 Task 0b 新增）
 *
 * 用途：
 *   - 作为 ecosystem.config.cjs 的可入库副本
 *   - 真实 ecosystem.config.cjs 可能被运维改动注入私有路径，应作为本地配置
 *   - 新机部署时执行：cp ecosystem.config.example.cjs ecosystem.config.cjs
 *
 * 与 ecosystem.config.cjs 的差异：
 *   - 本文件不含任何具体路径/账号信息
 *   - 所有 env 变量留空，由 .env / vault 注入
 *
 * 关键原则：
 *   1. PM2 直接管理 4 个进程（api / web / gateway / video-forge），避免嵌套 spawn
 *   2. Windows 上 PM2 fork 模式无法正确穿透 PATH/权限给子 spawn 的 Python 进程
 *   3. 配合 wait_ready: true 防止 API 启动未就绪时 PM2 误判健康
 *
 * @see https://pm2.keymetrics.io/docs/usage/application-declaration/
 */
module.exports = {
  apps: [
    {
      name: "super-agent-api",
      script: "packages/api/dist/index.js",
      env_production: {
        NODE_ENV: "production",
        DISABLE_IM_GATEWAY: "true",
        DISABLE_VIDEO_FORGE: "true",
        DISABLE_KB_PARSER_SIDECAR: "true",
      },
      max_memory_restart: "512M",
      max_restarts: 5,
      min_uptime: 10000,
      wait_ready: true,
      listen_timeout: 60000,
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      error_file: "./logs/pm2-api-error.log",
      out_file: "./logs/pm2-api-out.log",
      merge_logs: true,
      watch: false,
      kill_timeout: 5000,
    },
    {
      name: "super-agent-web",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000",
      cwd: "./packages/web",
      env_production: { NODE_ENV: "production" },
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
      interpreter: "python",
      script: "main.py",
      cwd: "./services/video-forge",
      env_production: {
        PYTHONUNBUFFERED: "1",
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
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
