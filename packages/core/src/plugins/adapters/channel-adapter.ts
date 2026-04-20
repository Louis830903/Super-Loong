/**
 * Channel 适配器 — 将 IM Gateway ChannelPlugin 配置桥接为插件
 *
 * 兼容性保证：
 * - 现有 12 Protocol 接口完全不变
 * - ChannelRegistry 不受影响
 * - 通过此适配器，外部渠道适配器可注册为插件
 */

import type { SuperAgentPlugin, PluginApi, PluginManifest, ChannelPluginConfig } from "../types.js";

/**
 * 将渠道配置包装为 SuperAgentPlugin。
 *
 * 用法：
 * ```typescript
 * const channelConfig: ChannelPluginConfig = {
 *   id: "my-chat",
 *   label: "My Chat Platform",
 *   capabilities: { dm: true, group: true },
 *   configSchema: { ... },
 * };
 * const plugin = createChannelPlugin(channelConfig);
 * registry.register(plugin);
 * ```
 */
export function createChannelPlugin(
  channel: ChannelPluginConfig,
  options?: {
    version?: string;
    description?: string;
    author?: string;
  },
): SuperAgentPlugin {
  const manifest: PluginManifest = {
    name: `channel-${channel.id}`,
    version: options?.version ?? "1.0.0",
    description: options?.description ?? `Channel adapter for ${channel.label}`,
    author: options?.author,
    capabilities: ["channel"],
  };

  return {
    manifest,
    register(api: PluginApi) {
      api.registerChannel(channel);
    },
  };
}
