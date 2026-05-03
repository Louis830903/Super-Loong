/**
 * 测试与构建工具 — CLI-First 封装
 *
 * 5个工具: test_run / test_watch / build_run / build_dev / lint_run
 *
 * 自动检测测试框架和构建工具
 */

import { z } from "zod";
import { spawn } from "node:child_process";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { buildShellArgs } from "../../platform/adapter.js";
import { runShellCmd } from "../run-shell-cmd.js";
import { buildIsolatedEnv } from "../../security/env-isolation.js";
import { registerProcess, pollProcess } from "../process-registry.js";

const logger = pino({ name: "test-build" });

// ─── 通用辅助 ──────────────────────────────────────────

/** 后台执行命令, 返回进程 ID */
function runBackground(command: string, cwd?: string): ToolResult {
  const [exe, args] = buildShellArgs(command);
  const child = spawn(exe, args, {
    cwd: cwd ?? undefined,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: buildIsolatedEnv(),  // 安全：过滤子进程环境变量，阻止敏感密钥泄漏
  });

  const sessionId = registerProcess(command, child, cwd ?? process.cwd());
  child.unref();

  return {
    success: true,
    output: `🚀 后台任务已启动\n进程ID: ${sessionId}\n命令: ${command}\n使用 process_poll 查看输出`,
    data: { sessionId },
  };
}

/** 自动检测测试命令 */
function detectTestCmd(cwd?: string): string | null {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = cwd ?? process.cwd();
  const hasFile = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };

  if (hasFile("vitest.config.ts") || hasFile("vitest.config.js")) return "npx vitest run";
  if (hasFile("jest.config.ts") || hasFile("jest.config.js") || hasFile("jest.config.cjs")) return "npx jest";
  if (hasFile("pytest.ini") || hasFile("conftest.py")) return "pytest";
  if (hasFile("Cargo.toml")) return "cargo test";
  if (hasFile("go.mod")) return "go test ./...";

  // 检查 package.json scripts
  if (hasFile("package.json")) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
      if (pkg.scripts?.test) return "npm test";
    } catch { /* ignore */ }
  }

  return null;
}

// ─── test_run ────────────────────────────────────────────

const testRunTool: ToolDefinition = {
  name: "test_run",
  description: "运行测试: 自动检测测试框架(vitest/jest/pytest/cargo test)并执行。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    command: z.string().optional().describe("自定义测试命令"),
    file: z.string().optional().describe("指定测试文件"),
    filter: z.string().optional().describe("测试名称过滤"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, command, file, filter } = z.object({
      cwd: z.string().optional(),
      command: z.string().optional(),
      file: z.string().optional(),
      filter: z.string().optional(),
    }).parse(params);

    let cmd = command ?? detectTestCmd(cwd);
    if (!cmd) return { success: false, output: "无法自动检测测试框架, 请指定 command 参数" };

    if (file) cmd += ` ${file}`;
    if (filter) cmd += ` --grep '${filter}'`;

    return runShellCmd(cmd, { cwd, timeoutMs: 300_000 });
  },
};

// ─── test_watch ──────────────────────────────────────────

const testWatchTool: ToolDefinition = {
  name: "test_watch",
  description: "监视模式运行测试: 文件变更时自动重新执行。后台运行。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    command: z.string().optional().describe("自定义测试命令"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, command } = z.object({
      cwd: z.string().optional(),
      command: z.string().optional(),
    }).parse(params);

    let cmd = command;
    if (!cmd) {
      const baseCmd = detectTestCmd(cwd);
      if (!baseCmd) return { success: false, output: "无法自动检测测试框架" };
      // 大多数测试框架支持 --watch 参数
      cmd = baseCmd.replace(" run", "") + " --watch";
    }

    return runBackground(cmd, cwd);
  },
};

// ─── build_run ───────────────────────────────────────────

const buildRunTool: ToolDefinition = {
  name: "build_run",
  description: "执行构建: 自动检测构建工具(vite/webpack/tsc/cargo/go)并执行生产构建。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    command: z.string().optional().describe("自定义构建命令"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, command } = z.object({
      cwd: z.string().optional(),
      command: z.string().optional(),
    }).parse(params);

    if (command) return runShellCmd(command, { cwd, timeoutMs: 300_000 });

    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = cwd ?? process.cwd();
    const hasFile = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };

    // 检查 package.json build script
    if (hasFile("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        const pm = hasFile("pnpm-lock.yaml") ? "pnpm" : hasFile("yarn.lock") ? "yarn" : "npm";
        if (pkg.scripts?.build) return runShellCmd(`${pm} run build`, { cwd, timeoutMs: 300_000 });
      } catch { /* ignore */ }
    }
    if (hasFile("Cargo.toml")) return runShellCmd("cargo build --release", { cwd, timeoutMs: 300_000 });
    if (hasFile("go.mod")) return runShellCmd("go build ./...", { cwd, timeoutMs: 300_000 });
    if (hasFile("Makefile")) return runShellCmd("make", { cwd, timeoutMs: 300_000 });

    return { success: false, output: "无法自动检测构建工具, 请指定 command 参数" };
  },
};

// ─── build_dev ───────────────────────────────────────────

const buildDevTool: ToolDefinition = {
  name: "build_dev",
  description: "启动开发服务器: 后台运行, 支持热重载。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    command: z.string().optional().describe("自定义开发服务器命令"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, command } = z.object({
      cwd: z.string().optional(),
      command: z.string().optional(),
    }).parse(params);

    if (command) return runBackground(command, cwd);

    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = cwd ?? process.cwd();
    const hasFile = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };

    if (hasFile("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        const pm = hasFile("pnpm-lock.yaml") ? "pnpm" : hasFile("yarn.lock") ? "yarn" : "npm";
        if (pkg.scripts?.dev) return runBackground(`${pm} run dev`, cwd);
        if (pkg.scripts?.start) return runBackground(`${pm} start`, cwd);
      } catch { /* ignore */ }
    }

    return { success: false, output: "无法自动检测开发服务器命令, 请指定 command 参数" };
  },
};

// ─── lint_run ────────────────────────────────────────────

const lintRunTool: ToolDefinition = {
  name: "lint_run",
  description: "代码检查: 运行 linter (ESLint/Prettier/Ruff/Clippy 等)。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    command: z.string().optional().describe("自定义 lint 命令"),
    fix: z.boolean().optional().describe("自动修复, 默认false"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, command, fix } = z.object({
      cwd: z.string().optional(),
      command: z.string().optional(),
      fix: z.boolean().optional(),
    }).parse(params);

    if (command) return runShellCmd(command, { cwd, timeoutMs: 180_000 });

    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const dir = cwd ?? process.cwd();
    const hasFile = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };

    // 检查 package.json lint script
    if (hasFile("package.json")) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf-8"));
        if (pkg.scripts?.lint) {
          const pm = hasFile("pnpm-lock.yaml") ? "pnpm" : "npm";
          return runShellCmd(`${pm} run lint${fix ? " -- --fix" : ""}`, { cwd, timeoutMs: 180_000 });
        }
      } catch { /* ignore */ }

      // 直接检测 eslint
      if (hasFile(".eslintrc.js") || hasFile(".eslintrc.json") || hasFile("eslint.config.js") || hasFile("eslint.config.mjs")) {
        return runShellCmd(`npx eslint .${fix ? " --fix" : ""}`, { cwd, timeoutMs: 180_000 });
      }
    }

    if (hasFile("ruff.toml") || hasFile(".ruff.toml") || hasFile("pyproject.toml")) {
      return runShellCmd(`ruff check .${fix ? " --fix" : ""}`, { cwd, timeoutMs: 180_000 });
    }
    if (hasFile("Cargo.toml")) {
      return runShellCmd("cargo clippy", { cwd, timeoutMs: 180_000 });
    }

    return { success: false, output: "无法自动检测 linter, 请指定 command 参数" };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const testBuildTools: ToolDefinition[] = [
  testRunTool,
  testWatchTool,
  buildRunTool,
  buildDevTool,
  lintRunTool,
];
