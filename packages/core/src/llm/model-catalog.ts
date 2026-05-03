/**
 * Built-in Model Catalog for Super Agent Platform.
 *
 * Pre-defined domestic LLM providers and their model lists.
 * Users select providers and models from this catalog in the Web UI,
 * then provide their API key — no code changes required.
 */

// ─── Types ────────────────────────────────────────────────────

export interface ModelDef {
  id: string;
  name: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsFunctions: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStreaming: boolean;
  /** Fixed temperature required by the model (e.g. Kimi K2 only allows 1). */
  fixedTemperature?: number;
  tags: string[];
  /** 模型价格（CNY / 1M tokens），Ollama 本地模型为 0 */
  pricing?: { input: number; output: number; unit: "CNY/1M_tokens" };
}

export interface ProviderDef {
  id: string;
  name: string;
  website: string;
  baseUrl: string;
  authMode: "api-key";
  envKey: string;
  models: ModelDef[];
}

// ─── Moonshot AI (Kimi) ───────────────────────────────────────

const moonshotModels: ModelDef[] = [
  // ── 旗舰多模态 ──────────────────────────────────
  {
    id: "kimi-k2.6",
    name: "Kimi K2.6 (最新旗舰)",
    contextWindow: 256000,
    maxOutputTokens: 98304,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["flagship", "vision", "agent", "coding"],
    pricing: { input: 1.1, output: 6.5, unit: "CNY/1M_tokens" },
  },
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 256000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["vision", "agent"],
    pricing: { input: 4.0, output: 18.0, unit: "CNY/1M_tokens" },
  },
  // ── 思考模型（深度推理）─────────────────────────
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking (长思考)",
    contextWindow: 256000,
    maxOutputTokens: 98304,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["reasoning", "thinking"],
    pricing: { input: 4.0, output: 24.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo (高速思考)",
    contextWindow: 256000,
    maxOutputTokens: 98304,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["reasoning", "thinking", "fast"],
    pricing: { input: 6.0, output: 36.0, unit: "CNY/1M_tokens" },
  },
  // ── Moonshot V1 文本模型 ────────────────────────
  {
    id: "moonshot-v1-128k",
    name: "Moonshot V1 128K",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general"],
    pricing: { input: 60, output: 60, unit: "CNY/1M_tokens" },
  },
  {
    id: "moonshot-v1-32k",
    name: "Moonshot V1 32K",
    contextWindow: 32000,
    maxOutputTokens: 32000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general", "lightweight"],
    pricing: { input: 24, output: 24, unit: "CNY/1M_tokens" },
  },
  // ── Moonshot V1 视觉模型 ────────────────────────
  {
    id: "moonshot-v1-128k-vision-preview",
    name: "Moonshot V1 128K Vision (视觉)",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["vision", "general"],
    pricing: { input: 60, output: 60, unit: "CNY/1M_tokens" },
  },
  {
    id: "moonshot-v1-32k-vision-preview",
    name: "Moonshot V1 32K Vision (视觉)",
    contextWindow: 32000,
    maxOutputTokens: 32000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["vision", "lightweight"],
    pricing: { input: 24, output: 24, unit: "CNY/1M_tokens" },
  },
];

// ─── 智谱 AI (GLM) ───────────────────────────────────────────

const zhipuModels: ModelDef[] = [
  // ── 文本模型 ────────────────────────────────────
  {
    id: "GLM-5.1",
    name: "GLM-5.1 (最新旗舰)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "coding"],
    pricing: { input: 6, output: 24, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-5",
    name: "GLM-5 高智能",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["agent", "planning"],
    pricing: { input: 5, output: 20, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-5-Turbo",
    name: "GLM-5 Turbo (Agent 增强)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["agent", "coding", "fast"],
    pricing: { input: 5, output: 22, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.7",
    name: "GLM-4.7 高智能",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["general"],
    pricing: { input: 2, output: 6, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.5-Air",
    name: "GLM-4.5 Air (高性价比)",
    contextWindow: 128000,
    maxOutputTokens: 96000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["balanced", "coding"],
    pricing: { input: 0.5, output: 1.5, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.5-AirX",
    name: "GLM-4.5 AirX (高速性价比)",
    contextWindow: 128000,
    maxOutputTokens: 96000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["fast", "balanced"],
    pricing: { input: 0.5, output: 1.5, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.6",
    name: "GLM-4.6 超强性能",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding", "reasoning"],
    pricing: { input: 2, output: 6, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4-Long",
    name: "GLM-4 Long (超长上下文)",
    contextWindow: 1000000,
    maxOutputTokens: 4096,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["long-context"],
    pricing: { input: 1, output: 1, unit: "CNY/1M_tokens" },
  },
  // ── 免费 / 轻量文本模型 ─────────────────────────
  {
    id: "GLM-4.7-Flash",
    name: "GLM-4.7 Flash (免费)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["free", "fast"],
    pricing: { input: 0, output: 0, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4-FlashX-250414",
    name: "GLM-4 FlashX (高速低价)",
    contextWindow: 128000,
    maxOutputTokens: 16000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast", "lightweight"],
    pricing: { input: 0.05, output: 0.2, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4-Flash-250414",
    name: "GLM-4 Flash (免费)",
    contextWindow: 128000,
    maxOutputTokens: 16000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["free"],
    pricing: { input: 0, output: 0, unit: "CNY/1M_tokens" },
  },
  // ── 视觉模型（支持图片输入）───────────────────────
  {
    id: "GLM-5V-Turbo",
    name: "GLM-5V Turbo (多模态旗舰)",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "vision", "coding"],
    pricing: { input: 5, output: 22, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.6V",
    name: "GLM-4.6V (视觉推理)",
    contextWindow: 128000,
    maxOutputTokens: 32000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["vision", "reasoning"],
    pricing: { input: 2, output: 6, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.6V-Flash",
    name: "GLM-4.6V Flash (免费视觉)",
    contextWindow: 128000,
    maxOutputTokens: 32000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["free", "vision"],
    pricing: { input: 0, output: 0, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4.1V-Thinking-FlashX",
    name: "GLM-4.1V Thinking FlashX (轻量视觉推理)",
    contextWindow: 64000,
    maxOutputTokens: 16000,
    supportsFunctions: false,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["vision", "reasoning", "fast"],
    pricing: { input: 1, output: 4, unit: "CNY/1M_tokens" },
  },
  {
    id: "GLM-4V-Flash",
    name: "GLM-4V Flash (免费视觉)",
    contextWindow: 16000,
    maxOutputTokens: 1000,
    supportsFunctions: false,
    supportsVision: true,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["free", "vision", "lightweight"],
    pricing: { input: 0, output: 0, unit: "CNY/1M_tokens" },
  },
];

// ─── 通义千问 (Qwen) ─────────────────────────────────────────

const qwenModels: ModelDef[] = [
  // ── Qwen3.6 旗舰系列 ────────────────────────────
  {
    id: "qwen3.6-max-preview",
    name: "Qwen3.6 Max Preview (最新旗舰)",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "latest"],
    pricing: { input: 2.0, output: 6.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus (多模态旗舰)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "vision", "agent"],
    pricing: { input: 0.8, output: 2.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen3.6-flash",
    name: "Qwen3.6 Flash (极速旗舰)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["fast", "latest"],
    pricing: { input: 0.15, output: 0.6, unit: "CNY/1M_tokens" },
  },
  // ── Qwen3.5 系列 ────────────────────────────────
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus (多模态)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["balanced", "vision"],
    pricing: { input: 0.8, output: 2.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen3.5-flash",
    name: "Qwen3.5 Flash",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast"],
    pricing: { input: 0.15, output: 0.6, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen3.5-omni-plus",
    name: "Qwen3.5 Omni Plus (全模态)",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "vision", "audio", "video"],
    pricing: { input: 2.0, output: 8.0, unit: "CNY/1M_tokens" },
  },
  // ── Qwen3 系列 ──────────────────────────────────
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    contextWindow: 262144,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship"],
    pricing: { input: 2.0, output: 6.0, unit: "CNY/1M_tokens" },
  },
  // ── Qwen Coder 系列 ─────────────────────────────
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding"],
    pricing: { input: 2.0, output: 6.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen3-coder-flash",
    name: "Qwen3 Coder Flash",
    contextWindow: 1000000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding", "fast"],
    pricing: { input: 0.3, output: 0.9, unit: "CNY/1M_tokens" },
  },
  // ── 经典模型 ────────────────────────────────────
  {
    id: "qwen-plus",
    name: "Qwen Plus (经典)",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general"],
    pricing: { input: 0.8, output: 2.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen-turbo",
    name: "Qwen Turbo (轻量)",
    contextWindow: 131072,
    maxOutputTokens: 8192,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["lightweight"],
    pricing: { input: 0.3, output: 0.6, unit: "CNY/1M_tokens" },
  },
  // ── 推理 / 长上下文 ─────────────────────────────
  {
    id: "qwq-plus",
    name: "QwQ Plus (深度推理)",
    contextWindow: 131072,
    maxOutputTokens: 65536,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["reasoning"],
    pricing: { input: 2.0, output: 8.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "qwen-long",
    name: "Qwen Long (超长上下文)",
    contextWindow: 10000000,
    maxOutputTokens: 4096,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["long-context"],
    pricing: { input: 0.5, output: 2.0, unit: "CNY/1M_tokens" },
  },
];

// ─── DeepSeek ─────────────────────────────────────────────────

const deepseekModels: ModelDef[] = [
  // ── DeepSeek V4 系列（最新）───────────────────────
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
    pricing: { input: 3.1, output: 6.2, unit: "CNY/1M_tokens" },
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
    tags: ["flagship", "fast", "functions"],
    pricing: { input: 1.0, output: 2.0, unit: "CNY/1M_tokens" },
  },
  // ── 向后兼容（自动路由到 V4 Flash）───────────────
  {
    id: "deepseek-chat",
    name: "DeepSeek V4 Flash (对话)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general", "functions"],
    pricing: { input: 1.0, output: 2.0, unit: "CNY/1M_tokens" },
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek V4 Flash (推理)",
    contextWindow: 1000000,
    maxOutputTokens: 384000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["reasoning"],
    pricing: { input: 1.0, output: 2.0, unit: "CNY/1M_tokens" },
  },
];

// ─── MiniMax ──────────────────────────────────────────────────

const minimaxModels: ModelDef[] = [
  // ── 旗舰系列 ────────────────────────────────────
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7 (旗舰)",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship"],
    pricing: { input: 2.1, output: 8.4, unit: "CNY/1M_tokens" },
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 极速",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast"],
    pricing: { input: 4.2, output: 16.8, unit: "CNY/1M_tokens" },
  },
  // ── M2.5 编码系列 ────────────────────────────────
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5 (编码增强)",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding"],
    pricing: { input: 1.05, output: 4.2, unit: "CNY/1M_tokens" },
  },
  {
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 极速",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast"],
    pricing: { input: 2.1, output: 8.4, unit: "CNY/1M_tokens" },
  },
  // ── M2.1 / M2 通用系列 ───────────────────────────
  {
    id: "MiniMax-M2.1",
    name: "MiniMax M2.1",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["coding", "multilingual"],
    pricing: { input: 2.1, output: 8.4, unit: "CNY/1M_tokens" },
  },
  {
    id: "MiniMax-M2",
    name: "MiniMax M2 (Agent 优化)",
    contextWindow: 204800,
    maxOutputTokens: 2048,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["agent"],
    pricing: { input: 2.1, output: 8.4, unit: "CNY/1M_tokens" },
  },
];

// ─── 火山引擎豆包 (ByteDance Doubao) ─────────────────────────
// 模型 ID 使用火山方舟 ARK API v3 实际接受的端点名称格式，
// 而非虚构名称。用户需先在火山引擎控制台「开通管理」中开通模型服务。
// 如测试仍返回 404，请到 https://console.volcengine.com/ark/ 创建推理接入点并使用端点 ID。

// 豆包模型列表仅包含豆包自家模型（Seed / Lite / Code 系列），模型 ID 来自火山方舟官方文档。
// Kimi K2.5 / GLM 4.7 / DeepSeek V3.2 等第三方托管模型不在此列出，
// 如需使用请到火山引擎控制台创建对应推理接入点，填入端点 ID（ep-m-xxx）。
// 官方模型列表：https://www.volcengine.com/docs/82379/1330310
// 发布公告：https://www.volcengine.com/docs/82379/2172655
const doubaoModels: ModelDef[] = [
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

// ─── Provider Definitions ─────────────────────────────────────

const PROVIDERS: ProviderDef[] = [
  {
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    website: "https://platform.kimi.com",
    baseUrl: "https://api.moonshot.cn/v1",
    authMode: "api-key",
    envKey: "MOONSHOT_API_KEY",
    models: moonshotModels,
  },
  {
    id: "zhipu",
    name: "智谱 AI (GLM)",
    website: "https://open.bigmodel.cn",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    authMode: "api-key",
    envKey: "ZHIPU_API_KEY",
    models: zhipuModels,
  },
  {
    id: "qwen",
    name: "通义千问 (Qwen)",
    website: "https://dashscope.console.aliyun.com",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    authMode: "api-key",
    envKey: "QWEN_API_KEY",
    models: qwenModels,
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    website: "https://platform.deepseek.com",
    baseUrl: "https://api.deepseek.com",
    authMode: "api-key",
    envKey: "DEEPSEEK_API_KEY",
    models: deepseekModels,
  },
  {
    id: "minimax",
    name: "MiniMax",
    website: "https://platform.minimaxi.com",
    baseUrl: "https://api.minimaxi.com/v1",
    authMode: "api-key",
    envKey: "MINIMAX_API_KEY",
    models: minimaxModels,
  },
  {
    id: "doubao",
    name: "火山引擎豆包 (ByteDance)",
    website: "https://www.volcengine.com/product/doubao",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    authMode: "api-key",
    envKey: "DOUBAO_API_KEY",
    models: doubaoModels,
  },
];

// ─── Custom Provider Template ─────────────────────────────────

const CUSTOM_PROVIDER: ProviderDef = {
  id: "custom",
  name: "自定义 (OpenAI 兼容)",
  website: "",
  baseUrl: "",
  authMode: "api-key",
  envKey: "CUSTOM_API_KEY",
  models: [],
};

// ─── P3-19: 从 JSON 配置文件加载自定义模型 ────────────────────
// 用户可通过编辑 models.json 添加自定义 provider/model，重启后生效。
// 相同 id 的自定义定义会覆盖内置定义（Provider 级别替换，非深度合并）。

import customModelConfig from "./models.json" with { type: "json" };

interface CustomProvidersConfig {
  providers?: Partial<ProviderDef>[];
}

/** 合并内置 + 自定义 Provider 列表，自定义同 id 的覆盖内置 */
function mergeCustomProviders(): ProviderDef[] {
  const cfg = customModelConfig as CustomProvidersConfig;
  if (!cfg.providers || cfg.providers.length === 0) return PROVIDERS;

  const merged = [...PROVIDERS];
  for (const custom of cfg.providers) {
    if (!custom.id) continue;
    const idx = merged.findIndex((p) => p.id === custom.id);
    if (idx >= 0) {
      // 覆盖内置 provider 的字段
      const existing = merged[idx];
      merged[idx] = {
        ...existing,
        ...custom,
        // models 数组：自定义不为空则完全替换（非深度合并）
        models: custom.models && custom.models.length > 0 ? custom.models as ModelDef[] : existing.models,
      } as ProviderDef;
    } else {
      // 新增自定义 provider
      merged.push(custom as ProviderDef);
    }
  }
  return merged;
}

// ─── Exports ──────────────────────────────────────────────────

/** Returns the full model catalog (内置 6 providers + 自定义 + custom 模板). */
export function getModelCatalog(): ProviderDef[] {
  return [...mergeCustomProviders(), CUSTOM_PROVIDER];
}

/** Look up a provider by ID. */
export function getProviderById(id: string): ProviderDef | undefined {
  if (id === "custom") return CUSTOM_PROVIDER;
  const merged = mergeCustomProviders();
  return merged.find((p) => p.id === id);
}

/** Look up a model by provider ID and model ID. */
export function getModelById(providerId: string, modelId: string): ModelDef | undefined {
  const provider = getProviderById(providerId);
  if (!provider) return undefined;
  return provider.models.find((m) => m.id === modelId);
}
