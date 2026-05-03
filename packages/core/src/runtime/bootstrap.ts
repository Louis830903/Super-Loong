/**
 * Video-Forge Bootstrap — 视频微服务环境自举模块
 *
 * 职责（Spec v1.4 附录 A2）：
 * 1. Python 3.11+ 探测（不下载，缺失/版本过低抛结构化提示 + 国内镜像链接）
 * 2. ffmpeg 探测与兜底下载（国内镜像优先，便携版到 runtime/ffmpeg/bin/）
 * 3. ffprobe 探测与兜底下载（ffmpeg-static 只含 ffmpeg 不含 ffprobe，
 *    Python 端 ffmpeg.probe() 必须依赖 ffprobe 二进制，否则 WinError 2）
 * 4. uv 自举 venv（services/video-forge/.venv/）
 * 5. PATH 注入（ffmpeg/bin + .venv/Scripts|bin 前置到子进程 env）
 *
 * 设计原则：
 * - 零新 npm 依赖（全部使用 Node.js 内置模块 + 系统 tar 命令 + pino 日志）
 * - 参考 gateway-launcher.ts 的 Python 命令探测方式
 * - 所有下载 URL 可通过环境变量覆盖（FFMPEG_DOWNLOAD_URL / FFPROBE_DOWNLOAD_URL）
 * - 幂等：重复调用不会重复下载或重建 venv
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { Readable } from "node:stream";
import pino from "pino";
import { Env } from "../config/env.js";

const execFileAsync = promisify(execFile);
const logger = pino({ name: "video-forge-bootstrap" });

// ==================== 类型定义 ====================

/** Bootstrap 结果，供 video-forge-supervisor.ts 消费 */
export interface VideoForgeDepsResult {
  /** Python 可执行文件路径（如 "python" 或 "C:\Python311\python.exe"） */
  pythonPath: string;
  /** Python 版本字符串（如 "3.14.2"） */
  pythonVersion: string;
  /** ffmpeg 可执行文件路径 */
  ffmpegPath: string;
  /**
   * ffprobe 可执行文件路径。
   * T6 frame-composition 及多处 Python 代码依赖 ffmpeg.probe()，该调用底层
   * 会 spawn ffprobe —— ffmpeg-static 只含 ffmpeg 不含 ffprobe，
   * 因此必须独立下载/探测，否则抛 WinError 2 / ENOENT。
   */
  ffprobePath: string;
  /** .venv 目录绝对路径 */
  venvDir: string;
  /** 注入 PATH 后的完整环境变量，可直接传给 spawn() 的 env 参数 */
  spawnEnv: NodeJS.ProcessEnv;
}

/** Bootstrap 配置选项 */
export interface BootstrapOptions {
  /** monorepo 根目录（默认从当前文件位置向上查找 pnpm-workspace.yaml 定位） */
  monorepoRoot?: string;
  /** ffmpeg 安装目标目录（默认 {monorepoRoot}/runtime/ffmpeg/） */
  ffmpegDir?: string;
  /** video-forge 服务目录（默认 {monorepoRoot}/services/video-forge/） */
  videoForgeDir?: string;
  /** 跳过 venv 创建（用于仅探测环境的场景） */
  skipVenv?: boolean;
}

// ==================== 结构化错误 ====================

/** Python 缺失或版本不足时抛出 */
export class PythonNotFoundError extends Error {
  readonly code = "PYTHON_NOT_FOUND" as const;
  /** 面向用户的安装引导文本（可直接展示到 onboarding UI） */
  readonly guidance: string;

  constructor(detail: string) {
    super(`Python 环境不满足要求: ${detail}`);
    this.name = "PythonNotFoundError";
    this.guidance = [
      "━━━ 视频生成功能需要 Python 3.11+ ━━━",
      "",
      `当前问题：${detail}`,
      "",
      "请安装 Python 后重启 Super Agent：",
      "  • 官网下载：  https://www.python.org/downloads/",
      "  • 阿里云镜像：https://mirrors.aliyun.com/python-release/",
      "  • 华为云镜像：https://mirrors.huaweicloud.com/python/",
      "",
      "⚠️ Windows 安装时请务必勾选「Add Python to PATH」",
    ].join("\n");
  }
}

/** ffmpeg 下载失败时抛出 */
export class FfmpegDownloadError extends Error {
  readonly code = "FFMPEG_DOWNLOAD_FAILED" as const;
  constructor(detail: string) {
    super(`ffmpeg 下载失败: ${detail}`);
    this.name = "FfmpegDownloadError";
  }
}

/** ffprobe 下载失败时抛出 */
export class FfprobeDownloadError extends Error {
  readonly code = "FFPROBE_DOWNLOAD_FAILED" as const;
  constructor(detail: string) {
    super(`ffprobe 下载失败: ${detail}`);
    this.name = "FfprobeDownloadError";
  }
}

/** uv / venv 创建失败时抛出 */
export class VenvSetupError extends Error {
  readonly code = "VENV_SETUP_FAILED" as const;
  constructor(detail: string) {
    super(`Python 虚拟环境创建失败: ${detail}`);
    this.name = "VenvSetupError";
  }
}

// ==================== 常量 ====================

/** 最低要求的 Python 版本 */
const MIN_PYTHON_VERSION = [3, 11] as const;

/**
 * ffmpeg-static 国内镜像下载源（按优先级排序）
 * 文件格式：gzip 压缩的单个 ffmpeg 二进制
 * 环境变量 FFMPEG_DOWNLOAD_URL 可覆盖（直接指向 .gz 文件完整 URL）
 */
// ffmpeg-static@5.3.0 绑定的二进制 release tag 为 b6.1.1（见 npm registry meta）。
// 历史遗留的 b7.0.2 在 GitHub/npmmirror 均不存在（404），2026-04 修正。
const FFMPEG_STATIC_VERSION = "b6.1.1";
const FFMPEG_MIRRORS = [
  // npmmirror 二进制镜像（国内 CDN，速度最快）
  `https://cdn.npmmirror.com/binaries/ffmpeg-static/${FFMPEG_STATIC_VERSION}`,
  // GitHub 原始 Release（国内可能较慢，作为兜底）
  `https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_STATIC_VERSION}`,
];

/**
 * 根据平台获取 ffmpeg-static 的文件名
 * ffmpeg-static 的命名规则：ffmpeg-{platform}-{arch}.gz
 */
const getFfmpegFileName = (): string => {
  const platform = process.platform; // win32 | linux | darwin
  const arch = process.arch;         // x64 | arm64
  return `ffmpeg-${platform}-${arch}.gz`;
};

/**
 * ffprobe 下载源：使用 @ffprobe-installer/{platform}-{arch} 的 npm tarball。
 * 这些子包由 GyanD 维护，每平台独立发布 npm tarball（.tgz），解包后为
 * package/ffprobe（.exe），国内 npmmirror 有完整镜像。
 *
 * 版本号用最新稳定版 5.1.0（2023-02 发布）。
 * 5.1.0 对应 ffprobe 5.x，兼容 ffmpeg-static 6.1.x 的探测输出格式。
 */
const FFPROBE_INSTALLER_VERSION = "5.1.0";

/**
 * 获取 @ffprobe-installer 子包名（按平台 + 架构）。
 * 对应 npm 包命名：@ffprobe-installer/win32-x64、@ffprobe-installer/darwin-arm64 等。
 */
const getFfprobeInstallerPackage = (): string => {
  const platform = process.platform; // win32 | linux | darwin
  const arch = process.arch;         // x64 | arm64
  return `${platform}-${arch}`;
};

/**
 * ffprobe 下载镜像列表（按优先级排序）。
 * 返回 tgz 下载 URL 数组（不含环境变量覆盖，由 downloadFfprobe 处理）。
 */
const getFfprobeMirrors = (): string[] => {
  const pkg = getFfprobeInstallerPackage();
  const ver = FFPROBE_INSTALLER_VERSION;
  return [
    // npmmirror: 国内 CDN，速度最快
    `https://registry.npmmirror.com/@ffprobe-installer/${pkg}/-/${pkg}-${ver}.tgz`,
    // npmjs 原始 registry（国内可能较慢，兜底）
    `https://registry.npmjs.org/@ffprobe-installer/${pkg}/-/${pkg}-${ver}.tgz`,
  ];
};

// ==================== 核心函数 ====================

/**
 * 探测系统 Python，验证版本 >= 3.11
 *
 * 探测逻辑（与 gateway-launcher.ts L94 保持一致）：
 * - Windows 使用 `python`
 * - 其他平台使用 `python3`，fallback `python`
 *
 * @returns { path, version } Python 命令名和版本字符串
 * @throws {PythonNotFoundError} 未找到 Python 或版本不足
 */
export const detectPython = async (): Promise<{ path: string; version: string }> => {
  // 按优先级尝试的 Python 命令列表
  const candidates = process.platform === "win32"
    ? ["python"]                // Windows 只用 python（memory: Python环境仅支持python命令）
    : ["python3", "python"];    // 其他平台优先 python3

  for (const cmd of candidates) {
    try {
      const { stdout } = await execFileAsync(cmd, ["--version"], { timeout: 10_000 });
      // 输出格式：「Python 3.14.2」
      const match = stdout.trim().match(/Python\s+(\d+)\.(\d+)\.(\d+)/i);
      if (!match) continue;

      const [, majorStr, minorStr, patchStr] = match;
      const major = parseInt(majorStr, 10);
      const minor = parseInt(minorStr, 10);
      const version = `${major}.${minor}.${parseInt(patchStr, 10)}`;

      // 版本校验：>= 3.11
      if (major > MIN_PYTHON_VERSION[0] ||
          (major === MIN_PYTHON_VERSION[0] && minor >= MIN_PYTHON_VERSION[1])) {
        logger.info({ cmd, version }, "Python 探测通过");
        return { path: cmd, version };
      }

      // 找到了但版本过低
      throw new PythonNotFoundError(
        `找到 ${cmd} 但版本为 ${version}，需要 >= ${MIN_PYTHON_VERSION.join(".")}`
      );
    } catch (err: any) {
      // PythonNotFoundError 直接向上抛（版本不足）
      if (err instanceof PythonNotFoundError) throw err;
      // 其他错误（命令不存在等）：尝试下一个候选
      logger.debug({ cmd, error: err.message }, "Python 候选命令不可用，尝试下一个");
    }
  }

  throw new PythonNotFoundError("系统 PATH 中未找到 python 命令");
};

/**
 * 探测系统 ffmpeg
 *
 * @returns ffmpeg 命令路径（找到时），或 null（未找到时）
 */
export const detectFfmpeg = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("ffmpeg", ["-version"], { timeout: 10_000 });
    const firstLine = stdout.split("\n")[0] ?? "";
    logger.info({ version: firstLine.trim() }, "系统 ffmpeg 已安装");
    return "ffmpeg";
  } catch {
    logger.info("系统 PATH 中未找到 ffmpeg");
    return null;
  }
};

/**
 * 探测系统 ffprobe
 *
 * @returns ffprobe 命令路径（找到时），或 null（未找到时）
 */
export const detectFfprobe = async (): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", ["-version"], { timeout: 10_000 });
    const firstLine = stdout.split("\n")[0] ?? "";
    logger.info({ version: firstLine.trim() }, "系统 ffprobe 已安装");
    return "ffprobe";
  } catch {
    logger.info("系统 PATH 中未找到 ffprobe");
    return null;
  }
};

/**
 * 从国内镜像下载 ffmpeg 便携版
 *
 * 下载流程：
 * 1. 逐一尝试 FFMPEG_MIRRORS 中的镜像（或使用 FFMPEG_DOWNLOAD_URL 环境变量覆盖）
 * 2. 下载 .gz 压缩的 ffmpeg 二进制
 * 3. 解压到目标目录
 * 4. Windows 下重命名为 ffmpeg.exe，其他平台设置可执行权限
 *
 * @param targetDir ffmpeg 安装目标目录（如 super-agent/runtime/ffmpeg/）
 * @returns ffmpeg 可执行文件的绝对路径
 */
export const downloadFfmpeg = async (targetDir: string): Promise<string> => {
  const binDir = path.join(targetDir, "bin");
  const exeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const targetPath = path.join(binDir, exeName);

  // 幂等：如果已下载过，直接返回
  if (fs.existsSync(targetPath)) {
    logger.info({ targetPath }, "ffmpeg 便携版已存在，跳过下载");
    return targetPath;
  }

  // 确保目标目录存在
  fs.mkdirSync(binDir, { recursive: true });

  const fileName = getFfmpegFileName();
  const tempPath = path.join(binDir, `_downloading_${exeName}`);

  // 构建待尝试的下载 URL 列表
  const envUrl = Env.FFMPEG_DOWNLOAD_URL;
  const urls = envUrl
    ? [envUrl]  // 环境变量覆盖：只用这一个
    : FFMPEG_MIRRORS.map((mirror) => `${mirror}/${fileName}`);

  // 逐一尝试下载
  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      logger.info({ url }, "正在下载 ffmpeg 便携版...");

      const resp = await fetch(url, {
        signal: AbortSignal.timeout(300_000), // 5 分钟超时
        redirect: "follow",
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      if (!resp.body) {
        throw new Error("响应体为空");
      }

      // 流式写入临时文件（.gz → gunzip → 二进制）
      const writeStream = createWriteStream(tempPath);
      const gunzip = createGunzip();

      // resp.body 是 ReadableStream (Web API)，需要转换为 Node.js stream
      const nodeStream = readableStreamToNodeStream(resp.body);
      await pipeline(nodeStream, gunzip, writeStream);

      // 非 Windows 平台设置可执行权限
      if (process.platform !== "win32") {
        fs.chmodSync(tempPath, 0o755);
      }

      // 原子重命名：下载完成后才从 temp 移到正式位置
      fs.renameSync(tempPath, targetPath);

      logger.info({ targetPath, url }, "ffmpeg 便携版下载完成");
      return targetPath;
    } catch (err: any) {
      lastError = err;
      logger.warn({ url, error: err.message }, "ffmpeg 下载失败，尝试下一个镜像");
      // 清理可能的残留临时文件
      try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
    }
  }

  throw new FfmpegDownloadError(
    `所有镜像均下载失败（共尝试 ${urls.length} 个）。` +
    `最后一个错误：${lastError?.message ?? "unknown"}。` +
    `你也可以手动下载 ffmpeg 并放到 ${targetPath}，或设置 FFMPEG_DOWNLOAD_URL 环境变量指向可用的下载源。`
  );
};

/**
 * 从 npmmirror / npmjs 下载 ffprobe 便携版
 *
 * 下载流程：
 * 1. 逐一尝试 @ffprobe-installer/{platform}-{arch} 的 tgz 镜像
 *    （或使用 FFPROBE_DOWNLOAD_URL 环境变量覆盖）
 * 2. 下载 .tgz 到临时目录
 * 3. 调用系统 tar 命令解包（Windows 10+ 自带 bsdtar，Linux/Mac 自带 tar）
 *    只抽出 package/ffprobe(.exe) 到目标 bin 目录
 * 4. 非 Windows 设置可执行权限
 *
 * @param targetDir ffmpeg 安装根目录（ffprobe 与 ffmpeg 放同一 bin/ 下）
 * @returns ffprobe 可执行文件的绝对路径
 */
export const downloadFfprobe = async (targetDir: string): Promise<string> => {
  const binDir = path.join(targetDir, "bin");
  const exeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const targetPath = path.join(binDir, exeName);

  // 幂等：如果已下载过，直接返回
  if (fs.existsSync(targetPath)) {
    logger.info({ targetPath }, "ffprobe 便携版已存在，跳过下载");
    return targetPath;
  }

  // 确保目标目录存在
  fs.mkdirSync(binDir, { recursive: true });

  // 使用系统 tmp 目录保存 tgz（避免与 bin/ 混杂）
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ffprobe-dl-"));
  const tgzPath = path.join(tmpDir, "ffprobe.tgz");

  // 构建待尝试的下载 URL 列表
  const envUrl = Env.FFPROBE_DOWNLOAD_URL;
  const urls = envUrl ? [envUrl] : getFfprobeMirrors();

  let lastError: Error | null = null;
  for (const url of urls) {
    try {
      logger.info({ url }, "正在下载 ffprobe 便携版...");

      const resp = await fetch(url, {
        signal: AbortSignal.timeout(300_000),
        redirect: "follow",
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }
      if (!resp.body) {
        throw new Error("响应体为空");
      }

      // 流式写入 tgz
      const writeStream = createWriteStream(tgzPath);
      const nodeStream = readableStreamToNodeStream(resp.body);
      await pipeline(nodeStream, writeStream);

      // 用系统 tar 解出 package/ffprobe(.exe) 到 tmpDir
      // --strip-components=1 去掉 "package/" 前缀
      // 只抽取 ffprobe 二进制，避免解出 README/package.json 等无关文件
      const tarMember = process.platform === "win32"
        ? "package/ffprobe.exe"
        : "package/ffprobe";
      try {
        await execFileAsync(
          "tar",
          ["-xzf", tgzPath, "-C", tmpDir, "--strip-components=1", tarMember],
          { timeout: 60_000 },
        );
      } catch (tarErr: any) {
        throw new Error(`tar 解压失败: ${tarErr.stderr || tarErr.message}`);
      }

      const extractedPath = path.join(tmpDir, exeName);
      if (!fs.existsSync(extractedPath)) {
        throw new Error(`解压后未找到 ${exeName}（预期路径 ${extractedPath}）`);
      }

      // 非 Windows 平台设置可执行权限
      if (process.platform !== "win32") {
        fs.chmodSync(extractedPath, 0o755);
      }

      // 原子移动到 bin/
      fs.renameSync(extractedPath, targetPath);

      // 清理临时目录
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

      logger.info({ targetPath, url }, "ffprobe 便携版下载完成");
      return targetPath;
    } catch (err: any) {
      lastError = err;
      logger.warn({ url, error: err.message }, "ffprobe 下载失败，尝试下一个镜像");
    }
  }

  // 清理临时目录
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

  throw new FfprobeDownloadError(
    `所有镜像均下载失败（共尝试 ${urls.length} 个）。` +
    `最后一个错误：${lastError?.message ?? "unknown"}。` +
    `你也可以手动下载 ffprobe 并放到 ${targetPath}，或设置 FFPROBE_DOWNLOAD_URL 环境变量指向可用的 .tgz 下载源。`
  );
};

/**
 * 创建 Python 虚拟环境并安装依赖
 *
 * 使用 uv 工具链（比 pip 快 10-100x）：
 * 1. `uv venv .venv` 创建虚拟环境
 * 2. `uv pip install -r requirements.lock` 安装锁定依赖
 *
 * @param videoForgeDir services/video-forge/ 目录
 * @param pythonPath Python 可执行文件路径
 * @returns .venv 目录绝对路径
 */
export const ensureUvVenv = async (
  videoForgeDir: string,
  pythonPath: string,
): Promise<string> => {
  const venvDir = path.join(videoForgeDir, ".venv");
  const requirementsFile = path.join(videoForgeDir, "requirements.lock");

  // 检查 requirements.lock 是否存在
  if (!fs.existsSync(requirementsFile)) {
    throw new VenvSetupError(
      `找不到 ${requirementsFile}，请确保 services/video-forge/ 目录结构完整`
    );
  }

  // 幂等：如果 .venv 已存在且有 pyvenv.cfg，跳过创建
  const pyvenvCfg = path.join(venvDir, "pyvenv.cfg");
  if (fs.existsSync(pyvenvCfg)) {
    logger.info({ venvDir }, "Python 虚拟环境已存在，跳过 uv venv");
  } else {
    // 探测 uv 命令
    try {
      await execFileAsync("uv", ["--version"], { timeout: 10_000 });
    } catch {
      throw new VenvSetupError(
        "系统中未找到 uv 工具。请先安装：pip install uv（或参考 https://docs.astral.sh/uv/）"
      );
    }

    logger.info({ venvDir, pythonPath }, "正在创建 Python 虚拟环境 (uv venv)...");
    try {
      await execFileAsync("uv", ["venv", venvDir, "--python", pythonPath], {
        cwd: videoForgeDir,
        timeout: 60_000,
      });
      logger.info({ venvDir }, "虚拟环境创建成功");
    } catch (err: any) {
      throw new VenvSetupError(`uv venv 创建失败: ${err.stderr || err.message}`);
    }
  }

  // 安装依赖（每次都运行以确保同步，uv 内部有缓存，已安装的包秒过）
  logger.info("正在安装 Python 依赖 (uv pip install)...");
  try {
    await execFileAsync(
      "uv",
      ["pip", "install", "-r", requirementsFile, "--python", venvDir],
      {
        cwd: videoForgeDir,
        timeout: 600_000, // 首次安装可能较慢（10 分钟）
        env: {
          ...process.env,
          // uv 使用国内 PyPI 镜像加速
          UV_INDEX_URL: Env.UV_INDEX_URL,
        },
      },
    );
    logger.info("Python 依赖安装完成");
  } catch (err: any) {
    throw new VenvSetupError(`uv pip install 失败: ${err.stderr || err.message}`);
  }

  return venvDir;
};

/**
 * 组装子进程的环境变量（PATH 前置注入 ffmpeg/bin + .venv/Scripts|bin）
 *
 * 关键点（Spec v1.4 附录 A2）：
 * - ffmpeg/bin 前置注入：Pixelle video.py 用 shutil.which('ffmpeg') 只查 PATH
 *   （ffprobe.exe 放同一 bin/，自动随 PATH 可见）
 * - .venv/Scripts（Windows）或 .venv/bin（Linux/Mac）前置注入：子进程使用虚拟环境中的 Python
 * - PYTHONUNBUFFERED=1：确保日志实时输出（与 gateway-launcher.ts 一致）
 */
export const buildSpawnEnv = (
  ffmpegBinDir: string,
  venvDir: string,
): NodeJS.ProcessEnv => {
  // Python 虚拟环境的可执行文件目录
  const venvBinDir = process.platform === "win32"
    ? path.join(venvDir, "Scripts")
    : path.join(venvDir, "bin");

  // 前置注入到 PATH（ffmpeg 和 venv 优先级最高）
  const currentPath = process.env.PATH || process.env.Path || "";
  const separator = process.platform === "win32" ? ";" : ":";
  const newPath = [ffmpegBinDir, venvBinDir, currentPath].join(separator);

  return {
    ...process.env,
    PATH: newPath,
    Path: newPath,           // Windows 下 PATH 大小写不敏感，双保险
    PYTHONUNBUFFERED: "1",   // 与 gateway-launcher.ts L101 保持一致
    VIRTUAL_ENV: venvDir,    // 部分工具依赖此变量判断虚拟环境
  };
};

// ==================== 主函数 ====================

/**
 * 从给定起点向上查找含指定标识文件的目录（monorepo 根定位）。
 *
 * 背景：bootstrap.ts 在源码与打包后的目录层级不一致——
 * - 源码位置：packages/core/src/runtime/bootstrap.ts
 * - 打包位置：packages/core/dist/index.js（tsup bundle，扁平化）
 * 硬编码"上 N 级"会被打包结构"吃掉"一级，导致 monorepoRoot 越位。
 * 改为基于标识文件向上查找，可同时兼容源码和打包后的执行场景。
 *
 * @param startDir 起始目录（通常为 path.dirname(import.meta.url 解析后的路径)）
 * @param markers 标识文件名列表，第一个命中即返回（默认 pnpm-workspace.yaml）
 * @returns 找到的目录绝对路径；未找到返回 null
 */
export const findMonorepoRoot = (
  startDir: string,
  markers: readonly string[] = ["pnpm-workspace.yaml"],
): string | null => {
  let dir = startDir;
  // 最多上行 10 级，防止极端情况下的无限循环（正常场景 4-5 级就能命中）
  for (let i = 0; i < 10; i++) {
    for (const marker of markers) {
      if (fs.existsSync(path.join(dir, marker))) {
        return dir;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // 已到文件系统根（Windows: D:\；POSIX: /）
    dir = parent;
  }
  return null;
};

/**
 * 确保 video-forge 微服务的所有运行时依赖就绪
 *
 * 执行顺序：
 * 1. detectPython()      — 探测 Python >= 3.11（不下载，缺失直接报错）
 * 2. ffmpeg 探测/下载    — 优先便携版 → 系统 PATH → 镜像下载
 * 3. ffprobe 探测/下载   — 优先便携版 → 系统 PATH → 镜像下载
 *    （ffmpeg-static 只含 ffmpeg 不含 ffprobe，Python 端 ffmpeg.probe() 必需）
 * 4. ensureUvVenv()      — 创建 .venv 并安装依赖（可选跳过）
 * 5. buildSpawnEnv()     — 组装子进程环境变量
 *
 * @param options 配置选项
 * @returns 供 video-forge-supervisor.ts 使用的完整依赖信息
 */
export const ensureVideoForgeDeps = async (
  options: BootstrapOptions = {},
): Promise<VideoForgeDepsResult> => {
  logger.info("═══ Video-Forge Bootstrap 开始 ═══");

  // ── 解析目录 ──
  // 从当前文件位置推断 monorepo 根。
  // 注意：import.meta.url 的 pathname 会对空格等特殊字符做 URL 编码（"Super Lv" → "Super%20Lv"），
  // 必须 decodeURIComponent 还原，否则 ffmpegPath/videoForgeDir 会带 %20 传给子进程，
  // 导致 spawn/ffmpeg 子进程因 "路径不存在" 抛 WinError 2。
  const rawPath = new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1");
  const currentDir = path.dirname(decodeURIComponent(rawPath));

  // 根治：不能硬编码"上 N 级"——源码位置 packages/core/src/runtime/ 与打包位置
  // packages/core/dist/ 层级不一致，tsup 会把 bootstrap.ts 打进 dist/index.js，
  // 导致 path.resolve(currentDir, "../../../..") 在打包后越位到项目根，
  // 进而让 ffmpegDir 指向错误的 <projectRoot>/runtime/ffmpeg 而不是 super-agent/runtime/ffmpeg。
  // 改为基于标识文件 pnpm-workspace.yaml 向上查找，永远找对 monorepo 根。
  const detectedRoot = findMonorepoRoot(currentDir);
  if (!detectedRoot && !options.monorepoRoot) {
    logger.warn(
      { currentDir },
      "⚠ 未能通过 pnpm-workspace.yaml 定位 monorepo 根，回退到相对路径推断（可能不准确）",
    );
  }
  const defaultRoot = detectedRoot || path.resolve(currentDir, "../../../..");
  const monorepoRoot = options.monorepoRoot || defaultRoot;
  const ffmpegDir = options.ffmpegDir || path.join(monorepoRoot, "runtime", "ffmpeg");
  const videoForgeDir = options.videoForgeDir || path.join(monorepoRoot, "services", "video-forge");

  logger.info({ monorepoRoot, ffmpegDir, videoForgeDir }, "目录解析完成");

  // ── Step 1: Python 探测 ──
  const python = await detectPython();

  // ── Step 2: ffmpeg 探测 + 兜底下载 ──
  const ffmpegBinDir = path.join(ffmpegDir, "bin");
  const ffmpegExeName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const localFfmpeg = path.join(ffmpegBinDir, ffmpegExeName);

  let ffmpegPath: string;

  // 优先检查已下载到 runtime/ 的便携版
  if (fs.existsSync(localFfmpeg)) {
    logger.info({ localFfmpeg }, "使用已下载的 ffmpeg 便携版");
    ffmpegPath = localFfmpeg;
  } else {
    // 检查系统 PATH
    const systemFfmpeg = await detectFfmpeg();
    if (systemFfmpeg) {
      ffmpegPath = systemFfmpeg;
    } else {
      // 系统也没有，从镜像下载
      ffmpegPath = await downloadFfmpeg(ffmpegDir);
    }
  }

  // ── Step 3: ffprobe 探测 + 兜底下载 ──
  // T6 frame-composition 及多处 Python 代码依赖 ffmpeg.probe()，必须有 ffprobe。
  // ffmpeg-static 只含 ffmpeg 不含 ffprobe，因此独立处理。
  const ffprobeExeName = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
  const localFfprobe = path.join(ffmpegBinDir, ffprobeExeName);

  let ffprobePath: string;

  if (fs.existsSync(localFfprobe)) {
    logger.info({ localFfprobe }, "使用已下载的 ffprobe 便携版");
    ffprobePath = localFfprobe;
  } else {
    const systemFfprobe = await detectFfprobe();
    if (systemFfprobe) {
      ffprobePath = systemFfprobe;
    } else {
      // 下载到与 ffmpeg 同目录 runtime/ffmpeg/bin/，天然随 PATH 前置注入可见
      ffprobePath = await downloadFfprobe(ffmpegDir);
    }
  }

  // ── Step 4: venv 自举（可选跳过） ──
  let venvDir: string;
  if (options.skipVenv) {
    venvDir = path.join(videoForgeDir, ".venv");
    logger.info("跳过 venv 创建（skipVenv=true）");
  } else {
    venvDir = await ensureUvVenv(videoForgeDir, python.path);
  }

  // ── Step 5: 组装环境变量 ──
  // 注入 PATH 的 bin 目录：
  // - 如果 ffmpeg/ffprobe 来自便携版，其目录就是 ffmpegBinDir
  // - 如果来自系统 PATH，便携版目录不存在但无害（仍注入，保证一致性）
  // 优先使用 ffprobePath 的目录：通常 ffmpeg/ffprobe 同目录；
  // 系统 PATH 场景下 path.dirname("ffprobe") === "."，此时 fallback ffmpegBinDir。
  const probeBinDir = path.dirname(ffprobePath);
  const finalBinDir = probeBinDir === "." ? ffmpegBinDir : probeBinDir;

  const spawnEnv = buildSpawnEnv(finalBinDir, venvDir);

  const result: VideoForgeDepsResult = {
    pythonPath: python.path,
    pythonVersion: python.version,
    ffmpegPath,
    ffprobePath,
    venvDir,
    spawnEnv,
  };

  logger.info(
    {
      pythonPath: result.pythonPath,
      pythonVersion: result.pythonVersion,
      ffmpegPath: result.ffmpegPath,
      ffprobePath: result.ffprobePath,
      venvDir: result.venvDir,
    },
    "═══ Video-Forge Bootstrap 完成 ═══",
  );

  return result;
};

// ==================== 内部工具 ====================

/**
 * 将 Web API 的 ReadableStream 转换为 Node.js 的 Readable
 * （fetch() 返回的 body 是 Web ReadableStream，pipeline() 需要 Node.js stream）
 */
function readableStreamToNodeStream(
  webStream: ReadableStream<Uint8Array>,
): Readable {
  const reader = webStream.getReader();
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null);
        } else {
          this.push(Buffer.from(value));
        }
      } catch (err) {
        this.destroy(err as Error);
      }
    },
  });
}
