/**
 * Gateway Bootstrap — IM Gateway sidecar 环境自举模块
 *
 * 职责（对齐 kb-parser-bootstrap.ts 的 pattern）：
 *   1. 复用 detectPython() —— Python 3.11+ 探测
 *   2. 复用 ensureUvVenv() —— 在 services/im-gateway/ 下建独立 .venv
 *   3. 复用 buildSpawnEnv() —— 组装子进程环境变量（PATH 前置 venv）
 *
 * 与 video-forge / kb-parser 的差异：
 *   - 不需要 ffmpeg / ffprobe（纯 FastAPI 服务）
 *   - 不需要 torch / easyocr（依赖远小于 kb-parser）
 *   - 使用独立的 .venv，与 video-forge / kb-parser 完全隔离
 *
 * 设计原则：
 *   - 零新 npm 依赖（仅复用 bootstrap.ts 已有的 node 内置模块 + pino）
 *   - 幂等：重复调用不重建 venv
 *   - 失败友好：带 guidance 的结构化错误，供上游提示用户
 */

import * as fs from "node:fs";
import * as path from "node:path";
import pino from "pino";

import {
  detectPython,
  ensureUvVenv,
  buildSpawnEnv,
  findMonorepoRoot,
  PythonNotFoundError,
  VenvSetupError,
} from "./bootstrap.js";

const logger = pino({ name: "gateway-bootstrap" });

// ==================== 类型定义 ====================

/** Bootstrap 结果，供 gateway-launcher.ts 消费 */
export interface GatewayDepsResult {
  /** Python 可执行文件路径 */
  pythonPath: string;
  /** Python 版本字符串（如 "3.11.9"） */
  pythonVersion: string;
  /** .venv 目录绝对路径 */
  venvDir: string;
  /** services/im-gateway/ 目录绝对路径 */
  gatewayDir: string;
  /** 注入 PATH 后的完整环境变量，可直接传给 spawn() */
  spawnEnv: NodeJS.ProcessEnv;
}

/** Bootstrap 配置选项 */
export interface GatewayBootstrapOptions {
  /** monorepo 根目录（默认根据 pnpm-workspace.yaml 向上查找） */
  monorepoRoot?: string;
  /** IM Gateway 服务目录（默认 {monorepoRoot}/services/im-gateway/） */
  gatewayDir?: string;
  /** 跳过 venv 创建（用于探测场景） */
  skipVenv?: boolean;
}

// ==================== 错误（复用 bootstrap.ts 的通用错误） ====================

export { PythonNotFoundError, VenvSetupError };

/**
 * 解析 IM Gateway 服务目录（默认基于 monorepo 根定位）。
 */
function resolveGatewayDir(options: GatewayBootstrapOptions): {
  monorepoRoot: string;
  gatewayDir: string;
} {
  // 从当前文件位置反推 monorepo 根
  // 注意：与 bootstrap.ts 一致处理 URL 编码（Windows 路径含空格时的 %20）
  const rawPath = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
  const currentDir = path.dirname(decodeURIComponent(rawPath));

  const detectedRoot = findMonorepoRoot(currentDir);
  if (!detectedRoot && !options.monorepoRoot) {
    logger.warn(
      { currentDir },
      "未能通过 pnpm-workspace.yaml 定位 monorepo 根，回退到相对路径推断（可能不准确）",
    );
  }

  const defaultRoot = detectedRoot || path.resolve(currentDir, "../../../..");
  const monorepoRoot = options.monorepoRoot || defaultRoot;
  const gatewayDir =
    options.gatewayDir || path.join(monorepoRoot, "services", "im-gateway");

  return { monorepoRoot, gatewayDir };
}

// ==================== 主函数 ====================

/**
 * 确保 IM Gateway 微服务的所有运行时依赖就绪。
 *
 * 执行顺序：
 *   1. 解析服务目录（support monorepoRoot / gatewayDir 覆盖）
 *   2. 校验 services/im-gateway/ 存在（否则抛明确错误）
 *   3. detectPython() —— 探测 Python 3.11+
 *   4. ensureUvVenv() —— 创建 .venv + 安装 pyproject.toml 依赖（可选跳过）
 *   5. buildSpawnEnv() —— 组装子进程环境变量
 */
export const ensureGatewayDeps = async (
  options: GatewayBootstrapOptions = {},
): Promise<GatewayDepsResult> => {
  logger.info("═══ IM Gateway Bootstrap 开始 ═══");

  // ── Step 1: 目录解析 ──
  const { gatewayDir } = resolveGatewayDir(options);
  logger.info({ gatewayDir }, "IM Gateway 服务目录已解析");

  // ── Step 2: 服务目录存在性校验 ──
  if (!fs.existsSync(gatewayDir)) {
    throw new VenvSetupError(
      `找不到 IM Gateway 服务目录: ${gatewayDir}。请确认 services/im-gateway/ 完整存在。`,
    );
  }
  // IM Gateway 使用 pyproject.toml（uv 标准）管理依赖
  const pyprojectFile = path.join(gatewayDir, "pyproject.toml");
  if (!fs.existsSync(pyprojectFile)) {
    throw new VenvSetupError(
      `找不到 ${pyprojectFile}，请确保 services/im-gateway/pyproject.toml 存在`,
    );
  }

  // ── Step 3: Python 探测 ──
  const python = await detectPython();

  // ── Step 4: venv 自举（可选跳过，用于仅探测） ──
  let venvDir: string;
  if (options.skipVenv) {
    venvDir = path.join(gatewayDir, ".venv");
    logger.info("跳过 venv 创建（skipVenv=true）");
  } else {
    venvDir = await ensureUvVenv(gatewayDir, python.path);
  }

  // ── Step 5: 组装环境变量 ──
  // IM Gateway 不需要 ffmpeg，传空字符串即可（buildSpawnEnv 会把 venv/Scripts 前置到 PATH）
  const spawnEnv = buildSpawnEnv("", venvDir);

  const result: GatewayDepsResult = {
    pythonPath: python.path,
    pythonVersion: python.version,
    venvDir,
    gatewayDir,
    spawnEnv,
  };

  logger.info(
    {
      pythonPath: result.pythonPath,
      pythonVersion: result.pythonVersion,
      venvDir: result.venvDir,
      gatewayDir: result.gatewayDir,
    },
    "═══ IM Gateway Bootstrap 完成 ═══",
  );

  return result;
};
