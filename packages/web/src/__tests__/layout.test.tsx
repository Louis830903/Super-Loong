/**
 * 根布局 / AppShell 冒烟测试
 *
 * 验证 layout.tsx 的 metadata 导出，以及 AppShell 的基本结构渲染。
 * RootLayout 返回完整 <html>，无法被 RTL 直接挂载，故结构测试改测 AppShell。
 * 由于 Sidebar / Toast / AuthGuard 依赖浏览器 API（fetch/localStorage/window），
 * 全部 mock 隔离，只验证 AppShell 的装配关系。
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { metadata } from "@/app/layout";
import { AppShell } from "@/components/layout/app-shell";

// Mock 客户端组件，避免 jsdom 中调用浏览器 API
vi.mock("@/components/layout/sidebar", () => ({
  default: () => <nav data-testid="sidebar">Sidebar</nav>,
}));
vi.mock("@/components/ui/toast", () => ({
  ToastContainer: () => <div data-testid="toast">Toast</div>,
}));
// AuthGuard 依赖 fetch/localStorage/window 事件，异步决定是否渲染侧边栏；
// mock 成直通壳，同步渲染 sidebar + children，专注验证 AppShell 的装配。
vi.mock("@/components/auth/auth-guard", () => ({
  AuthGuard: ({
    children,
    sidebar,
  }: {
    children: React.ReactNode;
    sidebar: React.ReactNode;
  }) => (
    <>
      {sidebar}
      {children}
    </>
  ),
}));

describe("RootLayout / AppShell", () => {
  it("metadata 导出正确", () => {
    expect(metadata.title).toBe("Super Agent");
    expect(metadata.description).toBe("AI Agent 管理平台");
  });

  it("AppShell 渲染 Sidebar、Toast 和子内容", () => {
    render(
      <AppShell>
        <p>Hello World</p>
      </AppShell>,
    );

    expect(screen.getByTestId("sidebar")).toBeDefined();
    expect(screen.getByTestId("toast")).toBeDefined();
    expect(screen.getByText("Hello World")).toBeDefined();
  });
});
