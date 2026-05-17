/**
 * DashboardPage 渲染冒烟测试
 *
 * 仅验证页面渲染不崩溃，不测试完整交互流。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

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

// ─── Mock useWebSocket ───
vi.mock("@/hooks/useWebSocket", () => ({
  useWebSocket: vi.fn(() => ({ lastEvent: null, connected: false })),
}));

// ─── Mock version-footer ───
vi.mock("@/components/layout/version-footer", () => ({
  VersionFooter: () => <div data-testid="version-footer">VersionFooter</div>,
}));

// ─── Mock sub-components（DashboardPage 用相对路径导入）───
vi.mock("@/app/dashboard/traces-panel", () => ({
  TracesPanel: () => <div data-testid="traces-panel">TracesPanel</div>,
}));
vi.mock("@/app/dashboard/onboarding-checklist", () => ({
  OnboardingChecklist: ({ systemHealthy }: any) => (
    <div data-testid="onboarding-checklist">
      Onboarding (healthy={String(systemHealthy)})
    </div>
  ),
}));

import DashboardPage from "@/app/dashboard/page";

describe("DashboardPage — 渲染冒烟", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({
      status: "ok",
      uptime: 3600,
      agents: 5,
      sessions: 12,
      gateway: "connected",
    });
  });

  it("渲染页面标题", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("仪表盘")).toBeDefined();
    });
  });

  it("渲染副标题「系统运行状态总览」", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("系统运行状态总览")).toBeDefined();
    });
  });

  it("加载后显示统计数据", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText("运行中")).toBeDefined();
      expect(screen.getByText("5")).toBeDefined(); // agents
    });
  });

  it("加载失败时显示错误信息", async () => {
    apiFetchMock.mockRejectedValue(new Error("Network Error"));
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByText(/API 连接失败/)).toBeDefined();
    });
  });

  it("渲染子组件 VersionFooter / OnboardingChecklist / TracesPanel", async () => {
    render(<DashboardPage />);
    await waitFor(() => {
      expect(screen.getByTestId("version-footer")).toBeDefined();
      expect(screen.getByTestId("onboarding-checklist")).toBeDefined();
      expect(screen.getByTestId("traces-panel")).toBeDefined();
    });
  });

  it("WebSocket 未连接时显示「离线」", () => {
    render(<DashboardPage />);
    expect(screen.getByText("离线")).toBeDefined();
  });
});
