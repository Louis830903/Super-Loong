/**
 * 进化预算与速率控制（Task 1.4）
 *
 * 防止进化引擎无限消耗 LLM 调用和文件修改资源。
 * - 单周期 LLM 调用上限
 * - 单周期文件修改上限
 * - 进化冷却期
 * - 连续周期上限（防止死循环）
 */

import pino from "pino";

const logger = pino({ name: "evolution-budget" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 预算配置 */
export interface BudgetConfig {
  /** 单周期最多 LLM 调用次数（默认 5，对标 Godel 的保守策略） */
  maxLlmCallsPerCycle: number;
  /** 单周期最多文件修改数（默认 3，对标 Godel 的 3 函数限制） */
  maxFileModificationsPerCycle: number;
  /** 进化冷却期（分钟，默认 30） */
  cooldownMinutes: number;
  /** 连续进化周期上限（默认 10，防死循环） */
  maxConsecutiveCycles: number;
}

/** 预算检查结果 */
export interface BudgetCheckResult {
  /** 是否被阻止 */
  blocked: boolean;
  /** 阻止原因 */
  reason?: string;
}

/** 预算统计 */
export interface BudgetStats {
  /** 本周期已用 LLM 调用次数 */
  llmCallsUsed: number;
  /** 周期 LLM 调用上限 */
  llmCallsLimit: number;
  /** 本周期已用文件修改次数 */
  fileModsUsed: number;
  /** 周期文件修改上限 */
  fileModsLimit: number;
  /** 是否在冷却期 */
  inCooldown: boolean;
  /** 冷却结束时间（ISO string） */
  cooldownUntil: string | null;
  /** 连续进化周期计数 */
  consecutiveCycles: number;
  /** 连续周期上限 */
  consecutiveCyclesLimit: number;
}

// ═══════════════════════════════════════════════════════════════
// 默认配置
// ═══════════════════════════════════════════════════════════════

export const DEFAULT_BUDGET_CONFIG: BudgetConfig = {
  maxLlmCallsPerCycle: 5,
  maxFileModificationsPerCycle: 3,
  cooldownMinutes: 30,
  maxConsecutiveCycles: 10,
};

// ═══════════════════════════════════════════════════════════════
// EvolutionBudget 核心类
// ═══════════════════════════════════════════════════════════════

export class EvolutionBudget {
  private config: BudgetConfig;

  // 周期内计数
  private _llmCallsInCycle = 0;
  private _fileModsInCycle = 0;

  // 冷却与连续周期
  private _cycleStartTime: number | null = null;
  private _lastCycleEndTime: number | null = null;
  private _consecutiveCycles = 0;

  constructor(config?: Partial<BudgetConfig>) {
    this.config = { ...DEFAULT_BUDGET_CONFIG, ...config };
  }

  // ─── 周期管理 ──────────────────────────────────────────────

  /**
   * 新周期开始前检查：是否在冷却期 / 是否超过连续周期上限
   */
  canStartCycle(): BudgetCheckResult {
    // 检查冷却期
    if (this._lastCycleEndTime) {
      const cooldownMs = this.config.cooldownMinutes * 60_000;
      const elapsed = Date.now() - this._lastCycleEndTime;
      if (elapsed < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - elapsed) / 60_000);
        return {
          blocked: true,
          reason: `冷却期未结束，还需约 ${remainingMinutes} 分钟`,
        };
      }
    }

    // 检查连续周期上限
    if (this._consecutiveCycles >= this.config.maxConsecutiveCycles) {
      return {
        blocked: true,
        reason: `已达连续周期上限 (${this.config.maxConsecutiveCycles})，请等待手动干预`,
      };
    }

    return { blocked: false };
  }

  /**
   * 开始新的进化周期
   */
  startCycle(): void {
    this._cycleStartTime = Date.now();
    this._llmCallsInCycle = 0;
    this._fileModsInCycle = 0;
    this._consecutiveCycles++;

    logger.info({
      cycle: this._consecutiveCycles,
      maxConsecutive: this.config.maxConsecutiveCycles,
    }, "Evolution cycle started");
  }

  /**
   * 结束当前进化周期
   */
  endCycle(): void {
    this._lastCycleEndTime = Date.now();
    this._cycleStartTime = null;

    logger.info({
      cycle: this._consecutiveCycles,
      llmCalls: this._llmCallsInCycle,
      fileMods: this._fileModsInCycle,
    }, "Evolution cycle ended");
  }

  // ─── 配额消耗 ──────────────────────────────────────────────

  /**
   * 记录一次 LLM 调用，返回是否还有配额
   */
  recordLlmCall(): BudgetCheckResult {
    this._llmCallsInCycle++;

    if (this._llmCallsInCycle > this.config.maxLlmCallsPerCycle) {
      return {
        blocked: true,
        reason: `LLM 调用配额用尽 (${this._llmCallsInCycle}/${this.config.maxLlmCallsPerCycle})`,
      };
    }

    return { blocked: false };
  }

  /**
   * 记录一次文件修改，返回是否还有配额
   */
  recordFileModification(): BudgetCheckResult {
    this._fileModsInCycle++;

    if (this._fileModsInCycle > this.config.maxFileModificationsPerCycle) {
      return {
        blocked: true,
        reason: `文件修改配额用尽 (${this._fileModsInCycle}/${this.config.maxFileModificationsPerCycle})`,
      };
    }

    return { blocked: false };
  }

  // ─── 统计 ──────────────────────────────────────────────────

  getStats(): BudgetStats {
    const cooldownMs = this.config.cooldownMinutes * 60_000;
    const inCooldown = this._lastCycleEndTime
      ? Date.now() - this._lastCycleEndTime < cooldownMs
      : false;
    const cooldownUntil = this._lastCycleEndTime
      ? new Date(this._lastCycleEndTime + cooldownMs).toISOString()
      : null;

    return {
      llmCallsUsed: this._llmCallsInCycle,
      llmCallsLimit: this.config.maxLlmCallsPerCycle,
      fileModsUsed: this._fileModsInCycle,
      fileModsLimit: this.config.maxFileModificationsPerCycle,
      inCooldown,
      cooldownUntil,
      consecutiveCycles: this._consecutiveCycles,
      consecutiveCyclesLimit: this.config.maxConsecutiveCycles,
    };
  }

  /** 跳过一次周期（不增加计数，但触发冷却） */
  skipCycle(): void {
    this._lastCycleEndTime = Date.now();
    this._cycleStartTime = null;
  }

  /** 重置所有计数器（手动干预后调用） */
  reset(): void {
    this._llmCallsInCycle = 0;
    this._fileModsInCycle = 0;
    this._cycleStartTime = null;
    this._lastCycleEndTime = null;
    this._consecutiveCycles = 0;
    logger.info("Evolution budget reset");
  }

  /** 获取当前配置 */
  getConfig(): BudgetConfig {
    return { ...this.config };
  }

  /** 更新配置 */
  updateConfig(partial: Partial<BudgetConfig>): void {
    Object.assign(this.config, partial);
  }
}
