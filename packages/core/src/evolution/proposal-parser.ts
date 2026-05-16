/**
 * Proposal Parser — 提案解析独立模块
 *
 * 从 engine.ts 提取：
 * - extractFirstJsonObject: brace counting JSON 提取器
 * - parseProposals: LLM 响应解析为 SkillProposal 列表
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { safeJsonParseAny } from "../utils/json-guard.js";
import type { SkillProposal, InteractionCase } from "./engine.js";

const parserLogger = pino({ name: "evolution-parser" });

/**
 * 从响应文本中提取第一个完整 JSON 对象，使用 brace counting 精确定位边界。
 *
 * 替代贪婪正则 `/\{[\s\S]*\}/`，后者在包含两个 JSON 块的响应中会误匹配：
 *   `{...} 解释文本 {...}` → 贪婪匹配会把中间的 "解释文本" 也吃掉。
 *
 * brace counting 从第一个 `{` 开始计数，遇到 `{` 计数+1，遇到 `}` 计数-1，
 * 回到 0 时即找到完整 JSON 对象的结束位置。
 * 字符串字面量和注释中的花括号被正确跳过。
 */
export function extractFirstJsonObject(text: string): string | null {
  // 找到第一个 '{' 的位置
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let inSingleLineComment = false;
  let inMultiLineComment = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const prev = i > 0 ? text[i - 1] : "";

    // 处理注释（JSON 标准不支持，但 LLM 有时会输出带注释的 JSON）
    if (!inString && !inMultiLineComment) {
      if (ch === "/" && text[i + 1] === "/") {
        inSingleLineComment = true;
        i++; // 跳过第二个 '/'
        continue;
      }
    }
    if (!inString && !inSingleLineComment) {
      if (ch === "/" && text[i + 1] === "*") {
        inMultiLineComment = true;
        i++; // 跳过 '*'
        continue;
      }
    }
    if (inSingleLineComment && ch === "\n") {
      inSingleLineComment = false;
      continue;
    }
    if (inMultiLineComment && ch === "*" && text[i + 1] === "/") {
      inMultiLineComment = false;
      i++; // 跳过 '/'
      continue;
    }

    if (inSingleLineComment || inMultiLineComment) continue;

    // 处理字符串（跳过字符串内的花括号）
    if (ch === "\\" && inString) {
      escapeNext = !escapeNext;
      continue;
    }
    if (ch === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    escapeNext = false;

    if (inString) continue;

    // 层数计数
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        return text.substring(start, i + 1);
      }
    }
  }

  return null; // 未找到闭合的 JSON 对象
}

/**
 * 从 LLM 分析响应中解析 SkillProposal 列表
 */
export function parseProposals(response: string, cases: InteractionCase[]): SkillProposal[] {
  const proposals: SkillProposal[] = [];
  try {
    // P2-T11: brace counting 替代贪婪正则，精确提取第一个完整 JSON 对象
    const jsonStr = extractFirstJsonObject(response);
    if (!jsonStr) return proposals;

    const parsed = safeJsonParseAny(jsonStr, "engine-parse-proposals");
    if (!parsed || typeof parsed !== "object") return proposals;
    const data = parsed as Record<string, unknown>;
    const rawProposals = (data.proposals as Array<Record<string, unknown>>) ?? [];

    for (const item of rawProposals) {
      const raw = item as Record<string, unknown>;
      if (!raw.action || raw.action === "no_change") continue;
      proposals.push({
        id: `prop_${uuid().slice(0, 8)}`,
        action: raw.action as SkillProposal["action"],
        skillName: (raw.skillName as string) ?? "unnamed",
        description: (raw.description as string) ?? "",
        content: (raw.content as string) ?? "",
        reasoning: (raw.reasoning as string) ?? "",
        basedOnCases: cases.slice(0, 5).map((c) => c.id),
        status: "pending",
        createdAt: new Date(),
        // Phase B-3: 解析 patch 操作
        patchOperations: raw.patchOperations as SkillProposal["patchOperations"],
        // Task 1.2: 三层技能库类型
        skillType: raw.skillType as SkillProposal["skillType"],
      });
    }
  } catch {
    parserLogger.warn("Failed to parse evolution analysis response as JSON");
  }
  return proposals;
}
