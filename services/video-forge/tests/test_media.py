"""
媒体路由测试 — /forge/image, /forge/video, /forge/video/jobs/:id, /forge/tts

每个接口覆盖：
  - happy path: mock 正常返回
  - 异常路径: core 未初始化 → 503 / 参数校验 → 422
"""

import pytest
from unittest.mock import AsyncMock, patch

from app.models.media import MediaResult


# ==================== POST /forge/image ====================

async def test_forge_image_ok(client, mock_core):
    """happy path — 图片生成成功。"""
    resp = await client.post("/forge/image", json={
        "prompt": "a beautiful sunset",
        "width": 1024,
        "height": 1024,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert body["url"] == "https://example.com/test.png"
    assert body["media_type"] == "image"
    assert body["is_image"] is True
    mock_core.media.assert_awaited_once()


async def test_forge_image_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/image", json={"prompt": "test"})
    assert resp.status_code == 503


async def test_forge_image_empty_prompt(client):
    """异常路径 — prompt 为空触发 422 校验。"""
    resp = await client.post("/forge/image", json={"prompt": ""})
    assert resp.status_code == 422


# ==================== POST /forge/video ====================

async def test_forge_video_ok(client):
    """happy path — 异步视频任务创建，返回 job_id。"""
    resp = await client.post("/forge/video", json={
        "prompt": "a running cat",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "job_id" in body
    assert body["status"] == "queued"
    assert body["job_id"].startswith("vj_")


async def test_forge_video_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/video", json={"prompt": "test"})
    assert resp.status_code == 503


# ==================== GET /forge/video/jobs/:id ====================

async def test_forge_video_status_not_found(client):
    """异常路径 — 查询不存在的 job_id 返回 404。"""
    resp = await client.get("/forge/video/jobs/vj_nonexistent")
    assert resp.status_code == 404


async def test_forge_video_status_ok(client):
    """happy path — 先创建任务再查询状态。"""
    # 创建任务
    create_resp = await client.post("/forge/video", json={"prompt": "test video"})
    job_id = create_resp.json()["job_id"]

    # 查询状态
    status_resp = await client.get(f"/forge/video/jobs/{job_id}")
    assert status_resp.status_code == 200
    body = status_resp.json()
    assert body["job_id"] == job_id
    assert body["status"] in ("queued", "running", "completed", "failed")


# ==================== POST /forge/tts ====================

async def test_forge_tts_ok(client, mock_core):
    """happy path — TTS 生成成功。"""
    # mock get_audio_duration 避免文件系统依赖（路由内延迟导入自 app.utils.tts_util）
    with patch("app.utils.tts_util.get_audio_duration", return_value=3.5):
        resp = await client.post("/forge/tts", json={
            "text": "你好世界",
            "voice": "zh-CN-YunjianNeural",
        })
    assert resp.status_code == 200
    body = resp.json()
    assert body["audio_path"] == "/tmp/test_audio.mp3"
    mock_core.tts.assert_awaited_once()


async def test_forge_tts_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/tts", json={"text": "hello"})
    assert resp.status_code == 503


async def test_forge_tts_empty_text(client):
    """异常路径 — text 为空触发 422 校验。"""
    resp = await client.post("/forge/tts", json={"text": ""})
    assert resp.status_code == 422
