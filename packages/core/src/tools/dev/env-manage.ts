/**
 * 环境管理工具 — CLI-First 封装
 *
 * 4个工具: env_create / env_activate / env_dotenv / env_port
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "env-manage" });

// ─── env_create ──────────────────────────────────────────

const envCreateTool: ToolDefinition = {
  name: "env_create",
  description: "创建虚拟环境: Python venv 或 Node nvm/fnm 管理。",
  parameters: z.object({
    type: z.enum(["python", "node"]).describe("环境类型: python(venv) / node(nvm)"),
    path: z.string().optional().describe("虚拟环境路径(Python时), 默认 .venv"),
    version: z.string().optional().describe("Node 版本(node类型时), 如 '20' 或 'lts'"),
    cwd: z.string().optional().describe("项目目录"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { type, path: envPath, version, cwd } = z.object({
      type: z.enum(["python", "node"]),
      path: z.string().optional(),
      version: z.string().optional(),
      cwd: z.string().optional(),
    }).parse(params);

    if (type === "python") {
      const venvPath = envPath ?? ".venv";
      return runShellCmd(`python3 -m venv ${venvPath}`, { cwd });
    }

    // Node 版本管理
    if (!version) return { success: false, output: "Node 类型需要指定 version 参数" };
    // 尝试 fnm → nvm
    const fnmResult = await runShellCmd(`fnm install ${version}`, { cwd });
    if (fnmResult.success) return fnmResult;
    return runShellCmd(`nvm install ${version}`, { cwd });
  },
};

// ─── env_activate ────────────────────────────────────────

const envActivateTool: ToolDefinition = {
  name: "env_activate",
  description: "激活虚拟环境: 显示激活命令(spawn-per-call 模型下无法持久激活, 返回指引)。",
  parameters: z.object({
    type: z.enum(["python", "node"]).describe("环境类型"),
    path: z.string().optional().describe("虚拟环境路径(Python), 默认 .venv"),
    version: z.string().optional().describe("Node 版本"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { type, path: envPath, version } = z.object({
      type: z.enum(["python", "node"]),
      path: z.string().optional(),
      version: z.string().optional(),
    }).parse(params);

    const info = getPlatformInfo();

    if (type === "python") {
      const venvPath = envPath ?? ".venv";
      const activateCmd = info.os === "win32"
        ? `${venvPath}\\Scripts\\activate`
        : `source ${venvPath}/bin/activate`;

      // spawn-per-call 无法持久化环境, 给出指引
      const pythonBin = info.os === "win32"
        ? `${venvPath}\\Scripts\\python.exe`
        : `${venvPath}/bin/python`;

      return {
        success: true,
        output: [
          `Python 虚拟环境激活指引:`,
          `手动激活: ${activateCmd}`,
          ``,
          `提示: 由于每条命令独立进程, 使用 terminal 执行时`,
          `应使用虚拟环境内的 Python 路径: ${pythonBin}`,
          `例如: ${pythonBin} -m pip install xxx`,
        ].join("\n"),
      };
    }

    // Node
    return {
      success: true,
      output: [
        `Node 版本切换指引:`,
        `fnm use ${version ?? "lts"}`,
        `或: nvm use ${version ?? "lts"}`,
      ].join("\n"),
    };
  },
};

// ─── env_dotenv ──────────────────────────────────────────

const envDotenvTool: ToolDefinition = {
  name: "env_dotenv",
  description: ".env 文件管理: 读取/设置/删除环境变量。自动脱敏敏感值。",
  parameters: z.object({
    action: z.enum(["read", "set", "delete"]).describe("操作: read/set/delete"),
    file: z.string().optional().describe(".env 文件路径, 默认 .env"),
    key: z.string().optional().describe("变量名(set/delete时)"),
    value: z.string().optional().describe("变量值(set时)"),
    cwd: z.string().optional().describe("项目目录"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { action, file, key, value, cwd } = z.object({
      action: z.enum(["read", "set", "delete"]),
      file: z.string().optional(),
      key: z.string().optional(),
      value: z.string().optional(),
      cwd: z.string().optional(),
    }).parse(params);

    const fs = require("node:fs") as typeof import("node:fs");
    const pathMod = require("node:path") as typeof import("node:path");
    const envFile = pathMod.resolve(cwd ?? process.cwd(), file ?? ".env");

    if (action === "read") {
      try {
        const content = fs.readFileSync(envFile, "utf-8");
        // 脱敏: 对含 KEY/TOKEN/SECRET/PASSWORD 的值只显示前4个字符
        const redacted = content.replace(
          /^(.*(?:KEY|TOKEN|SECRET|PASSWORD|PASS)[^=]*)=(.{4})(.+)$/gmi,
          "$1=$2****",
        );
        return { success: true, output: redacted || "(空文件)" };
      } catch {
        return { success: false, output: `.env 文件不存在: ${envFile}` };
      }
    }

    if (!key) return { success: false, output: `${action} 操作需要 key 参数` };

    if (action === "set") {
      if (value === undefined) return { success: false, output: "set 操作需要 value 参数" };

      let content = "";
      try { content = fs.readFileSync(envFile, "utf-8"); } catch { /* 新文件 */ }

      const regex = new RegExp(`^${key}=.*$`, "m");
      const newLine = `${key}=${value}`;

      if (regex.test(content)) {
        content = content.replace(regex, newLine);
      } else {
        content = content.trim() ? `${content.trim()}\n${newLine}\n` : `${newLine}\n`;
      }

      fs.writeFileSync(envFile, content, "utf-8");
      return { success: true, output: `✅ ${key} 已设置` };
    }

    // delete
    try {
      let content = fs.readFileSync(envFile, "utf-8");
      const regex = new RegExp(`^${key}=.*\n?`, "m");
      content = content.replace(regex, "");
      fs.writeFileSync(envFile, content, "utf-8");
      return { success: true, output: `✅ ${key} 已删除` };
    } catch {
      return { success: false, output: `.env 文件不存在: ${envFile}` };
    }
  },
};

// ─── env_port ────────────────────────────────────────────

const envPortTool: ToolDefinition = {
  name: "env_port",
  description: "端口管理: 检查端口是否被占用, 或释放占用端口的进程。",
  parameters: z.object({
    port: z.number().describe("端口号"),
    action: z.enum(["check", "kill"]).optional().describe("操作: check(检查) / kill(释放), 默认check"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { port, action } = z.object({
      port: z.number(),
      action: z.enum(["check", "kill"]).optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const act = action ?? "check";

    if (act === "check") {
      let cmd: string;
      switch (info.os) {
        case "darwin": cmd = `lsof -i :${port} -P -n`; break;
        case "linux": cmd = `ss -tlnp sport = :${port}`; break;
        case "win32": cmd = `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ConvertTo-Json`; break;
        default: return { success: false, output: "不支持的平台" };
      }

      const result = await runShellCmd(cmd);
      if (!result.output.trim()) {
        return { success: true, output: `✅ 端口 ${port} 未被占用` };
      }
      return { success: true, output: `端口 ${port} 占用情况:\n${result.output}` };
    }

    // kill: 释放端口
    let cmd: string;
    switch (info.os) {
      case "darwin": cmd = `lsof -ti :${port} | xargs kill -9 2>/dev/null`; break;
      case "linux": cmd = `fuser -k ${port}/tcp 2>/dev/null`; break;
      case "win32": cmd = `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }`; break;
      default: return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd);
    return { success: true, output: `端口 ${port} 已释放\n${result.output}`.trim() };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const envManageTools: ToolDefinition[] = [
  envCreateTool,
  envActivateTool,
  envDotenvTool,
  envPortTool,
];
