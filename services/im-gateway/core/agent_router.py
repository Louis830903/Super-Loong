"""
Agent 路由器 — 三级规则链解析

学习 OpenClaw SessionKey 嵌入 agentId + Hermes session_store 路由智慧。
替代 bridge.py 中的 `get_agent_id()` + `_agent_mapping` 简单映射。

规则链优先级（从高到低）：
1. 群绑定：platform:chat_id → agent_id（管理员在前端为某群指定 Agent）
2. 用户绑定：platform:user_id → agent_id（特定用户绑定）
3. 平台默认：platform → agent_id（整个平台使用同一 Agent）
4. 全局默认：default_agent_id

持久化：所有绑定规则存储在 data/agent_bindings.json，重启后恢复。
"""

import json
import logging
import os
from pathlib import Path
from typing import Optional

logger = logging.getLogger("gateway.router")

# 持久化路径
_DATA_DIR = Path(__file__).resolve().parent.parent / "data"
_BINDINGS_FILE = _DATA_DIR / "agent_bindings.json"


class AgentRouter:
    """
    三级规则链 Agent 路由器

    解决旧架构"平台 → Agent 一对一"的局限：
    - 同一平台不同群可路由到不同 Agent
    - 同一平台不同用户可路由到不同 Agent
    - 支持运行时动态绑定/解绑
    """

    def __init__(self, default_agent_id: str = ""):
        self._chat_bindings: dict[str, str] = {}    # "feishu:chat_xxx" → agent_id
        self._user_bindings: dict[str, str] = {}     # "feishu:user_xxx" → agent_id
        self._platform_bindings: dict[str, str] = {} # "feishu" → agent_id
        self._default_agent_id = default_agent_id
        self._bindings_file = _BINDINGS_FILE
        self._bindings_file.parent.mkdir(parents=True, exist_ok=True)

        # 启动时恢复持久化绑定
        self._restore()

    @property
    def default_agent_id(self) -> str:
        return self._default_agent_id

    @default_agent_id.setter
    def default_agent_id(self, value: str):
        self._default_agent_id = value

    def resolve(self, platform: str, chat_id: str = "", user_id: str = "") -> str:
        """
        三级规则链解析 Agent ID

        Args:
            platform: 平台标识 (feishu/wecom/dingtalk/weixin)
            chat_id: 聊天/群 ID
            user_id: 用户 ID

        Returns:
            解析到的 Agent ID（可能为空字符串）
        """
        return (
            self._chat_bindings.get(f"{platform}:{chat_id}") if chat_id else None
        ) or (
            self._user_bindings.get(f"{platform}:{user_id}") if user_id else None
        ) or (
            self._platform_bindings.get(platform)
        ) or (
            self._default_agent_id
        ) or ""

    # ── 绑定操作 ──────────────────────────────────

    def bind_chat(self, platform: str, chat_id: str, agent_id: str):
        """绑定群/会话到指定 Agent"""
        key = f"{platform}:{chat_id}"
        self._chat_bindings[key] = agent_id
        self._persist()
        logger.info("群绑定: %s → %s", key, agent_id)

    def bind_user(self, platform: str, user_id: str, agent_id: str):
        """绑定用户到指定 Agent"""
        key = f"{platform}:{user_id}"
        self._user_bindings[key] = agent_id
        self._persist()
        logger.info("用户绑定: %s → %s", key, agent_id)

    def bind_platform(self, platform: str, agent_id: str):
        """绑定平台默认 Agent"""
        self._platform_bindings[platform] = agent_id
        self._persist()
        logger.info("平台绑定: %s → %s", platform, agent_id)

    def unbind_chat(self, platform: str, chat_id: str) -> bool:
        """解绑群/会话"""
        key = f"{platform}:{chat_id}"
        removed = self._chat_bindings.pop(key, None)
        if removed:
            self._persist()
            logger.info("群解绑: %s", key)
        return removed is not None

    def unbind_user(self, platform: str, user_id: str) -> bool:
        """解绑用户"""
        key = f"{platform}:{user_id}"
        removed = self._user_bindings.pop(key, None)
        if removed:
            self._persist()
            logger.info("用户解绑: %s", key)
        return removed is not None

    def unbind_platform(self, platform: str) -> bool:
        """解绑平台"""
        removed = self._platform_bindings.pop(platform, None)
        if removed:
            self._persist()
            logger.info("平台解绑: %s", platform)
        return removed is not None

    # ── 查询 ──────────────────────────────────────

    def get_all_bindings(self) -> dict:
        """获取所有绑定规则（供 API 返回）"""
        return {
            "chat_bindings": dict(self._chat_bindings),
            "user_bindings": dict(self._user_bindings),
            "platform_bindings": dict(self._platform_bindings),
            "default_agent_id": self._default_agent_id,
        }

    def get_binding_count(self) -> int:
        """绑定规则总数"""
        return (
            len(self._chat_bindings)
            + len(self._user_bindings)
            + len(self._platform_bindings)
        )

    # ── 持久化 ──────────────────────────────────────

    def _persist(self) -> None:
        """保存绑定规则到 JSON"""
        try:
            data = {
                "chat_bindings": self._chat_bindings,
                "user_bindings": self._user_bindings,
                "platform_bindings": self._platform_bindings,
            }
            tmp = self._bindings_file.with_suffix(".tmp")
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            if self._bindings_file.exists():
                os.unlink(self._bindings_file)
            os.rename(tmp, self._bindings_file)
        except Exception as e:
            logger.error("绑定规则持久化失败: %s", e)

    def _restore(self) -> None:
        """从 JSON 恢复绑定规则"""
        if not self._bindings_file.exists():
            return
        try:
            with open(self._bindings_file, "r", encoding="utf-8") as f:
                data = json.load(f)
            self._chat_bindings = data.get("chat_bindings", {})
            self._user_bindings = data.get("user_bindings", {})
            self._platform_bindings = data.get("platform_bindings", {})
            total = self.get_binding_count()
            if total > 0:
                logger.info("已恢复 %d 条绑定规则", total)
        except Exception as e:
            logger.error("绑定规则恢复失败: %s", e)
