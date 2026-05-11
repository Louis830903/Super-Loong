/**
 * 应用控制工具 — 跨平台
 *
 * 4个工具: app_launch / app_quit / app_list / app_switch (底层调用 window_focus)
 *
 * 跨平台 CLI 映射:
 * - macOS: osascript (AppleScript) + open -a
 * - Linux: xdg-open + wmctrl + xdotool
 * - Windows: Start-Process / Stop-Process / Get-Process
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { validateShellArg } from "../../security/shell-arg-security.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "app-control" });

// ─── app_launch ──────────────────────────────────────────

const appLaunchTool: ToolDefinition = {
  name: "app_launch",
  description: "启动应用程序。macOS(open -a) / Linux(xdg-open) / Windows(Start-Process)。",
  parameters: z.object({
    app: z.string().describe("应用名称或路径, 如 'Safari', 'code', 'notepad'"),
    args: z.array(z.string()).optional().describe("启动参数"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { app, args: appArgs } = z.object({
      app: z.string(),
      args: z.array(z.string()).optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const extraArgs = appArgs?.join(" ") ?? "";

    // 参数安全校验 — app 名称不允许 shell 特殊字符
    const appErr = validateShellArg(app, "service_name", "app");
    if (appErr) return { success: false, output: `参数校验失败: ${appErr}` };

    let cmd: string;
    switch (info.os) {
      case "darwin":
        cmd = extraArgs
          ? `open -a '${app}' --args ${extraArgs}`
          : `open -a '${app}'`;
        break;
      case "linux":
        cmd = extraArgs ? `${app} ${extraArgs} &` : `${app} &`;
        break;
      case "win32":
        cmd = extraArgs
          ? `Start-Process '${app}' -ArgumentList '${extraArgs}'`
          : `Start-Process '${app}'`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 15_000 });
    return {
      success: true,
      output: `✅ 已启动应用: ${app}${extraArgs ? ` (参数: ${extraArgs})` : ""}`,
    };
  },
};

// ─── app_quit ────────────────────────────────────────────

const appQuitTool: ToolDefinition = {
  name: "app_quit",
  description: "退出应用程序。优先优雅退出, 可选强制关闭。",
  parameters: z.object({
    app: z.string().describe("应用名称或进程名"),
    force: z.boolean().optional().describe("是否强制关闭, 默认false(优雅退出)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { app, force } = z.object({
      app: z.string(),
      force: z.boolean().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    let cmd: string;

    // 参数安全校验 — app 名称不允许 shell 特殊字符
    const appErr = validateShellArg(app, "service_name", "app");
    if (appErr) return { success: false, output: `参数校验失败: ${appErr}` };

    switch (info.os) {
      case "darwin":
        cmd = force
          ? `pkill -9 -f '${app}'`
          : `osascript -e 'tell application "${app}" to quit'`;
        break;
      case "linux":
        cmd = force
          ? `pkill -9 -f '${app}'`
          : `pkill -f '${app}'`;
        break;
      case "win32":
        cmd = force
          ? `Stop-Process -Name '${app}' -Force -ErrorAction SilentlyContinue`
          : `Stop-Process -Name '${app}' -ErrorAction SilentlyContinue`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 15_000 });
    return {
      success: true,
      output: `✅ 已${force ? "强制关闭" : "退出"}应用: ${app}`,
    };
  },
};

// ─── app_list ────────────────────────────────────────────

const appListTool: ToolDefinition = {
  name: "app_list",
  description: "列出运行中的应用程序(仅包含有窗口的GUI应用)。",
  parameters: z.object({}),
  execute: async (_params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin":
        cmd = `osascript -e 'tell application "System Events" to get name of every process whose background only is false'`;
        break;
      case "linux":
        cmd = "wmctrl -l 2>/dev/null || xdotool search --onlyvisible --name '' getwindowname 2>/dev/null | sort -u | head -30";
        break;
      case "win32":
        cmd = "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName,MainWindowTitle | Sort-Object ProcessName -Unique | ConvertTo-Json -Depth 2";
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd, { timeoutMs: 15_000 });
  },
};

// ─── app_switch ──────────────────────────────────────────

// app_switch 底层复用 window_focus 逻辑
const appSwitchTool: ToolDefinition = {
  name: "app_switch",
  description: "切换到指定应用(聚焦其窗口)。内部调用 window_focus。",
  parameters: z.object({
    app: z.string().describe("应用名称"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { app } = z.object({ app: z.string() }).parse(params);

    // 参数安全校验 — app 名称不允许 shell 特殊字符
    const appErr = validateShellArg(app, "service_name", "app");
    if (appErr) return { success: false, output: `参数校验失败: ${appErr}` };

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin":
        cmd = `osascript -e 'tell application "${app}" to activate'`;
        break;
      case "linux":
        cmd = `xdotool search --name '${app}' windowactivate`;
        break;
      case "win32":
        cmd = `powershell -Command "$wshell = New-Object -ComObject WScript.Shell; $wshell.AppActivate('${app}')"`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 15_000 });
    return {
      success: result.success,
      output: result.success ? `✅ 已切换到应用: ${app}` : `未找到应用: ${app}\n${result.output}`,
    };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const appTools: ToolDefinition[] = [
  appLaunchTool,
  appQuitTool,
  appListTool,
  appSwitchTool,
];
