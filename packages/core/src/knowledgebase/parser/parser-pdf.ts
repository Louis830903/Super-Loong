/**
 * PDF 解析器（知识库 Spec §5.2 / T2.3）。
 *
 * 技术选型：pdf-parse（optional dep，api 层已在用；core 已声明）
 *
 * 设计要点：
 *   - 动态 import，未装则抛 PARSE_OPTIONAL_DEP_MISSING（不影响其他 parser）
 *   - 用 \f（form feed）作为页分隔符 —— pdf-parse 默认会在翻页处插入
 *   - 合并 text + 记 pageBreaks offset 列表，便于 chunker 按页优先切分
 *   - 抽出的文本为空（纯图 PDF / 扫描件）时抛 PARSE_NEEDS_OCR，T7 Docling 接管
 *   - metadata.pageCount = pdfData.numpages，info 只保留简单字段
 */

import type { ParseResult, ParserInput } from "./types.js";

/**
 * 解析 PDF。
 *
 * @param input  ParserInput
 * @param opts.maxPages  页数上限保护（默认 500，防御超大 PDF）
 */
export async function parsePdf(
  input: ParserInput,
  opts: { maxPages?: number } = {},
): Promise<ParseResult> {
  const { maxPages = 500 } = opts;

  // 动态 import —— pdf-parse 是 optional dep
  let pdfParse: (buf: Buffer, options?: { max?: number }) => Promise<{
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }>;
  try {
    // 通过变量名规避某些打包器的静态分析（bundler 不会把 optional dep 内联）
    const modName = "pdf-parse";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ modName);
    pdfParse = mod.default ?? mod;
  } catch (err) {
    const e = new Error("PARSE_OPTIONAL_DEP_MISSING");
    // 附加原因便于上游日志定位
    (e as Error & { cause?: unknown }).cause = err;
    (e as Error & { dep?: string }).dep = "pdf-parse";
    throw e;
  }

  let data: { text: string; numpages: number; info?: Record<string, unknown> };
  try {
    data = await pdfParse(input.buffer, { max: maxPages });
  } catch (err) {
    const e = new Error("PARSE_FAILED");
    (e as Error & { cause?: unknown }).cause = err;
    throw e;
  }

  const rawText = (data.text ?? "").replace(/\r\n?/g, "\n");

  // 抽不出文本 = 纯图/扫描件 → 交给 Docling OCR
  if (rawText.trim().length === 0) {
    const e = new Error("PARSE_NEEDS_OCR");
    (e as Error & { reason?: string }).reason = "pdf-has-no-extractable-text";
    throw e;
  }

  // 按 \f 切页并重组文本，记录每页起始 offset
  const pages = rawText.split("\f");
  const pageBreaks: number[] = [];
  let merged = "";
  for (let i = 0; i < pages.length; i++) {
    pageBreaks.push(merged.length);
    merged += pages[i];
    // 除最后一页外，每页间补一个换行避免首尾粘连
    if (i < pages.length - 1 && !pages[i].endsWith("\n")) merged += "\n";
  }

  return {
    text: merged,
    pageBreaks,
    metadata: {
      pageCount: data.numpages,
      // 只保留非敏感 info 字段
      pdfInfo: data.info
        ? {
            title: (data.info as Record<string, unknown>).Title,
            author: (data.info as Record<string, unknown>).Author,
            creator: (data.info as Record<string, unknown>).Creator,
            producer: (data.info as Record<string, unknown>).Producer,
          }
        : undefined,
    },
  };
}
