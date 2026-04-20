/**
 * Middleware module for Super Agent API.
 *
 * - Rate limiting (in-memory sliding window)
 * - Request logging (structured)
 * - Global error handler (Zod / business / unexpected)
 * - Request ID injection
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";

// ─── Request ID ──────────────────────────────────────────────

export async function registerRequestId(app: FastifyInstance): Promise<void> {
  app.addHook("onRequest", async (request: FastifyRequest) => {
    const rid = (request.headers["x-request-id"] as string) ?? crypto.randomUUID();
    (request as any).requestId = rid;
  });

  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("x-request-id", (request as any).requestId ?? "");
  });
}

// ─── Rate Limiter (in-memory sliding window) ─────────────────

interface RateLimitEntry {
  tokens: number;
  lastRefill: number;
}

export interface RateLimitConfig {
  /** Max requests per window */
  max: number;
  /** Window size in milliseconds */
  windowMs: number;
  /** Paths to skip rate limiting */
  skipPaths?: string[];
  /** Custom key extractor (default: IP) */
  keyExtractor?: (request: FastifyRequest) => string;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  max: parseInt(process.env.RATE_LIMIT_MAX ?? "100", 10),
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
  skipPaths: ["/api/system/health", "/v1/models"],
};

export async function registerRateLimit(
  app: FastifyInstance,
  config: Partial<RateLimitConfig> = {},
): Promise<void> {
  const cfg = { ...DEFAULT_RATE_LIMIT, ...config };
  const buckets = new Map<string, RateLimitEntry>();

  // Cleanup stale entries every 5 minutes
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of buckets) {
      if (now - entry.lastRefill > cfg.windowMs * 2) buckets.delete(key);
    }
  }, 300_000);

  app.addHook("onClose", () => clearInterval(cleanup));

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (cfg.skipPaths?.some((p) => request.url.startsWith(p))) return;

    const key = cfg.keyExtractor?.(request) ?? (request.ip || "unknown");
    const now = Date.now();

    let entry = buckets.get(key);
    if (!entry) {
      entry = { tokens: cfg.max, lastRefill: now };
      buckets.set(key, entry);
    }

    // Refill tokens based on elapsed time
    const elapsed = now - entry.lastRefill;
    const refill = Math.floor((elapsed / cfg.windowMs) * cfg.max);
    if (refill > 0) {
      entry.tokens = Math.min(cfg.max, entry.tokens + refill);
      entry.lastRefill = now;
    }

    // Set rate limit headers
    reply.header("X-RateLimit-Limit", cfg.max);
    reply.header("X-RateLimit-Remaining", Math.max(0, entry.tokens - 1));
    reply.header("X-RateLimit-Reset", Math.ceil((entry.lastRefill + cfg.windowMs) / 1000));

    if (entry.tokens <= 0) {
      reply.header("Retry-After", Math.ceil(cfg.windowMs / 1000));
      return reply.status(429).send({
        error: "Too Many Requests",
        message: `Rate limit exceeded. Try again in ${Math.ceil(cfg.windowMs / 1000)}s`,
        retryAfter: Math.ceil(cfg.windowMs / 1000),
      });
    }

    entry.tokens--;
  });

  app.log.info({ max: cfg.max, windowMs: cfg.windowMs }, "Rate limiting enabled");
}

// ─── Request Logging ─────────────────────────────────────────

export async function registerRequestLogging(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    const duration = reply.elapsedTime;
    const status = reply.statusCode;

    // Skip noisy health checks in logs
    if (request.url === "/api/system/health") return;

    const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";

    app.log[level]({
      method: request.method,
      url: request.url,
      status,
      duration: `${duration.toFixed(1)}ms`,
      ip: request.ip,
      requestId: (request as any).requestId,
    }, `${request.method} ${request.url} → ${status} (${duration.toFixed(1)}ms)`);
  });
}

// ─── Global Error Handler ────────────────────────────────────

export async function registerErrorHandler(app: FastifyInstance): Promise<void> {
  app.setErrorHandler(async (error: Error, request: FastifyRequest, reply: FastifyReply) => {
    const requestId = (request as any).requestId;

    // Zod validation errors → 400
    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Validation Error",
        message: "Request body validation failed",
        details: error.errors.map((e) => ({
          path: e.path.join("."),
          message: e.message,
        })),
        requestId,
      });
    }

    // Fastify validation errors → 400
    if ((error as any).validation) {
      return reply.status(400).send({
        error: "Validation Error",
        message: error.message,
        requestId,
      });
    }

    // Known status code errors
    const statusCode = (error as any).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({
        error: error.name || "Error",
        message: error.message,
        requestId,
      });
    }

    // Unexpected errors → 500
    app.log.error({
      err: error,
      method: request.method,
      url: request.url,
      requestId,
    }, "Unhandled error");

    return reply.status(500).send({
      error: "Internal Server Error",
      message: process.env.NODE_ENV === "production"
        ? "An unexpected error occurred"
        : error.message,
      requestId,
    });
  });
}

// ─── Not Found Handler ───────────────────────────────────────

export async function registerNotFoundHandler(app: FastifyInstance): Promise<void> {
  app.setNotFoundHandler(async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(404).send({
      error: "Not Found",
      message: `Route ${request.method} ${request.url} not found`,
      requestId: (request as any).requestId,
    });
  });
}

// ─── Register All Middleware ─────────────────────────────────

export async function registerMiddleware(
  app: FastifyInstance,
  options?: { rateLimit?: Partial<RateLimitConfig> },
): Promise<void> {
  await registerRequestId(app);
  await registerRequestLogging(app);
  await registerErrorHandler(app);
  await registerNotFoundHandler(app);
  await registerRateLimit(app, options?.rateLimit);
}
