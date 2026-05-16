/**
 * 进化引擎 Review / Analysis 提示词模板
 *
 * 从 engine.ts 提取以减小核心文件体积、方便独立维护。
 */

// ═══════════════════════════════════════════════════════════════
// Review Prompts (Hermes-style)
// ═══════════════════════════════════════════════════════════════

export const MEMORY_REVIEW_PROMPT = `Review the conversation above and consider saving to memory if appropriate.

Focus on:
1. Has the user revealed things about themselves — persona, desires, preferences, or personal details worth remembering?
2. Has the user expressed expectations about how you should behave, their work style, or ways they want you to operate?

If something stands out, save it using the memory tool. If nothing is worth saving, just say "Nothing to save." and stop.`;

export const SKILL_REVIEW_PROMPT = `Review the conversation above and consider creating or updating a skill if appropriate.

Focus on: was a non-trivial approach used that required trial and error, or changing course due to findings along the way, or did the user expect a different method or outcome?

If a relevant skill already exists, suggest how to update it. Otherwise, propose a new skill if the approach is reusable.
If nothing is worth saving, just say "Nothing to save." and stop.

Respond in JSON format:
{
  "action": "create" | "update" | "no_change",
  "skillName": "<snake_case_name>",
  "description": "<what the skill does>",
  "content": "<markdown skill content>",
  "reasoning": "<why this skill is valuable>",
  "skillType": "common_mistake" | "task_specific" | "general"
}`;

export const COMBINED_REVIEW_PROMPT = `Review the conversation above and consider two things:

**Memory**: Has the user revealed personal preferences, working style, or expectations about your behavior? If so, save using the memory tool.

**Skills**: Was a non-trivial approach used that required trial and error, or did the user expect a different method? If so, propose a skill.

Only act if there's something genuinely worth saving. If nothing stands out, say "Nothing to save." and stop.`;

// ═══════════════════════════════════════════════════════════════
// Evolution Analysis Prompts (MemSkill-style)
// ═══════════════════════════════════════════════════════════════

export const ANALYSIS_PROMPT = `You are an expert analyst for an AI Agent system. Analyze the failure cases below to identify why the agent failed and how its skills should evolve.

## Failure Categories
- **skill_gap**: The agent lacks a skill/technique needed for this task
- **wrong_tool**: The agent used the wrong tool or approach
- **bad_response**: The agent's response quality was poor
- **timeout**: The agent ran out of iterations
- **other**: Miscellaneous failures

## Failure Cases ({{count}} cases)
{{cases}}

## Analysis Instructions
1. Group failures into patterns by root cause
2. For each pattern, identify if a new skill would help or an existing skill needs improvement
3. Propose concrete, actionable skill changes
4. Classify each proposal into one of three skill types:
   - **common_mistake**: Recurring errors to avoid (highest ROI — prevent repeat failures)
   - **task_specific**: Skills tied to a specific domain/task
   - **general**: Broad techniques reusable across domains

Respond in JSON:
{
  "patterns": [
    {
      "name": "<pattern name>",
      "cases": [<case IDs>],
      "rootCause": "<skill_gap|wrong_tool|bad_response|timeout|other>",
      "explanation": "<why this pattern occurs>",
      "proposedFix": "<what skill change would help>"
    }
  ],
  "proposals": [
    {
      "action": "create" | "update",
      "skillName": "<name>",
      "description": "<what the skill does>",
      "content": "<skill content in markdown>",
      "reasoning": "<how this addresses the failures>",
      "skillType": "common_mistake" | "task_specific" | "general"
    }
  ],
  "summary": "<1-2 sentence summary>"
}`;
