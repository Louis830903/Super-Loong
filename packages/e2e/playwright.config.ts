import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 冒烟测试配置
 *
 * 仅使用 Chromium，启动 web 前端 dev server。
 * API 服务需单独启动（pnpm dev:api 或 start.bat）。
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? "github" : "list",
  timeout: 30000,
  expect: { timeout: 10000 },

  use: {
    baseURL: "http://localhost:3000",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        // 使用系统安装的 Chrome，避免下载 Chromium 二进制
        channel: "chrome",
      },
    },
  ],

  /**
   * 自动启动 Next.js dev server（假设 API 已运行在后台）。
   * 实际运行 E2E 前，先执行 `pnpm dev:api` 启动后端。
   */
  webServer: {
    command: "cd ..\\web && pnpm dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
    cwd: "..",
  },
});
