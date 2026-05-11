/**
 * 系统服务管理工具 — 跨平台 CLI-First 封装
 *
 * 4个工具: service_status / service_control / service_logs / cron_manage
 *
 * 跨平台策略:
 * - macOS: launchctl + ~/Library/LaunchAgents/
 * - Linux: systemctl + journalctl
 * - Windows: Get-Service / Start-Service / Stop-Service (PowerShell)
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo, getCommand } from "../../platform/adapter.js";
import { validateShellArg } from "../../security/shell-arg-security.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "service-manage" });

// ─── service_status ──────────────────────────────────────

const serviceStatusTool: ToolDefinition = {
  name: "service_status",
  description: "查看系统服务状态。跨平台支持: macOS(launchctl) / Linux(systemctl) / Windows(Get-Service)。",
  parameters: z.object({
    service: z.string().optional().describe("服务名称, 不指定则列出所有服务"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { service } = z.object({ service: z.string().optional() }).parse(params);

    let cmd: string | null;
    if (service) {
      cmd = getCommand("service_status", service);
    } else {
      cmd = getCommand("service_list");
    }

    if (!cmd) {
      return { success: false, output: "当前平台不支持服务管理命令" };
    }

    return runShellCmd(cmd);
  },
};

// ─── service_control ─────────────────────────────────────

const serviceControlTool: ToolDefinition = {
  name: "service_control",
  description: "控制系统服务: 启动/停止/重启。需要相应权限。",
  parameters: z.object({
    service: z.string().describe("服务名称"),
    action: z.enum(["start", "stop", "restart"]).describe("操作: start/stop/restart"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { service, action } = z.object({
      service: z.string(),
      action: z.enum(["start", "stop", "restart"]),
    }).parse(params);

    const cmdKey = `service_${action}`;
    let cmd = getCommand(cmdKey, service);

    // 部分平台命令映射可能未定义 restart, 用 stop + start 模拟
    if (!cmd && action === "restart") {
      const stopCmd = getCommand("service_stop", service);
      const startCmd = getCommand("service_start", service);
      if (stopCmd && startCmd) {
        const info = getPlatformInfo();
        const sep = info.os === "win32" ? "; " : " && ";
        cmd = `${stopCmd}${sep}${startCmd}`;
      }
    }

    if (!cmd) {
      return { success: false, output: `当前平台不支持服务 ${action} 操作` };
    }

    return runShellCmd(cmd, { timeoutMs: 60_000 });
  },
};

// ─── service_logs ────────────────────────────────────────

const serviceLogsTool: ToolDefinition = {
  name: "service_logs",
  description: "查看系统服务日志。macOS(log show) / Linux(journalctl) / Windows(Get-EventLog)。",
  parameters: z.object({
    service: z.string().describe("服务名称"),
    lines: z.number().optional().describe("日志行数, 默认50"),
    since: z.string().optional().describe("起始时间, 如 '1h' 或 '30m'"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { service, lines, since } = z.object({
      service: z.string(),
      lines: z.number().optional(),
      since: z.string().optional(),
    }).parse(params);

    // 参数安全校验
    const svcErr = validateShellArg(service, "service_name", "service");
    if (svcErr) return { success: false, output: `参数校验失败: ${svcErr}` };
    if (since) {
      const sinceErr = validateShellArg(since, "time_duration", "since");
      if (sinceErr) return { success: false, output: `参数校验失败: ${sinceErr}` };
    }

    const info = getPlatformInfo();
    const n = lines ?? 50;
    let cmd: string;

    switch (info.os) {
      case "linux":
        cmd = `journalctl -u ${service} -n ${n}${since ? ` --since '${since} ago'` : ""} --no-pager`;
        break;
      case "darwin":
        cmd = `log show --predicate 'subsystem == "${service}"' --last ${since ?? "1h"} --style compact | tail -${n}`;
        break;
      case "win32":
        cmd = `Get-EventLog -LogName Application -Source '${service}' -Newest ${n} | ConvertTo-Json -Depth 2`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd, { timeoutMs: 60_000 });
  },
};

// ─── cron_manage ─────────────────────────────────────────

const cronManageTool: ToolDefinition = {
  name: "cron_manage",
  description: "定时任务管理: 列出/添加/删除 cron 任务。Linux(crontab) / macOS(launchctl) / Windows(schtasks)。",
  parameters: z.object({
    action: z.enum(["list", "add", "remove"]).describe("操作: list/add/remove"),
    schedule: z.string().optional().describe("cron 表达式(add时), 如 '0 */6 * * *'"),
    command: z.string().optional().describe("要执行的命令(add时)"),
    name: z.string().optional().describe("任务名称(Windows schtasks 用, 或 remove 时指定)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { action, schedule, command, name } = z.object({
      action: z.enum(["list", "add", "remove"]),
      schedule: z.string().optional(),
      command: z.string().optional(),
      name: z.string().optional(),
    }).parse(params);

    const info = getPlatformInfo();

    if (action === "list") {
      switch (info.os) {
        case "linux":
        case "darwin":
          return runShellCmd("crontab -l 2>/dev/null || echo '无 cron 任务'");
        case "win32":
          return runShellCmd("schtasks /Query /FO CSV");
        default:
          return { success: false, output: "不支持的平台" };
      }
    }

    if (action === "add") {
      if (!schedule || !command) {
        return { success: false, output: "add 操作需要 schedule 和 command 参数" };
      }
      // 参数安全校验 — 防止 shell 注入
      const schedErr = validateShellArg(schedule, "cron_expr", "schedule");
      if (schedErr) return { success: false, output: `参数校验失败: ${schedErr}` };
      const cmdErr = validateShellArg(command, "shell_safe", "command");
      if (cmdErr) return { success: false, output: `参数校验失败: ${cmdErr}` };
      switch (info.os) {
        case "linux":
        case "darwin":
          return runShellCmd(`(crontab -l 2>/dev/null; echo '${schedule} ${command}') | crontab -`);
        case "win32": {
          const taskName = name ?? `sa_task_${Date.now()}`;
          return runShellCmd(`schtasks /Create /SC DAILY /TN "${taskName}" /TR "${command}" /F`);
        }
        default:
          return { success: false, output: "不支持的平台" };
      }
    }

    // remove
    if (!name && !command) {
      return { success: false, output: "remove 操作需要 name 或 command 参数" };
    }
    // 参数安全校验
    const rmTarget = command ?? name!;
    const rmErr = validateShellArg(rmTarget, "shell_safe", "name/command");
    if (rmErr) return { success: false, output: `参数校验失败: ${rmErr}` };
    switch (info.os) {
      case "linux":
      case "darwin":
        return runShellCmd(`crontab -l 2>/dev/null | grep -v '${command ?? name}' | crontab -`);
      case "win32":
        return runShellCmd(`schtasks /Delete /TN "${name}" /F`);
      default:
        return { success: false, output: "不支持的平台" };
    }
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const serviceTools: ToolDefinition[] = [
  serviceStatusTool,
  serviceControlTool,
  serviceLogsTool,
  cronManageTool,
];
