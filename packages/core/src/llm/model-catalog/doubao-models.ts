// ─── 火山引擎豆包 (ByteDance Doubao) 模型列表 ──────────────────
// 模型 ID 使用火山方舟 ARK API v3 实际接受的端点名称格式，
// 而非虚构名称。用户需先在火山引擎控制台「开通管理」中开通模型服务。
// 如测试仍返回 404，请到 https://console.volcengine.com/ark/ 创建推理接入点并使用端点 ID。

// 豆包模型列表仅包含豆包自家模型（Seed / Lite / Code 系列），模型 ID 来自火山方舟官方文档。
// Kimi K2.5 / GLM 4.7 / DeepSeek V3.2 等第三方托管模型不在此列出，
// 如需使用请到火山引擎控制台创建对应推理接入点，填入端点 ID（ep-m-xxx）。
// 官方模型列表：https://www.volcengine.com/docs/82379/1330310
// 发布公告：https://www.volcengine.com/docs/82379/2172655

import type { ModelDef } from "../model-catalog.js";

export const doubaoModels: ModelDef[] = [
  // ── Seed 2.0 Pro (2026-02-14 发布，旗舰深度思考) ──
  {
    id: "doubao-seed-2-0-pro-260215",
    name: "Doubao Seed 2.0 Pro (最新旗舰 · 深度思考)",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "reasoning", "agent", "vision", "coding"],
    pricing: { input: 3.2, output: 16, unit: "CNY/1M_tokens" },
  },
  // ── Seed 2.0 Lite (2026-02-14 发布，高性价比) ──
  {
    id: "doubao-seed-2-0-lite-260215",
    name: "Doubao Seed 2.0 Lite (高性价比 · 高频场景)",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["agent", "general"],
    pricing: { input: 0.6, output: 3.6, unit: "CNY/1M_tokens" },
  },
  // ── Seed 2.0 Mini (2026-02-14 发布，低延迟) ──
  {
    id: "doubao-seed-2-0-mini-260215",
    name: "Doubao Seed 2.0 Mini (低延迟 · 高并发)",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general", "free"],
    pricing: { input: 0.2, output: 2, unit: "CNY/1M_tokens" },
  },
  // ── Seed 2.0 Code (2026-02-14 发布，编程专项) ──
  {
    id: "doubao-seed-2-0-code-preview-260215",
    name: "Doubao Seed 2.0 Code (编程专项 · SWE-Bench 78.8%)",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding", "reasoning", "agent"],
    pricing: { input: 3.2, output: 16, unit: "CNY/1M_tokens" },
  },
  // ── Seed 1.8 (上一代旗舰) ─────────────────────
  {
    id: "doubao-seed-1-8-251228",
    name: "Doubao Seed 1.8 (上一代旗舰通用)",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "agent", "vision", "coding"],
    pricing: { input: 0.8, output: 2, unit: "CNY/1M_tokens" },
  },
];
