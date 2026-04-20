/**
 * MEDIA: 标记解析模块
 *
 * 对标 OpenClaw parse.ts 中的 splitMediaFromOutput / MEDIA_TOKEN_RE
 * 从 Agent/LLM 输出文本中分离 MEDIA: 标记和纯文本内容
 */

import { MEDIA_TOKEN_RE } from "./constants.js";

// ─── 类型定义 ───────────────────────────────────────────────

export interface ParsedMediaOutput {
  /** 去除 MEDIA: 标记后的纯文本 */
  text: string;
  /** 提取出的媒体 URL/路径列表 (去重、保持顺序) */
  mediaUrls: string[];
}

// ─── 公开 API ───────────────────────────────────────────────

/**
 * 从 Agent 输出中分离 MEDIA: 标记和纯文本
 *
 * 对标 OpenClaw splitMediaFromOutput:
 * - 支持 MEDIA:/path/to/file 和 MEDIA:`/path/to/file` 两种格式
 * - 提取出的 URL/路径列表自动去重
 * - 去除标记后的文本自动 trim 多余空行
 *
 * @example
 * splitMediaFromOutput("你好\nMEDIA:/tmp/a.png\n再见")
 * // → { text: "你好\n再见", mediaUrls: ["/tmp/a.png"] }
 */
export function splitMediaFromOutput(raw: string): ParsedMediaOutput {
  if (!raw) return { text: "", mediaUrls: [] };

  const mediaUrls: string[] = [];
  const seen = new Set<string>();

  // 重置 lastIndex（因为 MEDIA_TOKEN_RE 是全局正则）
  MEDIA_TOKEN_RE.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = MEDIA_TOKEN_RE.exec(raw)) !== null) {
    const url = match[1].trim();
    if (url && !seen.has(url)) {
      seen.add(url);
      mediaUrls.push(url);
    }
  }

  // 如果没有匹配到任何标记，直接返回原文
  if (mediaUrls.length === 0) {
    return { text: raw, mediaUrls: [] };
  }

  // 从原文中去除所有 MEDIA: 标记行
  MEDIA_TOKEN_RE.lastIndex = 0;
  let text = raw.replace(MEDIA_TOKEN_RE, "");

  // 清理多余的空行（连续 3 个以上换行缩减为 2 个）
  text = text.replace(/\n{3,}/g, "\n\n").trim();

  return { text, mediaUrls };
}

/**
 * 检测字符串是否包含 MEDIA: 标记
 */
export function hasMediaTokens(text: string): boolean {
  if (!text) return false;
  MEDIA_TOKEN_RE.lastIndex = 0;
  return MEDIA_TOKEN_RE.test(text);
}

/**
 * 从单个字符串中剥离 MEDIA: 前缀
 * 用于处理单个媒体引用
 *
 * @example
 * stripMediaPrefix("MEDIA:/tmp/a.png") → "/tmp/a.png"
 * stripMediaPrefix("/tmp/a.png") → "/tmp/a.png"
 */
export function stripMediaPrefix(source: string): string {
  return source.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}
