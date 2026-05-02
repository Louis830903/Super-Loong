"""
GET /health — 健康检查端点测试。

覆盖：
  - happy path: 正常返回 status=ok + comfykit_ready
  - 异常路径: core 未初始化时 comfykit_ready=False
"""

import pytest


async def test_health_ok(client):
    """happy path — 正常返回 ok + comfykit_ready=True。"""
    resp = await client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["comfykit_ready"] is True


async def test_health_core_not_ready(client_no_core):
    """异常路径 — MiniCore 未完全初始化时 comfykit_ready=False。"""
    resp = await client_no_core.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert body["comfykit_ready"] is False
