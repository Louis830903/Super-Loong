"""
RunningHub 标准模型 API 客户端 — 独立于 comfykit。

对接 RunningHub 官方标准 API（非 ComfyUI 工作流模式）：
- 鉴权：Bearer Token（Authorization 头）
- 基础地址：https://www.runninghub.cn
- 提交：POST /openapi/v2/<endpoint>  返回 {taskId, status}
- 轮询：POST /openapi/v2/query       返回 {status, results:[{url,outputType,nodeId}]}
- 上传：POST /openapi/v2/media/upload/binary  返回 {data:{download_url,fileName}}

关键差异（对比 comfykit RunningHubClient）：
1. base_url 用 www.runninghub.cn（非 .ai）
2. 鉴权用 Header Bearer（非 body apiKey）
3. 请求体扁平化（非 workflowId+nodeInfoList）
4. 响应无 code/data 包装（直接返回 taskId/status/results）
5. 结果字段 url/outputType（非 fileUrl/fileType）

复用约束：不造轮子，走 aiohttp，SSL 用 certifi bundle（Windows 兼容）。
"""

import asyncio
import os
import ssl
from pathlib import Path
from typing import Any, Dict, List, Optional

import aiohttp
import certifi
from loguru import logger


# 默认基础地址；可通过环境变量 RUNNINGHUB_STD_BASE_URL 覆盖
_DEFAULT_BASE_URL = "https://www.runninghub.cn"

# 轮询间隔（秒）和最大等待时长（秒）
_POLL_INTERVAL = 3.0
_POLL_TIMEOUT = 600.0  # 10 分钟


class RunningHubStandardError(Exception):
    """RunningHub 标准 API 调用错误（含 errorCode 结构化字段）。"""

    def __init__(self, message: str, error_code: str = "", error_message: str = ""):
        super().__init__(message)
        self.error_code = error_code
        self.error_message = error_message


class RunningHubStandardClient:
    """RunningHub 标准模型 API 客户端（Bearer Token + 扁平 REST）。"""

    def __init__(
        self,
        api_key: Optional[str] = None,
        base_url: Optional[str] = None,
        timeout: Optional[float] = None,
    ):
        """
        Args:
            api_key: RunningHub API Key（可不传，fallback 到 RUNNINGHUB_API_KEY 环境变量）
            base_url: 基础地址（默认 https://www.runninghub.cn）
            timeout: 单次 HTTP 请求超时（秒），默认 300s
        """
        self.api_key = api_key or os.getenv("RUNNINGHUB_API_KEY")
        if not self.api_key:
            raise ValueError("RunningHub API key 未配置（传参或设 RUNNINGHUB_API_KEY 环境变量）")

        self.base_url = (
            base_url
            or os.getenv("RUNNINGHUB_STD_BASE_URL")
            or _DEFAULT_BASE_URL
        ).rstrip("/")
        self.timeout = timeout if timeout is not None else 300.0
        self._session: Optional[aiohttp.ClientSession] = None

    # ------------------------------------------------------------------
    # Session 管理
    # ------------------------------------------------------------------

    async def _get_session(self) -> aiohttp.ClientSession:
        """获取/创建共享 aiohttp Session（certifi SSL，Windows 兼容）。"""
        if self._session is None or self._session.closed:
            ssl_ctx = ssl.create_default_context(cafile=certifi.where())
            connector = aiohttp.TCPConnector(ssl=ssl_ctx)
            timeout_config = aiohttp.ClientTimeout(total=self.timeout)
            self._session = aiohttp.ClientSession(
                timeout=timeout_config,
                connector=connector,
                trust_env=True,
            )
            logger.debug("创建 RunningHub 标准 API Session")
        return self._session

    async def close(self) -> None:
        """关闭 Session。"""
        if self._session and not self._session.closed:
            await self._session.close()
            self._session = None
            logger.debug("关闭 RunningHub 标准 API Session")

    async def __aenter__(self) -> "RunningHubStandardClient":
        return self

    async def __aexit__(self, exc_type, exc, tb) -> None:
        await self.close()

    # ------------------------------------------------------------------
    # 核心请求
    # ------------------------------------------------------------------

    def _auth_headers(self, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """Bearer 鉴权头。"""
        headers = {"Authorization": f"Bearer {self.api_key}"}
        if extra:
            headers.update(extra)
        return headers

    async def _post_json(
        self,
        endpoint: str,
        body: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        POST JSON 请求。

        Args:
            endpoint: 以 / 开头的完整路径（如 /openapi/v2/query）
            body: JSON 请求体
        Returns:
            解析后的响应 dict（已剥离 HTTP 层）
        """
        url = f"{self.base_url}{endpoint}"
        headers = self._auth_headers({"Content-Type": "application/json"})
        session = await self._get_session()

        logger.debug(f"POST {url}  body_keys={list(body.keys())}")
        async with session.post(url, headers=headers, json=body) as resp:
            text = await resp.text()
            if resp.status != 200:
                raise RunningHubStandardError(
                    f"HTTP {resp.status}: {text[:500]}"
                )
            try:
                data = await resp.json(content_type=None)
            except Exception as e:
                raise RunningHubStandardError(
                    f"响应非 JSON: {text[:500]} ({e})"
                )
            return data

    # ------------------------------------------------------------------
    # 文件上传
    # ------------------------------------------------------------------

    async def upload_file(self, file_path: str) -> str:
        """
        上传本地文件，返回可供后续 imageUrl 使用的 download_url。

        Args:
            file_path: 本地文件绝对/相对路径
        Returns:
            download_url（1 天有效）
        """
        path = Path(file_path)
        if not path.exists():
            raise FileNotFoundError(f"文件不存在: {file_path}")

        url = f"{self.base_url}/openapi/v2/media/upload/binary"
        headers = self._auth_headers()  # multipart 不手动设 Content-Type
        session = await self._get_session()

        with open(path, "rb") as f:
            form = aiohttp.FormData()
            form.add_field("file", f, filename=path.name)
            logger.info(f"上传文件到 RunningHub: {path.name}")
            async with session.post(url, headers=headers, data=form) as resp:
                text = await resp.text()
                if resp.status != 200:
                    raise RunningHubStandardError(f"上传失败 HTTP {resp.status}: {text[:500]}")
                try:
                    data = await resp.json(content_type=None)
                except Exception as e:
                    raise RunningHubStandardError(f"上传响应非 JSON: {text[:500]} ({e})")

        # 标准响应：{code:0, message:"success", data:{type, download_url, fileName, size}}
        if data.get("code") != 0:
            raise RunningHubStandardError(
                f"上传失败: code={data.get('code')} msg={data.get('message')}"
            )
        download_url = data.get("data", {}).get("download_url")
        if not download_url:
            raise RunningHubStandardError(f"上传响应缺 download_url: {data}")
        logger.info(f"✅ 上传成功: {download_url}")
        return download_url

    async def upload_url(self, media_url: str) -> str:
        """
        将一个远程 URL 转上传到 RunningHub（先下载再上传），返回新的 download_url。

        某些场景（如图→视频 imageUrl）直接传第三方 URL 即可，无需走此路径。
        此方法保留给后续"持久化中间产物"场景使用。
        """
        import tempfile
        session = await self._get_session()
        async with session.get(media_url) as resp:
            if resp.status != 200:
                raise RunningHubStandardError(f"下载远程 URL 失败 HTTP {resp.status}")
            content = await resp.read()

        suffix = Path(media_url.split("?")[0]).suffix or ".bin"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(content)
            tmp_path = tmp.name

        try:
            return await self.upload_file(tmp_path)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass

    # ------------------------------------------------------------------
    # 提交 + 轮询
    # ------------------------------------------------------------------

    async def submit_task(
        self,
        endpoint: str,
        body: Dict[str, Any],
    ) -> str:
        """
        提交一个标准 API 任务，返回 taskId。

        Args:
            endpoint: 模型 API 端点（如 /openapi/v2/rhart-image-g-2-official/text-to-image）
            body: 模型参数（扁平结构，各 API 不同）
        Returns:
            taskId
        """
        data = await self._post_json(endpoint, body)

        task_id = data.get("taskId")
        status = data.get("status", "")
        error_code = data.get("errorCode") or ""
        error_message = data.get("errorMessage") or ""

        if not task_id:
            raise RunningHubStandardError(
                f"提交任务失败: status={status} errorCode={error_code} errorMessage={error_message} raw={data}",
                error_code=error_code,
                error_message=error_message,
            )
        logger.info(f"📤 任务已提交: taskId={task_id} status={status}")
        return task_id

    async def poll_until_done(
        self,
        task_id: str,
        poll_interval: float = _POLL_INTERVAL,
        timeout: float = _POLL_TIMEOUT,
    ) -> Dict[str, Any]:
        """
        轮询任务直到完成（SUCCESS / FAILED / 超时）。

        Args:
            task_id: submit_task 返回的 ID
            poll_interval: 轮询间隔秒数（默认 3s）
            timeout: 最大等待秒数（默认 600s）
        Returns:
            完整响应 dict（含 status/results/errorCode 等）
        Raises:
            RunningHubStandardError: FAILED 或超时
        """
        query_endpoint = "/openapi/v2/query"
        elapsed = 0.0
        logger.info(f"⏳ 轮询任务 {task_id}（间隔 {poll_interval}s，超时 {timeout}s）")

        while elapsed < timeout:
            try:
                data = await self._post_json(query_endpoint, {"taskId": task_id})
            except Exception as e:
                # 单次轮询失败不终止，记录后继续
                logger.warning(f"轮询异常（继续）: {e}")
                await asyncio.sleep(poll_interval)
                elapsed += poll_interval
                continue

            status = (data.get("status") or "").upper()
            logger.debug(f"任务 {task_id} 状态: {status}")

            if status == "SUCCESS":
                logger.info(f"✅ 任务 {task_id} 成功")
                return data
            if status == "FAILED":
                error_code = data.get("errorCode") or ""
                error_message = data.get("errorMessage") or ""
                failed_reason = data.get("failedReason") or {}
                raise RunningHubStandardError(
                    f"任务失败: errorCode={error_code} errorMessage={error_message} failedReason={failed_reason}",
                    error_code=error_code,
                    error_message=error_message,
                )
            # QUEUED / RUNNING → 继续
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

        raise RunningHubStandardError(f"任务 {task_id} 轮询超时（>{timeout}s）")

    # ------------------------------------------------------------------
    # 便捷方法：一次性 run（提交 + 轮询 + 返回 results 列表）
    # ------------------------------------------------------------------

    async def run(
        self,
        endpoint: str,
        body: Dict[str, Any],
        poll_interval: float = _POLL_INTERVAL,
        timeout: float = _POLL_TIMEOUT,
    ) -> List[Dict[str, Any]]:
        """
        提交任务并阻塞直到完成，返回 results 列表。

        每个 result 形如 {url, nodeId, outputType, text?}。
        """
        task_id = await self.submit_task(endpoint, body)
        data = await self.poll_until_done(task_id, poll_interval=poll_interval, timeout=timeout)
        results = data.get("results") or []
        if not isinstance(results, list):
            raise RunningHubStandardError(f"results 字段异常: {results!r}")
        return results


def classify_results(results: List[Dict[str, Any]]) -> Dict[str, List[str]]:
    """
    按 outputType 把 results 分类为 images / videos / audios / texts（URL 或文本）。

    outputType 常见值：png / jpg / jpeg / webp / mp4 / mov / mp3 / wav / txt
    兼容性：若为 text 类型且包含 text 字段，写入 texts；否则按后缀分桶。
    """
    buckets: Dict[str, List[str]] = {"images": [], "videos": [], "audios": [], "texts": []}
    for item in results or []:
        if not isinstance(item, dict):
            continue
        out_type = (item.get("outputType") or "").lower()
        url = item.get("url")
        text = item.get("text")

        if out_type in {"png", "jpg", "jpeg", "gif", "webp"} and url:
            buckets["images"].append(url)
        elif out_type in {"mp4", "avi", "mov", "mkv", "webm"} and url:
            buckets["videos"].append(url)
        elif out_type in {"mp3", "wav", "flac", "m4a", "aac"} and url:
            buckets["audios"].append(url)
        elif text is not None:
            buckets["texts"].append(text)
        elif url:
            # 未知后缀兜底：按视频/图片头部关键字猜
            if "video" in out_type:
                buckets["videos"].append(url)
            elif "image" in out_type:
                buckets["images"].append(url)
            else:
                logger.warning(f"未识别 outputType={out_type!r} url={url}")
    return buckets
