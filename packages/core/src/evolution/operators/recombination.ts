/**
 * Recombination 算子（Task 2.2）
 *
 * 借鉴 SE-Agent 的 Recombination 算子：
 * 当同一 Agent 有 2+ 条成功轨迹时，合成混合策略。
 * 识别各自的强项 → 生成互补的混合策略。
 */

import pino from "pino";
import { EvolutionOperator, type OperatorContext, type OperatorResult } from "./base.js";

const logger = pino({ name: "evolution:operator:recombination" });

/**
 * Recombination 算子 —— 混合两条以上成功轨迹，生成互补策略。
 *
 * 核心逻辑：
 * 1. 加载同一 Agent 的前几次成功案例（success=true）
 * 2. LLM 识别各自强项
 * 3. 生成互补的混合策略
 * 4. 触发条件：allCases 中 success 案例 ≥ 2
 */
export class RecombinationOperator extends EvolutionOperator {
  readonly name = "recombination";
  readonly description = "合成 2+ 条成功轨迹 → 互补混合策略";

  canHandle(context: OperatorContext): boolean {
    // 需要同时有成功案例和失败案例才有合成价值
    const successes = context.allCases.filter((c) => c.success);
    const failures = context.failureCases.filter((c) => !c.success);
    return successes.length >= 2 && failures.length > 0;
  }

  protected generateContent(context: OperatorContext): string {
    const successes = context.allCases
      .filter((c) => c.success)
      .slice(0, 4);
    const failures = context.failureCases.slice(0, 3);

    let successesDesc = "";
    for (const c of successes) {
      successesDesc += `- [${c.id}] 用户: ${c.userMessage.slice(0, 150)}\n`;
      successesDesc += `  工具: ${c.toolCalls.join(", ") || "无"}\n`;
      if (c.score !== undefined) {
        successesDesc += `  评分: ${c.score}\n`;
      }
    }

    let failuresDesc = "";
    for (const c of failures) {
      failuresDesc += `- [${c.id}] 失败原因: ${c.failureReason ?? "未知"}\n`;
      failuresDesc += `  类别: ${c.failureCategory ?? "other"}\n`;
    }

    return `你是一个 AI Agent 系统的策略优化器。

## 成功案例（可用于学习）
${successesDesc}

## 最近失败（需要解决）
${failuresDesc}

## 任务：合成混合策略

请从成功案例中提取各自最有效的部分，组合成一个**互补的混合策略**。

要求：
1. 识别每个成功案例的强项（哪个步骤/工具/决策最关键）
2. 将强项组合成一个新策略
3. 新策略应能覆盖失败案例中的缺陷
4. **如果失败源于成功的代码路径与失败的代码路径之间的差异**，
   可直接产出源码级修改（targetCode）来合并两者优点

请以 JSON 格式回复：
{
  "proposals": [
    {
      "action": "create",
      "skillName": "<snake_case_name>",
      "description": "<combined strategy description>",
      "content": "<markdown skill content with mixed approach>",
      "reasoning": "<why combining these approaches works better>",
      "skillType": "general",
      "sourceStrategies": ["<case_id_1>", "<case_id_2>"],
      "strengthOfEach": "<what each contributed source brought to the mix>",
      "targetCode": {
        "modulePath": "evolution/engine.ts",
        "targetName": "functionName",
        "newCode": "<complete combined function code>",
        "operation": "modify"
      }
    }
  ]
}

注意：targetCode 是可选字段。仅当可以从成功/失败案例中提取具体代码改进时才提供。
modulePath 是相对 packages/core/src 的路径。`;
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

    // 标记为 Recombination 生成的混合策略
    for (const p of proposals) {
      p.skillType = "general";
      (p as any)._operator = "recombination";
    }

    logger.info({ proposals: proposals.length }, "Recombination operator complete");
    return { proposals, operatorName: this.name, durationMs: Date.now() - startMs };
  }
}
