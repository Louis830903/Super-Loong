/**
 * PM2 Ecosystem File — Super Agent 生产环境进程管理
 *
 * 管理 2 个进程：
 * - super-agent-api  : Node.js API 服务 (Fastify)，含内置 GatewayLauncher
 * - super-agent-web  : Next.js 前端 (生产模式)
 *
 * IM Gateway 由 API 内部的 GatewayLauncher 自动管理，不在此单独定义。
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
      script: "npx",
      args: "next start -p 3000",
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
  ],
};
