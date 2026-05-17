/**
 * Agent 页面 E2E 冒烟测试
 */
import { test, expect } from "@playwright/test";

test.describe("Agents Page", () => {
  test("导航到 Agent 页面并验证卡片列表", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator('[data-testid="nav-agents"]').click();
    await expect(page).toHaveURL(/\/agents/);

    // 验证至少有一个 Agent 卡片渲染
    const cards = page.locator('[data-testid^="agent-card-"]');
    await expect(cards.first()).toBeVisible({ timeout: 15000 });
    const count = await cards.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test("Agent 页面渲染「创建 Agent」按钮", async ({ page }) => {
    await page.goto("/agents");
    await expect(page.getByText("创建 Agent")).toBeVisible({ timeout: 15000 });
  });
});
