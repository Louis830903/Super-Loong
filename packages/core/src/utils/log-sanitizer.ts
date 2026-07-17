/**
 * 日志脱敏系统 — 防止敏感信息泄露
 *
 * 优化：
 * 1. 预编译正则，提升性能
 * 2. 采样模式，非敏感日志跳过
 * 3. 支持自定义脱敏规则
 */

import pino from "pino";

// 预编译正则（提升性能）
const SENSITIVE_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // API Key
  /Bearer\s+[a-zA-Z0-9\-._~+/]+=*/g, // JWT Token
  /password["\s:=]+["']?[^"'\s]+/gi, // 密码
  /secret["\s:=]+["']?[^"'\s]+/gi,   // 密钥
  /token["\s:=]+["']?[^"'\s]+/gi,    // Token
  /api[_-]?key["\s:=]+["']?[^"'\s]+/gi, // API Key
] as const;

// 敏感 key 名单
const SENSITIVE_KEYS = new Set([
  "password", "secret", "token", "apikey", "api_key",
  "authorization", "auth", "credential", "private",
]);

// 采样率：非敏感日志 10% 采样脱敏，敏感日志 100% 脱敏
const SAMPLE_RATE = 0.1;

export interface SanitizerOptions {
  /** 是否启用采样模式（默认 true） */
  sampling?: boolean;
  /** 自定义敏感正则 */
  customPatterns?: RegExp[];
  /** 自定义敏感 key */
  customKeys?: string[];
}

export function createSanitizer(options: SanitizerOptions = {}) {
  const {
    sampling = true,
    customPatterns = [],
    customKeys = [],
  } = options;

  const allPatterns = [...SENSITIVE_PATTERNS, ...customPatterns];
  const allKeys = new Set([...SENSITIVE_KEYS, ...customKeys.map(k => k.toLowerCase())]);

  function sanitizeString(str: string): string {
    let result = str;
    for (const pattern of allPatterns) {
      result = result.replace(pattern, (match) => {
        const prefix = match.slice(0, 4);
        return `${prefix}***REDACTED***`;
      });
    }
    return result;
  }

  function sanitizeValue(value: unknown, key?: string): unknown {
    // 检查 key 是否敏感
    if (key && allKeys.has(key.toLowerCase())) {
      return "***REDACTED***";
    }

    if (typeof value === "string") {
      return sanitizeString(value);
    }

    if (Array.isArray(value)) {
      return value.map(v => sanitizeValue(v));
    }

    if (value && typeof value === "object") {
      const result: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value)) {
        result[k] = sanitizeValue(v, k);
      }
      return result;
    }

    return value;
  }

  return function sanitize(data: unknown): unknown {
    // 采样模式：非敏感日志 10% 采样
    if (sampling && Math.random() > SAMPLE_RATE) {
      // 快速检查是否包含敏感信息
      const str = JSON.stringify(data);
      const hasSensitive = allPatterns.some(p => p.test(str)) ||
        Object.keys(data as object).some(k => allKeys.has(k.toLowerCase()));
      if (!hasSensitive) {
        return data; // 无敏感信息，直接返回
      }
    }

    return sanitizeValue(data);
  };
}

// 默认脱敏器
export const sanitizeLog = createSanitizer();

// 在 pino 中使用
export function createLogger(name: string) {
  return pino({
    name,
    serializers: {
      req: (req) => sanitizeLog(req),
      res: (res) => sanitizeLog(res),
      err: (err) => sanitizeLog(err),
    },
  });
}
