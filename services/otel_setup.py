"""
v3 Task 7 — Python 服务统一 OpenTelemetry 初始化。

共享模块，由 im-gateway / kb-parser / video-forge 在 lifespan 启动时调用。

用法：
    import sys, os
    sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
    from otel_setup import init_otel

    # 在 FastAPI lifespan 中调用
    init_otel(service_name="im-gateway")

环境变量（与 TS 侧保持一致）：
    OTEL_ENABLED=true               — 总开关（默认 false）
    OTEL_EXPORTER_OTLP_ENDPOINT     — OTLP HTTP 端点（默认 http://localhost:4318）
    OTEL_SAMPLE_RATE                — 采样率 0.0~1.0（默认 0.1）
    OTEL_SERVICE_NAME               — 若未通过参数指定则从此环境变量读取
"""

from __future__ import annotations

import os
import logging
from typing import Optional

logger = logging.getLogger("otel_setup")

# 全局 TracerProvider 引用（用于 shutdown）
_tracer_provider: Optional[object] = None


def init_otel(service_name: Optional[str] = None) -> bool:
    """
    初始化 OpenTelemetry TracerProvider + OTLP HTTP Exporter。

    返回 True 表示初始化成功，False 表示跳过或失败（优雅降级）。
    """
    global _tracer_provider

    enabled = os.environ.get("OTEL_ENABLED", "false").lower() == "true"
    if not enabled:
        logger.info("[OTel] Telemetry disabled (OTEL_ENABLED != true)")
        return False

    try:
        from opentelemetry import trace
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
        from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
        from opentelemetry.sdk.resources import Resource, SERVICE_NAME
        from opentelemetry.sdk.trace.sampling import (
            ParentBasedTraceIdRatio,
        )
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor  # noqa: F401
    except ImportError as e:
        logger.warning(
            "[OTel] 依赖未安装，跳过初始化: %s\n"
            "  安装命令: pip install opentelemetry-sdk opentelemetry-exporter-otlp-proto-http "
            "opentelemetry-instrumentation-fastapi opentelemetry-instrumentation-httpx",
            e,
        )
        return False

    try:
        svc_name = service_name or os.environ.get("OTEL_SERVICE_NAME", "super-agent-python")
        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "http://localhost:4318")
        sample_rate = float(os.environ.get("OTEL_SAMPLE_RATE", "0.1"))

        resource = Resource.create({SERVICE_NAME: svc_name})
        sampler = ParentBasedTraceIdRatio(sample_rate)

        provider = TracerProvider(resource=resource, sampler=sampler)
        exporter = OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)

        _tracer_provider = provider

        logger.info(
            "[OTel] Python telemetry started: service=%s endpoint=%s sampleRate=%.2f",
            svc_name, endpoint, sample_rate,
        )
        return True
    except Exception as e:
        logger.warning("[OTel] 初始化失败（优雅降级）: %s", e)
        return False


def instrument_fastapi(app: object) -> None:
    """为 FastAPI app 注入 OTel HTTP tracing（自动为每个请求创建 span）。"""
    if _tracer_provider is None:
        return
    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        FastAPIInstrumentor.instrument_app(app)  # type: ignore[arg-type]
        logger.info("[OTel] FastAPI auto-instrumentation enabled")
    except Exception as e:
        logger.warning("[OTel] FastAPI instrumentation failed: %s", e)


def shutdown_otel() -> None:
    """优雅关闭 — 确保所有 span 被 flush 到后端。"""
    global _tracer_provider
    if _tracer_provider is not None:
        try:
            _tracer_provider.shutdown()  # type: ignore[attr-defined]
            logger.info("[OTel] Telemetry shutdown complete")
        except Exception:
            pass
        _tracer_provider = None
