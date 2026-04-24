/**
 * 包管理工具 — CLI-First 封装
 *
 * 5个工具: pkg_install / pkg_update / pkg_audit / pkg_outdated / pkg_search
 *
 * 自动检测包管理器: npm/pnpm/yarn/pip/brew
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { runShellCmd } from "../run-shell-cmd.js";
import { hasBinary } from "../../platform/cli-detector.js";

const logger = pino({ name: "package-manage" });

/** 检测项目使用的包管理器 */
function detectPkgManager(cwd?: string): string {
  const fs = require("node:fs") as typeof import("node:fs");
  const path = require("node:path") as typeof import("node:path");
  const dir = cwd ?? process.cwd();
  const hasFile = (name: string) => { try { return fs.existsSync(path.join(dir, name)); } catch { return false; } };

  if (hasFile("pnpm-lock.yaml")) return "pnpm";
  if (hasFile("yarn.lock")) return "yarn";
  if (hasFile("package-lock.json") || hasFile("package.json")) return "npm";
  if (hasFile("requirements.txt") || hasFile("pyproject.toml")) return "pip";
  if (hasBinary("brew")) return "brew";
  return "npm"; // 默认回退
}

// ─── pkg_install ─────────────────────────────────────────

const pkgInstallTool: ToolDefinition = {
  name: "pkg_install",
  description: "安装依赖包。自动检测包管理器(npm/pnpm/yarn/pip/brew)。",
  parameters: z.object({
    packages: z.array(z.string()).optional().describe("要安装的包名列表, 为空则安装所有依赖"),
    dev: z.boolean().optional().describe("作为开发依赖安装, 默认false"),
    cwd: z.string().optional().describe("项目目录"),
    manager: z.string().optional().describe("强制指定包管理器"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { packages, dev, cwd, manager } = z.object({
      packages: z.array(z.string()).optional(),
      dev: z.boolean().optional(),
      cwd: z.string().optional(),
      manager: z.string().optional(),
    }).parse(params);

    const pm = manager ?? detectPkgManager(cwd);
    const pkgs = packages?.join(" ") ?? "";

    let cmd: string;
    switch (pm) {
      case "pnpm": cmd = pkgs ? `pnpm add ${dev ? "-D " : ""}${pkgs}` : "pnpm install"; break;
      case "yarn": cmd = pkgs ? `yarn add ${dev ? "--dev " : ""}${pkgs}` : "yarn install"; break;
      case "npm":  cmd = pkgs ? `npm install ${dev ? "--save-dev " : ""}${pkgs}` : "npm install"; break;
      case "pip":  cmd = pkgs ? `pip install ${pkgs}` : "pip install -r requirements.txt"; break;
      case "brew": cmd = `brew install ${pkgs}`; break;
      default: return { success: false, output: `不支持的包管理器: ${pm}` };
    }

    return runShellCmd(cmd, { cwd, timeoutMs: 300_000 });
  },
};

// ─── pkg_update ──────────────────────────────────────────

const pkgUpdateTool: ToolDefinition = {
  name: "pkg_update",
  description: "更新依赖包到最新版本。",
  parameters: z.object({
    packages: z.array(z.string()).optional().describe("要更新的包名列表, 为空则更新全部"),
    cwd: z.string().optional().describe("项目目录"),
    manager: z.string().optional().describe("强制指定包管理器"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { packages, cwd, manager } = z.object({
      packages: z.array(z.string()).optional(),
      cwd: z.string().optional(),
      manager: z.string().optional(),
    }).parse(params);

    const pm = manager ?? detectPkgManager(cwd);
    const pkgs = packages?.join(" ") ?? "";

    let cmd: string;
    switch (pm) {
      case "pnpm": cmd = pkgs ? `pnpm update ${pkgs}` : "pnpm update"; break;
      case "yarn": cmd = pkgs ? `yarn upgrade ${pkgs}` : "yarn upgrade"; break;
      case "npm":  cmd = pkgs ? `npm update ${pkgs}` : "npm update"; break;
      case "pip":  cmd = pkgs ? `pip install --upgrade ${pkgs}` : "pip install --upgrade -r requirements.txt"; break;
      case "brew": cmd = pkgs ? `brew upgrade ${pkgs}` : "brew upgrade"; break;
      default: return { success: false, output: `不支持的包管理器: ${pm}` };
    }

    return runShellCmd(cmd, { cwd, timeoutMs: 300_000 });
  },
};

// ─── pkg_audit ───────────────────────────────────────────

const pkgAuditTool: ToolDefinition = {
  name: "pkg_audit",
  description: "安全审计: 检查依赖中的已知安全漏洞。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    manager: z.string().optional().describe("强制指定包管理器"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, manager } = z.object({
      cwd: z.string().optional(),
      manager: z.string().optional(),
    }).parse(params);

    const pm = manager ?? detectPkgManager(cwd);

    let cmd: string;
    switch (pm) {
      case "pnpm": cmd = "pnpm audit"; break;
      case "yarn": cmd = "yarn audit"; break;
      case "npm":  cmd = "npm audit"; break;
      case "pip":  cmd = "pip audit 2>/dev/null || pip check"; break;
      default: return { success: false, output: `${pm} 不支持安全审计` };
    }

    // audit 退出码非 0 可能只是发现了漏洞, 仍返回输出
    const result = await runShellCmd(cmd, { cwd, timeoutMs: 120_000 });
    return { ...result, success: true };
  },
};

// ─── pkg_outdated ────────────────────────────────────────

const pkgOutdatedTool: ToolDefinition = {
  name: "pkg_outdated",
  description: "检查过期依赖: 列出可更新的包。",
  parameters: z.object({
    cwd: z.string().optional().describe("项目目录"),
    manager: z.string().optional().describe("强制指定包管理器"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { cwd, manager } = z.object({
      cwd: z.string().optional(),
      manager: z.string().optional(),
    }).parse(params);

    const pm = manager ?? detectPkgManager(cwd);

    let cmd: string;
    switch (pm) {
      case "pnpm": cmd = "pnpm outdated"; break;
      case "yarn": cmd = "yarn outdated"; break;
      case "npm":  cmd = "npm outdated"; break;
      case "pip":  cmd = "pip list --outdated"; break;
      case "brew": cmd = "brew outdated"; break;
      default: return { success: false, output: `${pm} 不支持过期检查` };
    }

    const result = await runShellCmd(cmd, { cwd, timeoutMs: 120_000 });
    return { ...result, success: true };
  },
};

// ─── pkg_search ──────────────────────────────────────────

const pkgSearchTool: ToolDefinition = {
  name: "pkg_search",
  description: "搜索包: 在包注册表中搜索可用的包。",
  parameters: z.object({
    query: z.string().describe("搜索关键词"),
    manager: z.string().optional().describe("包管理器: npm/pip/brew"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { query, manager } = z.object({
      query: z.string(),
      manager: z.string().optional(),
    }).parse(params);

    const pm = manager ?? "npm";

    let cmd: string;
    switch (pm) {
      case "npm":  cmd = `npm search ${query} --json | head -c 5000`; break;
      case "pip":  cmd = `pip index versions ${query} 2>/dev/null || pip search ${query} 2>/dev/null || echo 'pip search 已被禁用, 请访问 pypi.org'`; break;
      case "brew": cmd = `brew search ${query}`; break;
      default: return { success: false, output: `${pm} 不支持搜索` };
    }

    return runShellCmd(cmd, { timeoutMs: 120_000 });
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const packageTools: ToolDefinition[] = [
  pkgInstallTool,
  pkgUpdateTool,
  pkgAuditTool,
  pkgOutdatedTool,
  pkgSearchTool,
];
