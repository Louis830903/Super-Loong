"""
企微分块媒体上传 — 大文件切割逐块上传

参考 Hermes wecom.py upload_media_chunked() 实现：
- 512KB/块，最多 100 块
- 先 POST /cgi-bin/media/upload_by_chunk/init 获取 upload_id
- 逐块 POST /cgi-bin/media/upload_by_chunk/upload
- 最后 POST /cgi-bin/media/upload_by_chunk/finish 完成上传
"""

import asyncio
import logging
import math
from typing import Any, BinaryIO, Dict, Optional

logger = logging.getLogger("wecom.media")

# 上传参数
CHUNK_SIZE = 512 * 1024  # 512KB
MAX_CHUNKS = 100
MAX_FILE_SIZE = CHUNK_SIZE * MAX_CHUNKS  # 约 50MB


class WeComMediaUploader:
    """
    企微分块媒体上传器。

    将大文件切割为固定大小的块，逐块上传到企微服务器。
    """

    def __init__(
        self,
        corp_id: str,
        agent_id: str,
        access_token_fn,
        *,
        base_url: str = "https://qyapi.weixin.qq.com",
        chunk_size: int = CHUNK_SIZE,
    ):
        self._corp_id = corp_id
        self._agent_id = agent_id
        self._access_token_fn = access_token_fn
        self._base_url = base_url
        self._chunk_size = chunk_size

    async def upload_file(
        self,
        file_data: bytes,
        filename: str,
        media_type: str = "file",
    ) -> Optional[str]:
        """
        分块上传文件。

        Args:
            file_data: 文件内容字节
            filename: 文件名
            media_type: 媒体类型（image/voice/video/file）

        Returns:
            media_id（成功）或 None（失败）
        """
        file_size = len(file_data)

        if file_size > MAX_FILE_SIZE:
            logger.error(f"文件过大: {file_size} bytes > {MAX_FILE_SIZE} bytes")
            return None

        total_chunks = math.ceil(file_size / self._chunk_size)

        if total_chunks <= 1:
            # 小文件直接上传
            return await self._upload_single(file_data, filename, media_type)

        # 分块上传
        return await self._upload_chunked(file_data, filename, media_type, total_chunks)

    async def _upload_single(
        self,
        file_data: bytes,
        filename: str,
        media_type: str,
    ) -> Optional[str]:
        """小文件单次上传"""
        try:
            access_token = await self._access_token_fn()
            url = f"{self._base_url}/cgi-bin/media/upload?access_token={access_token}&type={media_type}"

            # 使用 aiohttp 上传
            import aiohttp
            async with aiohttp.ClientSession() as session:
                data = aiohttp.FormData()
                data.add_field("media", file_data, filename=filename)
                async with session.post(url, data=data) as resp:
                    result = await resp.json()

            if result.get("errcode", 0) != 0:
                logger.error(f"上传失败: {result}")
                return None

            media_id = result.get("media_id", "")
            logger.info(f"文件上传成功: {filename} → {media_id}")
            return media_id

        except Exception as e:
            logger.error(f"文件上传异常: {e}")
            return None

    async def _upload_chunked(
        self,
        file_data: bytes,
        filename: str,
        media_type: str,
        total_chunks: int,
    ) -> Optional[str]:
        """分块上传大文件"""
        try:
            access_token = await self._access_token_fn()

            # Step 1: 初始化分块上传
            init_url = (
                f"{self._base_url}/cgi-bin/media/upload_by_chunk/init"
                f"?access_token={access_token}"
            )
            import aiohttp
            async with aiohttp.ClientSession() as session:
                init_payload = {
                    "filename": filename,
                    "filesize": len(file_data),
                    "filetype": media_type,
                    "chunks": total_chunks,
                }
                async with session.post(init_url, json=init_payload) as resp:
                    init_result = await resp.json()

                if init_result.get("errcode", 0) != 0:
                    logger.error(f"分块上传初始化失败: {init_result}")
                    return None

                upload_id = init_result.get("uploadid", "")

                # Step 2: 逐块上传
                for i in range(total_chunks):
                    start = i * self._chunk_size
                    end = min(start + self._chunk_size, len(file_data))
                    chunk = file_data[start:end]

                    upload_url = (
                        f"{self._base_url}/cgi-bin/media/upload_by_chunk/upload"
                        f"?access_token={access_token}"
                    )
                    data = aiohttp.FormData()
                    data.add_field("file", chunk, filename=f"{filename}.part{i}")
                    data.add_field("uploadid", upload_id)
                    data.add_field("partindex", str(i))

                    async with session.post(upload_url, data=data) as resp:
                        chunk_result = await resp.json()

                    if chunk_result.get("errcode", 0) != 0:
                        logger.error(f"分块 {i}/{total_chunks} 上传失败: {chunk_result}")
                        return None

                    logger.debug(f"分块 {i + 1}/{total_chunks} 上传成功")

                # Step 3: 完成上传
                finish_url = (
                    f"{self._base_url}/cgi-bin/media/upload_by_chunk/finish"
                    f"?access_token={access_token}"
                )
                finish_payload = {
                    "uploadid": upload_id,
                    "filetype": media_type,
                }
                async with session.post(finish_url, json=finish_payload) as resp:
                    finish_result = await resp.json()

                if finish_result.get("errcode", 0) != 0:
                    logger.error(f"分块上传完成失败: {finish_result}")
                    return None

                media_id = finish_result.get("media_id", "")
                logger.info(f"分块上传完成: {filename} ({total_chunks} 块) → {media_id}")
                return media_id

        except Exception as e:
            logger.error(f"分块上传异常: {e}")
            return None


def estimate_chunks(file_size: int, chunk_size: int = CHUNK_SIZE) -> int:
    """估算分块数量"""
    return math.ceil(file_size / chunk_size)
