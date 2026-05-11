/**
 * 进化协调器（Task 2.1）
 *
 * 从 engine.ts 中提取「进化周期编排」逻辑到独立的 EvolutionCoordinator。
 *
 * 职责：
 * - 调度算子执行（OperatorSelector → 选定算子 → 执行）
 * - 管理进化预算（通过持有的 EvolutionBudget）
 * - 协调错误匹配（通过持有的 ErrorMatcher）
 * - 触发热修复流程
 *
 * EvolutionEngine 保留：
 * - InteractionCase 收集
 * - Nudge 触发
 * - 技能提案管理（proposals Map）
 * - 状态查询 API（getStats, getSnapshots 等）
 * - EventEmitter 事件发射
 */

import pino from "pino";
import type { InteractionCase, SkillProposal } from "./engine.js";
import type { AgentManager } from "../agent/manager.js";
import { getRegisteredOperators } from "./operators/base.js";
import { OperatorSelector, type FailureProfile } from "./operator-selector.js";
import { ErrorMatcher, type ErrorMatchResult } from "./error-matching.js";
import { EvolutionLock } from "./evolution-lock.js";

const logger = pino({ name: "evolution:coordinator" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 进化周期的输入 */
export interface CycleInput {
  /** 所有失败案例 */
  failureCases: InteractionCase[];
  /** 所有案例 */
  allCases: InteractionCase[];
  /** Agent 管理器 */
  agentManager: AgentManager;
  /** 当前 Agent ID */
  agentId: string;
  /** 是否检测到级联故障 */
  isCascade?: boolean;
}

/** 进化周期的输出 */
export interface CycleOutput {
  /** 生成的技能提案 */
  proposals: SkillProposal[];
  /** 错误匹配结果（如果适用） */
  errorMatch?: ErrorMatchResult;
  /** 跳过的算子 */
  skippedOperators: string[];
  /** 是否触发了热修复 */
  hotfixApplied: boolean;
}

// ═══════════════════════════════════════════════════════════════
// EvolutionCoordinator
// ═══════════════════════════════════════════════════════════════

export class EvolutionCoordinator {
  private selector: OperatorSelector;
  private errorMatcher: ErrorMatcher;
  private lock: EvolutionLock;

  constructor(dataDir?: string) {
    this.selector = new OperatorSelector();
    this.errorMatcher = new ErrorMatcher(dataDir);
    this.lock = new EvolutionLock(dataDir);
  }

  /**
   * 执行一个完整的进化周期：
   * 1. 先查错误数据库，看是否有已知修复
   * 2. 无匹配 → 构建失败画像 → 策略选择器决策 → 执行选定算子
   * 3. 返回提案
   */
  async runCycle(input: CycleInput): Promise<CycleOutput> {
    // Task 3.4: 进化锁保护——防止并发进化周期
    const result = await this.lock.withLock(async () => {
      return await this._runCycleUnlocked(input);
    }, `coordinator_${input.agentId}`);

    if (!result) {
      logger.info({ agentId: input.agentId }, "Evolution cycle skipped: lock not acquired");
      return { proposals: [], skippedOperators: ["revision", "recombination", "refinement"], hotfixApplied: false };
    }
    return result;
  }

  /** runCycle 的无锁内部实现 */
  private async _runCycleUnlocked(input: CycleInput): Promise<CycleOutput> {
    const skippedOperators: string[] = [];
    let errorMatch: ErrorMatchResult | undefined;
    let hotfixApplied = false;

    // Step 1: 智能错误匹配——先查已知修复
    if (input.failureCases.length === 1 && !input.isCascade) {
      errorMatch = this.errorMatcher.match(input.failureCases[0]);
      if (errorMatch.matched && errorMatch.autoApply && errorMatch.record?.battleTested) {
        logger.info({
          errorId: errorMatch.record?.id,
          confidence: errorMatch.confidence,
          fix: errorMatch.record?.fixSkillName,
        }, "Battle-tested fix matched, skipping LLM analysis");
        // 热修复：已知修复直接复用，不返回新提案
        hotfixApplied = true;
        return { proposals: [], errorMatch, skippedOperators: ["revision", "recombination", "refinement"], hotfixApplied };
      }
    }

    // Step 2: 构建失败画像 + 策略选择
    const profile = this.selector.buildProfile(input.failureCases, input.allCases);
    if (input.isCascade) {
      profile.isCascade = true;
    }

    const selection = await this.selector.select(profile, input.agentManager, input.agentId);

    // Step 3: 注册并执行选定算子
    const operators = getRegisteredOperators();
    const operatorMap = new Map(operators.map((o) => [o.name, o]));

    const allProposals: SkillProposal[] = [];
    for (const opName of selection.selectedOperators) {
      const op = operatorMap.get(opName);
      if (!op) {
        logger.warn({ operator: opName }, "Operator not registered, skipping");
        skippedOperators.push(opName);
        continue;
      }

      // 二次检查 canHandle（运行时校验）
      const context = { failureCases: input.failureCases, allCases: input.allCases, agentManager: input.agentManager, agentId: input.agentId };
      if (!op.canHandle(context)) {
        logger.info({ operator: opName }, "Operator canHandle=false at runtime, skipping");
        skippedOperators.push(opName);
        continue;
      }

      try {
        const result = await op.process(context);
        allProposals.push(...result.proposals);
        logger.info({ operator: opName, proposals: result.proposals.length, durationMs: result.durationMs },
          "Operator executed");
      } catch (err: any) {
        logger.error({ operator: opName, err: err.message }, "Operator execution failed");
      }
    }

    skippedOperators.push(...selection.skipOperators);
    return {
      proposals: allProposals,
      errorMatch,
      skippedOperators,
      hotfixApplied,
    };
  }

  /**
   * 记录成功修复到错误数据库
   */
  recordSuccessfulFix(failureCase: InteractionCase, proposalId: string, skillName: string): void {
    const reason = failureCase.failureReason ?? "";
    if (!reason) return;

    // 查找是否已有匹配记录
    const match = this.errorMatcher.match(failureCase);
    if (match.matched && match.record) {
      this.errorMatcher.recordHeal(match.record.id);
      logger.info({ errorId: match.record.id, healCount: match.record.healCount + 1 }, "Heal recorded on existing error");
      return;
    }

    // 新错误模式 —— 创建记录
    this.errorMatcher.addRecord({
      pattern: reason.slice(0, 300),
      matchType: "token_overlap",
      failureCategory: failureCase.failureCategory ?? "other",
      fixProposalId: proposalId,
      fixSkillName: skillName,
      fixDescription: `Auto-fixed by proposal ${proposalId}`,
    });
  }

  /** 获取错误匹配器（供外部查询） */
  getErrorMatcher(): ErrorMatcher {
    return this.errorMatcher;
  }
}
