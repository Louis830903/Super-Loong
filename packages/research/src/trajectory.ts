/**
 * Trajectory 生成 — ShareGPT 格式导出
 *
 * 参考 Hermes batch_runner.py 的 trajectory 格式：
 * - ShareGPT 标准格式
 * - 包含工具调用信息
 * - 支持元数据标注
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import pino from "pino";
import type { TaskResult } from "./batch-runner.js";

const logger = pino({ name: "research:trajectory" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** ShareGPT 消息格式 */
export interface ShareGPTMessage {
  from: "system" | "human" | "gpt";
  value: string;
  tool_calls?: Array<{
    name: string;
    arguments: Record<string, unknown>;
    result?: string;
  }>;
}

/** ShareGPT Trajectory */
export interface Trajectory {
  id: string;
  conversations: ShareGPTMessage[];
  metadata: {
    tools_used: string[];
    success: boolean;
    duration_ms: number;
    token_usage?: { prompt: number; completion: number };
    timestamp: string;
    [key: string]: unknown;
  };
}

/** 导出配置 */
export interface TrajectoryExportConfig {
  format: "sharegpt" | "jsonl";
  includeSystem: boolean;
  includeToolCalls: boolean;
  maxConversationLength: number;
}

// ═══════════════════════════════════════════════════════════════
// Trajectory Generator
// ═══════════════════════════════════════════════════════════════

export class TrajectoryGenerator {
  private trajectories: Trajectory[] = [];
  private config: TrajectoryExportConfig;

  constructor(config?: Partial<TrajectoryExportConfig>) {
    this.config = {
      format: config?.format ?? "sharegpt",
      includeSystem: config?.includeSystem ?? true,
      includeToolCalls: config?.includeToolCalls ?? true,
      maxConversationLength: config?.maxConversationLength ?? 50,
    };
  }

  /**
   * 从任务结果生成 trajectory
   */
  addFromResult(
    taskInput: string,
    result: TaskResult,
    systemPrompt?: string
  ): Trajectory {
    const messages: ShareGPTMessage[] = [];

    if (this.config.includeSystem && systemPrompt) {
      messages.push({ from: "system", value: systemPrompt });
    }

    messages.push({ from: "human", value: taskInput });

    const gptMessage: ShareGPTMessage = {
      from: "gpt",
      value: result.output,
    };

    if (this.config.includeToolCalls && result.toolCalls?.length) {
      gptMessage.tool_calls = result.toolCalls.map((name) => ({
        name,
        arguments: {},
      }));
    }

    messages.push(gptMessage);

    const trajectory: Trajectory = {
      id: result.taskId,
      conversations: messages,
      metadata: {
        tools_used: result.toolCalls ?? [],
        success: result.success,
        duration_ms: result.durationMs,
        token_usage: result.tokenUsage,
        timestamp: result.timestamp.toISOString(),
      },
    };

    this.trajectories.push(trajectory);
    return trajectory;
  }

  /**
   * 导出为文件
   */
  export(filePath: string): void {
    const dir = dirname(filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    if (this.config.format === "jsonl") {
      const lines = this.trajectories.map((t) => JSON.stringify(t)).join("\n");
      writeFileSync(filePath, lines + "\n", "utf-8");
    } else {
      writeFileSync(filePath, JSON.stringify(this.trajectories, null, 2), "utf-8");
    }

    logger.info({ path: filePath, count: this.trajectories.length }, "Trajectory 已导出");
  }

  /** 获取所有 trajectory */
  getAll(): Trajectory[] {
    return [...this.trajectories];
  }

  /** 按成功/失败过滤 */
  getBySuccess(success: boolean): Trajectory[] {
    return this.trajectories.filter((t) => t.metadata.success === success);
  }

  /** 统计 */
  getStats(): {
    total: number;
    successful: number;
    failed: number;
    avgDurationMs: number;
    uniqueTools: number;
  } {
    const successful = this.trajectories.filter((t) => t.metadata.success).length;
    const durations = this.trajectories.map((t) => t.metadata.duration_ms);
    const allTools = new Set(this.trajectories.flatMap((t) => t.metadata.tools_used));

    return {
      total: this.trajectories.length,
      successful,
      failed: this.trajectories.length - successful,
      avgDurationMs: durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      uniqueTools: allTools.size,
    };
  }

  /** 清空 */
  clear(): void {
    this.trajectories = [];
  }
}
