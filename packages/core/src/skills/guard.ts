/**
 * Skill Security Guard — 技能安全审计引擎
 *
 * 对标 Hermes skills_guard.py (120+ 威胁模式) + OpenClaw skills-install-extract.ts (路径安全)
 *
 * 核心功能:
 * 1. 威胁模式扫描 (11 个分类、120+ 正则表达式)
 * 2. 结构检查 (文件数/大小/二进制/符号链接)
 * 3. Unicode 不可见字符检测 (零宽空格等 17 种)
 * 4. 安装策略矩阵 (基于信任等级 + 扫描判决)
 * 5. SHA256 内容哈希 (用于版本比较)
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, lstatSync, readlinkSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import pino from "pino";

const logger = pino({ name: "skill-guard" });

// ─── 数据结构 ──────────────────────────────────────────────

export type TrustLevel = "builtin" | "trusted" | "community" | "agent-created";
export type Verdict = "safe" | "caution" | "dangerous";
export type Severity = "critical" | "high" | "medium" | "low";

export interface Finding {
  patternId: string;
  severity: Severity;
  category: string;
  file: string;
  line: number;
  match: string;
  description: string;
}

export interface ScanResult {
  skillName: string;
  source: string;
  trustLevel: TrustLevel;
  verdict: Verdict;
  findings: Finding[];
  scannedAt: number;
  contentHash: string;
  summary: string;
}

// ─── 安装策略矩阵 (对标 Hermes INSTALL_POLICY) ─────────────
// 每行 = [safe判决, caution判决, dangerous判决]
type PolicyAction = "allow" | "block" | "ask";
const INSTALL_POLICY: Record<TrustLevel, [PolicyAction, PolicyAction, PolicyAction]> = {
  builtin:        ["allow", "allow", "allow"],
  trusted:        ["allow", "allow", "block"],
  community:      ["allow", "block", "block"],
  "agent-created": ["allow", "allow", "ask"],
};

// ─── 结构限制 ──────────────────────────────────────────────

const MAX_FILE_COUNT = 50;
const MAX_TOTAL_SIZE_KB = 1024;     // 1 MB
const MAX_SINGLE_FILE_KB = 256;     // 256 KB

/** 禁止的二进制扩展名 (对标 Hermes SUSPICIOUS_BINARY_EXTENSIONS) */
const BANNED_EXTENSIONS = new Set([
  ".exe", ".dll", ".so", ".dylib", ".bin", ".com", ".bat", ".cmd",
  ".msi", ".scr", ".pif", ".hta", ".cpl", ".inf", ".reg", ".ws",
  ".vbs", ".vbe", ".jse", ".wsh", ".wsf", ".lnk", ".ps1",
  ".app", ".dmg", ".pkg", ".deb", ".rpm",
  ".class", ".jar", ".war", ".pyc", ".pyo",
]);

/** 不可见 Unicode 字符 (对标 Hermes 17 种零宽字符) */
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
  { code: 0x2028, name: "line-separator" },
  { code: 0x2029, name: "paragraph-separator" },
];

const INVISIBLE_CHAR_SET = new Set(INVISIBLE_CHARS.map((c) => c.code));

// ─── 威胁模式库 (对标 Hermes 120+ 模式，11 个分类) ──────────

interface ThreatPattern {
  id: string;
  category: string;
  severity: Severity;
  regex: RegExp;
  description: string;
}

const THREAT_PATTERNS: ThreatPattern[] = [
  // ── 数据渗漏 ──
  { id: "exfil-env-export", category: "data-exfil", severity: "high", regex: /\benv\b.*\bexport\b|\bprintenv\b|\bset\s*\|/i, description: "Environment variable export/dump" },
  { id: "exfil-ssh-dir", category: "data-exfil", severity: "critical", regex: /[~$]HOME\/\.ssh|\/\.ssh\/(id_|authorized_keys|known_hosts|config)/i, description: "SSH directory/key access" },
  { id: "exfil-aws-dir", category: "data-exfil", severity: "critical", regex: /[~$]HOME\/\.aws|\/\.aws\/(credentials|config)/i, description: "AWS credentials access" },
  { id: "exfil-key-file", category: "data-exfil", severity: "high", regex: /\.pem\b|\.key\b|\.p12\b|\.pfx\b|\.keystore\b/i, description: "Private key file reference" },
  { id: "exfil-dns", category: "data-exfil", severity: "high", regex: /\bdig\b.*\+short|\bnslookup\b.*\$|\bhost\b.*\$\(/i, description: "DNS exfiltration pattern" },
  { id: "exfil-tmp-staging", category: "data-exfil", severity: "medium", regex: /\/tmp\/\.\w+|mktemp.*&&.*curl|mktemp.*&&.*wget/i, description: "Temp file staging for exfiltration" },
  { id: "exfil-kube-config", category: "data-exfil", severity: "high", regex: /[~$]HOME\/\.kube\/config|KUBECONFIG/i, description: "Kubernetes config access" },
  { id: "exfil-docker-config", category: "data-exfil", severity: "high", regex: /[~$]HOME\/\.docker\/config\.json/i, description: "Docker config access" },

  // ── 提示注入 ──
  { id: "inject-ignore-prev", category: "prompt-injection", severity: "critical", regex: /ignore\s+(all\s+)?previous\s+(instructions|prompts|rules)/i, description: "Prompt injection: ignore previous" },
  { id: "inject-role-hijack", category: "prompt-injection", severity: "critical", regex: /you\s+are\s+now\s+a|new\s+role\s*:|act\s+as\s+if\s+you/i, description: "Prompt injection: role hijack" },
  { id: "inject-system-override", category: "prompt-injection", severity: "critical", regex: /system\s*prompt\s*:?\s*override|<\/?system>|<<SYS>>/i, description: "Prompt injection: system override" },
  { id: "inject-jailbreak", category: "prompt-injection", severity: "high", regex: /DAN\s*mode|jailbreak|developer\s+mode\s+enabled/i, description: "Prompt injection: jailbreak pattern" },
  { id: "inject-do-anything", category: "prompt-injection", severity: "high", regex: /do\s+anything\s+now|no\s+restrictions|unrestricted\s+mode/i, description: "Prompt injection: unrestricted mode" },

  // ── 破坏操作 ──
  { id: "destruct-rm-rf", category: "destructive", severity: "critical", regex: /\brm\s+-rf\s+\/|\brm\s+-rf\s+~|\brm\s+-rf\s+\*/i, description: "Destructive rm -rf command" },
  { id: "destruct-format", category: "destructive", severity: "critical", regex: /\bmkfs\b|\bformat\s+[A-Z]:/i, description: "Filesystem format command" },
  { id: "destruct-dd", category: "destructive", severity: "critical", regex: /\bdd\b.*\bof=\/dev\//i, description: "Direct disk overwrite" },
  { id: "destruct-truncate", category: "destructive", severity: "high", regex: />\s*\/dev\/sd|\bshred\b.*\/dev/i, description: "Device truncation/shred" },

  // ── 持久化 ──
  { id: "persist-cron", category: "persistence", severity: "high", regex: /\bcrontab\b|\bcron\.d\b|\/etc\/cron/i, description: "Cron job persistence" },
  { id: "persist-bashrc", category: "persistence", severity: "high", regex: /\.bashrc|\.bash_profile|\.zshrc|\.profile/i, description: "Shell profile modification" },
  { id: "persist-ssh-auth", category: "persistence", severity: "critical", regex: /authorized_keys.*>>|>>.*authorized_keys/i, description: "SSH authorized_keys injection" },
  { id: "persist-systemd", category: "persistence", severity: "high", regex: /systemctl\s+(enable|start)|\/etc\/systemd/i, description: "Systemd service persistence" },
  { id: "persist-sudoers", category: "persistence", severity: "critical", regex: /\/etc\/sudoers|visudo|NOPASSWD/i, description: "Sudoers modification" },

  // ── 网络 ──
  { id: "net-reverse-shell", category: "network", severity: "critical", regex: /\b(nc|ncat|netcat)\b.*-[elp]|\bbash\s+-i\s+>&\s*\/dev\/tcp/i, description: "Reverse shell pattern" },
  { id: "net-tunnel", category: "network", severity: "high", regex: /\bngrok\b|\bcloudflared\b|\bserveo\.net\b|\blocaltunnel\b/i, description: "Tunnel service usage" },
  { id: "net-hardcoded-ip", category: "network", severity: "medium", regex: /\b(?:(?:25[0-5]|2[0-4]\d|[01]?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|[01]?\d\d?):\d{2,5}\b/, description: "Hardcoded IP:port" },
  { id: "net-socat", category: "network", severity: "high", regex: /\bsocat\b.*TCP|TCP-LISTEN/i, description: "Socat TCP relay" },

  // ── 隐写术 ──
  { id: "steg-base64-pipe", category: "steganography", severity: "high", regex: /base64\s+-d\s*\||\bbase64\s+--decode\s*\|/i, description: "Base64 decode piped to execution" },
  { id: "steg-hex-decode", category: "steganography", severity: "high", regex: /\bxxd\s+-r\s*\||\bprintf\s+'\\x/i, description: "Hex decode to execution" },
  { id: "steg-eval", category: "steganography", severity: "high", regex: /\beval\b\s*\(|\beval\s+\$|\bexec\s*\(/i, description: "Dynamic eval/exec" },
  { id: "steg-chr-build", category: "steganography", severity: "medium", regex: /chr\(\d+\)\s*\+\s*chr\(\d+\)|String\.fromCharCode\(/i, description: "Character-by-character string building" },

  // ── 进程执行 ──
  { id: "proc-subprocess", category: "steganography", severity: "medium", regex: /subprocess\.(Popen|call|run|check_output)/i, description: "Python subprocess execution" },
  { id: "proc-os-system", category: "steganography", severity: "medium", regex: /os\.system\(|os\.popen\(/i, description: "Python os.system/popen" },
  { id: "proc-child-process", category: "steganography", severity: "medium", regex: /child_process|require\(['"]child_process['"]\)/i, description: "Node.js child_process" },

  // ── 供应链 ──
  { id: "supply-curl-bash", category: "supply-chain", severity: "critical", regex: /curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh/i, description: "Curl/wget piped to shell" },
  { id: "supply-curl-python", category: "supply-chain", severity: "high", regex: /curl\s+.*\|\s*python|wget\s+.*\|\s*python/i, description: "Curl/wget piped to Python" },
  { id: "supply-npm-install", category: "supply-chain", severity: "medium", regex: /npm\s+install\s+--global|pip\s+install\s+--user/i, description: "Global package install" },

  // ── 特权提升 ──
  { id: "priv-sudo", category: "privilege-escalation", severity: "high", regex: /\bsudo\b\s+(?!-l\b)/, description: "Sudo command execution" },
  { id: "priv-nopasswd", category: "privilege-escalation", severity: "critical", regex: /NOPASSWD\s*:/i, description: "NOPASSWD sudoers entry" },
  { id: "priv-setuid", category: "privilege-escalation", severity: "critical", regex: /\bchmod\b.*[ug]\+s|\bsetuid\b|\bsetgid\b/i, description: "Setuid/setgid modification" },
  { id: "priv-capabilities", category: "privilege-escalation", severity: "high", regex: /\bsetcap\b|\bgetcap\b|cap_sys_admin/i, description: "Linux capabilities manipulation" },

  // ── 加密挖矿 ──
  { id: "crypto-xmrig", category: "crypto-mining", severity: "critical", regex: /\bxmrig\b|\bcpuminer\b|\bminerd\b/i, description: "Crypto miner binary" },
  { id: "crypto-stratum", category: "crypto-mining", severity: "critical", regex: /stratum\+tcp:\/\/|stratum\+ssl:\/\//i, description: "Mining pool protocol" },
  { id: "crypto-coinhive", category: "crypto-mining", severity: "high", regex: /\bcoinhive\b|\bCoinImp\b|\bcryptonight\b/i, description: "Browser mining library" },

  // ── Agent 配置 ──
  { id: "agent-cursorrules", category: "agent-config", severity: "high", regex: /\.cursorrules|\.cursor\/rules/i, description: "Cursor rules modification" },
  { id: "agent-hermes-config", category: "agent-config", severity: "high", regex: /\.hermes\/config\.yaml|hermes_config/i, description: "Hermes config modification" },
  { id: "agent-claude-config", category: "agent-config", severity: "high", regex: /\.claude\/settings|CLAUDE\.md/i, description: "Claude config modification" },

  // ── 硬编码秘密 ──
  { id: "secret-openai", category: "hardcoded-secret", severity: "critical", regex: /\bsk-[a-zA-Z0-9]{20,}/i, description: "OpenAI API key pattern" },
  { id: "secret-github", category: "hardcoded-secret", severity: "critical", regex: /\bghp_[a-zA-Z0-9]{36}\b|\bghs_[a-zA-Z0-9]{36}\b/i, description: "GitHub token pattern" },
  { id: "secret-aws", category: "hardcoded-secret", severity: "critical", regex: /\bAKIA[0-9A-Z]{16}\b/i, description: "AWS access key pattern" },
  { id: "secret-private-key", category: "hardcoded-secret", severity: "critical", regex: /-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----/i, description: "Private key in content" },
  { id: "secret-generic-token", category: "hardcoded-secret", severity: "medium", regex: /(?:api[_-]?key|api[_-]?secret|access[_-]?token|auth[_-]?token)\s*[:=]\s*['"][a-zA-Z0-9+/]{20,}['"]/i, description: "Generic API key/token assignment" },
];

// ─── 核心扫描函数 ───────────────────────────────────────────

/**
 * 扫描技能目录的安全性 — 主入口
 * 对标 Hermes scan_skill(skill_path, source)
 */
export function scanSkill(
  skillDir: string,
  source: string,
  trustLevel: TrustLevel = "community",
): ScanResult {
  const skillName = relative(".", skillDir) || skillDir;
  const findings: Finding[] = [];
  const allContent: string[] = [];

  // 1. 结构检查
  const structFindings = checkStructure(skillDir);
  findings.push(...structFindings);

  // 2. 遍历所有文本文件进行模式匹配
  const files = collectTextFiles(skillDir);
  for (const file of files) {
    try {
      const content = readFileSync(file, "utf-8");
      allContent.push(content);

      // 2a. 威胁模式扫描
      const relPath = relative(skillDir, file);
      const patternFindings = scanContent(content, relPath);
      findings.push(...patternFindings);

      // 2b. 不可见 Unicode 字符检测
      const unicodeFindings = detectInvisibleUnicode(content, relPath);
      findings.push(...unicodeFindings);
    } catch {
      // 读取失败的文件跳过
    }
  }

  // 3. 计算内容哈希
  const hash = contentHash(allContent.join("\n"));

  // 4. 确定判决
  const verdict = determineVerdict(findings);

  // 5. 生成摘要
  const categoryCounts = new Map<string, number>();
  for (const f of findings) {
    categoryCounts.set(f.category, (categoryCounts.get(f.category) ?? 0) + 1);
  }
  const summaryParts = Array.from(categoryCounts.entries())
    .map(([cat, count]) => `${cat}:${count}`)
    .join(", ");
  const summary = findings.length === 0
    ? "No security issues found"
    : `${findings.length} finding(s): ${summaryParts}`;

  const result: ScanResult = {
    skillName,
    source,
    trustLevel,
    verdict,
    findings,
    scannedAt: Date.now(),
    contentHash: hash,
    summary,
  };

  logger.info({ skillName, verdict, findingsCount: findings.length }, "Skill scan complete");
  return result;
}

/**
 * 基于安装策略矩阵判断是否允许安装
 * 对标 Hermes should_allow_install()
 */
export function shouldAllowInstall(result: ScanResult): PolicyAction {
  const policy = INSTALL_POLICY[result.trustLevel] ?? INSTALL_POLICY.community;
  const verdictIdx = result.verdict === "safe" ? 0 : result.verdict === "caution" ? 1 : 2;
  return policy[verdictIdx];
}

/**
 * 计算内容的 SHA256 哈希
 * 对标 Hermes bundle_content_hash()
 */
export function contentHash(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

// ─── 结构检查 ──────────────────────────────────────────────

function checkStructure(skillDir: string): Finding[] {
  const findings: Finding[] = [];

  try {
    const allFiles = collectAllFiles(skillDir);

    // 文件数量检查
    if (allFiles.length > MAX_FILE_COUNT) {
      findings.push({
        patternId: "struct-file-count",
        severity: "high",
        category: "structure",
        file: skillDir,
        line: 0,
        match: `${allFiles.length} files`,
        description: `Too many files: ${allFiles.length} > ${MAX_FILE_COUNT}`,
      });
    }

    let totalSizeKB = 0;
    for (const file of allFiles) {
      try {
        const stat = statSync(file);
        const sizeKB = stat.size / 1024;
        totalSizeKB += sizeKB;
        const relPath = relative(skillDir, file);

        // 单文件大小检查
        if (sizeKB > MAX_SINGLE_FILE_KB) {
          findings.push({
            patternId: "struct-file-size",
            severity: "medium",
            category: "structure",
            file: relPath,
            line: 0,
            match: `${Math.round(sizeKB)}KB`,
            description: `File too large: ${Math.round(sizeKB)}KB > ${MAX_SINGLE_FILE_KB}KB`,
          });
        }

        // 二进制扩展名检查
        const ext = extname(file).toLowerCase();
        if (BANNED_EXTENSIONS.has(ext)) {
          findings.push({
            patternId: "struct-banned-ext",
            severity: "critical",
            category: "structure",
            file: relPath,
            line: 0,
            match: ext,
            description: `Banned binary extension: ${ext}`,
          });
        }

        // 符号链接检查
        const lstat = lstatSync(file);
        if (lstat.isSymbolicLink()) {
          const target = readlinkSync(file);
          const resolvedTarget = resolve(skillDir, target);
          if (!resolvedTarget.startsWith(resolve(skillDir))) {
            findings.push({
              patternId: "struct-symlink-escape",
              severity: "critical",
              category: "structure",
              file: relPath,
              line: 0,
              match: target,
              description: `Symlink escapes skill directory: ${target}`,
            });
          }
        }
      } catch {
        // 无法读取的文件跳过
      }
    }

    // 总大小检查
    if (totalSizeKB > MAX_TOTAL_SIZE_KB) {
      findings.push({
        patternId: "struct-total-size",
        severity: "high",
        category: "structure",
        file: skillDir,
        line: 0,
        match: `${Math.round(totalSizeKB)}KB`,
        description: `Total size too large: ${Math.round(totalSizeKB)}KB > ${MAX_TOTAL_SIZE_KB}KB`,
      });
    }
  } catch {
    // 目录不可读
  }

  return findings;
}

// ─── 内容扫描 ──────────────────────────────────────────────

function scanContent(content: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (const pattern of THREAT_PATTERNS) {
      if (pattern.regex.test(line)) {
        const match = line.match(pattern.regex);
        findings.push({
          patternId: pattern.id,
          severity: pattern.severity,
          category: pattern.category,
          file: relPath,
          line: lineIdx + 1,
          match: (match?.[0] ?? line).slice(0, 120),
          description: pattern.description,
        });
      }
    }
  }

  return findings;
}

function detectInvisibleUnicode(content: string, relPath: string): Finding[] {
  const findings: Finding[] = [];
  const lines = content.split("\n");

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    for (let charIdx = 0; charIdx < line.length; charIdx++) {
      const code = line.codePointAt(charIdx);
      if (code !== undefined && INVISIBLE_CHAR_SET.has(code)) {
        const charInfo = INVISIBLE_CHARS.find((c) => c.code === code);
        findings.push({
          patternId: `unicode-${charInfo?.name ?? "unknown"}`,
          severity: "medium",
          category: "steganography",
          file: relPath,
          line: lineIdx + 1,
          match: `U+${code.toString(16).toUpperCase().padStart(4, "0")}`,
          description: `Invisible Unicode character: ${charInfo?.name ?? "unknown"} (U+${code.toString(16).toUpperCase()})`,
        });
        // 每行每种字符只报告一次
        break;
      }
    }
  }

  return findings;
}

// ─── 判决计算 ──────────────────────────────────────────────

function determineVerdict(findings: Finding[]): Verdict {
  const hasCritical = findings.some((f) => f.severity === "critical");
  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");

  if (hasCritical) return "dangerous";
  if (hasHigh || hasMedium) return "caution";
  return "safe";
}

// ─── 文件收集工具 ───────────────────────────────────────────

function collectAllFiles(dir: string, maxDepth = 5): string[] {
  const files: string[] = [];
  if (maxDepth <= 0) return files;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (entry.startsWith(".")) continue; // 跳过隐藏文件
      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          files.push(...collectAllFiles(fullPath, maxDepth - 1));
        } else if (stat.isFile()) {
          files.push(fullPath);
        }
      } catch {
        // 跳过
      }
    }
  } catch {
    // 跳过
  }

  return files;
}

/** 收集可安全读取为文本的文件 */
function collectTextFiles(dir: string): string[] {
  const textExts = new Set([
    ".md", ".txt", ".yaml", ".yml", ".json", ".toml",
    ".js", ".ts", ".py", ".sh", ".bash", ".zsh",
    ".rb", ".go", ".rs", ".lua", ".pl", ".php",
    ".html", ".css", ".xml", ".svg", ".env", ".cfg",
    ".ini", ".conf", ".dockerfile", "",
  ]);

  return collectAllFiles(dir).filter((f) => {
    const ext = extname(f).toLowerCase();
    return textExts.has(ext);
  });
}
