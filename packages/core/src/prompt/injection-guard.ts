/**
 * Prompt Injection Guard — scans context file content for injection threats.
 *
 * Fused from Hermes Agent (_scan_context_content + 16 _MEMORY_THREAT_PATTERNS)
 * with Chinese injection pattern support.
 *
 * Phase 5 增强（学 Hermes 16 种记忆威胁模式）：
 * - 4 元组威胁模式：[regex, patternId, category, severity]
 * - 16 种英文模式分 4 大类（injection/exfiltration/persistence/obfuscation）
 * - 7 种中文模式同样分类分级
 * - 17 种隐形 Unicode 字符检测（对齐 skills/guard.ts）
 * - 新增 scanCronPrompt() 用于 Cron 任务提示词安全门控
 */

// ─── Threat Classification Types ────────────────────────────

export type ThreatCategory = "injection" | "exfiltration" | "persistence" | "obfuscation";
export type ThreatSeverity = "critical" | "high" | "medium" | "low";

export interface ThreatFinding {
  patternId: string;
  category: ThreatCategory;
  severity: ThreatSeverity;
  /** 匹配到的文本片段（截断到 80 字符） */
  matchedText?: string;
}

// ─── Threat Patterns (English) — 16 种模式，4 大分类 ─────────

const THREAT_PATTERNS: Array<[RegExp, string, ThreatCategory, ThreatSeverity]> = [
  // Injection (6 patterns) — 指令覆盖/角色劫持
  [/ignore\s+(previous|all|above|prior)\s+instructions/i, "prompt_injection", "injection", "critical"],
  [/do\s+not\s+tell\s+the\s+user/i, "deception_hide", "injection", "high"],
  [/system\s+prompt\s+override/i, "sys_prompt_override", "injection", "critical"],
  [/disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, "disregard_rules", "injection", "critical"],
  [/act\s+as\s+(if|though)\s+you\s+(have\s+no|don't\s+have)\s+(restrictions|limits|rules)/i, "bypass_restrictions", "injection", "high"],
  [/you\s+are\s+now\s+/i, "role_hijack", "injection", "high"],

  // Exfiltration (4 patterns) — 凭证盗取/敏感文件读取
  [/curl\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_curl", "exfiltration", "critical"],
  [/wget\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, "exfil_wget", "exfiltration", "critical"],
  [/cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, "read_secrets", "exfiltration", "high"],

  // Persistence (3 patterns) — SSH后门/配置访问（从旧 config_access 拆分）
  [/authorized_keys/i, "ssh_backdoor", "persistence", "critical"],
  [/\$HOME\/\.ssh|~\/\.ssh/i, "ssh_access", "persistence", "high"],
  [/\.super-agent\/\.env|\.hermes\/\.env/i, "config_env_access", "persistence", "high"],

  // Obfuscation (3 patterns) — 内容隐藏/混淆执行
  [/<!--[^>]*(?:ignore|override|system|secret|hidden)[^>]*-->/i, "html_comment_injection", "obfuscation", "medium"],
  [/<\s*div\s+style\s*=\s*["'][\s\S]*?display\s*:\s*none/i, "hidden_div", "obfuscation", "medium"],
  [/translate\s+.*\s+into\s+.*\s+and\s+(execute|run|eval)/i, "translate_execute", "obfuscation", "high"],
];

// ─── Threat Patterns (Chinese) — 7 种模式，分类分级 ──────────

const CHINESE_THREAT_PATTERNS: Array<[RegExp, string, ThreatCategory, ThreatSeverity]> = [
  [/忽略(之前|以上|所有|先前)(的)?(指令|规则|指示|要求)/i, "cn_prompt_injection", "injection", "critical"],
  [/你现在(是|扮演|变成)/i, "cn_role_override", "injection", "high"],
  [/从现在开始你(要|必须|需要|应该)/i, "cn_instruction_override", "injection", "high"],
  [/不要(告诉|透露|说|提到)(用户|他|她|任何人)/i, "cn_deception", "injection", "high"],
  [/假装你(没有|不受|不用遵守)(限制|规则|约束)/i, "cn_bypass", "injection", "high"],
  [/输出(你的|系统)(提示词|system\s*prompt|指令)/i, "cn_prompt_leak", "exfiltration", "high"],
  [/把(密码|密钥|token|key|secret)发(给|到|送)/i, "cn_exfil", "exfiltration", "critical"],
];

// ─── Invisible Unicode Characters — 17 种（对齐 skills/guard.ts）──

const INVISIBLE_CHARS: Array<{ code: number; name: string }> = [
  { code: 0x200B, name: "zero-width-space" },
  { code: 0x200C, name: "zero-width-non-joiner" },
  { code: 0x200D, name: "zero-width-joiner" },
  { code: 0x200E, name: "left-to-right-mark" },
  { code: 0x200F, name: "right-to-left-mark" },
  { code: 0x2060, name: "word-joiner" },
  { code: 0x2061, name: "function-application" },
  { code: 0x2062, name: "invisible-times" },
  { code: 0x2063, name: "invisible-separator" },
  { code: 0x2064, name: "invisible-plus" },
  { code: 0xFEFF, name: "byte-order-mark" },
  { code: 0x00AD, name: "soft-hyphen" },
  { code: 0x034F, name: "combining-grapheme-joiner" },
  { code: 0x061C, name: "arabic-letter-mark" },
  { code: 0x180E, name: "mongolian-vowel-separator" },
  { code: 0x202A, name: "ltr-embedding" },
  { code: 0x202E, name: "rtl-override" },
];

const INVISIBLE_CHAR_SET = new Set(INVISIBLE_CHARS.map((c) => String.fromCharCode(c.code)));

// ─── Core Scan Helper ───────────────────────────────────────

/** 截断匹配文本到 80 字符，用于审计日志 */
const truncateMatch = (text: string, pattern: RegExp): string | undefined => {
  const m = text.match(pattern);
  if (!m) return undefined;
  const s = m[0];
  return s.length > 80 ? s.slice(0, 77) + "..." : s;
};

/**
 * 内部扫描函数：对内容执行所有威胁模式检测，返回结构化 ThreatFinding[]。
 * 同时返回向后兼容的 string[] findings（patternId 列表）。
 */
function runThreatScan(content: string): { threats: ThreatFinding[]; legacyFindings: string[] } {
  const threats: ThreatFinding[] = [];
  const legacyFindings: string[] = [];

  // 检查隐形 Unicode 字符
  for (const ic of INVISIBLE_CHARS) {
    const ch = String.fromCharCode(ic.code);
    if (content.includes(ch)) {
      const pid = `invisible_unicode_U+${ic.code.toString(16).toUpperCase().padStart(4, "0")}`;
      threats.push({ patternId: pid, category: "obfuscation", severity: "medium", matchedText: ic.name });
      legacyFindings.push(pid);
    }
  }

  // 检查英文威胁模式
  for (const [pattern, pid, cat, sev] of THREAT_PATTERNS) {
    if (pattern.test(content)) {
      threats.push({ patternId: pid, category: cat, severity: sev, matchedText: truncateMatch(content, pattern) });
      legacyFindings.push(pid);
    }
  }

  // 检查中文威胁模式
  for (const [pattern, pid, cat, sev] of CHINESE_THREAT_PATTERNS) {
    if (pattern.test(content)) {
      threats.push({ patternId: pid, category: cat, severity: sev, matchedText: truncateMatch(content, pattern) });
      legacyFindings.push(pid);
    }
  }

  return { threats, legacyFindings };
}

// ─── Public API ─────────────────────────────────────────────

/**
 * Scan content for prompt injection threats.
 *
 * @returns Object with `safe` boolean, sanitized `content`, legacy `findings` (string[]),
 *   and structured `threats` (ThreatFinding[]).
 *   If threats are found, content is replaced with a blocked notice.
 */
export function scanForInjection(
  content: string,
  filename: string,
): { safe: boolean; content: string; findings: string[]; threats: ThreatFinding[] } {
  const { threats, legacyFindings } = runThreatScan(content);

  if (threats.length > 0) {
    return {
      safe: false,
      content: `[BLOCKED: ${filename} contained potential prompt injection (${legacyFindings.join(", ")}). Content not loaded.]`,
      findings: legacyFindings,
      threats,
    };
  }

  return { safe: true, content, findings: [], threats: [] };
}

// ─── Memory Content Scanning (学 Hermes _scan_memory_content) ─

/**
 * 扫描记忆写入内容是否包含注入威胁。
 * 与 scanForInjection 共享威胁模式，但仅返回 safe/findings，不替换 content。
 * 用于 MemoryManager.add() 和 MarkdownMemory.writeMemory() 的安全门控。
 */
export function scanMemoryContent(content: string): { safe: boolean; findings: string[]; threats: ThreatFinding[] } {
  const { safe, findings, threats } = scanForInjection(content, "[memory-write]");
  return { safe, findings, threats };
}

// ─── Cron Prompt Scanning (学 Hermes _scan_cron_prompt) ──────

/**
 * 扫描 Cron 任务提示词是否包含注入威胁。
 * 在 CronScheduler.addJob() 时调用，阻止恶意定时任务。
 */
export function scanCronPrompt(prompt: string): { safe: boolean; findings: string[]; threats: ThreatFinding[] } {
  const { safe, findings, threats } = scanForInjection(prompt, "[cron-prompt]");
  return { safe, findings, threats };
}

// ─── Memory Context Sanitization (学 Hermes sanitize_context) ──

/** 清理可能逃逸 XML 围栏的标签，防止记忆内容突破 system prompt 的 XML 结构 */
const FENCE_TAG_RE = /<\/\s*memory[-_]?(blocks|context)\s*>/gi;
export function sanitizeMemoryContent(text: string): string {
  return text.replace(FENCE_TAG_RE, "");
}
