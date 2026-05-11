/**
 * 零配置渐进接管 — 6 级自动化信任阶梯，让 Agent 从手动到全自主渐进升级。
 *
 * 6 级信任阶梯：
 *   L0 完全手动 — 所有操作需用户确认（默认）
 *   L1 建议模式 — Agent 提出建议，用户选择执行（使用 1 天后）
 *   L2 确认模式 — Agent 执行前询问确认（使用 3 天后）
 *   L3 通知模式 — Agent 执行后通知用户（使用 1 周后）
 *   L4 静默模式 — Agent 自主执行，仅在失败时通知（使用 2 周后）
 *   L5 全自主   — Agent 自主规划执行所有操作（使用 1 月+手动开启）
 *
 * 升级条件：
 *   - 该级别内成功率 >= 95%
 *   - 用户未手动撤销 >= 10 次操作
 *   - 用户未降级 >= 7 天
 *
 * 安全：安全操作（rm -rf、sudo、配置修改）始终保持 L2 以上确认要求。
 */

import pino from "pino";

const logger = pino({ name: "progressive-automation" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 自动化信任级别 */
export type AutomationLevel = 0 | 1 | 2 | 3 | 4 | 5;

/** 级别定义 */
export interface LevelDefinition {
  level: AutomationLevel;
  name: string;
  /** 行为描述 */
  behavior: string;
  /** 升级所需的最小使用天数 */
  minDaysToUpgrade: number;
  /** 升级所需的最小成功率 (0-1) */
  minSuccessRate: number;
  /** 升级所需的最小未撤销操作数 */
  minUndoCount: number;
  /** 升级所需的最小未降级天数 */
  minNoDowngradeDays: number;
}

/** 操作记录 */
export interface AutomationAction {
  /** 操作 ID */
  id: string;
  /** 操作类型 */
  type: string;
  /** 操作描述 */
  description: string;
  /** 是否成功 */
  success: boolean;
  /** 是否被用户撤销 */
  undoneByUser: boolean;
  /** 时间 */
  timestamp: Date;
  /** 操作时的自动化级别 */
  levelAt: AutomationLevel;
  /** 是否属于安全敏感操作 */
  isSafetyCritical: boolean;
}

/** 级别变更记录 */
export interface LevelChange {
  from: AutomationLevel;
  to: AutomationLevel;
  reason: string;
  timestamp: Date;
  /** 是自动升级还是手动调整 */
  source: "auto" | "manual";
}

/** 渐进自动化配置 */
export interface ProgressiveAutomationConfig {
  /** 初始级别 */
  initialLevel: AutomationLevel;
  /** 最大自动升级级别 */
  maxAutoLevel: AutomationLevel;
  /** 自动升级检查间隔（毫秒，默认 24 小时） */
  upgradeCheckInterval: number;
  /** 最大操作记录数（默认 1000） */
  maxActionHistory: number;
  /** 安全关键操作列表 */
  safetyCriticalPatterns: string[];
}

const DEFAULT_CONFIG: ProgressiveAutomationConfig = {
  initialLevel: 0,
  maxAutoLevel: 4, // 不能自动升到 L5，需手动
  upgradeCheckInterval: 24 * 60 * 60 * 1000,
  maxActionHistory: 1000,
  safetyCriticalPatterns: [
    "rm -rf",
    "sudo",
    "chmod",
    "chown",
    "systemctl",
    "shutdown",
    "reboot",
    "format",
    "mkfs",
    "dd",
    "del /f",
    "reg delete",
    "diskpart",
    "DROP TABLE",
    "DELETE FROM",
    "TRUNCATE",
  ],
};

/** 6 级自动化定义 */
export const AUTOMATION_LEVELS: LevelDefinition[] = [
  {
    level: 0,
    name: "完全手动",
    behavior: "所有操作需用户确认后才能执行",
    minDaysToUpgrade: 1,
    minSuccessRate: 0.8,
    minUndoCount: 3,
    minNoDowngradeDays: 1,
  },
  {
    level: 1,
    name: "建议模式",
    behavior: "Agent 提出操作建议，用户从建议中选择执行",
    minDaysToUpgrade: 3,
    minSuccessRate: 0.85,
    minUndoCount: 5,
    minNoDowngradeDays: 2,
  },
  {
    level: 2,
    name: "确认模式",
    behavior: "Agent 执行前询问用户确认",
    minDaysToUpgrade: 7,
    minSuccessRate: 0.9,
    minUndoCount: 7,
    minNoDowngradeDays: 3,
  },
  {
    level: 3,
    name: "通知模式",
    behavior: "Agent 执行后通知用户（非阻塞）",
    minDaysToUpgrade: 14,
    minSuccessRate: 0.92,
    minUndoCount: 10,
    minNoDowngradeDays: 5,
  },
  {
    level: 4,
    name: "静默模式",
    behavior: "Agent 自主执行，仅在失败或异常时通知用户",
    minDaysToUpgrade: 30,
    minSuccessRate: 0.95,
    minUndoCount: 15,
    minNoDowngradeDays: 7,
  },
  {
    level: 5,
    name: "全自主",
    behavior: "Agent 自主规划执行所有操作，无需用户干预",
    minDaysToUpgrade: Infinity, // 无法自动升级
    minSuccessRate: 0.98,
    minUndoCount: 20,
    minNoDowngradeDays: 14,
  },
];

// ═══════════════════════════════════════════════════════════════
// 渐进自动化管理器
// ═══════════════════════════════════════════════════════════════

/** P2-1: Per-Agent 自动化状态 */
interface AgentAutomationState {
  level: AutomationLevel;
  actionHistory: AutomationAction[];
  levelChanges: LevelChange[];
  firstUseAt: Date;
  lastDowngradeAt?: Date;
  lastUpgradeCheck: Date;
}

export class ProgressiveAutomation {
  // 全局默认状态（向后兼容：无 agentId 时使用）
  private level: AutomationLevel;
  private config: ProgressiveAutomationConfig;
  private actionHistory: AutomationAction[] = [];
  private levelChanges: LevelChange[] = [];
  private firstUseAt: Date;
  private lastDowngradeAt?: Date;
  private lastUpgradeCheck: Date = new Date(0);

  // P2-1: Per-Agent 级别存储（按 Agent 角色差异化信任级别）
  private agentStates: Map<string, AgentAutomationState> = new Map();

  constructor(config?: Partial<ProgressiveAutomationConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.level = this.config.initialLevel;
    this.firstUseAt = new Date();
  }

  // ─── Per-Agent 状态管理 ─────────────────────────────────

  /**
   * 获取指定 Agent 的状态（不存在则自动创建）。
   */
  private getAgentState(agentId: string): AgentAutomationState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = {
        level: this.config.initialLevel,
        actionHistory: [],
        levelChanges: [],
        firstUseAt: new Date(),
        lastUpgradeCheck: new Date(0),
      };
      this.agentStates.set(agentId, state);
    }
    return state;
  }

  /**
   * 获取指定 Agent 的当前自动化级别。
   * 无 agentId 时使用全局默认状态（向后兼容）。
   */
  getCurrentLevel(agentId?: string): AutomationLevel {
    if (agentId) {
      return this.getAgentState(agentId).level;
    }
    return this.level;
  }

  /**
   * 获取当前级别定义（支持 per-Agent）。
   */
  getCurrentLevelDef(agentId?: string): LevelDefinition {
    return AUTOMATION_LEVELS[this.getCurrentLevel(agentId)];
  }

  /**
   * 获取当前级别（向后兼容 getter）。
   */
  get currentLevel(): AutomationLevel {
    return this.getCurrentLevel();
  }

  /**
   * 获取当前级别定义（向后兼容 getter）。
   */
  get currentLevelDef(): LevelDefinition {
    return this.getCurrentLevelDef();
  }

  /**
   * 记录一次自动化操作（支持 per-Agent）。
   *
   * @param params.type 操作类型
   * @param params.description 操作描述
   * @param params.success 是否成功
   * @param params.undoneByUser 是否被用户撤销
   * @param params.agentId 关联的 Agent ID（P2-1: per-Agent 级别）
   */
  recordAction(params: {
    type: string;
    description: string;
    success: boolean;
    undoneByUser?: boolean;
    /** P2-1: 关联的 Agent ID */
    agentId?: string;
  }): AutomationAction {
    const isSafetyCritical = this.isSafetyCritical(params.description);

    const action: AutomationAction = {
      id: `act_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      type: params.type,
      description: params.description,
      success: params.success,
      undoneByUser: params.undoneByUser ?? false,
      timestamp: new Date(),
      levelAt: params.agentId ? this.getAgentState(params.agentId).level : this.level,
      isSafetyCritical,
    };

    if (params.agentId) {
      // Per-Agent 模式
      const state = this.getAgentState(params.agentId);
      state.actionHistory.push(action);
      while (state.actionHistory.length > this.config.maxActionHistory) {
        state.actionHistory.shift();
      }
      this.checkAutoUpgradeForAgent(params.agentId);
    } else {
      // 全局模式（向后兼容）
      this.actionHistory.push(action);
      while (this.actionHistory.length > this.config.maxActionHistory) {
        this.actionHistory.shift();
      }
      this.checkAutoUpgrade();
    }

    return action;
  }

  /**
   * 用户手动撤销一个操作。
   */
  undoLastAction(): boolean {
    const lastAction = this.actionHistory
      .filter(a => !a.undoneByUser)
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())[0];

    if (!lastAction) return false;

    lastAction.undoneByUser = true;
    logger.info({ actionId: lastAction.id, type: lastAction.type }, "Action undone by user");
    return true;
  }

  /**
   * 手动设置自动化级别（支持 per-Agent）。
   *
   * @param newLevel 目标级别
   * @param reason 变更原因
   * @param agentId 目标 Agent ID（P2-1: per-Agent 级别）
   */
  setLevel(newLevel: AutomationLevel, reason: string, agentId?: string): void {
    if (agentId) {
      const state = this.getAgentState(agentId);
      if (newLevel === state.level) return;

      const change: LevelChange = {
        from: state.level,
        to: newLevel,
        reason,
        timestamp: new Date(),
        source: "manual",
      };

      state.level = newLevel;
      state.levelChanges.push(change);

      if (newLevel < change.from) {
        state.lastDowngradeAt = new Date();
      }

      logger.info(
        { agentId, from: change.from, to: change.to, reason },
        "Agent automation level manually changed",
      );
      return;
    }

    // 全局模式（向后兼容）
    if (newLevel === this.level) return;

    const change: LevelChange = {
      from: this.level,
      to: newLevel,
      reason,
      timestamp: new Date(),
      source: "manual",
    };

    this.level = newLevel;
    this.levelChanges.push(change);

    if (newLevel < this.level) {
      this.lastDowngradeAt = new Date();
    }

    logger.info(
      { from: change.from, to: change.to, reason },
      "Automation level manually changed",
    );
  }

  /**
   * 获取推荐的可升级级别。
   */
  getRecommendedLevel(): AutomationLevel | null {
    const daysSinceFirstUse = (Date.now() - this.firstUseAt.getTime()) / (24 * 60 * 60 * 1000);

    for (let targetLevel = (this.level + 1) as AutomationLevel; targetLevel <= this.config.maxAutoLevel; targetLevel++) {
      const def = AUTOMATION_LEVELS[targetLevel];

      // 检查使用天数
      if (daysSinceFirstUse < def.minDaysToUpgrade) continue;

      // 检查成功率
      const successRate = this.getSuccessRate(targetLevel);
      if (successRate < def.minSuccessRate) continue;

      // 检查未撤销操作数
      const undoCount = this.getUndoCount(targetLevel);
      if (undoCount < def.minUndoCount) continue;

      // 检查是否在降级冷静期
      if (this.lastDowngradeAt) {
        const daysSinceDowngrade = (Date.now() - this.lastDowngradeAt.getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceDowngrade < def.minNoDowngradeDays) continue;
      }

      return targetLevel;
    }

    return null;
  }

  /**
   * 判断一个操作在当前级别下是否需要用户确认（支持 per-Agent）。
   *
   * @param actionDescription 操作描述
   * @param agentId 关联的 Agent ID（P2-1: per-Agent 级别）
   */
  requiresConfirmation(actionDescription: string, agentId?: string): boolean {
    const current = agentId ? this.getAgentState(agentId).level : this.level;

    // 安全关键操作始终需要确认（L2 以上）
    if (this.isSafetyCritical(actionDescription)) {
      return current < 2;
    }

    // 按级别判断
    switch (current) {
      case 0: return true;   // 完全手动：全部确认
      case 1: return true;   // 建议模式：选择后确认
      case 2: return true;   // 确认模式：执行前确认
      case 3: return false;  // 通知模式：不阻塞
      case 4: return false;  // 静默模式：不通知
      case 5: return false;  // 全自主：无需确认
      default: return true;
    }
  }

  /**
   * 判断一个操作在当前级别下是否需要通知用户。
   */
  requiresNotification(): boolean {
    return this.level <= 3;
  }

  /**
   * 判断操作是否安全关键。
   */
  private isSafetyCritical(actionDescription: string): boolean {
    const desc = actionDescription.toLowerCase();
    return this.config.safetyCriticalPatterns.some(p => desc.includes(p.toLowerCase()));
  }

  // ─── 统计方法 ──────────────────────────────────────────

  /**
   * 计算当前级别的成功率。
   */
  getSuccessRate(level?: AutomationLevel): number {
    const actions = level !== undefined
      ? this.actionHistory.filter(a => a.levelAt === level)
      : this.actionHistory;

    if (actions.length === 0) return 1;

    const successful = actions.filter(a => a.success).length;
    return parseFloat((successful / actions.length).toFixed(2));
  }

  /**
   * 获取未撤销操作数。
   */
  getUndoCount(level?: AutomationLevel): number {
    const actions = level !== undefined
      ? this.actionHistory.filter(a => a.levelAt === level)
      : this.actionHistory;

    return actions.filter(a => !a.undoneByUser).length;
  }

  /**
   * 获取使用天数。
   */
  get daysSinceFirstUse(): number {
    return (Date.now() - this.firstUseAt.getTime()) / (24 * 60 * 60 * 1000);
  }

  /**
   * 获取降级后天数。
   */
  get daysSinceDowngrade(): number | null {
    if (!this.lastDowngradeAt) return null;
    return (Date.now() - this.lastDowngradeAt.getTime()) / (24 * 60 * 60 * 1000);
  }

  // ─── 自动升级 ──────────────────────────────────────────

  /**
   * 检查并可自动升级（全局模式）。
   */
  private checkAutoUpgrade(): void {
    const now = Date.now();
    if (now - this.lastUpgradeCheck.getTime() < this.config.upgradeCheckInterval) return;

    this.lastUpgradeCheck = new Date();

    const recommended = this.getRecommendedLevel();
    if (recommended !== null && recommended > this.level) {
      const oldLevel = this.level;
      this.level = recommended;
      this.levelChanges.push({
        from: oldLevel,
        to: recommended,
        reason: `满足升级条件：成功率 ${this.getSuccessRate(recommended)} >= ${AUTOMATION_LEVELS[recommended].minSuccessRate}`,
        timestamp: new Date(),
        source: "auto",
      });

      logger.info(
        { from: oldLevel, to: recommended },
        "Automation level auto-upgraded",
      );
    }
  }

  /**
   * P2-1: 检查并自动升级指定 Agent。
   */
  private checkAutoUpgradeForAgent(agentId: string): void {
    const state = this.getAgentState(agentId);
    const now = Date.now();
    if (now - state.lastUpgradeCheck.getTime() < this.config.upgradeCheckInterval) return;

    state.lastUpgradeCheck = new Date();

    const recommended = this.getRecommendedLevelForAgent(agentId);
    if (recommended !== null && recommended > state.level) {
      const oldLevel = state.level;
      state.level = recommended;
      state.levelChanges.push({
        from: oldLevel,
        to: recommended,
        reason: `Agent ${agentId} 满足升级条件：成功率 ${this.getSuccessRateForAgent(agentId, recommended)} >= ${AUTOMATION_LEVELS[recommended].minSuccessRate}`,
        timestamp: new Date(),
        source: "auto",
      });

      logger.info(
        { agentId, from: oldLevel, to: recommended },
        "Agent automation level auto-upgraded",
      );
    }
  }

  /**
   * P2-1: 获取指定 Agent 的推荐升级级别。
   */
  private getRecommendedLevelForAgent(agentId: string): AutomationLevel | null {
    const state = this.getAgentState(agentId);
    const daysSinceFirstUse = (Date.now() - state.firstUseAt.getTime()) / (24 * 60 * 60 * 1000);

    for (let targetLevel = (state.level + 1) as AutomationLevel; targetLevel <= this.config.maxAutoLevel; targetLevel++) {
      const def = AUTOMATION_LEVELS[targetLevel];

      if (daysSinceFirstUse < def.minDaysToUpgrade) continue;

      const successRate = this.getSuccessRateForAgent(agentId, targetLevel);
      if (successRate < def.minSuccessRate) continue;

      const undoCount = this.getUndoCountForAgent(agentId, targetLevel);
      if (undoCount < def.minUndoCount) continue;

      if (state.lastDowngradeAt) {
        const daysSinceDowngrade = (Date.now() - state.lastDowngradeAt.getTime()) / (24 * 60 * 60 * 1000);
        if (daysSinceDowngrade < def.minNoDowngradeDays) continue;
      }

      return targetLevel;
    }

    return null;
  }

  /**
   * P2-1: 计算指定 Agent 在指定级别的成功率。
   */
  getSuccessRateForAgent(agentId: string, level?: AutomationLevel): number {
    const state = this.getAgentState(agentId);
    const actions = level !== undefined
      ? state.actionHistory.filter(a => a.levelAt === level)
      : state.actionHistory;

    if (actions.length === 0) return 1;

    const successful = actions.filter(a => a.success).length;
    return parseFloat((successful / actions.length).toFixed(2));
  }

  /**
   * P2-1: 获取指定 Agent 的未撤销操作数。
   */
  getUndoCountForAgent(agentId: string, level?: AutomationLevel): number {
    const state = this.getAgentState(agentId);
    const actions = level !== undefined
      ? state.actionHistory.filter(a => a.levelAt === level)
      : state.actionHistory;

    return actions.filter(a => !a.undoneByUser).length;
  }

  // ─── 报告 ──────────────────────────────────────────────

  /**
   * 生成自动化状态报告。
   */
  generateReport(): {
    currentLevel: LevelDefinition;
    daysSinceFirstUse: number;
    successRate: number;
    undoCount: number;
    totalActions: number;
    nextLevel?: LevelDefinition;
    readyForUpgrade: boolean;
    recentActions: AutomationAction[];
    levelHistory: LevelChange[];
  } {
    const recommended = this.getRecommendedLevel();
    const nextLevel = recommended !== null ? AUTOMATION_LEVELS[recommended] : undefined;

    return {
      currentLevel: this.currentLevelDef,
      daysSinceFirstUse: Math.floor(this.daysSinceFirstUse),
      successRate: this.getSuccessRate(),
      undoCount: this.getUndoCount(),
      totalActions: this.actionHistory.length,
      nextLevel,
      readyForUpgrade: recommended !== null,
      recentActions: this.actionHistory.slice(-10).reverse(),
      levelHistory: [...this.levelChanges].reverse(),
    };
  }

  /**
   * 格式化报告为可读文本。
   */
  formatReport(): string {
    const report = this.generateReport();
    const lines: string[] = [
      "## 自动化状态报告",
      "",
      `**当前级别**: L${report.currentLevel.level} — ${report.currentLevel.name}`,
      `**当前行为**: ${report.currentLevel.behavior}`,
      `**使用天数**: ${report.daysSinceFirstUse} 天`,
      `**成功率**: ${(report.successRate * 100).toFixed(0)}%`,
      `**未撤销操作**: ${report.undoCount} 次`,
      `**总操作数**: ${report.totalActions}`,
      "",
    ];

    if (report.readyForUpgrade && report.nextLevel) {
      lines.push("### 可升级");
      lines.push(`建议升级到 **L${report.nextLevel.level} — ${report.nextLevel.name}**`);
      lines.push(`升级后行为: ${report.nextLevel.behavior}`);
      lines.push("");
    }

    if (report.levelHistory.length > 0) {
      lines.push("### 级别变更历史");
      for (const change of report.levelHistory.slice(0, 5)) {
        const direction = change.to > change.from ? "↑" : "↓";
        lines.push(`- ${direction} L${change.from} → L${change.to}: ${change.reason} (${change.source})`);
      }
      lines.push("");
    }

    if (report.recentActions.length > 0) {
      lines.push("### 最近操作");
      for (const action of report.recentActions.slice(0, 5)) {
        const status = action.success ? "✅" : "❌";
        const undone = action.undoneByUser ? " [已撤销]" : "";
        const critical = action.isSafetyCritical ? " [安全关键]" : "";
        lines.push(`- ${status} ${action.description}${undone}${critical}`);
      }
    }

    return lines.join("\n");
  }

  /**
   * 重置自动化状态。
   */
  reset(): void {
    this.level = 0;
    this.actionHistory = [];
    this.levelChanges = [];
    this.firstUseAt = new Date();
    this.lastDowngradeAt = undefined;
    this.lastUpgradeCheck = new Date(0);

    this.levelChanges.push({
      from: 0,
      to: 0,
      reason: "状态重置",
      timestamp: new Date(),
      source: "manual",
    });

    logger.info("Progressive automation state reset");
  }
}
