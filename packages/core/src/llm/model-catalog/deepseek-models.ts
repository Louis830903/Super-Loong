// ─── DeepSeek 模型列表 ─────────────────────────────────────────

import type { ModelDef } from "../model-catalog.js";

export const deepseekModels: ModelDef[] = [
  // ── DeepSeek V4 系列（2026-04 发布，最新）───────────
  {
    id: "deepseek-v4-pro",
    name: "DeepSeek V4 Pro (旗舰)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "reasoning", "agent"],
    // 75% 折扣价，有效期至 2026-05-31；原始价 $1.74/$3.48
    pricing: { input: 0.435, output: 0.87, unit: "USD/1M_tokens" },
  },
  {
    id: "deepseek-v4-flash",
    name: "DeepSeek V4 Flash",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["fast", "functions", "reasoning"],
    pricing: { input: 0.14, output: 0.28, unit: "USD/1M_tokens" },
  },
  // ── 遗留别名（2026-07-24 后废弃）───────────────────
  // deepseek-chat → deepseek-v4-flash 非思考模式
  {
    id: "deepseek-chat",
    name: "DeepSeek Chat (遗留别名 → V4 Flash)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["legacy", "general", "functions"],
    deprecation: { sunsetDate: "2026-07-24", migratedTo: "deepseek-v4-flash" },
    pricing: { input: 0.14, output: 0.28, unit: "USD/1M_tokens" },
  },
  // deepseek-reasoner → deepseek-v4-flash 思考模式
  {
    id: "deepseek-reasoner",
    name: "DeepSeek Reasoner (遗留别名 → V4 Flash 思考)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["legacy", "reasoning"],
    deprecation: { sunsetDate: "2026-07-24", migratedTo: "deepseek-v4-flash" },
    pricing: { input: 0.14, output: 0.28, unit: "USD/1M_tokens" },
  },
];
