/**
 * 插件注册表 — 全局单例，管理所有已注册插件
 *
 * 职责：
 * - 维护插件实例和元数据
 * - 按能力类型索引，快速查找特定类型插件
 * - 冲突检测（同名插件/同名工具）
 * - 提供已注册资源的聚合查询
 */

import pino from "pino";
import { HookDispatcher } from "./hooks.js";
import type {
  SuperAgentPlugin,
  PluginApi,
  PluginContext,
  PluginCapability,
  PluginHookName,
  HookHandler,
  ChannelPluginConfig,
  CommandDefinition,
  RouteDefinition,
  LoadedPluginInfo,
  PluginDiscoverySource,
} from "./types.js";
import type { ToolDefinition, LLMProviderConfig } from "../types/index.js";
import type { IMemoryProvider } from "../memory/provider.js";

const logger = pino({ name: "plugin-registry" });

/** 插件注册表内部条目 */
interface PluginEntry {
  plugin: SuperAgentPlugin;
  source: PluginDiscoverySource;
  activated: boolean;
  loadedAt: Date;
  error?: string;
}

/**
 * 全局插件注册表。
 *
 * 单例模式，管理所有已注册插件及其提供的资源。
 * 通过适配器桥接现有 IMemoryProvider、ToolDefinition、ChannelPlugin。
 */
export class PluginRegistry {
  /** 插件名称 → 注册条目 */
  private plugins = new Map<string, PluginEntry>();

  /** 插件注册的工具 */
  private registeredTools = new Map<string, { tool: ToolDefinition; pluginName: string }>();

  /** 插件注册的渠道 */
  private registeredChannels = new Map<string, { channel: ChannelPluginConfig; pluginName: string }>();

  /** 插件注册的记忆 Provider */
  private registeredMemoryProviders = new Map<string, { provider: IMemoryProvider; pluginName: string }>();

  /** 插件注册的 LLM Provider */
  private registeredLLMProviders: Array<{ config: LLMProviderConfig; pluginName: string }> = [];

  /** 插件注册的命令 */
  private registeredCommands = new Map<string, { command: CommandDefinition; pluginName: string }>();

  /** 插件注册的路由 */
  private registeredRoutes: Array<{ route: RouteDefinition; pluginName: string }> = [];

  /** Hook 调度器 */
  readonly hooks = new HookDispatcher();

  /**
   * 注册一个插件（阶段1：声明式注册）。
   *
   * @param plugin - 插件实例
   * @param source - 插件来源
   */
  register(plugin: SuperAgentPlugin, source: PluginDiscoverySource = "workspace"): void {
    const name = plugin.manifest.name;

    // 冲突检测
    if (this.plugins.has(name)) {
      const existing = this.plugins.get(name)!;
      logger.warn(
        { plugin: name, existingSource: existing.source, newSource: source },
        "插件名称冲突，跳过注册",
      );
      return;
    }

    // 创建 PluginApi 实例（绑定当前插件名称用于溯源）
    const api = this.createPluginApi(name);

    // 阶段1：声明式注册
    try {
      plugin.register(api);
      this.plugins.set(name, {
        plugin,
        source,
        activated: false,
        loadedAt: new Date(),
      });
      logger.info(
        { plugin: name, capabilities: plugin.manifest.capabilities, source },
        "插件注册成功",
      );
    } catch (err) {
      logger.error({ plugin: name, err }, "插件注册失败");
      this.plugins.set(name, {
        plugin,
        source,
        activated: false,
        loadedAt: new Date(),
        error: String(err),
      });
    }
  }

  /**
   * 激活所有已注册但未激活的插件（阶段2：运行时激活）。
   *
   * @param contextFactory - 为每个插件创建运行时上下文的工厂函数
   */
  async activateAll(contextFactory: (pluginName: string) => PluginContext): Promise<void> {
    for (const [name, entry] of this.plugins) {
      if (entry.activated || entry.error) continue;
      if (!entry.plugin.activate) {
        entry.activated = true;
        continue;
      }

      try {
        const ctx = contextFactory(name);
        await entry.plugin.activate(ctx);
        entry.activated = true;
        logger.info({ plugin: name }, "插件激活成功");
      } catch (err) {
        entry.error = String(err);
        logger.error({ plugin: name, err }, "插件激活失败");
      }
    }
  }

  /**
   * 卸载指定插件。
   */
  async unregister(pluginName: string): Promise<void> {
    const entry = this.plugins.get(pluginName);
    if (!entry) return;

    // 调用 deactivate
    try {
      await entry.plugin.deactivate?.();
    } catch (err) {
      logger.error({ plugin: pluginName, err }, "插件卸载清理失败");
    }

    // 清理已注册资源
    this.hooks.unregister(pluginName);
    for (const [toolName, reg] of this.registeredTools) {
      if (reg.pluginName === pluginName) this.registeredTools.delete(toolName);
    }
    for (const [channelId, reg] of this.registeredChannels) {
      if (reg.pluginName === pluginName) this.registeredChannels.delete(channelId);
    }
    for (const [provName, reg] of this.registeredMemoryProviders) {
      if (reg.pluginName === pluginName) this.registeredMemoryProviders.delete(provName);
    }
    this.registeredLLMProviders = this.registeredLLMProviders.filter(p => p.pluginName !== pluginName);
    for (const [cmdName, reg] of this.registeredCommands) {
      if (reg.pluginName === pluginName) this.registeredCommands.delete(cmdName);
    }
    this.registeredRoutes = this.registeredRoutes.filter(r => r.pluginName !== pluginName);

    this.plugins.delete(pluginName);
    logger.info({ plugin: pluginName }, "插件已卸载");
  }

  // ─── 资源查询 API ──────────────────────────────

  /** 获取所有插件注册的工具 */
  getTools(): ToolDefinition[] {
    return Array.from(this.registeredTools.values()).map(r => r.tool);
  }

  /** 获取所有插件注册的渠道配置 */
  getChannels(): ChannelPluginConfig[] {
    return Array.from(this.registeredChannels.values()).map(r => r.channel);
  }

  /** 获取所有插件注册的记忆 Provider */
  getMemoryProviders(): IMemoryProvider[] {
    return Array.from(this.registeredMemoryProviders.values()).map(r => r.provider);
  }

  /** 获取所有插件注册的命令 */
  getCommands(): CommandDefinition[] {
    return Array.from(this.registeredCommands.values()).map(r => r.command);
  }

  /** 获取所有插件注册的路由 */
  getRoutes(): RouteDefinition[] {
    return this.registeredRoutes.map(r => r.route);
  }

  /** 获取所有已加载插件信息 */
  listPlugins(): LoadedPluginInfo[] {
    return Array.from(this.plugins.entries()).map(([name, entry]) => ({
      name,
      version: entry.plugin.manifest.version,
      source: entry.source,
      capabilities: entry.plugin.manifest.capabilities,
      activated: entry.activated,
      loadedAt: entry.loadedAt,
      error: entry.error,
    }));
  }

  /** 按能力类型查找插件 */
  findByCapability(capability: PluginCapability): LoadedPluginInfo[] {
    return this.listPlugins().filter(p => p.capabilities.includes(capability));
  }

  /** 获取插件总数 */
  get size(): number {
    return this.plugins.size;
  }

  /** 清空所有注册 */
  async clear(): Promise<void> {
    for (const name of Array.from(this.plugins.keys())) {
      await this.unregister(name);
    }
    this.hooks.clear();
  }

  // ─── 内部：为每个插件创建隔离的 PluginApi ──────

  private createPluginApi(pluginName: string): PluginApi {
    return {
      registerTool: (tool: ToolDefinition) => {
        if (this.registeredTools.has(tool.name)) {
          logger.warn({ tool: tool.name, plugin: pluginName }, "工具名称冲突，跳过");
          return;
        }
        this.registeredTools.set(tool.name, { tool, pluginName });
      },

      registerHook: (name: PluginHookName, handler: HookHandler) => {
        this.hooks.register(name, pluginName, handler);
      },

      registerChannel: (channel: ChannelPluginConfig) => {
        if (this.registeredChannels.has(channel.id)) {
          logger.warn({ channel: channel.id, plugin: pluginName }, "渠道 ID 冲突，跳过");
          return;
        }
        this.registeredChannels.set(channel.id, { channel, pluginName });
      },

      registerMemoryProvider: (provider: IMemoryProvider) => {
        if (this.registeredMemoryProviders.has(provider.name)) {
          logger.warn({ provider: provider.name, plugin: pluginName }, "记忆 Provider 名称冲突，跳过");
          return;
        }
        this.registeredMemoryProviders.set(provider.name, { provider, pluginName });
      },

      registerProvider: (config: LLMProviderConfig) => {
        this.registeredLLMProviders.push({ config, pluginName });
      },

      registerCommand: (command: CommandDefinition) => {
        if (this.registeredCommands.has(command.name)) {
          logger.warn({ command: command.name, plugin: pluginName }, "命令名称冲突，跳过");
          return;
        }
        this.registeredCommands.set(command.name, { command, pluginName });
      },

      registerRoute: (route: RouteDefinition) => {
        this.registeredRoutes.push({ route, pluginName });
      },
    };
  }
}
