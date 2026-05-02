"""
TTS 工具函数 — 从 Pixelle utils/tts_util.py + tts_voices.py 迁移。

包含 edge_tts 异步调用（带指数退避重试）和 speed_to_rate 转换。
"""

import asyncio
import random
import ssl

import certifi
import edge_tts as edge_tts_sdk
from edge_tts.exceptions import NoAudioReceived
from loguru import logger
from aiohttp import WSServerHandshakeError, ClientResponseError


# 重试配置
_RETRY_COUNT = 5
_RETRY_BASE_DELAY = 1.0
_MAX_RETRY_DELAY = 10.0

# 速率限制
_REQUEST_DELAY = 0.5
_MAX_CONCURRENT_REQUESTS = 3

# 全局信号量（按事件循环创建）
_request_semaphore = None
_semaphore_loop = None


def _get_request_semaphore():
    """获取或创建当前事件循环的并发信号量。"""
    global _request_semaphore, _semaphore_loop
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.Semaphore(_MAX_CONCURRENT_REQUESTS)
    if _request_semaphore is None or _semaphore_loop != current_loop:
        _request_semaphore = asyncio.Semaphore(_MAX_CONCURRENT_REQUESTS)
        _semaphore_loop = current_loop
    return _request_semaphore


def speed_to_rate(speed: float) -> str:
    """
    将速度倍率转为 Edge TTS rate 参数。

    Examples:
        1.0 → "+0%"
        1.2 → "+20%"
        0.8 → "-20%"
    """
    percentage = int((speed - 1.0) * 100)
    if percentage >= 0:
        return f"+{percentage}%"
    return f"{percentage}%"


async def edge_tts(
    text: str,
    voice: str = "zh-CN-YunjianNeural",
    rate: str = "+0%",
    volume: str = "+0%",
    pitch: str = "+0Hz",
    output_path: str | None = None,
    retry_count: int = _RETRY_COUNT,
    retry_base_delay: float = _RETRY_BASE_DELAY,
) -> bytes:
    """
    使用 Microsoft Edge TTS 将文本转语音。

    带指数退避重试机制 + 并发限流，返回 MP3 bytes。
    """
    logger.debug(f"调用 Edge TTS: voice={voice}, rate={rate}")

    semaphore = _get_request_semaphore()
    async with semaphore:
        pre_delay = _REQUEST_DELAY + random.uniform(0, 0.3)
        await asyncio.sleep(pre_delay)

        last_error = None
        for attempt in range(retry_count + 1):
            if attempt > 0:
                exp_delay = retry_base_delay * (2 ** (attempt - 1))
                jitter = random.uniform(0, retry_base_delay)
                delay = min(exp_delay + jitter, _MAX_RETRY_DELAY)
                logger.info(f"🔄 Edge TTS 重试 ({attempt + 1}/{retry_count + 1})，等待 {delay:.2f}s")
                await asyncio.sleep(delay)

            try:
                ssl_context = ssl.create_default_context(cafile=certifi.where())
                communicate = edge_tts_sdk.Communicate(
                    text=text, voice=voice, rate=rate, volume=volume, pitch=pitch
                )

                audio_chunks: list[bytes] = []
                async for chunk in communicate.stream():
                    if chunk["type"] == "audio":
                        audio_chunks.append(chunk["data"])

                audio_data = b"".join(audio_chunks)

                if attempt > 0:
                    logger.success(f"✅ 重试成功 (第 {attempt + 1} 次)")

                logger.info(f"生成 {len(audio_data)} bytes 音频")

                if output_path:
                    import os
                    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
                    with open(output_path, "wb") as f:
                        f.write(audio_data)
                    logger.info(f"音频已保存: {output_path}")

                return audio_data

            except (WSServerHandshakeError, ClientResponseError) as e:
                last_error = e
                error_code = getattr(e, "status", "unknown")
                if attempt >= retry_count:
                    logger.error(f"❌ Edge TTS 全部 {retry_count + 1} 次失败: {error_code}")
                    raise
                logger.warning(f"⚠️ Edge TTS 错误 ({attempt + 1}/{retry_count + 1}): {error_code}")

            except NoAudioReceived:
                last_error = NoAudioReceived()
                if attempt >= retry_count:
                    logger.error(f"❌ Edge TTS NoAudioReceived，全部重试失败")
                    raise
                logger.warning(f"⚠️ NoAudioReceived ({attempt + 1}/{retry_count + 1})")
                await asyncio.sleep(2.0)

            except Exception as e:
                logger.error(f"Edge TTS 不可重试错误: {type(e).__name__} - {e}")
                raise

        if last_error:
            raise last_error
        raise RuntimeError("Edge TTS 意外失败")


def get_audio_duration(audio_path: str) -> float:
    """获取音频文件时长（秒），ffmpeg-python 探测，失败则按文件大小估算。"""
    try:
        import ffmpeg
        probe = ffmpeg.probe(audio_path)
        return float(probe["format"]["duration"])
    except Exception as e:
        logger.warning(f"获取音频时长失败: {e}，使用估算值")
        import os
        file_size = os.path.getsize(audio_path)
        return max(1.0, file_size / 2000)
