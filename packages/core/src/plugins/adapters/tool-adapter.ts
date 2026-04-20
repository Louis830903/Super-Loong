/**
 * Tool 适配器 — 将现有 ToolDefinition 数组桥接为插件
 *
 * 兼容性保证：
 * - 现有 ToolDefinition 接口完全不变
 * - 三级加载逻辑不受影响
 * - 通过此适配器，外部工具包可注册为插件
 */

import type { SuperAgentPlugin, PluginApi, PluginManifest } from "../types.js";
import type { ToolDefinition } from "../../types/index.js";

/**
 * 将一组 ToolDefinition 包装为 SuperAgentPlugin。
 *
 * 用法：
 * ```typescript
 * const myTools: ToolDefinition[] = [tool1, tool2];
 * const plugin = createToolPlugin("my-tools", myTools);
 * registry.register(plugin);
 * ```
 */
export function createToolPlugin(
  name: string,
  tools: ToolDefinition[],
  options?: {
    version?: string;
    description?: string;
    author?: string;
  },
): SuperAgentPlugin {
  const manifest: PluginManifest = {
    name,
    version: options?.version ?? "1.0.0",
    description: options?.description ?? `Tool plugin providing ${tools.length} tools`,
    author: options?.author,
    capabilities: ["tool"],
  };

  return {
    manifest,
    register(api: PluginApi) {
      for (const tool of tools) {
        api.registerTool(tool);
      }
    },
  };
}
