"""WeClaw 集成测试 - 使用 FastAPI TestClient 测试完整 HTTP 端点"""

import os
import sys
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("SUPER_AGENT_API_URL", "http://localhost:3001")
os.environ.setdefault("WECLAW_ENABLED", "true")

from fastapi.testclient import TestClient


class TestWeclawIntegration(unittest.TestCase):
    """WeClaw HTTP 端点集成测试"""

    @classmethod
    def setUpClass(cls):
        from server import app, bridge as server_bridge
        cls.client = TestClient(app, raise_server_exceptions=False)
        cls.bridge = server_bridge

    def test_weclaw_status_endpoint(self):
        """GET /weclaw/status 应返回状态信息"""
        resp = self.client.get("/weclaw/status")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("connected", data)
        self.assertIn("message_count", data)
        self.assertIn("weclaw_api_url", data)

    def test_weclaw_chat_endpoint(self):
        """POST /weclaw/chat 应正确处理消息"""
        with patch.object(self.bridge, "send_message", new_callable=AsyncMock, return_value="你好！我是 Super Agent。"):
            resp = self.client.post("/weclaw/chat", json={
                "message": "你好",
                "user_id": "test_wx_user",
                "conversation_id": "conv_001",
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertIn("reply", data)
            self.assertIn("conversation_id", data)

    def test_weclaw_chat_empty_message(self):
        """POST /weclaw/chat 空消息应正常处理"""
        with patch.object(self.bridge, "send_message", new_callable=AsyncMock, return_value="请说点什么吧。"):
            resp = self.client.post("/weclaw/chat", json={
                "message": "",
                "user_id": "test_user",
            })
            self.assertEqual(resp.status_code, 200)

    def test_weclaw_chat_with_media_reply(self):
        """回复中包含 MEDIA: 标记应转为 HTTP URL"""
        with patch.object(
            self.bridge, "send_message", new_callable=AsyncMock,
            return_value="分析结果\n\nMEDIA:/data/media/chart.png"
        ):
            resp = self.client.post("/weclaw/chat", json={
                "message": "分析数据",
                "user_id": "test_user",
            })
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertTrue(len(data.get("media_urls", [])) > 0)
            self.assertIn("/media/chart.png", data["media_urls"][0])

    def test_weclaw_push_no_weclaw(self):
        """POST /weclaw/push WeClaw 未启动时应返回 502"""
        resp = self.client.post("/weclaw/push", json={
            "to": "test_user@im.wechat",
            "text": "测试推送",
        })
        self.assertIn(resp.status_code, [502, 500])

    def test_weclaw_config_update(self):
        """POST /weclaw/config 应动态更新配置"""
        resp = self.client.post("/weclaw/config", json={
            "weclaw_api_url": "http://127.0.0.1:19999",
        })
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("updated", data)
        self.assertEqual(data["updated"]["weclaw_api_url"], "http://127.0.0.1:19999")
        self.client.post("/weclaw/config", json={
            "weclaw_api_url": "http://127.0.0.1:18011",
        })

    def test_health_includes_weclaw(self):
        """GET /health 应包含 WeClaw 状态"""
        resp = self.client.get("/health")
        self.assertEqual(resp.status_code, 200)
        data = resp.json()
        self.assertIn("weclaw", data)
        self.assertIn("connected", data["weclaw"])

    def test_media_endpoint_404(self):
        """GET /media/nonexistent.png 不存在时应返回 404"""
        resp = self.client.get("/media/nonexistent_file_xyz.png")
        self.assertEqual(resp.status_code, 404)

    def test_media_path_traversal_blocked(self):
        """GET /media/../etc/passwd 路径穿越应被阻止"""
        resp = self.client.get("/media/..%2F..%2Fetc%2Fpasswd")
        self.assertEqual(resp.status_code, 404)


if __name__ == "__main__":
    unittest.main()
