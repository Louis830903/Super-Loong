"""
KB-Parser — Docling 驱动的知识库进阶解析 sidecar。

由 super-agent 的 kb-parser-supervisor.ts 以子进程方式启动：

    python -m uvicorn main:app --host 127.0.0.1 --port <动态端口>

职责（知识库 Spec §T7）：
  - 扫描件 PDF / 图片 OCR（Docling 内置 EasyOCR / Tesseract）
  - 复杂版式 PDF 的精度解析兜底（TS 侧 pdf-parse 抽不出文本时兜底）
  - 统一输出 markdown 文本 + 页数元信息

关键约束：
  - 不含任何 LLM 调用（LLM 由 super-agent 侧 Agent 负责）
  - 不持久化任何结果（无状态：入参 bytes → 出参 markdown）
  - 懒加载 DocumentConverter（首次 /parse 才初始化，避免健康检查无意义阻塞）
"""

from __future__ import annotations

import base64
import io
import time
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from loguru import logger
from pydantic import BaseModel, Field


# ── 懒加载容器 ─────────────────────────────────────────────────

_converter: Any = None  # Docling DocumentConverter，首次 /parse 才初始化


def _get_converter() -> Any:
    """懒加载 DocumentConverter —— 避免 uvicorn 启动即加载模型导致健康检查超时。"""
    global _converter
    if _converter is not None:
        return _converter

    try:
        # Docling 2.x 的稳定入口
        from docling.document_converter import DocumentConverter  # type: ignore
    except ImportError as exc:
        raise HTTPException(
            status_code=503,
            detail=(
                "docling 未安装或导入失败。请在 services/kb-parser/ 下执行："
                "`uv pip install -r requirements.lock`。原始错误：" + str(exc)
            ),
        )

    logger.info("[kb-parser] 正在初始化 Docling DocumentConverter（首次调用会较慢）...")
    _converter = DocumentConverter()
    logger.info("[kb-parser] DocumentConverter 就绪")
    return _converter


# ── FastAPI 应用 ─────────────────────────────────────────────────


@asynccontextmanager
async def lifespan(application: FastAPI):
    """应用生命周期：启动时仅记录日志，关闭时清理。"""
    # v3 T7: OTel 可观测性
    import sys as _s, os as _o
    _s.path.insert(0, _o.path.join(_o.path.dirname(__file__), ".."))
    from otel_setup import init_otel, instrument_fastapi, shutdown_otel
    init_otel(service_name="kb-parser")
    instrument_fastapi(application)

    logger.info("kb-parser sidecar 已启动，等待首次 /parse 请求以初始化 Docling")
    yield
    shutdown_otel()
    logger.info("kb-parser sidecar 正在关闭")


app = FastAPI(
    title="KB-Parser",
    description="Docling 驱动的知识库进阶解析微服务 — super-agent 子进程",
    version="0.1.0",
    lifespan=lifespan,
)

# ── v3 Task 11：统一错误码异常处理器 ──────────────────────
import sys as _sys
_sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent.parent))
from error_codes import error_response

_HTTP_STATUS_TO_CODE: dict[int, str] = {
    400: "BAD_REQUEST",
    404: "NOT_FOUND",
    500: "INTERNAL_ERROR",
    503: "SERVICE_UNAVAILABLE",
}

@app.exception_handler(HTTPException)
async def _http_exc_handler(request: Request, exc: HTTPException):
    code = _HTTP_STATUS_TO_CODE.get(exc.status_code, "INTERNAL_ERROR")
    return error_response(exc.status_code, code, str(exc.detail))

@app.exception_handler(Exception)
async def _global_exc_handler(request: Request, exc: Exception):
    logger.error(f"全局异常: {request.url.path} -> {type(exc).__name__}: {exc}")
    return error_response(500, "INTERNAL_ERROR", f"{type(exc).__name__}: {exc}")


# ── 数据模型 ──────────────────────────────────────────────────


class ParseRequest(BaseModel):
    """解析请求体。"""

    # base64 编码的原始二进制（与 TS 侧 parser-docling.ts 对齐）
    data: str = Field(..., description="base64 编码的文件二进制")
    filename: str = Field(..., description="原始文件名（用于格式识别 + 日志定位）")
    mime: str | None = Field(None, description="MIME 类型（可选，优先于 filename 扩展名）")


class ParseResponse(BaseModel):
    """解析响应体 —— 与 TS 侧 ParseResult 对齐。"""

    text: str = Field(..., description="提取出的 markdown 文本")
    page_count: int | None = Field(None, description="总页数/sheet 数/slide 数（若适用）")
    metadata: dict[str, Any] = Field(default_factory=dict, description="其他元数据")
    elapsed_ms: int = Field(..., description="本次解析耗时（毫秒）")


# ── 路由 ──────────────────────────────────────────────────────


@app.get("/healthz")
async def healthz() -> dict[str, Any]:
    """
    健康检查端点（对齐 Spec §T7）。

    只做存活探针 —— 不触发 Docling 初始化，避免 supervisor 的 10s 超时
    把首次模型加载也算作失败。
    """
    return {
        "ok": True,
        "service": "kb-parser",
        "converter_loaded": _converter is not None,
    }


@app.post("/parse", response_model=ParseResponse)
async def parse(req: ParseRequest) -> ParseResponse:
    """
    用 Docling 解析文件，返回 markdown 文本。

    错误处理：
      - base64 解码失败 → 400
      - 文件为空 → 400
      - Docling 未安装 → 503（上游会转为 TS 降级）
      - Docling 解析异常 → 500（上游会转为 TS 降级）
    """
    start_ns = time.perf_counter_ns()

    # ── 1. 解码 base64 ──
    try:
        buffer = base64.b64decode(req.data, validate=True)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"base64 解码失败: {exc}")

    if len(buffer) == 0:
        raise HTTPException(status_code=400, detail="文件 buffer 为空")

    # ── 2. 懒加载 Docling ──
    converter = _get_converter()

    # ── 3. Docling 解析 ──
    #   Docling 的 DocumentConverter.convert() 接受 source 参数，
    #   可以是路径或 DocumentStream（bytes 流 + 文件名）。
    try:
        from docling.datamodel.base_models import DocumentStream  # type: ignore

        stream = DocumentStream(name=req.filename, stream=io.BytesIO(buffer))
        result = converter.convert(stream)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("[kb-parser] Docling 解析失败")
        raise HTTPException(
            status_code=500,
            detail=f"Docling 解析失败: {type(exc).__name__}: {exc}",
        )

    # ── 4. 导出 markdown + 收集元数据 ──
    try:
        doc = result.document
        markdown = doc.export_to_markdown()
    except Exception as exc:
        logger.exception("[kb-parser] 导出 markdown 失败")
        raise HTTPException(
            status_code=500,
            detail=f"Docling 导出 markdown 失败: {type(exc).__name__}: {exc}",
        )

    # 页数：Docling 的 document.pages 是列表；不存在时兜底 None
    page_count: int | None = None
    try:
        pages = getattr(doc, "pages", None)
        if pages is not None:
            # pages 有时是 dict{page_no: Page}, 有时是 list
            if hasattr(pages, "__len__"):
                page_count = len(pages)  # type: ignore[arg-type]
    except Exception:
        page_count = None

    elapsed_ms = max(1, (time.perf_counter_ns() - start_ns) // 1_000_000)
    logger.info(
        "[kb-parser] 解析完成 filename={} bytes={} chars={} elapsed_ms={}".format(
            req.filename, len(buffer), len(markdown), elapsed_ms
        )
    )

    return ParseResponse(
        text=markdown,
        page_count=page_count,
        metadata={
            "parser": "docling",
            "filename": req.filename,
            "mime": req.mime,
        },
        elapsed_ms=elapsed_ms,
    )


# ── 本地开发入口 ──────────────────────────────────────────────

if __name__ == "__main__":
    import os
    import uvicorn

    # 本地开发：固定 9288 端口；生产由 supervisor 通过动态端口启动
    # 生产环境不启用 reload，避免 watchdog 占用额外文件句柄
    reload = os.environ.get("KB_PARSER_RELOAD", "") == "1"
    uvicorn.run("main:app", host="127.0.0.1", port=9288, reload=reload)
