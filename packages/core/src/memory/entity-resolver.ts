/**
 * 实体解析模块 — 从文本中提取实体名并建立关联。
 *
 * 移植自 Hermes store.py 的正则提取策略，支持：
 * - 大写短语（John Smith, New York）
 * - 引号内容（"React Native"）
 * - AKA 别名模式（TypeScript aka TS）
 * - 中文括号实体（「深度学习」、【GPT-4】）
 *
 * 后续可接入 NER 模型提升准确度。
 */

// ─── 提取模式（学 Hermes store.py _RE_CAPITALIZED 等） ──────

/** 大写短语：两个及以上连续首字母大写单词 */
const RE_CAPITALIZED = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\b/g;

/** 双引号内容 */
const RE_DOUBLE_QUOTE = /"([^"]{2,50})"/g;

/** 单引号内容（仅匹配含空格或大写的内容，避免缩写误提取） */
const RE_SINGLE_QUOTE = /'([A-Z][^']{1,48})'/g;

/** AKA 别名模式：X aka Y / X also known as Y */
const RE_AKA = /(\w+(?:\s+\w+)*)\s+(?:aka|also known as)\s+(\w+(?:\s+\w+)*)/gi;

/** 中文括号实体：「内容」或【内容】 */
const RE_CN_BRACKET = /[「【]([^」】]{1,30})[」】]/g;

// ─── 实体提取 ───────────────────────────────────────────────

export interface ExtractedEntity {
  name: string;
  /** AKA 关系中的别名 */
  alias?: string;
}

/**
 * 从文本中提取实体名称列表（去重、归一化）。
 * 返回值不含 alias 信息；如需别名关系请用 extractEntitiesWithAliases()。
 */
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();

  // 大写短语
  for (const m of text.matchAll(RE_CAPITALIZED)) {
    entities.add(m[1].trim());
  }

  // 双引号内容
  for (const m of text.matchAll(RE_DOUBLE_QUOTE)) {
    entities.add(m[1].trim());
  }

  // 单引号（限首字母大写）
  for (const m of text.matchAll(RE_SINGLE_QUOTE)) {
    entities.add(m[1].trim());
  }

  // 中文括号
  for (const m of text.matchAll(RE_CN_BRACKET)) {
    entities.add(m[1].trim());
  }

  // AKA 模式中的主名称
  for (const m of text.matchAll(RE_AKA)) {
    entities.add(m[1].trim());
  }

  return Array.from(entities);
}

/**
 * 提取实体及 AKA 别名关系。
 * 返回 {name, alias?} 列表，alias 非空表示 "name aka alias"。
 */
export function extractEntitiesWithAliases(text: string): ExtractedEntity[] {
  const result: ExtractedEntity[] = [];
  const seen = new Set<string>();

  // 先提取 AKA 关系
  for (const m of text.matchAll(RE_AKA)) {
    const name = m[1].trim();
    const alias = m[2].trim();
    if (!seen.has(name)) {
      result.push({ name, alias });
      seen.add(name);
    }
  }

  // 再提取其他实体（不重复 AKA 中已有的）
  for (const name of extractEntities(text)) {
    if (!seen.has(name)) {
      result.push({ name });
      seen.add(name);
    }
  }

  return result;
}

// ─── 实体解析（SQLiteBackend 集成） ────────────────────────

/** 实体行记录 */
export interface EntityRow {
  id: number;
  name: string;
  entityType: string;
  aliases: string[];
  createdAt: string;
}
