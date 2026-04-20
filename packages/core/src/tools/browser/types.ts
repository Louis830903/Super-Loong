/**
 * 浏览器自动化 — 类型定义与 Provider 接口
 *
 * 参考 Hermes 三后端架构（本地/云/CamoFox），定义统一的 BrowserProvider 接口。
 * 所有 Provider 实现此接口，由 SessionManager 统一调度。
 */

/** 浏览器 Provider 类型 */
export type BrowserProviderType = "local" | "stealth" | "cloud";

/** 浏览器会话配置 */
export interface BrowserSessionConfig {
  /** 使用的 Provider 类型（默认 local） */
  provider?: BrowserProviderType;
  /** 是否无头模式（默认 true） */
  headless?: boolean;
  /** 视口大小 */
  viewport?: { width: number; height: number };
  /** 区域设置 */
  locale?: string;
  /** 时区 */
  timezoneId?: string;
  /** 代理服务器 */
  proxy?: string;
  /** 用户数据目录（用于 Cookie 持久化） */
  userDataDir?: string;
  /** 不活跃超时（毫秒，默认 300000 = 5 分钟） */
  inactivityTimeout?: number;
}

/** 浏览器会话状态 */
export interface BrowserSessionState {
  /** 会话 ID（= taskId） */
  id: string;
  /** 使用的 Provider 类型 */
  provider: BrowserProviderType;
  /** 当前页面 URL */
  currentUrl?: string;
  /** 当前页面标题 */
  currentTitle?: string;
  /** 创建时间 */
  createdAt: Date;
  /** 最后活动时间 */
  lastActiveAt: Date;
  /** 是否已关闭 */
  closed: boolean;
}

/** Cookie 条目 */
export interface CookieEntry {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Strict" | "Lax" | "None";
}

/** 安全检查结果 */
export interface SecurityCheckResult {
  /** 是否安全 */
  safe: boolean;
  /** 检测到的问题 */
  issues: string[];
  /** 是否检测到 Bot 检测 */
  botDetected: boolean;
}

/**
 * 统一浏览器 Provider 接口。
 * 所有浏览器后端（本地/隐身/云）都实现此接口。
 */
export interface BrowserProvider {
  /** Provider 类型 */
  readonly providerType: BrowserProviderType;

  /** 初始化 Provider */
  initialize(config: BrowserSessionConfig): Promise<void>;

  /** 导航到 URL */
  navigate(url: string, waitMs?: number): Promise<{ title: string; content: string }>;

  /** 获取无障碍快照 */
  snapshot(): Promise<string>;

  /** 点击元素 */
  click(selector: string): Promise<void>;

  /** 输入文字 */
  typeText(selector: string, text: string, pressEnter?: boolean): Promise<void>;

  /** 滚动页面 */
  scroll(direction: "up" | "down", amount?: number): Promise<void>;

  /** 后退 */
  back(): Promise<void>;

  /** 键盘按键 */
  press(key: string): Promise<void>;

  /** 截图 */
  screenshot(options?: { fullPage?: boolean; savePath?: string }): Promise<{ path: string; size: number }>;

  /** 获取页面图片列表 */
  getImages(): Promise<Array<{ src: string; alt: string }>>;

  /** 获取控制台日志 */
  getConsoleLog(): Promise<string[]>;

  /** 获取 Cookie */
  getCookies(domain?: string): Promise<CookieEntry[]>;

  /** 设置 Cookie */
  setCookies(cookies: CookieEntry[]): Promise<void>;

  /** 等待元素或条件 */
  waitFor(selectorOrCondition: string, timeoutMs?: number): Promise<void>;

  /** 下拉选择 */
  select(selector: string, value: string): Promise<void>;

  /** 文件上传 */
  upload(selector: string, filePaths: string[]): Promise<void>;

  /** 导出 PDF */
  exportPdf(savePath: string): Promise<{ path: string; size: number }>;

  /** 关闭 Provider */
  close(): Promise<void>;

  /** 是否已关闭 */
  isClosed(): boolean;
}

/** Vision 分析结果 */
export interface VisionAnalysisResult {
  /** 分析描述 */
  description: string;
  /** 检测到的元素 */
  elements?: string[];
  /** 截图路径 */
  screenshotPath: string;
}
