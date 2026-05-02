"""
合成路由测试 — /forge/compose-frame, /forge/concat, /forge/add-bgm

每个接口覆盖：
  - happy path: mock VideoService 正常返回
  - 异常路径: core 未初始化 → 503
"""

import pytest


# ==================== POST /forge/compose-frame ====================

async def test_compose_frame_ok(client, mock_core):
    """happy path — 图片 + 音频合成视频段。"""
    resp = await client.post("/forge/compose-frame", json={
        "image_path": "/tmp/frame.png",
        "audio_path": "/tmp/narration.mp3",
        "fps": 30,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "video_segment_path" in body
    mock_core.video.create_video_from_image.assert_called_once()


async def test_compose_frame_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/compose-frame", json={
        "image_path": "/tmp/frame.png",
        "audio_path": "/tmp/narration.mp3",
    })
    assert resp.status_code == 503


# ==================== POST /forge/concat ====================

async def test_concat_ok(client, mock_core):
    """happy path — 多段视频拼接。"""
    resp = await client.post("/forge/concat", json={
        "segments": ["/tmp/seg1.mp4", "/tmp/seg2.mp4", "/tmp/seg3.mp4"],
        "method": "demuxer",
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "output_path" in body
    mock_core.video.concat_videos.assert_called_once()


async def test_concat_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/concat", json={
        "segments": ["/tmp/seg1.mp4"],
    })
    assert resp.status_code == 503


async def test_concat_empty_segments(client):
    """异常路径 — segments 为空列表触发 422 校验。"""
    resp = await client.post("/forge/concat", json={
        "segments": [],
    })
    assert resp.status_code == 422


# ==================== POST /forge/add-bgm ====================

async def test_add_bgm_ok(client, mock_core):
    """happy path — 为视频添加背景音乐。"""
    resp = await client.post("/forge/add-bgm", json={
        "video_path": "/tmp/main.mp4",
        "bgm_path": "/tmp/music.mp3",
        "volume": 0.3,
        "loop": True,
    })
    assert resp.status_code == 200
    body = resp.json()
    assert "output_path" in body
    mock_core.video.add_bgm.assert_called_once()


async def test_add_bgm_core_503(client_no_core):
    """异常路径 — MiniCore 未初始化返回 503。"""
    resp = await client_no_core.post("/forge/add-bgm", json={
        "video_path": "/tmp/main.mp4",
        "bgm_path": "/tmp/music.mp3",
    })
    assert resp.status_code == 503
