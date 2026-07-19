/**
 * 孤岛模块激活管理器 — 分阶段激活未使用的进化模块
 *
 * 优化：
 * 1. 依赖关系图
 * 2. 激活检查清单
 * 3. 回滚方案
 */

import pino from "pino";

const logger = pino({ name: "activation-manager" });

export interface ActivationStep {
  module: string;
  phase: number;
  dependencies: string[];
  activated: boolean;
  activatedAt?: Date;
  error?: string;
}

/**
 * P1-3: 模块激活钩子——由 EvolutionEngine 注入，使"激活/回滚"真正改变引擎行为，
 * 而非仅打日志。例如激活 ToolGenerator → 打开 P1-2 工具提案生成开关。
 */
export interface ModuleActivationHook {
  /** 激活时调用（打开对应能力开关 / 绑定监听） */
  activate?: () => void;
  /** 回滚时调用（关闭开关 / 解绑监听 / 清理资源） */
  deactivate?: () => void;
}

export class ActivationManager {
  /**
   * 激活步骤 + 依赖拓扑（严格按 Spec §十）：
   *   Stage 1（基础感知）：CapabilityGapDetector    ← 无依赖，最先
   *   Stage 2（工具生成）：ToolGenerator, ToolRegistrar ← 依赖 Stage 1
   *   Stage 3（自主学习）：ToolDiscoverer → AutoLearner ← AutoLearner 依赖 GapDetector + ToolDiscoverer
   *   Stage 4/5（意图/自适应）：IntentLearner → IntentDecomposer → AdaptiveExecutor
   */
  private steps: ActivationStep[] = [
    { module: "CapabilityGapDetector", phase: 1, dependencies: [], activated: false },
    { module: "ToolGenerator", phase: 2, dependencies: ["CapabilityGapDetector"], activated: false },
    { module: "ToolRegistrar", phase: 2, dependencies: ["ToolGenerator"], activated: false },
    { module: "ToolDiscoverer", phase: 3, dependencies: ["CapabilityGapDetector"], activated: false },
    { module: "AutoLearner", phase: 3, dependencies: ["CapabilityGapDetector", "ToolDiscoverer"], activated: false },
    { module: "IntentLearner", phase: 4, dependencies: [], activated: false },
    { module: "IntentDecomposer", phase: 4, dependencies: ["IntentLearner"], activated: false },
    { module: "AdaptiveExecutor", phase: 5, dependencies: ["IntentDecomposer"], activated: false },
  ];

  /** P1-3: 各模块的激活/回滚钩子（EvolutionEngine 注入真实开关） */
  private hooks: Record<string, ModuleActivationHook> = {};

  /**
   * 获取激活顺序
   */
  getActivationOrder(): ActivationStep[] {
    return [...this.steps].sort((a, b) => a.phase - b.phase);
  }

  /**
   * 检查模块是否可激活
   */
  canActivate(moduleName: string): { can: boolean; reason?: string } {
    const step = this.steps.find(s => s.module === moduleName);
    if (!step) {
      return { can: false, reason: "Module not found" };
    }

    if (step.activated) {
      return { can: false, reason: "Already activated" };
    }

    // 检查依赖
    for (const dep of step.dependencies) {
      const depStep = this.steps.find(s => s.module === dep);
      if (!depStep?.activated) {
        return { can: false, reason: `Dependency ${dep} not activated` };
      }
    }

    return { can: true };
  }

  /**
   * 激活模块
   */
  async activate(moduleName: string): Promise<boolean> {
    const check = this.canActivate(moduleName);
    if (!check.can) {
      logger.warn({ module: moduleName, reason: check.reason }, "Cannot activate module");
      return false;
    }

    const step = this.steps.find(s => s.module === moduleName)!;

    try {
      // 执行激活逻辑
      await this.doActivate(moduleName);

      step.activated = true;
      step.activatedAt = new Date();
      logger.info({ module: moduleName }, "Module activated");
      return true;
    } catch (error) {
      step.error = error instanceof Error ? error.message : String(error);
      logger.error({ module: moduleName, error: step.error }, "Activation failed");
      return false;
    }
  }

  /**
   * 回滚模块
   */
  async rollback(moduleName: string): Promise<boolean> {
    const step = this.steps.find(s => s.module === moduleName);
    if (!step?.activated) {
      return false;
    }

    try {
      await this.doRollback(moduleName);
      step.activated = false;
      step.activatedAt = undefined;
      logger.info({ module: moduleName }, "Module rolled back");
      return true;
    } catch (error) {
      logger.error({ module: moduleName, error }, "Rollback failed");
      return false;
    }
  }

  /**
   * 获取激活状态
   */
  getStatus(): ActivationStep[] {
    return [...this.steps];
  }

  /** P1-3: 注入各模块的真实激活/回滚钩子（EvolutionEngine 装配时调用）。 */
  setHooks(hooks: Record<string, ModuleActivationHook>): void {
    this.hooks = { ...this.hooks, ...hooks };
  }

  /** 某模块当前是否处于激活状态。 */
  isActive(moduleName: string): boolean {
    return this.steps.find(s => s.module === moduleName)?.activated ?? false;
  }

  /**
   * 按 STAGE 分阶段激活（Spec §十）：
   *   0=全关 / 1=仅 GapDetector / 2=+工具生成 / 3=+自主学习 / >=4=全部。
   * 拓扑循环：每轮只激活"依赖已就绪且 phase<=maxStage"的模块，直到无法继续。
   * 依赖未就绪的模块不会被激活（严格依赖序）。
   */
  async activateStage(maxStage: number): Promise<{ activated: string[]; skipped: string[] }> {
    const activated: string[] = [];
    if (maxStage <= 0) {
      logger.info("Evolution STAGE=0 — no modules activated (zero regression)");
      return { activated, skipped: this.steps.map(s => s.module) };
    }

    let progress = true;
    while (progress) {
      progress = false;
      for (const step of this.steps) {
        if (step.activated) continue;
        if (step.phase > maxStage) continue;
        const depsReady = step.dependencies.every(d =>
          this.steps.find(s => s.module === d)?.activated,
        );
        if (!depsReady) continue;
        const ok = await this.activate(step.module);
        if (ok) {
          activated.push(step.module);
          progress = true;
        }
      }
    }

    const skipped = this.steps.filter(s => !s.activated).map(s => s.module);
    logger.info({ maxStage, activated, skipped }, "P1-3: evolution stage activation complete");
    return { activated, skipped };
  }

  private async doActivate(moduleName: string): Promise<void> {
    // P1-3: 调用注入的真实钩子（如打开 P1-2 工具提案开关）；无钩子时仅标记 enabled。
    const hook = this.hooks[moduleName];
    if (hook?.activate) {
      hook.activate();
      logger.info({ module: moduleName }, "Module activated (hook invoked)");
    } else {
      logger.info({ module: moduleName }, "Module activated (state flag only; no hook bound)");
    }
  }

  private async doRollback(moduleName: string): Promise<void> {
    // P1-3: 调用注入的解绑钩子，真正停用能力（而非仅移除标记）。
    const hook = this.hooks[moduleName];
    if (hook?.deactivate) {
      hook.deactivate();
      logger.info({ module: moduleName }, "Module rolled back (hook invoked)");
    } else {
      logger.info({ module: moduleName }, "Module rolled back (state flag only; no hook bound)");
    }
  }

  // ─── 具体模块激活逻辑 ─────────────────────────────────────

  // P1-3: 具体模块的激活现由 EvolutionEngine 注入的 hook 驱动（见 setHooks / doActivate），
  //       不再硬编码各模块的空实现。
}
