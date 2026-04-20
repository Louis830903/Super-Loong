/**
 * Vision 分析模块 — 截图 + LLM 视觉分析
 *
 * 参考 Hermes vision API：
 * - 截图 → Base64 → LLM 视觉分析
 * - 可访问性树快照 → 超长时 LLM 摘要
 */

import pino from "pino";
import { readFileSync } from "node:fs";
import type { VisionAnalysisResult, BrowserProvider } from "./types.js";

const logger = pino({ name: "browser-vision" });

/**
 * 对当前页面执行视觉分析。
 *
 * 1. 截图
 * 2. 将截图转为 Base64
 * 3. 调用 LLM 视觉能力分析页面内容
 *
 * @param provider - 浏览器 Provider
 * @param query - 分析查询（如"找到登录按钮"）
 * @param llmCall - LLM 调用函数（由外部注入，避免循环依赖）
 */
export async function analyzePageVision(
  provider: BrowserProvider,
  query: string,
  llmCall?: (prompt: string, imageBase64?: string) => Promise<string>,
): Promise<VisionAnalysisResult> {
  // 截图
  const screenshot = await provider.screenshot({ fullPage: false });
  const screenshotPath = screenshot.path;

  if (!llmCall) {
    // 无 LLM 可用时，返回基础信息
    return {
      description: `截图已保存到 ${screenshotPath}（${(screenshot.size / 1024).toFixed(1)} KB）。LLM 视觉分析不可用。`,
      screenshotPath,
    };
  }

  try {
    // 读取截图为 Base64
    const imageBuffer = readFileSync(screenshotPath);
    const imageBase64 = imageBuffer.toString("base64");

    // 调用 LLM 视觉分析
    const prompt = [
      "请分析这个网页截图，回答以下问题：",
      query,
      "",
      "请用中文回答，简洁明了。",
    ].join("\n");

    const analysis = await llmCall(prompt, imageBase64);

    return {
      description: analysis,
      screenshotPath,
    };
  } catch (err) {
    logger.error({ err }, "Vision 分析失败");
    return {
      description: `Vision 分析失败。截图已保存到 ${screenshotPath}`,
      screenshotPath,
    };
  }
}

/**
 * 快照摘要 — 当可访问性快照超长时使用 LLM 生成摘要。
 *
 * 参考 Hermes：超过 8000 字符时自动摘要。
 */
export async function summarizeSnapshot(
  snapshotText: string,
  llmCall?: (prompt: string) => Promise<string>,
  maxLength = 8000,
): Promise<string> {
  if (snapshotText.length <= maxLength || !llmCall) {
    return snapshotText.slice(0, maxLength);
  }

  try {
    const prompt = [
      "以下是一个网页的无障碍树快照，请提取关键结构信息，生成简洁的页面摘要：",
      "",
      snapshotText.slice(0, 12000),
      "",
      "请用中文输出，保留重要的交互元素（按钮、链接、输入框、标题）。",
    ].join("\n");

    return await llmCall(prompt);
  } catch {
    return snapshotText.slice(0, maxLength);
  }
}
