/**
 * JSON 安全解析 — Task 10: 为所有 JSON.parse 调用点添加 schema 校验。
 *
 * 核心原则：LLM 输出不可信，JSON 解析必须做防御性处理。
 * - safeJsonParse<T>: 带类型守卫的严格解析，失败返回 null
 * - safeJsonParseAny: 宽松解析，仅防止 throw，失败返回 null
 */

import pino from "pino";

const logger = pino({ name: "json-guard" });

/**
 * 带类型守卫的严格 JSON 解析。
 * 如果解析失败或类型守卫不通过，返回 null 并记录 warn 日志。
 *
 * @param text - 待解析的 JSON 字符串
 * @param validator - 类型守卫函数
 * @param context - 调用上下文（用于日志）
 */
export function safeJsonParse<T>(
  text: string,
  validator: (obj: unknown) => obj is T,
  context?: string,
): T | null {
  try {
    const obj: unknown = JSON.parse(text);
    if (validator(obj)) return obj;
    logger.warn({ context, text: text.slice(0, 200) }, "JSON.parse 类型守卫不通过");
    return null;
  } catch (err) {
    logger.warn({ context, err: (err as Error).message, text: text.slice(0, 200) }, "JSON.parse 失败");
    return null;
  }
}

/**
 * 宽松 JSON 解析 — 仅防止 throw，返回 unknown。
 * 用于不需要严格 schema 的场景。
 */
export function safeJsonParseAny(text: string, context?: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    logger.warn({ context, err: (err as Error).message, text: text.slice(0, 200) }, "JSON.parse 失败");
    return null;
  }
}
