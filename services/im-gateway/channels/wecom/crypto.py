"""
企业微信渠道 — 消息加解密

实现企微消息回调的加解密逻辑（WXBizMsgCrypt）。
参考企微官方 SDK 和 Hermes wecom_crypto.py。

注意：WebSocket Bot 模式下消息不经过加密，此模块主要用于 HTTP 回调模式。
"""

import base64
import hashlib
import struct
import logging
from typing import Optional

logger = logging.getLogger("gateway.wecom.crypto")

try:
    from Crypto.Cipher import AES
    CRYPTO_AVAILABLE = True
except ImportError:
    try:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.backends import default_backend
        CRYPTO_AVAILABLE = True
    except ImportError:
        CRYPTO_AVAILABLE = False


class WeComCrypto:
    """
    企业微信消息加解密

    - 加密模式：AES-256-CBC
    - Padding：PKCS#7
    - 密钥：base64(encoding_aes_key) + "=" 解码后的 32 字节
    """

    def __init__(self, token: str, encoding_aes_key: str, corp_id: str):
        self._token = token
        self._corp_id = corp_id
        # encoding_aes_key 是 base64 编码的 43 位字符串，加 "=" 后解码为 32 字节
        self._aes_key = base64.b64decode(encoding_aes_key + "=")
        self._iv = self._aes_key[:16]

    def decrypt_message(self, encrypted: str) -> Optional[str]:
        """
        解密企微消息

        Args:
            encrypted: base64 编码的加密消息

        Returns:
            解密后的明文（XML 格式），解密失败返回 None
        """
        if not CRYPTO_AVAILABLE:
            logger.error("加解密库未安装，请安装 pycryptodome 或 cryptography")
            return None

        try:
            cipher_bytes = base64.b64decode(encrypted)
            plaintext = self._aes_decrypt(cipher_bytes)

            # 去除 PKCS#7 padding
            pad_len = plaintext[-1]
            content = plaintext[:-pad_len]

            # 结构：16字节随机串 + 4字节消息长度（网络序）+ 消息体 + CorpID
            msg_len = struct.unpack("!I", content[16:20])[0]
            message = content[20:20 + msg_len].decode("utf-8")

            # 验证 CorpID
            from_corp_id = content[20 + msg_len:].decode("utf-8")
            if from_corp_id != self._corp_id:
                logger.warning("CorpID 不匹配: 期望 %s，实际 %s", self._corp_id, from_corp_id)
                return None

            return message

        except Exception as e:
            logger.error("消息解密失败: %s", e)
            return None

    def encrypt_message(self, message: str) -> str:
        """
        加密企微消息

        Args:
            message: 明文消息（XML 格式）

        Returns:
            base64 编码的加密消息
        """
        import os
        import struct

        msg_bytes = message.encode("utf-8")
        corp_bytes = self._corp_id.encode("utf-8")
        random_bytes = os.urandom(16)

        # 结构：16字节随机串 + 4字节消息长度 + 消息体 + CorpID
        content = random_bytes + struct.pack("!I", len(msg_bytes)) + msg_bytes + corp_bytes

        # PKCS#7 padding
        block_size = 32
        pad_len = block_size - (len(content) % block_size)
        content += bytes([pad_len] * pad_len)

        cipher_bytes = self._aes_encrypt(content)
        return base64.b64encode(cipher_bytes).decode("utf-8")

    def verify_signature(self, signature: str, timestamp: str, nonce: str, encrypted: str) -> bool:
        """验证消息签名"""
        items = sorted([self._token, timestamp, nonce, encrypted])
        sha1 = hashlib.sha1("".join(items).encode("utf-8")).hexdigest()
        return sha1 == signature

    def _aes_decrypt(self, data: bytes) -> bytes:
        """AES-256-CBC 解密"""
        try:
            from Crypto.Cipher import AES as PyCryptoAES
            cipher = PyCryptoAES.new(self._aes_key, PyCryptoAES.MODE_CBC, self._iv)
            return cipher.decrypt(data)
        except ImportError:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.backends import default_backend
            cipher = Cipher(algorithms.AES(self._aes_key), modes.CBC(self._iv), backend=default_backend())
            decryptor = cipher.decryptor()
            return decryptor.update(data) + decryptor.finalize()

    def _aes_encrypt(self, data: bytes) -> bytes:
        """AES-256-CBC 加密"""
        try:
            from Crypto.Cipher import AES as PyCryptoAES
            cipher = PyCryptoAES.new(self._aes_key, PyCryptoAES.MODE_CBC, self._iv)
            return cipher.encrypt(data)
        except ImportError:
            from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
            from cryptography.hazmat.backends import default_backend
            cipher = Cipher(algorithms.AES(self._aes_key), modes.CBC(self._iv), backend=default_backend())
            encryptor = cipher.encryptor()
            return encryptor.update(data) + encryptor.finalize()
