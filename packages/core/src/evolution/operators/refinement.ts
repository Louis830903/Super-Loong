/**
 * Refinement 算子（Task 2.2）
 *
 * 借鉴 SE-Agent 的 Refinement 算子：
 * 对已有成功策略做风险感知的精简优化。
 * 适用场景：成功率>0.7 但有 minor issues，需微调而非大改。
 */

import pino from "pino";
import { EvolutionOperator, type OperatorContext, type OperatorResult } from "./base.js";

const logger = pino({ name: "evolution:operator:refinement" });

/**
 * Refinement 算子 —— 对已有成功策略做风险感知的精简优化。
 *
 * 核心逻辑：
 * 1. 加载最成功的案例（最高 score）
 * 2. 分析失败案例中的 minor issues
 * 3. LLM 去除冗余步骤 + 加入从失败中学到的防护措施
 * 4. 产出 patch 类型的 SkillProposal（增量修改，非全量替换）
 */
export class RefinementOperator extends EvolutionOperator {
  readonly name = "refinement";
  readonly description = "成功策略的风险感知精简优化";

  canHandle(context: OperatorContext): boolean {
    // 需要至少 1 个成功案例和 1 个失败案例
    const successes = context.allCases.filter((c) => c.success);
    if (successes.length === 0) return false;

    // 计算成功率
    const total = context.allCases.length;
    const successRate = successes.length / total;

    // 成功率 > 0.5 才做 Refinement（太低说明策略本身有问题，应该用 Revision）
    return successRate > 0.5 && context.failureCases.length > 0;
  }

  protected generateContent(context: OperatorContext): string {
    // 加载最成功案例（按 score 排序）
    const successes = context.allCases
      .filter((c) => c.success)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 2);

    const failures = context.failureCases.slice(0, 3);

    let bestCaseDesc = "";
    for (const c of successes) {
      bestCaseDesc += `- [${c.id}] 用户: ${c.userMessage.slice(0, 150)}\n`;
      bestCaseDesc += `  工具: ${c.toolCalls.join(", ") || "无"}\n`;
      bestCaseDesc += `  评分: ${c.score ?? "N/A"}\n`;
      bestCaseDesc += `  响应: ${c.agentResponse.slice(0, 200)}\n`;
    }

    let failuresDesc = "";
    for (const c of failures) {
      failuresDesc += `- [${c.id}] 失败: ${c.failureReason ?? "未知"} (${c.failureCategory ?? "other"})\n`;
    }

    const successRate = (
      context.allCases.filter((c) => c.success).length / Math.max(1, context.allCases.length)
    );

    return `你是一个 AI Agent 系统的策略优化器。当前策略整体成功率约为 ${(successRate * 100).toFixed(0)}%，但仍有少量失败。

## 最佳案例（最成功的执行）
${bestCaseDesc}

## 最近失败（minor issues）
${failuresDesc}

## 任务：风险感知的精简优化

对当前成功策略做 **微调优化**（而非彻底重写），重点是：
1. 识别成功案例中可能冗余的步骤（去除不必要的工具调用）
2. 从失败案例中提取防护措施（加入检查点、fallback 等）
3. 保持核心竞争力，只做增量改进
4. **如果失败源于某个函数的边界处理不完善**（如缺少 null 检查、超时未处理、异常未捕获），
   可直接产出该函数的修正代码（targetCode），做精准的代码级 refinement

请以 JSON 格式回复，使用 **patch** 操作（增量修改，非全量替换）：
{
  "proposals": [
    {
      "action": "patch",
      "skillName": "<existing_skill_name>",
      "description": "<what refinement is being made>",
      "content": "<SUGGESTED CHANGES — describe what to add/remove/modify>",
      "reasoning": "<why these refinements improve the strategy>",
      "skillType": "task_specific",
      "patchOperations": [
        {
          "oldString": "<section to replace>",
          "newString": "<improved version>"
        }
      ],
      "removedRedundancy": "<what redundant steps were removed>",
      "addedSafeguards": "<what protective measures were added>",
      "targetCode": {
        "modulePath": "evolution/engine.ts",
        "targetName": "functionName",
        "newCode": "<function with added safeguards / null checks / error handling>",
        "operation": "modify"
      }
    }
  ]
}

注意：targetCode 是可选字段。仅当失败可精确归因到某个函数的边界漏洞时才提供。
modulePath 是相对 packages/core/src 的路径，operation 为 modify | add | delete。`;
  }

  async process(context: OperatorContext): Promise<OperatorResult> {
    const startMs = Date.now();
    const prompt = this.generateContent(context);
    const proposals = await this.callLLM(
      context.agentManager,
      context.agentId ?? "",
      prompt,
      context.allCases,
    );

    // 标记为 Refinement 生成的精简优化
    for (const p of proposals) {
      p.skillType = "task_specific";
      (p as any)._operator = "refinement";
    }

    logger.info({ proposals: proposals.length }, "Refinement operator complete");
    return { proposals, operatorName: this.name, durationMs: Date.now() - startMs };
  }
}
