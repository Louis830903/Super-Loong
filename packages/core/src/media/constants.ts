/**
 * 媒体服务层常量定义
 * 对标 OpenClaw media 模块的核心配置参数
 */

import type { MediaKind } from "../types/index.js";

// ─── 大小与生命周期 ──────────────────────────────────────────

/** 单文件最大字节数 (5MB，对标 OpenClaw MEDIA_MAX_BYTES) */
export const MEDIA_MAX_BYTES = 5 * 1024 * 1024;

/** 临时文件 TTL (2 分钟，对标 OpenClaw DEFAULT_TTL_MS) */
export const MEDIA_TTL_MS = 2 * 60 * 1000;

/** 流式下载时 MIME 嗅探的前缀字节数 */
export const MIME_SNIFF_BYTES = 16 * 1024;

// ─── 存储路径 ────────────────────────────────────────────────

/** 媒体存储根目录（相对于 resolveHome()） */
export const MEDIA_STORE_DIR = "media";

/** 入站子目录 — 接收到的附件 */
export const MEDIA_INBOUND_DIR = "inbound";

/** 出站子目录 — 待发送的附件 */
export const MEDIA_OUTBOUND_DIR = "outbound";

// ─── MEDIA: 标记 ────────────────────────────────────────────

/**
 * MEDIA: 标记正则 — 对标 OpenClaw MEDIA_TOKEN_RE
 * 匹配格式: MEDIA:/path/to/file 或 MEDIA:`/path/to/file`
 * 支持 URL 和本地路径
 */
export const MEDIA_TOKEN_RE = /\bMEDIA:\s*`?([^\s`\n]+)`?/gi;

// ─── MIME → MediaKind 映射 ──────────────────────────────────

/** MIME 前缀 → MediaKind 映射表 (前缀匹配，越具体的放前面) */
export const MIME_KIND_MAP: Array<[prefix: string, kind: MediaKind]> = [
  ["image/", "image"],
  ["video/", "video"],
  ["audio/", "audio"],
  ["application/pdf", "document"],
  ["application/msword", "document"],
  ["application/vnd.openxmlformats-officedocument.wordprocessingml", "document"],
  ["application/vnd.openxmlformats-officedocument.spreadsheetml", "document"],
  ["application/vnd.openxmlformats-officedocument.presentationml", "document"],
  ["application/vnd.ms-excel", "document"],
  ["application/vnd.ms-powerpoint", "document"],
];

// ─── 安全相关 ───────────────────────────────────────────────

/** 被拒绝的危险 MIME 类型 */
export const BLOCKED_MIME_TYPES = new Set([
  "application/x-msdownload",   // .exe
  "application/x-msdos-program", // .exe
  "application/x-executable",
  "application/x-sharedlib",     // .so/.dll
  "application/x-shellscript",   // .sh
  "application/x-bat",           // .bat
  "application/x-msi",           // .msi
]);

/** 被拒绝的危险文件扩展名 */
export const BLOCKED_EXTENSIONS = new Set([
  ".exe", ".bat", ".cmd", ".sh", ".ps1", ".vbs", ".wsf",
  ".dll", ".so", ".dylib", ".msi", ".com", ".scr", ".pif",
]);

/** 内网 IP 正则 — 用于 SSRF 防护 */
export const INTERNAL_IP_PATTERNS = [
  /^127\./,                       // localhost
  /^10\./,                        // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,  // 172.16.0.0/12
  /^192\.168\./,                  // 192.168.0.0/16
  /^0\./,                         // 0.0.0.0/8
  /^169\.254\./,                  // link-local
  /^::1$/,                        // IPv6 localhost
  /^fc00:/i,                      // IPv6 ULA
  /^fe80:/i,                      // IPv6 link-local
];

/** 内网主机名黑名单 */
export const INTERNAL_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
]);
