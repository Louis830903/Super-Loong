import { createHash, timingSafeEqual } from "node:crypto";

/**
 * 恒定时间安全比较：防止时序攻击
 * 先对两个字符串做 SHA-256 哈希（统一长度），再用 timingSafeEqual 比较
 * 参考 OpenClaw: openclaw/src/security/secret-equal.ts
 */
export function safeEqualSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (typeof provided !== "string" || typeof expected !== "string") return false;
  const hash = (s: string) => createHash("sha256").update(s).digest();
  return timingSafeEqual(hash(provided), hash(expected));
}
