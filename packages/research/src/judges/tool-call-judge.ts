/**
 * judges/tool-call-judge.ts — 工具调用轨迹评判器
 *
 * 解析 Agent 的工具调用 trace，与 BenchmarkExpected.toolCalls 进行比对。
 * 支持 3 种匹配模式：
 *   - exact：工具名 + 参数完全一致
 *   - subset：期望参数是实际参数的子集（宽松匹配）
 *   - contains：实际参数 JSON 字符串包含期望值（最宽松）
 *
 * 评分逻辑：
 *   - 按序逐个比对期望工具调用列表
 *   - 每个匹配成功的工具调用得 1 分
 *   - 总分 = 匹配数 / 期望总数
 *   - 通过阈值 = 0.5（即一半以上工具调用正确）
 *
 * 参考 Spec v1.3 T4.2（L636）
 */

import type { Judge, JudgeScore } from "../evaluator.js";

/**
 * 实际工具调用记录（从 Agent trace 中提取）。
 * 与 LLMToolCall 结构对齐，但简化为纯文本。
 */
export interface ActualToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * 期望的单个工具调用。
 */
export interface ExpectedToolCall {
  name: string;
  argsMatch: "exact" | "subset" | "contains";
  expectedArgs?: Record<string, unknown>;
}

/**
 * ToolCallJudge — 基于工具调用轨迹的评判器。
 *
 * 用法：
 *   1. 创建实例时传入 parseActualCalls 回调（从 output 中解析实际工具调用）
 *   2. evaluate() 时传入 expected 字段（JSON 编码的 ExpectedToolCall[]）
 *   3. 返回匹配比例分数
 */
export class ToolCallJudge implements Judge {
  name = "tool_call";

  /**
   * 解析器：从 Agent 输出文本中提取实际工具调用列表。
   * 默认实现尝试 JSON.parse(output) 提取 toolCalls 字段。
   */
  private parseActualCalls: (output: string) => ActualToolCall[];

  constructor(parseActualCalls?: (output: string) => ActualToolCall[]) {
    this.parseActualCalls = parseActualCalls ?? defaultParseActualCalls;
  }

  async evaluate(input: string, output: string, expected?: string): Promise<JudgeScore> {
    // 无期望工具调用：跳过
    if (!expected) {
      return { score: 1, passed: true, reason: "No expected tool calls" };
    }

    // 解析期望列表
    let expectedCalls: ExpectedToolCall[];
    try {
      expectedCalls = JSON.parse(expected) as ExpectedToolCall[];
    } catch {
      return { score: 0, passed: false, reason: "Failed to parse expected tool calls JSON" };
    }

    if (!Array.isArray(expectedCalls) || expectedCalls.length === 0) {
      return { score: 1, passed: true, reason: "Empty expected tool calls" };
    }

    // 解析实际调用
    const actualCalls = this.parseActualCalls(output);

    // 逐个比对
    let matched = 0;
    const details: string[] = [];
    for (let i = 0; i < expectedCalls.length; i++) {
      const exp = expectedCalls[i];
      // 在实际调用中寻找第一个名称匹配且参数匹配的
      const matchIdx = actualCalls.findIndex(
        (actual) => actual.name === exp.name && this.matchArgs(actual.args, exp),
      );
      if (matchIdx >= 0) {
        matched++;
        details.push(`✓ ${exp.name}`);
        // 移除已匹配项，避免一对多
        actualCalls.splice(matchIdx, 1);
      } else {
        details.push(`✗ ${exp.name} (not found)`);
      }
    }

    const score = expectedCalls.length > 0 ? matched / expectedCalls.length : 1;
    return {
      score,
      passed: score >= 0.5,
      reason: `Matched ${matched}/${expectedCalls.length}: ${details.join(", ")}`,
    };
  }

  /**
   * 根据匹配模式判断参数是否一致。
   */
  private matchArgs(actualArgs: Record<string, unknown>, exp: ExpectedToolCall): boolean {
    if (!exp.expectedArgs) return true; // 不检查参数

    switch (exp.argsMatch) {
      case "exact":
        return JSON.stringify(sortKeys(actualArgs)) === JSON.stringify(sortKeys(exp.expectedArgs));

      case "subset":
        // 期望的每个键值在实际参数中存在且相等
        return Object.entries(exp.expectedArgs).every(
          ([k, v]) => JSON.stringify(actualArgs[k]) === JSON.stringify(v),
        );

      case "contains":
        // 实际参数 JSON 包含期望值的 JSON
        return JSON.stringify(actualArgs).includes(JSON.stringify(exp.expectedArgs).slice(1, -1));

      default:
        return false;
    }
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 默认的工具调用解析器：
 * 尝试从 output 中提取 JSON 数组或 { toolCalls: [...] } 结构。
 */
function defaultParseActualCalls(output: string): ActualToolCall[] {
  try {
    const parsed = JSON.parse(output);
    // 情况1：直接是数组
    if (Array.isArray(parsed)) {
      return parsed.map(normalizeToolCall).filter(Boolean) as ActualToolCall[];
    }
    // 情况2：{ toolCalls: [...] }
    if (parsed?.toolCalls && Array.isArray(parsed.toolCalls)) {
      return parsed.toolCalls.map(normalizeToolCall).filter(Boolean) as ActualToolCall[];
    }
  } catch {
    // 尝试从文本中提取 JSON 数组
    const match = output.match(/\[[\s\S]*\]/);
    if (match) {
      try {
        const arr = JSON.parse(match[0]);
        if (Array.isArray(arr)) {
          return arr.map(normalizeToolCall).filter(Boolean) as ActualToolCall[];
        }
      } catch { /* ignore */ }
    }
  }
  return [];
}

/** 将各种格式的 tool call 归一化为 ActualToolCall */
function normalizeToolCall(raw: unknown): ActualToolCall | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  // 支持 { name, args } 或 { function: { name, arguments } }（OpenAI 风格）
  if (typeof obj.name === "string") {
    return {
      name: obj.name,
      args: (typeof obj.args === "object" && obj.args !== null ? obj.args : {}) as Record<string, unknown>,
    };
  }
  if (obj.function && typeof obj.function === "object") {
    const fn = obj.function as Record<string, unknown>;
    if (typeof fn.name === "string") {
      let args: Record<string, unknown> = {};
      if (typeof fn.arguments === "string") {
        try { args = JSON.parse(fn.arguments); } catch { /* ignore */ }
      } else if (typeof fn.arguments === "object" && fn.arguments !== null) {
        args = fn.arguments as Record<string, unknown>;
      }
      return { name: fn.name, args };
    }
  }
  return null;
}

/** 递归排序对象键（确保 JSON 比较稳定） */
function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const val = obj[key];
    sorted[key] = val && typeof val === "object" && !Array.isArray(val)
      ? sortKeys(val as Record<string, unknown>)
      : val;
  }
  return sorted;
}
