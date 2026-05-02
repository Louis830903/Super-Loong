/**
 * Tool-call JSON 参数校验工具函数。
 *
 * 背景（P0-Qwen400-FIX）：
 *   LLM（尤其是 Qwen/DeepSeek 等代码类模型）在调用 write_file 等工具时，
 *   若 `content` 字段里嵌入长 JSON 或含未转义的 `"`、`\`、换行符，
 *   会导致 `function.arguments` 字符串本身不是合法 JSON。
 *   若将此破损 tool_call 原样再发给 Qwen 服务端，会触发
 *   `400 InternalError.Algo.InvalidParameter: function.arguments must be JSON`
 *   死循环，整条流水线被挡在第一个 agent。
 *
 * 本模块提供两道防线所需的纯函数：
 *   1. Runtime 层（agent/runtime.ts）：在 LLM 返回 tool_calls 后立即分拣，
 *      破损 tool_call 不进入 session.messages，改以 user 消息反馈让 LLM 重试；
 *   2. Provider 层（llm/provider.ts）：发送前再扫一遍（双保险），
 *      任何破损 tool_call 直接丢弃，保证出站 payload 100% 合法。
 *
 * 设计原则：纯函数、无副作用、零依赖，便于单元测试与跨层复用。
 */

import type { LLMToolCall } from "../types/index.js";

/** 破损 tool_call 诊断信息 */
export interface InvalidToolCall {
  toolCall: LLMToolCall;
  /** JSON.parse 抛出的错误消息（便于日志定位 position/line/column） */
  error: string;
}

/** 分拣结果：合法与破损分两组 */
export interface ToolCallPartition {
  valid: LLMToolCall[];
  invalid: InvalidToolCall[];
}

/**
 * 按 arguments 是否为合法 JSON 把一批 tool_calls 分为 valid / invalid 两组。
 *
 * 注意：这里只校验合法性，不缓存解析结果。上游 executeTool 会再 parse 一次，
 * 额外成本在 JSON 解析层面基本可忽略（相比一次 LLM 往返）。
 */
export function partitionToolCallsByJsonValidity(
  toolCalls: readonly LLMToolCall[],
): ToolCallPartition {
  const valid: LLMToolCall[] = [];
  const invalid: InvalidToolCall[] = [];
  for (const tc of toolCalls) {
    try {
      JSON.parse(tc.function.arguments);
      valid.push(tc);
    } catch (err) {
      invalid.push({
        toolCall: tc,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { valid, invalid };
}

/**
 * 构造反馈给 LLM 的"参数非法请重试"消息文本。
 * 明确告知 LLM 哪个工具的 arguments 错在哪里，并提醒 JSON 转义规则。
 *
 * 设计要点：
 *   - 消息以 [SYSTEM] 前缀标识来源（模拟系统提示，提高 LLM 遵从度）
 *   - 列出所有破损工具名 + 具体解析错误（position/column 等）
 *   - 明确列举最容易漏转义的字符（含中文引号易混淆点）
 */
export function buildInvalidToolCallRejectMessage(
  invalid: readonly InvalidToolCall[],
): string {
  const lines = invalid.map(
    (i) =>
      `- 工具「${i.toolCall.function.name}」的 arguments 不是合法 JSON：${i.error}`,
  );
  return (
    `[SYSTEM] 你上一轮尝试调用了以下工具，但 function.arguments 字段不是合法的 JSON，` +
    `已被系统拒绝（未执行、未进入对话历史）：\n${lines.join("\n")}\n\n` +
    `请重新调用。注意：arguments 必须是合法 JSON 字符串，如果某个字段（如 content）包含` +
    `引号 "、反斜杠 \\、换行、制表符等特殊字符，必须严格按 JSON 规范转义` +
    `（例如 \\"、\\\\、\\n、\\t）。`
  );
}
