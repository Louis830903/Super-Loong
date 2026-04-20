/**
 * PromptEngine — 10-layer system prompt assembler with caching.
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
import {
  TOOL_USE_ENFORCEMENT,
  MEMORY_GUIDANCE,
  SKILLS_GUIDANCE_HEADER,
  SAFETY_GUARDRAILS,
  CAPABILITIES_OVERVIEW,
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

      // L5: Skills Guidance (when skills are loaded)
      const skillsXml = this.buildSkillsList();
      if (skillsXml) {
        parts.push(SKILLS_GUIDANCE_HEADER);
        parts.push(skillsXml);
      }

      // L6: Safety Guardrails
      parts.push(SAFETY_GUARDRAILS);

      // L6.5: Capabilities Overview (让 Agent 完整知道自己能做什么)
      parts.push(CAPABILITIES_OVERVIEW);

      // L6.6: 心跳指导（Phase 1: 学 OpenClaw heartbeat-system-prompt.ts 条件注入）
      if (this.config.heartbeatEnabled) {
        parts.push(HEARTBEAT_SYSTEM_SECTION);
      }
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
      // L7: Core Memory Blocks
      const memoryXml = this.buildMemorySection();
      if (memoryXml) parts.push(memoryXml);

      // L7.5: Markdown Memory Files (MEMORY.md / USER.md / SOUL.md — Hermes pattern)
      // B-1: 使用冻结快照，确保 session 内 system prompt 稳定（学 Hermes _system_prompt_snapshot）
      if (this.config.markdownMemory) {
        const mdBlock = this.config.markdownMemory.getFrozenPromptBlock();
        if (mdBlock) parts.push(mdBlock);
      }

      // L8: Project Context Files (cached with TTL to avoid sync IO per turn)
      const now = Date.now();
      if (
        this._cachedContextFiles === null ||
        now - this._contextFilesCachedAt > PromptEngine.CONTEXT_FILES_TTL_MS
      ) {
        this._cachedContextFiles = discoverContextFiles(this.config.contextFilesRoot);
        this._contextFilesCachedAt = now;
      }
      if (this._cachedContextFiles) parts.push(this._cachedContextFiles);
    }

    // L9: Available Tools + Session Info + Runtime Environment
    parts.push(this.buildRuntimeSection(session, tools));

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

  private buildMemorySection(): string {
    const mm = this.config.memoryManager;
    if (!mm) return "";

    const agentId = this.config.agentConfig.id;
    // B-1: 使用冻结快照，确保 session 内 Core Memory 稳定
    const coreXml = mm.getFrozenCoreMemory(agentId);
    if (!coreXml) return "";

    return `## Persistent Memory\n${coreXml}`;
  }

  private buildRuntimeSection(
    session: Session,
    tools?: Map<string, ToolDefinition>,
  ): string {
    const parts: string[] = [];
    const cfg = this.config.agentConfig;

    // Available tools summary (compact: name only, full schema sent via toolDefs)
    if (tools && tools.size > 0) {
      parts.push(`## Tools (${tools.size})`);
      // Only list tool names — descriptions are already in the tool definitions JSON
      const toolNames = Array.from(tools.keys()).join(", ");
      parts.push(toolNames);
      parts.push("");
    }

    // Runtime environment (enhanced — follows OpenClaw buildSystemPromptParams + Hermes build_environment_hints)
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toISOString().slice(0, 19).replace("T", " ");
    const osLabel = PromptEngine.resolveOsLabel();
    const shellLabel = PromptEngine.detectShell();
    const envHints = PromptEngine.buildEnvironmentHints();

    parts.push("## Runtime");
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

    return parts.join("\n");
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

  // ─── Cache Key ─────────────────────────────────────────────

  private computeCacheKey(tools?: Map<string, ToolDefinition>): string {
    const cfg = this.config.agentConfig;
    const toolNames = tools ? Array.from(tools.keys()).sort().join(",") : "";
    return `${cfg.id}|${cfg.llmProvider.model}|${this.config.platform ?? ""}|${toolNames}|${this.config.promptMode ?? "full"}`;
  }
}
