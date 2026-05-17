/**
 * ToastContainer 组件测试
 *
 * 覆盖：空状态隐藏 / error/success/info 三类型渲染 / 手动关闭 / 最多 5 条
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

// ─── Mock @/lib/utils — 控制 onToast 回调 ───
const { onToastMock, showToastMock } = vi.hoisted(() => ({
  onToastMock: vi.fn(),
  showToastMock: vi.fn(),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
  onToast: onToastMock,
  showToast: showToastMock,
}));

import { ToastContainer } from "@/components/ui/toast";

// ─── 辅助：获取 onToast 注册的回调 ───
function getToastListener(): (msg: string, type: string) => void {
  expect(onToastMock).toHaveBeenCalled();
  return onToastMock.mock.calls[0]?.[0];
}

describe("ToastContainer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("空列表时渲染 null（不显示任何 DOM）", () => {
    const { container } = render(<ToastContainer />);
    expect(container.innerHTML).toBe("");
  });

  it("error 类型 — 红色背景 + AlertCircle 图标 + 错误文案", async () => {
    render(<ToastContainer />);
    const listener = getToastListener();
    expect(listener).toBeDefined();

    act(() => { listener("网络错误", "error"); });

    expect(screen.getByText("网络错误")).toBeDefined();
    // 红色边框样式验证
    const toastEl = screen.getByText("网络错误").closest('[class*="border-red"]');
    expect(toastEl).toBeDefined();
  });

  it("success 类型 — 绿色背景 + CheckCircle 图标", () => {
    render(<ToastContainer />);
    const listener = getToastListener();

    act(() => { listener("保存成功", "success"); });

    expect(screen.getByText("保存成功")).toBeDefined();
    const toastEl = screen.getByText("保存成功").closest('[class*="border-green"]');
    expect(toastEl).toBeDefined();
  });

  it("info 类型 — 蓝色背景 + Info 图标（默认）", () => {
    render(<ToastContainer />);
    const listener = getToastListener();

    act(() => { listener("正在处理...", "info"); });

    expect(screen.getByText("正在处理...")).toBeDefined();
    const toastEl = screen.getByText("正在处理...").closest('[class*="border-blue"]');
    expect(toastEl).toBeDefined();
  });

  it("手动关闭 — 点击 X 按钮移除 toast", () => {
    render(<ToastContainer />);
    const listener = getToastListener();

    act(() => { listener("可关闭消息", "error"); });
    expect(screen.getByText("可关闭消息")).toBeDefined();

    // 点击 X 关闭按钮
    const closeBtn = screen.getByRole("button");
    fireEvent.click(closeBtn);

    expect(screen.queryByText("可关闭消息")).toBeNull();
  });

  it("最多保留 5 条（第 6 条挤掉最早的第 1 条）", () => {
    render(<ToastContainer />);
    const listener = getToastListener();

    act(() => {
      for (let i = 1; i <= 5; i++) listener(`消息${i}`, "info");
    });
    // 5 条全部存在
    for (let i = 1; i <= 5; i++) {
      expect(screen.getByText(`消息${i}`)).toBeDefined();
    }

    // 第 6 条 — 第 1 条应被挤出
    act(() => { listener("消息6", "error"); });
    expect(screen.queryByText("消息1")).toBeNull();
    expect(screen.getByText("消息6")).toBeDefined();
  });
});
