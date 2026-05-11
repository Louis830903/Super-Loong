/**
 * Revision 算子（Task 2.2）
 *
 * 借鉴 SE-Agent 的 Revision 算子：
 * 分析失败案例 → LLM 生成架构正交的替代策略。
 * 适用场景：连续3+同类失败，当前策略已无效，需要 fundamentally different approach。
 */

import pino from "pino";
import { EvolutionOperator, type OperatorContext, type OperatorResult } from "./base.js";
import type { SkillProposal } from "../engine.js";

const logger = pino({ name: "evolution:operator:revision" });

/**
 * Revision 算子 —— 当当前方法反复失败时，生成正交替代策略。
 *
 * 核心逻辑：
 * 1. 检测上下文中有 3+ 同类失败（同 failureCategory）
 * 2. 分析失败模式，找到当前方法的根本缺陷
 * 3. 要求 LLM 生成 fundamentally different approach
 * 4. 产出 create 类型的 SkillProposal
 */
export class RevisionOperator extends EvolutionOperator {
  readonly name = "revision";
  readonly description = "分析重复失败 → 生成架构正交的替代策略";

  canHandle(context: OperatorContext): boolean {
    const failures = context.failureCases;
    if (failures.length < 2) return false;

    // 检查是否有同类别连续失败（至少 2 个同类）
    const byCategory = new Map<string, number>();
    for (const c of failures) {
      const cat = c.failureCategory ?? "other";
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + 1);
    }

    // 任一类别的失败数 ≥ 2 触发 Revision
    for (const count of byCategory.values()) {
      if (count >= 2) return true;
    }
    return false;
  }

  protected generateContent(context: OperatorContext): string {
    const failures = context.failureCases.slice(0, 10);

    // 按类别分组描述
    const byCategory = new Map<string, typeof failures>();
    for (const c of failures) {
      const cat = c.failureCategory ?? "other";
      if (!byCategory.has(cat)) byCategory.set(cat, []);
      byCategory.get(cat)!.push(c);
    }

    let failuresDesc = "";
    for (const [cat, cases] of byCategory) {
      failuresDesc += `\n### 类别: ${cat} (${cases.length} 次失败)\n`;
      for (const c of cases.slice(0, 3)) {
        failuresDesc += `- [${c.id}] ${c.failureReason ?? "未知原因"}\n`;
      }
    }

    return `你是一个 AI Agent 系统的进化优化器。当前 agent 在以下类别上反复失败：

${failuresDesc}

## 任务：生成架构正交的替代策略

当前方法显然已经无效。请提出一个 **fundamentally different approach（架构正交的替代方案）**。

要求：
1. 新策略不能是对现有策略的微调——必须是不同思路
2. 新策略应该从不同的角度解决问题
3. 可以是新的工具组合、新的决策流程、或新的检查机制
4. **如果失败根源是代码缺陷**（例如缺少错误处理、逻辑分支缺失、参数校验不足），
   可直接生成源码级修改提案（targetCode），而非仅写技能说明。

请以 JSON 格式回复：
{
  "proposals": [
    {
      "action": "create",
      "skillName": "<snake_case_name>",
      "description": "<new skill or code change description>",
      "content": "<markdown skill content — new approach>",
      "reasoning": "<why this different approach should work better>",
      "skillType": "task_specific",
      "alternativeReason": "<why the current approach keeps failing>",
      "targetCode": {
        "modulePath": "evolution/engine.ts",
        "targetName": "functionName",
        "newCode": "<complete replacement function code>",
        "operation": "modify"
      }
    }
  ]
}

注意：targetCode 是可选字段。仅当失败根源明确可追溯到某一函数/方法的代码缺陷时才提供。
modulePath 是相对 packages/core/src 的路径，operation 为 modify | add | delete。`;
  }

  async process(context: OperatorContext): Promise<OperatorResult> {
    const startMs = Date.now();
    const prompt = this.generateContent(context);
    const proposals = await this.callLLM(
      context.agentManager,
      context.agentId ?? "",
      prompt,
      context.failureCases,
    );

    // 标记为 Revision 生成的替代策略
    for (const p of proposals) {
      p.skillType = "task_specific";
      (p as any)._operator = "revision";
    }

    logger.info({ proposals: proposals.length }, "Revision operator complete");
    return { proposals, operatorName: this.name, durationMs: Date.now() - startMs };
  }
}
