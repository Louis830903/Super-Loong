/**
 * chat.test.ts — 对话路由集成测试
 *
 * 覆盖端点（非 SSE 部分，SSE 需 E2E）:
 *   POST   /api/chat                 — 发送消息
 *   GET    /api/conversations         — 列出对话
 *   POST   /api/conversations         — 创建对话
 *   GET    /api/conversations/:id/messages — 消息列表
 *   DELETE /api/conversations/:id     — 删除对话
 *   PATCH  /api/conversations/:id     — 更新对话
 *   GET    /api/conversations/search  — FTS 搜索
 *   Legacy: GET /api/sessions, GET /api/sessions/:id, DELETE /api/sessions/:id
 *   Legacy: GET /api/sessions/search
 *   POST   /v1/chat/completions       — OpenAI 兼容（非流式）
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AppContext } from "../context.js";
import { MockAgentManager } from "./test-helpers.js";

// ─── Mock @super-agent/core 导出 ────────────────────────────

const { mockCreateConv, mockListConvs, mockGetConv, mockGetMsgs,
  mockDeleteConv, mockUpdateTitle, mockUpdateModel, mockSearchConvs,
  mockSearchSessionsFTS, mockGetProviderById, mockGetModelById,
  MockChatMessageSchema } = vi.hoisted(() => ({
  mockCreateConv: vi.fn<any>(),
  mockListConvs: vi.fn<any>(),
  mockGetConv: vi.fn<any>(),
  mockGetMsgs: vi.fn<any>(),
  mockDeleteConv: vi.fn<any>(),
  mockUpdateTitle: vi.fn<any>(),
  mockUpdateModel: vi.fn<any>(),
  mockSearchConvs: vi.fn<any>(() => []),
  mockSearchSessionsFTS: vi.fn(() => []),
  mockGetProviderById: vi.fn(() => null),
  mockGetModelById: vi.fn(() => null),
  // 一个简单的 ChatMessageSchema mock
  MockChatMessageSchema: {
    safeParse: vi.fn((data: any) => {
      if (!data || !data.message) {
        return { success: false, error: { issues: [{ message: "message is required" }], flatten: () => ({ fieldErrors: {} }) } };
      }
      return { success: true, data: { ...data, agentId: data.agentId ?? "agent-1", sessionId: data.sessionId, message: data.message } };
    }),
  },
}));

vi.mock("@super-agent/core", () => ({
  ChatMessageSchema: MockChatMessageSchema,
  searchSessionsFTS: mockSearchSessionsFTS,
  createConversation: mockCreateConv,
  listConversations: mockListConvs,
  getConversation: mockGetConv,
  getConvMessages: mockGetMsgs,
  deleteConversation: mockDeleteConv,
  updateConversationTitle: mockUpdateTitle,
  updateConversationModel: mockUpdateModel,
  searchConvMessages: mockSearchConvs,
  getProviderById: mockGetProviderById,
  getModelById: mockGetModelById,
}));

// 动态导入
let chatRoutes: typeof import("../routes/chat.js").chatRoutes;
beforeEach(async () => {
  const mod = await import("../routes/chat.js");
  chatRoutes = mod.chatRoutes;
  vi.clearAllMocks();
});

// ─── Mock Agent（含 chat/stream/session 方法）──────────────

function createMockAgent(id: string) {
  const sessions = new Map<string, any>();
  return {
    id,
    state: { id, config: { name: "Test", llmProvider: { type: "openai", model: "gpt-4o-mini" } } },
    config: { name: "Test", llmProvider: { type: "openai", model: "gpt-4o-mini" } },
    async chat(message: string, sessionId?: string) {
      return {
        sessionId: sessionId ?? "sess-1",
        response: `回应: ${message}`,
        toolCalls: [],
        attachments: [],
      };
    },
    async *chatStream(message: string, _sessionId?: string) {
      yield `回应: ${message}`;
    },
    getSession(id: string) {
      if (!sessions.has(id)) sessions.set(id, { id, messages: [] });
      return sessions.get(id);
    },
    listSessions() {
      return Array.from(sessions.values());
    },
    findSession(id: string) {
      return sessions.get(id);
    },
    deleteSession(id: string) {
      return sessions.delete(id);
    },
  };
}

// ─── buildApp 辅助注册 chatRoutes ──────────────────────────

async function buildAppChat(ctx: Partial<AppContext>) {
  const { createFastify } = await import("./test-helpers.js");
  const app = createFastify();
  await chatRoutes(app, ctx as AppContext);
  await app.ready();
  return app;
}

describe("对话路由", () => {
  let mgr: MockAgentManager;
  let agent: ReturnType<typeof createMockAgent>;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    mgr = new MockAgentManager();
    agent = createMockAgent("agent-1");
    // 用 getAgent 覆盖以返回我们的 mock agent
    const origGetAgent = mgr.getAgent.bind(mgr);
    mgr.getAgent = (id: string) => {
      if (id === "agent-1") return agent as any;
      return origGetAgent(id);
    };
    mgr.listAgents = () => [agent as any];
    ctx = {
      agentManager: mgr as any,
      dedup: { check: vi.fn(() => undefined), record: vi.fn() },
      providerStore: { get: vi.fn(() => null) } as any,
    } as unknown as Partial<AppContext>;

    // 设置 conversation mock 默认返回值
    mockCreateConv.mockReturnValue({ id: "conv-1", agentId: "a1", title: null, messageCount: 0 });
    mockListConvs.mockReturnValue([]);
    mockGetConv.mockReturnValue(null);
    mockGetMsgs.mockReturnValue([]);
  });

  // ── POST /api/chat ─────────────────────────────────────

  it("POST /chat 缺 message 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/chat",
      payload: { agentId: "agent-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /chat Agent 不存在返回 404", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/chat",
      payload: { agentId: "nonexistent", message: "hello" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /chat 成功返回响应", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/chat",
      payload: { agentId: "agent-1", message: "你好" },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.response).toBe("回应: 你好");
  });

  it("POST /chat 携带 requestId 可去重", async () => {
    const dedupCache = new Map();
    // v3: DedupCache 要求 markSeen/isSeen/destroy，这里只 mock 用到的 check/record
    ctx.dedup = {
      check: vi.fn((rid: string) => dedupCache.get(rid)),
      record: vi.fn((rid: string, resp: any) => { dedupCache.set(rid, resp); }),
    } as any;
    const app = await buildAppChat(ctx);

    // 第一次请求，缓存结果
    const res1 = await app.inject({
      method: "POST", url: "/api/chat",
      payload: { agentId: "agent-1", message: "去重测试", requestId: "rid-1" },
    });
    expect(res1.statusCode).toBe(200);

    // 第二次同样 requestId，应返回缓存
    const res2 = await app.inject({
      method: "POST", url: "/api/chat",
      payload: { agentId: "agent-1", message: "ignore", requestId: "rid-1" },
    });
    expect(res2.statusCode).toBe(200);
    // 去重缓存直接返回原始响应对象（绕过 sendSuccess），故取 .response 而非 .data.response
    expect(JSON.parse(res2.body).response).toBe("回应: 去重测试");
  });

  // ── GET /api/conversations ─────────────────────────────

  it("GET /conversations 缺 agentId 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({ method: "GET", url: "/api/conversations" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /conversations 返回对话列表", async () => {
    mockListConvs.mockReturnValue([{ id: "conv-1", agentId: "agent-1", title: "Test" }]);
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/conversations?agentId=agent-1",
    });
    expect(res.statusCode).toBe(200);
  });

  // ── POST /api/conversations ────────────────────────────

  it("POST /conversations 缺 agentId 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/conversations",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /conversations 创建成功", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/api/conversations",
      payload: { agentId: "agent-1", title: "新对话" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockCreateConv).toHaveBeenCalled();
  });

  // ── GET /api/conversations/:id/messages ─────────────────

  it("GET /conversations/:id/messages 不存在返回 404", async () => {
    mockGetConv.mockReturnValueOnce(null);
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/conversations/nonexistent/messages",
    });
    expect(res.statusCode).toBe(404);
  });

  it("GET /conversations/:id/messages 成功", async () => {
    mockGetConv.mockReturnValueOnce({ id: "conv-1", agentId: "a1", title: "T", messageCount: 0 });
    mockGetMsgs.mockReturnValueOnce([]);
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/conversations/conv-1/messages",
    });
    expect(res.statusCode).toBe(200);
  });

  // ── DELETE /api/conversations/:id ──────────────────────

  it("DELETE /conversations/:id 不存在返回 404", async () => {
    mockGetConv.mockReturnValueOnce(null);
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "DELETE", url: "/api/conversations/nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /conversations/:id 成功", async () => {
    mockGetConv.mockReturnValueOnce({ id: "conv-1", agentId: "a1", title: "T" });
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "DELETE", url: "/api/conversations/conv-1",
    });
    expect(res.statusCode).toBe(200);
    expect(mockDeleteConv).toHaveBeenCalledWith("conv-1");
  });

  // ── PATCH /api/conversations/:id ───────────────────────

  it("PATCH /conversations/:id 不存在返回 404", async () => {
    mockGetConv.mockReturnValueOnce(null);
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "PATCH", url: "/api/conversations/nonexistent",
      payload: { title: "new" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH /conversations/:id 更新标题成功", async () => {
    mockGetConv.mockReturnValue({ id: "conv-1", agentId: "a1", title: "old", messageCount: 0 });
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "PATCH", url: "/api/conversations/conv-1",
      payload: { title: "新标题" },
    });
    expect(res.statusCode).toBe(200);
    expect(mockUpdateTitle).toHaveBeenCalledWith("conv-1", "新标题");
  });

  it("PATCH /conversations/:id 缺 title 和 modelOverride 返回 400", async () => {
    mockGetConv.mockReturnValueOnce({ id: "conv-1", agentId: "a1", title: "old" });
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "PATCH", url: "/api/conversations/conv-1",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ── GET /api/conversations/search ──────────────────────

  it("GET /conversations/search 缺 q 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/conversations/search",
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /conversations/search 成功", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/conversations/search?q=test",
    });
    expect(res.statusCode).toBe(200);
  });

  // ── POST /v1/chat/completions (OpenAI compat) ──────────

  it("POST /v1/chat/completions 缺 messages 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /v1/chat/completions 非流式成功", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "POST", url: "/v1/chat/completions",
      payload: {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.choices).toBeDefined();
    expect(body.data.choices[0].message.content).toBe("回应: Hello");
  });

  // ── Legacy Sessions ────────────────────────────────────

  it("GET /sessions 缺少 agentId 返回空", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({ method: "GET", url: "/api/sessions" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data.sessions).toEqual([]);
  });

  it("GET /sessions 列出 Agent 的 sessions", async () => {
    agent.chat("msg", "sess-1");
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/sessions?agentId=agent-1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /sessions/:id 存在返回详情", async () => {
    // 需要先通过 agent.getSession 创建 session（chat mock 不会自动创建）
    agent.getSession("sess-1");
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/sessions/sess-1?agentId=agent-1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /sessions/:id Agent 不存在返回 404", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/sessions/sess-1?agentId=nonexistent",
    });
    expect(res.statusCode).toBe(404);
  });

  it("DELETE /sessions/:id 成功", async () => {
    agent.getSession("sess-1");
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "DELETE", url: "/api/sessions/sess-1?agentId=agent-1",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /sessions/search 缺 q 返回 400", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({ method: "GET", url: "/api/sessions/search" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /sessions/search 成功", async () => {
    const app = await buildAppChat(ctx);
    const res = await app.inject({
      method: "GET", url: "/api/sessions/search?q=test",
    });
    expect(res.statusCode).toBe(200);
  });
});
