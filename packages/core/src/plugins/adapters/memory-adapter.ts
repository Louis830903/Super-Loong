/**
 * Memory 适配器 — 将现有 IMemoryProvider 桥接为插件
 *
 * 兼容性保证：
 * - MemoryProviderOrchestrator 逻辑完全不变
 * - 现有 IMemoryProvider 实现无需修改
 * - 通过此适配器，外部 memory provider 可同时注册为插件
 */

import type { SuperAgentPlugin, PluginApi, PluginManifest } from "../types.js";
import type { IMemoryProvider } from "../../memory/provider.js";

/**
 * 将现有 IMemoryProvider 包装为 SuperAgentPlugin。
 *
 * 用法：
 * ```typescript
 * const myProvider: IMemoryProvider = new MyCustomMemory();
 * const plugin = createMemoryPlugin(myProvider);
 * registry.register(plugin);
 * ```
 */
export function createMemoryPlugin(provider: IMemoryProvider): SuperAgentPlugin {
  const manifest: PluginManifest = {
    name: `memory-${provider.name}`,
    version: "1.0.0",
    description: `Memory provider adapter for ${provider.name}`,
    capabilities: ["memory"],
  };

  return {
    manifest,
    register(api: PluginApi) {
      api.registerMemoryProvider(provider);
    },
  };
}
