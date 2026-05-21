/**
 * OTel 可选依赖类型存根
 *
 * @why @opentelemetry/* 包置于 optionalDependencies，运行时通过 dynamic import
 *      + try/catch 优雅降级。此文件仅为 TypeScript 编译提供最小类型声明，
 *      无需实际安装 OTel 包即可通过 tsc --noEmit。
 *
 * @issue V3-07
 */

// ─── @opentelemetry/sdk-node ────────────────────────────────
declare module "@opentelemetry/sdk-node" {
  export class NodeSDK {
    constructor(config?: Record<string, unknown>);
    start(): void;
    shutdown(): Promise<void>;
  }
}

// ─── @opentelemetry/auto-instrumentations-node ──────────────
declare module "@opentelemetry/auto-instrumentations-node" {
  export function getNodeAutoInstrumentations(
    config?: Record<string, unknown>,
  ): unknown[];
}

// ─── @opentelemetry/exporter-trace-otlp-http ────────────────
declare module "@opentelemetry/exporter-trace-otlp-http" {
  export class OTLPTraceExporter {
    constructor(config?: { url?: string });
  }
}

// ─── @opentelemetry/resources ───────────────────────────────
declare module "@opentelemetry/resources" {
  export class Resource {
    constructor(attributes?: Record<string, unknown>);
  }
}

// ─── @opentelemetry/semantic-conventions ─────────────────────
declare module "@opentelemetry/semantic-conventions" {
  export const ATTR_SERVICE_NAME: string;
  export const ATTR_SERVICE_VERSION: string;
}

// ─── @opentelemetry/sdk-trace-base ──────────────────────────
declare module "@opentelemetry/sdk-trace-base" {
  export class ParentBasedSampler {
    constructor(config: { root: unknown });
  }
  export class TraceIdRatioBasedSampler {
    constructor(ratio: number);
  }
  export class AlwaysOnSampler {}
}

// ─── @opentelemetry/api ─────────────────────────────────────
declare module "@opentelemetry/api" {
  export interface SpanContext {
    traceId: string;
    spanId: string;
    traceFlags: number;
  }

  export interface Span {
    spanContext(): SpanContext;
    setStatus(status: { code: number; message?: string }): void;
    recordException(err: unknown): void;
    end(): void;
  }

  export interface Tracer {
    startActiveSpan<T>(
      name: string,
      options: Record<string, unknown>,
      fn: (span: Span) => T,
    ): T;
  }

  export const trace: {
    getTracer(name: string): Tracer;
    getSpan(ctx: unknown): Span | undefined;
  };

  export const context: {
    active(): unknown;
  };

  export const SpanKind: { CLIENT: number; SERVER: number };
  export const SpanStatusCode: { OK: number; ERROR: number };
}
