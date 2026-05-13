/**
 * Agent Manager — registry and lifecycle controller for all agents.
 *
 * Manages multiple AgentRuntime instances, provides CRUD operations,
 * and emits events for agent state changes.
 */

import { v4 as uuid } from "uuid";
import { EventEmitter } from "eventemitter3";
import pino from "pino";
import { AgentRuntime } from "./runtime.js";
import type { AgentConfig, AgentState, ToolDefinition } from "../types/index.js";
import type { SecurityManager } from "../security/sandbox.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillLoader } from "../skills/loader.js";
import type { EvolutionEngine } from "../evolution/engine.js";

const logger = pino({ name: "agent-manager" });

type AgentManagerEvents = {
  "agent:created": [AgentState];
  "agent:updated": [AgentState];
  "agent:deleted": [string];
  "agent:error": [string, Error];
};

export class AgentManager extends EventEmitter<AgentManagerEvents> {
  private agents: Map<string, AgentRuntime> = new Map();
  private globalTools: Map<string, ToolDefinition> = new Map();
  private securityManager?: SecurityManager;
  private memoryManager?: MemoryManager;
  private skillLoader?: SkillLoader;
  private platform?: string;
  // 进化引擎引用（Phase A-1: Nudge 自动化闭环）
  private _evolution: EvolutionEngine | null = null;

  /** Set the security manager for all agents. */
  setSecurityManager(sm: SecurityManager): void {
    this.securityManager = sm;
  }

  /** Set the memory manager for all agents. */
  setMemoryManager(mm: MemoryManager): void {
    this.memoryManager = mm;
  }

  /** Set the skill loader for all agents. */
  setSkillLoader(sl: SkillLoader): void {
    this.skillLoader = sl;
  }

  /** Set the default platform for all agents. */
  setPlatform(platform: string): void {
    this.platform = platform || undefined;
  }

  /**
   * 设置进化引擎并注册 Nudge 自动 Review 处理器
   * （学 Hermes run_agent.py:2105-2200 _spawn_background_review）
   */
  setEvolutionEngine(engine: EvolutionEngine): void {
    this._evolution = engine;
    // 注册 nudge:triggered 自动触发后台 review
    engine.on("nudge:triggered", async ({ memory, skills, agentId }: { memory: boolean; skills: boolean; agentId: string }) => {
      const agent = this.getAgent(agentId);
      if (!agent) return;
      try {
        const recentContext = agent.getRecentMessages(10)
          .map(m => `${m.role}: ${typeof m.content === "string" ? m.content.slice(0, 200) : ""}`)
          .join("\n");
        // 异步执行 review，不阻塞主流程
        await engine.triggerReview(agentId, {
          reviewMemory: memory,
          reviewSkills: skills,
          conversationContext: recentContext,
        });
      } catch (err) {
        logger.debug({ err, agentId }, "Background nudge review failed (non-fatal)");
      }
    });
    // C-4: 技能文件变更时清除所有 agent 的 Prompt 缓存
    // （学 Hermes clear_skills_system_prompt_cache）
    engine.on("skill:changed", () => {
      for (const agent of this.agents.values()) {
        agent.invalidatePromptCache();
      }
      logger.debug("Prompt cache invalidated for all agents (skill:changed)");
    });
    logger.info("Evolution engine connected to agent manager");
  }

  /** 获取进化引擎引用 */
  get evolution(): EvolutionEngine | null {
    return this._evolution;
  }

  /**
   * 创建专用的 Review Agent（学 Hermes Fork Agent 模式）。
   * 共享记忆存储和工具，但拥有独立的对话历史。
   * Review Agent 不注册到 AgentManager（临时实例，用后销毁）。
   * Phase B-1: 避免 review prompt 污染主 agent 对话历史。
   */
  createReviewAgent(sourceAgentId: string): AgentRuntime | null {
    const source = this.getAgent(sourceAgentId);
    if (!source) return null;

    const reviewAgent = new AgentRuntime({
      config: {
        ...source.state.config,
        id: `review_${sourceAgentId}_${Date.now()}`,
      },
      tools: Array.from(this.globalTools.values()),
      securityManager: this.securityManager,
      memoryManager: this.memoryManager,
      skillLoader: this.skillLoader,
      platform: this.platform,
      // 不传 manager，防止 review agent 触发进化引擎递归（学 Hermes 禁用 fork agent nudge）
    });
    logger.debug({ sourceAgentId, reviewAgentId: reviewAgent.id }, "Review agent created (isolated)");
    return reviewAgent;
  }

  /** Register a tool available to all agents. */
  registerGlobalTool(tool: ToolDefinition): void {
    this.globalTools.set(tool.name, tool);
    // Inject into existing agents
    for (const agent of this.agents.values()) {
      agent.registerTool(tool);
    }
  }

  /** Unregister a global tool by name and remove it from all agents. */
  unregisterGlobalTool(name: string): boolean {
    const deleted = this.globalTools.delete(name);
    if (deleted) {
      for (const agent of this.agents.values()) {
        agent.unregisterTool(name);
      }
      logger.info({ tool: name }, "Global tool unregistered");
    }
    return deleted;
  }

  /**
   * P2-1：返回当前全局可用的工具名列表。
   * 为 AgentMatcher、UI Autocomplete 等消费方提供统一的工具白名单数据源，
   * 避免各模块自己从 globalTools 取 keys 导致联系耦合。
   */
  listAvailableToolNames(): string[] {
    return Array.from(this.globalTools.keys());
  }

  /**
   * 返回当前全局工具定义列表（供 SubagentExecutor 等内部消费方使用）。
   * 与 listAvailableToolNames() 不同，本方法返回完整 ToolDefinition（含 execute 函数引用），
   * 用于子代理创建时需要注入全部工具的完整定义。
   */
  getGlobalTools(): ToolDefinition[] {
    return Array.from(this.globalTools.values());
  }

  /**
   * P1-2 / P2-1：返回当前加载的技能名列表（基于 skillLoader.listSkills）。
   * 若 skillLoader 未注入则返回空数组。名称来源于 Skill.frontmatter.name。
   */
  listAvailableSkillNames(): string[] {
    if (!this.skillLoader) return [];
    return this.skillLoader
      .listSkills()
      .map((s) => s.frontmatter?.name)
      .filter((n): n is string => typeof n === "string" && n.length > 0);
  }

  /**
   * Create a new agent from config.
   * @param config - Agent 配置（Partial<AgentConfig> & { name: string }）
   * @param opts - 创建选项
   * @param opts.lightweight - 轻量模式：跳过环境快照采集、Markdown 快照等重型初始化，
   *   用于批量注册内置 Agent 时避免 I/O 风暴
   */
  createAgent(config: Partial<AgentConfig> & { name: string }, opts?: { lightweight?: boolean }): AgentRuntime {
    const id = config.id ?? uuid();
    const fullConfig: AgentConfig = {
      id,
      name: config.name,
      description: config.description,
      role: config.role,
      goal: config.goal,
      backstory: config.backstory,
      systemPrompt: config.systemPrompt ?? "You are a helpful AI assistant.",
      llmProvider: config.llmProvider ?? { type: "openai", model: "gpt-4o-mini" },
      tools: config.tools ?? [],
      skills: config.skills ?? [],
      channels: config.channels ?? [],
      memoryEnabled: config.memoryEnabled ?? true,
      maxToolIterations: config.maxToolIterations ?? 25,
      metadata: config.metadata ?? {},
      toolPolicy: config.toolPolicy, // P0-Qwen400-ROOT: 透传工具注入策略
    };

    const runtime = new AgentRuntime({
      config: fullConfig,
      // P0-Qwen400-ROOT: 根据 toolPolicy 决定注入哪些工具。
      // "configured-only"：仅注入 config.tools 白名单中匹配的全局工具定义；
      //   tools=[] 时 Agent 无任何工具 → LLM 不会产生 tool_calls → 杜绝 JSON 破损。
      // "all"（默认）：保持向后兼容，注入所有全局工具。
      tools: fullConfig.toolPolicy === "configured-only"
        ? (fullConfig.tools.length > 0
            ? Array.from(this.globalTools.values()).filter(
                (t) => fullConfig.tools.includes(t.name),
              )
            : [])
        : Array.from(this.globalTools.values()),
      securityManager: this.securityManager,
      memoryManager: this.memoryManager,
      skillLoader: this.skillLoader,
      platform: this.platform,
      manager: this, // Phase A-1: 反向引用，用于 evolution 闭环
      // 🔧 P0 修复：透传 lightweight 标志，批量注册内置 Agent 时跳过重型初始化
      lightweight: opts?.lightweight,
    });

    this.agents.set(id, runtime);

    // P0-01 fix: Initialize core memory blocks so renderCoreMemory() works
    if (this.memoryManager) {
      this.memoryManager.initCoreMemory(id);
    }

    logger.info({ agentId: id, name: fullConfig.name }, "Agent created");
    this.emit("agent:created", runtime.state);

    return runtime;
  }

  /** Get an agent by ID. */
  getAgent(id: string): AgentRuntime | undefined {
    return this.agents.get(id);
  }

  /**
   * 列出所有 Agent。
   *
   * 默认会过滤掉 `metadata.source === "crew-dynamic"` 的动态 Agent：
   * 这类 Agent 由多 Agent 协作（autoAssign）运行时临时创建，
   * 完成后由 orchestrator 统一回收，不应出现在 UI 下拉框 / IM 通道 /
   * 模型推断 / 聊天 / 进化等面向用户的 Agent 列表中，避免出现“幽灵 Agent”。
   *
   * 如确需访问动态 Agent（例如调试或特殊内部场景），
   * 显式传入 `{ includeDynamic: true }` 作为逃生舱。
   *
   * 注意：orchestrator 的 cleanupDynamicAgents 走独立的 dynamicAgentIds Map
   * 精准清理，不依赖本方法，因此默认过滤不会影响回收逻辑。
   */
  listAgents(options?: { includeDynamic?: boolean }): AgentState[] {
    const all = Array.from(this.agents.values()).map((a) => a.state);
    if (options?.includeDynamic) return all;
    return all.filter((s) => {
      const src = (s.config as { metadata?: { source?: string } })?.metadata?.source;
      return src !== "crew-dynamic";
    });
  }

  /** Update an agent's config. */
  updateAgent(id: string, partial: Partial<AgentConfig>): AgentRuntime | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;

    agent.updateConfig(partial);
    logger.info({ agentId: id }, "Agent updated");
    this.emit("agent:updated", agent.state);
    return agent;
  }

  /** Delete an agent. */
  deleteAgent(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent) return false;

    agent.stop();
    this.agents.delete(id);

    // B-10: 清理对应的 core memory 块
    if (this.memoryManager) {
      this.memoryManager.clearCoreMemory(id);
    }

    logger.info({ agentId: id }, "Agent deleted");
    this.emit("agent:deleted", id);
    return true;
  }

  /** Get agent count. */
  get count(): number {
    return this.agents.size;
  }

  /** Stop all agents. */
  stopAll(): void {
    for (const agent of this.agents.values()) {
      agent.stop();
    }
    this.agents.clear();
  }
}
