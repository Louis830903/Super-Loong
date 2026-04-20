/**
 * 媒体安全守卫模块
 *
 * 对标 OpenClaw local-media-access.ts 的白名单路径验证
 * + SSRF 防护 + 大小限制 + MIME 安全检查
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  MEDIA_MAX_BYTES,
  BLOCKED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  INTERNAL_IP_PATTERNS,
  INTERNAL_HOSTNAMES,
} from "./constants.js";
import { isMimeSafe, isExtensionSafe } from "./mime.js";

// ─── 错误类型 ───────────────────────────────────────────────

export type MediaSecurityCode =
  | "path-traversal"
  | "symlink"
  | "ssrf"
  | "size-exceeded"
  | "mime-blocked"
  | "extension-blocked"
  | "network-path";

/** 媒体安全验证错误 */
export class MediaSecurityError extends Error {
  public readonly code: MediaSecurityCode;
  constructor(code: MediaSecurityCode, message: string) {
    super(message);
    this.name = "MediaSecurityError";
    this.code = code;
  }
}

// ─── 路径安全 ───────────────────────────────────────────────

/**
 * 路径白名单验证 — 防止路径遍历攻击
 *
 * 对标 OpenClaw assertLocalMediaAllowed:
 * 1. 拒绝 Windows 网络路径 (\\server\share)
 * 2. 拒绝包含 .. 的路径遍历
 * 3. 通过 realpath 解析后检查是否在白名单目录内
 * 4. 拒绝 symlink 逃逸
 */
export async function assertPathAllowed(
  filePath: string,
  allowedRoots: string[]
): Promise<void> {
  // 1. 拒绝 Windows 网络路径 (UNC)
  if (filePath.startsWith("\\\\") || filePath.startsWith("//")) {
    throw new MediaSecurityError(
      "network-path",
      `网络路径不允许: ${filePath}`
    );
  }

  // 2. 路径遍历检查 (拒绝 ..)
  const normalized = path.normalize(filePath);
  if (normalized.includes("..")) {
    throw new MediaSecurityError(
      "path-traversal",
      `路径遍历不允许: ${filePath}`
    );
  }

  // 3. 扩展名安全检查
  if (!isExtensionSafe(filePath)) {
    throw new MediaSecurityError(
      "extension-blocked",
      `危险文件扩展名: ${path.extname(filePath)}`
    );
  }

  // 4. 如果提供了白名单，检查 realpath 是否在白名单内
  if (allowedRoots.length > 0) {
    let realFilePath: string;
    try {
      realFilePath = await fs.realpath(filePath);
    } catch {
      // 文件不存在或无法解析 realpath
      throw new MediaSecurityError(
        "path-traversal",
        `无法解析路径: ${filePath}`
      );
    }

    const absFilePath = path.resolve(filePath);
    // Symlink 检查: realpath 结果应与 resolve 结果一致
    if (realFilePath !== absFilePath) {
      throw new MediaSecurityError(
        "symlink",
        `符号链接不允许: ${filePath} → ${realFilePath}`
      );
    }

    // 白名单目录检查
    let allowed = false;
    for (const root of allowedRoots) {
      const resolvedRoot = path.resolve(root);
      if (realFilePath.startsWith(resolvedRoot + path.sep) || realFilePath === resolvedRoot) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      throw new MediaSecurityError(
        "path-traversal",
        `路径不在允许的目录范围内: ${filePath}`
      );
    }
  }
}

// ─── SSRF 防护 ──────────────────────────────────────────────

/**
 * SSRF 防护 — 拒绝内网地址
 *
 * 检查 URL 的主机名/IP 是否为内网地址:
 * - 127.0.0.1, localhost
 * - 10.*, 172.16-31.*, 192.168.*
 * - IPv6 本地地址
 * - 仅允许 http:// 和 https:// 协议
 */
export function assertNotInternalUrl(urlStr: string): void {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new MediaSecurityError("ssrf", `无效的 URL: ${urlStr}`);
  }

  // 仅允许 http/https 协议
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new MediaSecurityError(
      "ssrf",
      `不允许的协议: ${parsed.protocol} (仅支持 http/https)`
    );
  }

  const hostname = parsed.hostname.toLowerCase();

  // 检查主机名黑名单
  if (INTERNAL_HOSTNAMES.has(hostname)) {
    throw new MediaSecurityError(
      "ssrf",
      `内网主机名不允许: ${hostname}`
    );
  }

  // 检查 IP 模式
  for (const pattern of INTERNAL_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      throw new MediaSecurityError(
        "ssrf",
        `内网 IP 地址不允许: ${hostname}`
      );
    }
  }
}

// ─── 大小限制 ───────────────────────────────────────────────

/**
 * 文件大小检查
 */
export function assertSizeAllowed(
  size: number,
  maxBytes: number = MEDIA_MAX_BYTES
): void {
  if (size > maxBytes) {
    const maxMB = (maxBytes / (1024 * 1024)).toFixed(1);
    const actualMB = (size / (1024 * 1024)).toFixed(2);
    throw new MediaSecurityError(
      "size-exceeded",
      `文件大小 ${actualMB}MB 超过 ${maxMB}MB 限制`
    );
  }
}

// ─── MIME 安全 ──────────────────────────────────────────────

/**
 * MIME 类型验证 — 拒绝可执行文件等危险类型
 */
export function assertMimeAllowed(mime: string): void {
  if (!isMimeSafe(mime)) {
    throw new MediaSecurityError(
      "mime-blocked",
      `不允许的 MIME 类型: ${mime}`
    );
  }
}
