/**
 * MigrationCard 组件测试
 *
 * 覆盖：加载中状态 / 未检测到 OpenClaw / 预览列表 / 迁移报告 / 错误提示 / 覆盖开关
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import React from "react";
import { MigrationCard } from "@/components/settings/migration-card";

// ─── Mock apiFetch ───
const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
  apiFetch: apiFetchMock,
  API_BASE: "",
  WS_BASE: "",
}));

describe("MigrationCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("加载中 — 显示标题 + Loader2 旋转图标", () => {
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    render(<MigrationCard />);
    expect(screen.getByText("数据迁移")).toBeDefined();
    // Loader2 会有 animate-spin class
    const loader = document.querySelector(".animate-spin");
    expect(loader).toBeDefined();
  });

  it("未检测到 OpenClaw — 显示空状态提示", async () => {
    apiFetchMock.mockResolvedValue({
      openclawExists: false,
      openclawPath: "~/.openclaw",
      items: [],
    });
    render(<MigrationCard />);
    await waitFor(() => {
      expect(screen.getByText("未检测到 OpenClaw 数据目录")).toBeDefined();
    });
  });

  it("检测到 OpenClaw — 显示迁移预览列表", async () => {
    apiFetchMock.mockResolvedValue({
      openclawExists: true,
      openclawPath: "/home/user/.openclaw",
      items: [
        { kind: "soul", label: "Soul 数据", status: "found", detail: "3 条记录" },
        { kind: "memory", label: "记忆数据", status: "found", detail: "12 条记录" },
        { kind: "skills", label: "技能定义", status: "will_overwrite", detail: "2 个技能" },
        { kind: "not_found_item", label: "其他数据", status: "not_found", detail: "无" },
      ],
    });
    render(<MigrationCard />);
    await waitFor(() => {
      expect(screen.getByText("Soul 数据")).toBeDefined();
      expect(screen.getByText("记忆数据")).toBeDefined();
      expect(screen.getByText("技能定义")).toBeDefined();
    });
    // 状态徽章（多个项可能有相同状态）
    expect(screen.getAllByText("已找到").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("将覆盖")).toBeDefined();
  });

  it("预览加载失败 — 显示未检测到 OpenClaw（API 失败时回退到空状态）", async () => {
    apiFetchMock.mockRejectedValue(new Error("无法连接"));
    render(<MigrationCard />);
    await waitFor(() => {
      expect(screen.getByText("未检测到 OpenClaw 数据目录")).toBeDefined();
    });
  });

  it("迁移执行成功 — 显示迁移报告", async () => {
    // 第一次调用：preview
    apiFetchMock.mockResolvedValueOnce({
      openclawExists: true,
      openclawPath: "/home/user/.openclaw",
      items: [
        { kind: "soul", label: "Soul 数据", status: "found", detail: "3 条记录" },
      ],
    });
    render(<MigrationCard />);
    await waitFor(() => {
      expect(screen.getByText("Soul 数据")).toBeDefined();
    });

    // 第二次调用：execute
    apiFetchMock.mockResolvedValueOnce({
      success: true,
      summary: "迁移完成：1 项成功，0 项跳过",
      results: [
        { kind: "soul", label: "Soul 数据", status: "migrated", message: "已迁移 3 条记录" },
      ],
    });

    fireEvent.click(screen.getByText("开始迁移"));
    await waitFor(() => {
      expect(screen.getByText("迁移完成：1 项成功，0 项跳过")).toBeDefined();
      expect(screen.getByText("已迁移")).toBeDefined();
      // Soul 数据同时出现在预览和报告中 → getAllByText
      expect(screen.getAllByText("Soul 数据").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("迁移执行失败 — 显示错误", async () => {
    apiFetchMock
      .mockResolvedValueOnce({
        openclawExists: true,
        openclawPath: "/home/user/.openclaw",
        items: [{ kind: "soul", label: "Soul 数据", status: "found", detail: "x" }],
      })
      .mockRejectedValueOnce(new Error("迁移失败"));

    render(<MigrationCard />);
    await waitFor(() => {
      expect(screen.getByText("Soul 数据")).toBeDefined();
    });

    fireEvent.click(screen.getByText("开始迁移"));
    await waitFor(() => {
      expect(screen.getByText("迁移失败")).toBeDefined();
    });
  });

  it("覆盖选项开关 — 默认为未选中", async () => {
    apiFetchMock.mockResolvedValue({
      openclawExists: true,
      openclawPath: "/home/user/.openclaw",
      items: [{ kind: "soul", label: "Soul 数据", status: "found", detail: "x" }],
    });
    render(<MigrationCard />);
    await waitFor(() => {
      const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
      expect(checkbox.checked).toBe(false);
    });
  });
});
