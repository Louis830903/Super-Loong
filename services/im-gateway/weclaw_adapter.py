"""
WeClaw 适配层 — 将微信 ClawBot (via WeClaw) 桥接到 Super Agent

WeClaw 是一个开源桥接工具，通过 HTTP/ACP/CLI 三种模式将任意 AI Agent 接入微信 ClawBot。
本模块实现 HTTP 模式的服务端，接收 WeClaw 转发的微信消息，经 bridge 转发到 Super Agent API，
并将回复返回给 WeClaw（WeClaw 自动处理图片 URL 提取、Markdown 转纯文本等）。

架构:
  用户(微信) → ClawBot → WeClaw → HTTP POST /weclaw/chat → 本模块 → bridge → Super Agent API
  Super Agent API → bridge → 本模块 → HTTP Response → WeClaw → ClawBot → 用户(微信)

主动推送:
  Super Agent → POST /weclaw/push → 本模块 → WeClaw API (127.0.0.1:18011) → ClawBot → 用户(微信)
"""

import logging
import os
import re
import time
from typing import Optional, Dict, Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

logger = logging.getLogger("im-gateway.weclaw")

# WeClaw 本地 API 地址（WeClaw 启动后默认监听此端口）
WECLAW_API_URL = os.environ.get("WECLAW_API_URL", "http://127.0.0.1:18011")

# 用于转换本地 MEDIA: 路径为 HTTP URL 的网关地址
GATEWAY_PUBLIC_URL = os.environ.get(
    "GATEWAY_PUBLIC_URL",
    f"http://127.0.0.1:{os.environ.get('IM_GATEWAY_PORT', '8642')}",
)


# ─── 请求/响应模型 ────────────────────────────────────────

class WeclawChatRequest(BaseModel):
    """WeClaw HTTP 模式发来的聊天请求"""
    message: str
    user_id: str = "wechat_user"
    conversation_id: str = ""


class WeclawChatResponse(BaseModel):
    """返回给 WeClaw 的聊天回复"""
    reply: str
    conversation_id: str = ""
    media_urls: list[str] = []


class WeclawPushRequest(BaseModel):
    """主动推送消息到微信"""
    to: str                    # 目标用户 ID (格式: user_id@im.wechat)
    text: str = ""             # 文本内容
    media: str = ""            # 媒体 URL (图片/文件)


class WeclawPushResponse(BaseModel):
    """推送结果"""
    success: bool
    message: str = ""


class WeclawConfigRequest(BaseModel):
    """动态更新 WeClaw 配置"""
    weclaw_api_url: Optional[str] = None
    gateway_public_url: Optional[str] = None


# ─── MEDIA: 标记 → HTTP URL 转换 ─────────────────────────

# 匹配 bridge.py 产生的 MEDIA:/path/to/file 标记
_MEDIA_TAG_RE = re.compile(r"MEDIA:(.+)")


def convert_media_tags_to_urls(text: str, gateway_url: str) -> tuple[str, list[str]]:
    """
    将回复中的 MEDIA:/local/path 标记转为 WeClaw 可下载的 HTTP URL。
    WeClaw 会自动识别回复中的图片 URL，下载后通过微信 CDN 发送图片消息。

    Returns:
        (处理后的文本, 媒体URL列表)
    """
    media_urls: list[str] = []
    lines = text.split("\n")
    clean_lines: list[str] = []

    for line in lines:
        match = _MEDIA_TAG_RE.match(line.strip())
        if match:
            local_path = match.group(1).strip()
            filename = os.path.basename(local_path)
            # 将本地路径转为网关的 /media/{filename} 端点 URL
            url = f"{gateway_url}/media/{filename}"
            media_urls.append(url)
            # 在文本中替换为 URL（WeClaw 会自动提取图片 URL）
            clean_lines.append(url)
        else:
            clean_lines.append(line)

    return "\n".join(clean_lines), media_urls


# ─── WeClaw 连接状态追踪 ─────────────────────────────────

class WeclawStatus:
    """追踪 WeClaw 连接状态"""

    def __init__(self):
        self.connected: bool = False
        self.last_message_at: float = 0
        self.message_count: int = 0
        self.last_error: str = ""
        self.weclaw_version: str = ""
        self.bound_user: str = ""

    def on_message(self, user_id: str):
        """记录收到消息"""
        self.connected = True
        self.last_message_at = time.time()
        self.message_count += 1
        if user_id:
            self.bound_user = user_id

    def on_error(self, error: str):
        """记录错误"""
        self.last_error = error

    def to_dict(self) -> Dict[str, Any]:
        return {
            "connected": self.connected,
            "last_message_at": self.last_message_at,
            "message_count": self.message_count,
            "last_error": self.last_error,
            "weclaw_version": self.weclaw_version,
            "bound_user": self.bound_user,
            "weclaw_api_url": WECLAW_API_URL,
        }


# 全局状态实例
weclaw_status = WeclawStatus()


# ─── 路由工厂 ─────────────────────────────────────────────

def create_weclaw_router(bridge) -> APIRouter:
    """
    创建 WeClaw 适配层路由。

    Args:
        bridge: AgentBridge 实例，用于转发消息到 Super Agent API
    """
    router = APIRouter(prefix="/weclaw", tags=["weclaw"])

    @router.post("/chat", response_model=WeclawChatResponse)
    async def weclaw_chat(req: WeclawChatRequest):
        """
        WeClaw HTTP 模式消息入口 — 核心对接点

        WeClaw 将微信消息通过 HTTP POST 转发到此端点，
        本端点通过 bridge 转发到 Super Agent API 获取回复。
        """
        try:
            weclaw_status.on_message(req.user_id)

            # 通过 bridge 转发到 Super Agent API
            # 使用 platform="weixin" 保持与其他 IM 平台一致的会话管理
            chat_id = req.conversation_id or req.user_id
            reply_text = await bridge.send_message(
                platform="weixin",
                chat_id=chat_id,
                user_id=req.user_id,
                text=req.message,
            )

            # 将 MEDIA: 本地路径标记转为 HTTP URL
            # WeClaw 会自动提取回复中的图片 URL 并作为微信图片消息发送
            clean_text, media_urls = convert_media_tags_to_urls(
                reply_text, GATEWAY_PUBLIC_URL
            )

            logger.info(
                "[weclaw] Chat from %s: %s → reply %d chars, %d media",
                req.user_id,
                req.message[:50],
                len(clean_text),
                len(media_urls),
            )

            return WeclawChatResponse(
                reply=clean_text,
                conversation_id=chat_id,
                media_urls=media_urls,
            )

        except Exception as e:
            weclaw_status.on_error(str(e))
            logger.error("[weclaw] Chat error: %s", e)
            raise HTTPException(status_code=500, detail=f"处理消息失败: {e}")

    @router.post("/push", response_model=WeclawPushResponse)
    async def weclaw_push(req: WeclawPushRequest):
        """
        主动推送消息到微信用户

        通过 WeClaw 本地 HTTP API 向指定微信用户发送消息。
        可被 Cron 调度器、Agent 工具或外部系统调用。
        """
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
                payload: Dict[str, str] = {"to": req.to}
                if req.text:
                    payload["text"] = req.text
                if req.media:
                    payload["media"] = req.media

                resp = await client.post(
                    f"{WECLAW_API_URL}/api/send",
                    json=payload,
                )
                resp.raise_for_status()

            logger.info("[weclaw] Push to %s: text=%s media=%s", req.to, bool(req.text), bool(req.media))
            return WeclawPushResponse(success=True, message="消息已推送")

        except httpx.ConnectError:
            msg = f"无法连接 WeClaw ({WECLAW_API_URL})，请确认 WeClaw 已启动"
            weclaw_status.on_error(msg)
            raise HTTPException(status_code=502, detail=msg)
        except Exception as e:
            weclaw_status.on_error(str(e))
            logger.error("[weclaw] Push error: %s", e)
            raise HTTPException(status_code=500, detail=f"推送失败: {e}")

    @router.get("/status")
    async def weclaw_get_status():
        """获取 WeClaw 连接状态"""
        status = weclaw_status.to_dict()

        # 尝试探测 WeClaw 本地 API 是否在线
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(3.0)) as client:
                resp = await client.get(f"{WECLAW_API_URL}/api/status")
                if resp.status_code == 200:
                    status["weclaw_running"] = True
                    weclaw_data = resp.json()
                    status["weclaw_version"] = weclaw_data.get("version", "")
                    status["weclaw_uptime"] = weclaw_data.get("uptime", 0)
                else:
                    status["weclaw_running"] = False
        except Exception:
            status["weclaw_running"] = False

        return status

    @router.post("/config")
    async def weclaw_update_config(req: WeclawConfigRequest):
        """动态更新 WeClaw 相关配置"""
        global WECLAW_API_URL, GATEWAY_PUBLIC_URL

        updated = {}
        if req.weclaw_api_url:
            WECLAW_API_URL = req.weclaw_api_url
            updated["weclaw_api_url"] = req.weclaw_api_url
        if req.gateway_public_url:
            GATEWAY_PUBLIC_URL = req.gateway_public_url
            updated["gateway_public_url"] = req.gateway_public_url

        logger.info("[weclaw] Config updated: %s", updated)
        return {"updated": updated}

    return router
