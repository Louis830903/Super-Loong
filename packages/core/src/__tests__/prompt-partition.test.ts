/**
 * T3: 上下文分区骨架对齐 单测
 *
 * 覆盖 Spec v1.3 / Sprint 1 / T3 的所有验收点（§ 3.4 测试要求）：
 * 1. session.metadata.currentTask 为空 → 不注入 Task 块
 * 2. session.metadata.currentTask 设置 → Task 块出现在 Memory 之前
 * 3. cfg.memoryEnabled = false → 无 Evidence 块，Task/State/Context 仍存在
 * 4. 现有 prompt-engine 相关测试无回归（基本 build 流程成功）
 *
 * 另补充 T3.4 + T3.5 的结构性检查：
 * 5. 6 大分区 H2 标题能 grep 到（Policies / Task / Evidence / Context / State / Output Format）
 * 6. 动态分区 XML 标签（<task> <evidence> <context> <state>）正确闭合
 * 7. stable prefix 缓存正确（两次 build 同一 session 不重建 Identity+Policies）
 */
import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { PromptEngine } from "../prompt/engine.js";
import { InMemoryBackend, MemoryManager } from "../memory/manager.js";
import type { AgentConfig, Session, ToolDefinition } from "../types/index.js";
import type { CoreMemoryBlock } from "../memory/manager.js";

// ─── Helpers ─────────────────────────────────────────────────

function buildAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "agent-T3",
    name: "T3-Tester",
    role: "分区测试代理",
    goal: "验证 6 大分区骨架",
    backstory: "T3 单测专用",
    systemPrompt: "You are a test agent for partition layout.",
    llmProvider: { type: "openai", model: "gpt-4o-mini" },
    tools: [],
    skills: [],
    channels: [],
    memoryEnabled: true,
    maxToolIterations: 5,
    metadata: {},
    ...overrides,
  };
}

function buildSession(overrides: Partial<Session> = {}): Session {
  const now = new Date();
  return {
    id: "session-T3",
    agentId: "agent-T3",
    messages: [],
    createdAt: now,
    updatedAt: now,
    metadata: {},
    ...overrides,
  };
}

function buildTools(names: string[] = ["read_file", "run_shell"]): Map<string, ToolDefinition> {
  const m = new Map<string, ToolDefinition>();
  for (const n of names) {
    m.set(n, {
      name: n,
      description: `tool ${n}`,
      parameters: z.object({}),
      execute: async () => ({ success: true, output: "ok" }),
    });
  }
  return m;
}

function buildCoreBlock(label: string, value: string): CoreMemoryBlock {
  return { label, description: `${label} block`, value, limit: 1000, readOnly: false };
}

// ─── 1. currentTask 为空 → 不注入 Task ─────────────────
describe("T3 Task partition: conditional injection", () => {
  it("should NOT inject <task> block when session.metadata.currentTask is absent", () => {
    const engine = new PromptEngine({ agentConfig: buildAgentConfig() });
    const session = buildSession();
    const prompt = engine.build(session, buildTools());

    expect(prompt).not.toContain("<task>");
    expect(prompt).not.toContain("## Task\n**Goal**");
  });

  it("should inject <task> block BEFORE Evidence when currentTask is set", () => {
    const backend = new InMemoryBackend();
    // 通过 coreBlocks 直接给 agent 初始化 Core Memory，确保 Evidence 块会出现
    const mgr = new MemoryManager({
      backend,
      agentId: "agent-T3",
      coreBlocks: [buildCoreBlock("user", "用户偏好中文")],
    });

    const engine = new PromptEngine({
      agentConfig: buildAgentConfig(),
      memoryManager: mgr,
    });
    const session = buildSession({
      metadata: {
        currentTask: { goal: "完成 T3 改造", subtasks: ["拆分 State", "加 XML 标签"] },
      },
    });
    const prompt = engine.build(session, buildTools());

    expect(prompt).toContain("<task>");
    expect(prompt).toContain("</task>");
    expect(prompt).toContain("**Goal**: 完成 T3 改造");
    expect(prompt).toContain("- 拆分 State");
    expect(prompt).toContain("- 加 XML 标签");

    // 顺序断言：<task> 必须出现在 <evidence> 之前
    const taskIdx = prompt.indexOf("<task>");
    const evidenceIdx = prompt.indexOf("<evidence>");
    expect(taskIdx).toBeGreaterThan(-1);
    expect(evidenceIdx).toBeGreaterThan(-1);
    expect(taskIdx).toBeLessThan(evidenceIdx);
  });

  it("should skip Task block when currentTask.goal is empty string", () => {
    const engine = new PromptEngine({ agentConfig: buildAgentConfig() });
    const session = buildSession({ metadata: { currentTask: { goal: "   " } } });
    const prompt = engine.build(session, buildTools());
    expect(prompt).not.toContain("<task>");
  });

  it("should tolerate currentTask without subtasks array", () => {
    const engine = new PromptEngine({ agentConfig: buildAgentConfig() });
    const session = buildSession({
      metadata: { currentTask: { goal: "仅目标，无子任务" } },
    });
    const prompt = engine.build(session, buildTools());
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("**Goal**: 仅目标，无子任务");
    expect(prompt).not.toContain("**Subtasks**:");
  });
});

// ─── 2. memoryEnabled=false → 无 Evidence，但保留其他分区 ───
describe("T3 Evidence partition: respects memoryEnabled flag", () => {
  it("should produce NO <evidence> block when memoryManager is not provided", () => {
    const engine = new PromptEngine({
      agentConfig: buildAgentConfig({ memoryEnabled: false }),
    });
    const session = buildSession({
      metadata: { currentTask: { goal: "只测非记忆路径" } },
    });
    const prompt = engine.build(session, buildTools());

    // 没有 memory，也没有 markdownMemory → 不应有 Evidence 块
    expect(prompt).not.toContain("<evidence>");
    expect(prompt).not.toContain("## Evidence");

    // Task / State / Tools 分区仍在
    expect(prompt).toContain("<task>");
    expect(prompt).toContain("<state>");
    expect(prompt).toContain("## State");
    expect(prompt).toContain("## Tools (2)");
  });
});

// ─── 3. 6 大分区 H2 标题可 grep + XML 正确闭合 ─────────
describe("T3 partition structure: 6 sections + XML wrappers", () => {
  let engine: PromptEngine;
  let session: Session;

  beforeEach(() => {
    const backend = new InMemoryBackend();
    const mgr = new MemoryManager({
      backend,
      agentId: "agent-T3",
      coreBlocks: [buildCoreBlock("user", "用户姓张")],
    });

    engine = new PromptEngine({
      agentConfig: buildAgentConfig(),
      memoryManager: mgr,
    });
    session = buildSession({
      metadata: {
        currentTask: { goal: "端到端结构测试", subtasks: ["grep 所有 H2"] },
      },
    });
  });

  it("should expose all 6 partition H2 headers (Policies/Task/Evidence/Context/Tools+State/Output)", () => {
    const prompt = engine.build(session, buildTools());

    // Stable prefix 内：Policies + Output Format
    expect(prompt).toContain("## Policies");
    expect(prompt).toContain("## Output Format");

    // Dynamic suffix 内：Task + Evidence + Tools + State
    expect(prompt).toContain("## Task");
    expect(prompt).toContain("## Evidence");
    expect(prompt).toContain("## Tools");
    expect(prompt).toContain("## State");
  });

  it("should wrap dynamic partitions with matched XML tags", () => {
    const prompt = engine.build(session, buildTools());

    // 成对出现即闭合正确
    const pairs: Array<[string, string]> = [
      ["<task>", "</task>"],
      ["<evidence>", "</evidence>"],
      ["<state>", "</state>"],
    ];
    for (const [open, close] of pairs) {
      expect(prompt.indexOf(open)).toBeGreaterThanOrEqual(0);
      expect(prompt.indexOf(close)).toBeGreaterThan(prompt.indexOf(open));
    }
  });

  it("should preserve partition order: Task → Evidence → Tools → State", () => {
    const prompt = engine.build(session, buildTools());
    const idxTask = prompt.indexOf("<task>");
    const idxEvid = prompt.indexOf("<evidence>");
    // 用 "## Tools (2)" 独特串避开 stable prefix 中 TOOL_USE_ENFORCEMENT 内的 "## Tools" 误匹配
    const idxTools = prompt.indexOf("## Tools (2)");
    const idxState = prompt.indexOf("<state>");

    expect(idxTask).toBeLessThan(idxEvid);
    expect(idxEvid).toBeLessThan(idxTools);
    expect(idxTools).toBeLessThan(idxState);
  });
});

// ─── 4. Stable prefix 缓存 + 无回归 ────────────────────
describe("T3 non-regression: stable prefix cache still works", () => {
  it("should return identical stable-prefix portion on repeated build() calls", () => {
    const engine = new PromptEngine({ agentConfig: buildAgentConfig() });
    const session = buildSession();
    const tools = buildTools();

    const p1 = engine.build(session, tools);
    const p2 = engine.build(session, tools);

    // 动态部分（State 含时间戳）可能变，但 stable prefix（至 ## Output Format）应一致
    const sliceAt = (s: string) => {
      const idx = s.indexOf("## Output Format");
      // 取到 Output Format 块结束位置的近似值（保守截到该段末，下一个分区开始处）
      return idx >= 0 ? s.slice(0, idx + 100) : s;
    };
    expect(sliceAt(p1)).toBe(sliceAt(p2));
  });

  it("should build a non-empty prompt in minimal mode without throwing", () => {
    const engine = new PromptEngine({
      agentConfig: buildAgentConfig(),
      promptMode: "minimal",
    });
    const session = buildSession();
    const prompt = engine.build(session, buildTools());

    expect(prompt.length).toBeGreaterThan(0);
    // minimal 模式下 Task/Evidence/Context 都不注入（仅 L1+L2+L6 + ToolBox + State）
    expect(prompt).not.toContain("<task>");
    expect(prompt).not.toContain("<evidence>");
    // State + ToolBox 总是输出
    expect(prompt).toContain("## Tools");
    expect(prompt).toContain("<state>");
  });
});
