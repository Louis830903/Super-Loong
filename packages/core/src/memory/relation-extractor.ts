/**
 * T6.3 — 关系抽取器
 *
 * 从文本中提取实体间的关系候选（基于模板规则 MVP 版）。
 * Phase 2 可选挂 LLM 小模型做更精确的关系抽取。
 *
 * 支持的关系模式（中英文）：
 *   - X works at Y / X 在 Y 工作 → worksAt
 *   - X is in Y / X 位于 Y → locatedIn
 *   - X is part of Y / X 属于 Y → partOf
 *   - X is a Y / X 是 Y → instanceOf
 *   - X created Y / X 创建了 Y → created
 *   - X uses Y / X 使用 Y → uses
 *   - X depends on Y / X 依赖 Y → dependsOn
 *   - X manages Y / X 管理 Y → manages
 */

import pino from "pino";

const logger = pino({ name: "relation-extractor" });

// ═══════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════

/** 关系候选 */
export interface RelationCandidate {
  subject: string;
  predicate: string;
  object: string;
  confidence: number;
}

// ═══════════════════════════════════════════════════════════════
// 规则模板
// ═══════════════════════════════════════════════════════════════

interface RelationPattern {
  regex: RegExp;
  predicate: string;
  /** 正则中主体和客体的组号（1-based） */
  subjectGroup: number;
  objectGroup: number;
  confidence: number;
}

/** 实体名称占位符：匹配已知实体（在运行时动态替换） */
const ENTITY_PLACEHOLDER = "([\\w\\u4e00-\\u9fff][\\w\\u4e00-\\u9fff\\s]*?)";
const E = ENTITY_PLACEHOLDER;

/**
 * 静态关系模式列表（中英文混合）
 * 注：正则中的 E 在运行时会被实际实体名替换来构造更精确的匹配
 */
const STATIC_PATTERNS: RelationPattern[] = [
  // 英文模式
  { regex: new RegExp(`${E}\\s+works\\s+at\\s+${E}`, "gi"), predicate: "worksAt", subjectGroup: 1, objectGroup: 2, confidence: 0.8 },
  { regex: new RegExp(`${E}\\s+is\\s+located\\s+in\\s+${E}`, "gi"), predicate: "locatedIn", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}\\s+is\\s+in\\s+${E}`, "gi"), predicate: "locatedIn", subjectGroup: 1, objectGroup: 2, confidence: 0.5 },
  { regex: new RegExp(`${E}\\s+is\\s+part\\s+of\\s+${E}`, "gi"), predicate: "partOf", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}\\s+is\\s+an?\\s+${E}`, "gi"), predicate: "instanceOf", subjectGroup: 1, objectGroup: 2, confidence: 0.6 },
  { regex: new RegExp(`${E}\\s+created\\s+${E}`, "gi"), predicate: "created", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}\\s+uses\\s+${E}`, "gi"), predicate: "uses", subjectGroup: 1, objectGroup: 2, confidence: 0.6 },
  { regex: new RegExp(`${E}\\s+depends\\s+on\\s+${E}`, "gi"), predicate: "dependsOn", subjectGroup: 1, objectGroup: 2, confidence: 0.6 },
  { regex: new RegExp(`${E}\\s+manages\\s+${E}`, "gi"), predicate: "manages", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}\\s+belongs\\s+to\\s+${E}`, "gi"), predicate: "partOf", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}\\s+owns\\s+${E}`, "gi"), predicate: "owns", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  // 中文模式
  { regex: new RegExp(`${E}在${E}工作`, "g"), predicate: "worksAt", subjectGroup: 1, objectGroup: 2, confidence: 0.8 },
  { regex: new RegExp(`${E}位于${E}`, "g"), predicate: "locatedIn", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}属于${E}`, "g"), predicate: "partOf", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}是${E}的一部分`, "g"), predicate: "partOf", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}是${E}`, "g"), predicate: "instanceOf", subjectGroup: 1, objectGroup: 2, confidence: 0.4 },
  { regex: new RegExp(`${E}使用${E}`, "g"), predicate: "uses", subjectGroup: 1, objectGroup: 2, confidence: 0.6 },
  { regex: new RegExp(`${E}创建了${E}`, "g"), predicate: "created", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
  { regex: new RegExp(`${E}依赖${E}`, "g"), predicate: "dependsOn", subjectGroup: 1, objectGroup: 2, confidence: 0.6 },
  { regex: new RegExp(`${E}管理${E}`, "g"), predicate: "manages", subjectGroup: 1, objectGroup: 2, confidence: 0.7 },
];

// ═══════════════════════════════════════════════════════════════
// 关系抽取函数
// ═══════════════════════════════════════════════════════════════

/**
 * 从文本中抽取实体间的关系候选。
 *
 * 策略：
 *   1. 对每个静态模式做全局正则匹配
 *   2. 匹配到的主体/客体与已知实体列表做交叉验证
 *   3. 仅保留两端都能匹配到已知实体的候选
 *
 * @param text - 待分析文本
 * @param entities - 已提取的实体名称列表
 * @returns 关系候选数组（去重）
 */
export function extractRelations(text: string, entities: string[]): RelationCandidate[] {
  if (!text || entities.length < 2) return [];

  const entitySet = new Set(entities.map((e) => e.toLowerCase()));
  const candidates: RelationCandidate[] = [];
  const seen = new Set<string>(); // 用于去重："subject|predicate|object"

  for (const pattern of STATIC_PATTERNS) {
    // 重置 regex lastIndex（全局标志）
    pattern.regex.lastIndex = 0;

    for (const match of text.matchAll(pattern.regex)) {
      const subject = match[pattern.subjectGroup]?.trim();
      const object = match[pattern.objectGroup]?.trim();

      if (!subject || !object) continue;
      if (subject.toLowerCase() === object.toLowerCase()) continue; // 排除自环

      // 交叉验证：两端都必须是已知实体
      const subjLower = subject.toLowerCase();
      const objLower = object.toLowerCase();
      if (!entitySet.has(subjLower) && !fuzzyMatch(subjLower, entitySet)) continue;
      if (!entitySet.has(objLower) && !fuzzyMatch(objLower, entitySet)) continue;

      const key = `${subjLower}|${pattern.predicate}|${objLower}`;
      if (seen.has(key)) continue;
      seen.add(key);

      candidates.push({
        subject: findBestMatch(subject, entities),
        predicate: pattern.predicate,
        object: findBestMatch(object, entities),
        confidence: pattern.confidence,
      });
    }
  }

  logger.debug({ entityCount: entities.length, candidateCount: candidates.length }, "relations extracted");
  return candidates;
}

// ═══════════════════════════════════════════════════════════════
// 辅助函数
// ═══════════════════════════════════════════════════════════════

/** 模糊匹配：检查 target 是否是 entitySet 中某个实体的子串或包含关系 */
function fuzzyMatch(target: string, entitySet: Set<string>): boolean {
  for (const entity of entitySet) {
    if (entity.includes(target) || target.includes(entity)) {
      return true;
    }
  }
  return false;
}

/** 从实体列表中找到与 raw 最匹配的原始名称（保留原始大小写） */
function findBestMatch(raw: string, entities: string[]): string {
  const lower = raw.toLowerCase();
  // 精确匹配
  for (const e of entities) {
    if (e.toLowerCase() === lower) return e;
  }
  // 包含匹配
  for (const e of entities) {
    if (e.toLowerCase().includes(lower) || lower.includes(e.toLowerCase())) return e;
  }
  return raw;
}
