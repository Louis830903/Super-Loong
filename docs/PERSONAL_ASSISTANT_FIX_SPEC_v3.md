# Super Agent 个人超级助手修复方案 Spec v3.0

> 基于六维能力差距分析，制定个人超级助手修复方案。
> 目标：从 50% 达成度提升到 80%+。
> 修复优先级：P0 > P1 > P2

---

## 一、P0 级修复（立即执行，1 周内完成）

### P0-1 记忆主动化系统

**问题**：记忆系统被动，需要手动调用 `remember`/`recall`，不会自动关联对话内容

**目标**：Agent 自动从对话中提取关键信息并跨会话关联

**修复方案**：

#### 1. 对话自动摘要与实体提取

```typescript
// packages/core/src/memory/auto-memory.ts
import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";
import type { LLMProvider } from "../llm/provider.js";
import pino from "pino";

const logger = pino({ name: "auto-memory" });

export interface ExtractedEntity {
  name: string;
  type: "person" | "project" | "date" | "location" | "organization" | "task";
  confidence: number;
  context: string;
}

export interface ConversationSummary {
  summary: string;
  entities: ExtractedEntity[];
  topics: string[];
  actionItems: string[];
}

/**
 * 自动记忆系统 — 对话后自动提取关键信息并关联
 */
export class AutoMemorySystem {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
    private llm: LLMProvider,
  ) {}

  /**
   * 对话结束后自动处理
   */
  async processConversation(
    sessionId: string,
    agentId: string,
    messages: Array<{ role: string; content: string }>,
  ): Promise<void> {
    try {
      // 1. 生成对话摘要
      const summary = await this.generateSummary(messages);
      
      // 2. 提取实体
      const entities = await this.extractEntities(messages);
      
      // 3. 提取主题
      const topics = await this.extractTopics(messages);
      
      // 4. 提取行动项
      const actionItems = await this.extractActionItems(messages);
      
      // 5. 写入记忆
      await this.memoryManager.add({
        agentId,
        type: "recall",
        content: summary.summary,
        metadata: {
          sessionId,
          entities: entities.map(e => e.name),
          topics,
          actionItems,
          timestamp: new Date().toISOString(),
        },
      });
      
      // 6. 写入知识图谱
      for (const entity of entities) {
        await this.linkEntityToGraph(entity, sessionId);
      }
      
      // 7. 建立跨会话关联
      await this.linkToPreviousSessions(entities, topics);
      
      logger.info({ sessionId, entities: entities.length, topics: topics.length }, "Auto-memory processed");
    } catch (error) {
      logger.error({ sessionId, error }, "Failed to process auto-memory");
    }
  }

  /**
   * 生成对话摘要
   */
  private async generateSummary(messages: Array<{ role: string; content: string }>): Promise<{ summary: string }> {
    const text = messages.map(m => `${m.role}: ${m.content}`).join("\n");
    
    const response = await this.llm.complete({
      messages: [{
        role: "user",
        content: `请为以下对话生成简洁的摘要（100字以内）：\n\n${text}`,
      }],
    });
    
    return { summary: response.content ?? "无法生成摘要" };
  }

  /**
   * 提取实体
   */
  private async extractEntities(messages: Array<{ role: string; content: string }>): Promise<ExtractedEntity[]> {
    const text = messages.map(m => m.content).join("\n");
    
    const response = await this.llm.complete({
      messages: [{
        role: "user",
        content: `从以下文本中提取所有重要实体（人名、项目名、日期、地点、组织、任务）。
文本：
${text}

请以 JSON 格式返回：
[
  { "name": "实体名", "type": "person|project|date|location|organization|task", "confidence": 0.95, "context": "上下文" }
]`,
      }],
    });
    
    try {
      return JSON.parse(response.content ?? "[]");
    } catch {
      return [];
    }
  }

  /**
   * 提取主题
   */
  private async extractTopics(messages: Array<{ role: string; content: string }>): Promise<string[]> {
    const text = messages.map(m => m.content).join("\n");
    
    const response = await this.llm.complete({
      messages: [{
        role: "user",
        content: `从以下文本中提取 3-5 个主要主题。
文本：
${text}

请以 JSON 格式返回：["主题1", "主题2", "主题3"]`,
      }],
    });
    
    try {
      return JSON.parse(response.content ?? "[]");
    } catch {
      return [];
    }
  }

  /**
   * 提取行动项
   */
  private async extractActionItems(messages: Array<{ role: string; content: string }>): Promise<string[]> {
    const text = messages.map(m => m.content).join("\n");
    
    const response = await this.llm.complete({
      messages: [{
        role: "user",
        content: `从以下文本中提取所有行动项（需要做的事情）。
文本：
${text}

请以 JSON 格式返回：["行动项1", "行动项2"]`,
      }],
    });
    
    try {
      return JSON.parse(response.content ?? "[]");
    } catch {
      return [];
    }
  }

  /**
   * 将实体链接到知识图谱
   */
  private async linkEntityToGraph(entity: ExtractedEntity, sessionId: string): Promise<void> {
    // 查找或创建实体
    const entityId = this.knowledgeGraph.findEntityId(entity.name);
    
    if (!entityId) {
      // 创建新实体（通过添加三元组）
      logger.debug({ entity: entity.name }, "New entity discovered");
    }
    
    // 添加会话关联
    await this.knowledgeGraph.addTriple({
      subjectId: entityId ?? 0,
      predicate: "mentioned_in",
      objectId: sessionId as any,
      confidence: entity.confidence,
      source: "auto_memory",
    });
  }

  /**
   * 建立跨会话关联
   */
  private async linkToPreviousSessions(entities: ExtractedEntity[], topics: string[]): Promise<void> {
    for (const entity of entities) {
      const previousId = this.knowledgeGraph.findEntityId(entity.name);
      if (previousId) {
        // 建立"同一实体"关联
        await this.knowledgeGraph.addTriple({
          subjectId: previousId,
          predicate: "same_as",
          objectId: previousId,
          confidence: 0.95,
          source: "auto_memory",
        });
      }
    }
  }

  /**
   * 查询相关记忆
   */
  async queryRelatedMemory(query: string, agentId: string): Promise<string[]> {
    // 使用知识图谱查找相关实体
    const relatedEntities = await this.knowledgeGraph.searchEntities(query);
    
    // 检索相关记忆
    const memories = await this.memoryManager.search(query, { agentId }, 5);
    
    return memories.map(m => m.content);
  }
}
```

#### 2. 集成到 Agent 运行时

```typescript
// packages/core/src/agent/runtime.ts
// 在对话完成后自动调用 AutoMemorySystem

// 在 chat() 方法末尾添加：
if (this.autoMemorySystem) {
  await this.autoMemorySystem.processConversation(
    sessionId,
    this.config.id,
    messages,
  );
}
```

**验证方式**：
1. 对话中提到"张三" → 验证自动提取实体
2. 再次提到"张三" → 验证自动关联历史记录
3. 询问"张三上次说的项目" → 验证能检索到

---

### P0-2 数据分析增强系统

**问题**：能读 Excel/CSV，但缺少图表生成和自动洞察

**目标**：自动分析 → 生成图表 → 洞察报告

**修复方案**：

#### 1. 图表生成工具

```typescript
// packages/core/src/tools/chart-generator.ts
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

/**
 * 图表生成工具 — 使用 Chart.js 生成图表
 */
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
```

#### 2. 数据洞察增强

```typescript
// packages/core/src/tools/data-insight-enhanced.ts
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const insightSchema = z.object({
  data: z.array(z.record(z.union([z.string(), z.number()]))).describe("数据数组"),
  analysisType: z.enum(["summary", "trend", "comparison", "distribution"]).describe("分析类型"),
  title: z.string().optional().default("数据分析报告").describe("报告标题"),
});

/**
 * 增强数据洞察工具 — 自动生成分析报告
 */
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
```

**验证方式**：
1. 上传 Excel 文件 → 验证自动解析
2. 生成图表 → 验证图表正确显示
3. 生成洞察报告 → 验证报告内容准确

---

### P0-3 界面优化

**问题**：功能可用，但界面不够美观和易用

**目标**：功能丰富，界面美观

**修复方案**：

#### 1. 数据可视化组件

```typescript
// packages/web/src/components/charts/data-chart.tsx
"use client";

import { useEffect, useRef } from "react";
import Chart from "chart.js/auto";

interface DataChartProps {
  data: any[];
  chartType: "line" | "bar" | "pie" | "scatter" | "area";
  title: string;
  xAxis: string;
  yAxis: string;
}

export function DataChart({ data, chartType, title, xAxis, yAxis }: DataChartProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const chartRef = useRef<Chart | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // 销毁旧图表
    if (chartRef.current) {
      chartRef.current.destroy();
    }

    const labels = data.map(d => d[xAxis]);
    const values = data.map(d => d[yAxis]);

    chartRef.current = new Chart(canvasRef.current, {
      type: chartType,
      data: {
        labels,
        datasets: [{
          label: title,
          data: values,
          backgroundColor: "rgba(54, 162, 235, 0.5)",
          borderColor: "rgba(54, 162, 235, 1)",
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
    });

    return () => {
      if (chartRef.current) {
        chartRef.current.destroy();
      }
    };
  }, [data, chartType, title, xAxis, yAxis]);

  return <canvas ref={canvasRef} />;
}
```

#### 2. 文件拖拽上传

```typescript
// packages/web/src/components/upload/drag-drop-upload.tsx
"use client";

import { useCallback, useState } from "react";
import { Upload, X } from "lucide-react";

interface DragDropUploadProps {
  onUpload: (files: File[]) => void;
  accept?: string;
  maxSize?: number; // MB
}

export function DragDropUpload({ onUpload, accept = "*", maxSize = 10 }: DragDropUploadProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [files, setFiles] = useState<File[]>([]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const droppedFiles = Array.from(e.dataTransfer.files);
    const validFiles = droppedFiles.filter(file => {
      const sizeMB = file.size / 1024 / 1024;
      return sizeMB <= maxSize;
    });

    setFiles(prev => [...prev, ...validFiles]);
    onUpload(validFiles);
  }, [maxSize, onUpload]);

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <div
      className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
        isDragging ? "border-blue-500 bg-blue-50" : "border-gray-300"
      }`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <Upload className="mx-auto h-12 w-12 text-gray-400" />
      <p className="mt-2 text-sm text-gray-600">
        拖拽文件到此处，或点击上传
      </p>
      <p className="text-xs text-gray-500">
        最大 {maxSize}MB
      </p>
      
      {files.length > 0 && (
        <div className="mt-4 space-y-2">
          {files.map((file, index) => (
            <div key={index} className="flex items-center justify-between bg-gray-100 p-2 rounded">
              <span className="text-sm truncate">{file.name}</span>
              <button onClick={() => removeFile(index)}>
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
```

#### 3. 消息搜索

```typescript
// packages/web/src/components/chat/message-search.tsx
"use client";

import { useState } from "react";
import { Search, X } from "lucide-react";

interface MessageSearchProps {
  onSearch: (query: string) => void;
  onClose: () => void;
}

export function MessageSearch({ onSearch, onClose }: MessageSearchProps) {
  const [query, setQuery] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSearch(query);
  };

  return (
    <div className="border-b border-gray-200 p-4">
      <form onSubmit={handleSubmit} className="flex items-center gap-2">
        <Search className="h-5 w-5 text-gray-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索消息..."
          className="flex-1 border-none outline-none"
        />
        <button type="button" onClick={onClose}>
          <X className="h-5 w-5 text-gray-400" />
        </button>
      </form>
    </div>
  );
}
```

**验证方式**：
1. 上传 Excel 文件 → 验证图表正确显示
2. 拖拽文件 → 验证上传成功
3. 搜索消息 → 验证搜索结果正确

---

## 二、P1 级修复（本周执行，2 周内完成）

### P1-1 电商运营自动化

**问题**：半自动，需人工确认关键步骤

**目标**：定时巡检 → 异常告警 → 一键处理

**修复方案**：

#### 1. 定时巡检任务

```typescript
// packages/core/src/cron/ecom-inspection.ts
import { CronJob } from "cron";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

export class EcomInspectionScheduler {
  private job: CronJob | null = null;

  /**
   * 启动定时巡检
   */
  start(interval: string = "0 9 * * *"): void {
    // 每天早上 9 点执行
    this.job = new CronJob(interval, async () => {
      await this.runInspection();
    });
    
    this.job.start();
  }

  /**
   * 停止定时巡检
   */
  stop(): void {
    this.job?.stop();
  }

  /**
   * 执行巡检
   */
  private async runInspection(): Promise<void> {
    // 1. 检查微信小店订单
    // 2. 检查抖音小店订单
    // 3. 检查库存异常
    // 4. 生成巡检报告
    // 5. 发送告警（如有异常）
  }
}
```

#### 2. 异常告警

```typescript
// packages/core/src/tools/alert-sender.ts
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const alertSchema = z.object({
  channel: z.enum(["feishu", "dingtalk", "wecom"]).describe("告警渠道"),
  message: z.string().describe("告警消息"),
  level: z.enum(["info", "warning", "error"]).describe("告警级别"),
});

export const alertSendTool: ToolDefinition = {
  name: "alert_send",
  description: "发送告警消息到指定渠道",
  parameters: alertSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { channel, message, level } = alertSchema.parse(params);
    
    // 发送告警到指定渠道
    // 实现略
    
    return {
      success: true,
      output: `告警已发送到 ${channel}`,
    };
  },
};
```

**验证方式**：
1. 启动定时巡检 → 验证每天自动执行
2. 模拟异常 → 验证告警发送
3. 一键处理 → 验证处理成功

---

### P1-2 个人知识库

**问题**：无个人知识库，对话记录无法自动整理

**目标**：自动整理对话为知识库

**修复方案**：

#### 1. 对话自动归档

```typescript
// packages/core/src/memory/knowledge-archiver.ts
import type { MemoryManager } from "./manager.js";
import type { KnowledgeGraph } from "./knowledge-graph.js";

export class KnowledgeArchiver {
  constructor(
    private memoryManager: MemoryManager,
    private knowledgeGraph: KnowledgeGraph,
  ) {}

  /**
   * 归档对话到知识库
   */
  async archiveConversation(
    sessionId: string,
    agentId: string,
    category: string,
  ): Promise<void> {
    // 1. 获取对话记录
    const memories = await this.memoryManager.list({ agentId });
    
    // 2. 生成知识条目
    const knowledgeEntry = this.generateKnowledgeEntry(memories, category);
    
    // 3. 写入知识库
    await this.memoryManager.add({
      agentId,
      type: "archival",
      content: knowledgeEntry,
      metadata: {
        sessionId,
        category,
        archivedAt: new Date().toISOString(),
      },
    });
  }

  /**
   * 生成知识条目
   */
  private generateKnowledgeEntry(memories: any[], category: string): string {
    // 生成结构化的知识条目
    return `# ${category}\n\n${memories.map(m => m.content).join("\n\n")}`;
  }

  /**
   * 搜索知识库
   */
  async searchKnowledge(query: string, agentId: string): Promise<any[]> {
    return this.memoryManager.search(query, { agentId, type: "archival" }, 10);
  }
}
```

**验证方式**：
1. 对话后自动归档 → 验证知识库更新
2. 搜索知识库 → 验证搜索结果正确
3. 跨会话关联 → 验证能检索到历史记录

---

## 三、P2 级修复（本月执行，1 个月内完成）

### P2-1 自我进化真实化

**问题**：34 模块中 9 个是孤岛，自我进化能力未完全实现

**目标**：Agent 真正自己写代码改进自己

**修复方案**：

#### 1. 激活孤岛模块

```typescript
// packages/core/src/evolution/activation-manager.ts
// 已在 P2-1 中实现，此处补充具体激活逻辑

export class ActivationManager {
  /**
   * 激活 ToolGenerator
   */
  async activateToolGenerator(): Promise<void> {
    // 1. 初始化 ToolGenerator
    // 2. 接通 LLM 生成逻辑
    // 3. 添加沙箱验证
    // 4. 添加人工审批
  }

  /**
   * 激活 AutoLearner
   */
  async activateAutoLearner(): Promise<void> {
    // 1. 初始化 CapabilityGapDetector
    // 2. 初始化 ToolDiscoverer
    // 3. 接通 AutoLearner
    // 4. 添加学习循环
  }
}
```

#### 2. 沙箱验证

```typescript
// packages/core/src/evolution/sandbox-validator.ts
export class SandboxValidator {
  /**
   * 验证生成的代码
   */
  async validate(code: string): Promise<{
    valid: boolean;
    errors: string[];
    warnings: string[];
  }> {
    // 1. 语法检查
    // 2. 安全检查
    // 3. 性能检查
    // 4. 返回验证结果
  }
}
```

**验证方式**：
1. 激活孤岛模块 → 验证模块正常工作
2. 生成代码 → 验证沙箱验证通过
3. 人工审批 → 验证审批流程正常

---

### P2-2 多模态能力

**问题**：文本为主，缺少图片、语音、视频支持

**目标**：图片、语音、视频全支持

**修复方案**：

#### 1. 图片理解

```typescript
// packages/core/src/tools/image-understanding.ts
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const imageSchema = z.object({
  imageUrl: z.string().describe("图片 URL 或 Base64"),
  question: z.string().describe("关于图片的问题"),
});

export const imageUnderstandingTool: ToolDefinition = {
  name: "image_understanding",
  description: "分析图片内容并回答问题",
  parameters: imageSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { imageUrl, question } = imageSchema.parse(params);
    
    // 调用视觉模型分析图片
    // 实现略
    
    return {
      success: true,
      output: "图片分析结果",
    };
  },
};
```

#### 2. 语音对话

```typescript
// packages/core/src/tools/voice-chat.ts
import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";

const voiceSchema = z.object({
  audioUrl: z.string().describe("音频 URL 或 Base64"),
  action: z.enum(["transcribe", "synthesize"]).describe("操作类型"),
});

export const voiceChatTool: ToolDefinition = {
  name: "voice_chat",
  description: "语音转文字或文字转语音",
  parameters: voiceSchema,
  execute: async (params: unknown, _context: ToolContext): Promise<ToolResult> => {
    const { audioUrl, action } = voiceSchema.parse(params);
    
    // 调用语音服务
    // 实现略
    
    return {
      success: true,
      output: "语音处理结果",
    };
  },
};
```

**验证方式**：
1. 上传图片 → 验证图片理解正确
2. 语音输入 → 验证语音转文字正确
3. 文字转语音 → 验证语音合成正确

---

## 四、修复计划时间表

| 阶段 | 任务 | 预计时间 | 优先级 |
|------|------|----------|:--:|
| P0-1 | 记忆主动化 | 3 天 | **P0** |
| P0-2 | 数据分析增强 | 2 天 | **P0** |
| P0-3 | 界面优化 | 2 天 | **P0** |
| P1-1 | 电商自动化 | 3 天 | P1 |
| P1-2 | 个人知识库 | 2 天 | P1 |
| P2-1 | 自我进化 | 5 天 | P2 |
| P2-2 | 多模态 | 3 天 | P2 |

**总计：约 20 天（3 周）**

---

## 五、验证标准

每个修复完成后必须验证：

- [ ] 功能正常工作
- [ ] 无新 Bug 引入
- [ ] 性能无下降
- [ ] 安全无漏洞
- [ ] 文档已更新
- [ ] 单元测试通过
- [ ] 集成测试通过

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:--:|:--:|----------|
| 修复引入新 Bug | 中 | 高 | 充分测试 + 灰度发布 |
| 性能下降 | 低 | 中 | 性能测试 + 监控告警 |
| 兼容性问题 | 中 | 高 | 保持 API 兼容 + 版本控制 |
| LLM 生成代码安全 | 中 | 高 | 沙箱验证 + 人工审批 |

---

*本修复方案基于六维能力差距分析制定，执行前请再次确认问题仍然存在。*
