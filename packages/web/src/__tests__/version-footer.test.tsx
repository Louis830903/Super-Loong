/**
 * VersionFooter 组件测试
 *
 * 覆盖：footer 精简模式 / banner 横幅模式 / 版本号显示 / 更新提示 / 安装进度阶段
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";
import { VersionFooter } from "@/components/layout/version-footer";

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

// ─── Mock useVersionWebSocket ───
vi.mock("@/hooks/use-version-websocket", () => ({
  useVersionWebSocket: vi.fn(() => null),
}));

describe("VersionFooter — footer 模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({
      success: true,
      current: "1.2.3",
      latest: "1.2.3",
      outdated: false,
      commit: "abc123",
      branch: "main",
    });
  });

  it("显示版本号", async () => {
    render(<VersionFooter variant="footer" />);
    await waitFor(() => {
      expect(screen.getByText(/Super Loong v1\.2\.3/)).toBeDefined();
    });
  });

  it("加载失败时显示默认版本号", async () => {
    apiFetchMock.mockRejectedValue(new Error("Network error"));
    render(<VersionFooter variant="footer" />);
    await waitFor(() => {
      expect(screen.getByText(/Super Loong v0\.1\.0/)).toBeDefined();
    });
  });

  it("有新版本时显示升级箭头", async () => {
    apiFetchMock.mockResolvedValue({
      success: true,
      current: "1.0.0",
      latest: "2.0.0",
      outdated: true,
      releaseUrl: "https://github.com/release",
    });
    render(<VersionFooter variant="footer" />);
    await waitFor(() => {
      expect(screen.getByText(/v1\.0\.0 → v2\.0\.0/)).toBeDefined();
    });
  });

  it("Gitee 源显示 Gitee 标记", async () => {
    apiFetchMock.mockResolvedValue({
      success: true,
      current: "1.0.0",
      latest: "2.0.0",
      outdated: true,
      releaseUrl: "https://gitee.com/release",
      source: "gitee",
    });
    render(<VersionFooter variant="footer" />);
    await waitFor(() => {
      expect(screen.getByText("Gitee")).toBeDefined();
    });
  });
});

describe("VersionFooter — banner 模式", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("查询中/失败时不显示（返回 null）", async () => {
    // apiFetch 未 resolve 前 displayInfo 为 null → 返回 null
    apiFetchMock.mockImplementation(() => new Promise(() => {})); // never resolves
    const { container } = render(<VersionFooter variant="banner" />);
    // 初始为 null（无 DOM）
    expect(container.innerHTML).toBe("");
  });

  it("已是最新版本时不显示", async () => {
    apiFetchMock.mockResolvedValue({
      success: true,
      current: "1.2.3",
      latest: "1.2.3",
      outdated: false,
    });
    const { container } = render(<VersionFooter variant="banner" />);
    await waitFor(() => {
      // 最新版 → 不显示
      expect(container.textContent).toBe("");
    });
  });

  it("有新版本时显示更新横幅 + 安装按钮", async () => {
    apiFetchMock.mockResolvedValue({
      success: true,
      current: "1.0.0",
      latest: "2.0.0",
      outdated: true,
      releaseUrl: "https://github.com/release",
    });
    render(<VersionFooter variant="banner" />);
    await waitFor(() => {
      expect(screen.getByText(/有新版本可用：v2\.0\.0/)).toBeDefined();
      expect(screen.getByText("一键安装")).toBeDefined();
      expect(screen.getByText("手动下载")).toBeDefined();
    });
  });
});
