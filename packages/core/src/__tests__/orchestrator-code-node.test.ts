/**
 * P0-D — Code Node 执行分支测试
 *
 * 验证 task.executor === "code" 时：
 *  1. codeHandler 被正确调用，输出通过 outputMap 传递给下游 task
 *  2. guardrail 对 code 输出生效（失败时触发重试）
 *  3. handler 抛错走重试，超出 maxRetries 后整个 crew 失败
 *  4. 不提供 agentId 也能跑（Code Node 不需要 Agent）
 */
import { describe, it, expect, vi } from "vitest";
import {
  CrewExecutor,
  type CrewConfig,
  type CrewTask,
  type CodeTaskContext,
  type CodeTaskResult,
} from "../collaboration/orchestrator.js";

// 最小 AgentManager Mock（Code Node 不需要 Agent，但 LLM Task 仍要取 Agent）
function createMockAgentManager(agents: Array<{ id: string }> = []) {
  const map = new Map(agents.map((a) => [a.id, a as any]));
  return { getAgent: vi.fn((id: string) => map.get(id)) } as any;
}

describe("P0-D Code Node 执行分支", () => {
  it("用例 1：codeHandler 被调用且输出传递给下游 task", async () => {
    const manager = createMockAgentManager();
    const executor = new CrewExecutor(manager);

    const handlerSpy = vi.fn(async (ctx: CodeTaskContext): Promise<CodeTaskResult> => {
      return { output: `code-result-for-${ctx.taskId}` };
    });

    const downstreamSeen: string[] = [];
    const downstreamHandler = vi.fn(async (ctx: CodeTaskContext): Promise<CodeTaskResult> => {
      // 上游输出应当通过 outputMap 可见
      const upstream = ctx.outputMap.get("t-code");
      downstreamSeen.push(upstream ?? "<missing>");
      return { output: "downstream-done" };
    });

    const tasks: CrewTask[] = [
      {
        id: "t-code",
        description: "code task",
        expectedOutput: "any",
        executor: "code",
        codeHandler: handlerSpy,
      },
      {
        id: "t-down",
        description: "downstream",
        expectedOutput: "any",
        executor: "code",
        codeHandler: downstreamHandler,
        context: ["t-code"],
      },
    ];

    const config: CrewConfig = {
      name: "code-node-crew",
      process: "sequential",
      tasks,
      taskTimeoutMs: 5_000,
    };

    const result = await executor.run(config);

    expect(result.status).toBe("completed");
    expect(handlerSpy).toHaveBeenCalledTimes(1);
    expect(downstreamHandler).toHaveBeenCalledTimes(1);
    expect(downstreamSeen).toEqual(["code-result-for-t-code"]);
    // Code Node 在未指定 agentId 时落占位 ID
    expect(result.taskOutputs[0].agentId).toBe("code-node:t-code");
  });

  it("用例 2：guardrail 失败触发重试，重试后通过则 crew 完成", async () => {
    const manager = createMockAgentManager();
    const executor = new CrewExecutor(manager);

    let call = 0;
    const handler = vi.fn(async (): Promise<CodeTaskResult> => {
      call++;
      return { output: call < 2 ? "bad" : "good" };
    });

    const tasks: CrewTask[] = [
      {
        id: "t1",
        description: "code",
        expectedOutput: "any",
        executor: "code",
        codeHandler: handler,
        guardrail: (output) => ({
          valid: output === "good",
          feedback: output === "good" ? undefined : "expected good",
        }),
      },
    ];

    const config: CrewConfig = {
      name: "code-guardrail-crew",
      process: "sequential",
      tasks,
      maxRetries: 3,
      taskTimeoutMs: 5_000,
    };

    const result = await executor.run(config);
    expect(result.status).toBe("completed");
    expect(handler).toHaveBeenCalledTimes(2);
    expect(result.taskOutputs[0].output).toBe("good");
    expect(result.taskOutputs[0].retries).toBe(1);
  });

  it("用例 3：handler 抛错重试超上限后 crew 失败", async () => {
    const manager = createMockAgentManager();
    const executor = new CrewExecutor(manager);

    const handler = vi.fn(async () => {
      throw new Error("boom");
    });

    const tasks: CrewTask[] = [
      {
        id: "t1",
        description: "code",
        expectedOutput: "any",
        executor: "code",
        codeHandler: handler,
      },
    ];

    const config: CrewConfig = {
      name: "code-fail-crew",
      process: "sequential",
      tasks,
      maxRetries: 1,
      taskTimeoutMs: 5_000,
    };

    const result = await executor.run(config);
    // run() 内部捕获异常后把 crew 标记为 failed 而非抛出
    expect(result.status).toBe("failed");
    expect(handler).toHaveBeenCalledTimes(2); // 初次 + 1 次重试
    expect(result.error).toContain("boom");
  });

  it("用例 4：声明 executor=code 却无 codeHandler → fail", async () => {
    const manager = createMockAgentManager();
    const executor = new CrewExecutor(manager);

    const tasks: CrewTask[] = [
      {
        id: "t1",
        description: "broken",
        expectedOutput: "any",
        executor: "code",
        // 故意不传 codeHandler
      },
    ];

    const config: CrewConfig = {
      name: "code-broken-crew",
      process: "sequential",
      tasks,
      taskTimeoutMs: 5_000,
    };

    const result = await executor.run(config);
    // 没有 codeHandler 时应该走默认分支（executor=code 但 codeHandler 缺失），
    // 进入 LLM 分支后因 agentId 缺失也会失败
    expect(result.status).toBe("failed");
  });
});
