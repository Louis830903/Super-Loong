/**
 * 冒烟测试：页面加载 → 导航 → 核心元素存在性验证
 *
 * 不依赖后端 API，仅验证前端页面渲染和导航功能。
 */
import { test, expect } from "@playwright/test";

test.describe("Smoke — 页面加载与导航", () => {
  test("仪表盘页面加载成功", async ({ page }) => {
    await page.goto("/dashboard");
    // 等待页面渲染完成
    await expect(page.locator("h1")).toContainText(["仪表盘", "Dashboard"]);
    // 版本号显示
    await expect(page.locator('[data-testid="version-display"]')).toBeVisible({
      timeout: 15000,
    });
  });

  test("从仪表盘导航到 Agent 管理", async ({ page }) => {
    await page.goto("/dashboard");
    // 点击导航中的 "Agent 管理"
    await page.locator('[data-testid="nav-agents"]').click();
    await expect(page).toHaveURL(/\/agents/);
    await expect(page.locator("h1")).toContainText("Agent 管理");
  });

  test("从仪表盘导航到对话页", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator('[data-testid="nav-chat"]').click();
    await expect(page).toHaveURL(/\/chat/);
    // 对话页应有标题和输入框
    await expect(page.locator('[data-testid="chat-input"]')).toBeVisible({
      timeout: 15000,
    });
  });

  test("从仪表盘导航到系统设置", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator('[data-testid="nav-settings"]').click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.locator("h1")).toContainText("模型配置");
  });
});
