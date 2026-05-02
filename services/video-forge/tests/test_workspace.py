"""
工作区工具函数测试 — workspace.py 单元测试。

覆盖：
  - build_workspace_dir: 创建目录 + 子目录幂等性
  - get_workspace_dir / get_final_output_path: 路径正确性
  - estimate_cost: 公式验证 + 默认价格兜底
"""

import os
import pytest
from pathlib import Path
from unittest.mock import patch


# ==================== build_workspace_dir ====================

def test_build_workspace_dir(tmp_path):
    """happy path — 创建工作区并验证子目录。"""
    with patch.dict(os.environ, {"SUPER_AGENT_MEDIA_ROOT": str(tmp_path)}):
        from app.utils.workspace import build_workspace_dir

        workspace = build_workspace_dir("test_job_001")

        assert workspace.exists()
        assert (workspace / "frames").is_dir()
        assert (workspace / "audio").is_dir()
        assert (workspace / "segments").is_dir()
        # 验证路径包含 video-jobs/test_job_001
        assert "video-jobs" in str(workspace)
        assert "test_job_001" in str(workspace)


def test_build_workspace_dir_idempotent(tmp_path):
    """幂等性 — 多次调用同一 job_id 不报错。"""
    with patch.dict(os.environ, {"SUPER_AGENT_MEDIA_ROOT": str(tmp_path)}):
        from app.utils.workspace import build_workspace_dir

        ws1 = build_workspace_dir("dup_job")
        ws2 = build_workspace_dir("dup_job")
        assert ws1 == ws2


# ==================== get_workspace_dir / get_final_output_path ====================

def test_get_workspace_dir(tmp_path):
    """路径正确性 — 不创建目录，只返回路径。"""
    with patch.dict(os.environ, {"SUPER_AGENT_MEDIA_ROOT": str(tmp_path)}):
        from app.utils.workspace import get_workspace_dir

        ws = get_workspace_dir("read_only_job")
        assert str(ws).endswith("read_only_job")
        # 不创建目录
        assert not ws.exists()


def test_get_final_output_path(tmp_path):
    """最终产物路径以 final.mp4 结尾。"""
    with patch.dict(os.environ, {"SUPER_AGENT_MEDIA_ROOT": str(tmp_path)}):
        from app.utils.workspace import get_final_output_path

        p = get_final_output_path("job_final")
        assert str(p).endswith("final.mp4")
        assert "job_final" in str(p)


# ==================== estimate_cost ====================

def test_estimate_cost_known_workflow():
    """happy path — 已知工作流的成本估算。"""
    from app.utils.workspace import estimate_cost

    pricing = {
        "runninghub/video_wan2.1_fusionx.json": 1.5,
        "_default": 1.0,
    }
    cost = estimate_cost("runninghub/video_wan2.1_fusionx.json", scenes=6, pricing_table=pricing)
    assert cost == pytest.approx(9.0)  # 6 × 1.5 = 9.0


def test_estimate_cost_unknown_workflow_uses_default():
    """异常路径 — 未知工作流使用 _default 兜底单价。"""
    from app.utils.workspace import estimate_cost

    pricing = {
        "_default": 2.0,
    }
    cost = estimate_cost("some/unknown_workflow.json", scenes=3, pricing_table=pricing)
    assert cost == pytest.approx(6.0)  # 3 × 2.0 = 6.0


def test_estimate_cost_no_default_fallback():
    """兜底 — pricing_table 无 _default 时退化为 1.0。"""
    from app.utils.workspace import estimate_cost

    cost = estimate_cost("any_workflow", scenes=4, pricing_table={})
    assert cost == pytest.approx(4.0)  # 4 × 1.0 = 4.0
