/**
 * Docling Sidecar HTTP 客户端（知识库 Spec §T7）。
 *
 * 职责：
 *   - 把 ParserInput（buffer + filename + mime）转成 POST /parse 请求
 *   - 把 sidecar 返回的 markdown 包装为 ParseResult（与 TS parser 一致）
 *   - 抽象 endpoint 来源 —— 支持静态 URL 或懒获取函数（供 supervisor 动态端口）
 *
 * 设计原则：
 *   - 只依赖 Web fetch（Node 18+ 内置）+ AbortSignal.timeout
 *   - 不直接依赖 supervisor —— 保持 core 包纯净、可单元测试
 *   - 失败时抛 DoclingClientError，上游 router.ts 负责降级决策
 */

import type { ParseResult, ParserInput } from "./types.js";

// ─── 类型 ────────────────────────────────────────────────────

/**
 * Docling 客户端抽象接口。
 *
 * router.ts 依赖此接口而非具体实现，便于在测试时注入 mock。
 * 生产环境由 kb-parser-supervisor.ts 提供实现。
 */
export interface DoclingClient {
  /**
   * 调用 sidecar 解析文件，返回与 TS parser 一致的 ParseResult。
   *
   * 失败时抛 DoclingClientError（见下），上游按语义判断是否降级。
   */
  parse(input: ParserInput): Promise<ParseResult>;

  /**
   * 客户端是否可用（不强制实现；用于上游提前短路避免无谓开销）。
   *
   * 实现建议：若 supervisor 明确处于不可用状态（超过最大重启次数），返回 false。
   * 其他情况返回 true，实际可用性由 parse() 真实调用决定。
   */
  isAvailable?(): boolean | Promise<boolean>;
}

/**
 * Docling 客户端构造参数。
 *
 * endpoint 支持两种形态：
 *   1. 静态 string —— 测试或独立部署场景（如 http://127.0.0.1:9288）
 *   2. getter 函数 —— 动态端口场景（supervisor 首次 ensureStarted 后才知道端口）
 */
export interface DoclingClientOptions {
  /** sidecar base URL（不含结尾斜杠），或返回 URL 的 getter */
  endpoint: string | (() => Promise<string>);
  /** POST /parse 的整体超时（默认 300s —— Docling OCR 可能较慢） */
  timeoutMs?: number;
  /** /healthz 探测超时（默认 10s，对齐 Spec §T7） */
  healthTimeoutMs?: number;
  /** 可选：手动禁用（用于 E2E 测试中模拟"sidecar 挂掉"场景） */
  disabled?: () => boolean;
}

/** Docling 客户端专用错误，便于 router 精确捕获降级 */
export class DoclingClientError extends Error {
  readonly code:
    | "DOCLING_ENDPOINT_UNAVAILABLE"
    | "DOCLING_HTTP_ERROR"
    | "DOCLING_PARSE_ERROR"
    | "DOCLING_DISABLED";

  readonly httpStatus?: number;

  constructor(
    code: DoclingClientError["code"],
    message: string,
    opts?: { httpStatus?: number; cause?: unknown },
  ) {
    super(message);
    this.name = "DoclingClientError";
    this.code = code;
    if (opts?.httpStatus !== undefined) this.httpStatus = opts.httpStatus;
    if (opts?.cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = opts.cause;
    }
  }
}

// ─── 工厂 ────────────────────────────────────────────────────

/**
 * 创建 Docling HTTP 客户端。
 *
 * 不立即探测 sidecar 是否启动 —— 首次 parse() 调用时才真正请求，
 * 支持懒启动模式（supervisor 在第一次调用时才 spawn Python 子进程）。
 */
export function createDoclingClient(opts: DoclingClientOptions): DoclingClient {
  const {
    endpoint,
    timeoutMs = 300_000,
    healthTimeoutMs = 10_000,
    disabled,
  } = opts;

  const resolveEndpoint = async (): Promise<string> => {
    const url = typeof endpoint === "function" ? await endpoint() : endpoint;
    if (!url) {
      throw new DoclingClientError(
        "DOCLING_ENDPOINT_UNAVAILABLE",
        "Docling sidecar endpoint 未就绪（supervisor 可能未启动或已崩溃）",
      );
    }
    return url.replace(/\/+$/, "");
  };

  const client: DoclingClient = {
    async parse(input: ParserInput): Promise<ParseResult> {
      // ── 0. 手动禁用闸门 ──
      if (disabled?.()) {
        throw new DoclingClientError(
          "DOCLING_DISABLED",
          "Docling 客户端被显式禁用",
        );
      }

      // ── 1. 解析端点 ──
      let base: string;
      try {
        base = await resolveEndpoint();
      } catch (err) {
        if (err instanceof DoclingClientError) throw err;
        throw new DoclingClientError(
          "DOCLING_ENDPOINT_UNAVAILABLE",
          `获取 Docling endpoint 失败: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // ── 2. 健康检查（快速失败：若 sidecar 未起，避免 300s 超时） ──
      try {
        const healthResp = await fetch(`${base}/healthz`, {
          method: "GET",
          signal: AbortSignal.timeout(healthTimeoutMs),
        });
        if (!healthResp.ok) {
          throw new DoclingClientError(
            "DOCLING_ENDPOINT_UNAVAILABLE",
            `Docling healthz 返回 ${healthResp.status}`,
            { httpStatus: healthResp.status },
          );
        }
      } catch (err) {
        if (err instanceof DoclingClientError) throw err;
        throw new DoclingClientError(
          "DOCLING_ENDPOINT_UNAVAILABLE",
          `Docling sidecar 不可达: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      // ── 3. POST /parse ──
      const body = JSON.stringify({
        data: input.buffer.toString("base64"),
        filename: input.filename ?? "untitled",
        mime: input.mime ?? null,
      });

      let resp: Response;
      try {
        resp = await fetch(`${base}/parse`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        throw new DoclingClientError(
          "DOCLING_HTTP_ERROR",
          `调用 /parse 失败: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      if (!resp.ok) {
        const detail = await resp.text().catch(() => "");
        throw new DoclingClientError(
          "DOCLING_HTTP_ERROR",
          `Docling /parse HTTP ${resp.status}: ${detail.slice(0, 500)}`,
          { httpStatus: resp.status },
        );
      }

      // ── 4. 解析响应 ──
      let payload: {
        text?: string;
        page_count?: number | null;
        metadata?: Record<string, unknown>;
        elapsed_ms?: number;
      };
      try {
        payload = (await resp.json()) as typeof payload;
      } catch (err) {
        throw new DoclingClientError(
          "DOCLING_PARSE_ERROR",
          `Docling 响应解析失败: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const text = (payload.text ?? "").replace(/\r\n?/g, "\n");
      if (text.trim().length === 0) {
        // Docling 也没抽出文本 —— 视为解析结果为空，上游会走 PARSE_EMPTY 语义
        throw new DoclingClientError(
          "DOCLING_PARSE_ERROR",
          "Docling 返回空文本（文件可能完全无可识别内容）",
        );
      }

      return {
        text,
        metadata: {
          ...(payload.metadata ?? {}),
          parser: "docling",
          pageCount: payload.page_count ?? undefined,
          elapsedMs: payload.elapsed_ms,
        },
      };
    },
  };

  return client;
}
