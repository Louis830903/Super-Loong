/**
 * v3 Task 3：API 全局响应壳 onSend hook 兜底包装
 *
 * 设计原则（与 V3 计划 §三 Task 3 对齐）：
 *   - 路由优先：99% 路由通过 sendSuccess/sendError 显式走标准壳
 *   - hook 兜底：少量未走 helper 的 JSON 响应、原生 reply.send(data) 在此兜底包装
 *   - 不破坏既有：FEATURE_FLAG_RESP_ENVELOPE=false 时 hook 完全跳过
 *   - 显式分支：二进制 / SSE / WebSocket / Webhook / A2A / 静态资源全部豁免
 *
 * 注册顺序：在 errorHandler、所有路由注册之后注册（onSend 反向触发，但路由级 config 必须先解析到）。
 *
 * @why 仅 sendSuccess/sendError 不够：errorHandler 之外的零散 reply.send + 第三方插件
 *      返回的 JSON 仍可能漏壳；此 hook 提供最终一致性兜底。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

/**
 * 读取 FEATURE_FLAG_RESP_ENVELOPE 的布尔值（运行时读 env）。
 *
 * @why 不从 @super-agent/core 跨包导入 FeatureFlags，避免要求 core 包必须重新构建 dist；
 *      与 core 的 feature-flags.ts 逻辑保持等价（true/1/yes/on 为 true）。
 */
function isEnvelopeEnabled(): boolean {
  const v = process.env.FEATURE_FLAG_RESP_ENVELOPE;
  if (v === undefined || v === null || v === "") return false;
  const lower = v.toLowerCase().trim();
  return lower === "true" || lower === "1" || lower === "yes" || lower === "on";
}

/** 路由级豁免：在 routes 上挂 `{ config: { skipEnvelope: true } }` 即跳过包装 */
export interface RouteEnvelopeConfig {
  skipEnvelope?: boolean;
}

/** URL 起始即视为豁免（SSE / WebSocket / Webhook / A2A / 静态文件） */
const EXEMPT_URL_PREFIXES = [
  "/webhook/",
  "/sse/",
  "/ws", // /ws + /ws/...
  "/a2a", // A2A JSON-RPC 协议
  "/.well-known", // agent-card
];

/** SSE 路由识别：URL 含 stream / live 关键字 */
const SSE_URL_HINTS = ["/stream", "/live"];

/** 是否为豁免路径 */
function isExemptUrl(url: string): boolean {
  // 仅包装 /api/* 路由；其余全部豁免（静态文件、SPA 兜底等）
  if (!url.startsWith("/api/")) return true;
  if (EXEMPT_URL_PREFIXES.some((p) => url.startsWith(p))) return true;
  if (SSE_URL_HINTS.some((h) => url.includes(h))) return true;
  return false;
}

/** 是否为已包装好的标准壳（success / jsonrpc） */
function isAlreadyEnveloped(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== "object") return false;
  const obj = parsed as Record<string, unknown>;
  // 已经走 sendSuccess / sendError
  if ("success" in obj && (obj.success === true || obj.success === false)) return true;
  // A2A JSON-RPC 响应固定格式
  if ("jsonrpc" in obj) return true;
  return false;
}

/** 从 reply 提取 traceId（与 response-helper 保持一致） */
function extractTraceId(request: FastifyRequest): string | undefined {
  const rid = (request as any).requestId ?? request.headers["x-request-id"];
  return typeof rid === "string" && rid.length > 0 ? rid : undefined;
}

/**
 * 注册响应壳兼底 hook
 *
 * @why 路由可能忘调 sendSuccess/sendError、业务代码可能直接 reply.send(rawObj)；
 *       本 hook 在 onSend 阶段接管未被包装的 payload、统一输出 { success, data,
 *       traceId } 壳。路径可同时走 "路由显式 + hook 兼底" 两层保护。
 */
export async function registerResponseEnvelope(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    // 1. Feature flag 总闸门
    if (!isEnvelopeEnabled()) return payload;

    // 2. 路径豁免
    if (isExemptUrl(request.url)) return payload;

    // 3. 路由级 skipEnvelope config
    // @why Fastify v4 推荐 request.routeOptions.config；同时兼容老路径 reply.context.config
    const routeConfig =
      ((request as any).routeOptions?.config ??
        (reply as any).context?.config) as RouteEnvelopeConfig | undefined;
    if (routeConfig?.skipEnvelope === true) return payload;

    // 4. SSE / 流式：reply.raw.headersSent 表示已经直接写过 raw socket
    if (reply.raw.headersSent) return payload;

    // 5. 二进制 / 流：Buffer / 含 .pipe 的 stream / null / undefined
    if (payload === null || payload === undefined) return payload;
    if (Buffer.isBuffer(payload)) return payload;
    if (typeof payload === "object" && typeof (payload as any).pipe === "function") return payload;

    // 6. 仅处理 JSON 响应：检查 Content-Type
    const contentType = String(reply.getHeader("content-type") ?? "");
    if (contentType && !contentType.includes("application/json")) return payload;

    // 7. payload 必定是 string（Fastify 已经 JSON.stringify 过对象响应）
    if (typeof payload !== "string") return payload;

    // 空 body 不包装
    if (payload.length === 0) return payload;

    // 解析 JSON
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // 非 JSON 字符串 → 不包装
      return payload;
    }

    // 8. 已包装则透传
    if (isAlreadyEnveloped(parsed)) return payload;

    // 9. 兜底包装
    const traceId = extractTraceId(request);
    const status = reply.statusCode;
    const wrapped =
      status >= 400
        ? {
            success: false as const,
            error: {
              // 缺失明确 code 时用 HTTP 状态码兜底（4xx → CLIENT_ERROR_xxx, 5xx → SERVER_ERROR_xxx）
              code: status >= 500 ? `SERVER_ERROR_${status}` : `CLIENT_ERROR_${status}`,
              message:
                (parsed && typeof parsed === "object" && "message" in (parsed as any))
                  ? String((parsed as any).message)
                  : (typeof parsed === "string" ? parsed : "Request failed"),
              details: parsed,
            },
            ...(traceId ? { traceId } : {}),
          }
        : {
            success: true as const,
            data: parsed,
            ...(traceId ? { traceId } : {}),
          };

    return JSON.stringify(wrapped);
  });

  app.log.info(
    { enabled: isEnvelopeEnabled() },
    "[v3 Task 3] Response envelope hook registered (FEATURE_FLAG_RESP_ENVELOPE)",
  );
}
