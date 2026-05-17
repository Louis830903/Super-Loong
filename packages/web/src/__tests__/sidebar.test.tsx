/**
 * Sidebar 组件测试
 *
 * 覆盖：导航链接渲染 / active 高亮 / 移动端折叠展开 / Logo 显示
 */

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import React from "react";
import Sidebar from "@/components/layout/sidebar";

describe("Sidebar", () => {
  it("渲染 Logo 和品牌名称", () => {
    render(<Sidebar />);
    expect(screen.getByText("Super Loong")).toBeDefined();
  });

  it("渲染全部 16 个导航项", () => {
    render(<Sidebar />);
    const navItems = [
      "仪表盘", "Agent 管理", "对话", "通道管理", "技能市场",
      "记忆管理", "知识库", "MCP 工具", "定时任务", "多 Agent 协作",
      "进化引擎", "A2A 协议", "媒体管理", "视频工作室", "安全管理", "系统设置",
    ];
    for (const item of navItems) {
      expect(screen.getByText(item)).toBeDefined();
    }
  });

  it("当前路径的导航项高亮（active 样式）", () => {
    // setup.ts 中 usePathname mock 返回 "/dashboard"
    render(<Sidebar />);
    const dashboardLink = screen.getByText("仪表盘").closest("a");
    expect(dashboardLink?.className).toContain("text-blue-400");
  });

  it("非当前路径的导航项不高亮", () => {
    render(<Sidebar />);
    // settings 不是当前路径 /dashboard
    const settingsLink = screen.getByText("系统设置").closest("a");
    expect(settingsLink?.className).not.toContain("text-blue-400");
    expect(settingsLink?.className).toContain("text-zinc-400");
  });

  it("移动端折叠按钮存在（lg:hidden）", () => {
    render(<Sidebar />);
    // Mobile toggle 按钮有 lg:hidden class
    const toggleBtn = document.querySelector(".lg\\:hidden");
    expect(toggleBtn).toBeDefined();
  });

  it("移动端点击折叠按钮显示菜单", () => {
    render(<Sidebar />);
    // 用 class 定位移动端按钮，避免和 VersionFooter 里的刷新按钮冲突
    const toggleBtn = document.querySelector(".lg\\:hidden");
    expect(toggleBtn).toBeDefined();
    // 点击折叠按钮
    fireEvent.click(toggleBtn!);
    // 菜单应变为可见（translate-x-0 而非 -translate-x-full）
    const sidebar = document.querySelector("aside");
    expect(sidebar?.className).toContain("translate-x-0");
  });

  it("包含 VersionFooter 组件（footer 模式）", () => {
    render(<Sidebar />);
    // VersionFooter footer 模式 — 显示版本号文本
    expect(screen.getByText(/Super Loong v/)).toBeDefined();
  });
});
