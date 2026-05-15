/**
 * 便携式分发包构建脚本
 *
 * 用法：pnpm tsx scripts/package-portable.ts [--version 0.2.0]
 *
 * 输出：dist-portable/super-agent-portable-v{version}.zip
 *
 * 目录结构：
 *   super-agent/
 *   ├── api/          ← @super-agent/api dist
 *   ├── core/         ← @super-agent/core dist
 *   ├── web/          ← @super-agent/web dist (静态导出)
 *   ├── node_modules/ ← 生产依赖
 *   ├── start.bat     ← Windows 启动脚本
 *   └── start.sh      ← Linux/macOS 启动脚本
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── 配置 ──────────────────────────────────────────────────

const ROOT = path.resolve(import.meta.dirname!, "..");
const DIST_PORTABLE = path.join(ROOT, "dist-portable");
const PACKAGE_DIR = path.join(DIST_PORTABLE, "super-agent");

// 从参数或根 package.json 获取版本号
const versionArg = process.argv.find((a) => a.startsWith("--version="));
const version = versionArg?.split("=")[1]
  ?? process.env.SUPER_AGENT_VERSION
  ?? readJson<{ version: string }>(path.join(ROOT, "package.json")).version;

const zipName = `super-agent-portable-v${version}.zip`;

// ─── 工具函数 ──────────────────────────────────────────────

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyDir(src: string, dest: string, filter?: (f: string) => boolean): void {
  ensureDir(dest);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (filter && !filter(entry.name)) continue;
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath, filter);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function exec(cmd: string, cwd?: string): void {
  console.log(`  > ${cmd}`);
  execSync(cmd, { cwd: cwd ?? ROOT, stdio: "inherit", timeout: 120_000 });
}

// ─── 主流程 ────────────────────────────────────────────────

console.log(`\n📦 构建便携式分发包 v${version}\n`);

// 1. 清理输出目录
console.log("1/7 清理输出目录...");
fs.rmSync(DIST_PORTABLE, { recursive: true, force: true });
ensureDir(PACKAGE_DIR);

// 2. 复制构建产物
console.log("2/7 复制构建产物...");
const coreDist = path.join(ROOT, "packages", "core", "dist");
const apiDist = path.join(ROOT, "packages", "api", "dist");
const webOut = path.join(ROOT, "packages", "web", "out");

if (fs.existsSync(coreDist)) copyDir(coreDist, path.join(PACKAGE_DIR, "core"));
if (fs.existsSync(apiDist)) copyDir(apiDist, path.join(PACKAGE_DIR, "api"));
if (fs.existsSync(webOut)) copyDir(webOut, path.join(PACKAGE_DIR, "web"));

// 3. 安装生产依赖到 portable 目录
console.log("3/7 安装生产依赖...");
const portablePkg = path.join(PACKAGE_DIR, "package.json");
fs.writeFileSync(portablePkg, JSON.stringify({
  name: "super-agent-portable",
  version,
  private: true,
  type: "module",
  scripts: {
    start: "node api/index.js",
    "start:api": "node api/index.js",
  },
  dependencies: {
    "@fastify/cors": "^11.0.0",
    "@fastify/jwt": "^9.0.0",
    "@fastify/rate-limit": "^10.3.0",
    "@fastify/static": "^8.1.0",
    "@fastify/websocket": "^11.0.0",
    "better-sqlite3": "^12.9.0",
    "chokidar": "^4.0.0",
    "cron-parser": "^5.5.0",
    "dotenv": "^16.4.0",
    "eventemitter3": "^5.0.1",
    "gray-matter": "^4.0.3",
    "json5": "^2.2.3",
    "jszip": "^3.10.1",
    "mammoth": "^1.8.0",
    "openai": "^4.104.0",
    "p-limit": "^6.2.0",
    "pdf-parse": "^1.1.1",
    "pino": "^9.6.0",
    "uuid": "^11.1.0",
    "xlsx": "^0.18.5",
    "zod": "^3.24.0",
    "zod-to-json-schema": "^3.25.2",
  },
}, null, 2));

try {
  exec("pnpm install --prod --no-frozen-lockfile", PACKAGE_DIR);
} catch {
  console.warn("  ⚠ pnpm install 失败（可能是跨平台 native 模块），继续打包...");
}

// 4. 生成启动脚本
console.log("4/7 生成启动脚本...");

// Windows 启动脚本
fs.writeFileSync(path.join(PACKAGE_DIR, "start.bat"), [
  "@echo off",
  "title Super Agent v%VERSION%",
  "echo ============================================",
  "echo   Super Agent v%VERSION%",
  "echo   模块化通用 AI Agent 平台",
  "echo ============================================",
  "echo.",
  "echo 启动 API 服务...",
  "node api\\index.js",
  "pause",
].join("\r\n").replace(/%VERSION%/g, version));

// Linux/macOS 启动脚本
fs.writeFileSync(path.join(PACKAGE_DIR, "start.sh"), [
  "#!/usr/bin/env bash",
  "set -e",
  `echo "============================================"`,
  `echo "  Super Agent v${version}"`,
  `echo "  模块化通用 AI Agent 平台"`,
  `echo "============================================"`,
  `echo ""`,
  `echo "启动 API 服务..."`,
  `exec node api/index.js`,
].join("\n"));

// 4.5 生成便携版 ecosystem.config.cjs（3 进程：api + gateway + video-forge，去掉 web 进程）
// 便携包中 API 通过 @fastify/static 直接托管静态 Web 文件，无需独立 Next.js 进程
console.log("4.5/7 生成便携版 ecosystem.config.cjs...");
const portableEcosystem = `/**
 * PM2 Ecosystem File — Super Agent 便携版（自动生成，请勿手动编辑）
 *
 * 管理 3 个进程：
 * - super-agent-api        : Node.js API 服务（含 Web 静态文件托管）
 * - super-agent-gateway    : IM Gateway (Python)
 * - super-agent-video-forge: 视频生成引擎 (Python)
 *
 * 注意：便携版无 super-agent-web 进程，API 在生产模式下通过 @fastify/static 托管 Web 文件。
 *
 * 使用方式：
 *   pm2 start ecosystem.config.cjs --env production
 */
module.exports = {
  apps: [
    {
      name: "super-agent-api",
      script: "api/index.js",
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
`;
fs.writeFileSync(path.join(PACKAGE_DIR, "ecosystem.config.cjs"), portableEcosystem);
console.log("  已生成便携版 ecosystem.config.cjs（3 进程，无 web）");

// 5. 压缩为 zip
console.log("5/7 压缩为 zip...");
const zipPath = path.join(DIST_PORTABLE, zipName);

// 使用系统命令压缩（避免引入 archiver 依赖）
if (process.platform === "win32") {
  exec(`powershell -Command "Compress-Archive -Path '${PACKAGE_DIR}' -DestinationPath '${zipPath}'"`);
} else {
  exec(`cd "${DIST_PORTABLE}" && zip -r "${zipName}" super-agent/`);
}

// 6. 清理临时目录
console.log("6/7 清理...");
fs.rmSync(PACKAGE_DIR, { recursive: true, force: true });

// ─── 输出结果 ──────────────────────────────────────────────

const stats = fs.statSync(zipPath);
const sizeMB = (stats.size / (1024 * 1024)).toFixed(1);

console.log(`\n✅ 分发包已生成:`);
console.log(`   ${zipPath}`);
console.log(`   大小: ${sizeMB} MB\n`);
