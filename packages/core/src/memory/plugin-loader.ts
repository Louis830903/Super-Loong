/**
 * 记忆系统插件发现与加载器。
 *
 * 支持配置驱动的动态 Provider 加载，学 Hermes plugins/memory/__init__.py 的发现模式。
 * 用户通过 AgentConfig.memoryPlugins 声明要加载的 Provider，
 * 运行时自动 import 并注册到 MemoryProviderOrchestrator。
 */

import type { IMemoryProvider } from "./provider.js";
import type { MemoryProviderOrchestrator } from "./provider.js";

// ─── 插件配置接口 ───────────────────────────────────────────

export interface MemoryPluginConfig {
  /** Provider 名称（如 "graphiti", "mem0"） */
  name: string;
  /** 模块路径（npm 包名或相对路径） */
  module: string;
  /** Provider 构造函数导出名（默认 "default"） */
  exportName?: string;
  /** Provider 配置对象 */
  config?: Record<string, unknown>;
  /** 是否启用（默认 true） */
  enabled?: boolean;
}

// ─── 加载器 ─────────────────────────────────────────────────

/**
 * 按配置加载记忆 Provider 插件并注册到编排器。
 * 每个插件通过 dynamic import 加载，失败时仅记录警告不中断启动。
 */
export async function loadMemoryPlugins(
  plugins: MemoryPluginConfig[],
  orchestrator: MemoryProviderOrchestrator,
): Promise<void> {
  for (const plugin of plugins) {
    if (plugin.enabled === false) {
      console.log(`[MemoryPluginLoader] Skipped disabled plugin: ${plugin.name}`);
      continue;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod: any = await import(plugin.module);
      const ProviderClass = mod[plugin.exportName ?? "default"];

      if (!ProviderClass) {
        console.warn(
          `[MemoryPluginLoader] Plugin '${plugin.name}' — export '${plugin.exportName ?? "default"}' not found in '${plugin.module}'`,
        );
        continue;
      }

      const provider: IMemoryProvider = new ProviderClass(plugin.config ?? {});
      orchestrator.addProvider(provider);
      console.log(`[MemoryPluginLoader] Loaded provider: ${plugin.name}`);
    } catch (err) {
      // 插件加载失败不中断系统启动
      console.error(
        `[MemoryPluginLoader] Failed to load '${plugin.name}' from '${plugin.module}':`,
        err,
      );
    }
  }
}
