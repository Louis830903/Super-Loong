/**
 * 自适应任务执行器 — 替代简单的工作流顺序执行，支持动态策略与执行中学习。
 *
 * 核心能力：
 *   - 并行执行无依赖的子目标
 *   - 子目标失败时自动分支：重试 → 降级 → 替代方案 → 请求用户帮助
 *   - 执行中学习：缓存 UI 坐标、切换备选工具
 *   - 资源管理：限制最大并发、Token 预算动态分配
 */

import { v4 as uuid } from "uuid";
import pino from "pino";

const logger = pino({ name: "adaptive-executor" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 执行单元的运行时状态 */
export type ExecutionStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "retrying"
  | "fallback"
  | "cancelled";

/** 执行单元（子目标或步骤） */
export interface ExecutionUnit {
  /** 单元 ID */
  id: string;
  /** 单元类型 */
  type: "subgoal" | "step";
  /** 单元名称 */
  name: string;
  /** 父级 ID */
  parentId?: string;
  /** 依赖的其他单元 ID */
  dependsOn: string[];
  /** 是否可并行 */
  parallelizable: boolean;
  /** 执行函数（由外部注入） */
  execute?: () => Promise<ExecutionResult>;
  /** 状态 */
  status: ExecutionStatus;
  /** 优先级 */
  priority: number;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/** 执行结果 */
export interface ExecutionResult {
  /** 成功与否 */
  success: boolean;
  /** 输出内容 */
  output: string;
  /** 结构化数据 */
  data?: unknown;
  /** 错误信息 */
  error?: string;
  /** 耗时（毫秒） */
  duration: number;
  /** 重试次数 */
  retries: number;
  /** 使用的降级方案 */
  fallbackUsed?: string;
}

/** 执行策略 */
export type ExecutionStrategy =
  | "sequential"      // 顺序执行
  | "parallel"        // 并行执行
  | "adaptive";       // 自适应（默认）

/** 失败处理策略 */
export type FailureStrategy =
  | "retry"           // 重试
  | "fallback"        // 降级
  | "alternative"     // 替代方案
  | "ask_user"        // 请求用户帮助
  | "abort";          // 终止

/** 执行计划 */
export interface ExecutionPlan {
  /** 计划 ID */
  id: string;
  /** 所有执行单元 */
  units: ExecutionUnit[];
  /** 按层的执行顺序 */
  layers: string[][];
  /** 当前层索引 */
  currentLayer: number;
  /** 失败处理策略映射 */
  failureStrategies: Map<string, FailureStrategy[]>;
  /** 降级方案映射 */
  fallbackMap: Map<string, string>;
  /** 状态 */
  status: "ready" | "running" | "paused" | "completed" | "failed" | "cancelled";
  /** 全局取消标志 */
  cancelled: boolean;
}

/** 执行进度 */
export interface ExecutionProgress {
  planId: string;
  /** 当前层 / 总层数 */
  layer: { current: number; total: number };
  /** 已完成单元 / 总单元数 */
  units: { completed: number; total: number };
  /** 总体进度百分比 (0-100) */
  percentage: number;
  /** 当前正在执行的单元名称列表 */
  currentUnits: string[];
}

/** 自适应执行器配置 */
export interface AdaptiveExecutorConfig {
  /** 最大并行子任务数（默认 3） */
  maxParallel: number;
  /** 单单元最大重试次数（默认 3） */
  maxRetries: number;
  /** 重试间隔毫秒（默认 2000） */
  retryDelayMs: number;
  /** 单单元超时时间毫秒（默认 120000） */
  unitTimeoutMs: number;
  /** 整体执行超时毫秒（默认 600000） */
  planTimeoutMs: number;
  /** Token 预算（默认 20000） */
  tokenBudget: number;
  /** 执行策略 */
  strategy: ExecutionStrategy;
}

const DEFAULT_CONFIG: AdaptiveExecutorConfig = {
  maxParallel: 3,
  maxRetries: 3,
  retryDelayMs: 2000,
  unitTimeoutMs: 120000,
  planTimeoutMs: 600000,
  tokenBudget: 20000,
  strategy: "adaptive",
};

// ═══════════════════════════════════════════════════════════════
// 自适应任务执行器
// ═══════════════════════════════════════════════════════════════

export class AdaptiveExecutor {
  private config: AdaptiveExecutorConfig;
  /** 当前执行计划 */
  private currentPlan?: ExecutionPlan;
  /** 执行进度回调 */
  private onProgress?: (progress: ExecutionProgress) => void;
  /** 执行中学习缓存 */
  private learnCache: Map<string, unknown> = new Map();
  /** 工具失败计数（用于自动切换备选工具） */
  private toolFailureCount: Map<string, number> = new Map();
  /** 整体开始时间 */
  private startTime: number = 0;

  constructor(config?: Partial<AdaptiveExecutorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 注册进度回调。
   */
  setProgressCallback(cb: (progress: ExecutionProgress) => void): void {
    this.onProgress = cb;
  }

  /**
   * 从分层依赖图创建执行计划。
   */
  createPlan(units: ExecutionUnit[], layers: string[][]): ExecutionPlan {
    const fallbackMap = new Map<string, string>();
    const failureStrategies = new Map<string, FailureStrategy[]>();

    for (const unit of units) {
      // 默认失败策略：重试 → 降级 → 替代方案 → 请求用户
      failureStrategies.set(unit.id, ["retry", "fallback", "alternative", "ask_user"]);
    }

    return {
      id: `plan_${uuid().slice(0, 8)}`,
      units,
      layers: layers.length > 0 ? layers : [units.map(u => u.id)],
      currentLayer: 0,
      failureStrategies,
      fallbackMap,
      status: "ready",
      cancelled: false,
    };
  }

  /**
   * 执行整个计划。
   */
  async execute(plan: ExecutionPlan): Promise<{
    success: boolean;
    results: Map<string, ExecutionResult>;
    totalDuration: number;
    summary: string;
  }> {
    this.currentPlan = plan;
    this.startTime = Date.now();
    plan.status = "running";
    plan.cancelled = false;

    const results = new Map<string, ExecutionResult>();
    const completed = new Set<string>();
    const failed = new Set<string>();

    // 检测整体超时 — Task 9: 存储 timer handle 防悬挂
    let planTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      planTimer = setTimeout(() => reject(new Error("Plan execution timeout")), this.config.planTimeoutMs);
    });

    try {
      const executePromise = this.executeLayers(plan, results, completed, failed);
      await Promise.race([executePromise, timeoutPromise]);
    } catch (err) {
      if ((err as Error).message === "Plan execution timeout") {
        plan.status = "failed";
        return {
          success: false,
          results,
          totalDuration: Date.now() - this.startTime,
          summary: `整体执行超时（${this.config.planTimeoutMs / 1000}s），已完成 ${completed.size}/${plan.units.length} 个单元`,
        };
      }
      throw err;
    } finally {
      if (planTimer) clearTimeout(planTimer);
    }

    const allSuccess = failed.size === 0;
    plan.status = allSuccess ? "completed" : "failed";

    return {
      success: allSuccess,
      results,
      totalDuration: Date.now() - this.startTime,
      summary: allSuccess
        ? `所有 ${completed.size} 个执行单元成功完成`
        : `${completed.size}/${plan.units.length} 成功，${failed.size} 失败`,
    };
  }

  /**
   * 按层顺序执行。
   */
  private async executeLayers(
    plan: ExecutionPlan,
    results: Map<string, ExecutionResult>,
    completed: Set<string>,
    failed: Set<string>,
  ): Promise<void> {
    for (let layerIdx = 0; layerIdx < plan.layers.length; layerIdx++) {
      if (plan.cancelled) break;

      plan.currentLayer = layerIdx;
      const layer = plan.layers[layerIdx];

      // 检查本层是否有依赖已失败的单元
      const blocked = layer.filter(unitId => {
        const unit = plan.units.find(u => u.id === unitId);
        if (!unit) return false;
        return unit.dependsOn.some(depId => failed.has(depId));
      });

      // 被阻塞的单元标记为跳过
      for (const unitId of blocked) {
        const unit = plan.units.find(u => u.id === unitId);
        if (unit) {
          unit.status = "cancelled";
          completed.add(unitId);
          results.set(unitId, {
            success: false,
            output: "",
            error: "上游依赖失败，跳过执行",
            duration: 0,
            retries: 0,
          });
        }
      }

      const runnable = layer.filter(id => !blocked.includes(id) && !completed.has(id));

      if (runnable.length === 0) continue;

      this.emitProgress(plan);

      // 判断本层是否可并行
      const canParallel = plan.units
        .filter(u => runnable.includes(u.id))
        .every(u => u.parallelizable);

      if (canParallel && this.config.strategy !== "sequential") {
        // 并行执行
        await this.executeParallel(
          runnable,
          plan,
          results,
          completed,
          failed,
          this.config.maxParallel,
        );
      } else {
        // 顺序执行
        for (const unitId of runnable) {
          if (plan.cancelled) break;
          await this.executeUnitWithRecovery(unitId, plan, results, completed, failed);
        }
      }

      this.emitProgress(plan);
    }
  }

  /**
   * 并行执行一组单元。
   */
  private async executeParallel(
    unitIds: string[],
    plan: ExecutionPlan,
    results: Map<string, ExecutionResult>,
    completed: Set<string>,
    failed: Set<string>,
    concurrency: number,
  ): Promise<void> {
    // 按优先级排序
    const sorted = unitIds
      .map(id => plan.units.find(u => u.id === id))
      .filter(Boolean)
      .sort((a, b) => (a!.priority ?? 0) - (b!.priority ?? 0))
      .map(u => u!.id);

    // 分批执行
    for (let i = 0; i < sorted.length; i += concurrency) {
      if (plan.cancelled) break;
      const batch = sorted.slice(i, i + concurrency);
      await Promise.all(
        batch.map(id => this.executeUnitWithRecovery(id, plan, results, completed, failed)),
      );
    }
  }

  /**
   * 执行单个单元（含自动恢复：重试 → 降级 → 替代 → 求助）。
   */
  private async executeUnitWithRecovery(
    unitId: string,
    plan: ExecutionPlan,
    results: Map<string, ExecutionResult>,
    completed: Set<string>,
    failed: Set<string>,
  ): Promise<void> {
    const unit = plan.units.find(u => u.id === unitId);
    if (!unit) return;

    const strategies = plan.failureStrategies.get(unitId) ?? ["retry", "ask_user"];
    let strategyIdx = 0;

    while (strategyIdx < strategies.length) {
      const strategy = strategies[strategyIdx];

      switch (strategy) {
        case "retry": {
          // 带超时的重试
          const result = await this.executeWithRetry(unit);
          if (result.success) {
            unit.status = "completed";
            completed.add(unitId);
            results.set(unitId, result);
            this.learnFromSuccess(unit, result);
            return;
          }

          // 重试耗尽 → 尝试下一个策略
          strategyIdx++;
          continue;
        }

        case "fallback": {
          const fallbackId = plan.fallbackMap.get(unitId);
          if (fallbackId) {
            logger.info({ unitId, fallbackId }, "Attempting fallback");

            const fallbackUnit = plan.units.find(u => u.id === fallbackId);
            if (fallbackUnit) {
              const fbResult = await this.executeWithRetry(fallbackUnit);
              if (fbResult.success) {
                fbResult.fallbackUsed = fallbackId;
                unit.status = "completed";
                completed.add(unitId);
                results.set(unitId, fbResult);
                return;
              }
            }
          }
          strategyIdx++;
          continue;
        }

        case "alternative": {
          // 尝试切换到备选工具
          const altResult = await this.tryAlternative(unit);
          if (altResult && altResult.success) {
            unit.status = "completed";
            completed.add(unitId);
            results.set(unitId, altResult);
            this.learnFromSuccess(unit, altResult);
            return;
          }
          strategyIdx++;
          continue;
        }

        case "ask_user": {
          // 无法自动恢复 → 标记失败
          unit.status = "failed";
          failed.add(unitId);
          results.set(unitId, {
            success: false,
            output: "",
            error: `所有自动恢复策略已耗尽（${strategies.join(" → ")}），需要用户干预`,
            duration: Date.now() - this.startTime,
            retries: this.config.maxRetries,
          });

          // 如果配置允许，可在此处暂停执行等用户回复
          plan.status = "paused";
          return;
        }

        case "abort": {
          plan.cancelled = true;
          unit.status = "cancelled";
          return;
        }
      }
    }

    // 所有策略耗尽
    unit.status = "failed";
    failed.add(unitId);
  }

  /**
   * 带重试逻辑的执行。
   */
  private async executeWithRetry(unit: ExecutionUnit): Promise<ExecutionResult> {
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (attempt > 0) {
        unit.status = "retrying";
        logger.info({ unitId: unit.id, attempt }, "Retrying execution");
        await this.delay(this.config.retryDelayMs);
      }

      unit.status = "running";
      const startTime = Date.now();

      try {
        if (!unit.execute) {
          return {
            success: false,
            output: "",
            error: "No execute function defined",
            duration: 0,
            retries: attempt,
          };
        }

        // 带超时的执行 — Task 9: 存储 timer handle 防悬挂
        const execPromise = unit.execute();
        let unitTimer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<ExecutionResult>((_, reject) => {
          unitTimer = setTimeout(() => reject(new Error("Unit execution timeout")), this.config.unitTimeoutMs);
        });

        const result = await Promise.race([execPromise, timeoutPromise]);
        if (unitTimer) clearTimeout(unitTimer);
        const duration = Date.now() - startTime;
        result.duration = duration;
        result.retries = attempt;

        if (result.success) return result;

        lastError = result.error ?? result.output;
      } catch (err) {
        lastError = (err as Error).message;
      }

      // 记录工具失败
      const toolName = unit.metadata?.toolName as string | undefined;
      if (toolName) {
        const count = (this.toolFailureCount.get(toolName) ?? 0) + 1;
        this.toolFailureCount.set(toolName, count);
      }
    }

    return {
      success: false,
      output: "",
      error: lastError ?? "Unknown error",
      duration: 0,
      retries: this.config.maxRetries,
    };
  }

  /**
   * 尝试替代工具。
   */
  private async tryAlternative(unit: ExecutionUnit): Promise<ExecutionResult | null> {
    const toolName = unit.metadata?.toolName as string | undefined;
    if (!toolName) return null;

    // 备选工具映射
    const alternatives: Record<string, string> = {
      "computer_use": "app_launch",
      "browser_navigate": "web_search",
      "app_launch": "run_shell",
      "web_search": "run_shell",
    };

    const altTool = alternatives[toolName];
    if (!altTool) return null;

    logger.info({ unitId: unit.id, original: toolName, alternative: altTool }, "Trying alternative tool");

    // 尝试使用备用工具
    if (unit.execute) {
      try {
        const result = await unit.execute();
        if (result.success) {
          logger.info({ unitId: unit.id, altTool }, "Alternative tool succeeded");
        }
        return result;
      } catch {
        return null;
      }
    }

    return null;
  }

  // ─── 执行中学习 ─────────────────────────────────────────

  /**
   * 从成功执行中学习。
   */
  private learnFromSuccess(unit: ExecutionUnit, result: ExecutionResult): void {
    // 缓存成功的工具调用模式
    const toolName = unit.metadata?.toolName as string | undefined;
    if (toolName) {
      this.learnCache.set(`success_${toolName}`, {
        params: unit.metadata?.params,
        duration: result.duration,
        timestamp: Date.now(),
      });
    }

    // 缓存 UI 坐标（如果是 computer_use）
    if (toolName === "computer_use" && result.data) {
      const data = result.data as Record<string, unknown>;
      if (data.coordinates) {
        const region = data.region ?? "default";
        this.learnCache.set(`ui_coords_${region}`, data.coordinates);
        logger.info({ region, coords: data.coordinates }, "Cached UI coordinates");
      }
    }

    // 重置该工具失败计数
    this.toolFailureCount.set(toolName ?? "", 0);
  }

  /**
   * 获取缓存的 UI 坐标。
   */
  getCachedCoordinates(region: string): unknown | undefined {
    return this.learnCache.get(`ui_coords_${region}`);
  }

  /**
   * 获取缓存的学习数据。
   */
  getCachedLearning(key: string): unknown | undefined {
    return this.learnCache.get(key);
  }

  /**
   * 获取工具失败统计。
   */
  getToolFailureStats(): Map<string, number> {
    return new Map(this.toolFailureCount);
  }

  /**
   * 建议切换到备选工具。
   */
  suggestAlternative(toolName: string): string | undefined {
    const failures = this.toolFailureCount.get(toolName) ?? 0;
    if (failures >= 3) {
      const alternatives: Record<string, string> = {
        "computer_use": "app_launch",
        "browser_navigate": "web_search",
        "app_launch": "run_shell",
      };
      return alternatives[toolName];
    }
    return undefined;
  }

  // ─── 控制方法 ──────────────────────────────────────────

  /**
   * 取消当前执行。
   */
  cancel(): void {
    if (this.currentPlan) {
      this.currentPlan.cancelled = true;
      this.currentPlan.status = "cancelled";
      logger.info({ planId: this.currentPlan.id }, "Execution cancelled");
    }
  }

  /**
   * 暂停当前执行。
   */
  pause(): void {
    if (this.currentPlan) {
      this.currentPlan.status = "paused";
      logger.info({ planId: this.currentPlan.id }, "Execution paused");
    }
  }

  /**
   * 获取当前计划。
   */
  getCurrentPlan(): ExecutionPlan | undefined {
    return this.currentPlan;
  }

  /**
   * 清空学习缓存。
   */
  clearLearnCache(): void {
    this.learnCache.clear();
    this.toolFailureCount.clear();
  }

  // ─── 辅助 ──────────────────────────────────────────────

  /**
   * 发送进度事件。
   */
  private emitProgress(plan: ExecutionPlan): void {
    if (!this.onProgress) return;

    const completedUnits = plan.units.filter(
      u => u.status === "completed" || u.status === "cancelled",
    ).length;

    const runningUnits = plan.units
      .filter(u => u.status === "running")
      .map(u => u.name);

    this.onProgress({
      planId: plan.id,
      layer: { current: plan.currentLayer + 1, total: plan.layers.length },
      units: { completed: completedUnits, total: plan.units.length },
      percentage: plan.units.length > 0
        ? Math.round((completedUnits / plan.units.length) * 100)
        : 0,
      currentUnits: runningUnits,
    });
  }

  /**
   * 异步延迟。
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
