/**
 * GuidedEmptyState 组件测试
 *
 * 覆盖：图标/标题/描述/步骤渲染 / CTA 按钮点击 / 次要操作链接与按钮 / 变体切换
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { Brain } from "lucide-react";
import { GuidedEmptyState } from "@/components/ui/guided-empty-state";

const defaultProps = {
  icon: Brain,
  title: "还没有记忆数据",
  description: "Agent 可以记住重要信息并在未来对话中使用",
  steps: ["打开记忆管理页面", "点击「添加记忆」", "输入标题和内容"],
  action: { label: "添加记忆", onClick: vi.fn() },
  secondaryAction: { label: "了解更多", href: "/docs/memory" },
};

describe("GuidedEmptyState", () => {
  it("渲染标题和描述", () => {
    render(<GuidedEmptyState {...defaultProps} />);
    expect(screen.getByText("还没有记忆数据")).toBeDefined();
    expect(screen.getByText(/Agent 可以记住重要信息/)).toBeDefined();
  });

  it("渲染步骤（编号 + 内容）", () => {
    render(<GuidedEmptyState {...defaultProps} />);
    // 三个步骤都应可见
    expect(screen.getByText("打开记忆管理页面")).toBeDefined();
    expect(screen.getByText("点击「添加记忆」")).toBeDefined();
    expect(screen.getByText("输入标题和内容")).toBeDefined();
    // 编号
    expect(screen.getByText("1")).toBeDefined();
    expect(screen.getByText("3")).toBeDefined();
  });

  it("主操作按钮点击触发 action.onClick", () => {
    const onClick = vi.fn();
    render(<GuidedEmptyState {...defaultProps} action={{ label: "添加记忆", onClick }} />);

    fireEvent.click(screen.getByText("添加记忆"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("无 action 时不渲染主按钮", () => {
    render(<GuidedEmptyState {...defaultProps} action={undefined} />);
    expect(screen.queryByText("添加记忆")).toBeNull();
  });

  it("secondaryAction 有 href 时渲染为链接", () => {
    render(<GuidedEmptyState {...defaultProps} />);
    const link = screen.getByText("了解更多");
    expect(link.closest("a")?.getAttribute("href")).toBe("/docs/memory");
  });

  it("secondaryAction 无 href 有 onClick 时渲染为按钮", () => {
    const onClick = vi.fn();
    render(
      <GuidedEmptyState
        {...defaultProps}
        secondaryAction={{ label: "了解更多", onClick }}
      />
    );

    fireEvent.click(screen.getByText("了解更多"));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("无 secondaryAction 时不渲染次要按钮", () => {
    render(<GuidedEmptyState {...defaultProps} secondaryAction={undefined} />);
    expect(screen.queryByText("了解更多")).toBeNull();
  });

  it("default 变体 — 灰色调", () => {
    render(<GuidedEmptyState {...defaultProps} variant="default" />);
    const container = screen.getByText("还没有记忆数据").closest('[class*="border-zinc"]');
    expect(container).toBeDefined();
  });

  it("success 变体 — 绿色调", () => {
    render(<GuidedEmptyState {...defaultProps} variant="success" />);
    const container = screen.getByText("还没有记忆数据").closest('[class*="border-emerald"]');
    expect(container).toBeDefined();
  });
});
