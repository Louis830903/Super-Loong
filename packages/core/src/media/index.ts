/**
 * 媒体服务层统一导出
 *
 * 对标 OpenClaw media/ 模块的完整能力:
 * - 常量配置
 * - MIME 检测与推断
 * - MEDIA: 标记解析
 * - 安全守卫
 * - 本地临时存储
 * - 统一加载器
 */

// 常量
export {
  MEDIA_MAX_BYTES,
  MEDIA_TTL_MS,
  MIME_SNIFF_BYTES,
  MEDIA_STORE_DIR,
  MEDIA_INBOUND_DIR,
  MEDIA_OUTBOUND_DIR,
  MEDIA_TOKEN_RE,
  MIME_KIND_MAP,
  BLOCKED_MIME_TYPES,
  BLOCKED_EXTENSIONS,
  INTERNAL_IP_PATTERNS,
  INTERNAL_HOSTNAMES,
} from "./constants.js";

// MIME 检测
export {
  detectMimeFromPath,
  detectMimeFromBuffer,
  detectMime,
  kindFromMime,
  inferFilename,
  mimeToExt,
  isMimeSafe,
  isExtensionSafe,
} from "./mime.js";

// MEDIA: 标记解析
export {
  splitMediaFromOutput,
  hasMediaTokens,
  stripMediaPrefix,
} from "./parse.js";
export type { ParsedMediaOutput } from "./parse.js";

// 安全守卫
export {
  MediaSecurityError,
  assertPathAllowed,
  assertNotInternalUrl,
  assertSizeAllowed,
  assertMimeAllowed,
} from "./security.js";
export type { MediaSecurityCode } from "./security.js";

// 本地临时存储
export {
  initMediaStore,
  saveMediaBuffer,
  saveMediaFromUrl,
  cleanExpiredMedia,
  getMediaById,
} from "./store.js";
export type { SavedMedia } from "./store.js";

// 统一加载器
export {
  loadMedia,
  resolveOutboundAttachment,
} from "./loader.js";
export type { LoadMediaOptions } from "./loader.js";
