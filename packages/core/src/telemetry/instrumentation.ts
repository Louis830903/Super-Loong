/**
 * v3 Task 7 — OpenTelemetry Instrumentation 入口
 *
 * @why 全链路可观测性是生产级平台的基本要求。此模块在应用启动最前面加载，
 *      通过 --require / --import 注入，确保所有 HTTP/DB/LLM 调用被自动追踪。
 *
 * 使用方式：
 *   node --import ./src/telemetry/instrumentation.js  (从 packages/core 目录)
 *   或在 ecosystem.config.cjs 的 node_args 中指定 --import 路径
 *
 * 配置（环境变量）：
 *   OTEL_ENABLED=true             — 总开关（默认 false，需显式开启）
 *   OTEL_SERVICE_NAME=super-agent — 服务名
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 — OTLP HTTP 端点
 *   OTEL_SAMPLE_RATE=0.1          — 采样率（0.0~1.0，默认 0.1 即 10%）
 *   OTEL_ERROR_ALWAYS_SAMPLE=true — 错误链路强制 100% 采样
 *
 * @issue V3-007
 */

import { FeatureFlags } from "../config/feature-flags.js";

// ─── 类型声明（延迟 import，避免未安装时崩溃）─────────────────

type OTelSDK = {
  start: () => void;
  shutdown: () => Promise<void>;
};

let sdk: OTelSDK | null = null;

/**
 * 初始化 OpenTelemetry SDK。
 * 仅在 OTEL_ENABLED=true 且 feature flag OTEL_TRACE 启用时生效。
 */
export async function initTelemetry(): Promise<void> {
  const enabled = process.env.OTEL_ENABLED === "true" && FeatureFlags.otelTracing;
  if (!enabled) {
    console.log("[OTel] Telemetry disabled (OTEL_ENABLED !== true or OTEL_TRACE flag off)");
    return;
  }

  try {
    // 动态 import — 允许 OTel 依赖为可选（未安装时优雅降级）
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
    const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");
    const { Resource } = await import("@opentelemetry/resources");
    const { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } = await import("@opentelemetry/semantic-conventions");
    const { ParentBasedSampler, TraceIdRatioBasedSampler, AlwaysOnSampler } = await import("@opentelemetry/sdk-trace-base");

    const serviceName = process.env.OTEL_SERVICE_NAME || "super-agent";
    const sampleRate = parseFloat(process.env.OTEL_SAMPLE_RATE || "0.1");
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318";

    // 采样策略：ParentBased + 比例采样（错误链路在 SpanProcessor 中强制保留）
    const sampler = new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(sampleRate),
    });

    const resource = new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: process.env.npm_package_version || "0.0.0",
      "deployment.environment": process.env.NODE_ENV || "development",
    });

    const traceExporter = new OTLPTraceExporter({ url: `${endpoint}/v1/traces` });

    sdk = new NodeSDK({
      resource,
      sampler,
      traceExporter,
      instrumentations: [
        getNodeAutoInstrumentations({
          // HTTP 自动 instrument — 为 API 层添加 trace
          "@opentelemetry/instrumentation-http": { enabled: true },
          // Fastify 框架 — 路由级 span
          "@opentelemetry/instrumentation-fastify": { enabled: true },
          // better-sqlite3 — DB 查询追踪
          "@opentelemetry/instrumentation-generic-pool": { enabled: false },
          // 关闭不必要的 instrumentation
          "@opentelemetry/instrumentation-fs": { enabled: false },
          "@opentelemetry/instrumentation-dns": { enabled: false },
        }),
      ],
    }) as unknown as OTelSDK;

    sdk.start();
    console.log(`[OTel] Telemetry started: service=${serviceName} endpoint=${endpoint} sampleRate=${sampleRate}`);

    // 优雅关闭
    const shutdown = async () => {
      if (sdk) {
        await sdk.shutdown();
        console.log("[OTel] Telemetry shutdown complete");
      }
    };
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  } catch (err: unknown) {
    // OTel 依赖未安装 → 优雅降级，不影响主业务
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[OTel] Failed to initialize (missing deps?): ${msg}`);
    console.warn("[OTel] Install with: pnpm add @opentelemetry/sdk-node @opentelemetry/auto-instrumentations-node @opentelemetry/exporter-trace-otlp-http @opentelemetry/resources @opentelemetry/semantic-conventions");
  }
}

/**
 * @why 跨服务调用需要传播 trace context，返回 W3C traceparent 格式。
 */
export function getTraceParent(): string | null {
  try {
    // 同步函数无法 await import()，require() 是唯一选项；Node ESM 模式下通过 CJS 互操作解析
    const { trace, context } = require("@opentelemetry/api");
    const span = trace.getSpan(context.active());
    if (!span) return null;
    const ctx = span.spanContext();
    const flags = ctx.traceFlags.toString(16).padStart(2, "0");
    return `00-${ctx.traceId}-${ctx.spanId}-${flags}`;
  } catch {
    return null;
  }
}

/**
 * @why LLM 调用是核心关键路径，需独立 span 追踪耗时与 token 用量。
 */
export async function traceLLMCall<T>(
  provider: string,
  model: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const { trace, SpanKind, SpanStatusCode } = await import("@opentelemetry/api");
    const tracer = trace.getTracer("super-agent.llm");
    return await tracer.startActiveSpan(
      `llm.${provider}.${model}`,
      { kind: SpanKind.CLIENT, attributes: { "llm.provider": provider, "llm.model": model } },
      async (span) => {
        try {
          const result = await fn();
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          span.setStatus({ code: SpanStatusCode.ERROR, message: errMsg });
          span.recordException(err);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  } catch {
    // OTel 不可用 → 直接执行
    return fn();
  }
}
