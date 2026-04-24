/**
 * SSRF 防护工具模块
 *
 * 提供 hostname 级别的私网/保留地址检测，供 isDomain()（orchestrator）
 * 和 validateUrl()（a2a-push）共享复用，避免两处独立实现导致检测逻辑不一致。
 *
 * 已知局限：仅做 hostname 字符串层面检测，不防御 DNS 重绑定攻击
 * （域名解析后指向私网 IP）。后续可通过 DNS 解析后二次校验 IP 增强。
 *
 * @see orchestrator.ts — isDomain()
 * @see a2a-push.ts — validateUrl()
 */

// ─── IPv4 私网/保留网段正则 ──────────────────────────────────

/** 纯 IPv4 地址格式（1-3位数字.3组） */
const IPV4_PATTERN = /^\d{1,3}(\.\d{1,3}){3}$/;

/** 127.0.0.0/8 回环 */
const LOOPBACK_PATTERN = /^127\./;

/** 10.0.0.0/8 RFC1918 */
const RFC1918_10 = /^10\./;

/** 172.16.0.0/12 RFC1918 */
const RFC1918_172 = /^172\.(1[6-9]|2\d|3[0-1])\./;

/** 192.168.0.0/16 RFC1918 */
const RFC1918_192 = /^192\.168\./;

/** 169.254.0.0/16 Link-local */
const LINK_LOCAL = /^169\.254\./;

// ─── 主检测函数 ──────────────────────────────────────────────

/**
 * 判断 hostname 是否为私网或保留地址（SSRF 防护）。
 *
 * 检测范围：
 * 1. IPv4 回环: 127.0.0.0/8
 * 2. RFC1918: 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 * 3. Link-local: 169.254.0.0/16
 * 4. Localhost 变体: localhost, *.localhost
 * 5. IPv6 回环/ULA/link-local: ::1, fe80::, fc00::/fd::
 * 6. 零地址: 0.0.0.0, ::
 * 7. 纯 IPv4 格式（即使不在上述网段，IP 直连仍被拦截）
 * 8. IPv6 格式（含 [ 或 : 的标识）
 *
 * @param hostname - URL.hostname（已 toLowerCase）
 * @returns true 表示为私网/保留地址，应拦截
 */
export function isPrivateOrReservedHost(hostname: string): boolean {
  const h = hostname.toLowerCase();

  // 1. localhost 及子域名
  if (h === "localhost" || h.endsWith(".localhost")) {
    return true;
  }

  // 2. IPv6 格式检测：带方括号或冒号
  if (h.includes(":") || h.startsWith("[")) {
    const stripped = h.replace(/^\[|\]$/g, ""); // 去掉可能的方括号

    // IPv6 回环
    if (stripped === "::1" || stripped === "0:0:0:0:0:0:0:1") return true;

    // IPv6 零地址
    if (stripped === "::" || stripped === "0:0:0:0:0:0:0:0") return true;

    // IPv6 link-local (fe80::/10)
    if (stripped.startsWith("fe80:") || stripped.startsWith("fe80%")) return true;

    // IPv6 ULA (fc00::/7 = fc00:: ~ fdff::)
    if (/^f[cd]/.test(stripped)) return true;

    // IPv4-mapped IPv6 (::ffff:x.x.x.x) — 提取内嵌 IPv4 递归检测
    const mapped = stripped.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
    if (mapped) return isPrivateIPv4(mapped[1]);

    // 其他 IPv6 格式一律拦截（不允许 IP 直连）
    return true;
  }

  // 3. 零地址
  if (h === "0.0.0.0") return true;

  // 4. 纯 IPv4 格式检测
  if (IPV4_PATTERN.test(h)) {
    return isPrivateIPv4(h);
  }

  return false;
}

/**
 * 判断 IPv4 地址是否为私网/保留地址。
 */
function isPrivateIPv4(ip: string): boolean {
  return (
    LOOPBACK_PATTERN.test(ip) ||
    RFC1918_10.test(ip) ||
    RFC1918_172.test(ip) ||
    RFC1918_192.test(ip) ||
    LINK_LOCAL.test(ip) ||
    ip === "0.0.0.0"
  );
}

/**
 * 判断字符串是否为纯 IP 地址（IPv4 或 IPv6 格式）。
 * 用于 isDomain() 快速排除 IP 地址。
 */
export function isIPAddress(s: string): boolean {
  const lower = s.toLowerCase();
  // IPv6 格式
  if (lower.includes(":") || lower.startsWith("[")) return true;
  // IPv4 格式
  if (IPV4_PATTERN.test(lower)) return true;
  return false;
}
