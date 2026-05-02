"""
ComfyKit 单例池 — 管理 ComfyUI/RunningHub 连接复用。

T1.5 实现：复用 Pixelle service.py 的 _get_or_create_comfykit 思路，
按 workflow 类型（selfhost/runninghub）维护独立连接池。
"""

# TODO T1.5: 实现 ComfyKitPool 单例管理
