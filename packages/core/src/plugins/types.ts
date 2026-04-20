/**
 * 统一插件系统 — 核心类型定义
 *
 * 设计参考 OpenClaw 声明式适配器组合 + 两阶段生命周期（register → activate）。
 * 让工具、渠道、记忆后端、Hook、Provider、命令、路由都可插件化扩展。
 *
 * 兼容性保证：
 * - 现有 IMemoryProvider 通过 memory-adapter 桥接
 * - 现有 ToolDefinition 通过 tool-adapter 桥接
 * - 现有 ChannelPlugin (IM Gateway) 通过 channel-adapter 桥接
 */

import type { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult, LLMProviderConfig } from "../types/index.js";
import type { IMemoryProvider, MemoryProviderConfig } from "../memory/provider.js";

// ═══════════════════════════════════════════════════════════════
// 插件能力声明
// ═══════════════════════════════════════════════════════════════

/** 插件可提供的能力类型（对标 OpenClaw 20+ 适配器，精选 7 类） */
export type PluginCapability =
  | "tool"           // 注册工具
  | "channel"        // 注册 IM 渠道
  | "memory"         // 注册记忆后端
  | "hook"           // 注册生命周期钩子
  | "provider"       // 注册 LLM/嵌入 Provider
  | "command"        // 注册命令
  | "route";         // 注册 HTTP 路由

/** 插件元数据声明 */
export interface PluginManifest {
  /** 插件唯一名称（如 "my-browser-plugin"） */
  name: string;
  /** 语义化版本号 */
  version: string;
  /** 插件描述 */
  description?: string;
  /** 作者 */
  author?: string;
  /** 声明插件提供哪些能力 */
  capabilities: PluginCapability[];
  /** 插件配置 JSON Schema（可选，用 Zod 验证） */
  configSchema?: z.ZodType;
  /** 依赖的其他插件名称 */
  dependencies?: string[];
}

// ═══════════════════════════════════════════════════════════════
// 生命周期钩子（参考 OpenClaw 30 个 Hook，精选核心 15 个）
// ═══════════════════════════════════════════════════════════════

export type PluginHookName =
  | "before_agent_start"   // Agent 启动前
  | "agent_end"            // Agent 结束后
  | "before_prompt_build"  // 构建提示词前
  | "llm_input"            // LLM 输入前（可修改消息）
  | "llm_output"           // LLM 输出后（可修改响应）
  | "before_tool_call"     // 工具调用前
  | "after_tool_call"      // 工具调用后
  | "message_received"     // 收到消息
  | "message_sending"      // 发送消息前
  | "message_sent"         // 消息已发送
  | "session_start"        // 会话开始
  | "session_end"          // 会话结束
  | "before_compaction"    // 上下文压缩前
  | "after_compaction"     // 上下文压缩后
  | "gateway_start";       // 网关启动

/** Hook 处理器上下文 */
export interface HookContext {
  /** 当前 Agent ID */
  agentId?: string;
  /** 当前会话 ID */
  sessionId?: string;
  /** 可在 Hook 间传递的自定义数据 */
  data: Record<string, unknown>;
}

/** Hook 处理器函数签名 */
export type HookHandler = (
  context: HookContext,
  /** 对于可修改的 Hook（如 llm_input），payload 是待修改的数据 */
  payload?: unknown,
) => Promise<unknown | void> | unknown | void;

// ═══════════════════════════════════════════════════════════════
// 渠道插件配置（对标 IM Gateway ChannelPlugin）
// ═══════════════════════════════════════════════════════════════

/** 渠道插件注册配置 */
export interface ChannelPluginConfig {
  /** 渠道唯一标识（如 "slack", "telegram"） */
  id: string;
  /** 显示名称 */
  label: string;
  /** 渠道能力声明 */
  capabilities: Record<string, boolean>;
  /** 配置 Schema */
  configSchema: Record<string, unknown>;
}

// ═══════════════════════════════════════════════════════════════
// 命令与路由定义
// ═══════════════════════════════════════════════════════════════

/** 斜杠命令定义 */
export interface CommandDefinition {
  /** 命令名称（如 "/mycommand"） */
  name: string;
  /** 命令描述 */
  description: string;
  /** 命令参数定义 */
  parameters?: z.ZodType;
  /** 执行函数 */
  execute: (args: unknown, context: ToolContext) => Promise<ToolResult>;
}

/** HTTP 路由定义 */
export interface RouteDefinition {
  /** HTTP 方法 */
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  /** 路径（如 "/api/my-plugin/data"） */
  path: string;
  /** 路由处理器 */
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
  /** 路由描述 */
  description?: string;
}

// ═══════════════════════════════════════════════════════════════
// 插件 API 表面（参考 OpenClaw OpenClawPluginApi）
// ═══════════════════════════════════════════════════════════════

/** 插件注册阶段可使用的 API */
export interface PluginApi {
  /** 注册工具 */
  registerTool(tool: ToolDefinition): void;
  /** 注册生命周期钩子 */
  registerHook(name: PluginHookName, handler: HookHandler): void;
  /** 注册 IM 渠道 */
  registerChannel(channel: ChannelPluginConfig): void;
  /** 注册记忆后端 Provider */
  registerMemoryProvider(provider: IMemoryProvider): void;
  /** 注册 LLM Provider 配置 */
  registerProvider(provider: LLMProviderConfig): void;
  /** 注册斜杠命令 */
  registerCommand(command: CommandDefinition): void;
  /** 注册 HTTP 路由 */
  registerRoute(route: RouteDefinition): void;
}

// ═══════════════════════════════════════════════════════════════
// 插件运行时上下文（activate 阶段可用）
// ═══════════════════════════════════════════════════════════════

/** 插件运行时上下文（参考 OpenClaw PluginRuntime） */
export interface PluginContext {
  /** 插件自身的配置（经过 Schema 验证后的值） */
  config: Record<string, unknown>;
  /** 日志器（带插件名前缀） */
  logger: {
    info: (msg: string, ...args: unknown[]) => void;
    warn: (msg: string, ...args: unknown[]) => void;
    error: (msg: string, ...args: unknown[]) => void;
    debug: (msg: string, ...args: unknown[]) => void;
  };
  /** 持久化的插件状态（SQLite 持久化） */
  state: {
    get: <T = unknown>(key: string) => Promise<T | undefined>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** 事件发射器（只读访问） */
  events: {
    on: (event: string, handler: (...args: unknown[]) => void) => void;
    off: (event: string, handler: (...args: unknown[]) => void) => void;
  };
}

// ═══════════════════════════════════════════════════════════════
// 统一插件接口（两阶段生命周期）
// ═══════════════════════════════════════════════════════════════

/**
 * Super Agent 统一插件接口。
 *
 * 生命周期：
 * 1. register(api) — 声明式注册阶段，同步执行，注册工具/Hook/渠道等
 * 2. activate(context) — 运行时激活阶段，异步执行，可访问配置/状态/事件
 * 3. deactivate() — 清理阶段，释放资源
 */
export interface SuperAgentPlugin {
  /** 插件元数据 */
  manifest: PluginManifest;

  /**
   * 阶段1：声明式注册。
   * 插件通过 api 注册工具、Hook、渠道、Provider 等。
   * 此阶段不应执行异步操作或依赖外部资源。
   */
  register(api: PluginApi): void;

  /**
   * 阶段2：运行时激活（可选）。
   * 在所有插件注册完成后调用，可执行异步初始化。
   */
  activate?(context: PluginContext): Promise<void>;

  /**
   * 清理阶段（可选）。
   * 插件卸载或系统关闭时调用。
   */
  deactivate?(): Promise<void>;
}

// ═══════════════════════════════════════════════════════════════
// 插件发现配置
// ═══════════════════════════════════════════════════════════════

/** 插件发现来源 */
export type PluginDiscoverySource = "builtin" | "workspace" | "global";

/** 插件发现配置 */
export interface PluginDiscoveryConfig {
  /** 内置插件目录（项目内） */
  builtinDir?: string;
  /** 工作区插件目录 */
  workspaceDir?: string;
  /** 全局插件目录（~/.super-agent/plugins/） */
  globalDir?: string;
  /** 禁用的插件名称列表 */
  disabledPlugins?: string[];
}

/** 已加载插件的描述信息 */
export interface LoadedPluginInfo {
  /** 插件名称 */
  name: string;
  /** 插件版本 */
  version: string;
  /** 插件来源 */
  source: PluginDiscoverySource;
  /** 提供的能力 */
  capabilities: PluginCapability[];
  /** 是否已激活 */
  activated: boolean;
  /** 加载时间 */
  loadedAt: Date;
  /** 加载错误（如果有） */
  error?: string;
}
