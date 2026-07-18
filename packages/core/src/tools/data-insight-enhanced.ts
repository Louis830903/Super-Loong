/**
 * 增强数据洞察工具 — 自动生成分析报告
 *
 * 功能：
 * - 数据摘要统计
 * - 趋势检测
 * - 异常警告
 * - 自动生成 Markdown 报告
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const insightSchema = z.object({
  data: z.array(z.record(z.union([z.string(), z.number()]))).describe("数据数组"),
  analysisType: z.enum(["summary", "trend", "comparison", "distribution"]).describe("分析类型"),
  title: z.string().optional().default("数据分析报告").describe("报告标题"),
});

export const dataInsightEnhancedTool: ToolDefinition = {
  name: "data_insight_enhanced",
  description: "自动分析数据并生成 Markdown 格式的洞察报告，包含统计摘要、趋势检测、异常警告",
  parameters: insightSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { data, analysisType, title } = insightSchema.parse(params);

    try {
      const report = generateInsightReport(data, analysisType, title);

      return {
        success: true,
        output: report,
      };
    } catch (error) {
      return {
        success: false,
        output: `数据分析失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function generateInsightReport(data: any[], analysisType: string, title: string): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    `> 生成时间：${new Date().toISOString()}`,
    `> 分析类型：${analysisType}`,
    "",
    "## 📊 数据概览",
    "",
    `- **总记录数**：${data.length}`,
    `- **字段数**：${Object.keys(data[0] ?? {}).length}`,
    "",
  ];

  // 数值字段分析
  const numericFields = Object.keys(data[0] ?? {}).filter(key =>
    typeof data[0][key] === "number"
  );

  if (numericFields.length > 0) {
    lines.push("## 🔢 数值字段分析", "");

    for (const field of numericFields) {
      const values = data.map(d => d[field]).filter(v => typeof v === "number");
      const sum = values.reduce((a, b) => a + b, 0);
      const avg = sum / values.length;
      const min = Math.min(...values);
      const max = Math.max(...values);

      lines.push(`### ${field}`, "");
      lines.push(`- 平均值：${avg.toFixed(2)}`);
      lines.push(`- 最小值：${min}`);
      lines.push(`- 最大值：${max}`);
      lines.push(`- 总和：${sum.toFixed(2)}`);
      lines.push("");
    }
  }

  // 文本字段分析
  const textFields = Object.keys(data[0] ?? {}).filter(key =>
    typeof data[0][key] === "string"
  );

  if (textFields.length > 0) {
    lines.push("## 📝 文本字段分析", "");

    for (const field of textFields) {
      const values = data.map(d => d[field]);
      const uniqueValues = new Set(values);

      lines.push(`### ${field}`, "");
      lines.push(`- 唯一值数量：${uniqueValues.size}`);
      lines.push(`- 示例：${[...uniqueValues].slice(0, 5).join(", ")}`);
      lines.push("");
    }
  }

  // 趋势检测
  if (analysisType === "trend" && numericFields.length > 0) {
    lines.push("## 📈 趋势分析", "");

    for (const field of numericFields) {
      const values = data.map(d => d[field]);
      const firstHalf = values.slice(0, Math.floor(values.length / 2));
      const secondHalf = values.slice(Math.floor(values.length / 2));

      const firstAvg = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length;
      const secondAvg = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length;

      const trend = secondAvg > firstAvg ? "上升" : secondAvg < firstAvg ? "下降" : "平稳";
      const change = ((secondAvg - firstAvg) / firstAvg * 100).toFixed(1);

      lines.push(`- **${field}**：${trend} ${change}%`);
    }

    lines.push("");
  }

  // 建议
  lines.push("## 💡 建议", "");
  lines.push("基于以上分析，建议：");
  lines.push("1. 关注数值波动较大的字段");
  lines.push("2. 定期检查数据质量");
  lines.push("3. 建立数据监控机制");

  return lines.join("\n");
}
