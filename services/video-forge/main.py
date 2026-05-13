"""
Video-Forge — 轻量 Python 视频微服务入口。

由 super-agent 的 video-forge-supervisor.ts 通过子进程方式启动：
    python -m uvicorn main:app --host 127.0.0.1 --port 8199

职责：
  - ComfyUI/RunningHub 工作流编排（图生/视频/TTS）
  - ffmpeg 合成（帧拼接、BGM 叠加、字幕合成）
  - 不含任何 LLM 调用逻辑（LLM 由 super-agent 侧 Agent 负责）
"""

import os
import shutil
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from loguru import logger


def _ensure_ffmpeg_on_path() -> None:
    """
    确保 `ffmpeg` 命令可被 subprocess 找到（零配置启动）。

    背景：
      ffmpeg-python / moviepy 底层用 subprocess.Popen(["ffmpeg", ...])，
      在 Windows 下 CreateProcess 要求 PATH 中存在 ffmpeg.exe，否则抛 WinError 2。
      历史上 T6 帧合成全部失败就是这个根因（用户系统未装 ffmpeg）。

    策略（按优先级）：
      1. 若系统 PATH 已存在 ffmpeg → 直接使用，无需注入
      2. 否则回退使用 imageio-ffmpeg 捆绑的二进制：
         - 它默认文件名是 ffmpeg-win-x86_64-v7.1.exe，需要创建 ffmpeg.exe 别名
         - 将其所在目录 prepend 到 os.environ["PATH"]
    """
    if shutil.which("ffmpeg"):
        return  # 系统已安装，放行

    try:
        import imageio_ffmpeg  # moviepy 的间接依赖，自带跨平台 ffmpeg 二进制
    except ImportError:
        logger.warning(
            "[ffmpeg-bootstrap] imageio-ffmpeg 未安装，且系统 PATH 无 ffmpeg，"
            "合成调用将失败。请执行 `uv sync` 或手动安装 ffmpeg。"
        )
        return

    bundled = Path(imageio_ffmpeg.get_ffmpeg_exe())
    if not bundled.exists():
        logger.warning(f"[ffmpeg-bootstrap] imageio-ffmpeg 报告的二进制不存在：{bundled}")
        return

    alias = bundled.parent / "ffmpeg.exe"
    if not alias.exists():
        try:
            shutil.copy2(bundled, alias)
            logger.info(f"[ffmpeg-bootstrap] 为捆绑二进制创建别名：{alias}")
        except OSError as exc:
            logger.warning(f"[ffmpeg-bootstrap] 创建 ffmpeg.exe 别名失败：{exc}")
            return

    os.environ["PATH"] = f"{bundled.parent}{os.pathsep}{os.environ.get('PATH', '')}"
    logger.info(f"[ffmpeg-bootstrap] 已将 imageio-ffmpeg 目录注入 PATH：{bundled.parent}")


# 必须在导入任何依赖 ffmpeg 的 app.* 模块前完成 PATH 注入
_ensure_ffmpeg_on_path()

from app.api.health import router as health_router  # noqa: E402
from app.api.admin import router as admin_router  # noqa: E402
from app.api.media import router as media_router  # noqa: E402
from app.api.compose import router as compose_router  # noqa: E402
from app.api.analysis import router as analysis_router  # noqa: E402
from app.core.mini_core import MiniCore  # noqa: E402

# 全局 MiniCore 实例（供路由层通过 app.state.core 访问）
_core: MiniCore | None = None


@asynccontextmanager
async def lifespan(application: FastAPI):
    """应用生命周期：启动时初始化 MiniCore，关闭时清理。"""
    global _core
    logger.info("video-forge 启动中...")
    _core = MiniCore("config.yaml")
    await _core.initialize()
    application.state.core = _core
    yield
    logger.info("video-forge 关闭，清理资源...")
    if _core:
        await _core.cleanup()
        _core = None


app = FastAPI(
    title="Video-Forge",
    description="轻量 Python 视频微服务 — super-agent 子进程",
    version="0.1.0",
    lifespan=lifespan,
)

# 挂载路由
app.include_router(health_router)
app.include_router(admin_router)
app.include_router(media_router, prefix="/forge")
app.include_router(compose_router, prefix="/forge")
app.include_router(analysis_router, prefix="/forge")


if __name__ == "__main__":
    import uvicorn

    # PM2/生产环境不启用 reload，开发时可设 VIDEO_FORGE_RELOAD=1
    reload = os.environ.get("VIDEO_FORGE_RELOAD", "") == "1"
    uvicorn.run("main:app", host="127.0.0.1", port=8199, reload=reload)
