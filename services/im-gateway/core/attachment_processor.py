"""
统一附件处理器 — 综合 OpenClaw extractFileBlocks + Hermes _maybe_extract_text_document

处理从 IM 平台接收的附件，将文档内容注入消息文本，将图片转为 base64 供多模态使用。
支持：文本文件直接注入、PDF/DOCX/XLSX 服务端解析、图片 base64 编码、音频跳过(已有 STT 链路)。
"""

import os
import logging
import base64
import time
from pathlib import Path
from typing import Optional

import httpx

logger = logging.getLogger("im-gateway.attachment")

# ── 常量 ──────────────────────────────────────────

# 学 Hermes: 文本文件注入的大小上限
TEXT_INJECT_MAX_BYTES = 100 * 1024  # 100KB

# 学 Hermes: 支持的文本文件扩展名（直接读取内容注入）
TEXT_EXTENSIONS = {
    ".txt", ".md", ".log", ".csv", ".json", ".xml", ".yaml", ".yml",
    ".ini", ".env", ".cfg", ".conf", ".toml",
}

# 学 Hermes: 支持的可解析二进制文档（发送到 /api/files/parse）
PARSEABLE_EXTENSIONS = {".pdf", ".docx", ".xlsx", ".xls", ".pptx"}

# 学 OpenClaw: 支持的图片扩展名
IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"}

# 学 Hermes: 支持的音频扩展名（已有 STT 链路处理）
AUDIO_EXTENSIONS = {".ogg", ".mp3", ".wav", ".m4a", ".opus", ".silk"}

# 学 OpenClaw: 注入消息的最大字符数
MAX_INJECT_CHARS = 50_000  # 与 files.ts MAX_TEXT_LENGTH 对齐

# token 预算上限 — 防止大文件注入撑爆 context window
TOKEN_BUDGET_CHARS = 30_000  # ~7500 tokens，为系统提示+历史留出空间


# ── 分类 ──────────────────────────────────────────

def classify_attachment(file_path: str, mime_type: str = "") -> str:
    """
    分类附件类型 — 返回 image/text/document/audio/unknown
    学 OpenClaw resolveAttachmentKind 的分类策略
    """
    ext = Path(file_path).suffix.lower()
    if ext in IMAGE_EXTENSIONS or mime_type.startswith("image/"):
        return "image"
    if ext in TEXT_EXTENSIONS or mime_type.startswith("text/"):
        return "text"
    if ext in PARSEABLE_EXTENSIONS:
        return "document"
    if ext in AUDIO_EXTENSIONS or mime_type.startswith("audio/"):
        return "audio"
    return "unknown"


# ── 文本文件提取 ──────────────────────────────────

def extract_text_file(file_path: str, max_bytes: int = TEXT_INJECT_MAX_BYTES) -> Optional[str]:
    """
    学 Hermes _maybe_extract_text_document:
    直接读取文本文件内容，≤100KB 全量注入，超过则截断
    """
    try:
        size = os.path.getsize(file_path)
        if size == 0:
            return None
        content = Path(file_path).read_text(encoding="utf-8")
        if len(content) > MAX_INJECT_CHARS:
            content = content[:MAX_INJECT_CHARS] + "\n...(内容过长已截断)"
        return content
    except (OSError, UnicodeDecodeError) as e:
        logger.warning("文本文件读取失败: %s — %s", file_path, e)
        return None


# ── 二进制文档解析 ──────────────────────────────────

async def parse_binary_document(
    file_path: str,
    api_base: str = "http://localhost:3001",
) -> Optional[str]:
    """
    学 OpenClaw extractFileContentFromSource 的 PDF 提取策略:
    调用已有 /api/files/parse 端点（pdf-parse / mammoth / xlsx）
    """
    try:
        with open(file_path, "rb") as f:
            raw = f.read()
        b64 = base64.b64encode(raw).decode("ascii")
        filename = os.path.basename(file_path)

        async with httpx.AsyncClient(timeout=30) as client:
            resp = await client.post(
                f"{api_base}/api/files/parse",
                json={"filename": filename, "data": b64},
            )
            if resp.status_code == 200:
                data = resp.json()
                return data.get("text", "")
            else:
                logger.warning("文档解析失败: %s — HTTP %s", filename, resp.status_code)
                return None
    except Exception as e:
        logger.error("文档解析异常: %s — %s", file_path, e)
        return None


# ── 文件内容包裹 ──────────────────────────────────

def wrap_file_content(filename: str, mime_type: str, content: str) -> str:
    """
    学 OpenClaw renderFileContextBlock:
    用 XML 标签包裹文件内容，防注入 + 结构化
    """
    safe_name = filename.replace('"', '&quot;').replace('<', '&lt;')
    safe_mime = mime_type.replace('"', '&quot;')
    safe_content = content.replace("</file>", "&lt;/file&gt;")
    return f'<file name="{safe_name}" mime="{safe_mime}">\n{safe_content}\n</file>'


# ── 统一处理入口 ──────────────────────────────────

async def process_attachments(
    media_urls: list[str],
    media_types: list[str],
    original_text: str,
    api_base: str = "http://localhost:3001",
) -> tuple[str, list[dict]]:
    """
    统一入口 — 处理所有附件，返回 (增强后的 text, images 列表)

    返回值:
        text: 注入了文档内容的增强文本
        images: base64 图片列表 [{"data": "...", "mime_type": "image/png", "filename": "..."}]
    """
    enriched_parts: list[str] = []
    images: list[dict] = []

    for i, url in enumerate(media_urls):
        mime = media_types[i] if i < len(media_types) else ""
        kind = classify_attachment(url, mime)
        filename = os.path.basename(url)

        if kind == "text":
            content = extract_text_file(url)
            if content:
                enriched_parts.append(wrap_file_content(filename, mime or "text/plain", content))
            else:
                enriched_parts.append(f"[附件: {filename} (读取失败)]")

        elif kind == "document":
            text = await parse_binary_document(url, api_base)
            if text:
                doc_mime = mime or "application/octet-stream"
                enriched_parts.append(wrap_file_content(filename, doc_mime, text))
            else:
                enriched_parts.append(f"[附件: {filename} (解析失败)]")

        elif kind == "image":
            try:
                with open(url, "rb") as f:
                    raw = f.read()
                b64 = base64.b64encode(raw).decode("ascii")
                img_mime = mime or "image/png"
                images.append({"data": b64, "mime_type": img_mime, "filename": filename})
            except Exception as e:
                logger.warning("图片读取失败: %s — %s", url, e)
                enriched_parts.append(f"[图片: {filename} (读取失败)]")

        elif kind == "audio":
            pass  # 已有 STT 转写链路，在 handler 中先处理

        else:
            enriched_parts.append(f"[附件: {filename} ({mime or '未知类型'}, 不支持)]")

    # token 预算检查 — 防止大文件注入撑爆 context window
    total_inject_chars = sum(len(p) for p in enriched_parts)
    if total_inject_chars > TOKEN_BUDGET_CHARS:
        logger.warning(
            "附件注入内容过长 (%d chars)，截断到 %d chars",
            total_inject_chars, TOKEN_BUDGET_CHARS,
        )
        # 按比例截断每个 part
        ratio = TOKEN_BUDGET_CHARS / total_inject_chars
        enriched_parts = [
            p[:int(len(p) * ratio)] + "\n...(token预算截断)" for p in enriched_parts
        ]

    # 组合最终文本
    text = original_text
    if enriched_parts:
        file_block = "\n\n".join(enriched_parts)
        text = f"{text}\n\n{file_block}" if text else file_block

    return text, images


# ── 缓存清理 ──────────────────────────────────────

def cleanup_cache(cache_dir: str = "cache/documents", max_age_hours: int = 24) -> int:
    """
    学 Hermes cleanup_document_cache:
    清理过期的缓存文件，返回删除数量
    """
    cache_path = Path(cache_dir)
    if not cache_path.exists():
        return 0
    now = time.time()
    max_age_secs = max_age_hours * 3600
    count = 0
    for f in cache_path.iterdir():
        if f.is_file() and (now - f.stat().st_mtime) > max_age_secs:
            try:
                f.unlink()
                count += 1
            except OSError:
                pass
    return count
