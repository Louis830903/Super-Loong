/**
 * KbParserSupervisor 边界测试（知识库 Spec §T7）。
 *
 * 策略：
 *   - 仅测公开方法的边界逻辑，不涉及实际子进程 spawn。
 *   - 通过 (supervisor as any) 直接操作内部状态模拟极端场景（测试允许破 encapsulation）。
 *   - Mock @super-agent/core 的 createDoclingClient / ensureKbParserDeps，避免 Python 依赖。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { KbParserSupervisor } from "../services/kb-parser-supervisor.js";

/** 用于类型断言的 mock DoclingClient */
interface MockDoclingClient {
  parse: ReturnType<typeof vi.fn>;
}

// ─── Mock @super-agent/core 的 Docling 客户端工厂 ──────────
vi.mock("@super-agent/core", () => {
  const mockClient: MockDoclingClient = {
    parse: vi.fn().mockRejectedValue(new Error("Mock — Python 子进程未运行")),
  };
  return {
    createDoclingClient: vi.fn(() => mockClient),
    ensureKbParserDeps: vi.fn().mockRejectedValue(new Error("Mock — no Python env")),
  };
});

const MAX_RESTARTS = 3; // 与源码常量对齐

// ─── 测试用例 ──────────────────────────────────────────────

describe("KbParserSupervisor 边界测试", () => {
  let supervisor: KbParserSupervisor;

  beforeEach(() => {
    supervisor = new KbParserSupervisor();
  });

  // ── 场景 1: getClient() 返回单例 ─────────────────────────

  it("getClient() 返回单例 — 两次调用获得同一引用", () => {
    const c1 = supervisor.getClient();
    const c2 = supervisor.getClient();
    expect(c1).toBe(c2);
  });

  it("getClient() 返回的 client 可调用 parse（mock 拒绝，不抛到测试外层）", async () => {
    const client = supervisor.getClient();
    // parse 被 mock 为 reject，证明 client 已构造但无子进程
    await expect((client as unknown as MockDoclingClient).parse()).rejects.toBeDefined();
  });

  // ── 场景 2: 达到最大重启次数后 isAvailable() 返回 false ──

  it("restartAttempts >= MAX_RESTARTS 后 isAvailable 返回 false", async () => {
    (supervisor as any).restartAttempts = MAX_RESTARTS; // 3
    const available = await supervisor.isAvailable();
    expect(available).toBe(false);
  });

  it("restartAttempts < MAX_RESTARTS 且从未启动 → isAvailable 返回 true（按需启动）", async () => {
    (supervisor as any).restartAttempts = 0;
    const available = await supervisor.isAvailable();
    // 未启动过，视为"可用（按需启动）"
    expect(available).toBe(true);
  });

  // ── 场景 3: stop() 幂等（从未启动时调用不抛错）───────────

  it("stop() 在从未启动时调用不抛异常", async () => {
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  it("stop() 可重复调用不抛异常", async () => {
    await supervisor.stop();
    // 第二次：internal state 已清理，process 为 null → 幂等
    await expect(supervisor.stop()).resolves.toBeUndefined();
  });

  // ── 场景 4: ensureStarted() 在不可用状态下直接返回 ────────

  it("ensureStarted() 重启次数耗尽后立即返回（不启动子进程）", async () => {
    (supervisor as any).restartAttempts = MAX_RESTARTS; // 已达上限
    await expect(supervisor.ensureStarted()).resolves.toBeUndefined();
    // 不应有子进程
    expect((supervisor as any).process).toBeNull();
    expect((supervisor as any)._ready).toBe(false);
  });

  it("ensureStarted() 在 restartAttempts 超限且 _ready=false 时直接返回", async () => {
    (supervisor as any).restartAttempts = MAX_RESTARTS + 1; // 超出上限
    (supervisor as any)._ready = false;
    await supervisor.ensureStarted();
    expect((supervisor as any).process).toBeNull();
  });

  // ── 调试属性 ─────────────────────────────────────────────

  it("currentPort 在未启动时返回 null", () => {
    expect(supervisor.currentPort).toBeNull();
  });

  it("pid 在未启动时返回 null", () => {
    expect(supervisor.pid).toBeNull();
  });
});
