/**
 * 进化审计日志（Task 1.3）
 *
 * 每次 applyProposal() 或源码修改操作记录完整审计条目。
 * 采用 JSONL 格式追加写入，无锁争用，支持按 proposal/file 维度查询。
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { v4 as uuid } from "uuid";
import pino from "pino";

const logger = pino({ name: "evolution-audit" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 单条审计记录 */
export interface AuditEntry {
  /** 审计条目唯一 ID */
  id: string;
  /** 操作时间戳 */
  timestamp: string;
  /** 操作类型 */
  operation: "apply_proposal" | "reject_proposal" | "approve_proposal" | "source_modify" | "rollback" | "snapshot_create";
  /** 关联的提案 ID（无则 null） */
  proposalId: string | null;
  /** 操作涉及的文件路径 */
  filePath: string;
  /** 变更 diff 摘要（截取前 500 字符，避免膨胀） */
  diffSummary: string;
  /** 决策理由 */
  decisionReason: string;
  /** 审核人标识（人工审核闸门强制记录） */
  reviewerId: string | null;
  /** 是否支持回滚 */
  rollbackPossible: boolean;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 审计查询过滤条件 */
export interface AuditFilter {
  proposalId?: string;
  filePath?: string;
  operation?: AuditEntry["operation"];
  /** 限制返回条数（默认 100） */
  limit?: number;
}

// ═══════════════════════════════════════════════════════════════
// EvolutionAudit 核心类
// ═══════════════════════════════════════════════════════════════

export class EvolutionAudit {
  private auditPath: string;

  /**
   * @param dataDir 数据目录（通常为用户数据目录下的 evolution/ 子目录）
   */
  constructor(dataDir: string) {
    this.auditPath = join(dataDir, "evolution-audit.jsonl");
    this.ensureDir();
  }

  /** 追加一条审计记录 */
  record(entry: Omit<AuditEntry, "id" | "timestamp">): AuditEntry {
    const full: AuditEntry = {
      id: `audit_${uuid().slice(0, 8)}`,
      timestamp: new Date().toISOString(),
      ...entry,
    };

    try {
      const line = JSON.stringify(full) + "\n";
      appendFileSync(this.auditPath, line, "utf-8");
      logger.debug({ operation: full.operation, proposalId: full.proposalId }, "Audit entry recorded");
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to write audit entry");
    }

    return full;
  }

  /** 按 proposalId 查询审计轨迹 */
  getAuditTrail(proposalId: string, limit = 100): AuditEntry[] {
    return this.query({ proposalId, limit });
  }

  /** 按文件路径查询变更历史 */
  getFileHistory(filePath: string, limit = 100): AuditEntry[] {
    return this.query({ filePath, limit });
  }

  /** 通用查询 */
  query(filter: AuditFilter): AuditEntry[] {
    const results: AuditEntry[] = [];
    const limit = filter.limit ?? 100;

    if (!existsSync(this.auditPath)) return results;

    try {
      // 从后往前读（最新在前）
      const content = readFileSync(this.auditPath, "utf-8");
      const lines = content.trim().split("\n").reverse();

      for (const line of lines) {
        if (results.length >= limit) break;

        try {
          const entry: AuditEntry = JSON.parse(line);

          if (filter.proposalId && entry.proposalId !== filter.proposalId) continue;
          if (filter.filePath && entry.filePath !== filter.filePath) continue;
          if (filter.operation && entry.operation !== filter.operation) continue;

          results.push(entry);
        } catch {
          // 跳过解析失败的行
        }
      }
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to query audit log");
    }

    return results;
  }

  /** 获取审计文件路径 */
  getPath(): string {
    return this.auditPath;
  }

  private ensureDir(): void {
    const dir = dirname(this.auditPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
