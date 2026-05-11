/**
 * 部署执行工具 — CLI-First 封装
 *
 * 5个工具: deploy_git_pull / deploy_build / deploy_restart / deploy_rollback / deploy_healthcheck
 *
 * 部署工具链: git pull → build → restart → healthcheck
 * 安全: 写入操作使用 sandboxLevel: "process"
 */

import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { validateShellArg } from "../../security/shell-arg-security.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "deploy-execute" });

// ─── deploy_git_pull ─────────────────────────────────────

const deployGitPullTool: ToolDefinition = {
  name: "deploy_git_pull",
  description: "拉取最新代码: 在指定目录执行 git pull。支持指定分支和 remote。",
  parameters: z.object({
    workdir: z.string().describe("项目根目录路径"),
    remote: z.string().optional().describe("远程名称, 默认 origin"),
    branch: z.string().optional().describe("分支名称, 默认当前分支"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { workdir, remote, branch } = z.object({
      workdir: z.string(),
      remote: z.string().optional(),
      branch: z.string().optional(),
    }).parse(params);

    const r = remote ?? "origin";

    // 参数安全校验 — 防止 shell 注入
    const remoteErr = validateShellArg(r, "service_name", "remote");
    if (remoteErr) return { success: false, output: `参数校验失败: ${remoteErr}` };
    if (branch) {
      const branchErr = validateShellArg(branch, "git_ref", "branch");
      if (branchErr) return { success: false, output: `参数校验失败: ${branchErr}` };
    }

    const cmd = branch
      ? `git pull ${r} ${branch} --no-edit`
      : `git pull ${r} --no-edit`;

    return runShellCmd(cmd, { cwd: workdir });
  },
};

// ─── deploy_build ────────────────────────────────────────

const deployBuildTool: ToolDefinition = {
  name: "deploy_build",
  description: "执行构建命令: 自动检测项目类型(Node/Python/Go/Rust)或使用自定义命令。",
  parameters: z.object({
    workdir: z.string().describe("项目根目录路径"),
    command: z.string().optional().describe("自定义构建命令, 不指定则自动检测"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { workdir, command } = z.object({
      workdir: z.string(),
      command: z.string().optional(),
    }).parse(params);

    // 如果指定了自定义命令, 直接使用
    if (command) {
      return runShellCmd(command, { cwd: workdir, timeoutMs: 300_000 });
    }

    // 自动检测项目类型 (使用顶层静态 import 的 fs/path，兼容 ESM)

    const hasFile = (name: string) => {
      try { return fs.existsSync(path.join(workdir, name)); } catch { return false; }
    };

    let buildCmd: string;
    if (hasFile("package.json")) {
      // Node.js 项目: 优先 pnpm → npm
      const lockfile = hasFile("pnpm-lock.yaml") ? "pnpm" : hasFile("yarn.lock") ? "yarn" : "npm";
      buildCmd = `${lockfile} run build`;
    } else if (hasFile("pyproject.toml") || hasFile("setup.py")) {
      buildCmd = "pip install -e .";
    } else if (hasFile("go.mod")) {
      buildCmd = "go build ./...";
    } else if (hasFile("Cargo.toml")) {
      buildCmd = "cargo build --release";
    } else if (hasFile("Makefile")) {
      buildCmd = "make";
    } else {
      return { success: false, output: "无法自动检测项目类型, 请指定 command 参数" };
    }

    logger.info({ workdir, buildCmd }, "自动检测构建命令");
    return runShellCmd(buildCmd, { cwd: workdir, timeoutMs: 300_000 });
  },
};

// ─── deploy_restart ──────────────────────────────────────

const deployRestartTool: ToolDefinition = {
  name: "deploy_restart",
  description: "重启服务: 通过 pm2/systemctl/docker 等重启应用服务。",
  parameters: z.object({
    service: z.string().describe("服务名称"),
    method: z.enum(["pm2", "systemctl", "docker", "custom"]).optional().describe("重启方式, 不指定则自动检测"),
    command: z.string().optional().describe("自定义重启命令(method=custom时)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { service, method, command } = z.object({
      service: z.string(),
      method: z.enum(["pm2", "systemctl", "docker", "custom"]).optional(),
      command: z.string().optional(),
    }).parse(params);

    if (method === "custom" && command) {
      return runShellCmd(command, { timeoutMs: 60_000 });
    }

    // 参数安全校验 — service 名称不允许 shell 特殊字符
    const svcErr = validateShellArg(service, "service_name", "service");
    if (svcErr) return { success: false, output: `参数校验失败: ${svcErr}` };

    const m = method ?? "systemctl";
    let cmd: string;

    switch (m) {
      case "pm2":
        cmd = `pm2 restart ${service}`;
        break;
      case "systemctl":
        cmd = `systemctl restart ${service}`;
        break;
      case "docker":
        cmd = `docker restart ${service}`;
        break;
      default:
        return { success: false, output: `不支持的重启方式: ${m}` };
    }

    return runShellCmd(cmd, { timeoutMs: 60_000 });
  },
};

// ─── deploy_rollback ─────────────────────────────────────

const deployRollbackTool: ToolDefinition = {
  name: "deploy_rollback",
  description: "回滚到指定版本: 使用 git checkout 或 git revert 回滚到指定 commit/tag。",
  parameters: z.object({
    workdir: z.string().describe("项目根目录路径"),
    target: z.string().describe("目标版本: commit hash / tag / HEAD~N"),
    method: z.enum(["checkout", "revert"]).optional().describe("回滚方式: checkout(硬回滚) / revert(安全回滚), 默认 checkout"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { workdir, target, method } = z.object({
      workdir: z.string(),
      target: z.string(),
      method: z.enum(["checkout", "revert"]).optional(),
    }).parse(params);

    const m = method ?? "checkout";

    // 参数安全校验 — target 必须是合法的 git ref
    const targetErr = validateShellArg(target, "git_ref", "target");
    if (targetErr) return { success: false, output: `参数校验失败: ${targetErr}` };

    const cmd = m === "revert"
      ? `git revert --no-edit ${target}`
      : `git checkout ${target}`;

    return runShellCmd(cmd, { cwd: workdir });
  },
};

// ─── deploy_healthcheck ──────────────────────────────────

const deployHealthcheckTool: ToolDefinition = {
  name: "deploy_healthcheck",
  description: "部署后健康检查: 通过 HTTP 请求验证服务是否正常运行。",
  parameters: z.object({
    url: z.string().describe("健康检查 URL, 如 http://localhost:3000/health"),
    expectedStatus: z.number().optional().describe("期望的 HTTP 状态码, 默认200"),
    retries: z.number().optional().describe("重试次数, 默认3"),
    interval: z.number().optional().describe("重试间隔(秒), 默认5"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { url, expectedStatus, retries, interval } = z.object({
      url: z.string(),
      expectedStatus: z.number().optional(),
      retries: z.number().optional(),
      interval: z.number().optional(),
    }).parse(params);

    const expected = expectedStatus ?? 200;
    const maxRetries = retries ?? 3;
    const waitSec = interval ?? 5;

    // 参数安全校验 — url 不允许 shell 特殊字符
    const urlErr = validateShellArg(url, "url", "url");
    if (urlErr) return { success: false, output: `参数校验失败: ${urlErr}` };

    for (let i = 0; i <= maxRetries; i++) {
      if (i > 0) {
        // 等待间隔
        await new Promise((r) => setTimeout(r, waitSec * 1000));
      }

      const result = await runShellCmd(
        `curl -sS -o /dev/null -w '%{http_code}' '${url}'`,
        { timeoutMs: 15_000 },
      );

      const statusCode = parseInt(result.output.trim(), 10);
      if (statusCode === expected) {
        return {
          success: true,
          output: `✅ 健康检查通过 (${url}): HTTP ${statusCode} (第${i + 1}次尝试)`,
        };
      }

      logger.info({ url, statusCode, attempt: i + 1 }, "健康检查未通过, 重试中...");
    }

    return {
      success: false,
      output: `❌ 健康检查失败 (${url}): 经过 ${maxRetries + 1} 次尝试, 未获得 HTTP ${expected}`,
    };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const deployTools: ToolDefinition[] = [
  deployGitPullTool,
  deployBuildTool,
  deployRestartTool,
  deployRollbackTool,
  deployHealthcheckTool,
];
