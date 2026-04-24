/**
 * 通用指数退避重试函数 — 从 a2a-client.ts rpcCall 和 a2a-push.ts deliverWithRetry 提取
 *
 * 消除两处高度重复的重试逻辑（延迟计算、尝试次数、transient 判断），
 * 统一为一个可复用的公共函数。
 */

import pino from "pino";

const logger = pino({ name: "retry" });

/** 重试配置 */
export interface RetryConfig {
  /** 最大尝试次数（含首次，默认 3） */
  maxAttempts?: number;
  /** 首次重试延迟（毫秒，默认 500） */
  initialDelayMs?: number;
  /** 最大延迟上限（毫秒，默认 8000） */
  maxDelayMs?: number;
}

const DEFAULTS: Required<RetryConfig> = {
  maxAttempts: 3,
  initialDelayMs: 500,
  maxDelayMs: 8000,
};

/**
 * 带指数退避的通用重试函数
 * @param fn - 执行函数
 * @param config - 重试配置
 * @param isTransient - 判断错误是否可重试（默认全部可重试）
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  config?: RetryConfig,
  isTransient?: (error: unknown) => boolean,
): Promise<T> {
  const { maxAttempts, initialDelayMs, maxDelayMs } = { ...DEFAULTS, ...config };

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // 非瞬态错误不重试
      if (isTransient && !isTransient(err)) throw err;

      // 最后一次尝试不等待
      if (attempt + 1 >= maxAttempts) break;

      const delay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
      logger.debug({ attempt: attempt + 1, maxAttempts, delay }, "Retrying after transient error");
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  throw lastError;
}
