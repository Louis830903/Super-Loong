/**
 * 屏幕截图与 OCR — 跨平台
 *
 * 2个工具: screen_capture / screen_ocr
 *
 * 跨平台截图:
 * - macOS: screencapture -x
 * - Linux: scrot / gnome-screenshot / import (ImageMagick)
 * - Windows: PowerShell [System.Windows.Forms.Screen]
 *
 * OCR: 调用视觉模型分析截图中的文字
 */

import { z } from "zod";
import path from "node:path";
import os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolContext, ToolResult } from "../../types/index.js";
import { getPlatformInfo } from "../../platform/adapter.js";
import { runShellCmd } from "../run-shell-cmd.js";

const logger = pino({ name: "screen-capture" });

/** 生成唯一截图文件名 */
function generateScreenshotPath(dir?: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `screenshot_${timestamp}.png`;
  return path.join(dir ?? os.tmpdir(), filename);
}

// ─── screen_capture ──────────────────────────────────────

const screenCaptureTool: ToolDefinition = {
  name: "screen_capture",
  description: "屏幕截图: 截取全屏/指定区域/指定窗口。返回截图文件路径和分辨率。",
  parameters: z.object({
    region: z.object({
      x: z.number(), y: z.number(),
      width: z.number(), height: z.number(),
    }).optional().describe("截图区域 {x, y, width, height}, 不指定则全屏"),
    outputDir: z.string().optional().describe("截图保存目录, 默认临时目录"),
    windowTitle: z.string().optional().describe("截取指定窗口(macOS/Linux)"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { region, outputDir, windowTitle } = z.object({
      region: z.object({
        x: z.number(), y: z.number(),
        width: z.number(), height: z.number(),
      }).optional(),
      outputDir: z.string().optional(),
      windowTitle: z.string().optional(),
    }).parse(params);

    const info = getPlatformInfo();
    const filePath = generateScreenshotPath(outputDir);

    let cmd: string;

    switch (info.os) {
      case "darwin":
        if (windowTitle) {
          // 截取指定窗口
          cmd = `screencapture -l $(osascript -e 'tell application "System Events" to get id of first window of (first process whose name contains "${windowTitle}")') '${filePath}'`;
        } else if (region) {
          cmd = `screencapture -x -R${region.x},${region.y},${region.width},${region.height} '${filePath}'`;
        } else {
          cmd = `screencapture -x '${filePath}'`;
        }
        break;

      case "linux":
        if (region) {
          // scrot 区域截图
          cmd = `scrot -a ${region.x},${region.y},${region.width},${region.height} '${filePath}' 2>/dev/null || import -window root -crop ${region.width}x${region.height}+${region.x}+${region.y} '${filePath}'`;
        } else {
          cmd = `scrot '${filePath}' 2>/dev/null || gnome-screenshot -f '${filePath}' 2>/dev/null || import -window root '${filePath}'`;
        }
        break;

      case "win32":
        if (region) {
          cmd = [
            `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
            `$bmp = New-Object Drawing.Bitmap(${region.width},${region.height})`,
            `$g = [Drawing.Graphics]::FromImage($bmp)`,
            `$g.CopyFromScreen(${region.x},${region.y},0,0,$bmp.Size)`,
            `$bmp.Save('${filePath}')`,
            `$g.Dispose(); $bmp.Dispose()`,
          ].join("; ");
        } else {
          cmd = [
            `Add-Type -AssemblyName System.Windows.Forms,System.Drawing`,
            `$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds`,
            `$bmp = New-Object Drawing.Bitmap($screen.Width,$screen.Height)`,
            `$g = [Drawing.Graphics]::FromImage($bmp)`,
            `$g.CopyFromScreen($screen.Location,[Drawing.Point]::Empty,$screen.Size)`,
            `$bmp.Save('${filePath}')`,
            `$g.Dispose(); $bmp.Dispose()`,
          ].join("; ");
        }
        break;

      default:
        return { success: false, output: "不支持的平台" };
    }

    const result = await runShellCmd(cmd, { timeoutMs: 20_000 });

    // 验证文件是否生成
    const fs = require("node:fs") as typeof import("node:fs");
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      return {
        success: true,
        output: `✅ 截图已保存: ${filePath}\n文件大小: ${(stats.size / 1024).toFixed(1)} KB`,
        data: { filePath, sizeBytes: stats.size },
      };
    }

    return { success: false, output: `截图失败: ${result.output}` };
  },
};

// ─── screen_ocr ──────────────────────────────────────────

const screenOcrTool: ToolDefinition = {
  name: "screen_ocr",
  description: "截图文字识别: 截取屏幕并使用视觉模型识别文字内容。需要视觉模型支持。",
  parameters: z.object({
    region: z.object({
      x: z.number(), y: z.number(),
      width: z.number(), height: z.number(),
    }).optional().describe("识别区域, 不指定则全屏"),
    imagePath: z.string().optional().describe("已有截图文件路径(跳过截图步骤)"),
    prompt: z.string().optional().describe("识别提示, 如 '读取表格中的数据' 或 '找到登录按钮的位置'"),
  }),
  execute: async (params: unknown, _ctx: ToolContext): Promise<ToolResult> => {
    const { region, imagePath, prompt } = z.object({
      region: z.object({
        x: z.number(), y: z.number(),
        width: z.number(), height: z.number(),
      }).optional(),
      imagePath: z.string().optional(),
      prompt: z.string().optional(),
    }).parse(params);

    let screenshotPath = imagePath;

    // 如果没有提供图片, 先截图
    if (!screenshotPath) {
      const captureResult = await screenCaptureTool.execute(
        { region },
        _ctx,
      );
      if (!captureResult.success) return captureResult;
      screenshotPath = (captureResult.data as { filePath: string })?.filePath;
    }

    if (!screenshotPath) {
      return { success: false, output: "无法获取截图文件" };
    }

    // 读取图片为 base64
    const fs = require("node:fs") as typeof import("node:fs");
    if (!fs.existsSync(screenshotPath)) {
      return { success: false, output: `截图文件不存在: ${screenshotPath}` };
    }

    const imageBuffer = fs.readFileSync(screenshotPath);
    const base64 = imageBuffer.toString("base64");

    return {
      success: true,
      output: [
        `📷 截图已准备 (${screenshotPath})`,
        `图片大小: ${(imageBuffer.length / 1024).toFixed(1)} KB`,
        ``,
        `⚠️ OCR 需要视觉模型支持。请将此截图发送给视觉模型进行分析。`,
        prompt ? `识别提示: ${prompt}` : "",
      ].filter(Boolean).join("\n"),
      data: {
        filePath: screenshotPath,
        base64Preview: base64.substring(0, 200) + "...",
        sizeBytes: imageBuffer.length,
      },
    };
  },
};

// ─── 导出 ────────────────────────────────────────────────

export const screenTools: ToolDefinition[] = [
  screenCaptureTool,
  screenOcrTool,
];
