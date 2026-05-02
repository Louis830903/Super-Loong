/**
 * T2.11f — 模型配置模板 + per-Agent Provider 覆盖 Vitest 测试
 *
 * 覆盖：
 * 1. PROVIDER_PRESETS 完整性（4 套预设 × 6 Agent）
 * 2. applyPerAgentProvider 三级优先级合并
 * 3. applyAllAgentProviders 批量覆盖
 * 4. ModelDef pricing 字段完整性
 */
import { describe, it, expect, vi } from "vitest";
import {
  PROVIDER_PRESETS,
  PRESET_BALANCED,
  PRESET_CHEAP,
  PRESET_ZH_BEST,
  PRESET_LOCAL,
} from "../collaboration/video-crew-provider-presets.js";
import type { AgentProviderOverride } from "../collaboration/video-crew-provider-presets.js";
import { applyPerAgentProvider, applyAllAgentProviders } from "../collaboration/crew-executor-provider.js";
import { VIDEO_AGENT_IDS } from "../collaboration/video-crew-presets.js";
import { getModelCatalog } from "../llm/model-catalog.js";
import type { AgentConfig } from "../types/index.js";

// ─── Mock ProviderStore ─────────────────────────────────────

function createMockStore(records: Record<string, { apiKey: string; baseUrl: string }>) {
  return {
    get(id: string) {
      const r = records[id];
      if (!r) return null;
      return { id, apiKey: r.apiKey, baseUrl: r.baseUrl, isEnabled: true, selectedModel: "", createdAt: "", updatedAt: "" };
    },
    // 只需要 get 方法，其他不测
    init: vi.fn(),
    syncFromEnv: vi.fn(),
    list: vi.fn(),
    upsert: vi.fn(),
    migrateKeys: vi.fn(),
    clearKey: vi.fn(),
    delete: vi.fn(),
    getActiveProvider: vi.fn(),
  } as any;
}

// ─── Mock AgentConfig 工厂 ──────────────────────────────────

function makeAgentConfig(id: string): AgentConfig {
  return {
    id,
    name: id,
    systemPrompt: "test",
    llmProvider: { type: "openai", model: "default" },
    tools: [],
    skills: [],
    channels: [],
    memoryEnabled: false,
    maxToolIterations: 5,
    metadata: {},
  };
}

// ─── 测试 ───────────────────────────────────────────────────

describe("PROVIDER_PRESETS 完整性", () => {
  const agentIds = Object.values(VIDEO_AGENT_IDS);

  it("应导出 4 套系统预设", () => {
    expect(PROVIDER_PRESETS).toHaveLength(4);
    expect(PROVIDER_PRESETS.map((p) => p.id)).toEqual(
      expect.arrayContaining(["preset_balanced", "preset_cheap", "preset_zh_best", "preset_local"])
    );
  });

  it.each([
    ["balanced", PRESET_BALANCED],
    ["cheap", PRESET_CHEAP],
    ["zh_best", PRESET_ZH_BEST],
    ["local", PRESET_LOCAL],
  ] as const)("预设 %s 应覆盖全部 6 个 Agent", (name, preset) => {
    for (const agentId of agentIds) {
      expect(preset.providers[agentId]).toBeDefined();
      expect(preset.providers[agentId].providerId).toBeTruthy();
      expect(preset.providers[agentId].model).toBeTruthy();
    }
  });

  it("每个预设应有 name 和 description", () => {
    for (const preset of PROVIDER_PRESETS) {
      expect(preset.name).toBeTruthy();
      expect(preset.description).toBeTruthy();
    }
  });
});

describe("applyPerAgentProvider 三级优先级合并", () => {
  it("override 显式值 > ProviderStore > 模型目录默认", () => {
    const agent = makeAgentConfig("test-agent");
    const override: AgentProviderOverride = {
      providerId: "qwen",
      model: "qwen-plus",
      apiKey: "explicit-key",
      baseUrl: "https://explicit.example.com/v1",
    };
    const store = createMockStore({
      qwen: { apiKey: "store-key", baseUrl: "https://store.example.com/v1" },
    });

    applyPerAgentProvider(agent, override, store);

    // override 显式值优先
    expect(agent.llmProvider.apiKey).toBe("explicit-key");
    expect(agent.llmProvider.baseUrl).toBe("https://explicit.example.com/v1");
    expect(agent.llmProvider.model).toBe("qwen-plus");
    expect(agent.llmProvider.providerId).toBe("qwen");
  });

  it("override 无 apiKey/baseUrl 时回退到 ProviderStore", () => {
    const agent = makeAgentConfig("test-agent");
    const override: AgentProviderOverride = {
      providerId: "qwen",
      model: "qwen-turbo",
    };
    const store = createMockStore({
      qwen: { apiKey: "store-key-123", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
    });

    applyPerAgentProvider(agent, override, store);

    // 回退到 ProviderStore
    expect(agent.llmProvider.apiKey).toBe("store-key-123");
    expect(agent.llmProvider.baseUrl).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });

  it("ProviderStore 也无记录时回退到模型目录默认 baseUrl", () => {
    const agent = makeAgentConfig("test-agent");
    const override: AgentProviderOverride = {
      providerId: "qwen",
      model: "qwen-plus",
    };
    // ProviderStore 无 qwen 记录
    const store = createMockStore({});

    applyPerAgentProvider(agent, override, store);

    // 回退到模型目录的默认 baseUrl
    // qwen 的默认 baseUrl 应该存在
    expect(agent.llmProvider.baseUrl).toBeTruthy();
    // apiKey 三级都无，应为 undefined
    expect(agent.llmProvider.apiKey).toBeUndefined();
  });

  it("Ollama 类型应被正确识别", () => {
    const agent = makeAgentConfig("test-agent");
    const override: AgentProviderOverride = {
      providerId: "ollama",
      model: "qwen2.5:14b",
    };
    const store = createMockStore({});

    applyPerAgentProvider(agent, override, store);

    expect(agent.llmProvider.type).toBe("ollama");
  });

  it("非 Ollama 类型应为 openai", () => {
    const agent = makeAgentConfig("test-agent");
    const override: AgentProviderOverride = {
      providerId: "deepseek",
      model: "deepseek-chat",
    };
    const store = createMockStore({});

    applyPerAgentProvider(agent, override, store);

    expect(agent.llmProvider.type).toBe("openai");
  });
});

describe("applyAllAgentProviders 批量覆盖", () => {
  it("应正确覆盖匹配的 Agent，不影响其他 Agent", () => {
    const agents = [
      makeAgentConfig("video-writer"),
      makeAgentConfig("video-designer"),
      makeAgentConfig("video-editor"),
    ];
    const providers: Record<string, AgentProviderOverride> = {
      "video-writer": { providerId: "qwen", model: "qwen-plus" },
      "video-editor": { providerId: "deepseek", model: "deepseek-chat" },
    };
    const store = createMockStore({
      qwen: { apiKey: "qwen-key", baseUrl: "https://qwen.api/v1" },
      deepseek: { apiKey: "ds-key", baseUrl: "https://deepseek.api/v1" },
    });

    applyAllAgentProviders(agents, providers, store);

    // writer 被覆盖
    expect(agents[0].llmProvider.model).toBe("qwen-plus");
    expect(agents[0].llmProvider.apiKey).toBe("qwen-key");
    // designer 未覆盖，保持默认
    expect(agents[1].llmProvider.model).toBe("default");
    // editor 被覆盖
    expect(agents[2].llmProvider.model).toBe("deepseek-chat");
    expect(agents[2].llmProvider.apiKey).toBe("ds-key");
  });
});

describe("ModelDef pricing 字段", () => {
  const catalog = getModelCatalog();

  it("Qwen 关键模型应有 pricing", () => {
    const qwen = catalog.find((p) => p.id === "qwen");
    expect(qwen).toBeDefined();
    const models = ["qwen-plus", "qwen-turbo", "qwen3-max"];
    for (const modelId of models) {
      const model = qwen!.models.find((m) => m.id === modelId);
      expect(model?.pricing).toBeDefined();
      expect(model!.pricing!.input).toBeGreaterThan(0);
      expect(model!.pricing!.output).toBeGreaterThan(0);
      expect(model!.pricing!.unit).toBe("CNY/1M_tokens");
    }
  });

  it("DeepSeek 关键模型应有 pricing", () => {
    const ds = catalog.find((p) => p.id === "deepseek");
    expect(ds).toBeDefined();
    const chat = ds!.models.find((m) => m.id === "deepseek-chat");
    expect(chat?.pricing).toBeDefined();
    expect(chat!.pricing!.input).toBe(1);
    expect(chat!.pricing!.output).toBe(2);
  });

  it("Moonshot/Kimi 模型应有 pricing", () => {
    const moonshot = catalog.find((p) => p.id === "moonshot");
    expect(moonshot).toBeDefined();
    const k26 = moonshot!.models.find((m) => m.id === "kimi-k2.6");
    expect(k26?.pricing).toBeDefined();
    expect(k26!.pricing!.input).toBe(1.1);
    expect(k26!.pricing!.output).toBe(6.5);
  });

  it("GLM 免费模型 pricing 应为 0", () => {
    const zhipu = catalog.find((p) => p.id === "zhipu");
    expect(zhipu).toBeDefined();
    const flash = zhipu!.models.find((m) => m.id === "GLM-4.7-Flash");
    expect(flash?.pricing).toBeDefined();
    expect(flash!.pricing!.input).toBe(0);
    expect(flash!.pricing!.output).toBe(0);
  });

  it("MiniMax M2.7 应有正确 pricing", () => {
    const minimax = catalog.find((p) => p.id === "minimax");
    expect(minimax).toBeDefined();
    const m27 = minimax!.models.find((m) => m.id === "MiniMax-M2.7");
    expect(m27?.pricing).toBeDefined();
    expect(m27!.pricing!.input).toBe(2.1);
    expect(m27!.pricing!.output).toBe(8.4);
  });

  it("Ollama 本地模型无 pricing（或为 0）", () => {
    const ollama = catalog.find((p) => p.id === "ollama");
    if (ollama) {
      for (const m of ollama.models) {
        if (m.pricing) {
          expect(m.pricing.input).toBe(0);
          expect(m.pricing.output).toBe(0);
        }
      }
    }
  });
});
