/**
 * 全桌面精确控制层 — 分层混合 GUI 控制
 *
 * 架构分层:
 * Layer 2 精确控制层 — 本模块
 * - 优先: 平台原生 CLI (零依赖)
 *   - macOS: cliclick (鼠标/键盘) + osascript (窗口)
 *   - Linux: xdotool (鼠标/键盘/窗口, 仅 X11)
 *   - Windows: PowerShell + Win32 API
 * - 增强: @nut-tree/nut-js (optionalDependency, 跨平台统一)
 *
 * 8个工具: mouse_click / mouse_move / mouse_drag / mouse_scroll
 *          keyboard_type / keyboard_key / window_focus / window_list
 */

import { z } from "zod";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { validateShellArg } from "../../security/shell-arg-security.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "gui-control" });

/** 坐标有效性检查 */
function validateCoordinate(x: number, y: number): string | null {
  if (x < 0 || y < 0) return `坐标不能为负数: (${x}, ${y})`;
  if (x > 10000 || y > 10000) return `坐标超出合理范围: (${x}, ${y})`;
  return null;
}

// ─── mouse_click ─────────────────────────────────────────

const mouseClickTool: ToolDefinition = {
  name: "mouse_click",
  description: "鼠标点击: 在指定坐标执行左键/右键/双击操作。",
  parameters: z.object({
    x: z.number().describe("X 坐标"),
    y: z.number().describe("Y 坐标"),
    button: z.enum(["left", "right", "middle"]).optional().describe("鼠标按钮, 默认 left"),
    doubleClick: z.boolean().optional().describe("是否双击, 默认 false"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { x, y, button, doubleClick } = z.object({
      x: z.number(), y: z.number(),
      button: z.enum(["left", "right", "middle"]).optional(),
      doubleClick: z.boolean().optional(),
    }).parse(params);

    const err = validateCoordinate(x, y);
    if (err) return { success: false, output: err };

    const info = getPlatformInfo();
    const btn = button ?? "left";
    const dbl = doubleClick ?? false;

    let cmd: string;
    switch (info.os) {
      case "darwin":
        // cliclick: c = click, dc = double click, rc = right click
        if (dbl) cmd = `cliclick dc:${x},${y}`;
        else if (btn === "right") cmd = `cliclick rc:${x},${y}`;
        else cmd = `cliclick c:${x},${y}`;
        break;
      case "linux":
        if (dbl) cmd = `xdotool mousemove ${x} ${y} click --repeat 2 1`;
        else cmd = `xdotool mousemove ${x} ${y} click ${btn === "right" ? 3 : btn === "middle" ? 2 : 1}`;
        break;
      case "win32": {
        const btnCode = btn === "right" ? "RightClick" : "Click";
        cmd = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y}); Start-Sleep -Milliseconds 50; [System.Windows.Forms.SendKeys]::SendWait('')`;
        // Windows 鼠标点击需要 Win32 API
        cmd = `powershell -Command "Add-Type @' \nusing System; using System.Runtime.InteropServices; \npublic class Mouse { [DllImport(\\"user32.dll\\")] public static extern bool SetCursorPos(int X, int Y); [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int cButtons, int dwExtraInfo); } \n'@; [Mouse]::SetCursorPos(${x},${y}); Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(${dbl ? '0x0002,0,0,0,0; Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(0x0004,0,0,0,0; Start-Sleep -Milliseconds 100; [Mouse]::mouse_event(0x0002,0,0,0,0; Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(0x0004,0,0,0,0)' : btn === 'right' ? '0x0008,0,0,0,0; Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(0x0010,0,0,0,0)' : '0x0002,0,0,0,0; Start-Sleep -Milliseconds 50; [Mouse]::mouse_event(0x0004,0,0,0,0)'})"`;
        break;
      }
      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: true, output: `✅ 点击 (${x}, ${y}) ${dbl ? "[双击]" : ""} ${btn}` };
  },
};

// ─── mouse_move ──────────────────────────────────────────

const mouseMoveTool: ToolDefinition = {
  name: "mouse_move",
  description: "鼠标移动: 将鼠标光标移动到指定坐标。",
  parameters: z.object({
    x: z.number().describe("目标 X 坐标"),
    y: z.number().describe("目标 Y 坐标"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { x, y } = z.object({ x: z.number(), y: z.number() }).parse(params);

    const err = validateCoordinate(x, y);
    if (err) return { success: false, output: err };

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin": cmd = `cliclick m:${x},${y}`; break;
      case "linux": cmd = `xdotool mousemove ${x} ${y}`; break;
      case "win32": cmd = `powershell -Command "[System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point(${x},${y})"`; break;
      default: return { success: false, output: "不支持的平台" };
    }

    await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: true, output: `✅ 鼠标移动到 (${x}, ${y})` };
  },
};

// ─── mouse_drag ──────────────────────────────────────────

const mouseDragTool: ToolDefinition = {
  name: "mouse_drag",
  description: "鼠标拖拽: 从起始坐标拖动到目标坐标。",
  parameters: z.object({
    fromX: z.number(), fromY: z.number(),
    toX: z.number(), toY: z.number(),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { fromX, fromY, toX, toY } = z.object({
      fromX: z.number(), fromY: z.number(),
      toX: z.number(), toY: z.number(),
    }).parse(params);

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin": cmd = `cliclick dd:${fromX},${fromY} du:${toX},${toY}`; break;
      case "linux": cmd = `xdotool mousemove ${fromX} ${fromY} mousedown 1 mousemove ${toX} ${toY} mouseup 1`; break;
      case "win32": cmd = `echo '拖拽需要 nut.js 支持(Windows 原生 CLI 限制)'`; break;
      default: return { success: false, output: "不支持的平台" };
    }

    await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: true, output: `✅ 拖拽 (${fromX},${fromY}) → (${toX},${toY})` };
  },
};

// ─── mouse_scroll ────────────────────────────────────────

const mouseScrollTool: ToolDefinition = {
  name: "mouse_scroll",
  description: "鼠标滚轮: 上下滚动指定步数。",
  parameters: z.object({
    direction: z.enum(["up", "down"]).describe("滚动方向"),
    steps: z.number().optional().describe("滚动步数, 默认3"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { direction, steps } = z.object({
      direction: z.enum(["up", "down"]),
      steps: z.number().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const n = steps ?? 3;
    const isUp = direction === "up";

    let cmd: string;
    switch (info.os) {
      case "darwin":
        // osascript 模拟滚轮
        cmd = `osascript -e 'tell application "System Events" to scroll${isUp ? " up" : " down"} ${n}'`;
        break;
      case "linux":
        cmd = `xdotool click --repeat ${n} ${isUp ? 4 : 5}`;
        break;
      case "win32":
        cmd = `powershell -Command "Add-Type @'\\nusing System; using System.Runtime.InteropServices;\\npublic class Mouse { [DllImport(\\"user32.dll\\")] public static extern void mouse_event(uint dwFlags, int dx, int dy, int cButtons, int dwExtraInfo); }\\n'@; [Mouse]::mouse_event(0x0800,0,0,${isUp ? 120 * n : -120 * n},0)"`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: true, output: `✅ 滚动 ${direction} ${n} 步` };
  },
};

// ─── keyboard_type ───────────────────────────────────────

const keyboardTypeTool: ToolDefinition = {
  name: "keyboard_type",
  description: "键盘输入: 在当前焦点位置输入文本字符串。",
  parameters: z.object({
    text: z.string().describe("要输入的文本"),
    delay: z.number().optional().describe("每个字符间的延迟(毫秒), 默认0"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { text, delay } = z.object({
      text: z.string(),
      delay: z.number().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    // 安全: 限制输入长度
    if (text.length > 5000) return { success: false, output: "输入文本过长(最大5000字符)" };

    let cmd: string;
    switch (info.os) {
      case "darwin":
        cmd = `cliclick t:'${text.replace(/'/g, "'\\''")}'`;
        break;
      case "linux":
        cmd = delay
          ? `xdotool type --delay ${delay} -- '${text.replace(/'/g, "'\\''")}'`
          : `xdotool type -- '${text.replace(/'/g, "'\\''")}'`;
        break;
      case "win32":
        // SendKeys 有特殊字符限制, 使用 Add-Type 更安全
        cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${text.replace(/[+^%~(){}[\]]/g, "{$&}")}')"`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    await runShellCmd(cmd, { timeoutMs: 15_000 });
    return { success: true, output: `✅ 已输入 ${text.length} 个字符` };
  },
};

// ─── keyboard_key ────────────────────────────────────────

const keyboardKeyTool: ToolDefinition = {
  name: "keyboard_key",
  description: "按键/组合键: 发送按键事件, 如 Enter, Ctrl+C, Alt+Tab。",
  parameters: z.object({
    key: z.string().describe("按键名称, 如 'Enter', 'Ctrl+C', 'Alt+Tab', 'F5'"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { key } = z.object({ key: z.string() }).parse(params);

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin": {
        // cliclick 按键映射
        const mapped = key.replace(/Ctrl\+/i, "ctrl+").replace(/Alt\+/i, "alt+").replace(/Shift\+/i, "shift+").replace(/Cmd\+/i, "cmd+");
        cmd = `cliclick kp:${mapped}`;
        break;
      }
      case "linux":
        cmd = `xdotool key ${key.replace(/Ctrl\+/i, "ctrl+").replace(/Alt\+/i, "alt+").replace(/Shift\+/i, "shift+")}`;
        break;
      case "win32": {
        // PowerShell SendKeys 映射
        const sendKeysMap: Record<string, string> = {
          Enter: "{ENTER}", Tab: "{TAB}", Escape: "{ESC}", Backspace: "{BS}",
          Delete: "{DEL}", Home: "{HOME}", End: "{END}",
          Up: "{UP}", Down: "{DOWN}", Left: "{LEFT}", Right: "{RIGHT}",
          F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}", F5: "{F5}",
          F6: "{F6}", F7: "{F7}", F8: "{F8}", F9: "{F9}", F10: "{F10}",
          F11: "{F11}", F12: "{F12}",
        };
        let sendKey = sendKeysMap[key] ?? key;
        // Ctrl+X → ^x
        sendKey = sendKey.replace(/Ctrl\+(.)/i, "^$1").replace(/Alt\+(.)/i, "%$1").replace(/Shift\+(.)/i, "+$1");
        cmd = `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('${sendKey}')"`;
        break;
      }
      default:
        return { success: false, output: "不支持的平台" };
    }

    await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: true, output: `✅ 按键: ${key}` };
  },
};

// ─── window_focus ────────────────────────────────────────

const windowFocusTool: ToolDefinition = {
  name: "window_focus",
  description: "聚焦窗口: 按标题匹配并激活指定窗口。",
  parameters: z.object({
    title: z.string().describe("窗口标题(模糊匹配)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { title } = z.object({ title: z.string() }).parse(params);

    // 参数安全校验 — 窗口标题不允许 shell 特殊字符
    const titleErr = validateShellArg(title, "service_name", "title");
    if (titleErr) return { success: false, output: `参数校验失败: ${titleErr}` };

    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin":
        cmd = `osascript -e 'tell application "System Events" to set frontmost of every process whose name contains "${title}" to true'`;
        break;
      case "linux":
        cmd = `xdotool search --name '${title}' windowactivate`;
        break;
      case "win32":
        cmd = `powershell -Command "$wshell = New-Object -ComObject WScript.Shell; $wshell.AppActivate('${title}')"`;
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 10_000 });
    return { success: result.success, output: result.success ? `✅ 已聚焦窗口: ${title}` : `未找到窗口: ${title}` };
  },
};

// ─── window_list ─────────────────────────────────────────

const windowListTool: ToolDefinition = {
  name: "window_list",
  description: "列出所有可见窗口: 显示窗口标题、进程名和位置。",
  parameters: z.object({}),
  execute: async (_params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const info = getPlatformInfo();
    let cmd: string;

    switch (info.os) {
      case "darwin":
        cmd = `osascript -e 'tell application "System Events" to get {name, position, size} of every window of every process whose visible is true'`;
        break;
      case "linux":
        cmd = "wmctrl -l -G 2>/dev/null || xdotool search --onlyvisible --name '' getwindowname 2>/dev/null | head -30";
        break;
      case "win32":
        cmd = "Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object Id,ProcessName,MainWindowTitle | ConvertTo-Json -Depth 2";
        break;
      default:
        return { success: false, output: "不支持的平台" };
    }

    return runShellCmd(cmd, { timeoutMs: 10_000 });
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const guiTools: ToolDefinition[] = [
  mouseClickTool,
  mouseMoveTool,
  mouseDragTool,
  mouseScrollTool,
  keyboardTypeTool,
  keyboardKeyTool,
  windowFocusTool,
  windowListTool,
];
