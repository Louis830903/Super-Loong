/**
 * 图表生成工具 — 使用 Chart.js 生成图表
 *
 * 支持：折线图、柱状图、饼图、散点图、面积图
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const chartGenerateSchema = z.object({
  data: z.array(z.record(z.union([z.string(), z.number()]))).describe("数据数组"),
  chartType: z.enum(["line", "bar", "pie", "scatter", "area"]).describe("图表类型"),
  title: z.string().describe("图表标题"),
  xAxis: z.string().describe("X 轴字段名"),
  yAxis: z.string().describe("Y 轴字段名"),
  width: z.number().optional().default(800).describe("图表宽度"),
  height: z.number().optional().default(600).describe("图表高度"),
});

export const chartGenerateTool: ToolDefinition = {
  name: "chart_generate",
  description: "根据数据生成图表（折线图、柱状图、饼图、散点图、面积图）",
  parameters: chartGenerateSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { data, chartType, title, xAxis, yAxis, width, height } = chartGenerateSchema.parse(params);

    try {
      // 生成 Chart.js 配置
      const chartConfig = generateChartConfig(data, chartType, title, xAxis, yAxis);

      // 生成 HTML 文件
      const html = generateChartHTML(chartConfig, width, height);

      // 保存到临时文件
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const os = await import("node:os");

      const tempDir = os.tmpdir();
      const fileName = `chart_${Date.now()}.html`;
      const filePath = path.join(tempDir, fileName);

      await fs.writeFile(filePath, html, "utf-8");

      return {
        success: true,
        output: `图表已生成：${filePath}\n类型：${chartType}\n标题：${title}`,
      };
    } catch (error) {
      return {
        success: false,
        output: `图表生成失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  },
};

function generateChartConfig(data: any[], chartType: string, title: string, xAxis: string, yAxis: string) {
  const labels = data.map(d => d[xAxis]);
  const values = data.map(d => d[yAxis]);

  return {
    type: chartType,
    data: {
      labels,
      datasets: [{
        label: title,
        data: values,
        backgroundColor: generateColors(values.length),
        borderColor: generateColors(values.length, 1),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        title: {
          display: true,
          text: title,
        },
      },
    },
  };
}

function generateColors(count: number, alpha = 0.5): string[] {
  const colors = [
    `rgba(54, 162, 235, ${alpha})`,
    `rgba(255, 99, 132, ${alpha})`,
    `rgba(75, 192, 192, ${alpha})`,
    `rgba(255, 206, 86, ${alpha})`,
    `rgba(153, 102, 255, ${alpha})`,
    `rgba(255, 159, 64, ${alpha})`,
  ];

  return Array.from({ length: count }, (_, i) => colors[i % colors.length]);
}

function generateChartHTML(config: any, width: number, height: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${config.data.datasets[0].label}</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</head>
<body>
  <div style="width: ${width}px; height: ${height}px;">
    <canvas id="chart"></canvas>
  </div>
  <script>
    const ctx = document.getElementById('chart').getContext('2d');
    new Chart(ctx, ${JSON.stringify(config)});
  </script>
</body>
</html>`;
}
