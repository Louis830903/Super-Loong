/**
 * 进化锁与并发控制（Task 3.4）
 *
 * 防止并发进化周期同时修改同一文件。
 * - 文件锁（.evolution-lock 标记文件）+ 进程级内存锁
 * - 超时释放：锁超过 15 分钟 → 自动过期
 * - withLock() 高阶函数：自动 acquire/release
 */

import { existsSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pino from "pino";

const logger = pino({ name: "evolution:lock" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 锁状态 */
export interface LockState {
  /** 是否持有锁 */
  locked: boolean;
  /** 锁持有者标识 */
  holder?: string;
  /** 锁获取时间 */
  acquiredAt?: Date;
  /** 锁超时时间 */
  expiresAt?: Date;
}

// ═══════════════════════════════════════════════════════════════
// EvolutionLock
// ═══════════════════════════════════════════════════════════════

export class EvolutionLock {
  /** 文件锁路径 */
  private lockPath: string;
  /** 进程级内存锁 */
  private memoryLocked: boolean = false;
  /** 锁持有者 */
  private holder: string = "";
  /** 锁超时（ms） */
  private timeoutMs: number;
  /** 锁定时器 */
  private expireTimer: ReturnType<typeof setTimeout> | null = null;

  /** 默认锁超时：15 分钟 */
  private static readonly DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
  /** 锁文件后缀 */
  private static readonly LOCK_FILE = ".evolution-lock";

  constructor(dataDir?: string, timeoutMs?: number) {
    const dir = dataDir ?? process.cwd();
    this.lockPath = join(dir, EvolutionLock.LOCK_FILE);
    this.timeoutMs = timeoutMs ?? EvolutionLock.DEFAULT_TIMEOUT_MS;
  }

  /**
   * 尝试获取锁
   * @param owner 锁持有者标识（如 "coordinator" / "proposal_xxx"）
   * @returns true 如果成功获取
   */
  acquireLock(owner: string = "evolution"): boolean {
    // 1. 检查进程级内存锁
    if (this.memoryLocked) {
      logger.debug({ holder: this.holder }, "Lock already held in memory");
      return false;
    }

    // 2. 检查文件锁是否存在且未过期
    if (existsSync(this.lockPath)) {
      try {
        const content = readFileSync(this.lockPath, "utf-8");
        const existing = JSON.parse(content) as { holder: string; acquiredAt: string; expiresAt: string };
        const expiresAt = new Date(existing.expiresAt).getTime();

        if (Date.now() < expiresAt) {
          // 锁未过期
          logger.debug({ existingHolder: existing.holder }, "Lock held by another process");
          return false;
        }

        // 锁已过期 → 强制释放
        logger.warn({ expiredHolder: existing.holder, acquiredAt: existing.acquiredAt },
          "Lock expired, force releasing");
        this.releaseLock();
      } catch {
        // 文件损坏 → 删除重建
        try { unlinkSync(this.lockPath); } catch { /* ignore */ }
      }
    }

    // 3. 获取锁
    const now = new Date();
    const lockData = {
      holder: owner,
      acquiredAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.timeoutMs).toISOString(),
    };

    try {
      writeFileSync(this.lockPath, JSON.stringify(lockData), "utf-8");
      this.memoryLocked = true;
      this.holder = owner;

      // 设置自动过期定时器
      this.expireTimer = setTimeout(() => {
        logger.warn({ holder: this.holder }, "Lock auto-expired by timer");
        this.releaseLock();
      }, this.timeoutMs);

      logger.info({ holder: owner }, "Lock acquired");
      return true;
    } catch (err: any) {
      logger.error({ err: err.message }, "Failed to acquire lock");
      return false;
    }
  }

  /**
   * 释放锁
   */
  releaseLock(): void {
    // 清除定时器
    if (this.expireTimer) {
      clearTimeout(this.expireTimer);
      this.expireTimer = null;
    }

    // 删除文件锁
    try {
      if (existsSync(this.lockPath)) {
        unlinkSync(this.lockPath);
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Failed to remove lock file");
    }

    this.memoryLocked = false;
    logger.info({ holder: this.holder }, "Lock released");
  }

  /**
   * 高阶函数：自动 acquire/release
   *
   * @param fn 需要被锁保护的异步函数
   * @param owner 锁持有者标识
   * @returns fn 的返回值，如果获取锁失败则返回 null
   */
  async withLock<T>(fn: () => Promise<T>, owner: string = "evolution"): Promise<T | null> {
    if (!this.acquireLock(owner)) {
      logger.info({ owner }, "Skipped: lock not acquired");
      return null;
    }

    try {
      return await fn();
    } finally {
      this.releaseLock();
    }
  }

  /**
   * 获取当前锁状态
   */
  getState(): LockState {
    if (!this.memoryLocked) {
      return { locked: false };
    }

    const expiresAt = this.expireTimer
      ? new Date(Date.now() + this.timeoutMs)
      : undefined;

    return {
      locked: true,
      holder: this.holder,
      acquiredAt: new Date(),
      expiresAt,
    };
  }

  /**
   * 检查是否可以获取锁（不实际获取）
   */
  canAcquire(): boolean {
    if (this.memoryLocked) return false;

    if (existsSync(this.lockPath)) {
      try {
        const content = readFileSync(this.lockPath, "utf-8");
        const existing = JSON.parse(content);
        return Date.now() >= new Date(existing.expiresAt).getTime();
      } catch {
        return true; // 文件损坏，可以获取
      }
    }

    return true;
  }
}
