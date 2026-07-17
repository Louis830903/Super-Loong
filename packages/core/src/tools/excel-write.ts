/**
 * Excel 写入工具 — 支持创建/修改 Excel 文件
 *
 * 使用 xlsx 库（SheetJS）实现 Excel 文件的创建和编辑。
 * 支持：创建工作簿、写入数据、设置格式、多 Sheet 管理。
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

// ─── 参数 Schema ──────────────────────────────────────────

const xlsxWriteSchema = z.object({
  path: z.string().describe("Excel 文件路径（.xlsx）"),
  sheetName: z.string().optional().default("Sheet1").describe("工作表名称"),
  data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("二维数组数据，第一行通常是表头"),
  headers: z.array(z.string()).optional().describe("可选的表头数组（如果 data 第一行不是表头）"),
  overwrite: z.boolean().optional().default(false).describe("是否覆盖已存在的文件"),
});

const xlsxAppendSchema = z.object({
  path: z.string().describe("Excel 文件路径（.xlsx）"),
  sheetName: z.string().optional().default("Sheet1").describe("工作表名称"),
  data: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("要追加的二维数组数据"),
});

// ─── 核心执行逻辑 ──────────────────────────────────────────

async function executeXlsxWrite(
  params: z.infer<typeof xlsxWriteSchema>,
  _context: ToolContext,
): Promise<ToolResult> {
  try {
    // 动态导入 xlsx（延迟加载，未安装时友好提示）
    const XLSX = await import("xlsx").catch(() => {
      throw new Error(
        "xlsx 库未安装。请运行: pnpm add xlsx\n" +
        "或使用 npm: npm install xlsx"
      );
    });

    const fs = await import("node:fs");
    const path = await import("node:path");

    // 检查文件是否存在
    const fileExists = fs.existsSync(params.path);
    if (fileExists && !params.overwrite) {
      return {
        success: false,
        output: `文件已存在: ${params.path}。设置 overwrite=true 覆盖。`,
      };
    }

    // 确保目录存在
    const dir = path.dirname(params.path);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // 创建工作簿
    const wb = XLSX.utils.book_new();

    // 准备数据
    let wsData = params.data;
    if (params.headers && params.headers.length > 0) {
      wsData = [params.headers, ...params.data];
    }

    // 创建工作表
    const ws = XLSX.utils.aoa_to_sheet(wsData);

    // 添加工作表到工作簿
    XLSX.utils.book_append_sheet(wb, ws, params.sheetName);

    // 写入文件
    XLSX.writeFile(wb, params.path);

    return {
      success: true,
      output: `Excel 文件已创建: ${params.path}\n工作表: ${params.sheetName}\n行数: ${wsData.length}\n列数: ${wsData[0]?.length ?? 0}`,
    };
  } catch (error) {
    return {
      success: false,
      output: `创建 Excel 失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function executeXlsxAppend(
  params: z.infer<typeof xlsxAppendSchema>,
  _context: ToolContext,
): Promise<ToolResult> {
  try {
    const XLSX = await import("xlsx").catch(() => {
      throw new Error("xlsx 库未安装。请运行: pnpm add xlsx");
    });

    const fs = await import("node:fs");

    if (!fs.existsSync(params.path)) {
      return {
        success: false,
        output: `文件不存在: ${params.path}。请先用 xlsx_write 创建。`,
      };
    }

    // 读取现有工作簿
    const wb = XLSX.readFile(params.path);

    // 获取或创建工作表
    let ws = wb.Sheets[params.sheetName];
    if (!ws) {
      ws = XLSX.utils.aoa_to_sheet([]);
      XLSX.utils.book_append_sheet(wb, ws, params.sheetName);
    }

    // 获取现有数据范围
    const range = XLSX.utils.decode_range(ws["!ref"] || "A1");
    const startRow = range.e.r + 1; // 下一行开始

    // 追加数据
    params.data.forEach((row, rowIndex) => {
      row.forEach((cell, colIndex) => {
        const cellRef = XLSX.utils.encode_cell({ r: startRow + rowIndex, c: colIndex });
        ws[cellRef] = { t: typeof cell === "number" ? "n" : "s", v: cell };
      });
    });

    // 更新范围
    if (params.data.length > 0) {
      range.e.r = startRow + params.data.length - 1;
      range.e.c = Math.max(range.e.c, params.data[0].length - 1);
      ws["!ref"] = XLSX.utils.encode_range(range);
    }

    // 保存
    XLSX.writeFile(wb, params.path);

    return {
      success: true,
      output: `已追加 ${params.data.length} 行到 ${params.path} (${params.sheetName})`,
    };
  } catch (error) {
    return {
      success: false,
      output: `追加 Excel 失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ─── 工具定义 ──────────────────────────────────────────────

const xlsxWriteTool: ToolDefinition = {
  name: "xlsx_write",
  description: "创建新的 Excel 文件并写入数据。支持表头、多行数据、覆盖选项。",
  parameters: xlsxWriteSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const parsed = xlsxWriteSchema.parse(params);
    return executeXlsxWrite(parsed, context);
  },
};

const xlsxAppendTool: ToolDefinition = {
  name: "xlsx_append",
  description: "向已存在的 Excel 文件追加数据行。",
  parameters: xlsxAppendSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const parsed = xlsxAppendSchema.parse(params);
    return executeXlsxAppend(parsed, context);
  },
};

export const excelTools: ToolDefinition[] = [xlsxWriteTool, xlsxAppendTool];
