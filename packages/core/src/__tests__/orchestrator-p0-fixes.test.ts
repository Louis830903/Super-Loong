/**
 * T2.0 — orchestrator 双项改造 P0 修复测试
 *
 * 用例 1：验证 async + 有已解析 context 的任务可被分为并行组
 * 用例 2：验证 guardrail 失败后 prompt 包含 feedback 字符串
 */
import { describe, it, expect, vi } from "vitest";
import {
  CrewExecutor,
  type CrewConfig,
  type CrewTask,
} from "../collaboration/orchestrator.js";

// ─── Mock 工具 ──────────────────────────────────────────────

/** 创建模拟 AgentRuntime，chat 方法可自定义延迟和响应 */
function createMockAgent(
  id: string,
  name: string,
  opts?: { delay?: number; response?: string | (() => string); chatFn?: (prompt: string) => Promise<{ sessionId: string; response: string; toolCalls: never[]; attachments: never[] }> },
) {
  const delay = opts?.delay ?? 0;
  return {
    id,
    state: {
      config: {
        name,
        description: `Mock agent ${name}`,
        role: "assistant",
      },
    },
    chat: opts?.chatFn ?? vi.fn(async (_prompt: string, _sessionId?: string) => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      const resp = typeof opts?.response === "function" ? opts.response() : (opts?.response ?? `Response from ${name}`);
      return { sessionId: "mock-session", response: resp, toolCalls: [], attachments: [] };
    }),
  };
}

/** 创建模拟 AgentManager */
function createMockAgentManager(agents: ReturnType<typeof createMockAgent>[]) {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  return {
    getAgent: vi.fn((id: string) => agentMap.get(id)),
  } as any;
}

// ─── 用例 1：async + 有已解析 context 的任务可并行 ──────────

describe("T2.0 改造 1：async 任务有已解析 context 时可并行", () => {
  it("T4(deps=[T1]) 和 T5(deps=[T3]) 应在 T1/T3 完成后并行执行", async () => {
    const PARALLEL_DELAY = 200;
    const agents = [
      createMockAgent("writer", "Writer", { response: "script output" }),
      createMockAgent("designer", "Designer", { response: "image prompts" }),
      createMockAgent("storyboard", "Storyboard", { response: "storyboard" }),
      createMockAgent("voice", "Voice", { delay: PARALLEL_DELAY, response: "audio done" }),
      createMockAgent("video", "Video", { delay: PARALLEL_DELAY, response: "video done" }),
      createMockAgent("editor", "Editor", { response: "final output" }),
    ];
    const manager = createMockAgentManager(agents);
    const executor = new CrewExecutor(manager);

    // 模拟 ShortVideoCrew 的 7 个 Task 依赖图
    const tasks: CrewTask[] = [
      { id: "t1", description: "script", expectedOutput: "json", agentId: "writer" },
      { id: "t2", description: "image prompts", expectedOutput: "json", agentId: "designer", context: ["t1"] },
      { id: "t3", description: "storyboard", expectedOutput: "json", agentId: "storyboard", context: ["t1", "t2"] },
      // T4 和 T5 标记 async=true，有 context 依赖但在执行到它们时依赖已完成
      { id: "t4", description: "audio", expectedOutput: "path", agentId: "voice", context: ["t1"], async: true },
      { id: "t5", description: "video", expectedOutput: "path", agentId: "video", context: ["t3"], async: true },
      { id: "t6", description: "compose", expectedOutput: "path", agentId: "editor", context: ["t4", "t5"] },
      { id: "t7", description: "merge", expectedOutput: "path", agentId: "editor", context: ["t6"] },
    ];

    const config: CrewConfig = {
      name: "ShortVideo Test Crew",
      process: "sequential",
      tasks,
      taskTimeoutMs: 10_000,
    };

    const start = Date.now();
    const result = await executor.run(config);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(7);

    // 关键断言：T4/T5 应并行执行（总耗时应约 PARALLEL_DELAY 而非 2*PARALLEL_DELAY）
    // 留 100ms 冗余给串行 task 的非零延迟
    expect(elapsed).toBeLessThan(PARALLEL_DELAY * 2 - 50);
  });

  it("async=true 但 context 未解析时仍为串行屏障", async () => {
    const agents = [
      createMockAgent("a1", "Agent1", { response: "R1" }),
      createMockAgent("a2", "Agent2", { response: "R2" }),
    ];
    const manager = createMockAgentManager(agents);
    const executor = new CrewExecutor(manager);

    // T2 依赖 T1，T1 不在前面（故意乱序测试），context 未解析
    // 但因为按 tasks 数组顺序执行，T1 会先跑
    const tasks: CrewTask[] = [
      { id: "t1", description: "First", expectedOutput: "out", agentId: "a1" },
      // 只有一个 async 任务，不形成并行组，会作为同步屏障
      { id: "t2", description: "Second", expectedOutput: "out", agentId: "a2", context: ["t1"], async: true },
    ];

    const config: CrewConfig = {
      name: "Single Async Crew",
      process: "sequential",
      tasks,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(2);
    // T2 能获取 T1 的输出作为上下文
    const t2Agent = agents[1];
    const callArgs = (t2Agent.chat as any).mock.calls[0][0] as string;
    expect(callArgs).toContain("R1"); // context 注入成功
  });
});

// ─── 用例 2：guardrail 失败后 feedback 注入 prompt ──────────

describe("T2.0 改造 2：guardrail feedback 注入重试 prompt", () => {
  it("guardrail 失败时 feedback 应出现在下一次 prompt 中", async () => {
    let callCount = 0;
    const receivedPrompts: string[] = [];

    const mockAgent = createMockAgent("a1", "Writer", {
      chatFn: vi.fn(async (prompt: string) => {
        receivedPrompts.push(prompt);
        callCount++;
        // 第一次返回不合规 JSON，第二次返回合规 JSON
        const response = callCount === 1
          ? '{"bad": "data"}'
          : '{"title": "test", "narration_full": "good content here for testing"}';
        return { sessionId: "s", response, toolCalls: [] as never[], attachments: [] as never[] };
      }),
    });

    const manager = createMockAgentManager([mockAgent]);
    const executor = new CrewExecutor(manager);

    // 模拟 guardrail：第一次返回失败，第二次返回成功
    let guardrailCallCount = 0;
    const mockGuardrail = (output: string): { valid: boolean; feedback?: string } => {
      guardrailCallCount++;
      if (guardrailCallCount === 1) {
        return { valid: false, feedback: "缺少 title 字段；scenes 数组长度应为 6" };
      }
      return { valid: true };
    };

    const tasks: CrewTask[] = [
      {
        id: "t1",
        description: "Generate script",
        expectedOutput: "JSON script",
        agentId: "a1",
        guardrail: mockGuardrail,
      },
    ];

    const config: CrewConfig = {
      name: "Guardrail Test Crew",
      process: "sequential",
      tasks,
      maxRetries: 2,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");

    // 关键断言：agent.chat 被调用 2 次
    expect(callCount).toBe(2);

    // 关键断言：第二次 prompt 包含 GUARDRAIL FEEDBACK
    expect(receivedPrompts[1]).toContain("[GUARDRAIL FEEDBACK]");
    expect(receivedPrompts[1]).toContain("缺少 title 字段");
    expect(receivedPrompts[1]).toContain("scenes 数组长度应为 6");
  });

  it("guardrail 连续失败超过 maxRetries 时抛出错误", async () => {
    const mockAgent = createMockAgent("a1", "Bad Agent", { response: '{"invalid": true}' });
    const manager = createMockAgentManager([mockAgent]);
    const executor = new CrewExecutor(manager);

    const alwaysFail = (_output: string): { valid: boolean; feedback?: string } => {
      return { valid: false, feedback: "输出格式不正确" };
    };

    const tasks: CrewTask[] = [
      {
        id: "t1",
        description: "Bad task",
        expectedOutput: "JSON",
        agentId: "a1",
        guardrail: alwaysFail,
      },
    ];

    const config: CrewConfig = {
      name: "Guardrail Fail Crew",
      process: "sequential",
      tasks,
      maxRetries: 2,
    };

    const result = await executor.run(config);
    // maxRetries=2 意味着最多重试 2 次（共 3 次调用），然后标记失败
    expect(result.status).toBe("failed");
    expect(result.error).toContain("guardrail");
  });
});
