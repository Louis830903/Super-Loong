/**
 * FeatureBanner 组件测试
 *
 * 覆盖：标题/描述/useCases/tips 渲染 / 折叠展开 / localStorage 持久化
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import { Sparkles } from "lucide-react";
import { FeatureBanner } from "@/components/ui/feature-banner";

// ─── localStorage mock ───
const { storageMock } = vi.hoisted(() => {
  let store: Record<string, string> = {};
  return {
    storageMock: {
      getItem: vi.fn((key: string) => store[key] ?? null),
      setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
      removeItem: vi.fn((key: string) => { delete store[key]; }),
      clear: vi.fn(() => { store = {}; }),
    },
  };
});

Object.defineProperty(window, "localStorage", { value: storageMock });

const defaultProps = {
  pageId: "memory",
  icon: Sparkles,
  title: "记忆管理",
  description: "持久化存储 Agent 的上下文记忆",
  useCases: ["自动记录关键对话", "跨会话信息检索"],
  tips: ["使用关键词标签提高检索精度"],
};

describe("FeatureBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storageMock.clear();
  });

  it("默认展开 — 显示描述、典型使用场景和使用技巧", () => {
    render(<FeatureBanner {...defaultProps} />);

    expect(screen.getByText("记忆管理")).toBeDefined();
    expect(screen.getByText(/持久化存储/)).toBeDefined();
    expect(screen.getByText("典型使用场景")).toBeDefined();
    expect(screen.getByText("自动记录关键对话")).toBeDefined();
    expect(screen.getByText("跨会话信息检索")).toBeDefined();
    expect(screen.getByText("使用技巧")).toBeDefined();
    expect(screen.getByText("使用关键词标签提高检索精度")).toBeDefined();
  });

  it("无 tips 时隐藏「使用技巧」区块", () => {
    render(<FeatureBanner {...defaultProps} tips={undefined} />);
    expect(screen.queryByText("使用技巧")).toBeNull();
  });

  it("空 tips 数组时隐藏「使用技巧」区块", () => {
    render(<FeatureBanner {...defaultProps} tips={[]} />);
    expect(screen.queryByText("使用技巧")).toBeNull();
  });

  it("折叠 — 点击按钮后隐藏展开内容", () => {
    render(<FeatureBanner {...defaultProps} />);

    // 初始展开
    expect(screen.getByText("典型使用场景")).toBeDefined();

    // 点击折叠按钮（标题栏整个是按钮）
    const toggleBtn = screen.getByRole("button");
    fireEvent.click(toggleBtn);

    // 折叠后内容隐藏
    expect(screen.queryByText("典型使用场景")).toBeNull();

    // 但标题仍然可见
    expect(screen.getByText("记忆管理")).toBeDefined();
  });

  it("折叠后再次展开 — 内容重现", () => {
    render(<FeatureBanner {...defaultProps} />);

    const toggleBtn = screen.getByRole("button");
    // 折叠
    fireEvent.click(toggleBtn);
    expect(screen.queryByText("典型使用场景")).toBeNull();

    // 展开
    fireEvent.click(toggleBtn);
    expect(screen.getByText("典型使用场景")).toBeDefined();
  });

  it("折叠状态持久化到 localStorage", () => {
    render(<FeatureBanner {...defaultProps} />);

    const toggleBtn = screen.getByRole("button");
    fireEvent.click(toggleBtn);

    expect(storageMock.setItem).toHaveBeenCalled();
    const calls = storageMock.setItem.mock.calls;
    const lastCall = calls[calls.length - 1];
    const parsed = JSON.parse(lastCall[1]);
    expect(parsed.memory).toBe(false); // pageId="memory" → collapsed
  });
});
