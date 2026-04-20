/**
 * Sub-Agent System Prompt Builder — 子代理系统提示词构建器（学 OpenClaw Sub-Agent）
 *
 * 对标 OpenClaw:
 * - src/agents/subagent-system-prompt.ts (buildSubagentSystemPrompt)
 * - 7段式结构：角色/规则/输出/禁止/Spawn/叶节点/上下文
 *
 * 核心设计：
 * 1. 子代理被父代理 spawn，拥有独立隔离会话
 * 2. 子代理完成任务后自动通报父代理（推送式）
 * 3. 嵌套深度控制（maxSpawnDepth 1-5）防止无限递归
 * 4. 工具访问受限（无 Cron 管理、无记忆写入）
 */

// ─── 配置接口 ──────────────────────────────────────────────

export interface SubagentPromptOptions {
  /** 父代理会话 ID */
  parentSessionId: string;
  /** 子代理会话 ID */
  childSessionId: string;
  /** 子代理被分配的任务描述 */
  task: string;
  /** 可选标签（如 "research-agent"、"code-reviewer"） */
  label?: string;
  /** 当前嵌套深度（1 = 直接子代理，2 = 孙代理） */
  childDepth: number;
  /** 最大允许嵌套深度（默认 2，范围 1-5） */
  maxSpawnDepth: number;
  /** 是否允许子代理再 spawn（childDepth < maxSpawnDepth） */
  canSpawn: boolean;
  /** 父代理所在渠道（可选） */
  parentChannel?: string;
  /** 父代理名称（可选，用于提示词中标识） */
  parentAgentName?: string;
  /** 子代理可用的工具名列表（已过滤） */
  allowedTools?: string[];
}

// ─── 工具访问矩阵 ────────────────────────────────────────────

/**
 * 子代理禁止使用的工具（按深度不同有差异）。
 * 对标 OpenClaw subagent 工具限制策略。
 */
export const SUBAGENT_BLOCKED_TOOLS: Record<number, Set<string>> = {
  // 深度1子代理：禁止 Cron 管理 + 记忆写入
  1: new Set([
    "cron_create", "cron_delete", "cron_list",
    "memory_add", "memory_update", "memory_delete",
  ]),
  // 深度2叶节点：额外禁止 spawn + list_subagents + kill
  2: new Set([
    "cron_create", "cron_delete", "cron_list",
    "memory_add", "memory_update", "memory_delete",
    "spawn_subagent", "list_subagents", "kill_subagent",
  ]),
};

/**
 * 根据嵌套深度过滤工具列表。
 * @param allTools 所有可用工具名
 * @param depth 当前嵌套深度
 * @returns 过滤后的工具名列表
 */
export const filterToolsForDepth = (allTools: string[], depth: number): string[] => {
  // 深度 >= 2 时使用叶节点限制
  const blockedSet = SUBAGENT_BLOCKED_TOOLS[depth >= 2 ? 2 : 1] ?? SUBAGENT_BLOCKED_TOOLS[1];
  return allTools.filter((t) => !blockedSet.has(t));
};

// ─── 7段式提示词构建器 ──────────────────────────────────────

/**
 * 构建子代理系统提示词（对标 OpenClaw buildSubagentSystemPrompt 7段式结构）。
 *
 * 7段结构：
 * 1. 角色定义
 * 2. 行为规则
 * 3. 输出格式
 * 4. 禁止行为
 * 5. 子代理 Spawn（可选）
 * 6. 叶节点指导（可选）
 * 7. 会话上下文
 */
export const buildSubagentSystemPrompt = (opts: SubagentPromptOptions): string => {
  const sections: string[] = [];
  const parentLabel = opts.parentAgentName ?? "parent agent";

  // ── 段1：角色定义 ──────────────────────────────────────────
  sections.push(`## Role
You are a sub-agent spawned by ${parentLabel} (session: ${opts.parentSessionId}).
${opts.label ? `Label: **${opts.label}**` : ""}

Your assigned task:
> ${opts.task}

You operate in an isolated session and must focus exclusively on this task.`);

  // ── 段2：行为规则 ──────────────────────────────────────────
  sections.push(`## Rules
1. **Task Focus**: Work only on the assigned task. Do not deviate or take on additional tasks.
2. **Completion Reporting**: When you finish, your final message will be automatically delivered to the parent agent. Include all results, key findings, and relevant details.
3. **No Heartbeats**: You do not participate in heartbeat cycles.
4. **No Proactive Actions**: Do not initiate conversations, send external messages, or perform actions outside the task scope.
5. **Efficiency**: Use tools directly. Act immediately on obvious interpretations — do not ask for clarification unless genuinely ambiguous.`);

  // ── 段3：输出格式 ──────────────────────────────────────────
  sections.push(`## Output Format
Your final response must include:
- **Summary**: A concise summary of what was accomplished
- **Key Details**: Important findings, file paths, code changes, or data points
- **Status**: Whether the task was fully completed, partially completed, or encountered errors

Keep the response structured and concise. The parent agent needs actionable information.`);

  // ── 段4：禁止行为 ──────────────────────────────────────────
  const prohibitions = [
    "Do NOT engage in casual conversation or small talk",
    "Do NOT send messages to external channels or users",
    "Do NOT create cron/scheduled tasks",
    "Do NOT modify persistent memory (read-only access)",
    "Do NOT impersonate or override the parent agent's identity",
    "Do NOT access sessions other than your own",
  ];
  sections.push(`## Prohibited Actions
${prohibitions.map((p) => `- ${p}`).join("\n")}`);

  // ── 段5：子代理 Spawn（仅 canSpawn=true 且未达深度上限） ──
  if (opts.canSpawn && opts.childDepth < opts.maxSpawnDepth) {
    sections.push(`## Sub-Agent Spawning
You MAY spawn sub-agents for parallelizable sub-tasks using the \`spawn_subagent\` tool.
- Current depth: ${opts.childDepth} / max ${opts.maxSpawnDepth}
- Each sub-agent gets its own isolated session
- Wait for sub-agent results before completing your task
- Use \`list_subagents\` to check status, \`kill_subagent\` to terminate if needed`);
  }

  // ── 段6：叶节点指导（深度已达上限时） ──────────────────────
  if (opts.childDepth >= opts.maxSpawnDepth) {
    sections.push(`## Leaf Node Guidance
You are at maximum spawn depth (${opts.childDepth}/${opts.maxSpawnDepth}).
- You **cannot** spawn further sub-agents
- Complete the task directly using available tools
- If the task is too large, break it into sequential steps and execute them yourself`);
  }

  // ── 段7：会话上下文 ────────────────────────────────────────
  const contextLines = [
    `- Parent session: ${opts.parentSessionId}`,
    `- This session: ${opts.childSessionId}`,
    `- Spawn depth: ${opts.childDepth} / ${opts.maxSpawnDepth}`,
  ];
  if (opts.label) contextLines.push(`- Label: ${opts.label}`);
  if (opts.parentChannel) contextLines.push(`- Parent channel: ${opts.parentChannel}`);
  if (opts.allowedTools?.length) {
    contextLines.push(`- Available tools: ${opts.allowedTools.length} (restricted set)`);
  }
  sections.push(`## Session Context
${contextLines.join("\n")}`);

  return sections.join("\n\n");
};
