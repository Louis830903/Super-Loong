"""
共享 fixture — mock MiniCore + FastAPI AsyncClient。

所有路由测试通过 mock_core 避免真实 ComfyKit / ffmpeg 调用。
重量级依赖（comfykit, edge_tts, ffmpeg 等）在导入前 mock 以避免安装。
"""

import sys
import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ------------------------------------------------------------------
# 预先 mock 重量级依赖，避免 ModuleNotFoundError
# ------------------------------------------------------------------
_MOCKED_MODULES = [
    "comfykit",
    "edge_tts",
    "edge_tts.exceptions",
    "moviepy",
    "moviepy.editor",
    "playwright",
    "playwright.async_api",
]
for _mod_name in _MOCKED_MODULES:
    if _mod_name not in sys.modules:
        _mock = MagicMock()
        # comfykit.ComfyKit 需要是一个可实例化的类
        if _mod_name == "comfykit":
            _mock.ComfyKit = MagicMock
        # edge_tts.exceptions 需要有 NoAudioReceived
        if _mod_name == "edge_tts.exceptions":
            _mock.NoAudioReceived = type("NoAudioReceived", (Exception,), {})
        sys.modules[_mod_name] = _mock

from httpx import ASGITransport, AsyncClient

from app.models.media import MediaResult


# ------------------------------------------------------------------
# Mock MiniCore fixture
# ------------------------------------------------------------------

@pytest.fixture
def mock_core():
    """构造一个 mock MiniCore，所有子服务均为 AsyncMock/MagicMock。"""
    core = MagicMock()
    core.comfykit_ready = True
    core._initialized = True

    # TTSService mock（async callable）
    core.tts = AsyncMock(return_value="/tmp/test_audio.mp3")

    # MediaService mock（async callable）
    core.media = AsyncMock(return_value=MediaResult(
        media_type="image",
        url="https://example.com/test.png",
        duration=None,
    ))

    # VideoService mock（同步方法）
    core.video = MagicMock()
    core.video.create_video_from_image = MagicMock(return_value="/tmp/segment.mp4")
    core.video.concat_videos = MagicMock(return_value="/tmp/concat.mp4")
    core.video.add_bgm = MagicMock(return_value="/tmp/bgm_out.mp4")

    # FrameProcessor mock
    core.frame_processor = AsyncMock()

    return core


@pytest.fixture
def mock_core_uninit():
    """未初始化的 MiniCore（子服务为 None），用于 503 异常路径测试。"""
    core = MagicMock()
    core.comfykit_ready = False
    core.tts = None
    core.media = None
    core.video = None
    core.frame_processor = None
    return core


# ------------------------------------------------------------------
# FastAPI AsyncClient fixture
# ------------------------------------------------------------------

@pytest.fixture
async def client(mock_core):
    """注入 mock_core 的异步测试客户端。"""
    from main import app

    # 覆盖 lifespan 中设置的 core
    app.state.core = mock_core

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac


@pytest.fixture
async def client_no_core(mock_core_uninit):
    """core 子服务为 None 的测试客户端，模拟未初始化场景。"""
    from main import app

    app.state.core = mock_core_uninit

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        yield ac
