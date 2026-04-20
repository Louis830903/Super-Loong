/**
 * SSRF 防护 + Bot 检测 — 浏览器安全守卫
 *
 * 参考 Hermes 导航前后双重检查：
 * - 导航前 URL 安全检查（SSRF 防护）
 * - 页面加载后 Bot 检测关键词扫描
 */

import pino from "pino";
import type { SecurityCheckResult } from "./types.js";

const logger = pino({ name: "browser-security" });

/** 私有 IP 段正则 */
const PRIVATE_IP_PATTERNS = [
  /^127\./,                    // localhost
  /^10\./,                     // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
  /^192\.168\./,               // 192.168.0.0/16
  /^169\.254\./,               // link-local
  /^0\./,                      // 0.0.0.0/8
  /^::1$/,                     // IPv6 localhost
  /^fc00:/i,                   // IPv6 ULA
  /^fe80:/i,                   // IPv6 link-local
];

/** 敏感主机名 */
const SENSITIVE_HOSTS = new Set([
  "localhost",
  "metadata.google.internal",
  "169.254.169.254",           // AWS/GCP metadata
  "100.100.100.200",           // Alibaba Cloud metadata
]);

/** Bot 检测关键词 */
const BOT_DETECTION_KEYWORDS = [
  "cloudflare",
  "captcha",
  "access denied",
  "blocked",
  "bot detected",
  "verify you are human",
  "unusual traffic",
  "challenge-platform",
  "cf-browser-verification",
  "just a moment",
  "checking your browser",
  "recaptcha",
  "hcaptcha",
];

/**
 * URL 安全检查 — SSRF 防护。
 *
 * 检查目标 URL 是否指向私有 IP 或敏感主机。
 */
export function checkUrlSafety(url: string): SecurityCheckResult {
  const issues: string[] = [];

  try {
    const parsed = new URL(url);

    // 协议检查
    if (!["http:", "https:"].includes(parsed.protocol)) {
      issues.push(`不安全的协议：${parsed.protocol}`);
      return { safe: false, issues, botDetected: false };
    }

    // 主机名检查
    const hostname = parsed.hostname.toLowerCase();
    if (SENSITIVE_HOSTS.has(hostname)) {
      issues.push(`访问敏感主机被阻止：${hostname}`);
      return { safe: false, issues, botDetected: false };
    }

    // 私有 IP 检查
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        issues.push(`访问私有 IP 被阻止：${hostname}`);
        return { safe: false, issues, botDetected: false };
      }
    }

    // 端口检查（非标准端口告警）
    if (parsed.port && !["80", "443", "8080", "8443", "3000", "5000"].includes(parsed.port)) {
      issues.push(`非标准端口：${parsed.port}（仅告警）`);
    }
  } catch {
    issues.push(`无效的 URL：${url}`);
    return { safe: false, issues, botDetected: false };
  }

  return { safe: issues.length === 0, issues, botDetected: false };
}

/**
 * Bot 检测扫描 — 检查页面是否触发了反爬虫机制。
 *
 * @param title - 页面标题
 * @param url - 页面 URL
 * @param bodyText - 页面正文（前 2000 字符）
 */
export function checkBotDetection(
  title: string,
  url: string,
  bodyText?: string,
): SecurityCheckResult {
  const issues: string[] = [];
  let botDetected = false;

  const textToCheck = `${title} ${url} ${bodyText ?? ""}`.toLowerCase();

  for (const keyword of BOT_DETECTION_KEYWORDS) {
    if (textToCheck.includes(keyword)) {
      botDetected = true;
      issues.push(`检测到反爬虫关键词：${keyword}`);
    }
  }

  if (botDetected) {
    logger.warn({ title, url, keywords: issues }, "页面疑似触发 Bot 检测");
  }

  return { safe: !botDetected, issues, botDetected };
}
