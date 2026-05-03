/**
 * XLSX 解析器（知识库 Spec §5.2 / T2.5）。
 *
 * 技术选型：xlsx（SheetJS，optional dep）
 *
 * 设计要点：
 *   - 动态 import，未装抛 PARSE_OPTIONAL_DEP_MISSING
 *   - 每个 sheet 转 CSV，拼接前加 [Sheet: 名称] 标题便于定位
 *   - pageBreaks 记每个 sheet 的起始 offset（chunker 可按 sheet 边界优先切）
 *   - 支持 .xls / .xlsx / .xlsm / .csv（xlsx 库自动探测）
 */

import type { ParseResult, ParserInput } from "./types.js";

export async function parseXlsx(input: ParserInput): Promise<ParseResult> {
  // 动态 import xlsx（optional dep）
  let XLSX: {
    read: (buf: Buffer, opts: { type: "buffer" }) => {
      SheetNames: string[];
      Sheets: Record<string, unknown>;
    };
    utils: {
      sheet_to_csv: (sheet: unknown) => string;
    };
  };
  try {
    const modName = "xlsx";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod: any = await import(/* webpackIgnore: true */ modName);
    XLSX = mod.default ?? mod;
  } catch (err) {
    const e = new Error("PARSE_OPTIONAL_DEP_MISSING");
    (e as Error & { cause?: unknown }).cause = err;
    (e as Error & { dep?: string }).dep = "xlsx";
    throw e;
  }

  let workbook: { SheetNames: string[]; Sheets: Record<string, unknown> };
  try {
    workbook = XLSX.read(input.buffer, { type: "buffer" });
  } catch (err) {
    const e = new Error("PARSE_FAILED");
    (e as Error & { cause?: unknown }).cause = err;
    throw e;
  }

  const pageBreaks: number[] = [];
  const parts: string[] = [];
  let offset = 0;
  const sheetNames: string[] = [];

  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (!sheet) continue;
    const csv = XLSX.utils.sheet_to_csv(sheet).trim();
    if (!csv) continue; // 跳过空 sheet
    sheetNames.push(name);
    pageBreaks.push(offset);
    const block = `[Sheet: ${name}]\n${csv}`;
    parts.push(block);
    // +2 是后面要拼接的 "\n\n"
    offset += block.length + 2;
  }

  const text = parts.join("\n\n");

  if (text.length === 0) {
    const e = new Error("PARSE_EMPTY");
    (e as Error & { reason?: string }).reason = "xlsx-all-sheets-empty";
    throw e;
  }

  return {
    text,
    pageBreaks,
    metadata: {
      pageCount: sheetNames.length,
      sheetNames,
    },
  };
}
