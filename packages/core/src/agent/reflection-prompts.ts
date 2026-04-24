/**
 * reflection-prompts.ts — ReflectionEngine 使用的 Prompt 模板
 *
 * 设计原则：
 *   - 只输出 JSON，便于解析，避免自由文本污染主对话
 *   - 字段与 ReflectionResult 严格对齐（category / strategy / suggestion / shouldRetry）
 *   - 中文建议不超过 80 字，作为 system 弱引导消息注入，允许主 LLM 忽略
 *
 * 与 hello-agents ReflectionAgent 的区别：
 *   - hello-agents 是「答案质量」反思（initial → reflect → refine）
 *   - 本方案是「工具失败自愈」反思（本土化场景：工具调用报错后给出修复建议）
 */

/**
 * 反思系统提示词（作为 LLM 反思调用的 system 消息）
 *
 * 约束：
 *   1. 必须返回合法 JSON（解析失败则降级为 null，主流程不受影响）
 *   2. 五种失败类别覆盖常见场景（参数/工具/外部/逻辑/意图歧义）
 *   3. 四种策略与主 Agent 的下一步动作一一映射
 */
export const REFLECTION_SYSTEM_PROMPT = `你正在进行工具调用失败的复盘分析。请按以下结构回复 JSON：

{
  "category": "param_error | wrong_tool | external_error | logic_error | ambiguous",
  "strategy": "retry_with_fix | switch_tool | ask_user | give_up",
  "suggestion": "<给主 Agent 的一句话引导，中文，不超过 80 字>",
  "shouldRetry": true | false
}

判断要点：
- param_error：参数格式/取值错（如路径不存在、JSON 不合法）→ 通常 retry_with_fix
- wrong_tool：工具能力不匹配任务（如用 read_file 读目录）→ 通常 switch_tool
- external_error：外部依赖故障（网络/服务/权限）→ 视情况 retry 或 give_up
- logic_error：调用顺序错（如未鉴权就读取）→ 必须 switch_tool 或先调前置工具
- ambiguous：用户意图不清 → 必须 ask_user

只输出 JSON，不要任何其他文字。`;

/**
 * 构造反思 user 消息内容
 *
 * @param toolName     失败的工具名
 * @param args         调用参数（将被 JSON 序列化并截断至 500 字符内）
 * @param error        失败信息（截断至 500 字符内）
 * @param recentSteps  近 N 步动作摘要，帮助 LLM 判断上下文（由调用方组装）
 */
export const buildReflectionPrompt = (
  toolName: string,
  args: unknown,
  error: string,
  recentSteps: string,
): string => {
  // 安全序列化参数：循环引用/不可序列化值降级为字符串
  let argsText: string;
  try {
    argsText = JSON.stringify(args);
  } catch {
    argsText = String(args);
  }
  return [
    `工具：${toolName}`,
    `参数：${argsText.slice(0, 500)}`,
    `失败信息：${(error ?? "").slice(0, 500)}`,
    `近 3 步动作：${recentSteps || "(无)"}`,
  ].join("\n");
};
