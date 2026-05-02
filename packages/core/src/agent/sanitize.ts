/**
 * Agent 状态脱敏工具 — 零信任原则确保 apiKey 不出 core。
 *
 * 背景（SEC-P0-04）：
 *   AgentRuntime.get state() 返回 config.llmProvider 里的原始 apiKey；
 *   API 层多处直接 `return { agent: runtime.state }`，导致明文 Key 泄露。
 *   本模块提供统一的深拷贝脱敏入口，任何 API 响应都必须先过一遍。
 */

import type { AgentState } from "../types/index.js";

/**
 * 脱敏 API Key：保留前 3 后 3 字符，中间用 `***...` 遮蔽。
 * 同时导出给 api/routes/models.ts 等处复用，消除本地重复实现（M1）。
 */
export function maskApiKey(key: string): string {
  if (!key || key.length < 8) return key ? "***" : "";
  return key.slice(0, 3) + "***..." + key.slice(-3);
}

/**
 * 对单个 AgentState 脱敏：深拷贝 config，并将 llmProvider.apiKey 替换为掩码。
 * 只触碰 apiKey 字段，其他字段保持原引用，开销可控。
 */
export function sanitizeAgentState(state: AgentState): AgentState {
  // 通过 unknown 中转规避 AgentConfig 与 Record 的强类型断言告警，
  // AgentConfig 定义的是命名字段的结构，此处仅用于浅拷贝 + 替换 apiKey。
  const rawConfig = state.config as unknown as Record<string, unknown> | undefined;
  if (!rawConfig) return state;

  const config: Record<string, unknown> = { ...rawConfig };
  const llmRaw = config.llmProvider;
  if (llmRaw && typeof llmRaw === "object") {
    const llm: Record<string, unknown> = { ...(llmRaw as Record<string, unknown>) };
    if (typeof llm.apiKey === "string" && llm.apiKey) {
      llm.apiKey = maskApiKey(llm.apiKey);
    }
    config.llmProvider = llm;
  }

  return {
    ...state,
    config: config as unknown as AgentState["config"],
  };
}

/** 批量脱敏。 */
export function sanitizeAgentStates(states: AgentState[]): AgentState[] {
  return states.map(sanitizeAgentState);
}

/**
 * 脱敏串识别：前端 GET 到脱敏后的 apiKey，若原样 PUT 回来会污染 DB。
 *
 * 判别规则（命中任一条即为脱敏串）：
 *   1. 命中通用脱敏 pattern `***...`
 *   2. 精确等于当前 record 的脱敏回显（作为 pattern 未覆盖时的兜底）
 */
export function isMaskedApiKey(value: string, originalMasked?: string): boolean {
  if (!value) return false;
  if (/\*\*\*\.\.\./.test(value)) return true;
  if (originalMasked && value === originalMasked) return true;
  return false;
}
