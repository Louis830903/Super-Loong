/**
 * 纯文本/Markdown 解析器（知识库 Spec §5.2 / T2.2）。
 *
 * 支持：
 *   - txt（text/plain）：直接 UTF-8 解码 + 去 BOM
 *   - md（text/markdown）：用 gray-matter（core 现有 dep）抽离 frontmatter，正文保留原样
 *
 * 设计要点：
 *   - 不做 markdown → HTML 转换，保留原始 markdown 文本给 chunker 保留语义（##/### 等）
 *   - chunker 后续可按 markdown 标题切分，这里 parser 只负责"提纯"
 *   - 不返回 pageBreaks（纯文本无页概念）
 */

import matter from "gray-matter";
import type { ParseResult, ParserInput } from "./types.js";

/** 去除 UTF-8 BOM（\uFEFF） */
function stripBOM(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/**
 * 解析 txt / md。
 *
 * @param input ParserInput
 * @param opts.parseFrontmatter 是否解析 md frontmatter（默认 true）
 */
export function parseText(
  input: ParserInput,
  opts: { parseFrontmatter?: boolean } = {},
): ParseResult {
  const { parseFrontmatter = true } = opts;
  const raw = stripBOM(input.buffer.toString("utf8"));

  // 通过 filename 或 mime 判定是否 md
  const filename = (input.filename ?? "").toLowerCase();
  const mime = (input.mime ?? "").toLowerCase();
  const isMarkdown =
    filename.endsWith(".md") ||
    filename.endsWith(".markdown") ||
    mime === "text/markdown" ||
    mime === "text/x-markdown";

  if (isMarkdown && parseFrontmatter) {
    try {
      // gray-matter 支持 YAML/TOML/JSON frontmatter
      const parsed = matter(raw);
      return {
        text: parsed.content.trim().length ? parsed.content : raw,
        metadata: {
          frontmatter:
            parsed.data && Object.keys(parsed.data).length > 0
              ? (parsed.data as Record<string, unknown>)
              : undefined,
        },
      };
    } catch {
      // frontmatter 解析失败时回退为原始文本（不阻塞流程）
      return { text: raw, metadata: {} };
    }
  }

  return { text: raw, metadata: {} };
}
