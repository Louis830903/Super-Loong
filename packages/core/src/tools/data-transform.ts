/**
 * Data Transform Tools — csv_parse / xlsx_read / regex_extract / text_diff / hash_digest × 5（延迟加载）。
 *
 * - csv_parse: 内置 CSV 解析（支持引号转义、多行字段）
 * - xlsx_read: 动态 import("xlsx")，未安装时友好提示
 * - regex_extract: vm.runInNewContext 沙箱化执行（ReDoS 防护）
 * - text_diff: 动态 import("diff")，未安装时简单逐行对比
 * - hash_digest: Node.js crypto，支持文件/文本自动检测
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { runInNewContext } from "node:vm";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { checkFileSize, truncateResult } from "./shared-security.js";

// ── 路径验证（复用 filesystem.ts 的 ALLOWED_ROOTS 逻辑） ──

const ALLOWED_ROOTS = [
  path.resolve(process.cwd()),
  path.resolve(os.homedir()),
  path.resolve(os.tmpdir()),
];

function validatePath(filePath: string): string | null {
  const resolved = path.resolve(filePath);
  if (!ALLOWED_ROOTS.some((root) => resolved.startsWith(root + path.sep) || resolved === root)) {
    return `Error: Path '${filePath}' is outside allowed directories`;
  }
  return null;
}

// ── 内置 CSV 解析器 ──────────────────────────────

/**
 * 解析 CSV 文本，支持：引号字段、字段内换行、引号转义（""）、自定义分隔符。
 */
function parseCSV(text: string, delimiter = ",", hasHeader = true): { headers: string[] | null; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < text.length && text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === delimiter) {
        row.push(field);
        field = "";
        i++;
      } else if (ch === "\r" || ch === "\n") {
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
        // 处理 \r\n
        if (ch === "\r" && i + 1 < text.length && text[i + 1] === "\n") i++;
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }
  // 最后一个字段
  if (field || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // 过滤空行
  const filtered = rows.filter(r => r.some(f => f.trim() !== ""));

  if (hasHeader && filtered.length > 0) {
    return { headers: filtered[0], rows: filtered.slice(1) };
  }
  return { headers: null, rows: filtered };
}

// ── 工具定义 ────────────────────────────────────

/** csv_parse — 解析 CSV */
const csvParseTool: ToolDefinition = {
  name: "csv_parse",
  description: "解析 CSV 文件或文本为结构化数据。支持引号字段、多行字段、自定义分隔符。",
  parameters: z.object({
    input: z.string().describe("CSV 文件路径或 CSV 文本内容"),
    hasHeader: z.boolean().default(true).describe("第一行是否为表头"),
    delimiter: z.string().default(",").describe("分隔符（默认逗号）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { input, hasHeader, delimiter } = params as {
      input: string; hasHeader: boolean; delimiter: string;
    };

    let csvText = input;
    // 判断是文件路径还是 CSV 文本
    if (!input.includes(",") && !input.includes("\n") && fs.existsSync(input)) {
      const pathErr = validatePath(input);
      if (pathErr) return { success: false, output: pathErr, error: pathErr };
      const sizeErr = checkFileSize(input, 50 * 1024 * 1024); // 50MB 上限
      if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };
      csvText = fs.readFileSync(input, "utf-8");
    }

    try {
      const { headers, rows } = parseCSV(csvText, delimiter, hasHeader);

      let output: string;
      if (headers) {
        output = `表头: ${headers.join(" | ")}\n行数: ${rows.length}\n\n`;
        // 显示前 20 行
        const preview = rows.slice(0, 20);
        output += preview.map((row, i) =>
          `[${i + 1}] ${row.map((f, j) => `${headers[j] || `col${j}`}: ${f}`).join(", ")}`
        ).join("\n");
        if (rows.length > 20) output += `\n... 还有 ${rows.length - 20} 行`;
      } else {
        output = `行数: ${rows.length}\n\n`;
        const preview = rows.slice(0, 20);
        output += preview.map((row, i) => `[${i + 1}] ${row.join(delimiter + " ")}`).join("\n");
        if (rows.length > 20) output += `\n... 还有 ${rows.length - 20} 行`;
      }

      return {
        success: true,
        output: truncateResult(output),
        data: { headers, rowCount: rows.length, preview: rows.slice(0, 5) },
      };
    } catch (err: any) {
      return { success: false, output: `CSV 解析失败: ${err.message}`, error: err.message };
    }
  },
};

/** xlsx_read — 读取 Excel 文件 */
const xlsxReadTool: ToolDefinition = {
  name: "xlsx_read",
  description: "读取 Excel 文件（.xlsx/.xls）内容。需要安装 xlsx 库（pnpm add xlsx）。",
  parameters: z.object({
    path: z.string().describe("Excel 文件路径"),
    sheet: z.union([z.string(), z.number()]).optional().describe("工作表名称或索引（默认第一个）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { path: filePath, sheet } = params as { path: string; sheet?: string | number };
    const pathErr = validatePath(filePath);
    if (pathErr) return { success: false, output: pathErr, error: pathErr };
    const sizeErr = checkFileSize(filePath, 50 * 1024 * 1024);
    if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };

    try {
      // 动态导入 xlsx（optionalDep，类型绕过）
      const moduleName = "xlsx";
      const XLSX = await import(/* webpackIgnore: true */ moduleName) as any;
      const workbook = XLSX.readFile(filePath);
      const sheetName = typeof sheet === "number"
        ? workbook.SheetNames[sheet] || workbook.SheetNames[0]
        : sheet || workbook.SheetNames[0];

      if (!sheetName || !workbook.Sheets[sheetName]) {
        return {
          success: false,
          output: `工作表 '${sheet}' 不存在。可用: ${workbook.SheetNames.join(", ")}`,
          error: "sheet not found",
        };
      }

      const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]) as Record<string, unknown>[];
      const headers: string[] = data.length > 0 ? Object.keys(data[0]) : [];

      let output = `工作表: ${sheetName}\n表头: ${headers.join(" | ")}\n行数: ${data.length}\n\n`;
      const preview = data.slice(0, 20);
      output += preview.map((row: Record<string, unknown>, i: number) =>
        `[${i + 1}] ${headers.map(h => `${h}: ${row[h] ?? ""}`).join(", ")}`
      ).join("\n");
      if (data.length > 20) output += `\n... 还有 ${data.length - 20} 行`;

      return {
        success: true,
        output: truncateResult(output),
        data: { sheetName, headers, rowCount: data.length, sheets: workbook.SheetNames },
      };
    } catch (err: any) {
      if (err.code === "ERR_MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
        return {
          success: false,
          output: "xlsx 库未安装。请执行: pnpm add xlsx",
          error: "xlsx not installed",
        };
      }
      return { success: false, output: `Excel 读取失败: ${err.message}`, error: err.message };
    }
  },
};

/** regex_extract — 正则提取（ReDoS 沙箱防护） */
const regexExtractTool: ToolDefinition = {
  name: "regex_extract",
  description:
    "用正则表达式从文本中提取/匹配/替换/拆分数据。" +
    "pattern 上限 500 字符，执行超时 5 秒（防 ReDoS）。",
  parameters: z.object({
    text: z.string().describe("目标文本"),
    pattern: z.string().describe("正则表达式（不含 / 分隔符）"),
    flags: z.string().default("g").describe("正则标志（g/i/m/s 等）"),
    action: z.enum(["match", "extract", "replace", "split"]).default("match")
      .describe("match=匹配, extract=提取分组, replace=替换, split=拆分"),
    replacement: z.string().optional().describe("replace 操作的替换文本"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { text, pattern, flags, action, replacement } = params as {
      text: string; pattern: string; flags: string; action: string; replacement?: string;
    };

    // 安全检查
    if (pattern.length > 500) {
      return { success: false, output: "正则表达式过长（上限 500 字符）", error: "pattern too long" };
    }
    if (text.length > 1 * 1024 * 1024) {
      return { success: false, output: "文本过大（上限 1MB）", error: "text too large" };
    }

    try {
      // vm 沙箱执行，防止 ReDoS 锁死主线程（5s 超时）
      let code: string;
      switch (action) {
        case "match":
          code = `(function(){ return [...text.matchAll(new RegExp(pattern, flags))].map(m => m[0]); })()`;
          break;
        case "extract":
          code = `(function(){ return [...text.matchAll(new RegExp(pattern, flags))].map(m => m.slice(1)); })()`;
          break;
        case "replace":
          code = `(function(){ return text.replace(new RegExp(pattern, flags), replacement || ''); })()`;
          break;
        case "split":
          code = `(function(){ return text.split(new RegExp(pattern)); })()`;
          break;
        default:
          return { success: false, output: `未知操作: ${action}`, error: "unknown action" };
      }

      const result = runInNewContext(code, { text, pattern, flags, replacement: replacement || "" }, { timeout: 5000 });

      let output: string;
      if (Array.isArray(result)) {
        output = `匹配结果（${result.length} 项）：\n${JSON.stringify(result, null, 2)}`;
      } else {
        output = String(result);
      }

      return {
        success: true,
        output: truncateResult(output),
        data: { action, matchCount: Array.isArray(result) ? result.length : 1, result },
      };
    } catch (err: any) {
      if (err.message?.includes("timed out") || err.code === "ERR_SCRIPT_EXECUTION_TIMEOUT") {
        return { success: false, output: "正则执行超时（可能是 ReDoS 攻击模式）", error: "regex timeout" };
      }
      return { success: false, output: `正则执行失败: ${err.message}`, error: err.message };
    }
  },
};

/** text_diff — 文本对比 */
const textDiffTool: ToolDefinition = {
  name: "text_diff",
  description: "对比两段文本的差异，输出 unified diff 格式。",
  parameters: z.object({
    source: z.string().describe("原始文本（或文件路径）"),
    target: z.string().describe("目标文本（或文件路径）"),
    context: z.number().default(3).describe("上下文行数"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    let { source, target, context: ctx } = params as { source: string; target: string; context: number };

    // 尝试从文件读取
    if (fs.existsSync(source) && !source.includes("\n")) {
      const err = validatePath(source);
      if (err) return { success: false, output: err, error: err };
      source = fs.readFileSync(source, "utf-8");
    }
    if (fs.existsSync(target) && !target.includes("\n")) {
      const err = validatePath(target);
      if (err) return { success: false, output: err, error: err };
      target = fs.readFileSync(target, "utf-8");
    }

    try {
      // 尝试使用 diff 库（optionalDep，类型绕过）
      const diffModName = "diff";
      const diffLib = await import(/* webpackIgnore: true */ diffModName) as any;
      const patch = diffLib.createPatch("file", source, target, "source", "target", { context: ctx });
      return {
        success: true,
        output: truncateResult(patch),
        data: { linesChanged: patch.split("\n").filter((l: string) => l.startsWith("+") || l.startsWith("-")).length },
      };
    } catch {
      // diff 库未安装，简单逐行对比
      const srcLines = source.split("\n");
      const tgtLines = target.split("\n");
      const diffs: string[] = [];
      const maxLen = Math.max(srcLines.length, tgtLines.length);
      for (let i = 0; i < maxLen; i++) {
        const s = srcLines[i] ?? "";
        const t = tgtLines[i] ?? "";
        if (s !== t) {
          diffs.push(`L${i + 1}:`);
          if (s) diffs.push(`  - ${s}`);
          if (t) diffs.push(`  + ${t}`);
        }
      }
      const output = diffs.length > 0 ? diffs.join("\n") : "两段文本完全相同";
      return {
        success: true,
        output: truncateResult(output),
        data: { linesChanged: diffs.filter(d => d.startsWith("L")).length },
      };
    }
  },
};

/** hash_digest — 计算哈希值 */
const hashDigestTool: ToolDefinition = {
  name: "hash_digest",
  description: "计算文件或文本的哈希摘要。支持 md5/sha1/sha256/sha512 算法。",
  parameters: z.object({
    input: z.string().describe("文件路径或文本内容"),
    algorithm: z.enum(["md5", "sha1", "sha256", "sha512"]).default("sha256").describe("哈希算法"),
    inputType: z.enum(["auto", "file", "text"]).default("auto").describe("auto=自动检测, file=文件, text=文本"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { input, algorithm, inputType } = params as {
      input: string; algorithm: string; inputType: string;
    };

    try {
      let data: Buffer | string;
      let source: string;

      const isFile = inputType === "file" || (inputType === "auto" && fs.existsSync(input) && !input.includes("\n"));

      if (isFile) {
        const pathErr = validatePath(input);
        if (pathErr) return { success: false, output: pathErr, error: pathErr };
        const sizeErr = checkFileSize(input, 200 * 1024 * 1024); // 200MB 上限
        if (sizeErr) return { success: false, output: sizeErr, error: sizeErr };
        data = fs.readFileSync(input);
        source = `file: ${input}`;
      } else {
        data = input;
        source = `text (${input.length} chars)`;
      }

      const hash = crypto.createHash(algorithm).update(data).digest("hex");

      return {
        success: true,
        output: `${algorithm.toUpperCase()}: ${hash}\n来源: ${source}`,
        data: { algorithm, hash, source },
      };
    } catch (err: any) {
      return { success: false, output: `哈希计算失败: ${err.message}`, error: err.message };
    }
  },
};

export const dataTransformTools: ToolDefinition[] = [
  csvParseTool,
  xlsxReadTool,
  regexExtractTool,
  textDiffTool,
  hashDigestTool,
];
