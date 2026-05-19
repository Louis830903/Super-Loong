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
  /** 模型价格（/1M tokens），Ollama 本地模型为 0 */
  pricing?: { input: number; output: number; unit: "CNY/1M_tokens" | "USD/1M_tokens" };
  /** 废弃信息（遗留别名标记） */
  deprecation?: { sunsetDate: string; migratedTo: string };
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

// ─── Provider Model Lists ─────────────────────────────────────

import { moonshotModels } from "./model-catalog/moonshot-models.js";
import { zhipuModels } from "./model-catalog/zhipu-models.js";

import { qwenModels } from "./model-catalog/qwen-models.js";
import { deepseekModels } from "./model-catalog/deepseek-models.js";
import { minimaxModels } from "./model-catalog/minimax-models.js";
import { doubaoModels } from "./model-catalog/doubao-models.js";

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
