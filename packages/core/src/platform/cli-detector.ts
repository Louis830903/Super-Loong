/**
 * CLI Detector — CLI工具存在性检测器
 *
 * 检测系统上已安装的CLI工具，缓存检测结果。
 * 为后续的运维/开发/桌面工具提供可用性信息。
 *
 * 安全设计:
 * - 复用 readiness.ts 的 SAFE_BINARY_NAME 白名单校验，防止命令注入
 * - 所有检测通过 which/where 命令执行，不执行任何被检测的命令本身
 * - 检测结果缓存在内存中，仅首次检测时执行系统调用
 */

import { spawnSync } from "node:child_process";
import pino from "pino";
import { getPlatformInfo } from "./adapter.js";

const logger = pino({ name: "cli-detector" });

// ─── CLI工具分类清单 ──────────────────────────────────────────

/** 系统级CLI — 容器/远程/核心工具 */
export const SYSTEM_CLIS = [
  "docker", "podman", "ssh", "git", "curl", "wget", "jq", "tar", "zip", "unzip",
] as const;

/** 开发工具CLI — 语言运行时/包管理器 */
export const DEV_CLIS = [
  "node", "npm", "pnpm", "yarn", "bun",
  "python", "python3", "pip", "pip3", "uv",
  "go", "rustc", "cargo",
  "java", "javac", "mvn", "gradle",
  "brew", "apt", "yum", "dnf", "pacman", "choco", "winget", "scoop",
] as const;

/** 运维CLI — 编排/部署/监控 */
export const OPS_CLIS = [
  "docker-compose", "kubectl", "terraform", "ansible", "ansible-playbook",
  "nginx", "pm2", "supervisorctl",
  "systemctl", "launchctl", "sc.exe",
] as const;

/** 桌面控制CLI — GUI自动化 */
export const DESKTOP_CLIS = [
  "osascript", "screencapture",              // macOS
  "xdotool", "wmctrl", "scrot", "xclip",    // Linux X11
  "cliclick",                                 // macOS 第三方
] as const;

/** 外部增强CLI — 第三方集成 */
export const EXTERNAL_CLIS = [
  "autocli", "gh", "glab",                   // GitHub/GitLab CLI
  "aws", "gcloud", "az",                     // 云平台CLI
  "flyctl", "vercel", "railway",             // PaaS CLI
] as const;

/** 所有CLI分类的联合类型 */
export type CLICategory = "system" | "dev" | "ops" | "desktop" | "external";

/** CLI分类映射 */
export const CLI_CATEGORIES: Record<CLICategory, readonly string[]> = {
  system: SYSTEM_CLIS,
  dev: DEV_CLIS,
  ops: OPS_CLIS,
  desktop: DESKTOP_CLIS,
  external: EXTERNAL_CLIS,
};

// ─── 检测结果类型 ──────────────────────────────────────────

export interface CLIDetectionResult {
  /** CLI工具名称 */
  name: string;
  /** 是否可用 */
  available: boolean;
  /** 所属分类 */
  category: CLICategory;
  /** 可选: 版本信息(暂不实现，预留接口) */
  version?: string;
}

export interface CLIScanResult {
  /** 所有已安装的CLI列表 */
  installed: string[];
  /** 按分类的安装情况 */
  byCategory: Record<CLICategory, string[]>;
  /** 检测耗时(ms) */
  scanDurationMs: number;
  /** 完整检测结果 */
  details: CLIDetectionResult[];
}

// ─── 安全校验 ──────────────────────────────────────────────

/**
 * 合法二进制名白名单 — 与 readiness.ts SAFE_BINARY_NAME 保持一致
 * 仅允许字母、数字、点、下划线、连字符
 */
const SAFE_BINARY_NAME = /^[a-zA-Z0-9._-]+$/;

// ─── 核心检测函数 ──────────────────────────────────────────

/**
 * 检查单个CLI工具是否已安装
 *
 * 安全措施:
 * - 名称必须通过 SAFE_BINARY_NAME 白名单校验
 * - 使用 which(Unix)/where(Windows) 检测，不执行目标命令
 * - 超时 3 秒防止挂起
 *
 * @param name CLI工具名称
 * @returns 是否已安装
 */
export function hasBinary(name: string): boolean {
  // 安全校验: 拒绝包含 shell 特殊字符的名称
  if (!SAFE_BINARY_NAME.test(name)) {
    logger.warn({ name }, "不合法的CLI名称，跳过检测");
    return false;
  }

  try {
    const cmd = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(cmd, [name], {
      stdio: "ignore",
      timeout: 3000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

// ─── 缓存机制 ──────────────────────────────────────────────

/** 检测结果缓存 — 避免重复系统调用 */
let _cachedScanResult: CLIScanResult | null = null;

/**
 * 扫描系统上所有已安装的CLI工具
 *
 * 首次调用时执行全量扫描，后续调用返回缓存结果。
 * 扫描范围: system + dev + ops + desktop + external 共 ~50 个工具。
 *
 * 性能: 每个工具的 which/where 调用约 5-20ms，
 * 总扫描时间约 200-800ms（取决于系统），仅首次启动时执行。
 *
 * @param force 强制重新扫描（忽略缓存）
 * @returns 扫描结果
 */
export function scanInstalledCLIs(force = false): CLIScanResult {
  if (_cachedScanResult && !force) return _cachedScanResult;

  const startTime = Date.now();
  const details: CLIDetectionResult[] = [];
  const byCategory: Record<CLICategory, string[]> = {
    system: [],
    dev: [],
    ops: [],
    desktop: [],
    external: [],
  };

  const platform = getPlatformInfo();

  // 按分类检测
  for (const [category, clis] of Object.entries(CLI_CATEGORIES) as [CLICategory, readonly string[]][]) {
    for (const name of clis) {
      // 跳过当前平台不适用的CLI（减少无意义检测）
      if (shouldSkipForPlatform(name, platform.os)) {
        details.push({ name, available: false, category });
        continue;
      }

      const available = hasBinary(name);
      details.push({ name, available, category });
      if (available) {
        byCategory[category].push(name);
      }
    }
  }

  const installed = details.filter(d => d.available).map(d => d.name);
  const scanDurationMs = Date.now() - startTime;

  _cachedScanResult = { installed, byCategory, scanDurationMs, details };

  logger.info(
    { installed: installed.length, total: details.length, durationMs: scanDurationMs },
    "CLI工具扫描完成",
  );

  return _cachedScanResult;
}

/**
 * 检测特定分类的CLI工具
 *
 * @param category CLI分类
 * @returns 该分类下已安装的工具列表
 */
export function detectCLIsByCategory(category: CLICategory): string[] {
  const result = scanInstalledCLIs();
  return result.byCategory[category];
}

/**
 * 快速检测特定CLI工具列表的可用性
 *
 * 不走全量扫描缓存，适用于按需检测小批量工具。
 *
 * @param names 工具名称列表
 * @returns 可用的工具名称列表
 */
export function detectCLIs(names: string[]): string[] {
  return names.filter(name => hasBinary(name));
}

/**
 * 获取当前平台的已安装CLI摘要文本
 * 用于注入到系统 Prompt 中
 */
export function getInstalledCLISummary(): string {
  const result = scanInstalledCLIs();
  const parts: string[] = [];

  for (const [category, clis] of Object.entries(result.byCategory)) {
    if (clis.length > 0) {
      const label = CLI_CATEGORY_LABELS[category as CLICategory] || category;
      parts.push(`${label}: ${clis.join(", ")}`);
    }
  }

  return parts.join("\n");
}

/**
 * 清除扫描缓存（仅用于测试）
 */
export function _resetCLICache(): void {
  _cachedScanResult = null;
}

// ─── 内部辅助 ──────────────────────────────────────────────

/** 分类人类可读标签 */
const CLI_CATEGORY_LABELS: Record<CLICategory, string> = {
  system: "系统工具",
  dev: "开发工具",
  ops: "运维工具",
  desktop: "桌面控制",
  external: "外部工具",
};

/**
 * 判断某CLI在当前平台是否应跳过检测
 * 避免在 Windows 上检测 osascript，在 macOS 上检测 sc.exe 等
 */
/** 平台专属工具集 — 提升到模块级避免每次调用重复创建 */
const MAC_ONLY  = new Set(["osascript", "screencapture", "launchctl", "cliclick"]);
const LINUX_ONLY = new Set(["xdotool", "wmctrl", "scrot", "xclip", "systemctl"]);
const WIN_ONLY  = new Set(["sc.exe", "choco", "winget", "scoop"]);

function shouldSkipForPlatform(name: string, os: string): boolean {
  if (os === "win32" && (MAC_ONLY.has(name) || LINUX_ONLY.has(name))) return true;
  if (os === "darwin" && (LINUX_ONLY.has(name) || WIN_ONLY.has(name))) return true;
  if (os === "linux" && (MAC_ONLY.has(name) || WIN_ONLY.has(name))) return true;

  return false;
}
