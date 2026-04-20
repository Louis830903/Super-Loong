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
  {
    id: "kimi-k2.5",
    name: "Kimi K2.5",
    contextWindow: 256000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["flagship", "vision", "agent"],
  },
  {
    id: "kimi-k2-0905-preview",
    name: "Kimi K2 (0905)",
    contextWindow: 256000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["coding", "context"],
  },
  {
    id: "kimi-k2-turbo-preview",
    name: "Kimi K2 Turbo",
    contextWindow: 256000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["fast"],
  },
  {
    id: "kimi-k2-thinking",
    name: "Kimi K2 Thinking",
    contextWindow: 256000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["reasoning"],
  },
  {
    id: "kimi-k2-thinking-turbo",
    name: "Kimi K2 Thinking Turbo",
    contextWindow: 256000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    fixedTemperature: 1,
    tags: ["reasoning", "fast"],
  },
  {
    id: "moonshot-v1-128k",
    name: "Moonshot V1 128K",
    contextWindow: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general"],
  },
  {
    id: "moonshot-v1-32k",
    name: "Moonshot V1 32K",
    contextWindow: 32000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general", "lightweight"],
  },
];

// ─── 智谱 AI (GLM) ───────────────────────────────────────────

const zhipuModels: ModelDef[] = [
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
  },
  // ── 文本模型（不支持图片）─────────────────────────
  {
    id: "GLM-5.1",
    name: "GLM-5.1 旗舰",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "coding"],
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
  },
  {
    id: "GLM-4.7",
    name: "GLM-4.7",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["general"],
  },
  {
    id: "GLM-4.7-FlashX",
    name: "GLM-4.7 FlashX",
    contextWindow: 200000,
    maxOutputTokens: 128000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast", "lightweight"],
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
  },
  {
    id: "GLM-4-Long",
    name: "GLM-4 Long",
    contextWindow: 1000000,
    maxOutputTokens: 4096,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["long-context"],
  },
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
  },
];

// ─── 通义千问 (Qwen) ─────────────────────────────────────────

const qwenModels: ModelDef[] = [
  {
    id: "qwen3-max",
    name: "Qwen3 Max",
    contextWindow: 262144,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship"],
  },
  {
    id: "qwen3.6-plus",
    name: "Qwen3.6 Plus (多模态旗舰)",
    contextWindow: 1000000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship", "vision", "video"],
  },
  {
    id: "qwen3.5-plus",
    name: "Qwen3.5 Plus (多模态)",
    contextWindow: 1000000,
    supportsFunctions: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["balanced", "vision", "video"],
  },
  {
    id: "qwen3.5-flash",
    name: "Qwen3.5 Flash",
    contextWindow: 1000000,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast", "cheap"],
  },
  {
    id: "qwen-plus",
    name: "Qwen Plus",
    contextWindow: 131072,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general"],
  },
  {
    id: "qwen-turbo",
    name: "Qwen Turbo",
    contextWindow: 131072,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["lightweight"],
  },
  {
    id: "qwen3-coder-plus",
    name: "Qwen3 Coder Plus",
    contextWindow: 262144,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["coding"],
  },
  {
    id: "qwq-plus",
    name: "QwQ Plus",
    contextWindow: 131072,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["reasoning"],
  },
  {
    id: "qwen-long",
    name: "Qwen Long",
    contextWindow: 10000000,
    supportsFunctions: false,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["long-context"],
  },
];

// ─── DeepSeek ─────────────────────────────────────────────────

const deepseekModels: ModelDef[] = [
  {
    id: "deepseek-chat",
    name: "DeepSeek V3.2 (对话)",
    contextWindow: 128000,
    maxOutputTokens: 8192,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["general", "functions"],
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek V3.2 (推理)",
    contextWindow: 128000,
    maxOutputTokens: 65536,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["reasoning"],
  },
];

// ─── MiniMax ──────────────────────────────────────────────────

const minimaxModels: ModelDef[] = [
  {
    id: "MiniMax-M2.7",
    name: "MiniMax M2.7",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["flagship"],
  },
  {
    id: "MiniMax-M2.7-highspeed",
    name: "MiniMax M2.7 极速",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast"],
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax M2.5",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: true,
    supportsStreaming: true,
    tags: ["coding"],
  },
  {
    id: "MiniMax-M2.5-highspeed",
    name: "MiniMax M2.5 极速",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["fast"],
  },
  {
    id: "MiniMax-M2.1",
    name: "MiniMax M2.1",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["coding", "multilingual"],
  },
  {
    id: "MiniMax-M2",
    name: "MiniMax M2",
    contextWindow: 204800,
    supportsFunctions: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStreaming: true,
    tags: ["agent"],
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

// ─── Exports ──────────────────────────────────────────────────

/** Returns the full built-in model catalog (5 providers + custom). */
export function getModelCatalog(): ProviderDef[] {
  return [...PROVIDERS, CUSTOM_PROVIDER];
}

/** Look up a provider by ID. */
export function getProviderById(id: string): ProviderDef | undefined {
  if (id === "custom") return CUSTOM_PROVIDER;
  return PROVIDERS.find((p) => p.id === id);
}

/** Look up a model by provider ID and model ID. */
export function getModelById(providerId: string, modelId: string): ModelDef | undefined {
  const provider = getProviderById(providerId);
  if (!provider) return undefined;
  return provider.models.find((m) => m.id === modelId);
}
