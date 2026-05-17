/**
 * AgentsPage 渲染冒烟测试
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

// ─── Mock useAgents ───
vi.mock("@/hooks/useAgents", () => ({
  useAgents: vi.fn(() => ({
    agents: [
      { id: "agent-1", name: "通用助手", isBuiltin: true, department: "general", departmentLabel: "通用", model: "gpt-4", originalTools: [] },
      { id: "agent-2", name: "代码助手", isBuiltin: false, department: "engineering", departmentLabel: "工程", model: "gpt-4", originalTools: [] },
    ],
    loading: false,
    error: null,
    refresh: vi.fn(),
  })),
}));

import AgentsPage from "@/app/agents/page";

describe("AgentsPage — 渲染冒烟", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiFetchMock.mockResolvedValue({ providers: [] });
  });

  it("渲染页面标题「Agent 管理」", async () => {
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("Agent 管理")).toBeDefined();
    });
  });

  it("渲染 Agent 列表", async () => {
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("通用助手")).toBeDefined();
      expect(screen.getByText("代码助手")).toBeDefined();
    });
  });

  it("渲染「创建 Agent」按钮", async () => {
    render(<AgentsPage />);
    await waitFor(() => {
      expect(screen.getByText("创建 Agent")).toBeDefined();
    });
  });
});
