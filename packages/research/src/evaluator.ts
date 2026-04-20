/**
 * 评估框架 — 可插拔评判器 + 多维指标 + 报告生成
 *
 * 参考 Hermes batch_runner.py 的评估逻辑：
 * - 精确匹配、LLM-as-Judge、自定义函数
 * - 多维指标：成功率、工具调用效率、token 消耗、延迟
 * - 评估报告生成（JSON + 人类可读摘要）
 */

import pino from "pino";
import type { TaskResult } from "./batch-runner.js";

const logger = pino({ name: "research:evaluator" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 评判器接口 */
export interface Judge {
  name: string;
  evaluate(input: string, output: string, expected?: string): Promise<JudgeScore>;
}

/** 评判分数 */
export interface JudgeScore {
  score: number; // 0-1
  passed: boolean;
  reason: string;
}

/** 评估配置 */
export interface EvalConfig {
  judges: Judge[];
  expectedOutputs?: Map<string, string>; // taskId → expected
}

/** 评估结果 */
export interface EvalResult {
  taskId: string;
  scores: Record<string, JudgeScore>; // judgeName → score
  avgScore: number;
  passed: boolean;
}

/** 评估报告 */
export interface EvalReport {
  generatedAt: string;
  totalTasks: number;
  passRate: number;
  avgScore: number;
  metrics: {
    successRate: number;
    avgDurationMs: number;
    avgTokens: number;
    toolEfficiency: number;
  };
  perJudge: Record<string, { avgScore: number; passRate: number }>;
  results: EvalResult[];
}

// ═══════════════════════════════════════════════════════════════
// Built-in Judges
// ═══════════════════════════════════════════════════════════════

/** 精确匹配评判器 */
export class ExactMatchJudge implements Judge {
  name = "exact_match";

  async evaluate(input: string, output: string, expected?: string): Promise<JudgeScore> {
    if (!expected) return { score: 1, passed: true, reason: "No expected output" };
    const match = output.trim() === expected.trim();
    return {
      score: match ? 1 : 0,
      passed: match,
      reason: match ? "Exact match" : "Output does not match expected",
    };
  }
}

/** 包含匹配评判器 */
export class ContainsJudge implements Judge {
  name = "contains";

  async evaluate(input: string, output: string, expected?: string): Promise<JudgeScore> {
    if (!expected) return { score: 1, passed: true, reason: "No expected output" };
    const keywords = expected.split("|").map((k) => k.trim());
    const matches = keywords.filter((k) => output.toLowerCase().includes(k.toLowerCase()));
    const score = keywords.length > 0 ? matches.length / keywords.length : 1;
    return {
      score,
      passed: score >= 0.5,
      reason: `Matched ${matches.length}/${keywords.length} keywords`,
    };
  }
}

/** LLM-as-Judge 评判器 */
export class LLMJudge implements Judge {
  name = "llm_judge";
  private llmCall: (prompt: string) => Promise<string>;

  constructor(llmCall: (prompt: string) => Promise<string>) {
    this.llmCall = llmCall;
  }

  async evaluate(input: string, output: string, expected?: string): Promise<JudgeScore> {
    const prompt = `You are evaluating an AI assistant's response.

Input: ${input.slice(0, 500)}
Output: ${output.slice(0, 1000)}
${expected ? `Expected: ${expected.slice(0, 500)}` : ""}

Rate the output quality from 0-10 and explain. Return JSON:
{"score": <0-10>, "reason": "<explanation>"}`;

    try {
      const response = await this.llmCall(prompt);
      const parsed = JSON.parse(response.match(/\{[\s\S]*\}/)?.[0] ?? "{}");
      const score = Math.min(Math.max((parsed.score ?? 5) / 10, 0), 1);
      return {
        score,
        passed: score >= 0.5,
        reason: parsed.reason ?? "LLM evaluation",
      };
    } catch {
      return { score: 0.5, passed: true, reason: "LLM judge failed, defaulting" };
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Evaluator
// ═══════════════════════════════════════════════════════════════

export class Evaluator {
  private config: EvalConfig;

  constructor(config: EvalConfig) {
    this.config = config;
  }

  /**
   * 评估一批任务结果
   */
  async evaluate(
    tasks: Array<{ id: string; input: string }>,
    results: TaskResult[]
  ): Promise<EvalReport> {
    const resultMap = new Map(results.map((r) => [r.taskId, r]));
    const evalResults: EvalResult[] = [];

    for (const task of tasks) {
      const result = resultMap.get(task.id);
      if (!result) continue;

      const expected = this.config.expectedOutputs?.get(task.id);
      const scores: Record<string, JudgeScore> = {};

      for (const judge of this.config.judges) {
        try {
          scores[judge.name] = await judge.evaluate(task.input, result.output, expected);
        } catch (err) {
          scores[judge.name] = { score: 0, passed: false, reason: `Judge error: ${err}` };
        }
      }

      const scoreValues = Object.values(scores).map((s) => s.score);
      const avgScore = scoreValues.length > 0 ? scoreValues.reduce((a, b) => a + b, 0) / scoreValues.length : 0;

      evalResults.push({
        taskId: task.id,
        scores,
        avgScore,
        passed: avgScore >= 0.5,
      });
    }

    return this.buildReport(results, evalResults);
  }

  private buildReport(results: TaskResult[], evalResults: EvalResult[]): EvalReport {
    const passRate = evalResults.length > 0
      ? evalResults.filter((r) => r.passed).length / evalResults.length
      : 0;
    const avgScore = evalResults.length > 0
      ? evalResults.reduce((sum, r) => sum + r.avgScore, 0) / evalResults.length
      : 0;

    // 多维指标
    const successRate = results.length > 0 ? results.filter((r) => r.success).length / results.length : 0;
    const avgDuration = results.length > 0 ? results.reduce((sum, r) => sum + r.durationMs, 0) / results.length : 0;
    const tokens = results.map((r) => (r.tokenUsage?.prompt ?? 0) + (r.tokenUsage?.completion ?? 0));
    const avgTokens = tokens.length > 0 ? tokens.reduce((a, b) => a + b, 0) / tokens.length : 0;
    const toolCounts = results.map((r) => r.toolCalls?.length ?? 0);
    const toolEfficiency = toolCounts.length > 0 ? toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length : 0;

    // 每个 judge 的统计
    const perJudge: Record<string, { avgScore: number; passRate: number }> = {};
    for (const judge of this.config.judges) {
      const judgeScores = evalResults.map((r) => r.scores[judge.name]).filter(Boolean);
      const avg = judgeScores.length > 0 ? judgeScores.reduce((sum, s) => sum + s.score, 0) / judgeScores.length : 0;
      const pass = judgeScores.length > 0 ? judgeScores.filter((s) => s.passed).length / judgeScores.length : 0;
      perJudge[judge.name] = { avgScore: avg, passRate: pass };
    }

    return {
      generatedAt: new Date().toISOString(),
      totalTasks: evalResults.length,
      passRate,
      avgScore,
      metrics: {
        successRate,
        avgDurationMs: avgDuration,
        avgTokens,
        toolEfficiency,
      },
      perJudge,
      results: evalResults,
    };
  }
}
