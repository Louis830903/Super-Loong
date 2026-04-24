/**
 * T4.7 — 评估基准适配器单测
 *
 * 覆盖 Spec 4.4 全部要求：
 * 1. BFCL Loader 加载内嵌样本并解析
 * 2. GAIA Loader 按 difficulty 过滤
 * 3. ToolBench Loader 加载 ≥8 条样本
 * 4. ToolCallJudge exact 匹配
 * 5. ToolCallJudge subset 匹配
 * 6. ToolCallJudge contains 匹配（顺序错）
 * 7. Evaluator 集成 ToolCallJudge 后报告含 perJudge["tool_call"]
 * 8. sampleTasks 采样工具函数
 */

import { describe, it, expect } from "vitest";
import { BFCLLoader } from "../datasets/bfcl-loader.js";
import { GAIALoader } from "../datasets/gaia-loader.js";
import { ToolBenchLoader } from "../datasets/toolbench-loader.js";
import { sampleTasks } from "../datasets/loader.js";
import { ToolCallJudge } from "../judges/tool-call-judge.js";
import { Evaluator, ExactMatchJudge } from "../evaluator.js";

// ═══════════════════════════════════════════════════════════════
// 1. BFCL Loader
// ═══════════════════════════════════════════════════════════════

describe("BFCLLoader", () => {
  it("应加载 ≥10 条内嵌样本", async () => {
    const loader = new BFCLLoader();
    // 网络不可达时降级到内嵌样本，给足 30s 超时
    const dataset = await loader.load({ maxTasks: 100 });

    expect(dataset.name).toBe("bfcl");
    expect(dataset.tasks.length).toBeGreaterThanOrEqual(10);

    // 每条任务应有 id、input、expected
    for (const task of dataset.tasks) {
      expect(task.id).toBeTruthy();
      expect(task.input).toBeTruthy();
      expect(task.expected).toBeDefined();
    }
  }, 30_000);

  it("maxTasks 限制生效", async () => {
    const loader = new BFCLLoader();
    const dataset = await loader.load({ maxTasks: 3 });
    expect(dataset.tasks.length).toBeLessThanOrEqual(3);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════
// 2. GAIA Loader
// ═══════════════════════════════════════════════════════════════

describe("GAIALoader", () => {
  it("应加载 ≥10 条内嵌样本", async () => {
    const loader = new GAIALoader();
    const dataset = await loader.load({ maxTasks: 100 });

    expect(dataset.name).toBe("gaia");
    expect(dataset.tasks.length).toBeGreaterThanOrEqual(10);
  }, 30_000);

  it("按 difficulty 过滤仅返回指定等级", async () => {
    const loader = new GAIALoader();

    // 加载 Level 1
    const d1 = await loader.load({ difficulty: 1, maxTasks: 100 });
    for (const task of d1.tasks) {
      expect(task.difficulty).toBe(1);
    }
    expect(d1.tasks.length).toBeGreaterThan(0);

    // 加载 Level 3
    const d3 = await loader.load({ difficulty: 3, maxTasks: 100 });
    for (const task of d3.tasks) {
      expect(task.difficulty).toBe(3);
    }
  }, 30_000);

  it("countByDifficulty 统计正确", async () => {
    const loader = new GAIALoader();
    const dataset = await loader.load({ maxTasks: 100 });
    // countByDifficulty 存储在 dataset.metadata 中，类型为 Record<number, number>
    const counts = dataset.metadata.countByDifficulty as Record<number, number> | undefined;
    expect(counts).toBeDefined();

    // 各等级数量之和应等于总任务数
    const totalCount =
      (counts?.[1] ?? 0) +
      (counts?.[2] ?? 0) +
      (counts?.[3] ?? 0);
    expect(totalCount).toBe(dataset.tasks.length);
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════
// 3. ToolBench Loader
// ═══════════════════════════════════════════════════════════════

describe("ToolBenchLoader", () => {
  it("应加载 ≥8 条内嵌样本", async () => {
    const loader = new ToolBenchLoader();
    const dataset = await loader.load({ maxTasks: 100 });

    expect(dataset.name).toBe("toolbench");
    expect(dataset.tasks.length).toBeGreaterThanOrEqual(8);

    // 每条应有 toolsRequired
    for (const task of dataset.tasks) {
      expect(task.toolsRequired).toBeDefined();
      expect(task.toolsRequired!.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

// ═══════════════════════════════════════════════════════════════
// 4. ToolCallJudge — 三种匹配模式
// ═══════════════════════════════════════════════════════════════

describe("ToolCallJudge", () => {
  const judge = new ToolCallJudge();

  it("exact 模式：参数完全匹配时得分 1", async () => {
    const input = "Test";
    // output：Agent 返回的实际调用（normalizeToolCall 支持 { name, args } 格式）
    const output = JSON.stringify([
      { name: "get_weather", args: { city: "Beijing", unit: "celsius" } },
    ]);
    // expected：传给 judge 的是 ExpectedToolCall[] 数组
    const expected = JSON.stringify([
      { name: "get_weather", argsMatch: "exact", expectedArgs: { city: "Beijing", unit: "celsius" } },
    ]);

    const score = await judge.evaluate(input, output, expected);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it("exact 模式：参数不匹配时得分 0", async () => {
    const input = "Test";
    const output = JSON.stringify([
      { name: "get_weather", args: { city: "Shanghai" } },
    ]);
    const expected = JSON.stringify([
      { name: "get_weather", argsMatch: "exact", expectedArgs: { city: "Beijing" } },
    ]);

    const score = await judge.evaluate(input, output, expected);
    expect(score.score).toBe(0);
    expect(score.passed).toBe(false);
  });

  it("subset 模式：实际参数包含期望子集即通过", async () => {
    const input = "Test";
    const output = JSON.stringify([
      { name: "search", args: { query: "AI", page: 1, limit: 10 } },
    ]);
    const expected = JSON.stringify([
      { name: "search", argsMatch: "subset", expectedArgs: { query: "AI" } },
    ]);

    const score = await judge.evaluate(input, output, expected);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it("contains 模式：实际 JSON 包含期望片段即通过", async () => {
    const input = "Test";
    // contains 匹配逻辑：JSON.stringify(actualArgs).includes(JSON.stringify(expectedArgs).slice(1,-1))
    // 即实际 JSON 字符串包含期望 JSON 去掉外层花括号的子串
    const output = JSON.stringify([
      { name: "send_email", args: { to: "user@example.com", subject: "Meeting Reminder" } },
    ]);
    // 期望的值必须与实际值完全相同才能“包含”
    const expected = JSON.stringify([
      { name: "send_email", argsMatch: "contains", expectedArgs: { subject: "Meeting Reminder" } },
    ]);

    const score = await judge.evaluate(input, output, expected);
    expect(score.score).toBe(1);
    expect(score.passed).toBe(true);
  });

  it("工具名不匹配时得分 0", async () => {
    const input = "Test";
    const output = JSON.stringify([
      { name: "get_weather", args: {} },
    ]);
    const expected = JSON.stringify([
      { name: "search_web", argsMatch: "exact", expectedArgs: {} },
    ]);

    const score = await judge.evaluate(input, output, expected);
    expect(score.score).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// 5. Evaluator 集成 ToolCallJudge
// ═══════════════════════════════════════════════════════════════

describe("Evaluator + ToolCallJudge 集成", () => {
  it("报告中应包含 perJudge['tool_call']", async () => {
    const toolCallJudge = new ToolCallJudge();
    const exactJudge = new ExactMatchJudge();
    const evaluator = new Evaluator({
      judges: [exactJudge, toolCallJudge],
      expectedOutputs: new Map([
        ["task_1", "Hello"],
      ]),
    });

    const tasks = [{ id: "task_1", input: "Say hello" }];
    const results = [{
      taskId: "task_1",
      success: true,
      output: "Hello",
      durationMs: 100,
      timestamp: new Date(),
    }];

    const report = await evaluator.evaluate(tasks, results);

    // perJudge 应包含两个 judge
    expect(report.perJudge).toHaveProperty("exact_match");
    expect(report.perJudge).toHaveProperty("tool_call");
    expect(report.totalTasks).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// 6. sampleTasks 工具函数
// ═══════════════════════════════════════════════════════════════

describe("sampleTasks", () => {
  it("不指定 maxTasks 时返回全部", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `t_${i}`,
      input: `input_${i}`,
      expected: {},
    }));

    const sampled = sampleTasks(tasks);
    expect(sampled.length).toBe(20);
  });

  it("maxTasks < 总数时返回指定数量", () => {
    const tasks = Array.from({ length: 20 }, (_, i) => ({
      id: `t_${i}`,
      input: `input_${i}`,
      expected: {},
    }));

    const sampled = sampleTasks(tasks, 5);
    expect(sampled.length).toBe(5);
  });

  it("maxTasks ≥ 总数时返回全部", () => {
    const tasks = Array.from({ length: 3 }, (_, i) => ({
      id: `t_${i}`,
      input: `input_${i}`,
      expected: {},
    }));

    const sampled = sampleTasks(tasks, 100);
    expect(sampled.length).toBe(3);
  });
});
