/**
 * D-1: MemoryProvider 插件接口（学 Hermes memory_provider.py）
 *
 * 定义记忆 Provider 的完整生命周期：initialize → prefetch → syncTurn → shutdown
 * 支持 builtin + 1 external provider 编排模式（学 Hermes MemoryManager）
 *
 * 与现有 MemoryBackend 的关系：
 * - MemoryBackend：纯存储接口（add/get/update/delete/list/search）
 * - IMemoryProvider：完整生命周期 + 工具注册 + system prompt 贡献
 * - BuiltinMemoryProvider 内部持有 MemoryManager + MarkdownMemory，封装现有逻辑
 */

import type { ToolDefinition, ToolContext, ToolResult, LLMMessage } from "../types/index.js";

// ─── Provider 配置 ────────────────────────────────────────────

export interface MemoryProviderConfig {
  sessionId: string;
  agentId: string;
  userId?: string;
  platform?: string;
}

// ─── Provider 接口 ────────────────────────────────────────────

/**
 * 记忆 Provider 抽象接口（学 Hermes memory_provider.py ABC）
 *
 * 核心生命周期：
 *   initialize() → [prefetch() → syncTurn()]* → shutdown()
 *
 * 外部 Provider 实现示例：Mem0Provider, HonchoProvider, GraphitiProvider
 */
export interface IMemoryProvider {
  /** Provider 唯一名称（如 "builtin", "mem0", "honcho"） */
  readonly name: string;

  // ── 核心生命周期 ──────────────────────────────────────────

  /** 初始化 Provider（连接外部服务、加载状态等） */
  initialize(config: MemoryProviderConfig): Promise<void>;

  /** 关闭 Provider（释放资源、保存状态等） */
  shutdown(): Promise<void>;

  // ── System Prompt 贡献 ─────────────────────────────────────

  /**
   * 返回此 Provider 贡献的 system prompt 片段
   * 将被合并到 PromptEngine 的 memory section 中
   */
  systemPromptBlock(): string;

  // ── 每轮回调 ──────────────────────────────────────────────

  /**
   * 预取阶段：根据用户查询预加载相关记忆
   * 返回的内容会被插入到当前轮次的 prompt 上下文中
   */
  prefetch(query: string): Promise<string>;

  /**
   * 同步阶段：每轮对话结束后同步 user/assistant 内容
   * 用于更新 Provider 内部状态（如 Mem0 的自动提取）
   */
  syncTurn(userContent: string, assistantContent: string): Promise<void>;

  // ── 工具注册 ──────────────────────────────────────────────

  /** 返回此 Provider 提供的工具定义列表 */
  getToolSchemas(): ToolDefinition[];

  /** 处理工具调用（由 Provider 内部路由到正确的处理函数） */
  handleToolCall(toolName: string, args: unknown, ctx: ToolContext): Promise<ToolResult>;

  // ── 可选钩子（默认不实现即可） ────────────────────────────

  /** 每轮开始时调用 */
  onTurnStart?(turnNumber: number, message: string): void;

  /** Session 结束时调用（可用于持久化摘要） */
  onSessionEnd?(messages: LLMMessage[]): void;

  /** 压缩前回调（可返回额外需要保留的内容） */
  onPreCompress?(messages: LLMMessage[]): string;

  /** 记忆写入时回调（可用于同步到外部系统） */
  onMemoryWrite?(action: string, target: string, content: string): void;
}

// ─── Provider 编排器 ──────────────────────────────────────────

/**
 * Provider 编排器（学 Hermes MemoryManager 编排模式）
 *
 * 管理 builtin + 最多1个 external provider
 * 所有 provider 调用都有 try/catch 故障隔离（一个 provider 异常不影响其他）
 */
export class MemoryProviderOrchestrator {
  private _providers: IMemoryProvider[] = [];
  private _hasExternal = false;

  /** 注册 Provider（学 Hermes add_provider，限制最多1个 external） */
  addProvider(provider: IMemoryProvider): void {
    if (provider.name !== "builtin" && this._hasExternal) {
      throw new Error(
        `Cannot add provider '${provider.name}': only one external provider is allowed. ` +
        `Already have an external provider registered.`
      );
    }
    if (provider.name !== "builtin") {
      this._hasExternal = true;
    }
    this._providers.push(provider);
  }

  /** 获取所有已注册的 Provider */
  get providers(): readonly IMemoryProvider[] {
    return this._providers;
  }

  /** 初始化所有 Provider（故障隔离） */
  async initializeAll(config: MemoryProviderConfig): Promise<void> {
    for (const p of this._providers) {
      try {
        await p.initialize(config);
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Failed to initialize provider '${p.name}':`, err);
      }
    }
  }

  /** 关闭所有 Provider（故障隔离） */
  async shutdownAll(): Promise<void> {
    for (const p of this._providers) {
      try {
        await p.shutdown();
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Failed to shutdown provider '${p.name}':`, err);
      }
    }
  }

  /** 收集所有 Provider 的 system prompt 贡献 */
  buildSystemPrompt(): string {
    const blocks: string[] = [];
    for (const p of this._providers) {
      try {
        const block = p.systemPromptBlock();
        if (block) blocks.push(block);
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Provider '${p.name}' systemPromptBlock() failed:`, err);
      }
    }
    return blocks.join("\n\n");
  }

  /** 预取所有 Provider 的记忆内容（并行，故障隔离） */
  async prefetchAll(query: string): Promise<string> {
    const results = await Promise.allSettled(
      this._providers.map((p) => p.prefetch(query))
    );
    const blocks: string[] = [];
    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === "fulfilled" && r.value) {
        blocks.push(r.value);
      } else if (r.status === "rejected") {
        console.error(
          `[MemoryProviderOrchestrator] Provider '${this._providers[i].name}' prefetch failed:`,
          r.reason
        );
      }
    }
    return blocks.join("\n\n");
  }

  /** 同步所有 Provider（并行，故障隔离） */
  async syncAll(userContent: string, assistantContent: string): Promise<void> {
    const results = await Promise.allSettled(
      this._providers.map((p) => p.syncTurn(userContent, assistantContent))
    );
    for (let i = 0; i < results.length; i++) {
      if (results[i].status === "rejected") {
        console.error(
          `[MemoryProviderOrchestrator] Provider '${this._providers[i].name}' syncTurn failed:`,
          (results[i] as PromiseRejectedResult).reason
        );
      }
    }
  }

  /** 收集所有 Provider 的工具定义 */
  getAllToolSchemas(): ToolDefinition[] {
    const tools: ToolDefinition[] = [];
    for (const p of this._providers) {
      try {
        tools.push(...p.getToolSchemas());
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Provider '${p.name}' getToolSchemas() failed:`, err);
      }
    }
    return tools;
  }

  /** 路由工具调用到正确的 Provider */
  async handleToolCall(toolName: string, args: unknown, ctx: ToolContext): Promise<ToolResult | null> {
    for (const p of this._providers) {
      const schemas = p.getToolSchemas();
      if (schemas.some((s) => s.name === toolName)) {
        return p.handleToolCall(toolName, args, ctx);
      }
    }
    return null; // 没有 Provider 认领此工具
  }

  /** 通知所有 Provider 轮次开始 */
  notifyTurnStart(turnNumber: number, message: string): void {
    for (const p of this._providers) {
      try {
        p.onTurnStart?.(turnNumber, message);
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Provider '${p.name}' onTurnStart failed:`, err);
      }
    }
  }

  /** 通知所有 Provider Session 结束 */
  notifySessionEnd(messages: LLMMessage[]): void {
    for (const p of this._providers) {
      try {
        p.onSessionEnd?.(messages);
      } catch (err) {
        console.error(`[MemoryProviderOrchestrator] Provider '${p.name}' onSessionEnd failed:`, err);
      }
    }
  }
}
