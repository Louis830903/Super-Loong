/**
 * Hook 调度器 — 管理插件生命周期钩子的注册与触发
 *
 * 参考 OpenClaw 30 个命名 Hook 的类型化系统，支持：
 * - 同步/异步 Handler
 * - 优先级排序
 * - 中断链（Handler 返回 false 可中止后续处理）
 * - 错误隔离（单个 Handler 失败不影响其他）
 */

import pino from "pino";
import type { PluginHookName, HookHandler, HookContext } from "./types.js";

const logger = pino({ name: "plugin-hooks" });

/** Hook 注册条目（附带优先级和来源） */
interface HookEntry {
  /** 所属插件名称 */
  pluginName: string;
  /** 处理器函数 */
  handler: HookHandler;
  /** 优先级（数字越小越先执行，默认 100） */
  priority: number;
}

/**
 * Hook 调度器。
 * 管理所有插件注册的 Hook，按优先级排序触发。
 */
export class HookDispatcher {
  /** Hook 名称 → 注册条目列表（按优先级排序） */
  private hooks = new Map<PluginHookName, HookEntry[]>();

  /**
   * 注册一个 Hook 处理器。
   * @param hookName - Hook 名称
   * @param pluginName - 注册此 Hook 的插件名称
   * @param handler - 处理器函数
   * @param priority - 优先级（默认 100，数字越小越先执行）
   */
  register(
    hookName: PluginHookName,
    pluginName: string,
    handler: HookHandler,
    priority = 100,
  ): void {
    const entries = this.hooks.get(hookName) ?? [];
    entries.push({ pluginName, handler, priority });
    // 按优先级排序（升序）
    entries.sort((a, b) => a.priority - b.priority);
    this.hooks.set(hookName, entries);
    logger.debug({ hook: hookName, plugin: pluginName, priority }, "Hook 已注册");
  }

  /**
   * 注销指定插件的所有 Hook。
   * @param pluginName - 插件名称
   */
  unregister(pluginName: string): void {
    for (const [hookName, entries] of this.hooks) {
      const filtered = entries.filter(e => e.pluginName !== pluginName);
      if (filtered.length === 0) {
        this.hooks.delete(hookName);
      } else {
        this.hooks.set(hookName, filtered);
      }
    }
    logger.debug({ plugin: pluginName }, "插件 Hook 已全部注销");
  }

  /**
   * 触发 Hook — 串行执行所有注册的 Handler。
   *
   * 行为模式：
   * - 每个 Handler 按优先级顺序执行
   * - Handler 可返回修改后的 payload（管道模式）
   * - Handler 抛出异常时记录日志但不中断链
   *
   * @param hookName - 要触发的 Hook 名称
   * @param context - Hook 上下文
   * @param payload - 传递给 Handler 的数据（管道模式下会被逐步修改）
   * @returns 最终的 payload（经过所有 Handler 处理后）
   */
  async dispatch(
    hookName: PluginHookName,
    context: HookContext,
    payload?: unknown,
  ): Promise<unknown> {
    const entries = this.hooks.get(hookName);
    if (!entries || entries.length === 0) return payload;

    let currentPayload = payload;

    for (const entry of entries) {
      try {
        const result = await entry.handler(context, currentPayload);
        // 如果 Handler 返回了非 undefined 值，更新 payload（管道模式）
        if (result !== undefined) {
          currentPayload = result;
        }
      } catch (err) {
        // 错误隔离：单个 Handler 失败不影响其他
        logger.error(
          { hook: hookName, plugin: entry.pluginName, err },
          "Hook 处理器执行失败，已跳过",
        );
      }
    }

    return currentPayload;
  }

  /**
   * 触发 Hook — 并行执行所有 Handler（无管道，适合通知类 Hook）。
   *
   * @param hookName - 要触发的 Hook 名称
   * @param context - Hook 上下文
   * @param payload - 传递给所有 Handler 的数据（不会被修改）
   */
  async dispatchParallel(
    hookName: PluginHookName,
    context: HookContext,
    payload?: unknown,
  ): Promise<void> {
    const entries = this.hooks.get(hookName);
    if (!entries || entries.length === 0) return;

    const results = await Promise.allSettled(
      entries.map(entry => entry.handler(context, payload)),
    );

    // 记录失败的 Handler
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        logger.error(
          { hook: hookName, plugin: entries[index].pluginName, err: result.reason },
          "Hook 处理器并行执行失败",
        );
      }
    });
  }

  /**
   * 检查某个 Hook 是否有注册的 Handler。
   */
  hasHandlers(hookName: PluginHookName): boolean {
    const entries = this.hooks.get(hookName);
    return !!entries && entries.length > 0;
  }

  /**
   * 获取所有已注册 Hook 的统计信息。
   */
  getStats(): Record<string, { count: number; plugins: string[] }> {
    const stats: Record<string, { count: number; plugins: string[] }> = {};
    for (const [hookName, entries] of this.hooks) {
      stats[hookName] = {
        count: entries.length,
        plugins: entries.map(e => e.pluginName),
      };
    }
    return stats;
  }

  /** 清空所有 Hook 注册 */
  clear(): void {
    this.hooks.clear();
  }
}
