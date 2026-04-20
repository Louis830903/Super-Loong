/**
 * 媒体本地临时存储模块
 *
 * 对标 OpenClaw store.ts:
 * - UUID 命名防冲突
 * - TTL 自动清理过期文件
 * - 并发安全: 目录被清理后自动重建重试 (retryAfterRecreatingDir)
 * - Claim-Check 模式: 大二进制落盘，通过路径引用
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { resolveHome } from "../config/index.js";
import {
  MEDIA_STORE_DIR,
  MEDIA_INBOUND_DIR,
  MEDIA_OUTBOUND_DIR,
  MEDIA_MAX_BYTES,
  MEDIA_TTL_MS,
} from "./constants.js";
import { detectMime, mimeToExt, kindFromMime } from "./mime.js";
import { assertSizeAllowed, assertNotInternalUrl } from "./security.js";

// ─── 类型定义 ───────────────────────────────────────────────

export interface SavedMedia {
  /** 存储后的本地绝对路径 */
  path: string;
  /** UUID 标识 */
  id: string;
  /** MIME 类型 */
  contentType: string;
  /** 文件大小 (字节) */
  size: number;
}

// ─── 路径工具 ───────────────────────────────────────────────

/** 解析媒体存储根目录的绝对路径 */
function resolveMediaRoot(): string {
  return path.join(resolveHome(), MEDIA_STORE_DIR);
}

/** 解析子目录的绝对路径 */
function resolveSubdir(subdir: "inbound" | "outbound"): string {
  const sub = subdir === "inbound" ? MEDIA_INBOUND_DIR : MEDIA_OUTBOUND_DIR;
  return path.join(resolveMediaRoot(), sub);
}

// ─── 初始化 ────────────────────────────────────────────────

/**
 * 初始化媒体存储目录
 * 确保 inbound/outbound 子目录存在
 */
export async function initMediaStore(): Promise<void> {
  const root = resolveMediaRoot();
  await fs.mkdir(path.join(root, MEDIA_INBOUND_DIR), { recursive: true });
  await fs.mkdir(path.join(root, MEDIA_OUTBOUND_DIR), { recursive: true });
}

// ─── 保存 ─────────────────────────────────────────────────

/**
 * 保存 Buffer 到本地临时存储
 *
 * 对标 OpenClaw saveMediaBuffer:
 * - UUID 命名防冲突
 * - 写入前自动清理过期文件
 * - 并发安全: 目录被清理后自动重建重试
 *
 * @param buffer 文件数据
 * @param contentType MIME 类型
 * @param subdir 子目录 (inbound/outbound)
 * @param maxBytes 最大字节数限制
 * @param originalFilename 原始文件名 (用于保留扩展名)
 */
export async function saveMediaBuffer(
  buffer: Buffer,
  contentType: string,
  subdir: "inbound" | "outbound" = "inbound",
  maxBytes: number = MEDIA_MAX_BYTES,
  originalFilename?: string
): Promise<SavedMedia> {
  // 大小检查
  assertSizeAllowed(buffer.length, maxBytes);

  // 写入前清理过期文件
  await cleanExpiredMedia().catch(() => {});

  const dir = resolveSubdir(subdir);
  const baseId = crypto.randomUUID();

  // 推断扩展名: 优先从原始文件名取，其次从 MIME 推断
  const ext = originalFilename
    ? path.extname(originalFilename).toLowerCase()
    : mimeToExt(contentType);

  // 构建文件名: UUID + 扩展名
  const filename = `${baseId}${ext}`;
  const filePath = path.join(dir, filename);

  // 写入文件 — 并发安全重试
  await retryAfterRecreatingDir(dir, async () => {
    await fs.writeFile(filePath, buffer, { mode: 0o600 });
  });

  return {
    path: filePath,
    id: baseId,
    contentType,
    size: buffer.length,
  };
}

/**
 * 从 URL 下载并保存到本地临时存储
 *
 * 对标 OpenClaw downloadToFile:
 * - SSRF 防护
 * - 流式下载 + 大小限制检查
 * - 自动 MIME 嗅探
 */
export async function saveMediaFromUrl(
  url: string,
  subdir: "inbound" | "outbound" = "inbound",
  maxBytes: number = MEDIA_MAX_BYTES
): Promise<SavedMedia> {
  // SSRF 防护
  assertNotInternalUrl(url);

  // 下载文件
  const response = await fetch(url, {
    headers: { "User-Agent": "SuperAgent/1.0" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} — ${url}`);
  }

  // 读取 body 为 Buffer，并检查大小
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  assertSizeAllowed(buffer.length, maxBytes);

  // MIME 检测: 优先使用响应头，其次 magic bytes + URL 扩展名
  const declaredMime = response.headers.get("content-type")?.split(";")[0].trim();
  const contentType = await detectMime({
    buffer,
    filePath: new URL(url).pathname,
    declaredMime: declaredMime ?? undefined,
  });

  // 从 URL 推断原始文件名
  const urlPath = new URL(url).pathname;
  const originalFilename = path.basename(urlPath) || undefined;

  return saveMediaBuffer(buffer, contentType, subdir, maxBytes, originalFilename);
}

// ─── TTL 清理 ──────────────────────────────────────────────

/**
 * TTL 自动清理过期文件
 *
 * 对标 OpenClaw cleanOldMedia:
 * - 递归扫描 inbound/outbound 目录
 * - 删除超过 TTL 的文件
 * - 清理空子目录
 */
export async function cleanExpiredMedia(ttlMs: number = MEDIA_TTL_MS): Promise<void> {
  const root = resolveMediaRoot();
  const now = Date.now();

  for (const subdir of [MEDIA_INBOUND_DIR, MEDIA_OUTBOUND_DIR]) {
    const dir = path.join(root, subdir);
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const filePath = path.join(dir, entry.name);
        try {
          const stat = await fs.stat(filePath);
          if (now - stat.mtimeMs > ttlMs) {
            await fs.unlink(filePath);
          }
        } catch {
          // 文件可能已被其他进程删除，忽略
        }
      }
    } catch {
      // 目录可能不存在，忽略
    }
  }
}

/**
 * 获取媒体文件信息 (按 ID 查找)
 */
export async function getMediaById(id: string): Promise<SavedMedia | null> {
  const root = resolveMediaRoot();

  for (const subdir of [MEDIA_INBOUND_DIR, MEDIA_OUTBOUND_DIR]) {
    const dir = path.join(root, subdir);
    try {
      const entries = await fs.readdir(dir);
      const match = entries.find((name) => name.startsWith(id));
      if (match) {
        const filePath = path.join(dir, match);
        const stat = await fs.stat(filePath);
        const contentType = await detectMime({ filePath });
        return {
          path: filePath,
          id,
          contentType,
          size: stat.size,
        };
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ─── 内部工具 ──────────────────────────────────────────────

/**
 * 并发安全重试 — 目录被清理后自动重建
 *
 * 对标 OpenClaw retryAfterRecreatingDir:
 * 当写入操作因目录不存在失败时，自动重建目录并重试一次
 */
async function retryAfterRecreatingDir(
  dir: string,
  operation: () => Promise<void>
): Promise<void> {
  try {
    await operation();
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      // 目录可能被 TTL 清理删除了，重建后重试
      await fs.mkdir(dir, { recursive: true });
      await operation();
    } else {
      throw err;
    }
  }
}
