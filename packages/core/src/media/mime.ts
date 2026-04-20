/**
 * MIME 检测与 MediaKind 推断模块
 *
 * 对标 OpenClaw web-media.ts 中的 detectMime + kindFromMime 逻辑
 * 支持两级检测: magic bytes (buffer) → 扩展名 fallback
 */

import path from "node:path";
import type { MediaKind } from "../types/index.js";
import { MIME_KIND_MAP, BLOCKED_EXTENSIONS, BLOCKED_MIME_TYPES } from "./constants.js";

// ─── 常用 Magic Bytes 签名表 ──────────────────────────────────
// 避免引入 file-type 重依赖，内置高频格式的 magic bytes 检测

interface MagicSignature {
  offset: number;
  bytes: number[];
  mime: string;
}

const MAGIC_SIGNATURES: MagicSignature[] = [
  // 图片
  { offset: 0, bytes: [0x89, 0x50, 0x4e, 0x47], mime: "image/png" },
  { offset: 0, bytes: [0xff, 0xd8, 0xff], mime: "image/jpeg" },
  { offset: 0, bytes: [0x47, 0x49, 0x46, 0x38], mime: "image/gif" },
  { offset: 0, bytes: [0x42, 0x4d], mime: "image/bmp" },
  // WebP: RIFF....WEBP
  { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50], mime: "image/webp" },
  // PDF
  { offset: 0, bytes: [0x25, 0x50, 0x44, 0x46], mime: "application/pdf" },
  // ZIP (也覆盖 .docx/.xlsx/.pptx)
  { offset: 0, bytes: [0x50, 0x4b, 0x03, 0x04], mime: "application/zip" },
  // MP3 (ID3 tag)
  { offset: 0, bytes: [0x49, 0x44, 0x33], mime: "audio/mpeg" },
  // MP3 (frame sync)
  { offset: 0, bytes: [0xff, 0xfb], mime: "audio/mpeg" },
  // OGG
  { offset: 0, bytes: [0x4f, 0x67, 0x67, 0x53], mime: "audio/ogg" },
  // WAV: RIFF....WAVE
  { offset: 8, bytes: [0x57, 0x41, 0x56, 0x45], mime: "audio/wav" },
  // MP4/M4A (ftyp box)
  { offset: 4, bytes: [0x66, 0x74, 0x79, 0x70], mime: "video/mp4" },
  // WebM (EBML header)
  { offset: 0, bytes: [0x1a, 0x45, 0xdf, 0xa3], mime: "video/webm" },
];

// ─── 扩展名 → MIME 映射 (内置常用，不依赖 mime-types 库) ──────

const EXT_MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".pdf": "application/pdf",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".zip": "application/zip",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".opus": "audio/opus",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".amr": "audio/amr",
  ".silk": "audio/silk",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
  ".mov": "video/quicktime",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".xml": "application/xml",
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".md": "text/markdown",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
};

// ─── 公开 API ───────────────────────────────────────────────

/**
 * 根据文件扩展名检测 MIME 类型
 */
export function detectMimeFromPath(filePath: string): string | undefined {
  const ext = path.extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext];
}

/**
 * 根据 Buffer magic bytes 检测 MIME 类型
 * 内置常用格式签名，无需外部依赖
 */
export function detectMimeFromBuffer(buffer: Buffer): string | undefined {
  for (const sig of MAGIC_SIGNATURES) {
    if (buffer.length < sig.offset + sig.bytes.length) continue;
    let matched = true;
    for (let i = 0; i < sig.bytes.length; i++) {
      if (buffer[sig.offset + i] !== sig.bytes[i]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      // ZIP 检测到后需要进一步判断是否为 Office 文档
      if (sig.mime === "application/zip") {
        return refineZipMime(buffer) ?? sig.mime;
      }
      return sig.mime;
    }
  }
  return undefined;
}

/**
 * 综合 MIME 检测 — magic bytes 优先，回退到扩展名，再回退到 declaredMime
 */
export async function detectMime(options: {
  buffer?: Buffer;
  filePath?: string;
  declaredMime?: string;
}): Promise<string> {
  const { buffer, filePath, declaredMime } = options;

  // 第一优先级: magic bytes
  if (buffer && buffer.length > 0) {
    const bufferMime = detectMimeFromBuffer(buffer);
    if (bufferMime) return bufferMime;
  }

  // 第二优先级: 扩展名
  if (filePath) {
    const extMime = detectMimeFromPath(filePath);
    if (extMime) return extMime;
  }

  // 第三优先级: 声明的 MIME
  if (declaredMime) return declaredMime;

  // 兜底
  return "application/octet-stream";
}

/**
 * MIME → MediaKind 推断
 * 对标 OpenClaw 的 kindFromMime 逻辑
 */
export function kindFromMime(mime: string): MediaKind {
  const lower = mime.toLowerCase();
  for (const [prefix, kind] of MIME_KIND_MAP) {
    if (lower.startsWith(prefix)) return kind;
  }
  return "file";
}

/**
 * 从文件路径推断文件名（去掉目录部分）
 */
export function inferFilename(filePath: string, contentType?: string): string {
  const base = path.basename(filePath);
  if (base && base !== "." && base !== "..") return base;

  // 如果路径没有有效文件名，根据 MIME 生成一个
  const ext = contentType ? mimeToExt(contentType) : "";
  return `media_${Date.now()}${ext}`;
}

/**
 * MIME → 扩展名（用于文件名推断）
 */
export function mimeToExt(mime: string): string {
  for (const [ext, m] of Object.entries(EXT_MIME_MAP)) {
    if (m === mime) return ext;
  }
  return "";
}

/**
 * 检查 MIME 类型是否安全（非可执行文件）
 */
export function isMimeSafe(mime: string): boolean {
  return !BLOCKED_MIME_TYPES.has(mime.toLowerCase());
}

/**
 * 检查文件扩展名是否安全
 */
export function isExtensionSafe(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return !BLOCKED_EXTENSIONS.has(ext);
}

// ─── 内部辅助 ───────────────────────────────────────────────

/**
 * ZIP 文件进一步判断是否为 Office 文档
 * 检查 ZIP 内部的 [Content_Types].xml 标记
 */
function refineZipMime(buffer: Buffer): string | undefined {
  // 简单检查 ZIP 内容中是否包含 Office 文档的标志性字符串
  const str = buffer.toString("ascii", 0, Math.min(buffer.length, 2048));
  if (str.includes("word/")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (str.includes("xl/")) return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (str.includes("ppt/")) return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return undefined;
}
