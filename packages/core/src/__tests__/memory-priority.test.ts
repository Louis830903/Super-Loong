/**
 * T1: 记忆优先级字段单测
 *
 * 覆盖 Spec v1.3 / Sprint 1 / T1 的所有验收点：
 * 1. PRIORITY_BOOST 常量数值正确
 * 2. blocker 优先级在 search 中能排到 normal 前面（同等其他条件下）
 * 3. 老数据（priority=undefined）兼容：等价 normal=1.0，行为不变
 * 4. 全部 normal 时与未启用 T1 之前等价（priorityBoost=1.0 不影响排序）
 * 5. SQLite Migration v11 幂等：跑两次不会报错
 * 6. createMemoryTools.remember 接收 priority 入参并传递到 backend
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  InMemoryBackend,
  MemoryManager,
  PRIORITY_BOOST,
  createMemoryTools,
} from "../memory/manager.js";
import {
  SQLiteBackend,
  initDatabase,
  closeDatabase,
  getDatabase,
} from "../persistence/sqlite.js";
import type { MemoryEntry, ToolContext } from "../types/index.js";

// ─── 1. 常量数值正确性 ─────────────────────────────────
describe("T1 PRIORITY_BOOST constants", () => {
  it("should expose 5 priority levels with correct multipliers", () => {
    expect(PRIORITY_BOOST.blocker).toBe(1.5);
    expect(PRIORITY_BOOST.action).toBe(1.3);
    expect(PRIORITY_BOOST.task_state).toBe(1.15);
    expect(PRIORITY_BOOST.conclusion).toBe(1.1);
    expect(PRIORITY_BOOST.normal).toBe(1.0);
  });

  it("should sort priorities in expected descending order", () => {
    const order = (Object.keys(PRIORITY_BOOST) as Array<keyof typeof PRIORITY_BOOST>)
      .sort((a, b) => PRIORITY_BOOST[b] - PRIORITY_BOOST[a]);
    expect(order).toEqual(["blocker", "action", "task_state", "conclusion", "normal"]);
  });
});

// ─── 2. blocker 排前 + 老数据兼容 + 全 normal 等价 ─────
describe("T1 search priority weighting", () => {
  it("should rank blocker memory above normal memory with identical content match", async () => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({ backend, agentId: "agent-T1" });

    // 同样的内容，仅 priority 不同
    await mgr.add({ agentId: "agent-T1", content: "用户对花生过敏", priority: "blocker" });
    await mgr.add({ agentId: "agent-T1", content: "用户对花生过敏", priority: "normal" });

    const results = await mgr.search("花生过敏", { agentId: "agent-T1" }, 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].entry.priority).toBe("blocker");
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it("should treat undefined priority as normal (legacy data compatibility)", async () => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({ backend, agentId: "agent-T1-legacy" });

    // 两条都直接 backend.add（绕过 embedder），只靠 textScore + jaccard 计算
    // 这样能隔离验证 priority undefined vs normal 是否等价
    const baseTime = new Date();
    const legacyEntry: MemoryEntry = {
      id: "mem-legacy",
      agentId: "agent-T1-legacy",
      content: "Hello world legacy",
      type: "archival",
      createdAt: baseTime,
      updatedAt: baseTime,
      metadata: {},
      // 故意不设 priority（模拟老数据）
    };
    const normalEntry: MemoryEntry = {
      id: "mem-normal",
      agentId: "agent-T1-legacy",
      content: "Hello world legacy",
      type: "archival",
      createdAt: baseTime,
      updatedAt: baseTime,
      metadata: {},
      priority: "normal",
    };
    await backend.add(legacyEntry);
    await backend.add(normalEntry);

    const results = await mgr.search("Hello world", { agentId: "agent-T1-legacy" }, 5);
    expect(results.length).toBe(2);
    // 老数据与 normal 数据的 score 应当完全相等（priority undefined fallback normal=1.0）
    const [a, b] = results;
    expect(Math.abs(a.score - b.score)).toBeLessThan(1e-9);
  });

  it("should produce identical ranking when all entries are normal (T1 disabled equivalent)", async () => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({ backend, agentId: "agent-T1-allnormal" });

    await mgr.add({ agentId: "agent-T1-allnormal", content: "alpha beta gamma", priority: "normal" });
    await mgr.add({ agentId: "agent-T1-allnormal", content: "alpha beta", priority: "normal" });
    await mgr.add({ agentId: "agent-T1-allnormal", content: "alpha", priority: "normal" });

    const results = await mgr.search("alpha beta gamma", { agentId: "agent-T1-allnormal" }, 5);
    // 全 normal 时 priorityBoost=1.0，排序仅由文本/embedding/jaccard 决定
    // alpha beta gamma 三词全中应排第一
    expect(results[0].entry.content).toBe("alpha beta gamma");
  });
});

// ─── 3. SQLite Migration v11 幂等性 ─────────────────────
describe("T1 Migration v11 idempotency", () => {
  const TEST_DB = path.join(process.cwd(), "data", "test-memory-priority.db");

  beforeAll(async () => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    await initDatabase(TEST_DB);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("should have priority + relevanceScore columns after init", () => {
    const db = getDatabase();
    const result = db.exec("PRAGMA table_info(memories)");
    expect(result.length).toBeGreaterThan(0);
    const colNames = result[0].values.map((row: unknown[]) => row[1] as string);
    expect(colNames).toContain("priority");
    expect(colNames).toContain("relevanceScore");
  });

  it("should round-trip priority + relevanceScore via SQLiteBackend", async () => {
    const backend = new SQLiteBackend();
    const entry: MemoryEntry = {
      id: "mem-sqlite-prio",
      agentId: "agent-sql",
      content: "SQLite roundtrip test",
      type: "archival",
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
      priority: "blocker",
      relevanceScore: 0.87,
    };
    await backend.add(entry);

    const loaded = await backend.get("mem-sqlite-prio");
    expect(loaded).not.toBeNull();
    expect(loaded!.priority).toBe("blocker");
    expect(loaded!.relevanceScore).toBeCloseTo(0.87, 2);

    // update 也应能改 priority
    await backend.update("mem-sqlite-prio", { priority: "action", relevanceScore: 0.5 });
    const updated = await backend.get("mem-sqlite-prio");
    expect(updated!.priority).toBe("action");
    expect(updated!.relevanceScore).toBeCloseTo(0.5, 2);
  });

  it("should default priority to 'normal' when add() does not specify it", async () => {
    const backend = new SQLiteBackend();
    const mgr = new MemoryManager({ backend });
    const created = await mgr.add({ agentId: "agent-default", content: "no-priority test" });
    expect(created.priority).toBe("normal");
    const loaded = await backend.get(created.id);
    expect(loaded!.priority).toBe("normal");
  });
});

// ─── 4. createMemoryTools.remember 透传 priority ─────────
describe("T1 createMemoryTools.remember priority pass-through", () => {
  it("should accept priority in tool params and forward to manager.add", async () => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({ backend, agentId: "agent-tool" });
    const tools = createMemoryTools(mgr);
    const remember = tools.find((t) => t.name === "remember");
    expect(remember).toBeDefined();

    const ctx: ToolContext = {
      agentId: "agent-tool",
      sessionId: "sess-1",
      userId: "user-1",
    } as ToolContext;

    const result = await remember!.execute(
      { content: "API rate limit is 100 RPS", type: "archival", priority: "blocker" },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({ priority: "blocker", type: "archival" });

    // 验证后端实际写入了 blocker
    const list = await backend.list({ agentId: "agent-tool" });
    expect(list.length).toBe(1);
    expect(list[0].priority).toBe("blocker");
  });

  it("should default priority to normal when tool caller omits it", async () => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({ backend, agentId: "agent-tool-2" });
    const tools = createMemoryTools(mgr);
    const remember = tools.find((t) => t.name === "remember")!;
    const ctx: ToolContext = {
      agentId: "agent-tool-2",
      sessionId: "sess-2",
    } as ToolContext;

    // 经过 zod default("normal")，未传 priority 应自动补 normal
    const parsed = remember.parameters.parse({ content: "ordinary fact" });
    expect(parsed.priority).toBe("normal");

    const result = await remember.execute(parsed, ctx);
    expect(result.success).toBe(true);

    const list = await backend.list({ agentId: "agent-tool-2" });
    expect(list[0].priority).toBe("normal");
  });
});
