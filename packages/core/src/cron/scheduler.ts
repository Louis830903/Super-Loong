/**
 * Cron Scheduler — manages and executes scheduled tasks.
 *
 * Features:
 * - Cron expression parsing and scheduling
 * - Natural language → cron expression conversion (via LLM)
 * - Execution history tracking
 * - Agent-based task execution with optional IM delivery
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { CronExpressionParser } from "cron-parser";
import { saveCronJob, loadCronJobs, deleteCronJob as deleteCronJobDB, addCronHistory, loadCronHistory } from "../persistence/sqlite.js";
import { scanCronPrompt } from "../prompt/injection-guard.js";

const logger = pino({ name: "cron-scheduler" });

export interface CronJobConfig {
  id: string;
  name: string;
  expression: string;
  naturalLanguage?: string;
  agentId: string;
  message: string;
  deliveryChannel?: string;
  deliveryChatId?: string;
  enabled: boolean;
  timezone: string;
  maxRetries: number;
  createdAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
}

export interface CronHistory {
  jobId: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "success" | "error";
  response?: string;
  error?: string;
  deliveryStatus?: string;
}

export class CronScheduler {
  private jobs = new Map<string, CronJobConfig>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private _running = false;
  private executeCallback?: (job: CronJobConfig) => Promise<string>;

  constructor() {}

  /** Set the callback that executes a cron job (called by the API layer) */
  setExecuteCallback(fn: (job: CronJobConfig) => Promise<string>): void {
    this.executeCallback = fn;
  }

  /** Load jobs from database */
  loadFromDB(): void {
    try {
      const rows = loadCronJobs();
      for (const row of rows) {
        const job: CronJobConfig = {
          id: row.id as string,
          name: row.name as string,
          expression: row.expression as string,
          naturalLanguage: row.naturalLanguage as string | undefined,
          agentId: row.agentId as string,
          message: row.message as string,
          deliveryChannel: row.deliveryChannel as string | undefined,
          deliveryChatId: row.deliveryChatId as string | undefined,
          enabled: row.enabled as boolean,
          timezone: (row.timezone as string) || "Asia/Shanghai",
          maxRetries: (row.maxRetries as number) || 1,
          createdAt: row.createdAt as string,
          lastRunAt: row.lastRunAt as string | undefined,
          nextRunAt: row.nextRunAt as string | undefined,
        };
        this.jobs.set(job.id, job);
      }
      logger.info({ count: rows.length }, "Cron jobs loaded from database");
    } catch {
      logger.warn("No cron jobs found in database (first run)");
    }
  }

  /** Add a new cron job */
  addJob(config: Partial<Omit<CronJobConfig, "id" | "createdAt">> & Pick<CronJobConfig, "name" | "expression" | "agentId" | "message">): CronJobConfig {
    // Phase 5: 扫描 Cron 提示词是否包含注入威胁（学 Hermes _scan_cron_prompt）
    const cronScan = scanCronPrompt(config.message);
    if (!cronScan.safe) {
      const patterns = cronScan.findings.join(", ");
      throw new Error(`[Security] Cron prompt blocked — detected threat patterns: ${patterns}`);
    }

    const job: CronJobConfig = {
      enabled: true,
      timezone: "Asia/Shanghai",
      maxRetries: 1,
      ...config,
      id: uuid(),
      createdAt: new Date().toISOString(),
    };

    // Calculate next run time
    job.nextRunAt = this.getNextRunTime(job.expression);

    this.jobs.set(job.id, job);
    saveCronJob(job);

    if (this._running && job.enabled) {
      this.scheduleJob(job);
    }

    logger.info({ id: job.id, name: job.name, expression: job.expression }, "Cron job added");
    return job;
  }

  /** Remove a cron job. Returns true if found and removed, false if not found */
  removeJob(id: string): boolean {
    if (!this.jobs.has(id)) return false;
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.jobs.delete(id);
    try { deleteCronJobDB(id); } catch {}
    logger.info({ id }, "Cron job removed");
    return true;
  }

  /** Enable a job */
  enableJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = true;
    saveCronJob(job);
    if (this._running) this.scheduleJob(job);
  }

  /** Disable a job */
  disableJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = false;
    saveCronJob(job);
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /** List all jobs */
  listJobs(): CronJobConfig[] {
    return Array.from(this.jobs.values());
  }

  /** Get a specific job */
  getJob(id: string): CronJobConfig | undefined {
    return this.jobs.get(id);
  }

  /** Update a cron job's properties */
  updateJob(id: string, updates: Partial<Omit<CronJobConfig, "id" | "createdAt">>): CronJobConfig | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    Object.assign(job, updates);
    if (updates.expression) {
      job.nextRunAt = this.getNextRunTime(job.expression);
    }
    try { saveCronJob(job); } catch {}
    // Re-schedule if running
    if (this._running && job.enabled) {
      this.scheduleJob(job);
    }
    return { ...job };
  }

  /** Get execution history for a job */
  getHistory(jobId: string, limit = 20): Array<Record<string, unknown>> {
    return loadCronHistory(jobId, limit);
  }

  /** Execute a job immediately (manual trigger) */
  async executeNow(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Cron job ${id} not found`);
    return this.runJob(job);
  }

  /** Start the scheduler — schedules all enabled jobs */
  start(callback?: (job: CronJobConfig) => Promise<string>): void {
    if (callback) this.executeCallback = callback;
    this._running = true;
    for (const job of this.jobs.values()) {
      if (job.enabled) {
        this.scheduleJob(job);
      }
    }
    logger.info({ jobCount: this.jobs.size }, "Cron scheduler started");
  }

  /** Stop the scheduler */
  stop(): void {
    this._running = false;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    logger.info("Cron scheduler stopped");
  }

  /** @deprecated 使用 isRunning 替代 */
  get running(): boolean {
    return this._running;
  }

  get isRunning(): boolean {
    return this._running;
  }

  // ─── Internal ──────────────────────────────────────────────

  private scheduleJob(job: CronJobConfig): void {
    // Clear existing timer
    const existing = this.timers.get(job.id);
    if (existing) clearTimeout(existing);

    const nextMs = this.getNextRunMs(job.expression);
    if (nextMs <= 0) {
      logger.warn({ id: job.id, expression: job.expression }, "Invalid cron expression, skipping");
      return;
    }

    // Cap at 24 hours (re-evaluate after)
    const delay = Math.min(nextMs, 24 * 60 * 60 * 1000);

    const timer = setTimeout(async () => {
      if (!this._running || !job.enabled) return;

      await this.runJob(job);

      // Re-schedule
      if (this._running && job.enabled) {
        this.scheduleJob(job);
      }
    }, delay);

    this.timers.set(job.id, timer);
    job.nextRunAt = new Date(Date.now() + nextMs).toISOString();
  }

  private async runJob(job: CronJobConfig): Promise<string> {
    const history: CronHistory = {
      jobId: job.id,
      startedAt: new Date().toISOString(),
      status: "running",
    };

    try {
      let response: string;
      if (this.executeCallback) {
        response = await this.executeCallback(job);
      } else {
        response = `[Cron] Job "${job.name}" executed (no callback set)`;
      }

      history.finishedAt = new Date().toISOString();
      history.status = "success";
      history.response = response;

      job.lastRunAt = history.startedAt;
      saveCronJob(job);
      addCronHistory(history);

      logger.info({ id: job.id, name: job.name }, "Cron job executed successfully");
      return response;
    } catch (err: any) {
      history.finishedAt = new Date().toISOString();
      history.status = "error";
      history.error = err.message;

      addCronHistory(history);
      logger.error({ id: job.id, error: err.message }, "Cron job execution failed");
      throw err;
    }
  }

  /** Parse cron expression and get milliseconds until next run */
  private getNextRunMs(expression: string): number {
    try {
      const next = this.parseCronNextRun(expression);
      return Math.max(next.getTime() - Date.now(), 1000);
    } catch {
      return 60000; // Default: 1 minute
    }
  }

  /** Get next run time as ISO string */
  private getNextRunTime(expression: string): string {
    try {
      return this.parseCronNextRun(expression).toISOString();
    } catch {
      return new Date(Date.now() + 60000).toISOString();
    }
  }

  /**
   * Parse cron expression using cron-parser library.
   * Supports full 5-field cron: minute hour day-of-month month day-of-week.
   * Including ranges, steps, lists, and aliases like @hourly etc.
   */
  private parseCronNextRun(expr: string): Date {
    // Handle aliases that cron-parser may not support directly
    const aliases: Record<string, string> = {
      "@hourly": "0 * * * *",
      "@daily": "0 0 * * *",
      "@weekly": "0 0 * * 0",
      "@monthly": "0 0 1 * *",
      "@yearly": "0 0 1 1 *",
    };
    const cronExpr = aliases[expr] ?? expr;

    const interval = CronExpressionParser.parse(cronExpr, {
      currentDate: new Date(),
      tz: "Asia/Shanghai",
    });
    return interval.next().toDate();
  }
}

/**
 * Parse natural language time description to cron expression using LLM.
 * Falls back to simple pattern matching if no LLM is available.
 */
export function parseNaturalLanguageToCron(input: string): string {
  const lower = input.toLowerCase();

  // Simple pattern matching
  if (/every\s+minute/i.test(lower) || /每分钟/.test(lower)) return "* * * * *";
  if (/every\s+hour/i.test(lower) || /每小时/.test(lower)) return "0 * * * *";
  if (/every\s+day/i.test(lower) || /每天/.test(lower) || /每日/.test(lower)) return "0 9 * * *";
  if (/every\s+week/i.test(lower) || /每周/.test(lower) || /每星期/.test(lower)) return "0 9 * * 1";
  if (/every\s+month/i.test(lower) || /每月/.test(lower)) return "0 9 1 * *";

  // Time patterns: "每天早上9点" / "9am daily"
  const timeMatch = lower.match(/(\d{1,2})\s*[点时:]\s*(\d{0,2})?/);
  if (timeMatch) {
    const hour = parseInt(timeMatch[1]);
    const minute = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
    return `${minute} ${hour} * * *`;
  }

  // Default: every day at 9:00
  return "0 9 * * *";
}
