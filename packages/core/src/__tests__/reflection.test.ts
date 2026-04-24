/**
 * T2.5: ReflectionEngine 单测
 *
 * 覆盖 Spec v1.3 / Sprint 2 / T2 的 6 个验收用例（§ 2.4 测试要求）：
 * 1. 工具失败 1 次 → 反思建议 retry_with_fix
 * 2. 同一工具连续失败 4 次（超 maxConsecutiveFailures=3）→ 第 4 次返回 null
 * 3. 单 turn 反思 3 次（超 maxReflectionDepth=2）→ 第 3 次返回 null
 * 4. 反思 LLM 调用超时 → 降级 null，不阻塞
 * 5. 反思 LLM 返回非 JSON → 容错降级 null
 * 6. 配置 enabled=false → 直接返回 null，无 LLM 调用
 *
 * 另追加：
 * 7. mapReflectionCategoryToFailureCategory 映射正确性
 * 8. buildReflectionPrompt 输出格式检查
 */
import { describe, it, expect, vi } from "vitest";
import { ReflectionEngine } from "../agent/reflection.js";
import type { ReflectionResult } from "../agent/reflection.js";
import { buildReflectionPrompt } from "../agent/reflection-prompts.js";
import { mapReflectionCategoryToFailureCategory } from "../evolution/engine.js";
import type { LLMProvider } from "../llm/provider.js";
import type { LLMResponse } from "../types/index.js";

// ─── Mock LLMProvider ──────────────────────────────────────

/** 构造假 LLMProvider，complete() 返回预设 JSON */
function mockLlm(
  jsonResponse: Record<string, unknown>,
  finishReason: LLMResponse["finishReason"] = "stop",
): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({
      content: JSON.stringify(jsonResponse),
      finishReason,
    }),
  } as unknown as LLMProvider;
}

/** 构造假 LLMProvider：complete() 超时 / 抛错 */
function mockLlmThrows(error: Error): LLMProvider {
  return {
    complete: vi.fn().mockRejectedValue(error),
  } as unknown as LLMProvider;
}

/** 构造假 LLMProvider：complete() 返回非 JSON 纯文本 */
function mockLlmText(text: string): LLMProvider {
  return {
    complete: vi.fn().mockResolvedValue({
      content: text,
      finishReason: "stop" as const,
    }),
  } as unknown as LLMProvider;
}

/** 标准反思 JSON 响应 */
const STANDARD_REFLECTION: Record<string, unknown> = {
  category: "param_error",
  strategy: "retry_with_fix",
  suggestion: "参数路径不存在，请检查文件是否在当前工作目录下",
  shouldRetry: true,
};

// ─── Core Tests ────────────────────────────────────────────

describe("ReflectionEngine", () => {
  const SESSION_ID = "session-test-1";

  it("1. 工具失败 1 次 → 返回有效 ReflectionResult (retry_with_fix)", async () => {
    const engine = new ReflectionEngine({ maxReflectionDepth: 2, maxConsecutiveFailures: 3, enabled: true, triggerOn: "failure_only" });
    const llm = mockLlm(STANDARD_REFLECTION);

    const result = await engine.reflect(SESSION_ID, "read_file", { path: "/foo" }, "ENOENT", llm);

    expect(result).not.toBeNull();
    expect(result!.category).toBe("param_error");
    expect(result!.strategy).toBe("retry_with_fix");
    expect(result!.suggestion).toContain("参数路径");
    expect(result!.shouldRetry).toBe(true);

    // 确认调用了 LLM
    expect((llm.complete as ReturnType<typeof vi.fn>)).toHaveBeenCalledOnce();
  });

  it("2. 同一工具连续失败 4 次 → 第 4 次返回 null（超 maxConsecutiveFailures=3）", async () => {
    const engine = new ReflectionEngine({ maxConsecutiveFailures: 3, maxReflectionDepth: 10, enabled: true, triggerOn: "failure_only" });
    const llm = mockLlm(STANDARD_REFLECTION);

    // 前 3 次正常反思
    const r1 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    const r2 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    const r3 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r3).not.toBeNull();

    // 第 4 次超限：返回 null，不调 LLM
    const callsBefore = (llm.complete as ReturnType<typeof vi.fn>).mock.calls.length;
    const r4 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    expect(r4).toBeNull();
    // LLM 调用次数不增（第 4 次被跳过）
    expect((llm.complete as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
  });

  it("3. 单 turn 反思 3 次 → 第 3 次返回 null（超 maxReflectionDepth=2）", async () => {
    const engine = new ReflectionEngine({ maxReflectionDepth: 2, maxConsecutiveFailures: 10, enabled: true, triggerOn: "failure_only" });
    const llm = mockLlm(STANDARD_REFLECTION);

    // 不同工具（避免触发 consecutiveFailures 限制）
    const r1 = await engine.reflect(SESSION_ID, "tool_a", {}, "err", llm);
    const r2 = await engine.reflect(SESSION_ID, "tool_b", {}, "err", llm);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();

    // 第 3 次：超过 depth=2
    const r3 = await engine.reflect(SESSION_ID, "tool_c", {}, "err", llm);
    expect(r3).toBeNull();

    // reset 后可以再次反思
    engine.resetTurnCounters(SESSION_ID);
    const r4 = await engine.reflect(SESSION_ID, "tool_d", {}, "err", llm);
    expect(r4).not.toBeNull();
  });

  it("4. 反思 LLM 调用抛错 → 降级返回 null，不阻塞主流程", async () => {
    const engine = new ReflectionEngine({ enabled: true, maxReflectionDepth: 2, maxConsecutiveFailures: 3, triggerOn: "failure_only" });
    const llm = mockLlmThrows(new Error("network timeout"));

    const result = await engine.reflect(SESSION_ID, "read_file", {}, "timeout", llm);
    expect(result).toBeNull();
  });

  it("5. 反思 LLM 返回非 JSON → 容错降级为 null", async () => {
    const engine = new ReflectionEngine({ enabled: true, maxReflectionDepth: 2, maxConsecutiveFailures: 3, triggerOn: "failure_only" });
    const llm = mockLlmText("这不是一个 JSON 响应，只是普通文字。");

    const result = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    expect(result).toBeNull();
  });

  it("6. 配置 enabled=false → 直接返回 null，无任何 LLM 调用", async () => {
    const engine = new ReflectionEngine({ enabled: false, maxReflectionDepth: 2, maxConsecutiveFailures: 3, triggerOn: "failure_only" });
    const llm = mockLlm(STANDARD_REFLECTION);

    const result = await engine.reflect(SESSION_ID, "read_file", {}, "err", llm);
    expect(result).toBeNull();
    expect((llm.complete as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("noteToolSuccess 清零连续失败计数后可重新反思", async () => {
    const engine = new ReflectionEngine({ maxConsecutiveFailures: 2, maxReflectionDepth: 10, enabled: true, triggerOn: "failure_only" });
    const llm = mockLlm(STANDARD_REFLECTION);

    // 连续失败 2 次
    await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);

    // 第 3 次：超限
    const r3 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    expect(r3).toBeNull();

    // noteToolSuccess 后重置
    engine.noteToolSuccess(SESSION_ID, "run_shell");
    engine.resetTurnCounters(SESSION_ID); // 同时 reset depth

    const r4 = await engine.reflect(SESSION_ID, "run_shell", {}, "err", llm);
    expect(r4).not.toBeNull();
  });

  it("LLM 返回 ```json ... ``` 包裹的 JSON 也能正确解析", async () => {
    const engine = new ReflectionEngine({ enabled: true, maxReflectionDepth: 2, maxConsecutiveFailures: 3, triggerOn: "failure_only" });
    const wrappedJson = "```json\n" + JSON.stringify(STANDARD_REFLECTION) + "\n```";
    const llm = mockLlmText(wrappedJson);

    const result = await engine.reflect(SESSION_ID, "read_file", {}, "err", llm);
    expect(result).not.toBeNull();
    expect(result!.strategy).toBe("retry_with_fix");
  });
});

// ─── mapReflectionCategoryToFailureCategory ────────────────

describe("mapReflectionCategoryToFailureCategory", () => {
  it("按 Spec 映射规则转换所有 5 种类别", () => {
    expect(mapReflectionCategoryToFailureCategory("param_error")).toBe("wrong_tool");
    expect(mapReflectionCategoryToFailureCategory("wrong_tool")).toBe("wrong_tool");
    expect(mapReflectionCategoryToFailureCategory("external_error")).toBe("timeout");
    expect(mapReflectionCategoryToFailureCategory("logic_error")).toBe("skill_gap");
    expect(mapReflectionCategoryToFailureCategory("ambiguous")).toBe("bad_response");
  });
});

// ─── buildReflectionPrompt ─────────────────────────────────

describe("buildReflectionPrompt", () => {
  it("正确拼接工具名/参数/错误/步骤", () => {
    const prompt = buildReflectionPrompt("read_file", { path: "/foo" }, "ENOENT: no such file", "step1 → step2");
    expect(prompt).toContain("工具：read_file");
    expect(prompt).toContain("参数：");
    expect(prompt).toContain("/foo");
    expect(prompt).toContain("失败信息：ENOENT");
    expect(prompt).toContain("近 3 步动作：step1 → step2");
  });

  it("参数/错误超长时被截断至 500 字符", () => {
    const longStr = "x".repeat(1000);
    const prompt = buildReflectionPrompt("run_shell", { cmd: longStr }, longStr, "");
    // 参数行和错误行各最多 500 字符（不含前缀）
    const argsLine = prompt.split("\n").find((l) => l.startsWith("参数："));
    const errorLine = prompt.split("\n").find((l) => l.startsWith("失败信息："));
    // 参数 JSON 序列化后会被 slice(0,500)，所以远小于 1000
    expect(argsLine!.length).toBeLessThan(520);
    expect(errorLine!.length).toBeLessThan(520);
  });
});
