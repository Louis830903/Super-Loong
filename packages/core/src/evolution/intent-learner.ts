/**
 * 用户意图学习引擎 — 长期追踪用户操作模式，预测意图并主动建议。
 *
 * 核心能力：
 *   1. 高频操作模式追踪（频率分析、上下文关联、文件关联）
 *   2. 意图预判（根据历史推断用户意图）
 *   3. 主动建议（自动化建议）
 *
 * 隐私保护：所有用户行为学习数据仅存储在本地，不上传。
 */

import { v4 as uuid } from "uuid";
import pino from "pino";

const logger = pino({ name: "intent-learner" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 操作模式类型 */
export type OperationPatternType =
  | "time_based"      // 时间相关（每天早上查邮件）
  | "context_based"   // 上下文相关（提交前运行 lint）
  | "file_based"      // 文件关联（用 Excel 打开 .csv）
  | "command_based"   // 命令序列（A → B → C 固定流程）
  | "intent_based";    // 意图短语相关

/** 单条操作记录 */
export interface OperationRecord {
  id: string;
  /** 操作时间 */
  timestamp: Date;
  /** 关联的 Agent ID */
  agentId: string;
  /** 关联的会话 ID */
  sessionId: string;
  /** 用户原始消息 */
  userMessage: string;
  /** Agent 最终回复的摘要 */
  agentSummary: string;
  /** 调用的工具名称列表 */
  toolCalls: string[];
  /** 操作成功与否 */
  success: boolean;
  /** 操作耗时（毫秒） */
  duration: number;
  /** 关联的文件路径 */
  relatedFiles?: string[];
  /** 时间特征：星期几 (0-6) */
  dayOfWeek: number;
  /** 时间特征：小时 (0-23) */
  hourOfDay: number;
  /** 提取的关键意图 */
  extractedIntent?: string;
  /** 操作分类标签 */
  tags: string[];
}

/** 学习到的操作模式 */
export interface LearnedPattern {
  id: string;
  /** 模式类型 */
  type: OperationPatternType;
  /** 模式描述 */
  description: string;
  /** 相关操作记录 ID */
  operationIds: string[];
  /** 发生频次 */
  frequency: number;
  /** 首次观察到的时间 */
  firstObservedAt: Date;
  /** 最近观察到的时间 */
  lastObservedAt: Date;
  /** 置信度 (0-1) */
  confidence: number;
  /** 触发条件（如特定时间、文件类型、短语） */
  triggers: PatternTrigger[];
  /** 建议执行的工具列表 */
  suggestedTools: string[];
  /** 建议提示文本 */
  suggestion: string;
  /** 状态 */
  status: "active" | "archived" | "dismissed";
  /** 用户是否确认过此模式 */
  confirmed: boolean;
}

/** 模式触发器 */
export interface PatternTrigger {
  type: "time" | "file_extension" | "keyword" | "context";
  value: string;
  /** 匹配权重 (0-1) */
  weight: number;
}

/** 意图预测结果 */
export interface IntentPrediction {
  /** 预测的操作 */
  predictedAction: string;
  /** 预测置信度 */
  confidence: number;
  /** 匹配到的模式 ID */
  matchedPatternId: string;
  /** 建议的工具调用列表 */
  suggestedTools: string[];
  /** 面向用户的建议文本 */
  suggestion: string;
}

/** 学习报告 */
export interface LearningReport {
  /** 总记录数 */
  totalRecords: number;
  /** 学习到的模式数 */
  totalPatterns: number;
  /** 按类型分组的模式数 */
  patternsByType: Record<OperationPatternType, number>;
  /** 最近学习到的模式（最近 7 天） */
  recentPatterns: LearnedPattern[];
  /** 高频模式（频次 >= 5） */
  highFrequencyPatterns: LearnedPattern[];
  /** 生成时间 */
  generatedAt: Date;
}

/** 意图学习器配置 */
export interface IntentLearnerConfig {
  /** 形成模式所需的最小记录数（默认 3） */
  minRecordsForPattern: number;
  /** 模式置信度衰减因子（每天衰减率，默认 0.05） */
  confidenceDecayPerDay: number;
  /** 最大存储记录数（默认 1000） */
  maxRecords: number;
  /** 高频模式阈值（默认 5） */
  highFrequencyThreshold: number;
  /** 建议最小置信度阈值（默认 0.4） */
  suggestionMinConfidence: number;
}

const DEFAULT_CONFIG: IntentLearnerConfig = {
  minRecordsForPattern: 3,
  confidenceDecayPerDay: 0.05,
  maxRecords: 1000,
  highFrequencyThreshold: 5,
  suggestionMinConfidence: 0.4,
};

// ═══════════════════════════════════════════════════════════════
// 意图学习引擎
// ═══════════════════════════════════════════════════════════════

export class IntentLearner {
  /** 操作记录 */
  private records: OperationRecord[] = [];
  /** 学习到的模式 */
  private patterns: Map<string, LearnedPattern> = new Map();
  /** 配置 */
  private config: IntentLearnerConfig;

  constructor(config?: Partial<IntentLearnerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 记录一次用户操作。
   */
  recordOperation(params: {
    agentId: string;
    sessionId: string;
    userMessage: string;
    agentSummary: string;
    toolCalls: string[];
    success: boolean;
    duration: number;
    relatedFiles?: string[];
  }): OperationRecord {
    const now = new Date();
    const record: OperationRecord = {
      id: `op_${uuid().slice(0, 8)}`,
      timestamp: now,
      agentId: params.agentId,
      sessionId: params.sessionId,
      userMessage: params.userMessage,
      agentSummary: params.agentSummary,
      toolCalls: params.toolCalls,
      success: params.success,
      duration: params.duration,
      relatedFiles: params.relatedFiles,
      dayOfWeek: now.getDay(),
      hourOfDay: now.getHours(),
      extractedIntent: this.extractIntent(params.userMessage),
      tags: this.extractTags(params),
    };

    this.records.push(record);

    // 限制最大记录数（FIFO）
    while (this.records.length > this.config.maxRecords) {
      this.records.shift();
    }

    // 尝试从新记录中学习模式
    this.updatePatterns(record);

    logger.debug({ recordId: record.id, intent: record.extractedIntent }, "Operation recorded");
    return record;
  }

  /**
   * 根据当前上下文预测用户意图。
   */
  predictIntent(context: {
    currentMessage?: string;
    currentTime?: Date;
    relatedFiles?: string[];
    recentOperations?: string[];
  }): IntentPrediction[] {
    const now = context.currentTime ?? new Date();
    const predictions: IntentPrediction[] = [];

    for (const pattern of this.patterns.values()) {
      if (pattern.status !== "active") continue;
      if (pattern.confidence < this.config.suggestionMinConfidence) continue;

      let matchScore = 0;
      let matchedTriggers = 0;

      for (const trigger of pattern.triggers) {
        switch (trigger.type) {
          case "time":
            if (this.matchTimeTrigger(trigger, now)) {
              matchScore += trigger.weight;
              matchedTriggers++;
            }
            break;
          case "file_extension":
            if (context.relatedFiles?.some(f => f.endsWith(trigger.value))) {
              matchScore += trigger.weight;
              matchedTriggers++;
            }
            break;
          case "keyword":
            if (context.currentMessage?.toLowerCase().includes(trigger.value.toLowerCase())) {
              matchScore += trigger.weight;
              matchedTriggers++;
            }
            break;
          case "context":
            if (context.recentOperations?.some(op => op.includes(trigger.value))) {
              matchScore += trigger.weight;
              matchedTriggers++;
            }
            break;
        }
      }

      if (matchedTriggers > 0) {
        const confidence = matchScore / pattern.triggers.reduce((s, t) => s + t.weight, 0);
        if (confidence >= this.config.suggestionMinConfidence) {
          predictions.push({
            predictedAction: pattern.description,
            confidence: parseFloat(confidence.toFixed(2)),
            matchedPatternId: pattern.id,
            suggestedTools: pattern.suggestedTools,
            suggestion: pattern.suggestion,
          });
        }
      }
    }

    // 按置信度降序排列
    return predictions.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 生成面向用户的建议文本。
   */
  generateSuggestions(context: {
    currentMessage?: string;
    relatedFiles?: string[];
  }): string[] {
    const predictions = this.predictIntent(context);
    return predictions.map(p => p.suggestion).filter(Boolean);
  }

  // ─── 模式学习 ───────────────────────────────────────────

  /**
   * 从操作记录中提取意图。
   */
  private extractIntent(userMessage: string): string {
    // 简单提取：取消息的前 60 个字符作为意图摘要
    const cleaned = userMessage.replace(/[\n\r]+/g, " ").trim();
    return cleaned.length > 60 ? cleaned.slice(0, 60) + "..." : cleaned;
  }

  /**
   * 提取操作标签。
   */
  private extractTags(params: {
    userMessage: string;
    toolCalls: string[];
    relatedFiles?: string[];
  }): string[] {
    const tags: string[] = [];

    // 从工具调用提取标签
    const toolTagMap: Record<string, string> = {
      "browser_navigate": "浏览器",
      "computer_use": "桌面控制",
      "run_shell": "终端",
      "write_file": "文件写入",
      "read_file": "文件读取",
      "list_directory": "目录列表",
      "web_search": "网络搜索",
      "app_launch": "应用启动",
      "email": "邮件",
      "git": "版本管理",
    };

    for (const tool of params.toolCalls) {
      const tag = toolTagMap[tool] ?? "其他";
      if (!tags.includes(tag)) tags.push(tag);
    }

    // 从文件扩展名提取标签
    if (params.relatedFiles) {
      for (const file of params.relatedFiles) {
        const ext = file.split(".").pop()?.toLowerCase();
        if (ext) {
          const extTagMap: Record<string, string> = {
            "csv": "CSV 文件",
            "xlsx": "Excel",
            "xls": "Excel",
            "docx": "Word",
            "pdf": "PDF",
            "pptx": "PPT",
            "py": "Python",
            "ts": "TypeScript",
            "js": "JavaScript",
            "go": "Go",
            "rs": "Rust",
            "json": "JSON",
            "yaml": "YAML",
            "yml": "YAML",
            "md": "Markdown",
          };
          const extTag = extTagMap[ext] ?? `${ext.toUpperCase()} 文件`;
          if (!tags.includes(extTag)) tags.push(extTag);
        }
      }
    }

    return tags;
  }

  /**
   * 更新学习模式。
   */
  private updatePatterns(record: OperationRecord): void {
    // 衰减已有模式的置信度
    this.decayConfidence();

    // 按标签分组，查找相似操作序列
    for (const tag of record.tags) {
      const relatedRecords = this.records.filter(
        r => r.id !== record.id && r.tags.includes(tag),
      );

      if (relatedRecords.length >= this.config.minRecordsForPattern - 1) {
        const records = [record, ...relatedRecords];
        this.upsertPattern({
          id: `tag_${tag.toLowerCase().replace(/\s+/g, "_")}`,
          type: "command_based",
          description: `执行 ${tag} 相关操作时通常调用 ${this.dedupTools(records).join(" → ")}`,
          operationIds: records.map(r => r.id),
          triggers: [{ type: "keyword", value: tag, weight: 0.7 }],
          suggestedTools: this.dedupTools(records),
          suggestion: `你经常执行 ${tag} 相关操作，需要我帮你自动化吗？`,
        });
      }
    }

    // 时间模式检测：相同小时段 + 相同工作日的重复操作
    const sameTimeRecords = this.records.filter(
      r => r.id !== record.id &&
        r.hourOfDay === record.hourOfDay &&
        r.dayOfWeek === record.dayOfWeek,
    );

    if (sameTimeRecords.length >= this.config.minRecordsForPattern - 1) {
      const timePatternId = `time_${record.hourOfDay}_${record.dayOfWeek}_${record.tags[0] ?? "general"}`;
      this.upsertPattern({
        id: timePatternId,
        type: "time_based",
        description: `每天 ${record.hourOfDay} 点左右执行 ${record.tags.join(", ")} 相关操作`,
        operationIds: [record.id, ...sameTimeRecords.map(r => r.id)],
        triggers: [
          {
            type: "time",
            value: `${record.dayOfWeek}:${record.hourOfDay}`,
            weight: 0.7,
          },
          ...record.tags.map(tag => ({
            type: "keyword" as const,
            value: tag,
            weight: 0.15,
          })),
        ],
        suggestedTools: this.dedupTools([
          record,
          ...sameTimeRecords,
        ]),
        suggestion: `你通常在 ${record.hourOfDay}:00 左右进行 ${record.tags.join("、")} 相关操作，需要我帮你自动化吗？`,
      });
    }

    // 文件类型关联
    if (record.relatedFiles && record.relatedFiles.length > 0) {
      for (const file of record.relatedFiles) {
        const ext = file.split(".").pop()?.toLowerCase();
        if (!ext) continue;

        const sameExtRecords = this.records.filter(
          r => r.id !== record.id &&
            r.relatedFiles?.some(f => f.endsWith(`.${ext}`)),
        );

        if (sameExtRecords.length >= this.config.minRecordsForPattern - 1) {
          const extPatternId = `file_${ext}`;
          this.upsertPattern({
            id: extPatternId,
            type: "file_based",
            description: `处理 .${ext} 文件时通常执行 ${record.toolCalls.join(" → ")} 操作`,
            operationIds: [record.id, ...sameExtRecords.map(r => r.id)],
            triggers: [
              {
                type: "file_extension",
                value: `.${ext}`,
                weight: 0.8,
              },
            ],
            suggestedTools: record.toolCalls,
            suggestion: `检测到你打开了 .${ext} 文件，需要我帮你用常用方式处理吗？`,
          });
        }
      }
    }
  }

  /**
   * 创建或更新模式。
   */
  private upsertPattern(params: {
    id: string;
    type: OperationPatternType;
    description: string;
    operationIds: string[];
    triggers: PatternTrigger[];
    suggestedTools: string[];
    suggestion: string;
  }): LearnedPattern {
    const existing = this.patterns.get(params.id);

    if (existing) {
      existing.operationIds = [
        ...new Set([...existing.operationIds, ...params.operationIds]),
      ];
      existing.frequency = existing.operationIds.length;
      existing.lastObservedAt = new Date();
      existing.confidence = Math.min(1, existing.confidence + 0.1);
      existing.triggers = params.triggers;
      existing.suggestedTools = params.suggestedTools;
      existing.suggestion = params.suggestion;
      return existing;
    }

    const pattern: LearnedPattern = {
      id: params.id,
      type: params.type,
      description: params.description,
      operationIds: params.operationIds,
      frequency: params.operationIds.length,
      firstObservedAt: new Date(),
      lastObservedAt: new Date(),
      confidence: 0.5,
      triggers: params.triggers,
      suggestedTools: params.suggestedTools,
      suggestion: params.suggestion,
      status: "active",
      confirmed: false,
    };

    this.patterns.set(pattern.id, pattern);
    logger.info({ patternId: pattern.id, type: pattern.type }, "New pattern learned");
    return pattern;
  }

  /**
   * 置信度衰减：每天衰减配置的速率。
   */
  private decayConfidence(): void {
    const now = Date.now();
    for (const pattern of this.patterns.values()) {
      const daysSinceLastObserved =
        (now - pattern.lastObservedAt.getTime()) / (24 * 60 * 60 * 1000);

      if (daysSinceLastObserved > 1) {
        pattern.confidence = Math.max(
          0.1,
          pattern.confidence - this.config.confidenceDecayPerDay * Math.floor(daysSinceLastObserved),
        );
      }

      // 置信度过低 → 归档
      if (pattern.confidence < 0.15 && pattern.status === "active") {
        pattern.status = "archived";
        logger.info({ patternId: pattern.id }, "Pattern archived due to low confidence");
      }
    }
  }

  /**
   * 匹配时间触发器。
   */
  private matchTimeTrigger(trigger: PatternTrigger, now: Date): boolean {
    // 格式: "dayOfWeek:hourOfDay"，如 "5:9" = 周五 9 点
    const parts = trigger.value.split(":");
    if (parts.length !== 2) return false;

    const targetDay = parseInt(parts[0], 10);
    const targetHour = parseInt(parts[1], 10);

    return now.getDay() === targetDay && now.getHours() === targetHour;
  }

  /**
   * 去重工具列表。
   */
  private dedupTools(records: OperationRecord[]): string[] {
    const tools = new Set<string>();
    for (const r of records) {
      for (const t of r.toolCalls) {
        tools.add(t);
      }
    }
    return Array.from(tools);
  }

  // ─── 查询与报告 ─────────────────────────────────────────

  /**
   * 获取所有学习到的模式。
   */
  getPatterns(filter?: {
    type?: OperationPatternType;
    minConfidence?: number;
    status?: LearnedPattern["status"];
  }): LearnedPattern[] {
    let results = Array.from(this.patterns.values());

    if (filter?.type) {
      results = results.filter(p => p.type === filter.type);
    }
    if (filter?.minConfidence !== undefined) {
      results = results.filter(p => p.confidence >= filter.minConfidence!);
    }
    if (filter?.status) {
      results = results.filter(p => p.status === filter.status);
    }

    return results.sort((a, b) => b.confidence - a.confidence);
  }

  /**
   * 获取高置信度模式。
   */
  getHighConfidencePatterns(): LearnedPattern[] {
    return this.getPatterns({ minConfidence: 0.7, status: "active" });
  }

  /**
   * 用户确认一个模式。
   */
  confirmPattern(patternId: string): boolean {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return false;

    pattern.confirmed = true;
    pattern.confidence = Math.min(1, pattern.confidence + 0.2);
    logger.info({ patternId }, "Pattern confirmed by user");
    return true;
  }

  /**
   * 用户忽略一个模式。
   */
  dismissPattern(patternId: string): boolean {
    const pattern = this.patterns.get(patternId);
    if (!pattern) return false;

    pattern.status = "dismissed";
    logger.info({ patternId }, "Pattern dismissed by user");
    return true;
  }

  /**
   * 生成学习报告。
   */
  generateReport(): LearningReport {
    const allPatterns = Array.from(this.patterns.values());
    const patternsByType: Record<OperationPatternType, number> = {
      time_based: 0,
      context_based: 0,
      file_based: 0,
      command_based: 0,
      intent_based: 0,
    };

    for (const p of allPatterns) {
      patternsByType[p.type]++;
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentPatterns = allPatterns.filter(
      p => p.lastObservedAt.getTime() >= weekAgo,
    );

    return {
      totalRecords: this.records.length,
      totalPatterns: allPatterns.length,
      patternsByType,
      recentPatterns,
      highFrequencyPatterns: allPatterns.filter(
        p => p.frequency >= this.config.highFrequencyThreshold,
      ),
      generatedAt: new Date(),
    };
  }

  /**
   * 获取记录总数。
   */
  get recordCount(): number {
    return this.records.length;
  }

  /**
   * 获取模式总数。
   */
  get patternCount(): number {
    return this.patterns.size;
  }

  /**
   * 重置学习器（清除所有记录和模式）。
   */
  reset(): void {
    this.records = [];
    this.patterns.clear();
    logger.info("Intent learner reset");
  }
}
