/**
 * Collaboration Module — Unit Tests.
 *
 * 覆盖：withTimeout 超时防护、CrewExecutor 超时/并行任务、
 *       CollaborationOrchestrator 历史容量限制、分页查询。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CrewExecutor,
  GroupChatExecutor,
  CollaborationOrchestrator,
  type CrewConfig,
  type CrewTask,
  type CrewResult,
  type GroupChatResult,
} from "../collaboration/orchestrator.js";

// ─── Mock 工具 ──────────────────────────────────────────────

/** 创建模拟 AgentRuntime，chat 方法可自定义延迟和响应 */
function createMockAgent(
  id: string,
  name: string,
  opts?: { delay?: number; response?: string },
) {
  const delay = opts?.delay ?? 0;
  const response = opts?.response ?? `Response from ${name}`;
  return {
    id,
    state: {
      config: {
        name,
        description: `Mock agent ${name}`,
        role: "assistant",
      },
    },
    chat: vi.fn(async (_prompt: string, _sessionId?: string) => {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      return { sessionId: "mock-session", response, toolCalls: [], attachments: [] };
    }),
  };
}

/** 创建模拟 AgentManager，支持预注册多个 mock agent */
function createMockAgentManager(agents: ReturnType<typeof createMockAgent>[]) {
  const agentMap = new Map(agents.map((a) => [a.id, a]));
  return {
    getAgent: vi.fn((id: string) => agentMap.get(id)),
  } as any;
}

// ─── 1. withTimeout 工具函数测试（通过间接行为验证） ───────

describe("withTimeout (via CrewExecutor)", () => {
  it("正常完成：promise 在 timeout 前 resolve", async () => {
    const agent = createMockAgent("a1", "Fast Agent", { delay: 10, response: "done" });
    const manager = createMockAgentManager([agent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Timeout Test Crew",
      process: "sequential",
      tasks: [{ id: "t1", description: "Test task", expectedOutput: "output", agentId: "a1" }],
      taskTimeoutMs: 5000,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(1);
    expect(result.taskOutputs[0].output).toBe("done");
  });

  it("超时：agent.chat 延迟超过 taskTimeoutMs → timeout error", async () => {
    const agent = createMockAgent("a1", "Slow Agent", { delay: 500 });
    const manager = createMockAgentManager([agent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Timeout Fail Crew",
      process: "sequential",
      tasks: [{ id: "t1", description: "Slow task", expectedOutput: "output", agentId: "a1" }],
      taskTimeoutMs: 100,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("Timeout");
  });

  it("withTimeout 不泄漏 timer：正常完成后 timer 被清理", async () => {
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const agent = createMockAgent("a1", "Agent", { delay: 5, response: "ok" });
    const manager = createMockAgentManager([agent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Timer Cleanup Crew",
      process: "sequential",
      tasks: [{ id: "t1", description: "Task", expectedOutput: "out", agentId: "a1" }],
      taskTimeoutMs: 5000,
    };

    await executor.run(config);
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });
});

// ─── 2. 并行任务测试（C-1） ────────────────────────────────

describe("CrewExecutor async parallel tasks", () => {
  it("3个 async=true 无依赖的任务应并行执行", async () => {
    const DELAY = 200;
    const agents = [
      createMockAgent("a1", "Agent1", { delay: DELAY, response: "R1" }),
      createMockAgent("a2", "Agent2", { delay: DELAY, response: "R2" }),
      createMockAgent("a3", "Agent3", { delay: DELAY, response: "R3" }),
    ];
    const manager = createMockAgentManager(agents);
    const executor = new CrewExecutor(manager);

    const tasks: CrewTask[] = [
      { id: "t1", description: "Task 1", expectedOutput: "out", agentId: "a1", async: true },
      { id: "t2", description: "Task 2", expectedOutput: "out", agentId: "a2", async: true },
      { id: "t3", description: "Task 3", expectedOutput: "out", agentId: "a3", async: true },
    ];

    const config: CrewConfig = {
      name: "Parallel Crew",
      process: "sequential",
      tasks,
      taskTimeoutMs: 10000,
    };

    const start = Date.now();
    const result = await executor.run(config);
    const elapsed = Date.now() - start;

    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(3);
    // 串行至少 600ms，并行应 < 500ms（留系统开销）
    expect(elapsed).toBeLessThan(DELAY * 2.5);
    // 验证结果保持正确顺序
    expect(result.taskOutputs[0].output).toBe("R1");
    expect(result.taskOutputs[1].output).toBe("R2");
    expect(result.taskOutputs[2].output).toBe("R3");
  });

  it("async task 部分失败时记录 [ERROR] 但不中断", async () => {
    const goodAgent = createMockAgent("a1", "Good", { delay: 10, response: "OK" });
    const badAgent = {
      ...createMockAgent("a2", "Bad"),
      chat: vi.fn(async () => { throw new Error("LLM crash"); }),
    };
    const manager = createMockAgentManager([goodAgent, badAgent as any]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Partial Fail Crew",
      process: "sequential",
      tasks: [
        { id: "t1", description: "Good task", expectedOutput: "out", agentId: "a1", async: true },
        { id: "t2", description: "Bad task", expectedOutput: "out", agentId: "a2", async: true },
      ],
      taskTimeoutMs: 5000,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("partial"); // 部分失败应标记为 partial
    expect(result.taskOutputs).toHaveLength(2);
    expect(result.taskOutputs[0].output).toBe("OK");
    expect(result.taskOutputs[1].output).toContain("[ERROR]");
  });

  it("有 context 依赖的任务不可并行，作为同步屏障", async () => {
    const agent = createMockAgent("a1", "Agent", { delay: 10, response: "result" });
    const manager = createMockAgentManager([agent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Context Barrier Crew",
      process: "sequential",
      tasks: [
        { id: "t1", description: "First", expectedOutput: "out", agentId: "a1", async: true },
        { id: "t2", description: "Depends on t1", expectedOutput: "out", agentId: "a1", context: ["t1"] },
        { id: "t3", description: "After barrier", expectedOutput: "out", agentId: "a1", async: true },
      ],
      taskTimeoutMs: 5000,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(3);
    expect(agent.chat).toHaveBeenCalledTimes(3);
  });
});

// ─── 3. 历史记录容量测试 ────────────────────────────────────

describe("CollaborationOrchestrator history management", () => {
  let orchestrator: CollaborationOrchestrator;

  beforeEach(() => {
    const manager = createMockAgentManager([]);
    orchestrator = new CollaborationOrchestrator(manager);
  });

  it("pruneHistory: 超过100条时裁剪到100条", async () => {
    const history = (orchestrator as any).runHistory as Array<CrewResult | GroupChatResult>;
    const pruneHistory = (orchestrator as any).pruneHistory.bind(orchestrator);

    for (let i = 0; i < 150; i++) {
      history.push({
        crewId: `crew_${i}`,
        name: `Crew ${i}`,
        process: "sequential",
        status: "completed",
        taskOutputs: [],
        finalOutput: "",
        totalDurationMs: 100,
      } as CrewResult);
    }

    expect(history.length).toBe(150);
    pruneHistory();
    expect(history.length).toBeLessThanOrEqual(100);
    expect((history[0] as CrewResult).crewId).toBe("crew_50");
    expect((history[history.length - 1] as CrewResult).crewId).toBe("crew_149");
  });

  it("getHistoryPaginated 分页 + 类型过滤", () => {
    const history = (orchestrator as any).runHistory as Array<CrewResult | GroupChatResult>;

    for (let i = 0; i < 5; i++) {
      history.push({
        crewId: `crew_${i}`,
        name: `Crew ${i}`,
        process: "sequential",
        status: "completed",
        taskOutputs: [],
        finalOutput: "",
        totalDurationMs: 100,
      } as CrewResult);
    }
    for (let i = 0; i < 3; i++) {
      history.push({
        chatId: `gchat_${i}`,
        name: `GroupChat ${i}`,
        status: "completed",
        messages: [],
        turns: 5,
        totalDurationMs: 200,
      } as GroupChatResult);
    }

    const page1 = orchestrator.getHistoryPaginated(1, 5);
    expect(page1.total).toBe(8);
    expect(page1.results).toHaveLength(5);

    const page2 = orchestrator.getHistoryPaginated(2, 5);
    expect(page2.results).toHaveLength(3);

    const crewOnly = orchestrator.getHistoryPaginated(1, 10, "crew");
    expect(crewOnly.total).toBe(5);
    expect(crewOnly.results).toHaveLength(5);

    const chatOnly = orchestrator.getHistoryPaginated(1, 10, "groupchat");
    expect(chatOnly.total).toBe(3);
    expect(chatOnly.results).toHaveLength(3);
  });

  it("getStats 统计正确", () => {
    const history = (orchestrator as any).runHistory as Array<CrewResult | GroupChatResult>;

    history.push({
      crewId: "c1", name: "C1", process: "sequential", status: "completed",
      taskOutputs: [], finalOutput: "", totalDurationMs: 100,
    } as CrewResult);
    history.push({
      chatId: "g1", name: "G1", status: "completed",
      messages: [], turns: 3, totalDurationMs: 200,
    } as GroupChatResult);

    const stats = orchestrator.getStats();
    expect(stats.totalRuns).toBe(2);
    expect(stats.crewRuns).toBe(1);
    expect(stats.chatRuns).toBe(1);
  });
});

// ─── 4. Hierarchical 模式测试 ──────────────────────────────

describe("CrewExecutor hierarchical mode", () => {
  it("无 managerAgentId 时报错", async () => {
    const agent = createMockAgent("a1", "Worker");
    const manager = createMockAgentManager([agent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "No Manager Crew",
      process: "hierarchical",
      tasks: [{ id: "t1", description: "Task", expectedOutput: "out", agentId: "a1" }],
    };

    const result = await executor.run(config);
    expect(result.status).toBe("failed");
    expect(result.error).toContain("managerAgentId");
  });

  it("manager 规划成功时按规划顺序执行", async () => {
    const worker1 = createMockAgent("w1", "Worker1", { response: "W1 done" });
    const worker2 = createMockAgent("w2", "Worker2", { response: "W2 done" });
    const managerAgent = createMockAgent("mgr", "Manager", {
      response: '["t2", "t1"]',
    });
    const manager = createMockAgentManager([worker1, worker2, managerAgent]);
    const executor = new CrewExecutor(manager);

    const config: CrewConfig = {
      name: "Hierarchical Crew",
      process: "hierarchical",
      tasks: [
        { id: "t1", description: "Task 1", expectedOutput: "out", agentId: "w1" },
        { id: "t2", description: "Task 2", expectedOutput: "out", agentId: "w2" },
      ],
      managerAgentId: "mgr",
      taskTimeoutMs: 5000,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");
    expect(result.taskOutputs).toHaveLength(2);
    expect(result.taskOutputs[0].taskId).toBe("t2");
    expect(result.taskOutputs[1].taskId).toBe("t1");
  });
});
