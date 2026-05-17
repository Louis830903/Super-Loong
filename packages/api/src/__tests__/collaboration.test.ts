/**
 * collaboration.test.ts — 协作路由集成测试
 *
 * 覆盖端点:
 *   POST   /api/collab/crew              — 运行 Crew
 *   GET    /api/collab/crew/history       — Crew 历史
 *   POST   /api/collab/groupchat          — 启动 GroupChat
 *   GET    /api/collab/groupchat/history   — GroupChat 历史
 *   GET    /api/collab/running            — 运行中任务
 *   POST   /api/collab/cancel/:taskId     — 取消任务
 *   GET    /api/collab/events             — SSE 实时事件
 *   GET    /api/collab/history            — 分页历史
 *   GET    /api/collab/stats              — 统计
 *   GET    /api/collab/attachment         — 附件下载
 *   POST   /api/collab/deliver            — IM 投递
 *   GET    /api/collab/download/:id       — ZIP 打包下载
 *   GET    /api/collab/env-check          — 环境检测
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppContext } from "../context.js";
import { collaborationRoutes } from "../routes/collaboration.js";
import { buildApp, MockCollaborationOrchestrator } from "./test-helpers.js";

// Mock getCollabOutputsRoot / getWorkspacePath / checkPythonDocLibs
const { mockCollabRoot, mockWorkspacePath, mockCheckDocLibs } = vi.hoisted(() => ({
  mockCollabRoot: vi.fn(() => "/mock/collab-outputs"),
  mockWorkspacePath: vi.fn((_id: string) => "/mock/collab-outputs/workspace-1"),
  mockCheckDocLibs: vi.fn(async () => ({ python: true, fpdf: true, python_docx: true })),
}));

vi.mock("@super-agent/core", () => ({
  getCollabOutputsRoot: mockCollabRoot,
  getWorkspacePath: mockWorkspacePath,
  checkPythonDocLibs: mockCheckDocLibs,
}));

// Mock fs 操作
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual("node:fs/promises");
  return {
    ...(actual as object),
    stat: vi.fn(async (_p: string) => ({ size: 1024, isFile: () => true, isDirectory: () => false })),
    readFile: vi.fn(async (_p: string) => Buffer.from("mock")),
    readdir: vi.fn(async (_p: string, _opts?: any) => []),
    realpath: vi.fn(async (p: string) => p),
    unlink: vi.fn(async () => {}),
    createReadStream: vi.fn(() => {
      const { Readable } = require("node:stream");
      return Readable.from([Buffer.from("mock")]);
    }),
  };
});

describe("协作路由", () => {
  let orchestrator: MockCollaborationOrchestrator;
  let ctx: Partial<AppContext>;

  beforeEach(() => {
    orchestrator = new MockCollaborationOrchestrator();
    ctx = { collaborationOrchestrator: orchestrator as any } as unknown as Partial<AppContext>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══ Crew: Task Orchestration ══════════════════════════

  it("POST /collab/crew 缺 name 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: { tasks: [{ id: "t1", description: "做点什么", expectedOutput: "输出" }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew 缺 tasks 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: { name: "测试任务" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew name 超长返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "x".repeat(101),
        tasks: [{ id: "t1", description: "做点什么", expectedOutput: "输出" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew sequential 成功运行", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "日报生成",
        process: "sequential",
        tasks: [
          { id: "t1", description: "收集数据", expectedOutput: "原始数据", agentId: "agent-1" },
          { id: "t2", description: "生成报告", expectedOutput: "报告内容", agentId: "agent-2" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.type).toBe("crew");
    expect(body.data.status).toBe("completed");
  });

  it("POST /collab/crew hierarchical + autoAssign 成功", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "智能分配任务",
        process: "hierarchical",
        managerAgentId: "manager-1",
        autoAssign: true,
        maxDynamicAgents: 5,
        tasks: [
          { id: "t1", description: "分析需求", expectedOutput: "需求文档" },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it("POST /collab/crew autoAssign 非 hierarchical 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "无效配置",
        process: "sequential",
        managerAgentId: "manager-1",
        autoAssign: true,
        tasks: [{ id: "t1", description: "任务", expectedOutput: "输出" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew autoAssign 无 managerAgentId 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "缺 Manager",
        process: "hierarchical",
        autoAssign: true,
        tasks: [{ id: "t1", description: "任务", expectedOutput: "输出" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew maxDynamicAgents 非 autoAssign 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "误用参数",
        managerAgentId: "manager-1",
        maxDynamicAgents: 5,
        tasks: [{ id: "t1", description: "任务", expectedOutput: "输出" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/crew taskTimeoutMs 低于最小值返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "超时过短",
        taskTimeoutMs: 100,
        tasks: [{ id: "t1", description: "任务", expectedOutput: "输出" }],
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /collab/crew/history 返回历史列表", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    // 先创建一条
    await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "历史任务",
        tasks: [{ id: "t1", description: "做点什么", expectedOutput: "输出" }],
      },
    });
    const res = await app.inject({ method: "GET", url: "/api/collab/crew/history" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
  });

  // ═══ GroupChat: Conversation Negotiation ═══════════════

  it("POST /collab/groupchat 缺 name 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: { participantIds: ["a1", "a2"], initialMessage: "Hello" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/groupchat 缺 participantIds 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: { name: "讨论", initialMessage: "Hello" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/groupchat 缺 initialMessage 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: { name: "讨论", participantIds: ["a1"] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/groupchat 成功启动", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: {
        name: "需求讨论",
        participantIds: ["agent-1", "agent-2"],
        initialMessage: "我们来讨论新功能的设计方案",
        speakerSelection: "round_robin",
        maxTurns: 5,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.type).toBe("groupchat");
    expect(body.data.status).toBe("completed");
  });

  it("POST /collab/groupchat 非法 speakerSelection 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: {
        name: "讨论",
        participantIds: ["a1"],
        initialMessage: "Hello",
        speakerSelection: "invalid_mode",
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("GET /collab/groupchat/history 返回历史列表", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    await app.inject({
      method: "POST",
      url: "/api/collab/groupchat",
      payload: { name: "历史讨论", participantIds: ["a1"], initialMessage: "开始" },
    });
    const res = await app.inject({ method: "GET", url: "/api/collab/groupchat/history" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toHaveLength(1);
  });

  // ═══ Execution Control ═════════════════════════════════

  it("GET /collab/running 返回运行中任务", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/running" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).data).toBeInstanceOf(Array);
  });

  it("POST /collab/cancel/:taskId 缺失 taskId 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    // 用空字符串来触发校验
    const res = await app.inject({ method: "POST", url: "/api/collab/cancel/" });
    // Fastify 不会匹配空 param 的路由，所以返回 404
    expect([404, 400]).toContain(res.statusCode);
  });

  it("POST /collab/cancel/:taskId 不存在返回 404", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "POST", url: "/api/collab/cancel/nonexistent" });
    expect(res.statusCode).toBe(404);
  });

  // ═══ SSE Events ════════════════════════════════════════

  // SSE 端点是长连接，app.inject() 无法正确处理（会一直等待数据流结束），
  // 需要浏览器/E2E 测试覆盖。此处跳过。
  it.skip("GET /collab/events 返回 SSE 头", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET",
      url: "/api/collab/events",
      headers: { accept: "text/event-stream" },
    });
    // SSE 端点设置原始 writeHead，inject 可能拿不到 body 但有 statusCode
    // 预期是 200 或连接异常
    expect(res.statusCode).toBe(200);
  });

  // ═══ History & Stats ═══════════════════════════════════

  it("GET /collab/history 返回分页历史", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET",
      url: "/api/collab/history?page=1&pageSize=10",
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.results).toBeDefined();
    expect(body.data.total).toBeDefined();
    expect(body.data.page).toBe(1);
  });

  it("GET /collab/history 支持 type 过滤", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET",
      url: "/api/collab/history?type=crew",
    });
    expect(res.statusCode).toBe(200);
  });

  it("GET /collab/stats 返回统计数据", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/stats" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.totalCrews).toBeDefined();
  });

  // ═══ Attachment Download ═══════════════════════════════

  it("GET /collab/attachment 缺 path 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/attachment" });
    expect(res.statusCode).toBe(400);
  });

  it("GET /collab/attachment 路径在白名单外返回 403", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "GET",
      url: "/api/collab/attachment?path=/etc/passwd",
    });
    expect(res.statusCode).toBe(403);
  });

  // ═══ IM Deliver ════════════════════════════════════════

  it("POST /collab/deliver 缺 resultId 返回 400", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/deliver",
      payload: { channelId: "feishu", chatId: "chat-1" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("POST /collab/deliver 结果不存在返回 404", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({
      method: "POST",
      url: "/api/collab/deliver",
      payload: { resultId: "nonexistent", channelId: "feishu", chatId: "chat-1" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("POST /collab/deliver IM 网关不可达返回 503", async () => {
    // 先创建一条结果
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const crewRes = await app.inject({
      method: "POST",
      url: "/api/collab/crew",
      payload: {
        name: "投递测试",
        tasks: [{ id: "t1", description: "做点什么", expectedOutput: "输出" }],
      },
    });
    const resultId = JSON.parse(crewRes.body).data.id;

    // Mock fetch 失败
    const origFetch = global.fetch;
    global.fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/api/collab/deliver",
        payload: { resultId, channelId: "feishu", chatId: "chat-1" },
      });
      expect(res.statusCode).toBe(503);
    } finally {
      global.fetch = origFetch;
    }
  });

  // ═══ ZIP Download ══════════════════════════════════════

  it("GET /collab/download/:id 缺 id 返回 400（路由校验）", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/download/" });
    // 路由匹配到 /download/ 但 id 为空 → 路由内校验返回 400
    expect(res.statusCode).toBe(400);
  });

  it("GET /collab/download/:id 结果不存在返回 404 或 403（Windows 路径差异）", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/download/nonexistent" });
    // 结果不存在 → fallback 到 getWorkspacePath
    // Windows 下 path.resolve("/mock/...") 会被解析为 D:\mock\...
    // 而 collabRoot 仍为 "/mock/..."，导致白名单校验失败 → 403
    // Linux/Mac 下则可能通过白名单到达目录检查 → 404
    expect([403, 404]).toContain(res.statusCode);
  });

  // ═══ Env Check ═════════════════════════════════════════

  it("GET /collab/env-check 返回环境检测结果", async () => {
    const app = await buildApp(collaborationRoutes, ctx as AppContext);
    const res = await app.inject({ method: "GET", url: "/api/collab/env-check" });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.data.python).toBe(true);
  });
});
