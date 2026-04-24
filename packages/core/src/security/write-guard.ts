/**
 * Write Guard — 文件写入保护
 *
 * 独立模块，不修改 SecurityManager 或 sandbox.ts。
 * 仅被 terminal 工具内部调用。
 *
 * 参考: hermes-agent/tools/path_security.py (44行)
 * - validate_within_dir(): 路径穿越检测
 * - has_traversal_component(): .. 组件检测
 *
 * 功能:
 * 1. 安全根目录限制 — 所有写入必须在指定目录树内
 * 2. 路径穿越防护 — 检测 .. 和符号链接绕过
 * 3. 关键路径拒绝 — ~/.ssh, /etc, /boot 等
 */

import path from "node:path";
import fs from "node:fs";
import pino from "pino";

const logger = pino({ name: "write-guard" });

// ─── 类型定义 ──────────────────────────────────────────────

export interface WriteGuardResult {
  /** 路径是否安全 */
  allowed: boolean;
  /** 拒绝原因 */
  reason?: string;
  /** 规范化后的路径 */
  resolvedPath?: string;
}

// ─── 关键路径拒绝列表 ──────────────────────────────────────

/** 绝对禁止写入的路径前缀 */
const BLOCKED_PATHS_UNIX = [
  "/etc/", "/boot/", "/usr/", "/sbin/", "/lib/", "/lib64/",
  "/sys/", "/dev/", "/proc/", "/root/",
];

const BLOCKED_PATHS_WIN = [
  "C:\\Windows\\", "C:\\Program Files\\", "C:\\Program Files (x86)\\",
];

/** 用户主目录下的敏感子目录 */
const BLOCKED_HOME_SUBDIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config/gcloud",
  ".kube", ".docker", ".npmrc", ".pypirc",
];

// ─── 核心检测函数 ──────────────────────────────────────────

/**
 * 检测路径中是否包含穿越组件 (..)
 *
 * 参考 Hermes has_traversal_component()
 */
export function hasTraversalComponent(targetPath: string): boolean {
  const normalized = path.normalize(targetPath);
  const parts = normalized.split(path.sep);
  return parts.includes("..");
}

/**
 * 验证路径是否在安全根目录内
 *
 * 参考 Hermes validate_within_dir()
 *
 * @param targetPath 目标路径
 * @param safeRoot 安全根目录
 * @returns 是否在安全目录内
 */
export function validateWithinDir(targetPath: string, safeRoot: string): boolean {
  try {
    // 使用 realpath 解析符号链接
    const resolvedTarget = fs.realpathSync(path.resolve(targetPath));
    const resolvedRoot = fs.realpathSync(path.resolve(safeRoot));

    // 检查解析后的路径是否在根目录内
    return resolvedTarget.startsWith(resolvedRoot + path.sep) || resolvedTarget === resolvedRoot;
  } catch {
    // 如果路径不存在，使用 resolve 检查（不解析符号链接）
    const resolved = path.resolve(targetPath);
    const root = path.resolve(safeRoot);
    return resolved.startsWith(root + path.sep) || resolved === root;
  }
}

/**
 * 检查路径是否在阻止列表中
 */
function isBlockedPath(targetPath: string): { blocked: boolean; reason?: string } {
  const normalized = path.resolve(targetPath);
  const isWin = process.platform === "win32";
  const homeDir = process.env.HOME || process.env.USERPROFILE || "";

  // 检查系统级阻止路径
  const blockedPaths = isWin ? BLOCKED_PATHS_WIN : BLOCKED_PATHS_UNIX;
  for (const blocked of blockedPaths) {
    if (normalized.startsWith(blocked) || normalized.toLowerCase().startsWith(blocked.toLowerCase())) {
      return { blocked: true, reason: `系统保护目录: ${blocked}` };
    }
  }

  // 检查用户主目录下的敏感子目录
  if (homeDir) {
    for (const subdir of BLOCKED_HOME_SUBDIRS) {
      const fullPath = path.join(homeDir, subdir);
      if (normalized.startsWith(fullPath)) {
        return { blocked: true, reason: `敏感用户目录: ~/${subdir}` };
      }
    }
  }

  return { blocked: false };
}

/**
 * 综合检查路径写入安全性
 *
 * 纯函数 — 不产生副作用。
 *
 * @param targetPath 目标写入路径
 * @param safeRoot 可选的安全根目录（配置后所有写入必须在此目录内）
 * @returns 检查结果
 */
export function checkWritePath(
  targetPath: string,
  safeRoot?: string,
): WriteGuardResult {
  // 1. 路径穿越检测
  if (hasTraversalComponent(targetPath)) {
    return {
      allowed: false,
      reason: `路径包含穿越组件(..): ${targetPath}`,
    };
  }

  // 2. 阻止列表检查
  const blockCheck = isBlockedPath(targetPath);
  if (blockCheck.blocked) {
    return {
      allowed: false,
      reason: blockCheck.reason,
    };
  }

  // 3. 安全根目录限制（如果配置了）
  if (safeRoot) {
    if (!validateWithinDir(targetPath, safeRoot)) {
      return {
        allowed: false,
        reason: `路径不在安全根目录内: ${targetPath} (允许: ${safeRoot})`,
      };
    }
  }

  // 4. 解析最终路径
  const resolvedPath = path.resolve(targetPath);

  return {
    allowed: true,
    resolvedPath,
  };
}
