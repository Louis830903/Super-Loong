/**
 * 数据洞察工具 — 自动分析数据并生成洞察报告
 *
 * 功能：
 * - 数据摘要统计（行数、列数、空值、类型分布）
 * - 数值列统计（均值、中位数、标准差、极值）
 * - 文本列分析（唯一值、高频词、长度分布）
 * - 简单趋势检测（递增/递减/波动）
 * - 自动生成 Markdown 格式洞察报告
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

// ─── 参数 Schema ──────────────────────────────────────────

const dataInsightSchema = z.object({
  data: z.array(z.record(z.union([z.string(), z.number(), z.boolean(), z.null()]))).describe("数据数组，每个元素是一条记录"),
  title: z.string().optional().default("数据分析报告").describe("报告标题"),
  analyzeTrends: z.boolean().optional().default(true).describe("是否分析趋势"),
  maxUniqueValues: z.number().optional().default(20).describe("文本列最大唯一值显示数"),
});

// ─── 类型定义 ──────────────────────────────────────────────

interface ColumnStats {
  name: string;
  type: "numeric" | "text" | "boolean" | "mixed" | "empty";
  count: number;
  nullCount: number;
  uniqueCount: number;
  // 数值统计
  min?: number;
  max?: number;
  mean?: number;
  median?: number;
  stdDev?: number;
  // 文本统计
  topValues?: Array<{ value: string; count: number }>;
  avgLength?: number;
}

interface InsightReport {
  title: string;
  generatedAt: string;
  rowCount: number;
  columnCount: number;
  columns: ColumnStats[];
  trends: string[];
  warnings: string[];
  summary: string;
}

// ─── 核心执行逻辑 ──────────────────────────────────────────

function analyzeColumn(name: string, values: unknown[]): ColumnStats {
  const nonNull = values.filter(v => v !== null && v !== undefined && v !== "");
  const nullCount = values.length - nonNull.length;

  // 类型检测
  const types = new Set(nonNull.map(v => typeof v));
  let type: ColumnStats["type"] = "empty";
  if (nonNull.length === 0) {
    type = "empty";
  } else if (types.size === 1) {
    const t = [...types][0];
    type = t === "number" ? "numeric" : t === "boolean" ? "boolean" : "text";
  } else {
    type = "mixed";
  }

  const stats: ColumnStats = {
    name,
    type,
    count: values.length,
    nullCount,
    uniqueCount: new Set(nonNull.map(String)).size,
  };

  // 数值列统计
  if (type === "numeric") {
    const nums = nonNull.map(Number).filter(n => !isNaN(n));
    if (nums.length > 0) {
      stats.min = Math.min(...nums);
      stats.max = Math.max(...nums);
      stats.mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      const sorted = [...nums].sort((a, b) => a - b);
      stats.median = sorted.length % 2 === 0
        ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
        : sorted[Math.floor(sorted.length / 2)];
      const variance = nums.reduce((sum, n) => sum + Math.pow(n - stats.mean!, 2), 0) / nums.length;
      stats.stdDev = Math.sqrt(variance);
    }
  }

  // 文本列统计
  if (type === "text") {
    const texts = nonNull.map(String);
    stats.avgLength = texts.reduce((sum, t) => sum + t.length, 0) / texts.length;

    // 高频值统计
    const freq = new Map<string, number>();
    for (const t of texts) {
      freq.set(t, (freq.get(t) ?? 0) + 1);
    }
    stats.topValues = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([value, count]) => ({ value, count }));
  }

  return stats;
}

function detectTrends(columns: ColumnStats[]): string[] {
  const trends: string[] = [];

  for (const col of columns) {
    if (col.type === "numeric" && col.min !== undefined && col.max !== undefined) {
      const range = col.max - col.min;
      if (range > 0) {
        const volatility = (col.stdDev ?? 0) / (col.mean ?? 1);
        if (volatility > 0.5) {
          trends.push(`📊 "${col.name}" 波动较大（变异系数 ${(volatility * 100).toFixed(1)}%）`);
        }
        if (col.mean !== undefined && col.median !== undefined) {
          const skew = (col.mean - col.median) / (col.stdDev ?? 1);
          if (Math.abs(skew) > 0.5) {
            trends.push(`📈 "${col.name}" 分布偏斜（${skew > 0 ? "右偏" : "左偏"}）`);
          }
        }
      }
    }

    if (col.type === "text" && col.uniqueCount === col.count) {
      trends.push(`🔑 "${col.name}" 可能是唯一标识符（所有值都不同）`);
    }

    if (col.nullCount > col.count * 0.3) {
      trends.push(`⚠️ "${col.name}" 缺失值较多（${((col.nullCount / col.count) * 100).toFixed(1)}%）`);
    }
  }

  return trends;
}

function generateReport(data: Record<string, unknown>[], title: string, analyzeTrends: boolean): InsightReport {
  if (data.length === 0) {
    return {
      title,
      generatedAt: new Date().toISOString(),
      rowCount: 0,
      columnCount: 0,
      columns: [],
      trends: [],
      warnings: ["数据为空"],
      summary: "没有数据可供分析。",
    };
  }

  // 获取所有列名
  const columnNames = [...new Set(data.flatMap(row => Object.keys(row)))];

  // 分析每列
  const columns = columnNames.map(name => {
    const values = data.map(row => row[name]);
    return analyzeColumn(name, values);
  });

  // 检测趋势
  const trends = analyzeTrends ? detectTrends(columns) : [];

  // 生成警告
  const warnings: string[] = [];
  const emptyCols = columns.filter(c => c.type === "empty");
  if (emptyCols.length > 0) {
    warnings.push(`以下列完全为空: ${emptyCols.map(c => c.name).join(", ")}`);
  }
  const mixedCols = columns.filter(c => c.type === "mixed");
  if (mixedCols.length > 0) {
    warnings.push(`以下列类型混合: ${mixedCols.map(c => c.name).join(", ")}`);
  }

  // 生成摘要
  const numericCols = columns.filter(c => c.type === "numeric").length;
  const textCols = columns.filter(c => c.type === "text").length;
  const summary = `数据集包含 ${data.length} 行、${columnNames.length} 列。` +
    `其中数值列 ${numericCols} 个，文本列 ${textCols} 个。` +
    (trends.length > 0 ? `发现 ${trends.length} 个值得注意的模式。` : "");

  return {
    title,
    generatedAt: new Date().toISOString(),
    rowCount: data.length,
    columnCount: columnNames.length,
    columns,
    trends,
    warnings,
    summary,
  };
}

function formatMarkdown(report: InsightReport): string {
  const lines: string[] = [
    `# ${report.title}`,
    "",
    `> 生成时间: ${report.generatedAt}`,
    "",
    "## 📋 概览",
    "",
    `- **总行数**: ${report.rowCount}`,
    `- **总列数**: ${report.columnCount}`,
    "",
    report.summary,
    "",
  ];

  if (report.warnings.length > 0) {
    lines.push("## ⚠️ 警告", "");
    for (const w of report.warnings) {
      lines.push(`- ${w}`);
    }
    lines.push("");
  }

  if (report.trends.length > 0) {
    lines.push("## 🔍 发现", "");
    for (const t of report.trends) {
      lines.push(`- ${t}`);
    }
    lines.push("");
  }

  lines.push("## 📊 列分析", "");
  for (const col of report.columns) {
    lines.push(`### ${col.name}`, "");
    lines.push(`- 类型: ${col.type}`);
    lines.push(`- 非空值: ${col.count - col.nullCount}/${col.count}`);
    lines.push(`- 唯一值: ${col.uniqueCount}`);

    if (col.type === "numeric" && col.min !== undefined) {
      lines.push(`- 范围: ${col.min.toFixed(2)} ~ ${col.max!.toFixed(2)}`);
      lines.push(`- 均值: ${col.mean!.toFixed(2)}`);
      lines.push(`- 中位数: ${col.median!.toFixed(2)}`);
      lines.push(`- 标准差: ${col.stdDev!.toFixed(2)}`);
    }

    if (col.type === "text" && col.topValues && col.topValues.length > 0) {
      lines.push(`- 平均长度: ${col.avgLength!.toFixed(1)} 字符`);
      lines.push(`- 高频值: ${col.topValues.slice(0, 5).map(v => `"${v.value}"(${v.count})`).join(", ")}`);
    }

    lines.push("");
  }

  return lines.join("\n");
}

async function executeDataInsight(
  params: z.infer<typeof dataInsightSchema>,
  _context: ToolContext,
): Promise<ToolResult> {
  try {
    const report = generateReport(params.data, params.title, params.analyzeTrends);
    const markdown = formatMarkdown(report);

    return {
      success: true,
      output: markdown,
    };
  } catch (error) {
    return {
      success: false,
      output: `数据分析失败: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ─── 工具定义 ──────────────────────────────────────────────

const dataInsightTool: ToolDefinition = {
  name: "data_insight",
  description: "自动分析数据集并生成 Markdown 格式的洞察报告。包含统计摘要、趋势检测、异常警告。",
  parameters: dataInsightSchema,
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const parsed = dataInsightSchema.parse(params);
    return executeDataInsight(parsed, context);
  },
};

export const insightTools: ToolDefinition[] = [dataInsightTool];
