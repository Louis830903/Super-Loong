/**
 * 版本显示 E2E 冒烟测试
 */
import { test, expect } from "@playwright/test";

test.describe("Version Display", () => {
  test("仪表盘显示非空版本号", async ({ page }) => {
    await page.goto("/dashboard");

    const versionEl = page.locator('[data-testid="version-display"]');
    await expect(versionEl).toBeVisible({ timeout: 15000 });

    const text = await versionEl.textContent();
    expect(text).toBeTruthy();
    // 版本号格式: "Super Loong vX.Y.Z"
    expect(text).toMatch(/Super Loong/);
  });

  test("Agent 管理页也显示版本号", async ({ page }) => {
    await page.goto("/agents");

    const versionEl = page.locator('[data-testid="version-display"]');
    await expect(versionEl).toBeVisible({ timeout: 15000 });
  });
});
