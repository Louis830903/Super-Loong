/**
 * 统一媒体加载器
 *
 * 对标 OpenClaw web-media.ts 的 loadWebMedia + outbound-attachment.ts
 * 提供统一的媒体加载入口，支持 URL / 本地路径 / Base64 三种来源
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { Attachment, MediaDescriptor, MediaKind } from "../types/index.js";
import { MEDIA_MAX_BYTES } from "./constants.js";
import { detectMime, kindFromMime, inferFilename } from "./mime.js";
import { assertPathAllowed, assertSizeAllowed, assertNotInternalUrl, assertMimeAllowed } from "./security.js";
import { saveMediaBuffer, type SavedMedia } from "./store.js";
import { stripMediaPrefix } from "./parse.js";

// ─── 类型定义 ───────────────────────────────────────────────

export interface LoadMediaOptions {
  /** 安全白名单目录列表 (为空则不做路径白名单检查) */
  allowedRoots?: string[];
  /** 最大文件字节数 */
  maxBytes?: number;
}

// ─── 公开 API ───────────────────────────────────────────────

/**
 * 统一媒体加载入口 — 对标 OpenClaw loadWebMedia
 *
 * 支持 3 种来源:
 * 1. URL (http/https) → 下载 + SSRF 防护
 * 2. 本地路径 → 读取 + 白名单校验
 * 3. Base64 → 解码 + MIME 检测
 *
 * 自动完成:
 * - MEDIA: 前缀剥离
 * - MIME 嗅探 (magic bytes + 扩展名)
 * - MediaKind 推断
 * - 文件名推断
 * - 大小限制校验
 * - MIME 安全检查
 */
export async function loadMedia(
  source: string | Attachment,
  options?: LoadMediaOptions
): Promise<MediaDescriptor> {
  const maxBytes = options?.maxBytes ?? MEDIA_MAX_BYTES;
  const allowedRoots = options?.allowedRoots ?? [];

  // 如果传入的是 Attachment 对象，按优先级选择来源
  if (typeof source !== "string") {
    return loadFromAttachment(source, { allowedRoots, maxBytes });
  }

  // 字符串来源: 剥离 MEDIA: 前缀
  const cleaned = stripMediaPrefix(source);

  // 判断来源类型
  if (/^https?:\/\//i.test(cleaned)) {
    return loadFromUrl(cleaned, maxBytes);
  }

  if (isBase64(cleaned)) {
    return loadFromBase64(cleaned, maxBytes);
  }

  // 默认当作本地路径
  return loadFromLocalPath(cleaned, allowedRoots, maxBytes);
}

/**
 * 出站附件解析 — 对标 OpenClaw resolveOutboundAttachmentFromUrl
 * 加载 → 保存到 outbound → 返回本地路径信息
 */
export async function resolveOutboundAttachment(
  source: string | Attachment,
  options?: LoadMediaOptions
): Promise<SavedMedia> {
  const descriptor = await loadMedia(source, options);
  return saveMediaBuffer(
    descriptor.buffer,
    descriptor.contentType,
    "outbound",
    options?.maxBytes,
    descriptor.filename
  );
}

// ─── 内部加载实现 ──────────────────────────────────────────

/**
 * 从 Attachment 对象加载 — 按优先级: base64 > url > path
 */
async function loadFromAttachment(
  att: Attachment,
  opts: { allowedRoots: string[]; maxBytes: number }
): Promise<MediaDescriptor> {
  if (att.base64) {
    return loadFromBase64(att.base64, opts.maxBytes, att.mimeType, att.filename);
  }
  if (att.url) {
    return loadFromUrl(att.url, opts.maxBytes, att.mimeType, att.filename);
  }
  if (att.path) {
    return loadFromLocalPath(att.path, opts.allowedRoots, opts.maxBytes, att.mimeType, att.filename);
  }
  throw new Error("Attachment 必须提供 path、url 或 base64 中的至少一个");
}

/**
 * 从 URL 下载媒体
 */
async function loadFromUrl(
  url: string,
  maxBytes: number,
  declaredMime?: string,
  declaredFilename?: string
): Promise<MediaDescriptor> {
  // SSRF 防护
  assertNotInternalUrl(url);

  const response = await fetch(url, {
    headers: { "User-Agent": "SuperAgent/1.0" },
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`下载失败: HTTP ${response.status} — ${url}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  assertSizeAllowed(buffer.length, maxBytes);

  const responseMime = response.headers.get("content-type")?.split(";")[0].trim();
  const contentType = await detectMime({
    buffer,
    filePath: new URL(url).pathname,
    declaredMime: declaredMime ?? responseMime ?? undefined,
  });

  assertMimeAllowed(contentType);

  const filename = declaredFilename ?? inferFilename(new URL(url).pathname, contentType);
  const kind = kindFromMime(contentType);

  return { localPath: "", buffer, contentType, kind, filename, size: buffer.length };
}

/**
 * 从本地路径读取媒体
 */
async function loadFromLocalPath(
  filePath: string,
  allowedRoots: string[],
  maxBytes: number,
  declaredMime?: string,
  declaredFilename?: string
): Promise<MediaDescriptor> {
  // 安全检查
  if (allowedRoots.length > 0) {
    await assertPathAllowed(filePath, allowedRoots);
  }

  const buffer = await fs.readFile(filePath);
  assertSizeAllowed(buffer.length, maxBytes);

  const contentType = await detectMime({
    buffer,
    filePath,
    declaredMime,
  });

  assertMimeAllowed(contentType);

  const filename = declaredFilename ?? inferFilename(filePath, contentType);
  const kind = kindFromMime(contentType);

  return { localPath: filePath, buffer, contentType, kind, filename, size: buffer.length };
}

/**
 * 从 Base64 解码媒体
 */
async function loadFromBase64(
  base64Str: string,
  maxBytes: number,
  declaredMime?: string,
  declaredFilename?: string
): Promise<MediaDescriptor> {
  // 去除可能的 data URI 前缀 (data:image/png;base64,...)
  let raw = base64Str;
  let dataMime: string | undefined;

  const dataUriMatch = raw.match(/^data:([^;]+);base64,/);
  if (dataUriMatch) {
    dataMime = dataUriMatch[1];
    raw = raw.slice(dataUriMatch[0].length);
  }

  const buffer = Buffer.from(raw, "base64");
  assertSizeAllowed(buffer.length, maxBytes);

  const contentType = await detectMime({
    buffer,
    declaredMime: declaredMime ?? dataMime,
  });

  assertMimeAllowed(contentType);

  const filename = declaredFilename ?? `media_${Date.now()}${inferExtFromMime(contentType)}`;
  const kind = kindFromMime(contentType);

  return { localPath: "", buffer, contentType, kind, filename, size: buffer.length };
}

// ─── 工具函数 ──────────────────────────────────────────────

/** 检测字符串是否为 Base64 (简易判断) */
function isBase64(str: string): boolean {
  // data URI 格式
  if (str.startsWith("data:")) return true;
  // 纯 Base64: 长度大于 100 且只包含合法字符
  if (str.length > 100 && /^[A-Za-z0-9+/\n\r]+=*$/.test(str.trim())) return true;
  return false;
}

/** 从 MIME 推断扩展名 */
function inferExtFromMime(mime: string): string {
  const map: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "application/pdf": ".pdf",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "video/mp4": ".mp4",
  };
  return map[mime] ?? "";
}
