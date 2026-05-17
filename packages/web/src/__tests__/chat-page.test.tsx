/**
 * ChatPage 渲染冒烟测试
 *
 * 仅验证页面渲染不崩溃，不测试完整对话交互流。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import React from "react";

// ─── Mock apiFetch / cn ───
const { apiFetchMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(),
}));
vi.mock("@/lib/utils", () => ({
  cn: (...args: string[]) => args.filter(Boolean).join(" "),
  apiFetch: apiFetchMock,
  API_BASE: "",
}));

// ─── Mock useAgents ───
vi.mock("@/hooks/useAgents", () => ({
  useAgents: vi.fn(() => ({
    agents: [
      { id: "agent-1", name: "通用助手", isBuiltin: true, department: "general", departmentLabel: "通用", model: "gpt-4", originalTools: [] },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

// ─── Mock file-utils ───
vi.mock("@/lib/file-utils", () => ({
  isTextFile: vi.fn(() => false),
  isParseableFile: vi.fn(() => false),
  readFileAsText: vi.fn(() => Promise.resolve("")),
  readFileAsBase64: vi.fn(() => Promise.resolve("")),
}));

// ─── Mock speech recognition ───
vi.stubGlobal("webkitSpeechRecognition", undefined);
vi.stubGlobal("SpeechRecognition", undefined);

// ─── Mock scrollTo (jsdom 中 div 没有 scrollTo 方法) ───
Element.prototype.scrollTo = vi.fn() as unknown as typeof Element.prototype.scrollTo;

import ChatPage from "@/app/chat/page";

describe("ChatPage — 渲染冒烟", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // 默认 mock：conversations API 返回空列表
    apiFetchMock.mockImplementation((url: string) => {
      if (url.includes("/api/conversations")) {
        return Promise.resolve({ conversations: [] });
      }
      if (url.includes("/api/models/providers")) {
        return Promise.resolve({ providers: [] });
      }
      return Promise.resolve({});
    });
  });

  it("渲染对话面板标题「对话」", async () => {
    render(<ChatPage />);
    await waitFor(() => {
      // 左侧面板 h2 + 右侧面板 h1 都显示「对话」
      const headings = screen.getAllByText("对话");
      expect(headings.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("无活跃对话时显示「暂无对话」占位", async () => {
    render(<ChatPage />);
    await waitFor(() => {
      expect(screen.getByText("暂无对话")).toBeDefined();
    });
  });

  it("渲染「新建对话」按钮", async () => {
    render(<ChatPage />);
    await waitFor(() => {
      // Plus 按钮 title 为"新建对话"
      const btn = screen.getByTitle("新建对话");
      expect(btn).toBeDefined();
    });
  });

  it("渲染输入框 placeholder", () => {
    render(<ChatPage />);
    expect(screen.getByPlaceholderText(/输入消息/)).toBeDefined();
  });
});
