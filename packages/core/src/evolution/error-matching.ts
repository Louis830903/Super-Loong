/**
 * 智能错误匹配引擎（Task 2.5）
 *
 * 借鉴 self-healing-agents 的 smart_match 6 信号匹配引擎。
 * 新失败到达时，先在错误数据库中查找已知修复，
 * 有匹配且风险可接受 → 直接应用修复，跳过 LLM 分析。
 */

import pino from "pino";
import { writeFileSync, readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { InteractionCase } from "./engine.js";

const logger = pino({ name: "evolution:error-matching" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 错误数据库中的一条记录 */
export interface ErrorRecord {
  /** 唯一 ID */
  id: string;
  /** 错误模式（正则或关键字） */
  pattern: string;
  /** 匹配方式 */
  matchType: "regex" | "exact_substring" | "token_overlap";
  /** 失败类别 */
  failureCategory: string;
  /** 已知修复方案（提案 ID） */
  fixProposalId?: string;
  /** 已知修复方案（技能名） */
  fixSkillName?: string;
  /** 修复说明 */
  fixDescription: string;
  /** 此修复已成功应用的次数 */
  healCount: number;
  /** 是否为久经考验的修复（healCount >= 5） */
  battleTested: boolean;
  /** 创建时间 */
  createdAt: string;
  /** 最后匹配时间 */
  lastMatchedAt?: string;
}

/** 匹配信号 */
export interface MatchSignal {
  /** 信号类型 */
  type: "regex" | "exact_substring" | "token_overlap" | "error_class" | "path_similarity" | "ngram_overlap";
  /** 匹配权重 */
  weight: number;
  /** 是否命中 */
  hit: boolean;
  /** 置信度 (0-1) */
  confidence: number;
}

/** 匹配结果 */
export interface ErrorMatchResult {
  /** 是否匹配 */
  matched: boolean;
  /** 匹配的记录 */
  record?: ErrorRecord;
  /** 总置信度 */
  confidence: number;
  /** 各信号详情 */
  signals: MatchSignal[];
  /** 是否推荐自动应用 */
  autoApply: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 6 信号匹配引擎
// ═══════════════════════════════════════════════════════════════

/**
 * 6 信号权重配置（对标 self-healing-agents）
 *
 * - Regex(0.90): 正则匹配，最精确
 * - Exact substring(0.95): 完全子串匹配
 * - Token overlap(≤0.80): 词元重叠度
 * - Error class(0.75): 失败类别匹配
 * - Path similarity(≤0.70): 路径相似度
 * - N-gram overlap(≤0.85): N-gram 重叠度
 *
 * 3+ 信号命中加分: +0.03; 4+ 信号: +0.02
 */
const SIGNAL_WEIGHTS: Record<MatchSignal["type"], number> = {
  regex: 0.90,
  exact_substring: 0.95,
  token_overlap: 0.80,
  error_class: 0.75,
  path_similarity: 0.70,
  ngram_overlap: 0.85,
};

/** 自动应用置信度阈值 */
const AUTO_APPLY_THRESHOLD = 0.8;

/** Battle-tested 阈值 */
const BATTLE_TESTED_THRESHOLD = 5;

/** Task 8: 错误记录 Map 容量上限 */
const MAX_RECORDS = 1000;

// ═══════════════════════════════════════════════════════════════
// ErrorMatcher
// ═══════════════════════════════════════════════════════════════

export class ErrorMatcher {
  private records: Map<string, ErrorRecord> = new Map();
  private dbPath: string;

  constructor(dataDir?: string) {
    const dir = dataDir ?? join(process.cwd(), "data");
    this.dbPath = join(dir, "error-database.jsonl");
    this.load();
  }

  // ─── CRUD ──────────────────────────────────────────────────

  /** 添加一条错误修复记录 */
  addRecord(record: Omit<ErrorRecord, "id" | "healCount" | "battleTested" | "createdAt">): ErrorRecord {
    const full: ErrorRecord = {
      ...record,
      id: `err_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      healCount: 0,
      battleTested: false,
      createdAt: new Date().toISOString(),
    };
    this.records.set(full.id, full);
    this.pruneRecords();
    this.persist(full);
    logger.info({ id: full.id, pattern: full.pattern }, "Error record added");
    return full;
  }

  /** 记录成功修复（healCount++） */
  recordHeal(recordId: string): void {
    const record = this.records.get(recordId);
    if (!record) return;
    record.healCount++;
    record.lastMatchedAt = new Date().toISOString();
    if (record.healCount >= BATTLE_TESTED_THRESHOLD) {
      record.battleTested = true;
    }
    this.persist(record);
    logger.info({ id: recordId, healCount: record.healCount }, "Heal recorded");
  }

  /** 获取所有记录 */
  getAllRecords(): ErrorRecord[] {
    return Array.from(this.records.values());
  }

  // ─── 匹配引擎 ──────────────────────────────────────────────

  /**
   * 对新失败案例执行 6 信号匹配
   */
  match(failureCase: InteractionCase): ErrorMatchResult {
    const reason = failureCase.failureReason ?? "";
    const category = failureCase.failureCategory ?? "other";

    if (!reason || this.records.size === 0) {
      return { matched: false, confidence: 0, signals: [], autoApply: false };
    }

    let bestMatch: ErrorMatchResult = { matched: false, confidence: 0, signals: [], autoApply: false };

    for (const record of this.records.values()) {
      const signals = this.computeSignals(reason, category, record);
      const hitSignals = signals.filter((s) => s.hit);

      if (hitSignals.length === 0) continue;

      // 计算加权置信度
      let confidence = hitSignals.reduce((sum, s) => sum + s.weight * s.confidence, 0) / hitSignals.length;

      // 3+ 信号加成
      if (hitSignals.length >= 4) confidence += 0.05;
      else if (hitSignals.length >= 3) confidence += 0.03;

      // Battle-tested 加成
      if (record.battleTested) confidence += 0.05;

      confidence = Math.min(1, confidence);

      if (confidence > bestMatch.confidence) {
        bestMatch = {
          matched: true,
          record,
          confidence,
          signals,
          autoApply: confidence >= AUTO_APPLY_THRESHOLD,
        };
      }
    }

    return bestMatch;
  }

  /**
   * 计算 6 个匹配信号
   */
  private computeSignals(reason: string, category: string, record: ErrorRecord): MatchSignal[] {
    const reasonLower = reason.toLowerCase();
    const patternLower = record.pattern.toLowerCase();

    // 1. Regex 匹配
    const regexHit = (() => {
      try {
        return new RegExp(record.pattern, "i").test(reason);
      } catch { return false; }
    })();

    // 2. Exact substring 匹配
    const exactHit = reasonLower.includes(patternLower);

    // 3. Token overlap 匹配
    const reasonTokens = new Set(reasonLower.split(/\s+/).filter((t) => t.length > 2));
    const patternTokens = new Set(patternLower.split(/\s+/).filter((t) => t.length > 2));
    const overlap = [...reasonTokens].filter((t) => patternTokens.has(t)).length;
    const overlapRatio = patternTokens.size > 0 ? overlap / patternTokens.size : 0;

    // 4. Error class 匹配
    const classHit = record.failureCategory === category;

    // 5. Path similarity（简化版——检查是否包含相同的路径模式）
    const pathPattern = /(?:\/[^\s]+)/g;
    const reasonPaths = (reason.match(pathPattern) ?? []).map((p: string) => p.toLowerCase());
    const recordPaths = (record.pattern.match(pathPattern) ?? []).map((p: string) => p.toLowerCase());
    const pathOverlap = reasonPaths.filter((p: string) => recordPaths.includes(p)).length;
    const pathRatio = recordPaths.length > 0 ? pathOverlap / recordPaths.length : 0;

    // 6. N-gram overlap（trigram）
    const trigrams = (s: string) => {
      const grams = new Set<string>();
      for (let i = 0; i < s.length - 2; i++) grams.add(s.slice(i, i + 3));
      return grams;
    };
    const reasonGrams = trigrams(reasonLower);
    const patternGrams = trigrams(patternLower);
    const gramOverlap = patternGrams.size > 0
      ? [...reasonGrams].filter((g) => patternGrams.has(g)).length / patternGrams.size
      : 0;

    return [
      { type: "regex", weight: SIGNAL_WEIGHTS.regex, hit: regexHit, confidence: regexHit ? 0.9 : 0 },
      { type: "exact_substring", weight: SIGNAL_WEIGHTS.exact_substring, hit: exactHit, confidence: exactHit ? 0.95 : 0 },
      { type: "token_overlap", weight: SIGNAL_WEIGHTS.token_overlap, hit: overlapRatio >= 0.3, confidence: Math.min(0.8, overlapRatio) },
      { type: "error_class", weight: SIGNAL_WEIGHTS.error_class, hit: classHit, confidence: classHit ? 0.75 : 0 },
      { type: "path_similarity", weight: SIGNAL_WEIGHTS.path_similarity, hit: pathRatio >= 0.5, confidence: Math.min(0.7, pathRatio) },
      { type: "ngram_overlap", weight: SIGNAL_WEIGHTS.ngram_overlap, hit: gramOverlap >= 0.3, confidence: Math.min(0.85, gramOverlap) },
    ];
  }

  // ─── 持久化 ────────────────────────────────────────────────

  private persist(record: ErrorRecord): void {
    try {
      appendFileSync(this.dbPath, JSON.stringify(record) + "\n", "utf-8");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to persist error record");
    }
  }

  private load(): void {
    try {
      if (!existsSync(this.dbPath)) return;
      const lines = readFileSync(this.dbPath, "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const record: ErrorRecord = JSON.parse(line);
          this.records.set(record.id, record);
        } catch { /* skip corrupt lines */ }
      }
      this.pruneRecords();
      logger.info({ records: this.records.size }, "Error database loaded");
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to load error database");
    }
  }

  /**
   * Task 8: 截断 records Map — 按 createdAt 排序，保留最新的 MAX_RECORDS 条
   */
  private pruneRecords(): void {
    if (this.records.size <= MAX_RECORDS) return;
    const sorted = Array.from(this.records.entries())
      .sort((a, b) => new Date(b[1].createdAt).getTime() - new Date(a[1].createdAt).getTime());
    this.records = new Map(sorted.slice(0, MAX_RECORDS));
  }
}
