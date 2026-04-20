/**
 * Model-specific execution guidance adapters.
 *
 * Each adapter matches a model name pattern and provides tailored guidance
 * to address known failure modes of that model family.
 *
 * Covers 4 Chinese LLMs (Kimi, Qwen, MiniMax, GLM) + DeepSeek + GPT + Claude.
 */

import {
  GPT_TOOL_ENFORCEMENT,
  GEMINI_TOOL_ENFORCEMENT,
  CHINESE_LLM_TOOL_ENFORCEMENT,
} from "./guidance.js";

export interface ModelAdapter {
  /** Human-readable adapter name */
  name: string;
  /** Test whether a model string matches this adapter */
  matches: (model: string) => boolean;
  /** Guidance text injected into L3 of the system prompt */
  guidance: string;
}

// ─── Kimi / Moonshot ────────────────────────────────────────

const KIMI_GUIDANCE = `# Execution guidance (Kimi/Moonshot)
<kimi_specific>
- Long context window does NOT mean you can skip tool verification — always confirm
  facts with tools even when you have extensive context.
- Keep single responses under 2000 characters unless the user explicitly asks for detail.
- When using function calling, ensure each tool call is atomic — do not batch unrelated
  operations into a single response.
- Kimi may lose track of deeply nested JSON; prefer flat argument structures.
- After receiving tool results, explicitly summarize what changed before proceeding.
</kimi_specific>`;

// ─── Qwen / Tongyi ──────────────────────────────────────────

const QWEN_GUIDANCE = `# Execution guidance (Qwen/Tongyi)
<qwen_specific>
- JSON tool arguments must be strictly valid — no trailing commas, no comments,
  no single quotes. Qwen sometimes truncates long function_call arguments; keep
  argument values concise.
- When a function_call is required, emit the COMPLETE tool call in one response —
  do not split it across multiple messages.
- Prefer explicit tool calls over inline code blocks when a matching tool exists.
- For multi-step tasks, execute one tool call at a time and verify each result
  before proceeding to the next step.
- Qwen may repeat previous tool outputs verbatim — always check whether the data
  is fresh from the current tool call.
</qwen_specific>`;

// ─── MiniMax / abab ─────────────────────────────────────────

const MINIMAX_GUIDANCE = `# Execution guidance (MiniMax)
<minimax_specific>
- After making a tool call, WAIT for the result before continuing — do not
  predict or assume tool output.
- Do not attempt multiple rounds of tool calls in a single response; issue one
  tool call, receive the result, then decide on the next action.
- Keep tool arguments short and well-structured — MiniMax performs best with
  concise, focused requests.
- When returning results to the user, distinguish clearly between your analysis
  and the raw tool output.
</minimax_specific>`;

// ─── GLM / ChatGLM / Zhipu ─────────────────────────────────

const GLM_GUIDANCE = `# Execution guidance (GLM/ChatGLM)
<glm_specific>
- In tool_call arguments, use ASCII punctuation only — no full-width commas (，),
  colons (：), quotes (""), or parentheses (（）).
- Parameter values must use standard double quotes ("), not Chinese quotes ("").
- GLM sometimes generates tool calls with extra whitespace or newlines in JSON —
  keep argument formatting compact and on one line when possible.
- When handling Chinese input, preserve the original text in tool arguments rather
  than translating to English.
- Verify tool call syntax before submission — GLM has a higher rate of malformed
  JSON in function calls.
</glm_specific>`;

// ─── GPT / Codex (OpenAI) ───────────────────────────────────

const GPT_GUIDANCE = `# Execution guidance (GPT/OpenAI)
<gpt_specific>
- Use tools whenever they improve correctness — do not stop early when another
  tool call would materially improve the result.
- If a tool returns empty or partial results, retry with a different query or
  strategy before giving up.
- Your memory and user profile describe the USER, not the system you are running on.
  The execution environment may differ from what the user profile says.
- Do not abandon work on partial results — keep calling tools until the task is
  fully complete and verified.
</gpt_specific>`;

// ─── DeepSeek ─────────────────────────────────────────────────

const DEEPSEEK_GUIDANCE = `# Execution guidance (DeepSeek)
<deepseek_specific>
- DeepSeek has strong reasoning ability but may overthink simple tasks — keep
  tool calls direct and avoid unnecessary chain-of-thought for straightforward operations.
- JSON arguments must be strictly valid — no trailing commas or comments.
- When using function calling, emit complete tool calls in one response.
- DeepSeek may switch between Chinese and English mid-response — maintain
  consistent language matching the user's input language.
- For code generation tasks, always verify output with tools before presenting.
</deepseek_specific>`;

// ─── Claude (Anthropic) ─────────────────────────────────────

const CLAUDE_GUIDANCE = `# Execution guidance (Claude)
<claude_specific>
- Prefer parallel tool calls when operations are independent — Claude handles
  concurrent tool execution well.
- When a task requires multiple file reads, batch them in a single response.
- Claude tends to be thorough but verbose — when the user asks for concise output,
  actively trim your response.
- For code generation, always verify the output compiles/runs before presenting it.
</claude_specific>`;

// ─── Adapter Registry ───────────────────────────────────────

export const MODEL_ADAPTERS: ModelAdapter[] = [
  {
    name: "kimi",
    matches: (m: string) => /moonshot|kimi/i.test(m),
    guidance: KIMI_GUIDANCE,
  },
  {
    name: "qwen",
    matches: (m: string) => /qwen|tongyi|dashscope/i.test(m),
    guidance: QWEN_GUIDANCE,
  },
  {
    name: "minimax",
    matches: (m: string) => /abab|minimax/i.test(m),
    guidance: MINIMAX_GUIDANCE,
  },
  {
    name: "glm",
    matches: (m: string) => /glm|chatglm|zhipu/i.test(m),
    guidance: GLM_GUIDANCE,
  },
  {
    name: "gpt",
    matches: (m: string) => /gpt|codex|\bo[134]-/i.test(m),
    guidance: GPT_GUIDANCE,
  },
  {
    name: "deepseek",
    matches: (m: string) => /deepseek/i.test(m),
    guidance: DEEPSEEK_GUIDANCE,
  },
  {
    name: "claude",
    matches: (m: string) => /claude/i.test(m),
    guidance: CLAUDE_GUIDANCE,
  },
];

/**
 * Find the first matching model adapter for a given model name.
 * Returns the guidance string, or empty string if no adapter matches.
 */
export function resolveModelGuidance(model: string): string {
  for (const adapter of MODEL_ADAPTERS) {
    if (adapter.matches(model)) {
      return adapter.guidance;
    }
  }
  return "";
}

/**
 * Phase 4: 根据模型 ID 返回对应的工具强制补充指导。
 * 学 Hermes OPENAI_MODEL_EXECUTION_GUIDANCE / GOOGLE_MODEL_OPERATIONAL_GUIDANCE 模式，
 * 对不同 LLM 家族注入差异化的工具使用规则。
 */
export function resolveToolEnforcement(modelId: string): string | null {
  const id = modelId.toLowerCase();
  // GPT / Codex / o1-o4 系列
  if (/gpt|codex|\bo[134]-/i.test(id)) return GPT_TOOL_ENFORCEMENT;
  // Grok 行为与 GPT 相似
  if (id.includes("grok")) return GPT_TOOL_ENFORCEMENT;
  // Gemini / Gemma 系列
  if (/gemini|gemma/i.test(id)) return GEMINI_TOOL_ENFORCEMENT;
  // 国产模型：Kimi/Qwen/DeepSeek/GLM/MiniMax
  if (/kimi|moonshot|qwen|tongyi|deepseek|glm|chatglm|zhipu|minimax|abab/i.test(id)) return CHINESE_LLM_TOOL_ENFORCEMENT;
  return null;
}
