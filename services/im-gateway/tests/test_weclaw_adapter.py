"""
WeClaw 适配层单元测试
测试 weclaw_adapter.py 中的核心功能
"""

import os
import sys
import unittest
from unittest.mock import MagicMock

# 将 im-gateway 目录加入 PATH
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from weclaw_adapter import (
    WeclawChatRequest,
    WeclawChatResponse,
    WeclawPushRequest,
    WeclawPushResponse,
    WeclawConfigRequest,
    WeclawStatus,
    convert_media_tags_to_urls,
    create_weclaw_router,
)


class TestConvertMediaTagsToUrls(unittest.TestCase):
    """测试 MEDIA: 标记转 HTTP URL 的转换逻辑"""

    def test_no_media_tags(self):
        """纯文本不应被修改"""
        text = "这是一段普通回复，没有媒体内容。"
        result_text, urls = convert_media_tags_to_urls(text, "http://localhost:8642")
        self.assertEqual(result_text, text)
        self.assertEqual(urls, [])

    def test_single_media_tag(self):
        """单个 MEDIA: 标记应转为 URL"""
        text = "请看这张图片：\n\nMEDIA:/data/media/chart.png"
        result_text, urls = convert_media_tags_to_urls(text, "http://localhost:8642")
        self.assertIn("http://localhost:8642/media/chart.png", result_text)
        self.assertEqual(len(urls), 1)
        self.assertEqual(urls[0], "http://localhost:8642/media/chart.png")

    def test_multiple_media_tags(self):
        """多个 MEDIA: 标记应全部转换"""
        text = "回复内容\n\nMEDIA:/path/a.jpg\nMEDIA:/path/b.pdf"
        result_text, urls = convert_media_tags_to_urls(text, "http://gw:8642")
        self.assertEqual(len(urls), 2)
        self.assertIn("http://gw:8642/media/a.jpg", urls)
        self.assertIn("http://gw:8642/media/b.pdf", urls)

    def test_media_tag_with_spaces(self):
        """MEDIA: 标记前后空格应被处理"""
        text = "  MEDIA:/path/to/file.png  "
        result_text, urls = convert_media_tags_to_urls(text, "http://localhost:8642")
        self.assertEqual(len(urls), 1)

    def test_mixed_content(self):
        """混合文本和 MEDIA: 标记"""
        text = "第一段文字\n这是正文\nMEDIA:/images/photo.jpg\n最后一段"
        result_text, urls = convert_media_tags_to_urls(text, "http://localhost:8642")
        self.assertEqual(len(urls), 1)
        self.assertIn("第一段文字", result_text)
        self.assertIn("最后一段", result_text)

    def test_gateway_url_trailing_slash(self):
        """网关 URL 不含尾部斜杠"""
        text = "MEDIA:/file.png"
        _, urls = convert_media_tags_to_urls(text, "http://localhost:8642")
        self.assertEqual(urls[0], "http://localhost:8642/media/file.png")

    def test_empty_text(self):
        """空文本不应报错"""
        result_text, urls = convert_media_tags_to_urls("", "http://localhost:8642")
        self.assertEqual(result_text, "")
        self.assertEqual(urls, [])


class TestWeclawStatus(unittest.TestCase):
    """测试 WeClaw 状态追踪"""

    def test_initial_state(self):
        """初始状态应为未连接"""
        status = WeclawStatus()
        self.assertFalse(status.connected)
        self.assertEqual(status.message_count, 0)
        self.assertEqual(status.last_error, "")

    def test_on_message(self):
        """收到消息后状态应更新"""
        status = WeclawStatus()
        status.on_message("user_123")
        self.assertTrue(status.connected)
        self.assertEqual(status.message_count, 1)
        self.assertEqual(status.bound_user, "user_123")
        self.assertGreater(status.last_message_at, 0)

    def test_multiple_messages(self):
        """多次消息应累加计数"""
        status = WeclawStatus()
        status.on_message("user_a")
        status.on_message("user_b")
        status.on_message("user_a")
        self.assertEqual(status.message_count, 3)
        self.assertEqual(status.bound_user, "user_a")

    def test_on_error(self):
        """错误应被记录"""
        status = WeclawStatus()
        status.on_error("连接超时")
        self.assertEqual(status.last_error, "连接超时")

    def test_to_dict(self):
        """序列化应包含所有字段"""
        status = WeclawStatus()
        status.on_message("test_user")
        d = status.to_dict()
        self.assertIn("connected", d)
        self.assertIn("message_count", d)
        self.assertIn("last_message_at", d)
        self.assertIn("bound_user", d)
        self.assertIn("weclaw_api_url", d)
        self.assertTrue(d["connected"])
        self.assertEqual(d["message_count"], 1)


class TestPydanticModels(unittest.TestCase):
    """测试 Pydantic 请求/响应模型"""

    def test_chat_request_defaults(self):
        """聊天请求默认值"""
        req = WeclawChatRequest(message="你好")
        self.assertEqual(req.message, "你好")
        self.assertEqual(req.user_id, "wechat_user")
        self.assertEqual(req.conversation_id, "")

    def test_chat_request_full(self):
        """聊天请求完整参数"""
        req = WeclawChatRequest(
            message="测试消息",
            user_id="wx_user_001",
            conversation_id="conv_123",
        )
        self.assertEqual(req.user_id, "wx_user_001")
        self.assertEqual(req.conversation_id, "conv_123")

    def test_chat_response(self):
        """聊天回复模型"""
        resp = WeclawChatResponse(
            reply="你好！",
            conversation_id="conv_123",
            media_urls=["http://example.com/image.jpg"],
        )
        self.assertEqual(resp.reply, "你好！")
        self.assertEqual(len(resp.media_urls), 1)

    def test_push_request(self):
        """推送请求模型"""
        req = WeclawPushRequest(to="user@im.wechat", text="通知消息")
        self.assertEqual(req.to, "user@im.wechat")
        self.assertEqual(req.text, "通知消息")
        self.assertEqual(req.media, "")

    def test_config_request(self):
        """配置更新请求"""
        req = WeclawConfigRequest(weclaw_api_url="http://new:18011")
        self.assertEqual(req.weclaw_api_url, "http://new:18011")
        self.assertIsNone(req.gateway_public_url)


class TestCreateWeclawRouter(unittest.TestCase):
    """测试路由工厂函数"""

    def test_router_creation(self):
        """路由应正确创建并包含预期端点"""
        mock_bridge = MagicMock()
        router = create_weclaw_router(mock_bridge)
        self.assertIsNotNone(router)
        self.assertEqual(router.prefix, "/weclaw")
        # FastAPI APIRouter 的 routes 路径包含前缀
        route_paths = [r.path for r in router.routes]
        self.assertIn("/weclaw/chat", route_paths)
        self.assertIn("/weclaw/push", route_paths)
        self.assertIn("/weclaw/status", route_paths)
        self.assertIn("/weclaw/config", route_paths)


if __name__ == "__main__":
    unittest.main()
