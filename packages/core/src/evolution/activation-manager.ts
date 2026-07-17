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

export class ActivationManager {
  private steps: ActivationStep[] = [
    { module: "ToolGenerator", phase: 1, dependencies: [], activated: false },
    { module: "ToolRegistrar", phase: 1, dependencies: ["ToolGenerator"], activated: false },
    { module: "CapabilityGapDetector", phase: 2, dependencies: [], activated: false },
    { module: "AutoLearner", phase: 2, dependencies: ["CapabilityGapDetector", "ToolDiscoverer"], activated: false },
    { module: "ToolDiscoverer", phase: 3, dependencies: [], activated: false },
    { module: "IntentLearner", phase: 4, dependencies: [], activated: false },
    { module: "IntentDecomposer", phase: 4, dependencies: ["IntentLearner"], activated: false },
    { module: "AdaptiveExecutor", phase: 5, dependencies: ["IntentDecomposer"], activated: false },
  ];

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

  private async doActivate(moduleName: string): Promise<void> {
    // 实际激活逻辑（依赖注入、初始化等）
    logger.info({ module: moduleName }, "Activating module");
    // TODO: 实现具体激活逻辑
  }

  private async doRollback(moduleName: string): Promise<void> {
    // 实际回滚逻辑
    logger.info({ module: moduleName }, "Rolling back module");
    // TODO: 实现具体回滚逻辑
  }
}
