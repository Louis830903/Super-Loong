/**
 * Computer Use Loop — 视觉推理层
 *
 * 这是能力天花板的关键: 当 Agent 面对未知界面时,
 * 通过「截屏→推理→行动→截屏」循环自主操作任意 GUI。
 *
 * 核心流程:
 * 1. screen_capture() → 截取全屏
 * 2. 发送截图 + 目标描述给视觉模型 → "在微信中找到xx群并点击"
 * 3. 视觉模型返回: { action: 'mouse_click', coordinate: [342, 567] }
 * 4. gui-control 执行: mouse_click(342, 567)
 * 5. 等待 1-2秒 → 回到步骤 1
 * 6. 循环直到: 目标完成 / 最大步数(20步) / 用户中断
 *
 * 安全约束:
 * - 最大循环步数限制(默认 20 步)
 * - 每步操作前截屏存档(可追溯)
 * - Feature Flag SUPER_AGENT_COMPUTER_USE=true 单独控制
 *
 * ⚠️ 本设计为原创方案, 工作区内无参考实现
 */

import { z } from "zod";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";

const logger = pino({ name: "computer-use" });

// ─── 类型定义 ──────────────────────────────────────────

interface GUIAction {
  type: "mouse_click" | "mouse_move" | "mouse_drag" | "keyboard_type" | "keyboard_key" | "scroll" | "wait" | "done";
  coordinate?: [number, number];
  text?: string;
  key?: string;
  direction?: "up" | "down";
  reason?: string;
}

interface StepRecord {
  step: number;
  screenshotPath: string;
  action: GUIAction;
  timestamp: number;
}

// ─── Computer Use Loop 主工具 ────────────────────────────

const computerUseTool: ToolDefinition = {
  name: "computer_use",
  description: [
    "Computer Use Loop: 视觉推理驱动的GUI自动化。",
    "接收自然语言目标, 通过截屏→视觉推理→执行操作的循环自主操作任意GUI应用。",
    "适用场景: Agent不知道界面布局时, 需要视觉模型辅助定位和操作。",
    "⚠️ 每步消耗约500-1000 tokens(截图分析), 适合简短操作流程。",
  ].join("\n"),
  parameters: z.object({
    goal: z.string().describe("自然语言目标, 如 '打开微信发送消息给xxx'"),
    maxSteps: z.number().optional().describe("最大步数, 默认20"),
    stepDelay: z.number().optional().describe("每步等待时间(毫秒), 默认1500"),
    screenshotDir: z.string().optional().describe("截图存档目录, 默认临时目录"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { goal, maxSteps, stepDelay, screenshotDir } = z.object({
      goal: z.string(),
      maxSteps: z.number().optional(),
      stepDelay: z.number().optional(),
      screenshotDir: z.string().optional(),
    }).parse(params);

    const max = Math.min(maxSteps ?? 20, 50); // 硬限制 50 步
    const delay = stepDelay ?? 1500;
    const ssDir = screenshotDir ?? path.join(os.tmpdir(), "computer-use");

    // 确保截图目录存在
    const fs = require("node:fs") as typeof import("node:fs");
    fs.mkdirSync(ssDir, { recursive: true });

    const steps: StepRecord[] = [];
    const screenshots: string[] = [];

    // 动态导入桌面工具（避免循环依赖）
    let screenCapture: ToolDefinition;
    let guiTools: ToolDefinition[];

    try {
      const screenMod = await import("./screen-capture.js");
      screenCapture = screenMod.screenTools[0]; // screen_capture
      const guiMod = await import("./gui-control.js");
      guiTools = guiMod.guiTools;
    } catch (err: any) {
      return {
        success: false,
        output: `Computer Use 依赖模块加载失败: ${err.message}\n需要 screen-capture 和 gui-control 模块可用`,
      };
    }

    logger.info({ goal, maxSteps: max }, "Computer Use Loop 开始");

    // ── 单步截图 + 提示 ──
    // 当前版本是 "Agent 外部循环" 模式: 每次调用只执行一步(截图+提示),
    // 由 Agent 主循环分析截图后决定下一步操作。
    // 未来增强: 内置视觉模型调用, 实现自主多步循环。
    const step = steps.length + 1;

    // 1. 截图
    const captureResult = await screenCapture.execute(
      { outputDir: ssDir },
      _ctx,
    );
    if (!captureResult.success) {
      return {
        success: false,
        output: `步骤 ${step}: 截图失败 — ${captureResult.output}`,
        data: { steps, screenshots },
      };
    }

    const ssPath = (captureResult.data as { filePath?: string })?.filePath ?? "";
    screenshots.push(ssPath);

    // 2. 视觉推理 — 返回需要执行的动作
    const analysisPrompt = [
      `目标: ${goal}`,
      `当前步骤: ${step}/${max}`,
      `截图路径: ${ssPath}`,
      "",
      "请分析截图并返回下一步操作, 格式为 JSON:",
      '{ "type": "mouse_click", "coordinate": [x, y], "reason": "点击xxx按钮" }',
      '{ "type": "keyboard_type", "text": "要输入的文本", "reason": "在输入框中输入" }',
      '{ "type": "keyboard_key", "key": "Enter", "reason": "确认输入" }',
      '{ "type": "scroll", "direction": "down", "reason": "向下滚动查看更多" }',
      '{ "type": "wait", "reason": "等待页面加载" }',
      '{ "type": "done", "reason": "目标已完成" }',
    ].join("\n");

    return {
      success: true,
      output: [
        `🖥️ Computer Use — 步骤 ${step}/${max}`,
        `目标: ${goal}`,
        `截图: ${ssPath}`,
        "",
        "⚠️ 视觉推理模式:",
        "当前版本需要你(Agent)分析截图并决定下一步操作。",
        "请查看截图后, 使用对应的 GUI 工具(mouse_click/keyboard_type等)执行操作,",
        "然后再次调用 computer_use 继续下一步。",
        "",
        analysisPrompt,
      ].join("\n"),
      data: {
        step,
        maxSteps: max,
        screenshotPath: ssPath,
        screenshots,
        goal,
      },
    };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const computerUseTools: ToolDefinition[] = [
  computerUseTool,
];
