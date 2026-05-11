/**
 * 策略选择器 / 元认知决策层（Task 2.3）
 *
 * 不再按序执行所有算子，而是通过 LLM 驱动的元认知层
 * 判断当前失败的"最佳修复策略"。
 *
 * 硬编码基线规则 + LLM 覆写（2+ 条件同时满足时）。
 */

import pino from "pino";
import type { InteractionCase } from "./engine.js";
import type { AgentManager } from "../agent/manager.js";
import { safeJsonParseAny } from "../utils/json-guard.js";

const logger = pino({ name: "evolution:operator-selector" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 可用算子名称 */
export type OperatorName = "revision" | "recombination" | "refinement";

/** 失败画像——元认知层的输入 */
export interface FailureProfile {
  /** 主要失败类别 */
  failureCategory: string;
  /** 最近失败案例数 */
  recentCaseCount: number;
  /** 是否有 2+ 有效（成功）轨迹 */
  hasValidTrajectories: boolean;
  /** 主要错误类型 */
  errorType: "repeated" | "isolated" | "external" | "cascade";
  /** 是否检测到级联故障 */
  isCascade: boolean;
  /** 总体成功率 (0-1) */
  successRate: number;
}

/** 算子选择结果 */
export interface OperatorSelection {
  /** 选中的算子列表（1-2个） */
  selectedOperators: OperatorName[];
  /** 跳过的算子 */
  skipOperators: OperatorName[];
  /** 选择理由 */
  reason: string;
  /** 是否使用了 LLM 覆写 */
  llmOverride: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 硬编码决策规则
// ═══════════════════════════════════════════════════════════════

/** 决策矩阵：条件 → 推荐算子 */
const DECISION_MATRIX: Array<{
  condition: (profile: FailureProfile) => boolean;
  operators: OperatorName[];
  reason: string;
}> = [
  {
    // 连续3+同类失败 → 当前策略已无效，需正交替代
    condition: (p) => p.errorType === "repeated" && p.recentCaseCount >= 3,
    operators: ["revision"],
    reason: "连续同类别失败，当前策略已无效，需要正交替代方案",
  },
  {
    // 有2+有效轨迹 + 有失败 → 可合成混合策略
    condition: (p) => p.hasValidTrajectories && p.recentCaseCount > 0,
    operators: ["recombination"],
    reason: "有有效轨迹可学习，合成混合策略",
  },
  {
    // 成功率>0.7 但有 minor issues → 微调优化
    condition: (p) => p.successRate > 0.7 && p.recentCaseCount > 0 && p.errorType !== "repeated",
    operators: ["refinement"],
    reason: "成功率较高但仍有少量失败，微调优化即可",
  },
  {
    // 级联故障 → 跳过所有算子
    condition: (p) => p.isCascade,
    operators: [],
    reason: "检测到级联故障，根因在其他地方，跳过算子分析",
  },
  {
    // 仅1次失败且为外部错误 → 跳过（直接用 error-matching）
    condition: (p) => p.recentCaseCount === 1 && p.errorType === "external",
    operators: [],
    reason: "单次外部错误，已知修复更快，跳过算子分析",
  },
];

// ═══════════════════════════════════════════════════════════════
// OperatorSelector
// ═══════════════════════════════════════════════════════════════

export class OperatorSelector {
  /**
   * 从失败案例中构建失败画像
   */
  buildProfile(failureCases: InteractionCase[], allCases: InteractionCase[]): FailureProfile {
    const successes = allCases.filter((c) => c.success);

    // 找到主要失败类别
    const catCounts = new Map<string, number>();
    for (const c of failureCases) {
      const cat = c.failureCategory ?? "other";
      catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);
    }

    let mainCategory = "other";
    let maxCount = 0;
    for (const [cat, count] of catCounts) {
      if (count > maxCount) { maxCount = count; mainCategory = cat; }
    }

    // 判断错误类型
    let errorType: FailureProfile["errorType"] = "isolated";
    const maxSameCategory = Math.max(0, ...catCounts.values());
    if (maxSameCategory >= 3) {
      errorType = "repeated";
    } else if (failureCases.length === 1 && mainCategory === "timeout") {
      errorType = "external";
    }

    return {
      failureCategory: mainCategory,
      recentCaseCount: failureCases.length,
      hasValidTrajectories: successes.length >= 2,
      errorType,
      isCascade: false, // 由外部 CascadeDetector 设置
      successRate: allCases.length > 0 ? successes.length / allCases.length : 0,
    };
  }

  /**
   * 选择算子——先走硬编码规则，2+ 规则匹配时调 LLM 覆写
   */
  async select(
    profile: FailureProfile,
    agentManager?: AgentManager,
    agentId?: string,
  ): Promise<OperatorSelection> {
    // 1. 硬编码基线决策
    const matches: Array<{ operators: OperatorName[]; reason: string }> = [];
    for (const rule of DECISION_MATRIX) {
      if (rule.condition(profile)) {
        matches.push({ operators: rule.operators, reason: rule.reason });
      }
    }

    // 无匹配 → 默认跳过
    if (matches.length === 0) {
      return {
        selectedOperators: [],
        skipOperators: ["revision", "recombination", "refinement"],
        reason: "无匹配的决策规则，跳过所有算子",
        llmOverride: false,
      };
    }

    // 单一匹配 → 直接使用
    if (matches.length === 1) {
      const match = matches[0];
      const allOps: OperatorName[] = ["revision", "recombination", "refinement"];
      return {
        selectedOperators: match.operators,
        skipOperators: allOps.filter((o) => !match.operators.includes(o)),
        reason: match.reason,
        llmOverride: false,
      };
    }

    // 2+ 规则同时匹配 → LLM 覆写决策
    if (agentManager && agentId) {
      try {
        return await this.llmOverride(matches, profile, agentManager, agentId);
      } catch (err: any) {
        logger.warn({ err: err.message }, "LLM override failed, using first match");
      }
    }

    // LLM 不可用时：取第一个匹配
    const allOps: OperatorName[] = ["revision", "recombination", "refinement"];
    return {
      selectedOperators: matches[0].operators,
      skipOperators: allOps.filter((o) => !matches[0].operators.includes(o)),
      reason: `${matches.length} 条规则匹配，LLM 不可用，取第一条: ${matches[0].reason}`,
      llmOverride: false,
    };
  }

  /**
   * LLM 覆写——当 2+ 规则同时匹配时调用
   */
  private async llmOverride(
    matches: Array<{ operators: OperatorName[]; reason: string }>,
    profile: FailureProfile,
    agentManager: AgentManager,
    agentId: string,
  ): Promise<OperatorSelection> {
    const agent = agentManager.getAgent(agentId);
    if (!agent) throw new Error(`Agent ${agentId} not found`);

    const rulesDesc = matches
      .map((m, i) => `${i + 1}. 推荐算子: [${m.operators.join(", ") || "跳过"}] — ${m.reason}`)
      .join("\n");

    const prompt = `你是进化引擎的元认知决策层。当前有 ${matches.length} 条规则同时匹配，需要你选择最佳策略。

## 失败画像
- 主要失败类别: ${profile.failureCategory}
- 最近失败数: ${profile.recentCaseCount}
- 有有效轨迹: ${profile.hasValidTrajectories ? "是" : "否"}
- 错误类型: ${profile.errorType}
- 成功率: ${(profile.successRate * 100).toFixed(0)}%

## 匹配的规则
${rulesDesc}

## 任务
从以上规则中选择 1-2 个最可能解决问题的算子。如果认为都不合适，可以选 "skip"。

回复 JSON：
{
  "selectedOperators": ["revision"] | ["recombination"] | ["refinement"] | [],
  "reason": "<一句话解释为什么这样选择>"
}`;

    const { response } = await agent.chat(prompt, `operator_select_${Date.now()}`);
    try {
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("No JSON in response");

      const parsed = safeJsonParseAny(jsonMatch[0], "operator-selector");
      if (!parsed || typeof parsed !== "object") throw new Error("Invalid JSON response");
      const data = parsed as Record<string, unknown>;
      const selected: OperatorName[] = Array.isArray(data.selectedOperators)
        ? data.selectedOperators.filter((o: string) =>
            ["revision", "recombination", "refinement"].includes(o))
        : [];

      const allOps: OperatorName[] = ["revision", "recombination", "refinement"];
      return {
        selectedOperators: selected,
        skipOperators: allOps.filter((o) => !selected.includes(o)),
        reason: `LLM 覆写: ${data.reason ?? "基于元认知分析"}`,
        llmOverride: true,
      };
    } catch {
      // JSON 解析失败 → 回退到第一条规则
      const allOps: OperatorName[] = ["revision", "recombination", "refinement"];
      return {
        selectedOperators: matches[0].operators,
        skipOperators: allOps.filter((o) => !matches[0].operators.includes(o)),
        reason: `LLM 响应解析失败，回退: ${matches[0].reason}`,
        llmOverride: false,
      };
    }
  }
}
