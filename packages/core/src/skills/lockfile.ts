/**
 * Skill Lockfile — 版本锁定与更新检测
 *
 * 对标 Hermes HubLockFile + check_for_skill_updates
 *       OpenClaw ClawHubSkillsLockfile + updateSkillsFromClawHub
 *
 * 核心功能:
 * 1. 锁定文件管理 — 记录已安装技能的版本/哈希/来源
 * 2. 更新检测 — 比较本地哈希与远程最新版本
 * 3. 审计日志 — 记录所有安装/卸载/更新操作
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import pino from "pino";
import { contentHash, type TrustLevel } from "./guard.js";

const logger = pino({ name: "skill-lockfile" });

// ─── 数据结构 ──────────────────────────────────────────────

/** 锁定文件格式 (对标 Hermes HubLockFile + OpenClaw ClawHubSkillsLockfile) */
export interface SkillLockfile {
  version: 1;
  skills: Record<string, SkillLockEntry>;
}

/** 锁定条目 */
export interface SkillLockEntry {
  /** 来源标识 (github/skillhub/clawhub/local) */
  source: string;
  /** 源内唯一标识 */
  identifier: string;
  /** 信任等级 */
  trustLevel: TrustLevel;
  /** 安全扫描判决 */
  verdict: string;
  /** SHA256 内容哈希 */
  contentHash: string;
  /** 本地安装路径 */
  installPath: string;
  /** 安装时间戳 */
  installedAt: number;
  /** 语义版本 */
  version?: string;
  /** 更新来源 URL */
  sourceUrl?: string;
}

/** 技能来源元数据 (对标 OpenClaw ClawHubSkillOrigin) */
export interface SkillOrigin {
  version: 1;
  registry: string;
  slug: string;
  installedVersion: string;
  installedAt: number;
}

/** 更新检测结果 */
export interface UpdateCheckResult {
  name: string;
  status: "up_to_date" | "update_available" | "error";
  currentVersion?: string;
  latestVersion?: string;
  currentHash?: string;
  latestHash?: string;
  error?: string;
}

/** 审计日志条目 */
export interface AuditLogEntry {
  timestamp: string;
  action: "install" | "uninstall" | "update" | "scan" | "block";
  skillName: string;
  source?: string;
  verdict?: string;
  extra?: Record<string, unknown>;
}

// ─── 默认路径 ───────────────────────────────────────────

const DEFAULT_HUB_DIR = join(homedir(), ".superlv", "skills", ".hub");
const LOCKFILE_NAME = "lock.json";
const AUDIT_LOG_NAME = "audit.log";

// ─── Lockfile Manager ───────────────────────────────────

export class SkillLockfileManager {
  private hubDir: string;
  private lockfilePath: string;
  private auditLogPath: string;
  private lockfile: SkillLockfile;

  constructor(hubDir?: string) {
    this.hubDir = hubDir ?? DEFAULT_HUB_DIR;
    this.lockfilePath = join(this.hubDir, LOCKFILE_NAME);
    this.auditLogPath = join(this.hubDir, AUDIT_LOG_NAME);
    this.lockfile = this.readLockfile();
  }

  // ─── 读写锁定文件 ──────────────────────────────────

  /** 读取锁定文件 */
  readLockfile(): SkillLockfile {
    try {
      if (existsSync(this.lockfilePath)) {
        const raw = readFileSync(this.lockfilePath, "utf-8");
        const data = JSON.parse(raw) as SkillLockfile;
        if (data.version === 1 && data.skills) {
          return data;
        }
      }
    } catch (err: any) {
      logger.warn({ error: err.message }, "Failed to read lockfile, creating new");
    }
    return { version: 1, skills: {} };
  }

  /** 写入锁定文件 */
  writeLockfile(): void {
    try {
      if (!existsSync(this.hubDir)) {
        mkdirSync(this.hubDir, { recursive: true });
      }
      writeFileSync(this.lockfilePath, JSON.stringify(this.lockfile, null, 2), "utf-8");
    } catch (err: any) {
      logger.error({ error: err.message }, "Failed to write lockfile");
    }
  }

  // ─── 安装/卸载记录 ────────────────────────────────

  /** 记录安装 */
  recordInstall(name: string, entry: Omit<SkillLockEntry, "installedAt">): void {
    this.lockfile.skills[name] = {
      ...entry,
      installedAt: Date.now(),
    };
    this.writeLockfile();
    this.appendAuditLog("install", name, {
      source: entry.source,
      verdict: entry.verdict,
      hash: entry.contentHash.slice(0, 12),
    });
    logger.info({ name, source: entry.source }, "Install recorded in lockfile");
  }

  /** 记录卸载 */
  recordUninstall(name: string): void {
    if (this.lockfile.skills[name]) {
      delete this.lockfile.skills[name];
      this.writeLockfile();
      this.appendAuditLog("uninstall", name);
      logger.info({ name }, "Uninstall recorded in lockfile");
    }
  }

  /** 记录更新 */
  recordUpdate(name: string, updates: Partial<SkillLockEntry>): void {
    const existing = this.lockfile.skills[name];
    if (existing) {
      Object.assign(existing, updates);
      this.writeLockfile();
      this.appendAuditLog("update", name, {
        newHash: updates.contentHash?.slice(0, 12),
        newVersion: updates.version,
      });
    }
  }

  // ─── 查询 ────────────────────────────────────────

  /** 获取锁定条目 */
  getEntry(name: string): SkillLockEntry | undefined {
    return this.lockfile.skills[name];
  }

  /** 获取所有锁定条目 */
  getAllEntries(): Record<string, SkillLockEntry> {
    return { ...this.lockfile.skills };
  }

  /** 已安装技能数量 */
  get count(): number {
    return Object.keys(this.lockfile.skills).length;
  }

  // ─── 更新检测 ────────────────────────────────────

  /**
   * 检查所有已安装技能的更新
   * 对标 Hermes check_for_skill_updates + OpenClaw updateSkillsFromClawHub
   *
   * @param fetchLatestHash 异步回调：给定 identifier/sourceUrl，返回最新内容的哈希
   */
  async checkForUpdates(
    fetchLatestHash: (entry: SkillLockEntry) => Promise<{ hash: string; version?: string } | null>,
  ): Promise<UpdateCheckResult[]> {
    const results: UpdateCheckResult[] = [];

    for (const [name, entry] of Object.entries(this.lockfile.skills)) {
      try {
        const latest = await fetchLatestHash(entry);
        if (!latest) {
          results.push({ name, status: "error", error: "Failed to fetch latest version" });
          continue;
        }

        if (latest.hash !== entry.contentHash) {
          results.push({
            name,
            status: "update_available",
            currentVersion: entry.version,
            latestVersion: latest.version,
            currentHash: entry.contentHash.slice(0, 12),
            latestHash: latest.hash.slice(0, 12),
          });
        } else {
          results.push({
            name,
            status: "up_to_date",
            currentVersion: entry.version,
            currentHash: entry.contentHash.slice(0, 12),
          });
        }
      } catch (err: any) {
        results.push({ name, status: "error", error: err.message });
      }
    }

    return results;
  }

  /**
   * 快速检查单个技能是否有更新
   */
  hasUpdate(name: string, newContentHash: string): boolean {
    const entry = this.lockfile.skills[name];
    if (!entry) return false;
    return entry.contentHash !== newContentHash;
  }

  // ─── 审计日志 ────────────────────────────────────

  /**
   * 追加审计日志条目
   * 对标 Hermes audit_log 追加模式
   */
  appendAuditLog(
    action: AuditLogEntry["action"],
    skillName: string,
    extra?: Record<string, unknown>,
  ): void {
    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      action,
      skillName,
      ...extra,
    };

    try {
      if (!existsSync(this.hubDir)) {
        mkdirSync(this.hubDir, { recursive: true });
      }
      const line = JSON.stringify(entry) + "\n";
      appendFileSync(this.auditLogPath, line, "utf-8");
    } catch (err: any) {
      logger.debug({ error: err.message }, "Failed to append audit log");
    }
  }

  /**
   * 读取审计日志
   */
  readAuditLog(limit = 100): AuditLogEntry[] {
    try {
      if (!existsSync(this.auditLogPath)) return [];
      const content = readFileSync(this.auditLogPath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      return lines
        .slice(-limit)
        .map((line) => {
          try {
            return JSON.parse(line) as AuditLogEntry;
          } catch {
            return null;
          }
        })
        .filter((e): e is AuditLogEntry => e !== null);
    } catch {
      return [];
    }
  }

  // ─── 工具方法 ────────────────────────────────────

  /** 从文件内容计算哈希 */
  static computeHash(content: string): string {
    return contentHash(content);
  }

  /** 格式化更新检测结果为可读文本 */
  static formatUpdateResults(results: UpdateCheckResult[]): string {
    if (results.length === 0) return "No installed skills to check.";

    const lines: string[] = [];
    const updates = results.filter((r) => r.status === "update_available");
    const upToDate = results.filter((r) => r.status === "up_to_date");
    const errors = results.filter((r) => r.status === "error");

    if (updates.length > 0) {
      lines.push(`${updates.length} update(s) available:`);
      for (const u of updates) {
        lines.push(`  ↑ ${u.name}: ${u.currentVersion ?? u.currentHash} → ${u.latestVersion ?? u.latestHash}`);
      }
    }
    if (upToDate.length > 0) {
      lines.push(`${upToDate.length} skill(s) up to date.`);
    }
    if (errors.length > 0) {
      lines.push(`${errors.length} check(s) failed:`);
      for (const e of errors) {
        lines.push(`  ✗ ${e.name}: ${e.error}`);
      }
    }

    return lines.join("\n");
  }
}
