/**
 * DOCX 解析器（知识库 Spec §5.2 / T2.4）。
 *
 * 技术选型：mammoth（optional dep）
 *
 * 设计要点：
 *   - 动态 import，未装抛 PARSE_OPTIONAL_DEP_MISSING
 *   - 用 extractRawText（不带样式），比 convertToHtml 快且更稳
 *   - mammoth.messages 里的 warnings 聚合到 metadata.warnings（最多 5 条）
 *   - DOCX 原生无页概念（页由 Word 自动排版），不返回 pageBreaks
 *     若未来需要，可用 extractRawText 的 "##PAGE_BREAK##" 标记或改走 Docling
 */

import type { ParseResult, ParserInput } from "./types.js";

export async function parseDocx(input: ParserInput): Promise<ParseResult> {
  // 动态 import mammoth（optional dep）
  let mammoth: {
    extractRawText: (opts: { buffer: Buffer }) => Promise<{
      value: string;
      messages?: Array<{ message: string; type?: string }>;
    }>;
  };
  try {
    const modName = "mammoth";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ modName);
    mammoth = mod.default ?? mod;
  } catch (err) {
    const e = new Error("PARSE_OPTIONAL_DEP_MISSING");
    (e as Error & { cause?: unknown }).cause = err;
    (e as Error & { dep?: string }).dep = "mammoth";
    throw e;
  }

  let result: { value: string; messages?: Array<{ message: string; type?: string }> };
  try {
    result = await mammoth.extractRawText({ buffer: input.buffer });
  } catch (err) {
    const e = new Error("PARSE_FAILED");
    (e as Error & { cause?: unknown }).cause = err;
    throw e;
  }

  const text = (result.value ?? "").replace(/\r\n?/g, "\n").trim();

  if (text.length === 0) {
    const e = new Error("PARSE_EMPTY");
    (e as Error & { reason?: string }).reason = "docx-has-no-text";
    throw e;
  }

  const warnings =
    result.messages && result.messages.length
      ? result.messages.slice(0, 5).map((m) => m.message)
      : undefined;

  return {
    text,
    metadata: warnings ? { warnings } : {},
  };
}
