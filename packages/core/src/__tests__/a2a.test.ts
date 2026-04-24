/**
 * A2A 协议综合测试 — 18 用例
 *
 * 覆盖：Agent 注册表、Task 状态机、消息/Artifact 工厂、
 *       A2AClient RPC、PushNotificationDispatcher、URL 安全校验。
 *
 * @see a2a-spec.md — 协议规范
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── 注册表 ──────────────────────────────────────────────────
import { InMemoryAgentRegistry } from "../collaboration/agent-registry.js";

// ─── Task 状态机 ────────────────────────────────────────────
import {
  TaskStore,
  InvalidTransitionError,
  TaskNotFoundError,
} from "../collaboration/a2a-task.js";

// ─── 类型 + 辅助函数 ────────────────────────────────────────
import {
  TaskState,
  isTerminalState,
  isInterruptedState,
  mapAttachmentToA2APart,
  mapA2APartToAttachment,
  type A2AAgentCard,
  type A2AMessage,
  type Part,
} from "../collaboration/a2a-types.js";

// ─── 消息工厂 ───────────────────────────────────────────────
import {
  createMessage,
  createArtifact,
  createTextMessage,
  attachmentsToParts,
  partsToAttachments,
} from "../collaboration/a2a-message.js";

// ─── Push 分发器 ────────────────────────────────────────────
import { PushNotificationDispatcher } from "../collaboration/a2a-push.js";

// ─── Mock tracing（A2AClient 依赖） ─────────────────────────
vi.mock("../tracing/tracer.js", () => ({
  currentTraceId: () => "test-trace-id-1234",
  withSpan: (_name: string, _attrs: unknown, fn: () => unknown) => fn(),
}));

// ─── A2AClient ──────────────────────────────────────────────
import { A2AClient, A2AClientError } from "../collaboration/a2a-client.js";

// ─── 测试用 AgentCard 工厂 ──────────────────────────────────

function makeCard(name: string, url = "https://example.com"): A2AAgentCard {
  return {
    name,
    description: `${name} agent`,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    url,
    capabilities: { streaming: true, pushNotifications: false },
    skills: [
      { id: "s1", name: "translate", description: "翻译", tags: ["nlp", "i18n"] },
    ],
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
  };
}

// ═══════════════════════════════════════════════════════════════
// 1. Agent Registry（3 用例）
// ═══════════════════════════════════════════════════════════════

describe("InMemoryAgentRegistry", () => {
  let registry: InMemoryAgentRegistry;

  beforeEach(() => {
    registry = new InMemoryAgentRegistry();
  });

  // ── 1) discover-empty ──────────────────────────────────────
  it("discover-empty: 空注册表返回空列表", async () => {
    const cards = await registry.discover();
    expect(cards).toEqual([]);
  });

  // ── 2) register-and-discover ───────────────────────────────
  it("register-and-discover: 注册后可发现并精确解析", async () => {
    const card = makeCard("translator");
    await registry.register(card, 60_000);

    // discover 无过滤
    const all = await registry.discover();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe("translator");

    // discover 按 capability 过滤
    const byCapability = await registry.discover({ capability: "translate" });
    expect(byCapability).toHaveLength(1);

    const noMatch = await registry.discover({ capability: "coding" });
    expect(noMatch).toHaveLength(0);

    // discover 按 tag 过滤
    const byTag = await registry.discover({ tag: "nlp" });
    expect(byTag).toHaveLength(1);

    // resolve 精确查找
    const resolved = await registry.resolve("translator");
    expect(resolved).not.toBeNull();
    expect(resolved!.name).toBe("translator");

    // resolve 不存在的
    const notFound = await registry.resolve("nonexistent");
    expect(notFound).toBeNull();
  });

  // ── 3) heartbeat-expire ────────────────────────────────────
  it("heartbeat-expire: TTL 过期后变为离线", async () => {
    const card = makeCard("ephemeral");
    // 注册时 TTL=1ms（立即过期）
    await registry.register(card, 1);

    // 等待过期
    await new Promise((r) => setTimeout(r, 10));

    // 惰性淘汰后不可发现
    const cards = await registry.discover({ onlineOnly: true });
    expect(cards).toHaveLength(0);

    // resolve 也返回 null
    const resolved = await registry.resolve("ephemeral");
    expect(resolved).toBeNull();

    // 心跳续活后恢复
    await registry.heartbeat("ephemeral");
    const after = await registry.resolve("ephemeral");
    expect(after).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
// 2. Task State Machine（4 用例）
// ═══════════════════════════════════════════════════════════════

describe("TaskStore", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore(); // 无 SQLite 持久化
  });

  // ── 4) task-state-transition ───────────────────────────────
  it("task-state-transition: 合法状态转换链", () => {
    const task = store.createTask("ctx-1");
    expect(task.status.state).toBe(TaskState.SUBMITTED);

    // submitted → working
    const t1 = store.transition(task.id, TaskState.WORKING);
    expect(t1.status.state).toBe(TaskState.WORKING);

    // working → input-required
    const t2 = store.transition(task.id, TaskState.INPUT_REQUIRED);
    expect(t2.status.state).toBe(TaskState.INPUT_REQUIRED);

    // input-required → working（恢复）
    const t3 = store.transition(task.id, TaskState.WORKING);
    expect(t3.status.state).toBe(TaskState.WORKING);

    // working → completed（终止）
    const t4 = store.transition(task.id, TaskState.COMPLETED);
    expect(t4.status.state).toBe(TaskState.COMPLETED);
    expect(isTerminalState(t4.status.state)).toBe(true);
  });

  // ── 5) task-state-terminal-immutable ───────────────────────
  it("task-state-terminal-immutable: 终止态不可再转换", () => {
    const task = store.createTask("ctx-2");
    store.transition(task.id, TaskState.WORKING);
    store.transition(task.id, TaskState.FAILED);

    // 尝试从 FAILED 转换 → 抛出 InvalidTransitionError
    expect(() => store.transition(task.id, TaskState.WORKING)).toThrow(
      InvalidTransitionError,
    );

    // CANCELED 同理
    const t2 = store.createTask("ctx-3");
    store.transition(t2.id, TaskState.WORKING);
    store.transition(t2.id, TaskState.CANCELED);
    expect(() => store.transition(t2.id, TaskState.WORKING)).toThrow(
      InvalidTransitionError,
    );
  });

  // ── 6) context-id-grouping ────────────────────────────────
  it("context-id-grouping: 同 contextId 分组查询", () => {
    store.createTask("ctx-A");
    store.createTask("ctx-A");
    store.createTask("ctx-B");

    const groupA = store.listTasks({ contextId: "ctx-A" });
    expect(groupA).toHaveLength(2);

    const groupB = store.listTasks({ contextId: "ctx-B" });
    expect(groupB).toHaveLength(1);

    const all = store.listTasks();
    expect(all).toHaveLength(3);
  });

  // ── 7) artifact-versioning ────────────────────────────────
  it("artifact-versioning: Artifact 添加与追加", () => {
    const task = store.createTask("ctx-art");
    store.transition(task.id, TaskState.WORKING);

    // 添加完整 Artifact
    const artifact = createArtifact("report", [{ kind: "text", text: "v1" }]);
    store.addArtifact(task.id, artifact);

    let updated = store.getTask(task.id)!;
    expect(updated.artifacts).toHaveLength(1);
    expect(updated.artifacts[0].name).toBe("report");

    // 追加分块
    store.appendArtifactChunk(task.id, artifact.artifactId, [
      { kind: "text", text: " v2" },
    ], { append: true });

    updated = store.getTask(task.id)!;
    expect(updated.artifacts[0].parts).toHaveLength(2);

    // 不存在的 Task 抛异常
    expect(() => store.getTask("nonexistent")).not.toThrow();
    expect(store.getTask("nonexistent")).toBeNull();
    expect(() => store.addArtifact("nonexistent", artifact)).toThrow(TaskNotFoundError);
  });
});

// ═══════════════════════════════════════════════════════════════
// 3. Message / Part 映射（2 用例）
// ═══════════════════════════════════════════════════════════════

describe("Message & Part", () => {
  // ── 8) message-factory ─────────────────────────────────────
  it("message-factory: createMessage / createArtifact / createTextMessage", () => {
    // createMessage
    const msg = createMessage("user", [{ kind: "text", text: "hello" }], {
      contextId: "ctx-1",
    });
    expect(msg.role).toBe("user");
    expect(msg.parts).toHaveLength(1);
    expect(msg.messageId).toBeTruthy();
    expect(msg.contextId).toBe("ctx-1");

    // createArtifact
    const art = createArtifact("doc", [{ kind: "text", text: "content" }], "A doc");
    expect(art.name).toBe("doc");
    expect(art.artifactId).toBeTruthy();
    expect(art.description).toBe("A doc");

    // createTextMessage
    const txt = createTextMessage("你好", "ctx-2");
    expect(txt.role).toBe("user");
    expect(txt.parts[0]).toEqual({ kind: "text", text: "你好" });
    expect(txt.contextId).toBe("ctx-2");
  });

  // ── 9) message-part-multimodal ────────────────────────────
  it("message-part-multimodal: Attachment ↔ Part 双向映射", () => {
    // base64 attachment → RawPart
    const rawPart = mapAttachmentToA2APart({
      base64: "aGVsbG8=",
      mimeType: "image/png",
      filename: "test.png",
    });
    expect(rawPart.kind).toBe("raw");
    expect((rawPart as any).raw).toBe("aGVsbG8=");

    // URL attachment → UrlPart
    const urlPart = mapAttachmentToA2APart({
      url: "https://example.com/file.pdf",
      mimeType: "application/pdf",
    });
    expect(urlPart.kind).toBe("url");

    // 无 base64/url → TextPart（降级）
    const textPart = mapAttachmentToA2APart({
      caption: "一张图片",
      mimeType: "image/png",
    });
    expect(textPart.kind).toBe("text");

    // 反向映射
    const att1 = mapA2APartToAttachment({ kind: "raw", raw: "abc", mediaType: "image/png" });
    expect(att1.base64).toBe("abc");

    const att2 = mapA2APartToAttachment({ kind: "url", url: "https://x.com/f.txt" });
    expect(att2.url).toBe("https://x.com/f.txt");

    const att3 = mapA2APartToAttachment({ kind: "text", text: "hi" });
    expect(att3.caption).toBe("hi");

    const att4 = mapA2APartToAttachment({ kind: "data", data: { key: "val" } });
    expect(att4.base64).toBeTruthy();

    // 批量转换
    const parts = attachmentsToParts([
      { base64: "x", mimeType: "text/plain" },
      { url: "https://a.com" },
    ]);
    expect(parts).toHaveLength(2);

    const atts = partsToAttachments(parts);
    expect(atts).toHaveLength(2);
  });
});

// ═══════════════════════════════════════════════════════════════
// 4. A2AClient（5 用例）
// ═══════════════════════════════════════════════════════════════

describe("A2AClient", () => {
  let client: A2AClient;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    client = new A2AClient("https://remote.example.com", undefined, {
      maxAttempts: 2,
      initialDelayMs: 10,
      maxDelayMs: 50,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 构建成功的 JSON-RPC 响应 */
  function rpcOk(result: unknown): Response {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: "1", result }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** 构建 JSON-RPC 错误响应 */
  function rpcErr(code: number, message: string): Response {
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", id: "1", error: { code, message } }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  // ── 10) call-success ───────────────────────────────────────
  it("call-success: sendMessage 正常返回 Task", async () => {
    const fakeTask = { id: "t1", contextId: "c1", status: { state: "working" } };
    mockFetch.mockResolvedValueOnce(rpcOk({ type: "task", task: fakeTask }));

    const result = await client.sendMessage({
      message: { messageId: "m1", role: "user", parts: [{ kind: "text", text: "hi" }] },
    });
    expect(result).toEqual({ type: "task", task: fakeTask });

    // 验证 fetch 请求参数
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://remote.example.com/a2a");
    expect(opts.method).toBe("POST");

    // 验证 trace header 注入
    const headers = opts.headers as Record<string, string>;
    expect(headers["x-a2a-trace-id"]).toBe("test-trace-id-1234");
  });

  // ── 11) call-timeout / retry ───────────────────────────────
  it("call-timeout: transient 错误触发重试", async () => {
    // 第 1 次 500，第 2 次成功
    mockFetch
      .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }))
      .mockResolvedValueOnce(rpcOk({ id: "t1", status: { state: "completed" } }));

    const result = await client.getTask("t1");
    expect(result).toEqual({ id: "t1", status: { state: "completed" } });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // ── 12) auth-fail ──────────────────────────────────────────
  it("auth-fail: 401 非 transient 不重试直接抛出", async () => {
    mockFetch.mockResolvedValueOnce(
      rpcErr(-32001, "Unauthorized"),
    );

    await expect(client.getTask("t1")).rejects.toThrow(A2AClientError);
    // -32001 不是 transient，应只调用一次
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  // ── 13) well-known-card-fetch ──────────────────────────────
  it("well-known-card-fetch: 正常获取 AgentCard", async () => {
    const card = makeCard("remote-agent", "https://remote.example.com");
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(card), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"v1"' },
      }),
    );

    const result = await client.fetchAgentCard();
    expect(result.name).toBe("remote-agent");
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // 验证请求 URL
    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe("https://remote.example.com/.well-known/agent-card.json");
  });

  // ── 14) well-known-cache-304 ──────────────────────────────
  it("well-known-cache-304: ETag 命中时返回缓存", async () => {
    const card = makeCard("cached-agent");

    // 第 1 次获取：返回 card + ETag
    mockFetch.mockResolvedValueOnce(
      new Response(JSON.stringify(card), {
        status: 200,
        headers: { "Content-Type": "application/json", ETag: '"etag-1"' },
      }),
    );
    await client.fetchAgentCard();

    // 第 2 次获取：返回 304
    mockFetch.mockResolvedValueOnce(new Response(null, { status: 304 }));
    const cachedResult = await client.fetchAgentCard();
    expect(cachedResult.name).toBe("cached-agent");
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // 验证第二次请求包含 If-None-Match
    const [, opts] = mockFetch.mock.calls[1] as [string, RequestInit];
    const headers = opts.headers as Record<string, string>;
    expect(headers["If-None-Match"]).toBe('"etag-1"');
  });

  // ── 15) protocol-version-negotiation ──────────────────────
  it("protocol-version: 服务端返回版本不匹配错误", async () => {
    mockFetch.mockResolvedValueOnce(
      rpcErr(-32003, "Unsupported: 0.1.0"),
    );

    await expect(
      client.sendMessage({
        message: { messageId: "m1", role: "user", parts: [] },
        protocolVersion: "0.1.0",
      }),
    ).rejects.toThrow("Unsupported: 0.1.0");
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. PushNotificationDispatcher（2 用例）
// ═══════════════════════════════════════════════════════════════

describe("PushNotificationDispatcher", () => {
  let dispatcher: PushNotificationDispatcher;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    dispatcher = new PushNotificationDispatcher({
      maxAttempts: 2,
      initialDelayMs: 5,
      maxDelayMs: 20,
      allowInsecure: false,
      domainWhitelist: [],
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 16) push-notification-retry ───────────────────────────
  it("push-notification-retry: 失败后重试 + dead-letter", async () => {
    dispatcher.register({
      id: "cfg-1",
      taskId: "t1",
      webhookUrl: "https://hook.example.com/callback",
    });

    // 两次都失败 → dead-letter
    mockFetch
      .mockRejectedValueOnce(new Error("Connection refused"))
      .mockRejectedValueOnce(new Error("Connection refused"));

    await dispatcher.dispatch("t1", {
      taskId: "t1",
      eventType: "status_update",
      timestamp: new Date().toISOString(),
    });

    // 验证重试了 2 次
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // 验证 dead-letter
    const deadLetters = dispatcher.getDeadLetters();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].config.id).toBe("cfg-1");
    expect(deadLetters[0].failCount).toBe(2);
  });

  // ── 17) push-url-validation ───────────────────────────────
  it("push-url-validation: SSRF 防护 + HTTPS 强制", () => {
    // HTTP 被拒
    expect(() =>
      dispatcher.register({
        id: "bad-1",
        taskId: "t2",
        webhookUrl: "http://hook.example.com/cb",
      }),
    ).toThrow("HTTPS");

    // localhost 被拒
    expect(() =>
      dispatcher.register({
        id: "bad-2",
        taskId: "t2",
        webhookUrl: "https://localhost/cb",
      }),
    ).toThrow("私网/保留地址");

    // 127.0.0.1 被拒
    expect(() =>
      dispatcher.register({
        id: "bad-3",
        taskId: "t2",
        webhookUrl: "https://127.0.0.1/cb",
      }),
    ).toThrow("私网/保留地址");

    // 合法 HTTPS 通过
    expect(() =>
      dispatcher.register({
        id: "ok",
        taskId: "t2",
        webhookUrl: "https://valid.example.com/cb",
      }),
    ).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. 辅助函数（1 用例）
// ═══════════════════════════════════════════════════════════════

describe("A2A Type Helpers", () => {
  // ── 18) state-helper-functions ────────────────────────────
  it("isTerminalState / isInterruptedState 正确分类", () => {
    // 终止态
    expect(isTerminalState(TaskState.COMPLETED)).toBe(true);
    expect(isTerminalState(TaskState.FAILED)).toBe(true);
    expect(isTerminalState(TaskState.CANCELED)).toBe(true);
    expect(isTerminalState(TaskState.REJECTED)).toBe(true);

    // 非终止态
    expect(isTerminalState(TaskState.SUBMITTED)).toBe(false);
    expect(isTerminalState(TaskState.WORKING)).toBe(false);
    expect(isTerminalState(TaskState.INPUT_REQUIRED)).toBe(false);

    // 中断态
    expect(isInterruptedState(TaskState.INPUT_REQUIRED)).toBe(true);
    expect(isInterruptedState(TaskState.AUTH_REQUIRED)).toBe(true);

    // 非中断态
    expect(isInterruptedState(TaskState.WORKING)).toBe(false);
    expect(isInterruptedState(TaskState.COMPLETED)).toBe(false);
  });
});
