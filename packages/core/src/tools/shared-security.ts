/**
 * Shared Security — 跨工具安全原语基座。
 *
 * 对标 Hermes file_tools.py + file_operations.py + path_security.py，
 * 集中提供写入黑名单、设备阻断、二进制检测、大小守卫、SSRF 检查、
 * MIME 头检测和结果截断等安全能力。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 写入路径黑名单（对标 Hermes WRITE_DENIED_PATHS + WRITE_DENIED_PREFIXES） ──

const HOME = os.homedir();

/** 精确匹配拒绝写入的路径（对标 Hermes 14 项） */
const WRITE_DENIED_PATHS = new Set([
  path.join(HOME, ".ssh", "authorized_keys"),
  path.join(HOME, ".ssh", "id_rsa"),
  path.join(HOME, ".ssh", "id_rsa.pub"),
  path.join(HOME, ".ssh", "id_ed25519"),
  path.join(HOME, ".ssh", "id_ed25519.pub"),
  path.join(HOME, ".ssh", "known_hosts"),
  path.join(HOME, ".ssh", "config"),
  path.join(HOME, ".bashrc"),
  path.join(HOME, ".bash_profile"),
  path.join(HOME, ".zshrc"),
  path.join(HOME, ".profile"),
  path.join(HOME, ".gitconfig"),
  // Unix 系统路径
  ...(process.platform === "win32"
    ? []
    : ["/etc/sudoers", "/etc/shadow", "/etc/passwd", "/etc/hosts"]),
]);

/** 前缀匹配拒绝写入的目录（对标 Hermes 9 项） */
const WRITE_DENIED_PREFIXES = [
  path.join(HOME, ".ssh") + path.sep,
  path.join(HOME, ".aws") + path.sep,
  path.join(HOME, ".docker") + path.sep,
  path.join(HOME, ".gnupg") + path.sep,
  path.join(HOME, ".kube") + path.sep,
  path.join(HOME, ".config", "gcloud") + path.sep,
];

/**
 * 写入路径安全检查 — 阻止写入敏感系统文件。
 * @returns 错误消息（不安全），null（安全）
 */
export function validateWritePath(filePath: string): string | null {
  // Windows 文件系统不区分大小写，统一规范化为小写比较
  const resolved = process.platform === "win32"
    ? path.resolve(filePath).toLowerCase()
    : path.resolve(filePath);
  // 精确匹配
  for (const denied of WRITE_DENIED_PATHS) {
    const cmp = process.platform === "win32" ? denied.toLowerCase() : denied;
    if (resolved === cmp) {
      return `Error: 拒绝写入敏感路径 '${filePath}'（安全策略）`;
    }
  }
  // 前缀匹配
  for (const prefix of WRITE_DENIED_PREFIXES) {
    const cmp = process.platform === "win32" ? prefix.toLowerCase() : prefix;
    if (resolved.startsWith(cmp)) {
      return `Error: 拒绝写入受保护目录 '${filePath}'（安全策略）`;
    }
  }
  return null;
}

// ── 设备路径阻断（对标 Hermes _BLOCKED_DEVICE_PATHS） ──

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/null",
  "/dev/stdin",
  "/dev/stdout",
  "/dev/stderr",
  "/dev/tty",
  "/dev/console",
  "/dev/full",
  "/dev/sda",
  "/dev/mem",
  "/dev/kmem",
]);

/**
 * 设备路径检查 — 阻止读取可能挂起进程或产生无限输出的设备文件。
 * @returns 错误消息（被阻止），null（安全）
 */
export function isBlockedDevicePath(filePath: string): string | null {
  // Windows 无 /dev/ 设备路径，跳过
  if (process.platform === "win32") return null;
  const resolved = path.resolve(filePath);
  if (BLOCKED_DEVICE_PATHS.has(resolved) || resolved.startsWith("/dev/")) {
    return `Error: 拒绝访问设备路径 '${filePath}'`;
  }
  return null;
}

// ── 二进制文件检测（对标 Hermes has_binary_extension） ──

const BINARY_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".obj", ".o", ".a", ".lib",
  ".pyc", ".pyo", ".class", ".jar", ".war", ".ear",
  ".zip", ".gz", ".bz2", ".xz", ".tar", ".7z", ".rar",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff", ".svg",
  ".mp3", ".mp4", ".wav", ".avi", ".mov", ".flv", ".mkv", ".webm",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".sqlite", ".db", ".mdb",
]);

/**
 * 判断文件是否为二进制文件（基于扩展名）。
 * 用于在 read_file 中给出友好提示而非返回乱码。
 */
export function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ── 文件大小守卫（对标 Hermes _DEFAULT_MAX_READ_CHARS） ──

/**
 * 文件大小检查。
 * @returns 错误消息（超限），null（安全）
 */
export function checkFileSize(filePath: string, maxBytes: number): string | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > maxBytes) {
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(1);
      const limitMB = (maxBytes / (1024 * 1024)).toFixed(1);
      return `Error: 文件 '${filePath}' 大小 ${sizeMB}MB 超过 ${limitMB}MB 上限`;
    }
    return null;
  } catch {
    // 文件不存在等错误交由调用方处理
    return null;
  }
}

// ── 结果截断（对标 Hermes max_result_size_chars） ──

const DEFAULT_MAX_RESULT_CHARS = 100_000; // ≈25-35K tokens

/**
 * 截断过长的工具输出，保留首尾各一半以保留上下文。
 */
export function truncateResult(text: string, maxChars = DEFAULT_MAX_RESULT_CHARS): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const truncated = text.length - maxChars;
  return (
    text.slice(0, half) +
    `\n\n... [已截断 ${truncated} 字符] ...\n\n` +
    text.slice(-half)
  );
}

// ── MIME magic byte 检测（对标 Hermes _detect_image_mime_type） ──

/** 从文件头 magic bytes 检测图片 MIME 类型 */
export function detectMimeFromHeader(bufferOrPath: Buffer | string): string | null {
  let header: Buffer;
  if (typeof bufferOrPath === "string") {
    try {
      // 只读取前 64 字节
      const fd = fs.openSync(bufferOrPath, "r");
      header = Buffer.alloc(64);
      fs.readSync(fd, header, 0, 64, 0);
      fs.closeSync(fd);
    } catch {
      return null;
    }
  } else {
    header = bufferOrPath.subarray(0, 64);
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4e && header[3] === 0x47) {
    return "image/png";
  }
  // JPEG: FF D8 FF
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  // GIF: 47 49 46 38
  if (header[0] === 0x47 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x38) {
    return "image/gif";
  }
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46 &&
    header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50
  ) {
    return "image/webp";
  }
  // BMP: 42 4D
  if (header[0] === 0x42 && header[1] === 0x4d) {
    return "image/bmp";
  }
  return null;
}

// ── SSRF URL 安全检查（对标 Hermes is_safe_url + _ssrf_redirect_guard） ──

/**
 * 检查 URL 是否安全（非内网/元数据地址）。
 * 阻止 SSRF 攻击向内网、localhost、云元数据端点发起请求。
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // 阻止非 http(s) 协议
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;

    // 阻止 localhost
    if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1") return false;

    // 阻止 0.0.0.0（绑定所有接口）
    if (hostname === "0.0.0.0") return false;

    // 阻止 IPv4-mapped IPv6（如 ::ffff:127.0.0.1）
    if (hostname.startsWith("::ffff:")) return false;

    // 阻止十进制 IP（如 2130706433 = 127.0.0.1）
    if (/^\d+$/.test(hostname)) return false;

    // 阻止私有 IP 地址段
    if (hostname.startsWith("10.")) return false;
    if (hostname.startsWith("192.168.")) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;

    // 阻止 AWS/Cloud 元数据端点
    if (hostname.startsWith("169.254.")) return false;

    // 阻止内部域名后缀
    if (hostname.endsWith(".internal") || hostname.endsWith(".local") || hostname.endsWith(".localhost")) return false;

    // 阻止 IPv6 环回和链路本地
    if (hostname === "::1" || hostname.startsWith("fe80:") || hostname.startsWith("fc00:") || hostname.startsWith("fd00:")) return false;

    return true;
  } catch {
    return false; // URL 解析失败 → fail-closed
  }
}
