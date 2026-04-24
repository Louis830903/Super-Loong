/**
 * Output Processor — 终端输出净化器
 *
 * 职责边界: 只负责输出**净化**，**不做截断**。
 * 截断已由现有 context/tool-result-truncation.ts 三层防御处理。
 * 如果本模块也做截断，会导致双重截断，信息丢失更严重。
 *
 * 功能:
 * 1. ANSI转义序列完整剥离 (CSI/OSC/DCS/8-bit C1)
 * 2. 敏感信息编辑 (API密钥/token/密码模式自动遮蔽)
 * 3. Unicode NFKC规范化 (防止全宽字符绕过检测)
 * 4. 退出码语义解释 (grep=1 无匹配, diff=1 有差异)
 *
 * 参考: hermes-agent/tools/ansi_strip.py
 */

import pino from "pino";

const logger = pino({ name: "output-processor" });

// ─── ANSI 转义序列剥离 ──────────────────────────────────────

/**
 * ANSI转义序列完整剥离
 *
 * 覆盖范围 (参考 Hermes ansi_strip.py):
 * - CSI (Control Sequence Introducer): \x1b[...
 * - OSC (Operating System Command): \x1b]...
 * - DCS (Device Control String): \x1bP...
 * - 8-bit C1 控制码: \x80-\x9f
 * - 普通转义序列: \x1b 后跟单个字符
 * - 额外控制字符: BEL(\x07), DEL(\x7f), 退格/回车序列
 */
const ANSI_PATTERNS = [
  // CSI 序列: ESC [ ... 最终字符 (0x40-0x7E)
  /\x1b\[[0-9;?]*[A-Za-z]/g,
  // OSC 序列: ESC ] ... (以 BEL 或 ST 结束)
  /\x1b\].*?(?:\x07|\x1b\\)/g,
  // DCS 序列: ESC P ... ST
  /\x1bP.*?\x1b\\/g,
  // 8-bit C1 控制码 (0x80-0x9f)
  // eslint-disable-next-line no-control-regex
  /[\x80-\x9f]/g,
  // 普通转义序列: ESC 后跟单个字符
  /\x1b[^[\]P]/g,
  // BEL 响铃
  /\x07/g,
  // DEL 字符
  /\x7f/g,
];

/**
 * 剥离所有ANSI转义序列
 *
 * @param text 包含ANSI转义的原始输出
 * @returns 纯净文本
 */
export function stripAnsi(text: string): string {
  let cleaned = text;
  for (const pattern of ANSI_PATTERNS) {
    cleaned = cleaned.replace(pattern, "");
  }
  // 处理退格字符造成的覆盖效果: 'a\b' → '' (字符被退格删除)
  while (cleaned.includes("\b")) {
    cleaned = cleaned.replace(/[^\b]\b/g, "");
    // 防止无限循环: 如果只剩下退格符，直接移除
    cleaned = cleaned.replace(/\b/g, "");
  }
  return cleaned;
}

// ─── 敏感信息编辑 ──────────────────────────────────────────

/**
 * 敏感信息匹配模式
 * 检测常见的 API 密钥、token、密码格式
 */
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // API 密钥格式 (sk-xxx, api_xxx 等) — 高置信模式，无需上下文
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/g, label: "API_KEY" },
  // api_key= 或 api-key: 后跟值（要求 = 或 : 紧接，不允许纯空格匹配）
  { pattern: /\b(api[_-]?key[=:]\s?)[^\s'"]{10,}/gi, label: "API_KEY" },
  // Bearer Token — 高置信模式
  { pattern: /(Bearer\s+)[^\s'"]{20,}/gi, label: "BEARER_TOKEN" },
  // 通用 token/secret/password 赋值（要求 = 或 : 紧接，最少 16 字符避免误伤短值）
  { pattern: /([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH)[=:]\s?)[^\s'"]{16,}/gi, label: "SECRET" },
  // AWS 密钥 — 高置信模式（固定前缀 AKIA）
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, label: "AWS_KEY" },
  // GitHub token — 高置信模式（固定前缀 ghp_/ghs_/github_pat_）
  { pattern: /\b(gh[ps]_[A-Za-z0-9]{36,})\b/g, label: "GITHUB_TOKEN" },
  { pattern: /\b(github_pat_[A-Za-z0-9_]{82,})\b/g, label: "GITHUB_PAT" },
  // 私钥内容 — 高置信模式（BEGIN/END 块）
  { pattern: /-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----/g, label: "PRIVATE_KEY" },
  // 密码哈希 — 高置信模式（Bcrypt 格式）
  { pattern: /\$2[aby]\$\d+\$[./A-Za-z0-9]{53}/g, label: "BCRYPT_HASH" },
  // 通用长随机字符串 (至少 32 位 base64，要求 = 或 : 紧接)
  { pattern: /([A-Z_]*(?:KEY|TOKEN|SECRET)[=:]\s?)([a-zA-Z0-9+/]{32,}={0,2})/gi, label: "SECRET_VALUE" },
];

/**
 * 遮蔽输出中的敏感信息
 *
 * @param text 原始文本
 * @returns 敏感信息已遮蔽的文本
 */
export function redactSensitive(text: string): string {
  let redacted = text;

  for (const { pattern, label } of SENSITIVE_PATTERNS) {
    // 需要重置 lastIndex（全局正则的状态问题）
    pattern.lastIndex = 0;
    redacted = redacted.replace(pattern, (match, prefix?: string) => {
      // 对于有前缀捕获组的模式，保留前缀部分
      if (prefix && match.startsWith(prefix)) {
        return `${prefix}[REDACTED:${label}]`;
      }
      return `[REDACTED:${label}]`;
    });
  }

  return redacted;
}

// ─── Unicode 规范化 ──────────────────────────────────────────

/**
 * Unicode NFKC 规范化
 *
 * 将全宽字符转为半宽，统一 Unicode 表示。
 * 防止使用全宽字符绕过安全检测（如 `ｒｍ -ｒｆ /`）。
 */
export function normalizeUnicode(text: string): string {
  return text.normalize("NFKC");
}

// ─── 退出码语义解释 ──────────────────────────────────────────

/**
 * 退出码语义映射
 * 某些命令的非零退出码有特定语义含义，不代表执行失败
 *
 * 参考: Hermes _interpret_exit_code()
 */
const EXIT_CODE_SEMANTICS: Record<string, Record<number, string>> = {
  grep: {
    1: "无匹配结果(正常行为)",
    2: "语法错误或文件不可访问",
  },
  diff: {
    1: "存在差异(正常行为)",
    2: "发生错误",
  },
  git: {
    1: "操作失败或无匹配",
    128: "致命错误(仓库损坏/权限等)",
  },
  curl: {
    6: "无法解析主机名",
    7: "连接被拒绝",
    28: "操作超时",
    35: "SSL/TLS 握手失败",
  },
  ssh: {
    255: "连接失败",
  },
  test: {
    1: "条件为假(正常行为)",
  },
  ping: {
    1: "没有收到回复",
    2: "其他错误",
  },
};

/**
 * 解释退出码语义
 *
 * @param command 执行的命令字符串
 * @param exitCode 退出码
 * @returns 语义解释文本，无特殊语义返回 null
 */
export function interpretExitCode(command: string, exitCode: number): string | null {
  if (exitCode === 0) return null; // 成功无需解释

  // 提取命令名称（取第一个非空 token）
  const cmdName = command.trim().split(/\s+/)[0]?.replace(/^.*[/\\]/, ""); // 去除路径
  if (!cmdName) return null;

  const semantics = EXIT_CODE_SEMANTICS[cmdName];
  if (!semantics) return null;

  return semantics[exitCode] || null;
}

/**
 * 判断非零退出码是否为正常语义（非错误）
 */
export function isNormalNonZeroExit(command: string, exitCode: number): boolean {
  const interpretation = interpretExitCode(command, exitCode);
  if (!interpretation) return false;

  // 包含"正常"关键词的视为非错误退出
  return interpretation.includes("正常行为");
}

// ─── 统一处理入口 ──────────────────────────────────────────

/**
 * 处理终端输出 — 统一净化流程
 *
 * 1. ANSI剥离
 * 2. Unicode NFKC规范化
 * 3. 敏感信息遮蔽
 *
 * 注意: 不做截断！截断交给现有的 tool-result-truncation.ts
 *
 * @param rawOutput 终端原始输出
 * @returns 净化后的输出
 */
export function processOutput(rawOutput: string): string {
  // 空输出直接返回
  if (!rawOutput) return rawOutput;

  let processed = rawOutput;

  // Step 1: ANSI转义剥离
  processed = stripAnsi(processed);

  // Step 2: Unicode NFKC 规范化
  processed = normalizeUnicode(processed);

  // Step 3: 敏感信息遮蔽
  processed = redactSensitive(processed);

  // Step 4: 清理尾部多余空行（保留最多1个）
  processed = processed.replace(/\n{3,}/g, "\n\n");

  return processed;
}

/**
 * 构建带退出码语义的完整输出
 *
 * @param rawOutput 原始输出
 * @param command 执行的命令
 * @param exitCode 退出码
 * @returns 净化后的输出 + 退出码注释（如有语义）
 */
export function processOutputWithExitCode(
  rawOutput: string,
  command: string,
  exitCode: number,
): { output: string; isNormalExit: boolean; exitNote?: string } {
  const output = processOutput(rawOutput);
  const exitNote = interpretExitCode(command, exitCode) ?? undefined;
  const isNormalExit = exitCode === 0 || isNormalNonZeroExit(command, exitCode);

  return { output, isNormalExit, exitNote };
}
