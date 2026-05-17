/**
 * Vitest 配置 — API 集成测试
 *
 * 策略：
 * - forks 池避免 SQLite 文件锁竞态（与 core 配置一致）
 * - 30s timeout 覆盖 LLM 调用超时场景
 * - better-sqlite3 需要 deps.inline 处理原生模块
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 15000,
    pool: "forks",
    server: {
      deps: {
        inline: ["better-sqlite3"],
      },
    },
  },
});
