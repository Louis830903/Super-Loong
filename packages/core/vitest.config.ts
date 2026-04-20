import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 15000,
    pool: "forks",
    // Allow access to node built-ins
    server: { deps: { inline: ["sql.js"] } },
  },
});
