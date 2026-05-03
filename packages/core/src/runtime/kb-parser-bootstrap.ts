/**
 * KB-Parser Bootstrap — 知识库 Docling sidecar 环境自举模块（Spec §T7）。
 *
 * 职责（对齐 bootstrap.ts 的 video-forge 模式）：
 *   1. 复用 detectPython() —— Python 3.11+ 探测（与 video-forge 共用逻辑）
 *   2. 复用 ensureUvVenv() —— 在 services/kb-parser/ 下建独立 .venv
 *   3. 组装子进程环境变量（PATH 前置 venv/Scripts|bin + PYTHONUNBUFFERED=1）
 *
 * 与 video-forge 的差异：
 *   - 不需要 ffmpeg / ffprobe（纯解析服务）
 *   - 使用独立的 .venv（避免 Docling 的 torch/easyocr 污染 video-forge）
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

const logger = pino({ name: "kb-parser-bootstrap" });

// ==================== 类型定义 ====================

/** Bootstrap 结果，供 kb-parser-supervisor.ts 消费 */
export interface KbParserDepsResult {
  /** Python 可执行文件路径 */
  pythonPath: string;
  /** Python 版本字符串（如 "3.11.9"） */
  pythonVersion: string;
  /** .venv 目录绝对路径 */
  venvDir: string;
  /** services/kb-parser/ 目录绝对路径 */
  kbParserDir: string;
  /** 注入 PATH 后的完整环境变量，可直接传给 spawn() */
  spawnEnv: NodeJS.ProcessEnv;
}

/** Bootstrap 配置选项 */
export interface KbParserBootstrapOptions {
  /** monorepo 根目录（默认根据 pnpm-workspace.yaml 向上查找） */
  monorepoRoot?: string;
  /** kb-parser 服务目录（默认 {monorepoRoot}/services/kb-parser/） */
  kbParserDir?: string;
  /** 跳过 venv 创建（用于探测场景） */
  skipVenv?: boolean;
}

// ==================== 错误（复用 bootstrap.ts 的通用错误） ====================

export { PythonNotFoundError, VenvSetupError };

/**
 * 解析 kb-parser 服务目录（默认基于 monorepo 根定位）。
 */
function resolveKbParserDir(options: KbParserBootstrapOptions): {
  monorepoRoot: string;
  kbParserDir: string;
} {
  // 从当前文件位置反推 monorepo 根
  // 注意：与 bootstrap.ts 一致处理 URL 编码（Windows 路径含空格时的 %20）
  const rawPath = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
  const currentDir = path.dirname(decodeURIComponent(rawPath));

  const detectedRoot = findMonorepoRoot(currentDir);
  if (!detectedRoot && !options.monorepoRoot) {
    logger.warn(
      { currentDir },
      "⚠ 未能通过 pnpm-workspace.yaml 定位 monorepo 根，回退到相对路径推断（可能不准确）",
    );
  }

  const defaultRoot = detectedRoot || path.resolve(currentDir, "../../../..");
  const monorepoRoot = options.monorepoRoot || defaultRoot;
  const kbParserDir =
    options.kbParserDir || path.join(monorepoRoot, "services", "kb-parser");

  return { monorepoRoot, kbParserDir };
}

// ==================== 主函数 ====================

/**
 * 确保 kb-parser 微服务的所有运行时依赖就绪。
 *
 * 执行顺序：
 *   1. 解析服务目录（support monorepoRoot / kbParserDir 覆盖）
 *   2. 校验 services/kb-parser/ 存在（否则抛明确错误）
 *   3. detectPython() —— 探测 Python 3.11+（缺失直接报错，不下载 Python）
 *   4. ensureUvVenv() —— 创建 .venv + 安装 requirements.lock（可选跳过）
 *   5. buildSpawnEnv() —— 组装子进程环境变量
 *
 * 该函数是 Spec §T7 规定的 `ensureKbParserDeps` 独立函数，与 video-forge
 * 的 bootstrap 完全隔离（独立 venv、独立依赖锁），但复用底层探测/安装能力。
 */
export const ensureKbParserDeps = async (
  options: KbParserBootstrapOptions = {},
): Promise<KbParserDepsResult> => {
  logger.info("═══ KB-Parser Bootstrap 开始 ═══");

  // ── Step 1: 目录解析 ──
  const { kbParserDir } = resolveKbParserDir(options);
  logger.info({ kbParserDir }, "kb-parser 服务目录已解析");

  // ── Step 2: 服务目录存在性校验 ──
  if (!fs.existsSync(kbParserDir)) {
    throw new VenvSetupError(
      `找不到 kb-parser 服务目录: ${kbParserDir}。请确认 services/kb-parser/ 完整存在。`,
    );
  }
  const requirementsFile = path.join(kbParserDir, "requirements.lock");
  if (!fs.existsSync(requirementsFile)) {
    throw new VenvSetupError(
      `找不到 ${requirementsFile}，请确保 services/kb-parser/requirements.lock 存在`,
    );
  }

  // ── Step 3: Python 探测 ──
  const python = await detectPython();

  // ── Step 4: venv 自举（可选跳过，用于仅探测） ──
  let venvDir: string;
  if (options.skipVenv) {
    venvDir = path.join(kbParserDir, ".venv");
    logger.info("跳过 venv 创建（skipVenv=true）");
  } else {
    venvDir = await ensureUvVenv(kbParserDir, python.path);
  }

  // ── Step 5: 组装环境变量 ──
  // kb-parser 不需要 ffmpeg，传空字符串即可（buildSpawnEnv 会把 venv/Scripts 前置到 PATH）
  const spawnEnv = buildSpawnEnv("", venvDir);

  const result: KbParserDepsResult = {
    pythonPath: python.path,
    pythonVersion: python.version,
    venvDir,
    kbParserDir,
    spawnEnv,
  };

  logger.info(
    {
      pythonPath: result.pythonPath,
      pythonVersion: result.pythonVersion,
      venvDir: result.venvDir,
      kbParserDir: result.kbParserDir,
    },
    "═══ KB-Parser Bootstrap 完成 ═══",
  );

  return result;
};
