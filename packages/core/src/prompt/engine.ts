/**
 * PromptEngine — 10-layer system prompt assembler with caching.
 *
 * @version 2.1.0
 * @last-modified 2026-05-03 — 审查：各层已核实存在，补充版本注释
 *
 * Layers (L1-L6 stable prefix, L7-L10 dynamic per-turn):
 *  L1. Agent Identity (role/goal/backstory + systemPrompt)
 *  L2. Tool-Use Enforcement
 *  L3. Model-Specific Execution Guidance
 *  L4. Memory Guidance
 *  L5. Skills Guidance + available skills list
 *  L6. Safety Guardrails
 *  ── CACHE BOUNDARY ──
 *  L7. Core Memory Blocks (XML from MemoryManager)
 *  L8. Project Context Files
 *  L9. Available Tools + Session Info + Runtime Environment
 *  L10. Platform Hint
 *
 * Fused from:
 *  - Hermes: tool enforcement, memory guidance, session-level caching
 *  - OpenClaw: cache boundary, promptMode, platform hints
 *  - Super Agent enhancements: Chinese LLM adapters, injection guard, structured XML memory
 */

import type { AgentConfig, Session, ToolDefinition } from "../types/index.js";
import type { MemoryManager } from "../memory/manager.js";
import type { SkillLoader } from "../skills/loader.js";
import { createRequire } from "node:module";
import {
  TOOL_USE_ENFORCEMENT,
  MEMORY_GUIDANCE,
  KB_GUIDANCE,
  SKILLS_GUIDANCE_HEADER,
  SAFETY_GUARDRAILS,
  SAFETY_POLICIES_SHORT,
  OUTPUT_FORMAT,
  PLATFORM_SUMMARY,
} from "./guidance.js";
import { HEARTBEAT_SYSTEM_SECTION } from "../cron/heartbeat.js";
import { resolveModelGuidance, resolveToolEnforcement } from "./model-adapters.js";
import { resolvePlatformHint } from "./platform-hints.js";
import { discoverContextFiles } from "./context-files.js";
import type { MarkdownMemory } from "../memory/markdown-memory.js";
import { getModelById } from "../llm/model-catalog.js";
import * as os from "node:os";
import * as fs from "node:fs";
import { execFileSync } from "node:child_process";

// ─── Helpers ─────────────────────────────────────────────────

/** Escape XML special characters to prevent injection in <available_skills> block. */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── Configuration ───────────────────────────────────────────

export interface PromptEngineConfig {
  agentConfig: AgentConfig;
  memoryManager?: MemoryManager;
  /** SkillLoader instance — provides loaded skills for prompt injection (学 OpenClaw/Hermes) */
  skillLoader?: SkillLoader;
  /** Platform key: "wechat" | "wecom" | "dingtalk" | "feishu" | "cli" | ... */
  platform?: string;
  /** Project root for context file discovery */
  contextFilesRoot?: string;
  /**
   * Prompt verbosity mode (from OpenClaw):
   * - "full": all 10 layers (default)
   * - "minimal": L1 + L2 + L6 + L9 only (sub-agents with standard prompt)
   * - "subagent": Phase 2 子代理模式（使用 7段式子代理提示词 + L2 + L6 + L9）
   * - "none": identity line only (pure text generation)
   */
  promptMode?: "full" | "minimal" | "subagent" | "none";
  /** Phase 2: 子代理系统提示词（promptMode="subagent" 时替代 L1 身份层） */
  subagentSystemPrompt?: string;
  /** Phase 1: 是否启用心跳巡检（启用时将注入 HEARTBEAT_SYSTEM_SECTION 到系统提示） */
  heartbeatEnabled?: boolean;
  /** Markdown memory files (MEMORY.md / USER.md / SOUL.md) */
  markdownMemory?: MarkdownMemory;
}

// ─── PromptEngine Class ──────────────────────────────────────

export class PromptEngine {
  private config: PromptEngineConfig;
  private _cachedStablePrefix: string | null = null;
  private _cacheKey: string | null = null;
  /** P1-03 fix: Cache context files with TTL to avoid sync IO every build */
  private _cachedContextFiles: string | null = null;
  private _contextFilesCachedAt = 0;
  private static readonly CONTEXT_FILES_TTL_MS = 60_000; // 60 seconds

  constructor(config: PromptEngineConfig) {
    this.config = config;
  }

  /**
   * Build the complete system prompt for a given session.
   * L1-L6 (stable prefix) is cached; L7-L10 (dynamic) regenerated each call.
   */
  build(session: Session, tools?: Map<string, ToolDefinition>): string {
    const mode = this.config.promptMode ?? "full";

    if (mode === "none") {
      return this.buildIdentityLine();
    }

    // Stable prefix (L1-L6) — cached
    const prefix = this.getStablePrefix(mode, tools);

    if (mode === "minimal" || mode === "subagent") {
      // Minimal/Subagent: prefix already has L1+L2+L6, just add L9 (tools+session)
      const dynamic = this.buildDynamicSuffix(session, tools, true);
      return prefix + "\n\n" + dynamic;
    }

    // Full mode: prefix (L1-L6) + dynamic suffix (L7-L10)
    const dynamic = this.buildDynamicSuffix(session, tools, false);
    return prefix + "\n\n" + dynamic;
  }

  /** Invalidate cached stable prefix (call when config changes). */
  invalidateCache(): void {
    this._cachedStablePrefix = null;
    this._cacheKey = null;
    this._cachedContextFiles = null;
    this._contextFilesCachedAt = 0;
  }

  /** Update the engine configuration and invalidate cache. */
  updateConfig(config: Partial<PromptEngineConfig>): void {
    this.config = { ...this.config, ...config };
    // P1-01 fix: Always invalidate — any config change can affect stable prefix
    this.invalidateCache();
  }

  // ─── Stable Prefix (L1-L6) ─────────────────────────────────

  private getStablePrefix(mode: "full" | "minimal" | "subagent", tools?: Map<string, ToolDefinition>): string {
    const key = this.computeCacheKey(tools);
    if (this._cachedStablePrefix && this._cacheKey === key) {
      return this._cachedStablePrefix;
    }

    const parts: string[] = [];
    const cfg = this.config.agentConfig;
    const hasTools = tools && tools.size > 0;

    // L1: Agent Identity (or sub-agent prompt in subagent mode)
    if (mode === "subagent" && this.config.subagentSystemPrompt) {
      parts.push(this.config.subagentSystemPrompt);
    } else {
      parts.push(this.buildIdentity());
    }

    if (mode === "minimal" || mode === "subagent") {
      // Minimal: L1 + L2 + L6 only
      if (hasTools) {
        parts.push(TOOL_USE_ENFORCEMENT);
        // Phase 4: 分模型工具强制补充（学 Hermes 分模型策略）
        const modelToolEnf = resolveToolEnforcement(cfg.llmProvider.model);
        if (modelToolEnf) parts.push(modelToolEnf);
      }
      parts.push(SAFETY_GUARDRAILS);
    } else {
      // Full: L1-L6
      // L2: Tool-Use Enforcement
      if (hasTools) {
        parts.push(TOOL_USE_ENFORCEMENT);
        // Phase 4: 分模型工具强制补充（学 Hermes 分模型策略）
        const modelToolEnf = resolveToolEnforcement(cfg.llmProvider.model);
        if (modelToolEnf) parts.push(modelToolEnf);
      }

      // L3: Model-Specific Guidance
      const modelGuidance = resolveModelGuidance(cfg.llmProvider.model);
      if (modelGuidance) parts.push(modelGuidance);

      // L4: Memory Guidance (when memory is enabled)
      if (cfg.memoryEnabled) parts.push(MEMORY_GUIDANCE);

      // L4.5: Knowledge Base Guidance (when kb_ tools are available)
      if (tools) {
        const hasKbTools = Array.from(tools.keys()).some((n) => n.startsWith("kb_"));
        if (hasKbTools) parts.push(KB_GUIDANCE);
      }

      // L5: Skills Guidance (when skills are loaded)
      const skillsXml = this.buildSkillsList();
      if (skillsXml) {
        parts.push(SKILLS_GUIDANCE_HEADER);
        parts.push(skillsXml);
      }

      // L6: Safety Guardrails
      parts.push(SAFETY_GUARDRAILS);

      // L6.5: Platform Summary (轻量平台摘要 — 替代旧 900 token CAPABILITIES_OVERVIEW)
      parts.push(PLATFORM_SUMMARY);

      // L6.5b: Active Features (条件注入 — 仅列出实际启用的可选模块)
      const activeFeatures = this.buildActiveFeatures(tools);
      if (activeFeatures) parts.push(activeFeatures);

      // L6.6: 心跳指导（Phase 1: 学 OpenClaw heartbeat-system-prompt.ts 条件注入）
      if (this.config.heartbeatEnabled) {
        parts.push(HEARTBEAT_SYSTEM_SECTION);
      }

      // ✨ T3 Task 3.4: Output 分区 — 注入到 stable prefix 末尾
      // 输出格式规范是相对稳定的，适合 cache；仅 full 模式注入，避免污染 minimal/subagent
      parts.push(OUTPUT_FORMAT);
    }

    const prefix = parts.filter(Boolean).join("\n\n");
    this._cachedStablePrefix = prefix;
    this._cacheKey = key;
    return prefix;
  }

  // ─── Dynamic Suffix (L7-L10) ───────────────────────────────

  private buildDynamicSuffix(
    session: Session,
    tools?: Map<string, ToolDefinition>,
    minimalMode = false,
  ): string {
    const parts: string[] = [];

    if (!minimalMode) {
      // ✨ T3 Task 3.3: Task 分区（条件注入 — 仅在 session.metadata.currentTask 存在时）
      // 位于 L7 Memory 之前，让 LLM 第一时间看到当前目标
      const taskSection = this.buildTaskSection(session);
      if (taskSection) parts.push(taskSection);

      // ✨ T3 Task 3.5: Evidence 分区 — 合并 L7 Core Memory + L7.5 Markdown Memory
      // 用 <evidence> XML 标签包裹，风格与 <core_memory_block> 一致
      const evidenceSection = this.buildEvidenceSection();
      if (evidenceSection) parts.push(evidenceSection);

      // ✨ T3 Task 3.5: Context 分区 — L8 项目上下文文件
      const contextSection = this.buildContextSection();
      if (contextSection) parts.push(contextSection);
    }

    // ✨ T3 Task 3.2: ToolBox 分区（工具列表，独立于 State）
    const toolBoxSection = this.buildToolBoxSection(tools);
    if (toolBoxSection) parts.push(toolBoxSection);

    // ✨ T3 Task 3.2: State 分区（运行时环境 + 会话 + 多模态能力，用 <state> 包裹）
    parts.push(this.buildStateSection(session));

    if (!minimalMode) {
      // L10: Platform Hint
      const platformHint = resolvePlatformHint(this.config.platform);
      if (platformHint) parts.push(`## Platform\n${platformHint}`);
    }

    return parts.filter(Boolean).join("\n\n");
  }

  // ─── Layer Builders ────────────────────────────────────────

  private buildIdentityLine(): string {
    const cfg = this.config.agentConfig;
    return `You are ${cfg.name}${cfg.role ? ` (${cfg.role})` : ""}.`;
  }

  private buildIdentity(): string {
    const cfg = this.config.agentConfig;
    const parts: string[] = [];

    if (cfg.role || cfg.goal || cfg.backstory) {
      parts.push("## Identity");
      if (cfg.role) parts.push(`**Role**: ${cfg.role}`);
      if (cfg.goal) parts.push(`**Goal**: ${cfg.goal}`);
      if (cfg.backstory) parts.push(`**Backstory**: ${cfg.backstory}`);
      parts.push("");
    }

    // Base system prompt from config
    parts.push(cfg.systemPrompt);

    // ✨ T3 Task 3.1: 在 Identity 后紧跟 Policies，让 LLM 第一时间看到硬约束
    // 与 L6 SAFETY_GUARDRAILS 详版互补：Identity 给最显眼的 5 条，L6 给全量细节
    parts.push("");
    parts.push("## Policies");
    parts.push(SAFETY_POLICIES_SHORT);

    return parts.join("\n");
  }

  /**
   * Build the <available_skills> block for the system prompt.
   *
   * Follows OpenClaw's formatSkillsForPrompt pattern: each skill shows
   * name + description + location so the Agent can use skill_read(name)
   * to load full content on demand. Falls back to agentConfig.skills names
   * if no SkillLoader is available.
   */
  private buildSkillsList(): string {
    const loader = this.config.skillLoader;

    // P0-token: Reduced from 30→10, switched to Hermes-style 1-line summaries
    // to drastically cut token usage and prevent LLM timeouts with large tool sets.
    const MAX_SKILLS_IN_PROMPT = 10;

    // Primary path: use loaded skills from SkillLoader (Hermes 1-line summary format)
    if (loader) {
      const allSkills = loader.listSkills().filter((s) => s.enabled);
      if (allSkills.length === 0) return "";

      const skills = allSkills.slice(0, MAX_SKILLS_IN_PROMPT);
      const overflow = allSkills.length - skills.length;

      // Hermes-style compact format: "- name: description" (1 line per skill)
      const lines = [
        "Use skill_read(name) to load a skill when the task matches.",
      ];
      for (const s of skills) {
        const desc = s.frontmatter.description || "";
        // Truncate long descriptions to save tokens
        const shortDesc = desc.length > 80 ? desc.slice(0, 77) + "..." : desc;
        lines.push(`- ${s.frontmatter.name}: ${shortDesc}`);
      }
      if (overflow > 0) {
        lines.push(`(${overflow} more skills available via skill_list())`);
      }
      return lines.join("\n");
    }

    // Fallback: use agentConfig.skills (just names, no descriptions)
    const skills = this.config.agentConfig.skills;
    if (skills.length === 0) return "";
    const items = skills.map((s) => `- ${s}`).join("\n");
    return `Skills: ${items}`;
  }

  // ─── ✨ T3 新分区构建器（Task/Evidence/Context/ToolBox/State） ─────

  /**
   * T3 Task 3.3: Task 分区（条件注入）
   * 从 session.metadata.currentTask 读取当前任务目标与子任务。
   * 返回值用 <task> XML 标签包裹；没有 currentTask 时返回空串，不占 token。
   */
  private buildTaskSection(session: Session): string {
    const raw = session.metadata?.currentTask as
      | { goal?: unknown; subtasks?: unknown }
      | undefined;
    if (!raw || typeof raw !== "object") return "";
    const goal = typeof raw.goal === "string" ? raw.goal.trim() : "";
    if (!goal) return "";

    const subtasks = Array.isArray(raw.subtasks)
      ? raw.subtasks.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

    const lines = ["## Task", `**Goal**: ${goal}`];
    if (subtasks.length > 0) {
      lines.push("**Subtasks**:");
      for (const s of subtasks) lines.push(`- ${s}`);
    }
    return `<task>\n${lines.join("\n")}\n</task>`;
  }

  /**
   * T3 Task 3.5: Evidence 分区 — 合并持久化记忆与 Markdown 记忆。
   * 包含 L7 Core Memory（MemoryManager.getFrozenCoreMemory）+ L7.5 Markdown Memory。
   * 整体用 <evidence> 包裹，便于 LLM 识别「来自历史的证据」。
   */
  private buildEvidenceSection(): string {
    const inner: string[] = [];

    const mm = this.config.memoryManager;
    if (mm) {
      // B-1: 使用冻结快照，确保 session 内 Core Memory 稳定
      const coreXml = mm.getFrozenCoreMemory(this.config.agentConfig.id);
      if (coreXml) {
        inner.push("### Persistent Memory");
        inner.push(coreXml);
      }
    }

    // L7.5: Markdown Memory Files (MEMORY.md / USER.md / SOUL.md — Hermes pattern)
    if (this.config.markdownMemory) {
      const mdBlock = this.config.markdownMemory.getFrozenPromptBlock();
      if (mdBlock) {
        if (inner.length > 0) inner.push("");
        inner.push("### Markdown Memory");
        inner.push(mdBlock);
      }
    }

    if (inner.length === 0) return "";
    return `<evidence>\n## Evidence\n${inner.join("\n")}\n</evidence>`;
  }

  /**
   * T3 Task 3.5: Context 分区 — L8 项目上下文文件（AGENTS.md / README.md / CLAUDE.md 等）。
   * 用 <context> 包裹；保留原 60 秒 TTL 缓存以避免每轮同步 IO。
   */
  private buildContextSection(): string {
    const now = Date.now();
    if (
      this._cachedContextFiles === null ||
      now - this._contextFilesCachedAt > PromptEngine.CONTEXT_FILES_TTL_MS
    ) {
      this._cachedContextFiles = discoverContextFiles(this.config.contextFilesRoot);
      this._contextFilesCachedAt = now;
    }
    if (!this._cachedContextFiles) return "";
    return `<context>\n## Context\n${this._cachedContextFiles}\n</context>`;
  }

  /**
   * T3 Task 3.2: ToolBox 分区 — 可用工具列表（名字摘要）。
   * 工具 JSON schema 通过 toolDefs 单独下发，这里只提示 LLM 可用哪些。
   */
  private buildToolBoxSection(tools?: Map<string, ToolDefinition>): string {
    if (!tools || tools.size === 0) return "";
    const names = Array.from(tools.keys()).join(", ");
    return `## Tools (${tools.size})\n${names}`;
  }

  /**
   * T3 Task 3.2: State 分区 — 运行时状态 + 环境提示 + SysOps + Multimodal。
   * 从原 buildRuntimeSection 拆出，去除 Tools 块（已独立为 ToolBox）。
   * 用 <state> XML 包裹，顶部标题改为 ## State（满足验收「6 大分区能 grep 到 H2 标题」）。
   */
  private buildStateSection(session: Session): string {
    const parts: string[] = [];
    const cfg = this.config.agentConfig;

    // Runtime environment (enhanced — follows OpenClaw buildSystemPromptParams + Hermes build_environment_hints)
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toISOString().slice(0, 19).replace("T", " ");
    const osLabel = PromptEngine.resolveOsLabel();
    const shellLabel = PromptEngine.detectShell();
    const envHints = PromptEngine.buildEnvironmentHints();

    parts.push("## State");
    parts.push(`- Time: ${timeStr} (${tz})`);
    parts.push(`- Model: ${cfg.llmProvider.model}`);
    parts.push(`- OS: ${osLabel}`);
    parts.push(`- Shell: ${shellLabel}`);
    parts.push(`- Node: ${process.version}`);
    if (this.config.platform) parts.push(`- Channel: ${this.config.platform}`);
    parts.push(`- Session: ${session.id} | Messages: ${session.messages.length}`);

    // 上下文压缩提示 — 让 Agent 知道长对话会被自动摘要
    const modelCtx = getModelById(cfg.llmProvider.providerId ?? "", cfg.llmProvider.model ?? "")?.contextWindow;
    if (modelCtx) {
      parts.push(`- Context window: ${Math.round(modelCtx / 1000)}K tokens (older messages are auto-summarized)`);
    }

    // Environment-specific hints (WSL, Docker, etc.)
    if (envHints) parts.push(`\n${envHints}`);

    // ── SysOps 平台感知增强 (Task 6.2) ──
    // 仅当 SysOps 总开关开启时才注入，避免占用普通模式的 token
    if (process.env.SUPER_AGENT_SYSOPS_ENABLED === "true") {
      try {
        // ESM 兼容: 使用 createRequire 在同步方法中加载模块
        const esmRequire = createRequire(import.meta.url);
        const { getInstalledCLISummary } = esmRequire("../platform/cli-detector.js") as { getInstalledCLISummary: () => string };
        const cliSummary = getInstalledCLISummary();
        if (cliSummary) {
          parts.push("");
          parts.push("## System Operations");
          parts.push("You have system-level operation capabilities. Available CLI tools:");
          parts.push(cliSummary);
          parts.push("");
          parts.push("Guidelines:");
          parts.push("- Prefer installed CLI tools over writing scripts");
          parts.push("- Use `terminal` for long-running commands, `run_shell` for quick ones");
          parts.push("- Dangerous operations (rm -rf, git push --force) require approval");
          parts.push("- Always verify before modifying: check status first, then act");
        }
      } catch { /* CLI detector not available, skip silently */ }
    }

    // 多模态能力认知声明 — 让模型知道自己能不能直接看图
    const visionCapable = cfg.llmProvider.supportsVision;
    parts.push("");
    parts.push("## Multimodal");
    if (visionCapable) {
      parts.push("- You can DIRECTLY see and analyze images that users send in the conversation.");
      parts.push("- User-sent images are already embedded in the message as base64 \u2014 just describe/analyze them.");
      parts.push("- Do NOT call vision_analyze for user-sent images. That tool is ONLY for analyzing images from URLs or local file paths.");
    } else {
      parts.push("- Current model does NOT support image analysis.");
      parts.push("- If users send images, politely inform them and suggest switching to a vision-capable model (e.g. Kimi K2.5, GLM-5V, Qwen-Plus).");
    }

    return `<state>\n${parts.join("\n")}\n</state>`;
  }

  // ─── OS & Environment Detection (学 OpenClaw resolveOsSummary + Hermes build_environment_hints) ──

  /** Resolve a human-readable OS label: "windows 10.0.26100 (x64)" | "macos 15.4 (arm64)" | "linux 6.1.0 (x64)" */
  private static resolveOsLabel(): string {
    const platform = os.platform();
    const arch = os.arch();
    const release = os.release();
    if (platform === "darwin") {
      // Try sw_vers for friendlier macOS version (like OpenClaw)
      try {
        const ver = execFileSync("sw_vers", ["-productVersion"], { encoding: "utf-8", timeout: 3000 }).trim();
        if (ver) return `macos ${ver} (${arch})`;
      } catch { /* fallback */ }
      return `macos ${release} (${arch})`;
    }
    if (platform === "win32") {
      return `windows ${release} (${arch})`;
    }
    return `${platform} ${release} (${arch})`;
  }

  /** Detect the active shell: "PowerShell 7.x" | "PowerShell 5.1" | "zsh" | "bash" | "sh" */
  private static _cachedShell: string | null = null;
  private static detectShell(): string {
    if (PromptEngine._cachedShell) return PromptEngine._cachedShell;
    const platform = os.platform();

    if (platform === "win32") {
      // Check for PowerShell 7+ (pwsh), fallback to 5.1
      try {
        const ver = execFileSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
          encoding: "utf-8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        PromptEngine._cachedShell = `PowerShell ${ver} (pwsh)`;
        return PromptEngine._cachedShell;
      } catch { /* pwsh not available */ }
      PromptEngine._cachedShell = "PowerShell 5.1 (powershell)";
      return PromptEngine._cachedShell;
    }

    // Unix: check SHELL env, fallback to sh
    const shellEnv = process.env.SHELL ?? "";
    const shellName = shellEnv.split("/").pop() ?? "sh";
    PromptEngine._cachedShell = shellName;
    return PromptEngine._cachedShell;
  }

  /**
   * Build environment-specific hints (学 Hermes build_environment_hints).
   * Detects WSL, Docker, Termux, etc. and returns guidance for the LLM.
   */
  private static buildEnvironmentHints(): string {
    const hints: string[] = [];

    // WSL detection (学 Hermes WSL_ENVIRONMENT_HINT)
    if (PromptEngine.isWSL()) {
      hints.push(
        "You are running inside WSL (Windows Subsystem for Linux). " +
        "The Windows host filesystem is mounted under /mnt/ — /mnt/c/ is C:, /mnt/d/ is D:, etc. " +
        "When the user references Windows paths, translate to /mnt/ equivalents."
      );
    }

    // Windows-specific shell guidance
    if (os.platform() === "win32") {
      hints.push(
        "The host OS is Windows. Shell commands (run_shell) execute in PowerShell. " +
        "Use PowerShell syntax, NOT bash/sh. " +
        "Use semicolons (;) instead of && to chain commands. " +
        "Use Invoke-WebRequest instead of curl for HTTP requests."
      );
    }

    // Docker container detection
    if (PromptEngine.isDocker()) {
      hints.push(
        "You are running inside a Docker container. " +
        "Filesystem changes are ephemeral unless volumes are mounted."
      );
    }

    return hints.join("\n");
  }

  /** Detect WSL environment (学 Hermes is_wsl()). */
  private static isWSL(): boolean {
    if (os.platform() !== "linux") return false;
    try {
      const release = os.release().toLowerCase();
      if (release.includes("microsoft") || release.includes("wsl")) return true;
      const procVersion = fs.readFileSync("/proc/version", "utf-8").toLowerCase();
      return procVersion.includes("microsoft") || procVersion.includes("wsl");
    } catch { return false; }
  }

  /** Detect Docker container environment. */
  private static isDocker(): boolean {
    try {
      return fs.existsSync("/.dockerenv") ||
        (fs.existsSync("/proc/1/cgroup") && fs.readFileSync("/proc/1/cgroup", "utf-8").includes("docker"));
    } catch { return false; }
  }

  // ─── Active Features (L6.5b, 条件注入) ───────────────────────

  /**
   * 动态生成 ## Active Features 区块，仅列出当前会话实际启用的可选模块。
   *
   * 检测策略：
   * - 工具名前缀匹配 → 推断已加载的工具模块
   * - 平台配置 → IM 能力声明
   * - 环境变量 → Feature Flag 控制的功能
   *
   * 原则：只声明 Agent 真的能用的，不在工具列表里的不写。
   */
  private buildActiveFeatures(tools?: Map<string, ToolDefinition>): string {
    if (!tools || tools.size === 0) return "";

    const features: string[] = [];
    const toolNames = Array.from(tools.keys());
    const hasPrefix = (prefix: string) => toolNames.some((n) => n.startsWith(prefix));

    // ── 浏览器 ──
    if (toolNames.some((n) => n.startsWith("browser_"))) {
      features.push("- Browser: Playwright web automation (navigate, click, type, screenshot)");
    }

    // ── 图片生成 ──
    if (hasPrefix("image_generate") || hasPrefix("image_edit")) {
      features.push("- Image Gen: Seedream text-to-image");
    }

    // ── 语音 ──
    if (hasPrefix("tts_") || hasPrefix("stt_")) {
      features.push("- Voice: TTS speech synthesis + STT transcription");
    }

    // ── 视频生成 ──
    if (toolNames.some((n) => n.startsWith("forge_"))) {
      features.push("- Video Forge: image/video/TTS/frame-compose/concat/BGM");
    }

    // ── 数据处理 ──
    if (hasPrefix("csv_") || hasPrefix("xlsx_") || hasPrefix("regex_") || hasPrefix("hash_") || hasPrefix("text_diff")) {
      features.push("- Data: CSV/XLSX/regex/diff/hash transform");
    }

    // ── 媒体处理 ──
    if (hasPrefix("pdf_") || hasPrefix("markdown_") || hasPrefix("qr")) {
      features.push("- Media: PDF extract, Markdown render, QR code");
    }

    // ── 视觉分析 ──
    if (hasPrefix("vision_") || hasPrefix("ocr_")) {
      features.push("- Vision: image analysis + OCR extraction");
    }

    // ── 知识库 ──
    if (hasPrefix("kb_")) {
      features.push("- Knowledge Base: semantic search across indexed documents");
    }

    // ── 桌面控制 ──
    if (toolNames.some((n) =>
      n.startsWith("mouse_") || n.startsWith("keyboard_") ||
      n.startsWith("window_") || n.startsWith("app_") || n.startsWith("screen_"),
    )) {
      features.push("- Desktop Control: mouse/keyboard/window/app/screen");
    }

    // ── Computer Use ──
    if (hasPrefix("computer_use")) {
      features.push("- Computer Use: autonomous GUI automation loop (screenshot→analyze→act)");
    }

    // ── SysOps ──
    if (toolNames.some((n) =>
      n.startsWith("terminal") || n.startsWith("docker_") || n.startsWith("service_") ||
      n.startsWith("network_") || n.startsWith("monitor_") || n.startsWith("deploy_"),
    )) {
      features.push("- SysOps: terminal/Docker/service/network/monitor/deploy");
    }

    // ── Git 高级 ──
    if (toolNames.some((n) => n.startsWith("git_") && !["git_status", "git_log", "git_diff", "git_commit"].includes(n))) {
      features.push("- Git Advanced: branching, merging, rebasing");
    }

    // ── 开发辅助 ──
    if (hasPrefix("package_") || hasPrefix("test_") || hasPrefix("env_manage")) {
      features.push("- Dev Tools: package management, test/build, environment");
    }

    // ── 定时任务 / 心跳 ──
    if (this.config.heartbeatEnabled) {
      features.push("- Cron Scheduler: natural language task scheduling via cron expressions");
    }

    // ── IM 平台（仅当运行在对应渠道时注入）──
    const platform = this.config.platform?.toLowerCase();
    if (platform === "feishu") {
      features.push("- Feishu: event routing, card actions, rich text, rate limiting, webhook verification");
    } else if (platform === "wecom") {
      features.push("- WeCom: streaming responses, chunked upload (512KB), Markdown adaptation, AES encryption");
    } else if (platform === "dingtalk") {
      features.push("- DingTalk: Markdown + ActionCard, @mention support");
    }

    if (features.length === 0) return "";

    return `## Active Features\n${features.join("\n")}`;
  }

  // ─── Cache Key ─────────────────────────────────────────────

  private computeCacheKey(tools?: Map<string, ToolDefinition>): string {
    const cfg = this.config.agentConfig;
    const toolNames = tools ? Array.from(tools.keys()).sort().join(",") : "";
    return `${cfg.id}|${cfg.llmProvider.model}|${this.config.platform ?? ""}|${toolNames}|${this.config.promptMode ?? "full"}`;
  }
}
