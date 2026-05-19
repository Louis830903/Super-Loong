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
import { saveCronJob, loadCronJobs, deleteCronJob as deleteCronJobDB, addCronHistory, loadCronHistory, cleanupOldCronHistory } from "../persistence/sqlite.js";
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
  /** [v3] 调度类型: "cron"(默认) | "once" | "interval" */
  scheduleType?: "cron" | "once" | "interval";
  /** [v3] 一次性任务的执行时间 ISO 字符串 */
  runAt?: string;
  /** [v3] 间隔调度的间隔毫秒数 */
  intervalMs?: number;
  /** [v3] 任务超时秒数（默认 600） */
  timeoutSeconds?: number;
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

// ─── [v3] 运行时状态 — 仅内存，不混入 CronJobConfig（修复 C-1） ───
interface JobRuntimeState {
  consecutiveErrors: number;
  lastErrorReason?: string;
  /** "transient:rate_limit" | "transient:network" | "permanent" | ... */
  lastErrorCategory?: string;
}

// ─── [v3] 结构化返回类型（修复 L-5） ───
interface RunJobResult {
  ok: boolean;
  response: string;
}

// ─── [v3 Task 2-1] 瞬时错误分类（对齐 OpenClaw isTransientCronError） ───
const TRANSIENT_PATTERNS: Record<string, RegExp> = {
  rate_limit:   /(rate[_ ]limit|429|resource has been exhausted)/i,
  overloaded:   /\b529\b|\boverloaded\b|capacity exceeded/i,
  network:      /(network|econnreset|econnrefused|fetch failed)/i,
  timeout:      /(timeout|etimedout)/i,
  // [v3] 收紧 server_error 正则，避免误判普通数字（修复 L-4）
  server_error: /(?:status|http|code)\s*5\d{2}\b|\b5\d{2}\s*(?:error|internal|gateway|unavailable)/i,
};

/** 指数退避调度表（对齐 OpenClaw DEFAULT_BACKOFF_SCHEDULE_MS） */
const BACKOFF_SCHEDULE_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000];

export class CronScheduler {
  private jobs = new Map<string, CronJobConfig>();
  /** [v3] 全局 60s 唤醒定时器（替代 per-job timers） */
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  private _running = false;
  private executeCallback?: (job: CronJobConfig) => Promise<string>;
  /** [v3 Task 1-3] 心跳回调 */
  private heartbeatCallback?: (job: CronJobConfig) => Promise<string>;
  /** [v3] 运行时状态 Map — 仅内存（修复 C-1） */
  private runtimeState = new Map<string, JobRuntimeState>();
  /** [v3 Task 3-9] 连续失败告警 — 记录上次告警时间 */
  private lastAlertAtMs = new Map<string, number>();
  /** [v3 Task 3-9] 告警回调 */
  private alertCallback?: (job: CronJobConfig, message: string) => Promise<void>;
  /** [v3 Task 2-8] 正在执行 cron 的 agentId 集合（递归防护） */
  private _cronExecutionInProgress = new Set<string>();

  /** 60s 唤醒间隔（对齐 OpenClaw） */
  private static readonly WAKE_INTERVAL_MS = 60_000;
  /** 单次唤醒最多执行的到期任务数（修复 R-1） */
  private static readonly MAX_CONCURRENT_DUE = 3;
  /** [v3 Task 2-2] 历史清理间隔（每 24 小时一次） */
  private static readonly HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
  private lastHistoryCleanup = 0;

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
          // [v3 Task 3-8a] 加载新字段
          scheduleType: ((row.scheduleType as string) || "cron") as CronJobConfig["scheduleType"],
          runAt: row.runAt as string | undefined,
          intervalMs: row.intervalMs as number | undefined,
          timeoutSeconds: row.timeoutSeconds as number | undefined,
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

    // Calculate next run time — [v3] 传递 timezone
    job.nextRunAt = this.getNextRunTime(job.expression, job.timezone);

    this.jobs.set(job.id, job);
    saveCronJob(job);

    if (this._running && job.enabled) {
      this.armTimer(); // [v3] 替代 this.scheduleJob(job)
    }

    logger.info({ id: job.id, name: job.name, expression: job.expression }, "Cron job added");
    return job;
  }

  /** [v3] Remove a cron job. Returns true if found and removed */
  removeJob(id: string): boolean {
    if (!this.jobs.has(id)) return false;
    this.jobs.delete(id);
    this.runtimeState.delete(id);       // [v3] 清理运行时状态
    this.lastAlertAtMs.delete(id);      // [v3] 清理告警记录（修复 R-3）
    // [v3 Task 5] DB 删除失败不影响内存态：内存已删，下次启动从 DB 重建时该任务也不会复活
    // @why 容错优先：避免因 DB 短暂不可用导致 removeJob 整体失败
    try { deleteCronJobDB(id); } catch (err: unknown) {
      logger.debug({ id, err: err instanceof Error ? err.message : String(err) }, "deleteCronJobDB failed (non-fatal)");
    }
    if (this._running) this.armTimer(); // [v3] 触发重新评估
    logger.info({ id }, "Cron job removed");
    return true;
  }

  /** [v3] Enable a job — 替换 per-job scheduleJob 为全局 armTimer */
  enableJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = true;
    if (!job.nextRunAt) job.nextRunAt = this.getNextRunTime(job.expression, job.timezone);
    saveCronJob(job);
    if (this._running) this.armTimer();
  }

  /** [v3] Disable a job — 全局 wakeTimer 自动跳过 disabled job */
  disableJob(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.enabled = false;
    saveCronJob(job);
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
      job.nextRunAt = this.getNextRunTime(job.expression, job.timezone);
    }
    // [v3 Task 5] DB 持久化失败不影响内存调度：当次仍生效，重启后丢失
    // @why updateJob 多用于热更新参数，DB 失败可下次手动重写
    try { saveCronJob(job); } catch (err: unknown) {
      logger.debug({ id: job.id, err: err instanceof Error ? err.message : String(err) }, "saveCronJob (updateJob) failed (non-fatal)");
    }
    // [v3] 替代 per-job scheduleJob
    if (this._running && job.enabled) this.armTimer();
    return { ...job };
  }

  /** Get execution history for a job */
  getHistory(jobId: string, limit = 20): Array<Record<string, unknown>> {
    return loadCronHistory(jobId, limit);
  }

  /** [v3] Start the scheduler — 60s 全局唤醒机制 */
  start(callback?: (job: CronJobConfig) => Promise<string>): void {
    if (callback) this.executeCallback = callback;
    this._running = true;
    // 为没有 nextRunAt 的已启用任务计算首次运行时间
    for (const job of this.jobs.values()) {
      if (job.enabled && !job.nextRunAt) {
        job.nextRunAt = this.getNextRunTime(job.expression, job.timezone);
      }
    }
    this.armTimer();
    // [v3 Task 2-7] 异步启动补偿，catch 兜底（修复 L-3 + R-2）
    this.runMissedJobs().catch((e: unknown) => logger.error({ error: e }, "Startup compensation failed"));
    logger.info({ jobCount: this.jobs.size }, "Cron scheduler started (60s wake cycle)");
  }

  /** [v3] Stop the scheduler — 清除全局 wakeTimer */
  stop(): void {
    this._running = false;
    if (this.wakeTimer) {
      clearTimeout(this.wakeTimer);
      this.wakeTimer = null;
    }
    logger.info("Cron scheduler stopped");
  }

  /** @deprecated 使用 isRunning 替代 */
  get running(): boolean {
    return this._running;
  }

  get isRunning(): boolean {
    return this._running;
  }

  // ─── [v3] Internal — 全局唤醒 + 调度推进 + 运行时状态 ──────

  /** [v3] 设置心跳回调 — 心跳任务走独立路径（Task 1-3） */
  setHeartbeatCallback(fn: (job: CronJobConfig) => Promise<string>): void {
    this.heartbeatCallback = fn;
  }

  /** [v3] 设置告警回调（Task 3-9） */
  setAlertCallback(fn: (job: CronJobConfig, message: string) => Promise<void>): void {
    this.alertCallback = fn;
  }

  /** [v3 Task 2-8] 查询是否在 cron 执行上下文中（递归防护用） */
  isCronExecutionContext(agentId: string): boolean {
    return this._cronExecutionInProgress.has(agentId);
  }

  /** [v3] 获取或创建运行时状态 */
  private getRuntime(jobId: string): JobRuntimeState {
    let s = this.runtimeState.get(jobId);
    if (!s) { s = { consecutiveErrors: 0 }; this.runtimeState.set(jobId, s); }
    return s;
  }

  /** [v3 Task 2-7] 启动补偿 — 补执行停机期间错过的任务
   *  宽限期 = min(period/2, clamp(120s, 7200s))，超出宽限期的任务跳过 */
  private async runMissedJobs(): Promise<void> {
    const nowMs = Date.now();
    const missedJobs: CronJobConfig[] = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled || !job.nextRunAt) continue;
      const nextMs = new Date(job.nextRunAt).getTime();
      if (nextMs >= nowMs) continue; // 未过期

      // [审核 M-2] 从未执行过的任务（lastRunAt 为空）：直接补执行，不做宽限期判断
      if (!job.lastRunAt) {
        missedJobs.push(job);
        continue;
      }

      // 计算宽限期
      const lastMs = new Date(job.lastRunAt).getTime();
      const periodMs = nextMs - lastMs;
      const gracePeriodMs = Math.min(periodMs / 2, Math.max(120_000, Math.min(7_200_000, periodMs)));
      const missedByMs = nowMs - nextMs;

      if (missedByMs <= gracePeriodMs) {
        missedJobs.push(job);
      } else {
        // 超出宽限期: 跳过执行，推进到下次
        logger.info({ id: job.id, name: job.name, missedByMs }, "Missed job outside grace period, skipping");
        this.advanceSchedule(job);
        // [v3 Task 5] 推进 nextRunAt 后持久化；失败下次启动仍会重算
        try { saveCronJob(job); } catch (err: unknown) {
          logger.debug({ id: job.id, err: err instanceof Error ? err.message : String(err) }, "saveCronJob (advanceSchedule) failed (non-fatal)");
        }
      }
    }

    // 错开执行避免资源争抢
    const STAGGER_MS = 2_000;
    for (let i = 0; i < missedJobs.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
      const job = missedJobs[i];
      logger.info({ id: job.id, name: job.name }, "Running missed job (startup compensation)");
      await this.runJob(job);
      // runJob() 已通过 advanceSchedule() 统一推进调度
    }

    if (missedJobs.length > 0) {
      logger.info({ count: missedJobs.length }, "Startup compensation complete");
    }
  }

  /** [v3] 全局 60s 唤醒定时器 — 每次唤醒后递归 armTimer（对齐 OpenClaw） */
  private armTimer(): void {
    if (!this._running) return;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.wakeTimer = setTimeout(() => this.onTimer(), CronScheduler.WAKE_INTERVAL_MS);
    // [v3 Task 2-6] 不阻止 Node 进程退出
    if (this.wakeTimer && typeof this.wakeTimer === "object" && "unref" in this.wakeTimer) {
      this.wakeTimer.unref();
    }
  }

  /** [v3] 全局唤醒回调 — 收集到期任务并执行 */
  private async onTimer(): Promise<void> {
    if (!this._running) return;

    // [v3 Task 2-2] 定期清理过期历史记录
    const now = Date.now();
    if (now - this.lastHistoryCleanup > CronScheduler.HISTORY_CLEANUP_INTERVAL_MS) {
      this.lastHistoryCleanup = now;
      try { cleanupOldCronHistory(30); } catch (e) { logger.error({ error: e }, "History cleanup failed"); }
    }

    const nowMs = Date.now();
    const dueJobs: CronJobConfig[] = [];

    for (const job of this.jobs.values()) {
      if (!job.enabled || !job.nextRunAt) continue;
      if (new Date(job.nextRunAt).getTime() <= nowMs) {
        dueJobs.push(job);
      }
    }

    // [v3] 限制单次最大执行数，防止阻塞（修复 R-1）
    const batch = dueJobs.slice(0, CronScheduler.MAX_CONCURRENT_DUE);

    for (const job of batch) {
      if (!this._running) break;
      await this.runJob(job);
      // [v3 关键修正] 不在此处更新 nextRunAt/lastRunAt
      // runJob() 内部已统一处理所有状态更新
    }

    if (this._running) this.armTimer();
  }

  /** [v3] 统一调度推进 — nextRunAt 更新的唯一入口（修复 L-1） */
  private advanceSchedule(job: CronJobConfig): void {
    const schedType = job.scheduleType ?? "cron";
    if (schedType === "once") {
      job.enabled = false;
      job.nextRunAt = undefined;
    } else if (schedType === "interval") {
      job.nextRunAt = new Date(Date.now() + (job.intervalMs ?? 60_000)).toISOString();
    } else {
      // cron 类型
      job.nextRunAt = this.getNextRunTime(job.expression, job.timezone);
    }
  }

  /** [v3 Task 2-1 最终版] runJob — 含重试 + 错误分类 + 退避 + 调度推进
   *  maxRetries 语义 = 最大尝试次数（含首次），如 maxRetries=3 → 最多执行 3 次 */
  private async runJob(job: CronJobConfig): Promise<RunJobResult> {
    // [v3 Task 2-8] 标记执行上下文（递归防护）
    this._cronExecutionInProgress.add(job.agentId);
    try {
      return await this.runJobInner(job);
    } finally {
      this._cronExecutionInProgress.delete(job.agentId);
    }
  }

  /** runJob 内部实现 — 含完整重试循环 */
  private async runJobInner(job: CronJobConfig): Promise<RunJobResult> {
    const maxAttempts = Math.max(1, job.maxRetries ?? 1);
    let lastError: Error | null = null;
    const rt = this.getRuntime(job.id);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const history: CronHistory = {
        jobId: job.id,
        startedAt: new Date().toISOString(),
        status: "running",
      };

      try {
        const timeoutMs = (job.timeoutSeconds ?? 600) * 1000;
        let response: string;
        const execPromise = (job.agentId === "__heartbeat__" && this.heartbeatCallback)
          ? this.heartbeatCallback(job)
          : this.executeCallback
            ? this.executeCallback(job)
            : Promise.resolve(`[Cron] Job "${job.name}" executed (no callback set)`);
        // [v3 Task 3-7] Promise.race 超时保护（修复审核 S-2: 清除幽灵定时器）
        let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error(`Cron job "${job.name}" timed out after ${job.timeoutSeconds ?? 600}s`)), timeoutMs);
          // [审核 L-1] 不阻止进程退出
          if (timeoutHandle && typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
            timeoutHandle.unref();
          }
        });
        try {
          response = await Promise.race([execPromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }

        history.finishedAt = new Date().toISOString();
        history.status = "success";
        history.response = response;

        // 成功: 重置运行时状态
        rt.consecutiveErrors = 0;
        rt.lastErrorReason = undefined;
        rt.lastErrorCategory = undefined;

        // 统一状态更新 — runJob 是唯一写入点
        job.lastRunAt = history.startedAt;
        this.advanceSchedule(job);
        saveCronJob(job);
        addCronHistory(history);
        logger.info({ id: job.id, name: job.name, attempt }, "Cron job executed successfully");
        return { ok: true, response };
      } catch (err: any) {
        lastError = err;
        history.finishedAt = new Date().toISOString();
        history.status = "error";
        history.error = `[Attempt ${attempt}/${maxAttempts}] ${err.message}`;
        addCronHistory(history);

        const { transient, category } = CronScheduler.classifyError(err.message);

        // 永久错误 → 立即终止重试
        if (!transient) {
          logger.error({ id: job.id, attempt, error: err.message }, "Permanent error, skipping retries");
          break;
        }

        logger.warn({ id: job.id, attempt, maxAttempts, category }, "Transient error, retrying");

        // 重试前退避: 5s × 2^(attempt-1) → 5s, 10s, 20s
        if (attempt < maxAttempts) {
          await new Promise(r => setTimeout(r, 5_000 * Math.pow(2, attempt - 1)));
        }
      }
    }

    // ─── 所有重试都失败 ───────────────────────────────────
    rt.consecutiveErrors++;
    rt.lastErrorReason = lastError?.message;
    const { transient, category } = CronScheduler.classifyError(lastError?.message ?? "");
    rt.lastErrorCategory = transient ? `transient:${category}` : "permanent";

    // 瞬时错误 → 退避调度；永久错误 → 正常推进
    if (transient) {
      const idx = Math.min(rt.consecutiveErrors - 1, BACKOFF_SCHEDULE_MS.length - 1);
      const naturalMs = new Date(job.nextRunAt ?? 0).getTime();
      job.nextRunAt = new Date(Math.max(naturalMs, Date.now() + BACKOFF_SCHEDULE_MS[idx])).toISOString();
    } else {
      this.advanceSchedule(job);
    }

    job.lastRunAt = new Date().toISOString();
    // [v3 Task 5] 失败重试用尽后落库；持久化失败不影响告警链路
    // @why 告警必须发出，DB 失败仅丢失 lastRunAt 时间戳，可下次执行覆盖
    try { saveCronJob(job); } catch (err: unknown) {
      logger.debug({ id: job.id, err: err instanceof Error ? err.message : String(err) }, "saveCronJob (after retries) failed (non-fatal)");
    }
    this.checkFailureAlert(job);
    logger.error({ id: job.id, maxAttempts }, "Cron job failed after all retries");
    return { ok: false, response: `All ${maxAttempts} attempts failed: ${lastError?.message}` };
  }

  /** [v3] 瞬时错误分类 — 对齐 OpenClaw isTransientCronError */
  private static classifyError(message: string): { transient: boolean; category?: string } {
    for (const [cat, re] of Object.entries(TRANSIENT_PATTERNS)) {
      if (re.test(message)) return { transient: true, category: cat };
    }
    return { transient: false };
  }

  /** [v3 Task 3-9] 连续失败告警检查 */
  private checkFailureAlert(job: CronJobConfig): void {
    const rt = this.getRuntime(job.id);
    if (rt.consecutiveErrors < 3) return; // 连续 3 次失败后触发
    const lastAlert = this.lastAlertAtMs.get(job.id) ?? 0;
    const cooldown = 30 * 60_000; // 30 分钟冷却期
    if (Date.now() - lastAlert < cooldown) return;
    this.lastAlertAtMs.set(job.id, Date.now());
    const msg = `Cron job "${job.name}" (${job.id}) failed ${rt.consecutiveErrors} consecutive times. Last error: ${rt.lastErrorReason ?? "unknown"}`;
    if (this.alertCallback) {
      this.alertCallback(job, msg).catch(e => logger.error({ error: e }, "Alert callback failed"));
    }
    logger.warn({ id: job.id, consecutiveErrors: rt.consecutiveErrors }, msg);
  }

  /** [v3] 手动执行 — 适配 RunJobResult（修复 L-5） */
  async executeNow(id: string): Promise<string> {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Cron job ${id} not found`);
    const result = await this.runJob(job);
    if (!result.ok) throw new Error(result.response);
    return result.response;
  }

  /** [v3 Task 1-0] 获取下次运行时间 ISO 字符串 — 传递 timezone 而非硬编码 */
  private getNextRunTime(expression: string, timezone?: string): string {
    try {
      return this.parseCronNextRun(expression, timezone).toISOString();
    } catch {
      return new Date(Date.now() + 60000).toISOString();
    }
  }

  /**
   * [v3 Task 1-0] 解析 cron 表达式，返回下次执行时间。
   * 支持 5 段式 cron: minute hour day-of-month month day-of-week
   * 及别名 @hourly / @daily / @weekly / @monthly / @yearly
   */
  private parseCronNextRun(expr: string, timezone?: string): Date {
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
      tz: timezone || "Asia/Shanghai",
    });
    return interval.next().toDate();
  }
}

/**
 * [v3 Task 2-4] 增强版自然语言 → cron 表达式转换。
 * 支持中英文时间描述，返回 { expression, matched } 便于校验。
 * Falls back to simple pattern matching if no LLM is available.
 */
export function parseNaturalLanguageToCron(input: string): string {
  const result = parseNaturalLanguageToCronEx(input);
  return result.expression;
}

/** 增强版: 返回匹配信息 */
export function parseNaturalLanguageToCronEx(input: string): { expression: string; matched: boolean } {
  const lower = input.toLowerCase().trim();

  // 基础频率匹配
  if (/every\s+minute/i.test(lower) || /每分钟/.test(lower)) return { expression: "* * * * *", matched: true };
  if (/every\s+hour/i.test(lower) || /每小时/.test(lower)) return { expression: "0 * * * *", matched: true };
  if (/every\s+day/i.test(lower) || /每天/.test(lower) || /每日/.test(lower)) return { expression: "0 9 * * *", matched: true };
  if (/every\s+week/i.test(lower) || /每周/.test(lower) || /每星期/.test(lower)) return { expression: "0 9 * * 1", matched: true };
  if (/every\s+month/i.test(lower) || /每月/.test(lower)) return { expression: "0 9 1 * *", matched: true };

  // 中文星期匹配: "每周三下午3点"
  const weekdayCn: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
  const weekMatch = lower.match(/每?(?:周|星期)([一二三四五六日天]).*?(\d{1,2})\s*[点时:]\s*(\d{0,2})?/);
  if (weekMatch) {
    const dow = weekdayCn[weekMatch[1]] ?? 1;
    const hour = parseInt(weekMatch[2]);
    const minute = weekMatch[3] ? parseInt(weekMatch[3]) : 0;
    return { expression: `${minute} ${hour} * * ${dow}`, matched: true };
  }

  // 英文 weekday: "every wednesday at 3pm"
  const weekdayEn: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const enWeekMatch = lower.match(/every\s+(sun|mon|tue|wed|thu|fri|sat)\w*\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?(?:\s*(am|pm))?/i);
  if (enWeekMatch) {
    const dow = weekdayEn[enWeekMatch[1].slice(0, 3).toLowerCase()] ?? 1;
    let hour = parseInt(enWeekMatch[2]);
    const minute = enWeekMatch[3] ? parseInt(enWeekMatch[3]) : 0;
    if (enWeekMatch[4]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (enWeekMatch[4]?.toLowerCase() === "am" && hour === 12) hour = 0;
    return { expression: `${minute} ${hour} * * ${dow}`, matched: true };
  }

  // 中文上/下午 + 时间: "每天下午3点30分"
  const cnAmPm = lower.match(/(上午|下午|早上|晚上|凌晨)?(\d{1,2})\s*[点时:]\s*(\d{0,2})?/);
  if (cnAmPm) {
    let hour = parseInt(cnAmPm[2]);
    const minute = cnAmPm[3] ? parseInt(cnAmPm[3]) : 0;
    const period = cnAmPm[1];
    if ((period === "下午" || period === "晚上") && hour < 12) hour += 12;
    if (period === "凌晨" && hour === 12) hour = 0;
    return { expression: `${minute} ${hour} * * *`, matched: true };
  }

  // 英文时间: "9am daily" / "at 14:30"
  const enTime = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
  if (enTime) {
    let hour = parseInt(enTime[1]);
    const minute = enTime[2] ? parseInt(enTime[2]) : 0;
    if (enTime[3]?.toLowerCase() === "pm" && hour < 12) hour += 12;
    if (enTime[3]?.toLowerCase() === "am" && hour === 12) hour = 0;
    return { expression: `${minute} ${hour} * * *`, matched: true };
  }

  // 无法匹配 → 默认每天 9:00，标记未匹配
  return { expression: "0 9 * * *", matched: false };
}

/** [v3 Task 2-5] 校验 cron 表达式是否合法 */
export function validateCronExpression(expression: string): { valid: boolean; error?: string } {
  const aliases: Record<string, string> = {
    "@hourly": "0 * * * *", "@daily": "0 0 * * *",
    "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *",
  };
  const cronExpr = aliases[expression] ?? expression;
  try {
    CronExpressionParser.parse(cronExpr);
    return { valid: true };
  } catch (err: any) {
    return { valid: false, error: err.message };
  }
}
