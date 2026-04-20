# -*- coding: utf-8 -*-
"""
Adapter compliance unit tests
Covers P0-P2 improvements.
"""

import asyncio
import os
import sys
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from adapters.base import (
    TokenManager,
    ChannelMediaAdapter,
    MediaPayload,
    AdapterError,
    PLATFORM_SIZE_LIMITS,
    get_size_limit,
    TOKEN_EXPIRED_CODES,
    DEFAULT_SIZE_LIMIT,
)
from adapters.wecom import WeComMediaAdapter, WeComTokenManager, KIND_TO_WECOM_TYPE
from adapters.feishu import (
    FeishuMediaAdapter,
    FeishuTokenManager,
    KIND_TO_FEISHU_FILE_TYPE,
    MIME_TO_FEISHU_FILE_TYPE,
    _resolve_file_type,
)
from adapters.dingtalk import DingTalkMediaAdapter, DingTalkTokenManager, KIND_TO_DINGTALK_TYPE


def run_async(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


# === 1. PLATFORM_SIZE_LIMITS ===

class TestPlatformSizeLimits(unittest.TestCase):

    def test_wecom_limits(self):
        self.assertEqual(get_size_limit("wecom", "image"), 10 * 1024 * 1024)
        self.assertEqual(get_size_limit("wecom", "audio"), 2 * 1024 * 1024)
        self.assertEqual(get_size_limit("wecom", "video"), 10 * 1024 * 1024)
        self.assertEqual(get_size_limit("wecom", "file"), 20 * 1024 * 1024)

    def test_feishu_limits(self):
        self.assertEqual(get_size_limit("feishu", "image"), 10 * 1024 * 1024)
        self.assertEqual(get_size_limit("feishu", "file"), 30 * 1024 * 1024)

    def test_dingtalk_limits(self):
        self.assertEqual(get_size_limit("dingtalk", "image"), 20 * 1024 * 1024)
        self.assertEqual(get_size_limit("dingtalk", "audio"), 2 * 1024 * 1024)
        self.assertEqual(get_size_limit("dingtalk", "video"), 20 * 1024 * 1024)

    def test_unknown_platform_returns_default(self):
        self.assertEqual(get_size_limit("unknown", "image"), DEFAULT_SIZE_LIMIT)

    def test_unknown_kind_returns_default(self):
        self.assertEqual(get_size_limit("wecom", "xyz"), DEFAULT_SIZE_LIMIT)


# === 2. TokenManager ===

class ConcreteTokenManager(TokenManager):
    def __init__(self, static_token="", has_creds=True, fetch_result=("new_token", 7200)):
        super().__init__(static_token=static_token)
        self._has_creds = has_creds
        self._fetch_result = fetch_result
        self.fetch_count = 0

    def has_credentials(self):
        return self._has_creds

    async def _fetch_token(self):
        self.fetch_count += 1
        return self._fetch_result


class TestTokenManager(unittest.TestCase):

    def test_no_creds_returns_static(self):
        mgr = ConcreteTokenManager(static_token="s", has_creds=False)
        self.assertEqual(run_async(mgr.get_token()), "s")
        self.assertEqual(mgr.fetch_count, 0)

    def test_with_creds_fetches(self):
        mgr = ConcreteTokenManager(has_creds=True, fetch_result=("fetched", 7200))
        self.assertEqual(run_async(mgr.get_token()), "fetched")
        self.assertEqual(mgr.fetch_count, 1)

    def test_token_cached(self):
        mgr = ConcreteTokenManager(has_creds=True, fetch_result=("c", 7200))
        run_async(mgr.get_token())
        run_async(mgr.get_token())
        self.assertEqual(mgr.fetch_count, 1)

    def test_force_refresh(self):
        mgr = ConcreteTokenManager(has_creds=True, fetch_result=("f", 7200))
        run_async(mgr.get_token())
        run_async(mgr.force_refresh())
        self.assertEqual(mgr.fetch_count, 2)

    def test_expired_triggers_refresh(self):
        mgr = ConcreteTokenManager(has_creds=True, fetch_result=("t1", 1))
        run_async(mgr.get_token())
        mgr._expires_at = time.time() - 100
        mgr._fetch_result = ("t2", 7200)
        self.assertEqual(run_async(mgr.get_token()), "t2")
        self.assertEqual(mgr.fetch_count, 2)


# === 3. Platform Token Managers ===

class TestWeComTokenManager(unittest.TestCase):
    def test_has_credentials_true(self):
        self.assertTrue(WeComTokenManager(corpid="w", corpsecret="s").has_credentials())

    def test_has_credentials_false(self):
        self.assertFalse(WeComTokenManager().has_credentials())

    def test_static_fallback(self):
        mgr = WeComTokenManager(static_token="st")
        self.assertEqual(run_async(mgr.get_token()), "st")


class TestFeishuTokenManager(unittest.TestCase):
    def test_has_credentials(self):
        self.assertTrue(FeishuTokenManager(app_id="a", app_secret="s").has_credentials())

    def test_no_credentials(self):
        self.assertFalse(FeishuTokenManager().has_credentials())


class TestDingTalkTokenManager(unittest.TestCase):
    def test_has_credentials(self):
        self.assertTrue(DingTalkTokenManager(appkey="k", appsecret="s").has_credentials())

    def test_no_credentials(self):
        self.assertFalse(DingTalkTokenManager().has_credentials())


# === 4. WeComMediaAdapter ===

class TestWeComAdapterConfig(unittest.TestCase):

    def test_agentid_configurable(self):
        a = WeComMediaAdapter(agentid=1000002)
        self.assertEqual(a._agentid, 1000002)

    def test_agentid_default(self):
        self.assertEqual(WeComMediaAdapter()._agentid, 0)

    def test_token_mgr_with_creds(self):
        a = WeComMediaAdapter(corpid="c", corpsecret="s")
        self.assertTrue(a._token_manager.has_credentials())

    def test_token_mgr_static(self):
        a = WeComMediaAdapter(access_token="t")
        self.assertFalse(a._token_manager.has_credentials())

    def test_platform_name(self):
        self.assertEqual(WeComMediaAdapter().platform_name, "wecom")

    def test_type_mapping(self):
        self.assertEqual(KIND_TO_WECOM_TYPE["audio"], "voice")
        self.assertEqual(KIND_TO_WECOM_TYPE["video"], "video")


# === 5. FeishuMediaAdapter ===

class TestFeishuAdapterConfig(unittest.TestCase):

    def test_token_mgr_with_creds(self):
        a = FeishuMediaAdapter(app_id="a", app_secret="s")
        self.assertTrue(a._token_manager.has_credentials())

    def test_platform_name(self):
        self.assertEqual(FeishuMediaAdapter().platform_name, "feishu")

    def test_file_type_pdf(self):
        p = MediaPayload(path="/t.pdf", kind="document", mime_type="application/pdf", filename="t.pdf")
        self.assertEqual(_resolve_file_type(p), "pdf")

    def test_file_type_doc(self):
        p = MediaPayload(
            path="/t.docx", kind="document",
            mime_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            filename="t.docx",
        )
        self.assertEqual(_resolve_file_type(p), "doc")

    def test_file_type_xls(self):
        p = MediaPayload(path="/t.xls", kind="document", mime_type="application/vnd.ms-excel", filename="t.xls")
        self.assertEqual(_resolve_file_type(p), "xls")

    def test_file_type_ppt(self):
        p = MediaPayload(
            path="/t.pptx", kind="document",
            mime_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            filename="t.pptx",
        )
        self.assertEqual(_resolve_file_type(p), "ppt")

    def test_file_type_unknown(self):
        p = MediaPayload(path="/t.xyz", kind="file", mime_type="application/octet-stream", filename="t.xyz")
        self.assertEqual(_resolve_file_type(p), "stream")


# === 6. DingTalkMediaAdapter ===

class TestDingTalkAdapterConfig(unittest.TestCase):

    def test_agent_id_configurable(self):
        a = DingTalkMediaAdapter(agent_id=12345678)
        self.assertEqual(a._agent_id, 12345678)

    def test_agent_id_default(self):
        self.assertEqual(DingTalkMediaAdapter()._agent_id, 0)

    def test_token_mgr_with_creds(self):
        a = DingTalkMediaAdapter(appkey="k", appsecret="s")
        self.assertTrue(a._token_manager.has_credentials())

    def test_platform_name(self):
        self.assertEqual(DingTalkMediaAdapter().platform_name, "dingtalk")

    def test_video_native(self):
        self.assertEqual(KIND_TO_DINGTALK_TYPE["video"], "video")

    def test_supports_kind_video(self):
        self.assertTrue(DingTalkMediaAdapter().supports_kind("video"))


# === 7. TOKEN_EXPIRED_CODES ===

class TestTokenExpiredCodes(unittest.TestCase):

    def test_wecom(self):
        self.assertIn(42001, TOKEN_EXPIRED_CODES["wecom"])
        self.assertIn(40014, TOKEN_EXPIRED_CODES["wecom"])

    def test_feishu(self):
        self.assertIn(99991663, TOKEN_EXPIRED_CODES["feishu"])

    def test_dingtalk(self):
        self.assertIn(88, TOKEN_EXPIRED_CODES["dingtalk"])


# === 8. bridge validate_attachment ===

class TestBridgeValidateAttachment(unittest.TestCase):

    def test_nonexistent_file(self):
        from bridge import validate_attachment
        ok, msg = validate_attachment("/nonexistent/file.png")
        self.assertFalse(ok)

    def test_accepts_platform_kind_params(self):
        from bridge import validate_attachment
        import inspect
        sig = inspect.signature(validate_attachment)
        self.assertIn("platform", sig.parameters)
        self.assertIn("kind", sig.parameters)

    def test_max_attachment_bytes_increased(self):
        from bridge import MAX_ATTACHMENT_BYTES
        self.assertEqual(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024)


# === 9. AdapterError ===

class TestAdapterError(unittest.TestCase):

    def test_create(self):
        e = AdapterError(error_type="token_expired", error_code=42001, message="exp", retryable=True)
        self.assertEqual(e.error_type, "token_expired")
        self.assertTrue(e.retryable)

    def test_defaults(self):
        e = AdapterError(error_type="network")
        self.assertEqual(e.error_code, 0)
        self.assertFalse(e.retryable)


if __name__ == "__main__":
    unittest.main()
