/**
 * Browser Tools — Playwright 浏览器自动化 × 6
 * （browser_navigate / browser_snapshot / browser_click / browser_type / browser_screenshot / browser_close）。
 *
 * 三级浏览器发现策略：
 *   ① 远程 WebSocket 连接（BROWSER_WS_ENDPOINT）
 *   ② 用户指定路径（BROWSER_PATH）
 *   ③ 自动探测 Edge → Chrome → Brave
 *
 * Playwright channel 优先：探测到 Edge/Chrome 时使用 channel 参数。
 */

import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import { getConfigStore } from "./config-store.js";

const logger = pino({ name: "browser-tools" });

// ── Playwright 延迟加载 ──────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _pw: any = null;

async function getPlaywright(): Promise<any> {
  if (_pw) return _pw;
  try {
    // 动态模块名避免 TypeScript 静态解析
    const moduleName = "playwright";
    _pw = await import(moduleName);
    return _pw;
  } catch {
    throw new Error(
      "playwright 未安装。请执行: pnpm add playwright\n" +
      "注意：不需要下载 Chromium，工具会自动探测本地已安装的浏览器。"
    );
  }
}

// ── 浏览器配置读取 ──────────────────────────────

interface BrowserConfig {
  browserPath: string;
  wsEndpoint: string;
}

function getBrowserConfig(): BrowserConfig {
  const store = getConfigStore();
  return {
    browserPath: store.get("browser", "browser_path") || process.env.BROWSER_PATH || "",
    wsEndpoint: store.get("browser", "ws_endpoint") || process.env.BROWSER_WS_ENDPOINT || "",
  };
}

// ── 本地浏览器探测 ──────────────────────────────

interface DetectedBrowser {
  name: string;
  path: string;
  channel?: string;  // Playwright channel 参数
}

function detectLocalBrowsers(): DetectedBrowser[] {
  const platform = process.platform;
  const candidates: DetectedBrowser[] = [];

  if (platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    candidates.push(
      { name: "Edge", path: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe", channel: "msedge" },
      { name: "Chrome", path: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", channel: "chrome" },
      { name: "Chrome", path: `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`, channel: "chrome" },
      { name: "Brave", path: "C:\\Program Files\\BraveSoftware\\Brave-Browser\\Application\\brave.exe" },
    );
  } else if (platform === "darwin") {
    candidates.push(
      { name: "Edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", channel: "msedge" },
      { name: "Chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", channel: "chrome" },
      { name: "Brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    );
  } else {
    candidates.push(
      { name: "Edge", path: "/usr/bin/microsoft-edge", channel: "msedge" },
      { name: "Chrome", path: "/usr/bin/google-chrome", channel: "chrome" },
      { name: "Brave", path: "/usr/bin/brave-browser" },
    );
  }

  return candidates.filter(c => fs.existsSync(c.path));
}

// ── 浏览器会话管理（单例） ──────────────────────

let _browser: any = null;   // playwright.Browser
let _context: any = null;   // playwright.BrowserContext
let _page: any = null;       // playwright.Page

/** 懒初始化浏览器会话 */
async function getPage(): Promise<any> {
  if (_page && !_page.isClosed()) return _page;

  const pw = await getPlaywright();
  const cfg = getBrowserConfig();

  // 策略①：WebSocket 远程连接
  if (cfg.wsEndpoint) {
    logger.info({ ws: cfg.wsEndpoint }, "连接远程浏览器");
    _browser = await pw.chromium.connectOverCDP(cfg.wsEndpoint);
    const contexts = _browser.contexts();
    _context = contexts.length > 0 ? contexts[0] : await _browser.newContext();
    _page = _context.pages().length > 0 ? _context.pages()[0] : await _context.newPage();
    return _page;
  }

  // 策略②/③：本地浏览器
  const launchArgs = ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"];
  const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;

  const launchOptions: Record<string, unknown> = {
    headless: true,
    args: launchArgs,
  };
  if (proxy) {
    launchOptions.proxy = { server: proxy };
  }

  if (cfg.browserPath) {
    // 策略②：用户指定路径
    logger.info({ path: cfg.browserPath }, "使用用户指定浏览器");
    launchOptions.executablePath = cfg.browserPath;
  } else {
    // 策略③：自动探测
    const detected = detectLocalBrowsers();
    if (detected.length === 0) {
      throw new Error(
        "未找到可用的浏览器。请安装 Edge 或 Chrome，\n" +
        "或告诉我浏览器路径，我会自动保存配置。\n" +
        "例如：我的浏览器在 C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      );
    }
    const best = detected[0];
    logger.info({ name: best.name, path: best.path, channel: best.channel }, "自动探测到浏览器");

    if (best.channel) {
      launchOptions.channel = best.channel;
    } else {
      launchOptions.executablePath = best.path;
    }
  }

  _browser = await pw.chromium.launch(launchOptions);
  _context = await _browser.newContext({
    locale: "zh-CN",
    timezoneId: "Asia/Shanghai",
    viewport: { width: 1280, height: 720 },
  });
  _page = await _context.newPage();
  _page.setDefaultTimeout(10_000);

  return _page;
}

/** 关闭浏览器会话 */
async function closeBrowser(): Promise<void> {
  if (_browser) {
    try { await _browser.close(); } catch { /* ignore */ }
    _browser = null;
    _context = null;
    _page = null;
  }
}

// ── 工具定义 ─────────────────────────────────────

/** browser_navigate — 打开 URL */
const browserNavigateTool: ToolDefinition = {
  name: "browser_navigate",
  description: "打开指定 URL，返回页面标题和文字摘要（前 3000 字符）。",
  parameters: z.object({
    url: z.string().describe("要打开的网址"),
    waitMs: z.number().default(3000).describe("页面加载后等待时间（毫秒，最大 10000）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { url, waitMs } = params as { url: string; waitMs: number };
    const safeWait = Math.min(waitMs, 10000);

    try {
      const page = await getPage();
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (safeWait > 0) await page.waitForTimeout(safeWait);

      const title = await page.title();
      const textContent = await page.evaluate("document.body?.innerText?.slice(0, 3000) ?? ''");

      return {
        success: true,
        output: `✅ 已打开：${url}\n标题：${title}\n\n${textContent}`,
        data: { url, title, textLength: textContent.length },
      };
    } catch (err: any) {
      return { success: false, output: `打开页面失败：${err.message}`, error: err.message };
    }
  },
};

/** browser_snapshot — 获取无障碍快照 */
const browserSnapshotTool: ToolDefinition = {
  name: "browser_snapshot",
  description: "获取当前页面的无障碍树快照（结构化文本，用于理解页面结构）。",
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    try {
      const page = await getPage();
      const snapshot = await page.accessibility.snapshot();
      const text = JSON.stringify(snapshot, null, 2).slice(0, 5000);

      return {
        success: true,
        output: `页面无障碍快照：\n${text}`,
        data: { snapshotLength: text.length },
      };
    } catch (err: any) {
      return { success: false, output: `获取快照失败：${err.message}`, error: err.message };
    }
  },
};

/** browser_click — 点击元素 */
const browserClickTool: ToolDefinition = {
  name: "browser_click",
  description: "点击页面中匹配选择器的元素。支持 CSS 选择器或 text= 文本匹配。",
  parameters: z.object({
    selector: z.string().describe("CSS 选择器或 text=匹配文本，如 'button.submit' 或 'text=登录'"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { selector } = params as { selector: string };
    try {
      const page = await getPage();
      await page.click(selector, { timeout: 10_000 });
      // 等待页面响应
      await page.waitForTimeout(500);

      return {
        success: true,
        output: `✅ 已点击：${selector}`,
        data: { selector },
      };
    } catch (err: any) {
      return { success: false, output: `点击失败：${err.message}`, error: err.message };
    }
  },
};

/** browser_type — 输入文字 */
const browserTypeTool: ToolDefinition = {
  name: "browser_type",
  description: "在页面输入框中输入文字。可选按回车键提交。",
  parameters: z.object({
    selector: z.string().describe("输入框的 CSS 选择器"),
    text: z.string().describe("要输入的文字"),
    pressEnter: z.boolean().default(false).describe("输入后是否按回车键"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { selector, text, pressEnter } = params as {
      selector: string; text: string; pressEnter: boolean;
    };
    try {
      const page = await getPage();
      await page.fill(selector, text, { timeout: 10_000 });
      if (pressEnter) {
        await page.press(selector, "Enter");
        await page.waitForTimeout(500);
      }

      return {
        success: true,
        output: `✅ 已输入 "${text.slice(0, 50)}${text.length > 50 ? "..." : ""}" 到 ${selector}${pressEnter ? "（已按回车）" : ""}`,
        data: { selector, textLength: text.length, pressEnter },
      };
    } catch (err: any) {
      return { success: false, output: `输入失败：${err.message}`, error: err.message };
    }
  },
};

/** browser_screenshot — 页面截图 */
const browserScreenshotTool: ToolDefinition = {
  name: "browser_screenshot",
  description: "对当前页面截图保存为 PNG 文件。",
  parameters: z.object({
    savePath: z.string().optional().describe("截图保存路径（默认临时目录）"),
    fullPage: z.boolean().default(false).describe("是否截取完整页面（含滚动区域）"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { savePath, fullPage } = params as { savePath?: string; fullPage: boolean };
    try {
      const page = await getPage();
      const outPath = savePath || path.join(
        os.tmpdir(),
        `sa_screenshot_${Date.now()}.png`
      );
      const dir = path.dirname(outPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      await page.screenshot({ path: outPath, fullPage });
      const stat = fs.statSync(outPath);

      return {
        success: true,
        output: `✅ 截图已保存：${outPath}（${(stat.size / 1024).toFixed(1)} KB）`,
        data: { filePath: outPath, size: stat.size },
      };
    } catch (err: any) {
      return { success: false, output: `截图失败：${err.message}`, error: err.message };
    }
  },
};

/** browser_close — 关闭浏览器 */
const browserCloseTool: ToolDefinition = {
  name: "browser_close",
  description: "关闭浏览器会话，释放资源。",
  parameters: z.object({}),
  execute: async (): Promise<ToolResult> => {
    try {
      await closeBrowser();
      return { success: true, output: "✅ 浏览器已关闭", data: {} };
    } catch (err: any) {
      return { success: false, output: `关闭失败：${err.message}`, error: err.message };
    }
  },
};

export const browserTools: ToolDefinition[] = [
  browserNavigateTool,
  browserSnapshotTool,
  browserClickTool,
  browserTypeTool,
  browserScreenshotTool,
  browserCloseTool,
];
