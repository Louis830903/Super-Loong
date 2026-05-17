/**
 * SettingsPage 渲染冒烟测试
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

// ─── Mock MigrationCard ───
vi.mock("@/components/settings/migration-card", () => ({
  MigrationCard: () => <div data-testid="migration-card">MigrationCard</div>,
}));

import SettingsPage from "@/app/settings/page";

describe("SettingsPage — 渲染冒烟", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 mock：services、providers、flags API 返回空
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/services")) {
        return Promise.resolve({ services: [] });
      }
      if (url.includes("/api/models/providers")) {
        return Promise.resolve({ providers: [] });
      }
      if (url.includes("/api/auth/keys")) {
        return Promise.resolve({ keys: [] });
      }
      if (url.includes("/api/settings/flags")) {
        return Promise.resolve({ flags: [] });
      }
      return Promise.resolve({});
    });
  });

  it("渲染页面标题「模型配置」", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("模型配置")).toBeDefined();
    });
  });

  it("渲染副标题「选择 Provider，填写 API Key…」", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText(/选择 Provider，填写 API Key/)).toBeDefined();
    });
  });

  it("渲染「持久化状态」概览面板", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByText("持久化状态")).toBeDefined();
    });
  });

  it("渲染 MigrationCard 子组件", async () => {
    render(<SettingsPage />);
    await waitFor(() => {
      expect(screen.getByTestId("migration-card")).toBeDefined();
    });
  });
});
