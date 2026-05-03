/**
 * 知识库解析器总入口与分发器（知识库 Spec §5.2 / T2.8）。
 *
 * 设计要点：
 *   - detectFormat：按 mime 优先、filename 扩展名兜底、最后按 buffer 魔数兜底
 *   - parseFile：总入口，按 format 分发到 6 个 parser
 *   - 所有 parser 错误统一以 code 抛出（见 types.ts 的 ParserErrorCode）
 *   - 公开 API 最小化 —— 只暴露 parseFile + detectFormat + 类型
 */

import type { ParseResult, ParserInput, ParserFormat } from "./types.js";
import { parseText } from "./parser-text.js";
import { parseHtml } from "./parser-html.js";
import { parsePdf } from "./parser-pdf.js";
import { parseDocx } from "./parser-docx.js";
import { parseXlsx } from "./parser-xlsx.js";
import { parsePptx } from "./parser-pptx.js";

// 扩展名 → format 映射
const EXT_TO_FORMAT: Record<string, ParserFormat> = {
  ".txt": "text",
  ".log": "text",
  ".csv": "xlsx", // CSV 走 SheetJS 稳
  ".tsv": "xlsx",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".pdf": "pdf",
  ".docx": "docx",
  ".xlsx": "xlsx",
  ".xls": "xlsx",
  ".xlsm": "xlsx",
  ".pptx": "pptx",
};

// MIME → format 映射（优先级高于扩展名）
const MIME_TO_FORMAT: Record<string, ParserFormat> = {
  "text/plain": "text",
  "text/markdown": "markdown",
  "text/x-markdown": "markdown",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/csv": "xlsx",
};

/** buffer 魔数兜底探测（仅用于 mime/ext 都缺失的情况） */
function sniffFormat(buffer: Buffer): ParserFormat | null {
  if (buffer.length < 4) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const b2 = buffer[2];
  const b3 = buffer[3];

  // %PDF = 0x25 0x50 0x44 0x46
  if (b0 === 0x25 && b1 === 0x50 && b2 === 0x44 && b3 === 0x46) return "pdf";
  // ZIP（PK） = 0x50 0x4B 0x03 0x04 —— docx/xlsx/pptx 都是 ZIP，无法区分，这里不做进一步细分
  // HTML 开头可能是 <!DOCTYPE / <html / <!-- 等
  const head = buffer.slice(0, Math.min(200, buffer.length)).toString("utf8").toLowerCase().trim();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  return null;
}

/**
 * 根据 filename / mime / buffer 推断文件格式。
 * 返回 null 表示无法识别。
 */
export function detectFormat(input: ParserInput): ParserFormat | null {
  const mime = (input.mime ?? "").toLowerCase();
  if (mime && MIME_TO_FORMAT[mime]) return MIME_TO_FORMAT[mime];

  const filename = (input.filename ?? "").toLowerCase();
  const dotIdx = filename.lastIndexOf(".");
  if (dotIdx >= 0) {
    const ext = filename.slice(dotIdx);
    if (EXT_TO_FORMAT[ext]) return EXT_TO_FORMAT[ext];
  }

  return sniffFormat(input.buffer);
}

/**
 * 总入口：按文件格式分发到对应 parser。
 *
 * 错误码（以 Error.message 形式抛出，可用 err.message 区分）：
 *   - PARSE_UNSUPPORTED：格式识别失败或不在 6 格式清单内
 *   - PARSE_OPTIONAL_DEP_MISSING：依赖未装（err.dep 附加模块名）
 *   - PARSE_NEEDS_OCR：纯图 PDF 等需 OCR（T7 Docling 接管）
 *   - PARSE_EMPTY：解析成功但无文本
 *   - PARSE_FAILED：其他解析失败（err.cause 附加原始错误）
 */
export async function parseFile(
  input: ParserInput,
  opts?: { maxPdfPages?: number },
): Promise<ParseResult> {
  const format = detectFormat(input);
  if (!format) {
    const e = new Error("PARSE_UNSUPPORTED");
    (e as Error & { filename?: string; mime?: string }).filename = input.filename;
    (e as Error & { filename?: string; mime?: string }).mime = input.mime;
    throw e;
  }

  switch (format) {
    case "text":
      return parseText(input);
    case "markdown":
      return parseText(input); // parser-text 内部按 filename/mime 判定走 md 分支
    case "html":
      return parseHtml(input);
    case "pdf":
      return parsePdf(input, { maxPages: opts?.maxPdfPages });
    case "docx":
      return parseDocx(input);
    case "xlsx":
      return parseXlsx(input);
    case "pptx":
      return parsePptx(input);
    default: {
      // TypeScript 穷尽检查兜底
      const _never: never = format;
      const e = new Error("PARSE_UNSUPPORTED");
      (e as Error & { format?: string }).format = String(_never);
      throw e;
    }
  }
}

export type { ParseResult, ParserInput, ParserFormat, ParseMetadata, ParserErrorCode } from "./types.js";
export { parseText, parseHtml, parsePdf, parseDocx, parseXlsx, parsePptx };
