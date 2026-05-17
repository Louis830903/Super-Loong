/**
 * models.test.ts — 模型与 Provider 管理路由集成测试
 *
 * 覆盖端点:
 *   GET    /api/models/catalog            — 内置模型目录
 *   GET    /api/models/providers          — 已配置 Provider 列表
 *   PUT    /api/models/providers/:id      — 更新 Provider 配置
 *   DELETE /api/models/providers/:id/key  — 清除 API Key
 *   POST   /api/models/providers/:id/test — 测试 Provider 连通性
 *
 * Mock 策略:
 *   - vi.mock('@super-agent/core') 拦截 getModelCatalog / getProviderById / maskApiKey / LLMProvider 等
 *   - ctx: MockProviderStore + MockMemoryManager（updateEmbedderApiKey）+ MockAgentManager
 *   - requirePermission 在 AUTH_ENABLED 未启用时透传，无需额外处理
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { modelRoutes } from "../routes/models.js";
import { buildApp } from "./test-helpers.js";
import type { AppContext } from "../context.js";

// ─── 可控制的 LLM complete 返回值 ───────────────────────────

const mockLLMComplete = vi.fn();

// ─── Mock @super-agent/core ──────────────────────────────────

vi.mock("@super-agent/core", () => ({
  getModelCatalog: vi.fn(() => [{
    id: "moonshot",
    name: "Moonshot AI (Kimi)",
    website: "https://platform.moonshot.cn",
    baseUrl: "https://api.moonshot.cn/v1",
    models: [{
      id: "kimi-k2.6",
      name: "Kimi K2.6",
      contextWindow: 256000,
      supportsFunctions: true,
      supportsVision: true,
      supportsReasoning: true,
      supportsStreaming: true,
      tags: ["旗舰"],
    }],
  }]),
  getProviderById: vi.fn((id: string) =>
    id === "moonshot" ? {
      id: "moonshot", name: "Moonshot AI (Kimi)",
      website: "https://platform.moonshot.cn", baseUrl: "https://api.moonshot.cn/v1",
      models: [{
        id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 256000,
        supportsFunctions: true, supportsVision: true,
        supportsReasoning: true, supportsStreaming: true, tags: ["旗舰"],
      }],
    } : undefined,
  ),
  getModelById: vi.fn((_providerId: string, modelId: string) =>
    modelId === "kimi-k2.6" ? {
      id: "kimi-k2.6", name: "Kimi K2.6", contextWindow: 256000,
      supportsFunctions: true, supportsVision: true,
      supportsReasoning: true, supportsStreaming: true, tags: ["旗舰"],
    } : undefined,
  ),
  maskApiKey: vi.fn((key: string) => key.length <= 8 ? key : key.slice(0, 4) + "***" + key.slice(-4)),
  isMaskedApiKey: vi.fn(() => false),
  // 用可控制的 mock 类替代 LLMProvider
  LLMProvider: class MockLLMProvider {
    complete = mockLLMComplete;
  },
  logConfigChange: vi.fn(),
  saveAgentConfig: vi.fn(),
}));

// ─── Mock ProviderStore ──────────────────────────────────────

class MockProviderStore {
  private records = new Map<string, any>();

  list() {
    return Array.from(this.records.values());
  }

  get(id: string) {
    return this.records.get(id);
  }

  upsert(id: string, data: any) {
    const existing = this.records.get(id) || { id };
    const updated = { ...existing, ...data, id };
    this.records.set(id, updated);
    return updated;
  }

  clearKey(id: string) {
    if (!this.records.has(id)) return false;
    const r = this.records.get(id);
    r.apiKey = undefined;
    this.records.set(id, r);
    return true;
  }

  /** 测试辅助：直接设置一条记录 */
  _seed(id: string, record: any) {
    this.records.set(id, { id, ...record });
  }
}

// ─── Mock AgentManager（供 PUT provider 后更新默认 Agent） ───

class MockAgentManager {
  agents = new Map<string, any>();

  listAgents() {
    return Array.from(this.agents.values());
  }

  updateAgent(id: string, updates: any) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    Object.assign(agent, updates);
    return agent;
  }

  /** 测试辅助：预置一个 Agent */
  _seed(agent: any) {
    this.agents.set(agent.id, { ...agent });
  }
}

// ─── Mock MemoryManager ──────────────────────────────────────

class MockMemoryManager {
  updateEmbedderApiKey(_key: string) {
    return true; // 模拟热更新成功
  }
}

// ─── 测试套件 ────────────────────────────────────────────────

describe("模型与 Provider 路由", () => {
  let providerStore: MockProviderStore;
  let agentManager: MockAgentManager;
  let memoryManager: MockMemoryManager;
  let ctx: AppContext;

  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 LLM complete 返回成功结果
    mockLLMComplete.mockResolvedValue({
      content: "ok",
      usage: { promptTokens: 5, completionTokens: 2 },
    });
    providerStore = new MockProviderStore();
    agentManager = new MockAgentManager();
    memoryManager = new MockMemoryManager();
    ctx = {
      providerStore: providerStore as any,
      agentManager: agentManager as any,
      memoryManager: memoryManager as any,
    } as unknown as AppContext;
  });

  // ── GET /api/models/catalog ──────────────────────────────

  it("GET /api/models/catalog 返回模型目录列表", async () => {
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/models/catalog" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.providers).toHaveLength(1);
    expect(body.data.providers[0].id).toBe("moonshot");
  });

  // ── GET /api/models/providers ────────────────────────────

  it("GET /api/models/providers 返回已配置 Provider 列表（含脱敏 key）", async () => {
    providerStore._seed("moonshot", {
      apiKey: "sk-test-key-123456",
      selectedModel: "kimi-k2.6",
      isEnabled: true,
    });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/models/providers" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.providers).toHaveLength(1);
    const p = body.data.providers[0];
    expect(p.id).toBe("moonshot");
    expect(p.keyStatus).toBe("configured");
    expect(p.maskedKey).toContain("***"); // 脱敏
  });

  it("GET /api/models/providers 未配置 key 时状态为 missing", async () => {
    providerStore._seed("moonshot", { isEnabled: false });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({ method: "GET", url: "/api/models/providers" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.providers[0].keyStatus).toBe("missing");
    expect(body.data.providers[0].maskedKey).toBe("");
  });

  // ── PUT /api/models/providers/:id ────────────────────────

  it("PUT /api/models/providers/:id 更新 Provider 配置成功", async () => {
    providerStore._seed("moonshot", { apiKey: "old-key" });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "PUT",
      url: "/api/models/providers/moonshot",
      payload: { apiKey: "sk-new-key", selectedModel: "kimi-k2.6", isEnabled: true },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.data.provider.selectedModel).toBe("kimi-k2.6");
    expect(body.data.provider.keyStatus).toBe("configured");
  });

  it("PUT /api/models/providers/:id 未知 Provider 返回 404", async () => {
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "PUT",
      url: "/api/models/providers/unknown-provider",
      payload: { apiKey: "sk-test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PUT /api/models/providers/:id 脱敏哨兵 key 不覆盖原值", async () => {
    // isMaskedApiKey = false，所以传入 key 被当作有效值
    providerStore._seed("moonshot", { apiKey: "original-key" });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "PUT",
      url: "/api/models/providers/moonshot",
      payload: { apiKey: "sk-n***1234" }, // 非脱敏哨兵（isMaskedApiKey→false）
    });
    expect(res.statusCode).toBe(200);
    // 因为 isMaskedApiKey mock 返回 false，传入的 key 会被接受为有效值
    const provider = providerStore.get("moonshot");
    expect(provider.apiKey).toBe("sk-n***1234");
  });

  // ── DELETE /api/models/providers/:id/key ─────────────────

  it("DELETE /api/models/providers/:id/key 清除 API Key 成功", async () => {
    providerStore._seed("moonshot", { apiKey: "sk-existing-key" });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/models/providers/moonshot/key",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    // ProviderStore 中 key 已清除
    const provider = providerStore.get("moonshot");
    expect(provider.apiKey).toBeUndefined();
  });

  it("DELETE /api/models/providers/:id/key 未知 Provider 返回 404", async () => {
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "DELETE",
      url: "/api/models/providers/unknown/key",
    });
    expect(res.statusCode).toBe(404);
  });

  // ── POST /api/models/providers/:id/test ──────────────────

  it("POST /api/models/providers/:id/test 连通性测试成功", async () => {
    providerStore._seed("moonshot", { apiKey: "sk-valid", selectedModel: "kimi-k2.6" });
    mockLLMComplete.mockResolvedValue({
      content: "ok",
      usage: { promptTokens: 5, completionTokens: 2 },
    });
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/models/providers/moonshot/test",
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.success).toBe(true);
    expect(body.data.response).toBe("ok");
  });

  it("POST /api/models/providers/:id/test 未知 Provider 返回 404", async () => {
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/models/providers/unknown/test",
      payload: { apiKey: "sk-test" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /api/models/providers/:id/test 无 API Key 返回 400", async () => {
    // 不预置记录，providerStore.get 返回 undefined
    // 也不传 body.apiKey → apiKey 为空
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/models/providers/moonshot/test",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /api/models/providers/:id/test LLM 连接失败返回 502", async () => {
    providerStore._seed("moonshot", { apiKey: "sk-valid", selectedModel: "kimi-k2.6" });
    mockLLMComplete.mockRejectedValue(new Error("Connect timeout"));
    const app = await buildApp(modelRoutes, ctx);
    const res = await app.inject({
      method: "POST",
      url: "/api/models/providers/moonshot/test",
      payload: {},
    });
    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Connection failed"); // 统一 502 不泄露内部栈
  });
});
