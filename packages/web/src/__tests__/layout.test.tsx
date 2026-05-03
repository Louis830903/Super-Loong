/**
 * 根布局冒烟测试
 *
 * 验证 layout.tsx 的 metadata 导出和基本 HTML 结构渲染。
 * 由于 Sidebar 依赖浏览器 API，使用 mock 隔离。
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import RootLayout, { metadata } from "@/app/layout";

// Mock 客户端组件，避免 jsdom 中调用浏览器 API
vi.mock("@/components/layout/sidebar", () => ({
  default: () => <nav data-testid="sidebar">Sidebar</nav>,
}));
vi.mock("@/components/ui/toast", () => ({
  ToastContainer: () => <div data-testid="toast">Toast</div>,
}));

describe("RootLayout", () => {
  it("metadata 导出正确", () => {
    expect(metadata.title).toBe("Super Agent");
    expect(metadata.description).toBe("AI Agent 管理平台");
  });

  it("渲染 Sidebar 和 main 结构", () => {
    render(
      <RootLayout>
        <p>Hello World</p>
      </RootLayout>,
    );

    expect(screen.getByTestId("sidebar")).toBeDefined();
    expect(screen.getByTestId("toast")).toBeDefined();
    expect(screen.getByText("Hello World")).toBeDefined();
  });
});
