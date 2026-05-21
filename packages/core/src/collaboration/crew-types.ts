/**
 * Crew 任务编排类型定义（B3 上帝文件拆分 — 从 orchestrator.ts 提取）。
 *
 * 包含 CrewAI 风格任务编排所需的全部类型：
 *   - CollabMessage / ProcessType / CodeTaskContext / CodeTaskResult
 *   - CrewTask / CrewConfig / TaskOutput / CrewResult
 */

import type { Attachment, LLMProviderConfig } from "../types/index.js";

// ─── Shared Types ────────────────────────────────────────────

export interface CollabMessage {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: "task_output" | "chat" | "system" | "handoff";
  timestamp: Date;
  metadata?: Record<string, unknown>;
  /** 消息携带的文件附件列表（可选） */
  attachments?: Attachment[];
}

export type ProcessType = "sequential" | "hierarchical";

/**
 * P0-D: Code Node 上下文。
 * Code Task 执行时 orchestrator 注入的只读上下文，避免 handler 直接访问内部状态。
 */
export interface CodeTaskContext {
  /** 当前任务 ID */
  taskId: string;
  /** 所属 Crew ID */
  crewId: string;
  /** 上游 task 输出只读视图（key = taskId, value = output 字符串） */
  outputMap: ReadonlyMap<string, string>;
  /** 当前协作的工作空间目录（可能不存在） */
  workspaceDir: string | undefined;
  /** Crew 配置中的变量注入（对应 {{key}} 占位符的原值） */
  inputs: Record<string, string> | undefined;
  /** 中止信号，handler 在长任务中应当定期检查 */
  signal: AbortSignal | undefined;
}

/** P0-D: Code Node 执行结果 */
export interface CodeTaskResult {
  /** 输出字符串（建议为 JSON），会经过 guardrail 校验并注入下游 outputMap */
  output: string;
  /** 可选的文件附件（图片、音频、视频等） */
  attachments?: Attachment[];
}

export interface CrewTask {
  id: string;
  description: string;
  expectedOutput: string;
  /** 执行该任务的 Agent ID（hierarchical + autoAssign 模式下可省略，由 Manager 自动分配） */
  agentId?: string;
  /** 任务所需能力的提示词（辅助 Manager 匹配，可选） */
  requiredCapabilities?: string[];
  /** IDs of prerequisite tasks whose output feeds as context */
  context?: string[];
  /** If true, can run in parallel with other async tasks */
  async?: boolean;
  /** Optional guardrail validation for the output */
  guardrail?: (output: string) => { valid: boolean; feedback?: string };
  /** E-2: 是否通过子代理执行（而非直接 agent.chat） */
  useSubagent?: boolean;
  /** E-2: 子代理超时（毫秒），默认等于 taskTimeoutMs */
  subagentTimeout?: number;
  /**
   * P0-D: 执行模式。"llm"（默认）走 agent.chat 由 LLM 执行；
   * "code" 走 codeHandler 由确定性代码执行，适合循环调工具等机械任务。
   */
  executor?: "llm" | "code";
  /**
   * P0-D: Code Node 处理函数。executor === "code" 时必须提供。
   * handler 内部应自行处理并发/重试等细节；抛错会被 orchestrator 按 maxRetries 重试。
   */
  codeHandler?: (ctx: CodeTaskContext) => Promise<CodeTaskResult>;
}

export interface CrewConfig {
  id?: string;
  name: string;
  description?: string;
  process: ProcessType;
  tasks: CrewTask[];
  /** For hierarchical mode: the agent that manages task delegation */
  managerAgentId?: string;
  /** Maximum retry attempts per task on guardrail failure */
  maxRetries?: number;
  /** Variables to inject into task descriptions via {{key}} */
  inputs?: Record<string, string>;
  /** Verbose logging */
  verbose?: boolean;
  /** 单个任务的超时时间（毫秒），默认 3600000（1小时） */
  taskTimeoutMs?: number;
  /** 允许 Manager 自动分配 Agent（仅 hierarchical 模式生效，默认 false） */
  autoAssign?: boolean;
  /** 单次 Crew 最多动态创建 Agent 数（默认 30） */
  maxDynamicAgents?: number;
}

export interface TaskOutput {
  taskId: string;
  agentId: string;
  output: string;
  retries: number;
  durationMs: number;
  timestamp: Date;
  /** 任务产出的文件附件列表（可选） */
  attachments?: Attachment[];
}

export interface CrewResult {
  /** G-1: Discriminated Union 标识 */
  type: "crew";
  crewId: string;
  name: string;
  process: ProcessType;
  status: "completed" | "failed" | "partial" | "cancelled";
  taskOutputs: TaskOutput[];
  finalOutput: string;
  totalDurationMs: number;
  error?: string;
  /** 所有任务产出的去重文件聚合（可选） */
  allAttachments?: Attachment[];
  /** 协作工作空间目录路径（成功和失败都有） */
  workspaceDir?: string;
}

// Re-export LLMProviderConfig for convenience (used by CrewExecutor)
export type { LLMProviderConfig };
