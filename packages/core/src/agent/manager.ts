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

  /** Create a new agent from config. */
  createAgent(config: Partial<AgentConfig> & { name: string }): AgentRuntime {
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
    };

    const runtime = new AgentRuntime({
      config: fullConfig,
      tools: Array.from(this.globalTools.values()),
      securityManager: this.securityManager,
      memoryManager: this.memoryManager,
      skillLoader: this.skillLoader,
      platform: this.platform,
      manager: this, // Phase A-1: 反向引用，用于 evolution 闭环
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

  /** List all agents. */
  listAgents(): AgentState[] {
    return Array.from(this.agents.values()).map((a) => a.state);
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
