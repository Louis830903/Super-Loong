/**
 * 系统监控工具 — 跨平台 CLI-First 封装
 *
 * 5个工具: sys_info / sys_processes / sys_disk / sys_memory / sys_logs
 *
 * 全部为只读工具(🟢 sandboxLevel: "none")
 */

import { z } from "zod";
import os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "system-monitor" });

// ─── sys_info ────────────────────────────────────────────

const sysInfoTool: ToolDefinition = {
  name: "sys_info",
  description: "系统信息概览: OS/CPU/内存/主机名/运行时间。优先使用 Node.js os 模块(零子进程开销)。",
  parameters: z.object({}),
  execute: async (_params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const info = getPlatformInfo();
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const uptime = os.uptime();

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const mins = Math.floor((uptime % 3600) / 60);

    const output = [
      `== 系统信息 ==`,
      `操作系统: ${info.osLabel} ${info.release} (${info.arch})`,
      `主机名: ${os.hostname()}`,
      `Shell: ${info.shell}`,
      `运行时间: ${days}天 ${hours}小时 ${mins}分钟`,
      ``,
      `== CPU ==`,
      `型号: ${cpus[0]?.model ?? "unknown"}`,
      `核心数: ${cpus.length}`,
      ``,
      `== 内存 ==`,
      `总量: ${(totalMem / 1073741824).toFixed(1)} GB`,
      `可用: ${(freeMem / 1073741824).toFixed(1)} GB`,
      `已用: ${((totalMem - freeMem) / 1073741824).toFixed(1)} GB (${(((totalMem - freeMem) / totalMem) * 100).toFixed(0)}%)`,
      ``,
      `WSL: ${info.isWSL ? "是" : "否"}`,
      `Docker: ${info.isDocker ? "是" : "否"}`,
    ].join("\n");

    return { success: true, output };
  },
};

// ─── sys_processes ───────────────────────────────────────

const sysProcessesTool: ToolDefinition = {
  name: "sys_processes",
  description: "进程列表: 显示系统当前运行的进程, 按 CPU/内存 排序。",
  parameters: z.object({
    sortBy: z.enum(["cpu", "memory"]).optional().describe("排序方式: cpu 或 memory, 默认 cpu"),
    count: z.number().optional().describe("显示前N个进程, 默认20"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { sortBy, count } = z.object({
      sortBy: z.enum(["cpu", "memory"]).optional(),
      count: z.number().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const n = count ?? 20;
    const sort = sortBy ?? "cpu";

    let cmd: string;
    switch (info.os) {
      case "darwin":
      case "linux":
        cmd = sort === "cpu"
          ? `ps aux --sort=-%cpu | head -${n + 1}`
          : `ps aux --sort=-%mem | head -${n + 1}`;
        break;
      case "win32":
        cmd = sort === "cpu"
          ? `Get-Process | Sort-Object CPU -Descending | Select-Object -First ${n} Id,ProcessName,CPU,@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json -Depth 2`
          : `Get-Process | Sort-Object WorkingSet -Descending | Select-Object -First ${n} Id,ProcessName,CPU,@{N='MemMB';E={[math]::Round($_.WorkingSet/1MB,1)}} | ConvertTo-Json -Depth 2`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd);
  },
};

// ─── sys_disk ────────────────────────────────────────────

const sysDiskTool: ToolDefinition = {
  name: "sys_disk",
  description: "磁盘使用情况: 显示各分区的容量、已用和可用空间。",
  parameters: z.object({
    path: z.string().optional().describe("指定目录查看详细占用(du), 不指定则显示全局(df)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { path: targetPath } = z.object({ path: z.string().optional() }).parse(params);

    const info = getPlatformInfo();
    let cmd: string;

    if (targetPath) {
      // 指定目录: 使用 du
      cmd = info.os === "win32"
        ? `Get-ChildItem -Path '${targetPath}' -Recurse -File | Measure-Object -Property Length -Sum | Select-Object @{N='Path';E={'${targetPath}'}},Count,@{N='SizeMB';E={[math]::Round($_.Sum/1MB,1)}} | ConvertTo-Json`
        : `du -sh '${targetPath}' 2>/dev/null`;
    } else {
      // 全局: 使用 df
      cmd = info.os === "win32"
        ? "Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{N='UsedGB';E={[math]::Round($_.Used/1GB,1)}},@{N='FreeGB';E={[math]::Round($_.Free/1GB,1)}},@{N='TotalGB';E={[math]::Round(($_.Used+$_.Free)/1GB,1)}} | ConvertTo-Json -Depth 2"
        : "df -h";
    }

    return runShellCmd(cmd);
  },
};

// ─── sys_memory ──────────────────────────────────────────

const sysMemoryTool: ToolDefinition = {
  name: "sys_memory",
  description: "内存使用详情: 物理内存和交换区使用情况。",
  parameters: z.object({}),
  execute: async (_params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "linux":
        cmd = "free -h";
        break;
      case "darwin":
        cmd = "vm_stat && echo '---' && sysctl hw.memsize";
        break;
      case "win32":
        cmd = [
          "$os = Get-CimInstance Win32_OperatingSystem",
          "$totalMB = [math]::Round($os.TotalVisibleMemorySize/1KB,0)",
          "$freeMB = [math]::Round($os.FreePhysicalMemory/1KB,0)",
          "$usedMB = $totalMB - $freeMB",
          "Write-Output \"Total: ${totalMB}MB  Used: ${usedMB}MB  Free: ${freeMB}MB  Usage: $([math]::Round($usedMB/$totalMB*100,1))%\"",
        ].join("; ");
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd);
  },
};

// ─── sys_logs ────────────────────────────────────────────

const sysLogsTool: ToolDefinition = {
  name: "sys_logs",
  description: "系统日志: 查看最近的系统级日志。macOS(log show) / Linux(journalctl) / Windows(Get-EventLog)。",
  parameters: z.object({
    lines: z.number().optional().describe("日志行数, 默认50"),
    since: z.string().optional().describe("起始时间, 如 '1h' 或 '30m'"),
    level: z.enum(["error", "warning", "info"]).optional().describe("日志级别过滤"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { lines, since, level } = z.object({
      lines: z.number().optional(),
      since: z.string().optional(),
      level: z.enum(["error", "warning", "info"]).optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const n = lines ?? 50;

    let cmd: string;
    switch (info.os) {
      case "linux": {
        const parts = ["journalctl", `-n ${n}`, "--no-pager"];
        if (since) parts.push(`--since '${since} ago'`);
        if (level) {
          const priorityMap = { error: "3", warning: "4", info: "6" };
          parts.push(`-p ${priorityMap[level]}`);
        }
        cmd = parts.join(" ");
        break;
      }
      case "darwin":
        cmd = `log show --last ${since ?? "1h"} --style compact | tail -${n}`;
        break;
      case "win32": {
        const logName = level === "error" ? "System" : "Application";
        const entryType = level === "error" ? " -EntryType Error" : level === "warning" ? " -EntryType Warning" : "";
        cmd = `Get-EventLog -LogName ${logName}${entryType} -Newest ${n} | Format-Table -AutoSize | Out-String -Width 200`;
        break;
      }
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd, { timeoutMs: 60_000 });
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const monitorTools: ToolDefinition[] = [
  sysInfoTool,
  sysProcessesTool,
  sysDiskTool,
  sysMemoryTool,
  sysLogsTool,
];
