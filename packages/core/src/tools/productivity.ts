/**
 * Productivity Tools — todo_manage / timer_set / clipboard_copy / env_info × 4（同步加载）。
 *
 * - todo_manage: 内存 TodoStore + merge/replace 双模式（对标 Hermes TodoStore）
 * - timer_set: setTimeout 后台提醒
 * - clipboard_copy: 平台检测 clip.exe / pbcopy / xclip（spawnSync 参数数组防注入）
 * - env_info: 系统环境信息聚合
 */

import { z } from "zod";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";

const logger = pino({ name: "productivity" });

// ── TodoStore 内存实现（对标 Hermes todo_tool.py） ──

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "done" | "cancelled";
}

const VALID_STATUSES = new Set(["pending", "in_progress", "done", "cancelled"]);
const MAX_TODO_ITEMS = 1000;

class TodoStore {
  private items: TodoItem[] = [];

  /** 验证并规范化单个 todo */
  private validate(todo: TodoItem): TodoItem {
    return {
      id: String(todo.id || `todo_${Date.now()}`),
      content: String(todo.content || ""),
      status: VALID_STATUSES.has(todo.status) ? todo.status : "pending",
    };
  }

  /** 按 id 去重，保留最后出现的（对标 Hermes _dedupe_by_id） */
  private dedupeById(todos: TodoItem[]): TodoItem[] {
    const seen = new Map<string, TodoItem>();
    for (const t of todos) seen.set(t.id, t);
    return [...seen.values()];
  }

  /** 写入任务列表 */
  write(todos: TodoItem[], merge: boolean): TodoItem[] {
    const validated = todos.map(t => this.validate(t));
    if (!merge) {
      // replace 模式：全量替换
      this.items = this.dedupeById(validated);
    } else {
      // merge 模式：按 id 更新已有项，追加新项
      const existing = new Map(this.items.map(t => [t.id, t]));
      for (const todo of validated) {
        existing.set(todo.id, { ...existing.get(todo.id), ...todo });
      }
      this.items = [...existing.values()];
    }
    // 容量上限防护
    if (this.items.length > MAX_TODO_ITEMS) {
      this.items = this.items.slice(-MAX_TODO_ITEMS);
    }
    return this.read();
  }

  /** 读取任务列表（返回浅复制） */
  read(): TodoItem[] {
    return this.items.map(t => ({ ...t }));
  }
}

// 全局单例（会话级生命周期）
const _todoStore = new TodoStore();

// ── 工具定义 ────────────────────────────────────

/** todo_manage — 待办事项管理 */
const todoManageTool: ToolDefinition = {
  name: "todo_manage",
  description:
    "管理待办事项列表。write 操作更新任务列表（merge=true 按 id 合并，merge=false 全量替换），" +
    "read 操作返回当前全部任务。每个任务包含 id/content/status 字段。" +
    "status 可选: pending / in_progress / done / cancelled。",
  parameters: z.object({
    action: z.enum(["write", "read"]).describe("write=写入/更新, read=读取全部"),
    todos: z.array(z.object({
      id: z.string().describe("任务唯一标识"),
      content: z.string().describe("任务描述"),
      status: z.enum(["pending", "in_progress", "done", "cancelled"]).describe("任务状态"),
    })).optional().describe("write 时传入任务列表"),
    merge: z.boolean().default(true).describe("true=按id合并更新, false=全量替换"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { action, todos, merge } = params as {
      action: "write" | "read"; todos?: TodoItem[]; merge: boolean;
    };

    if (action === "write") {
      if (!todos || todos.length === 0) {
        return { success: false, output: "write 操作需要提供 todos 列表", error: "missing todos" };
      }
      const result = _todoStore.write(todos, merge);
      const summary = result.map(t => `[${t.status}] ${t.id}: ${t.content}`).join("\n");
      return {
        success: true,
        output: `✅ 任务列表已更新（${result.length} 项）\n${summary}`,
        data: { count: result.length, items: result },
      };
    }

    // read
    const items = _todoStore.read();
    if (items.length === 0) {
      return { success: true, output: "当前没有待办事项", data: { count: 0, items: [] } };
    }
    const summary = items.map(t => `[${t.status}] ${t.id}: ${t.content}`).join("\n");
    return {
      success: true,
      output: `待办事项（${items.length} 项）：\n${summary}`,
      data: { count: items.length, items },
    };
  },
};

// ── timer_set ────────────────────────────────────

/** 活跃 timer 管理（上限 50 个，支持取消） */
const MAX_TIMERS = 50;
const _activeTimers = new Map<string, NodeJS.Timeout>();

/** timer_set — 设置倒计时提醒 */
const timerSetTool: ToolDefinition = {
  name: "timer_set",
  description: "设置倒计时提醒。到时后会在控制台输出通知。返回 timer_id 用于查询。",
  parameters: z.object({
    seconds: z.number().min(1).max(86400).describe("倒计时秒数（1-86400）"),
    label: z.string().describe("提醒标签/描述"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { seconds, label } = params as { seconds: number; label: string };

    // 上限检查
    if (_activeTimers.size >= MAX_TIMERS) {
      return { success: false, output: `已达到计时器上限（${MAX_TIMERS} 个），请等待现有计时器到期`, error: "max_timers" };
    }

    const timerId = `timer_${Date.now()}`;

    const handle = setTimeout(() => {
      _activeTimers.delete(timerId);
      logger.info({ timerId, label }, `⏰ 计时器到期: ${label}`);
      console.log(`\n⏰ [Timer] ${label} — ${seconds}秒计时结束！\n`);
    }, seconds * 1000);

    _activeTimers.set(timerId, handle);

    const minutes = seconds >= 60 ? `（${(seconds / 60).toFixed(1)} 分钟）` : "";
    return {
      success: true,
      output: `✅ 计时器已设置：${label}\n⏱️ ${seconds} 秒后提醒${minutes}\nID: ${timerId}`,
      data: { timerId, seconds, label },
    };
  },
};

// ── clipboard_copy ──────────────────────────────

/** clipboard_copy — 复制文本到系统剪贴板（spawnSync 参数数组防注入） */
const clipboardCopyTool: ToolDefinition = {
  name: "clipboard_copy",
  description: "复制文本到系统剪贴板。支持 Windows/macOS/Linux。",
  parameters: z.object({
    text: z.string().describe("要复制的文本内容"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { text } = params as { text: string };
    const platform = process.platform;

    try {
      let result;
      if (platform === "win32") {
        // Windows: 通过 stdin 传入文本到 clip.exe（避免命令注入）
        result = spawnSync("clip", [], { input: text, timeout: 5000, stdio: ["pipe", "ignore", "pipe"] });
      } else if (platform === "darwin") {
        result = spawnSync("pbcopy", [], { input: text, timeout: 5000, stdio: ["pipe", "ignore", "pipe"] });
      } else {
        // Linux: 依次尝试 xclip → xsel → wl-copy
        const tools: Array<[string, string[]]> = [
          ["xclip", ["-selection", "clipboard"]],
          ["xsel", ["--clipboard", "--input"]],
          ["wl-copy", []],
        ];
        let success = false;
        for (const [cmd, args] of tools) {
          const r = spawnSync(cmd, args, { input: text, timeout: 5000, stdio: ["pipe", "ignore", "pipe"] });
          if (!r.error && r.status === 0) {
            success = true;
            break;
          }
        }
        if (!success) {
          return { success: false, output: "未找到可用的剪贴板工具（需要 xclip/xsel/wl-copy）", error: "no_clipboard_tool" };
        }
        return {
          success: true,
          output: `✅ 已复制 ${text.length} 个字符到剪贴板`,
          data: { length: text.length },
        };
      }

      if (result?.error) throw result.error;
      if (result?.status !== 0) {
        return { success: false, output: `剪贴板命令退出码: ${result?.status}`, error: "clipboard_error" };
      }
      return {
        success: true,
        output: `✅ 已复制 ${text.length} 个字符到剪贴板`,
        data: { length: text.length },
      };
    } catch (err: any) {
      return { success: false, output: `复制到剪贴板失败: ${err.message}`, error: err.message };
    }
  },
};

// ── env_info ─────────────────────────────────────

/** env_info — 获取系统环境信息 */
const envInfoTool: ToolDefinition = {
  name: "env_info",
  description: "获取当前系统环境信息：操作系统、CPU、内存、Node.js 版本等。",
  parameters: z.object({
    detail: z.boolean().default(false).describe("是否返回详细信息（CPU 核心详情、环境变量子集）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { detail } = params as { detail: boolean };

    const info: Record<string, unknown> = {
      platform: os.platform(),
      arch: os.arch(),
      hostname: os.hostname(),
      release: os.release(),
      nodeVersion: process.version,
      cwd: process.cwd(),
      uptime: `${(os.uptime() / 3600).toFixed(1)} hours`,
      totalMemory: `${(os.totalmem() / (1024 * 1024 * 1024)).toFixed(1)} GB`,
      freeMemory: `${(os.freemem() / (1024 * 1024 * 1024)).toFixed(1)} GB`,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model || "unknown",
      homeDir: os.homedir(),
      tmpDir: os.tmpdir(),
      shell: process.env.SHELL || process.env.COMSPEC || "unknown",
    };

    if (detail) {
      // 安全子集：不暴露敏感环境变量
      const safeEnvKeys = ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TERM", "EDITOR", "NODE_ENV"];
      const envSubset: Record<string, string> = {};
      for (const key of safeEnvKeys) {
        if (process.env[key]) envSubset[key] = process.env[key]!;
      }
      info.env = envSubset;
      info.cpuDetails = os.cpus().map(c => `${c.model} @ ${c.speed}MHz`);
      info.networkInterfaces = Object.keys(os.networkInterfaces());
    }

    const lines = Object.entries(info).map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: ${v.join(", ")}`;
      if (typeof v === "object" && v !== null) return `${k}: ${JSON.stringify(v)}`;
      return `${k}: ${v}`;
    });

    return {
      success: true,
      output: `系统环境信息：\n${lines.join("\n")}`,
      data: info,
    };
  },
};

export const productivityTools: ToolDefinition[] = [todoManageTool, timerSetTool, clipboardCopyTool, envInfoTool];
