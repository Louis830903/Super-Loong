/**
 * B-0: content 安全访问工具函数
 *
 * 所有对 LLMMessage.content 做字符串操作的位置，统一改用此工具函数，
 * 防止 ContentPart[] 类型在运行时触发 TypeError。
 */

import type { ContentPart } from "../types/index.js";

/**
 * 安全提取 LLMMessage.content 的纯文本部分
 * - string → 直接返回
 * - null → 返回空字符串
 * - ContentPart[] → 拼接所有 type:"text" 部分
 */
export function getContentText(content: string | null | ContentPart[]): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
      .map((p) => p.text)
      .join("");
  }
  return String(content);
}

/**
 * 判断 content 是否包含图片部分
 */
export function hasImageContent(content: string | null | ContentPart[]): boolean {
  if (!Array.isArray(content)) return false;
  return content.some((p) => p.type === "image_url");
}

/**
 * 估算 ContentPart[] 中图片占用的 token 数
 * OpenAI: detail:"low" ~85 tokens, detail:"high" ~1105 tokens
 * 用于 compressor.estimateTokens() 精确估算
 */
export function estimateImageTokens(content: string | null | ContentPart[]): number {
  if (!Array.isArray(content)) return 0;
  return content
    .filter((p): p is Extract<ContentPart, { type: "image_url" }> => p.type === "image_url")
    .reduce((sum, p) => sum + (p.image_url.detail === "high" ? 1105 : 85), 0);
}
