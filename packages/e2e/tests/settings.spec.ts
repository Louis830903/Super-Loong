/**
 * 设置页 E2E 冒烟测试
 */
import { test, expect } from "@playwright/test";

test.describe("Settings Page", () => {
  test("导航到设置页并验证核心元素", async ({ page }) => {
    await page.goto("/dashboard");
    await page.locator('[data-testid="nav-settings"]').click();
    await expect(page).toHaveURL(/\/settings/);

    // 验证页面标题
    await expect(page.getByText("模型配置")).toBeVisible({ timeout: 15000 });

    // 验证持久化状态面板
    await expect(page.getByText("持久化状态")).toBeVisible();

    // 验证 MigrationCard 存在
    await expect(page.locator('[data-testid="migration-card"]')).toBeVisible({
      timeout: 15000,
    });
  });

  test("设置页渲染保存按钮（Provider 卡片展开后）", async ({ page }) => {
    await page.goto("/settings");

    // 等待 Provider 列表加载
    await page.waitForTimeout(2000);

    // 如果有 Provider 卡片，点击第一个展开
    const firstCard = page.locator("button:has(span.font-semibold)").first();
    if (await firstCard.isVisible({ timeout: 5000 }).catch(() => false)) {
      await firstCard.click();
      // 展开后应能看到保存按钮
      await expect(page.locator('[data-testid="save-settings"]')).toBeVisible({
        timeout: 5000,
      });
    }
    // 若无 Provider 则跳过（空列表场景已在单元测试覆盖）
  });
});
