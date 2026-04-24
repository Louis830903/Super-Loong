/**
 * reflection.ts — 会话内即时反思引擎（ReflectionEngine）
 *
 * 借鉴自 hello-agents 的 ReflectionAgent 范式（执行 → 观察 → 反思 → 重执行），
 * 本土化为工具失败自愈场景：工具调用失败/低置信度时调用专用 prompt，
 * 让 LLM 分析失败原因并给出修复建议，作为 system 弱引导消息注入主对话。
 *
 * 与离线 Evolution/Nudge 的区别：
 *   - Nudge：跨会话、离线、生成技能/记忆提案
 *   - Reflection：当前会话内、在线、即时给出下一步修正建议
 *   - 两者互补不冲突：reflection.ts 写入的 InteractionCase 会带 metadata.source="reflection"
 *     供 evolution/engine.ts 去重，避免对同一失败重复生成技能提案
 *
 * 强约束（防死循环）：
 *   1. 单 turn 反思深度 ≤ maxReflectionDepth（默认 2）
 *   2. 同一工具连续失败 ≥ maxConsecutiveFailures（默认 3）后直接降级，不再反思
 *   3. 反思 LLM 调用设 15s 超时，超时/解析失败均降级为 null，不阻塞主流程
 *   4. enabled=false 或环境变量 REFLECTION_ENABLED=false 时直接返回 null
 */

import pino from "pino";
import type { LLMProvider } from "../llm/provider.js";
import type { LLMMessage } from "../types/index.js";
import { REFLECTION_SYSTEM_PROMPT, buildReflectionPrompt } from "./reflection-prompts.js";

const logger = pino({ name: "reflection-engine" });

/** 反思 LLM 调用的硬超时（毫秒）。超过则降级为 null，不阻塞主流程。 */
const REFLECTION_LLM_TIMEOUT_MS = 15_000;

// ─── 类型定义 ───────────────────────────────────────────────

/**
 * ReflectionEngine 配置。所有字段均可选，未提供时走默认值。
 */
export interface ReflectionConfig {
  /** 单 turn 最大反思深度，默认 2 */
  maxReflectionDepth: number;
  /** 同一工具连续失败上限，默认 3；超过则直接降级，不再反思 */
  maxConsecutiveFailures: number;
  /** 是否启用，默认读取 env REFLECTION_ENABLED；未设置则为 true */
  enabled: boolean;
  /** 触发条件：仅在显式失败 / 同时含低置信度。当前版本只实现 failure_only */
  triggerOn: "failure_only" | "failure_or_low_confidence";
}

/**
 * 反思结果。由 LLM 以 JSON 形式返回，经校验后供主 Agent 参考。
 */
export interface ReflectionResult {
  /** 失败类别：用于后续映射到 InteractionCase.failureCategory */
  category: "param_error" | "wrong_tool" | "external_error" | "logic_error" | "ambiguous";
  /** 推荐策略 */
  strategy: "retry_with_fix" | "switch_tool" | "ask_user" | "give_up";
  /** 给主 Agent 的一句话引导（中文，≤80 字），作为 system 消息注入 */
  suggestion: string;
  /** 是否建议立即重试（false 时主循环应尽快停手或转交用户） */
  shouldRetry: boolean;
}

/** reflect() 的可选扩展参数（保持向后兼容） */
export interface ReflectOptions {
  /** 近 N 步动作摘要，传给 LLM 帮助判断上下文 */
  recentSteps?: string;
}

// ─── 默认配置 ───────────────────────────────────────────────

/**
 * 解析环境变量 REFLECTION_ENABLED。
 * 约定：显式设为 "false" / "0" / "no" 才关闭，其他值均启用。
 */
function resolveEnabledFromEnv(): boolean {
  const raw = process.env.REFLECTION_ENABLED;
  if (raw === undefined) return true;
  const v = raw.trim().toLowerCase();
  return !(v === "false" || v === "0" || v === "no");
}

/** 默认配置工厂（每次调用返回新对象，避免意外共享） */
function buildDefaultConfig(): ReflectionConfig {
  return {
    maxReflectionDepth: 2,
    maxConsecutiveFailures: 3,
    enabled: resolveEnabledFromEnv(),
    triggerOn: "failure_only",
  };
}

// ─── 核心类 ─────────────────────────────────────────────────

export class ReflectionEngine {
  private config: ReflectionConfig;

  /** sessionId → toolName → 连续失败计数（工具成功时应清零，由外部调用 noteToolSuccess） */
  private failureCounters = new Map<string, Map<string, number>>();

  /** sessionId → 本 user turn 内已反思次数 */
  private depthCounters = new Map<string, number>();

  constructor(config?: Partial<ReflectionConfig>) {
    this.config = { ...buildDefaultConfig(), ...(config ?? {}) };
  }

  /** 只读访问：单测/外部观测用 */
  getConfig(): Readonly<ReflectionConfig> {
    return this.config;
  }

  /**
   * 工具失败后调用。内部会：
   *   1. 判定 enabled / 深度上限 / 连续失败上限，任一未过即返回 null
   *   2. 更新计数器
   *   3. 调 LLM（带超时/JSON 解析容错）
   *   4. 返回校验后的 ReflectionResult 或 null
   *
   * 关键：任何异常都降级为 null，保证主流程永不因反思失败中断。
   */
  async reflect(
    sessionId: string,
    toolName: string,
    args: unknown,
    error: string,
    llm: LLMProvider,
    options?: ReflectOptions,
  ): Promise<ReflectionResult | null> {
    // 1) 未启用：零成本直接返回
    if (!this.config.enabled) return null;

    // 2) 更新「本工具连续失败次数」
    const toolMap = this.ensureToolMap(sessionId);
    const prevFailures = toolMap.get(toolName) ?? 0;
    const curFailures = prevFailures + 1;
    toolMap.set(toolName, curFailures);

    // 3) 连续失败超限：直接降级，不再反思（省钱 + 防死循环）
    if (curFailures > this.config.maxConsecutiveFailures) {
      logger.warn(
        { sessionId, toolName, curFailures, limit: this.config.maxConsecutiveFailures },
        "tool consecutive failures exceed limit, skip reflection",
      );
      return null;
    }

    // 4) 本 turn 反思深度超限：直接降级
    const curDepth = (this.depthCounters.get(sessionId) ?? 0) + 1;
    if (curDepth > this.config.maxReflectionDepth) {
      logger.warn(
        { sessionId, curDepth, limit: this.config.maxReflectionDepth },
        "reflection depth exceed limit this turn, skip reflection",
      );
      return null;
    }
    this.depthCounters.set(sessionId, curDepth);

    // 5) 调 LLM（带超时容错）
    const userContent = buildReflectionPrompt(toolName, args, error, options?.recentSteps ?? "");
    const messages: LLMMessage[] = [
      { role: "system", content: REFLECTION_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REFLECTION_LLM_TIMEOUT_MS);
    try {
      const response = await llm.complete({
        messages,
        stream: false,
        signal: controller.signal,
      });
      const text = typeof response.content === "string" ? response.content : "";
      return this.parseResult(text);
    } catch (err) {
      // 超时 / 网络错 / Provider 抛错：全部降级为 null
      logger.warn({ sessionId, toolName, err }, "reflection LLM call failed, degrade to null");
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 每个 user turn 开始时调用，清空本 session 的反思深度计数。
   * 注意：不清理连续失败计数 —— 那是跨 turn 的累计。
   */
  resetTurnCounters(sessionId: string): void {
    this.depthCounters.delete(sessionId);
  }

  /**
   * 工具调用成功后调用，清零该工具的连续失败计数。
   * runtime.ts 在 executeTool 成功分支调用本方法。
   */
  noteToolSuccess(sessionId: string, toolName: string): void {
    const toolMap = this.failureCounters.get(sessionId);
    if (toolMap) toolMap.delete(toolName);
  }

  /** 会话结束时调用，避免内存泄漏 */
  disposeSession(sessionId: string): void {
    this.failureCounters.delete(sessionId);
    this.depthCounters.delete(sessionId);
  }

  // ─── 内部工具方法 ──────────────────────────────────────────

  private ensureToolMap(sessionId: string): Map<string, number> {
    let m = this.failureCounters.get(sessionId);
    if (!m) {
      m = new Map();
      this.failureCounters.set(sessionId, m);
    }
    return m;
  }

  /**
   * 解析 LLM 返回的 JSON 反思结果。
   *   - 支持外层被 ```json ... ``` 包裹的常见情况
   *   - 字段缺失/非法时返回 null（主流程继续走原失败分支）
   */
  private parseResult(raw: string): ReflectionResult | null {
    const text = this.stripCodeFence(raw).trim();
    if (!text) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // 兜底：从文本中抠出首个 { ... } 片段
      const match = text.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        parsed = JSON.parse(match[0]);
      } catch {
        return null;
      }
    }

    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;

    const category = this.validateCategory(obj.category);
    const strategy = this.validateStrategy(obj.strategy);
    const suggestion =
      typeof obj.suggestion === "string" ? obj.suggestion.trim().slice(0, 200) : "";
    const shouldRetry =
      typeof obj.shouldRetry === "boolean" ? obj.shouldRetry : strategy === "retry_with_fix";

    if (!category || !strategy || !suggestion) return null;

    return { category, strategy, suggestion, shouldRetry };
  }

  private stripCodeFence(text: string): string {
    // 去除 ```json ... ``` 或 ``` ... ``` 包裹
    const fenceMatch = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
    return fenceMatch ? fenceMatch[1] : text;
  }

  private validateCategory(v: unknown): ReflectionResult["category"] | null {
    const allowed = ["param_error", "wrong_tool", "external_error", "logic_error", "ambiguous"];
    return typeof v === "string" && allowed.includes(v)
      ? (v as ReflectionResult["category"])
      : null;
  }

  private validateStrategy(v: unknown): ReflectionResult["strategy"] | null {
    const allowed = ["retry_with_fix", "switch_tool", "ask_user", "give_up"];
    return typeof v === "string" && allowed.includes(v)
      ? (v as ReflectionResult["strategy"])
      : null;
  }
}
