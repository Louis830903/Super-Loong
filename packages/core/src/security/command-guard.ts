/**
 * Command Guard — 危险命令检测器
 *
 * 独立的纯函数模块，不修改 SecurityManager.checkPermission()。
 * 仅被 terminal 工具内部调用:
 *   terminal.execute() → CommandGuard.check(cmd) → 拦或放 → spawn()
 *
 * 42条危险模式规则 (参考 hermes-agent/tools/approval.py L75-L133):
 * - 删除操作 (5条)
 * - 权限修改 (4条)
 * - 系统破坏 (3条)
 * - 数据库 (3条)
 * - 系统配置 (5条)
 * - 服务管理 (1条)
 * - 进程危险 (2条)
 * - 恶意模式 (1条)
 * - 远程代码执行 (5条)
 * - 自我保护 (5条)
 * - Git破坏 (5条)
 * - 敏感写入 (3条)
 *
 * 检测流程:
 * 1. 输入规范化: ANSI剥离 + null字节移除 + Unicode NFKC
 * 2. 小写转换
 * 3. 正则逐条匹配
 * 4. 返回 { isDangerous, category, description, patternKey }
 */

import pino from "pino";
import { stripAnsi, normalizeUnicode } from "../tools/output-processor.js";

const logger = pino({ name: "command-guard" });

// ─── 类型定义 ──────────────────────────────────────────────

/** 危险等级 */
export type DangerLevel = "critical" | "high" | "medium";

/** 危险模式分类 */
export type DangerCategory =
  | "deletion"
  | "permission"
  | "system_destroy"
  | "database"
  | "system_config"
  | "service"
  | "process"
  | "malicious"
  | "remote_exec"
  | "self_protection"
  | "git_destructive"
  | "sensitive_write";

/** 危险命令检测结果 */
export interface CommandGuardResult {
  /** 命令是否危险 */
  isDangerous: boolean;
  /** 匹配的危险分类 */
  category?: DangerCategory;
  /** 人类可读的危险描述 */
  description?: string;
  /** 模式键名(用于审批白名单匹配) */
  patternKey?: string;
  /** 危险等级 */
  level?: DangerLevel;
}

/** 内部危险模式定义 */
interface DangerPattern {
  key: string;
  pattern: RegExp;
  category: DangerCategory;
  description: string;
  level: DangerLevel;
}

// ─── 敏感路径定义 ──────────────────────────────────────────

/** 敏感写入目标 — 参考 Hermes _SENSITIVE_WRITE_TARGET */
const SENSITIVE_PATHS = [
  "/etc/", "/boot/", "/usr/", "/sbin/", "/lib/",
  "/sys/", "/dev/",
  "~/.ssh/", "~/.gnupg/", "~/.config/",
  "/root/", "C:\\Windows\\", "C:\\Program Files\\",
];

/** 构建敏感路径匹配正则 */
const SENSITIVE_PATH_PATTERN = new RegExp(
  SENSITIVE_PATHS.map(p => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
  "i",
);

// ─── 42条危险模式规则 ──────────────────────────────────────

const DANGER_PATTERNS: DangerPattern[] = [
  // ── 删除操作 (5条) ──
  {
    key: "rm_recursive",
    pattern: /\brm\b.*(-r|--recursive|-rf|-fr)/i,
    category: "deletion",
    description: "递归删除文件/目录 (rm -r)",
    level: "critical",
  },
  {
    key: "find_delete",
    pattern: /\bfind\b.*-delete/i,
    category: "deletion",
    description: "find命令批量删除",
    level: "critical",
  },
  {
    key: "find_exec_rm",
    pattern: /\bfind\b.*-exec\s+rm/i,
    category: "deletion",
    description: "find -exec rm 批量删除",
    level: "critical",
  },
  {
    key: "xargs_rm",
    pattern: /\bxargs\b.*\brm\b/i,
    category: "deletion",
    description: "xargs管道删除",
    level: "high",
  },
  {
    key: "shred",
    pattern: /\bshred\b/i,
    category: "deletion",
    description: "安全擦除文件(不可恢复)",
    level: "critical",
  },

  // ── 权限修改 (4条) ──
  {
    key: "chmod_world_writable",
    pattern: /\bchmod\b.*(777|666|o\+w)/i,
    category: "permission",
    description: "设置全局可写权限",
    level: "high",
  },
  {
    key: "chmod_recursive",
    pattern: /\bchmod\b.*(-R|--recursive)/i,
    category: "permission",
    description: "递归修改权限",
    level: "high",
  },
  {
    key: "chown_recursive_root",
    pattern: /\bchown\b.*(-R|--recursive).*\broot\b/i,
    category: "permission",
    description: "递归修改所有权为root",
    level: "critical",
  },
  {
    key: "chown_root",
    pattern: /\bchown\b.*\broot\b/i,
    category: "permission",
    description: "修改所有权为root",
    level: "high",
  },

  // ── 系统破坏 (3条) ──
  {
    key: "mkfs",
    pattern: /\bmkfs\b/i,
    category: "system_destroy",
    description: "格式化文件系统",
    level: "critical",
  },
  {
    key: "dd_if",
    pattern: /\bdd\b.*\bif=/i,
    category: "system_destroy",
    description: "dd直接写入设备(可能覆盖磁盘)",
    level: "critical",
  },
  {
    key: "write_dev",
    pattern: />\s*\/dev\/sd[a-z]/i,
    category: "system_destroy",
    description: "直接写入磁盘设备",
    level: "critical",
  },

  // ── 数据库 (3条) ──
  {
    key: "drop_table_db",
    pattern: /\b(drop\s+table|drop\s+database)\b/i,
    category: "database",
    description: "删除数据库表或数据库",
    level: "critical",
  },
  {
    key: "delete_no_where",
    pattern: /\bdelete\s+from\b(?!.*\bwhere\b)/i,
    category: "database",
    description: "DELETE无WHERE条件(全表删除)",
    level: "critical",
  },
  {
    key: "truncate_table",
    pattern: /\btruncate\s+table\b/i,
    category: "database",
    description: "清空数据库表",
    level: "critical",
  },

  // ── 系统配置 (5条) ──
  {
    key: "redirect_etc",
    pattern: />\s*\/etc\//i,
    category: "system_config",
    description: "重定向输出到/etc/目录",
    level: "critical",
  },
  {
    key: "tee_sensitive",
    pattern: /\btee\b.*\/(etc|boot|usr)\//i,
    category: "system_config",
    description: "tee写入系统目录",
    level: "critical",
  },
  {
    key: "cp_mv_etc",
    pattern: /\b(cp|mv|install)\b.*\/(etc|boot)\//i,
    category: "system_config",
    description: "复制/移动文件到系统目录",
    level: "high",
  },
  {
    key: "sed_inplace_etc",
    pattern: /\bsed\b.*-i.*\/(etc|boot)\//i,
    category: "system_config",
    description: "就地编辑系统配置文件",
    level: "high",
  },
  {
    key: "visudo_passwd",
    pattern: /\b(visudo|vipw)\b/i,
    category: "system_config",
    description: "编辑sudoers/passwd文件",
    level: "critical",
  },

  // ── 服务管理 (1条) ──
  {
    key: "systemctl_stop",
    pattern: /\bsystemctl\s+(stop|disable|mask)\b/i,
    category: "service",
    description: "停止/禁用系统服务",
    level: "high",
  },

  // ── 进程危险 (2条) ──
  {
    key: "kill_all",
    pattern: /\bkill\s+-9\s+-1\b/i,
    category: "process",
    description: "杀死所有进程 (kill -9 -1)",
    level: "critical",
  },
  {
    key: "pkill_force",
    pattern: /\bpkill\s+-9\b/i,
    category: "process",
    description: "强制杀死匹配进程",
    level: "high",
  },

  // ── 恶意模式 (1条) ──
  {
    key: "fork_bomb",
    pattern: /:\(\)\s*\{\s*:\|\s*:&\s*\};\s*:/,
    category: "malicious",
    description: "Fork bomb (进程炸弹)",
    level: "critical",
  },

  // ── 远程代码执行 (5条) ──
  {
    key: "shell_eval",
    pattern: /\b(bash|sh|zsh|dash)\s+(-c|-lc)\b/i,
    category: "remote_exec",
    description: "通过shell -c执行字符串代码",
    level: "medium",
  },
  {
    key: "script_eval",
    pattern: /\b(python|python3|perl|ruby|node)\s+(-e|-c)\b/i,
    category: "remote_exec",
    description: "通过脚本语言执行内联代码",
    level: "medium",
  },
  {
    key: "curl_pipe_sh",
    pattern: /\bcurl\b.*\|\s*(bash|sh|zsh)/i,
    category: "remote_exec",
    description: "curl管道到shell执行(远程代码执行)",
    level: "critical",
  },
  {
    key: "bash_curl",
    pattern: /\b(bash|sh)\s+<\(\s*curl/i,
    category: "remote_exec",
    description: "进程替换执行远程脚本",
    level: "critical",
  },
  {
    key: "heredoc_exec",
    pattern: /<<\s*['"]?EOF/i,
    category: "remote_exec",
    description: "Here-doc脚本执行",
    level: "medium",
  },

  // ── 自我保护 (5条) ──
  {
    key: "kill_self_agent",
    pattern: /\bkill\b.*(hermes|super-agent|gateway|node)/i,
    category: "self_protection",
    description: "尝试杀死Agent/网关进程",
    level: "critical",
  },
  {
    key: "kill_pgrep",
    pattern: /\bkill\b.*\$\(pgrep/i,
    category: "self_protection",
    description: "通过pgrep动态杀进程",
    level: "high",
  },
  {
    key: "chmod_exec",
    pattern: /\bchmod\b.*\+x\b.*&&/i,
    category: "self_protection",
    description: "赋予执行权限后立即执行",
    level: "high",
  },
  {
    key: "gateway_run",
    pattern: /\bgateway\b.*\brun\b/i,
    category: "self_protection",
    description: "尝试脱管运行网关",
    level: "high",
  },
  {
    key: "nohup_disown",
    pattern: /\b(nohup|disown)\b/i,
    category: "self_protection",
    description: "脱离控制的后台进程",
    level: "medium",
  },

  // ── Git破坏 (5条) ──
  {
    key: "git_reset_hard",
    pattern: /\bgit\s+reset\s+--hard\b/i,
    category: "git_destructive",
    description: "Git硬重置(丢弃所有未提交更改)",
    level: "high",
  },
  {
    key: "git_push_force",
    pattern: /\bgit\s+push\s+.*(-f|--force)\b/i,
    category: "git_destructive",
    description: "Git强制推送(覆盖远程历史)",
    level: "critical",
  },
  {
    key: "git_clean_force",
    pattern: /\bgit\s+clean\s+.*-f\b/i,
    category: "git_destructive",
    description: "Git强制清理未跟踪文件",
    level: "high",
  },
  {
    key: "git_branch_delete",
    pattern: /\bgit\s+branch\s+.*-D\b/,
    category: "git_destructive",
    description: "Git强制删除分支(大写-D不检查合并状态)",
    level: "high",
  },
  {
    key: "git_rebase",
    pattern: /\bgit\s+rebase\b/i,
    category: "git_destructive",
    description: "Git变基(可能改写历史)",
    level: "medium",
  },

  // ── 敏感写入 (3条) ──
  {
    key: "redirect_sensitive",
    pattern: />\s*(~\/\.ssh|~\/\.gnupg|~\/\.config)/i,
    category: "sensitive_write",
    description: "重定向到敏感用户目录",
    level: "critical",
  },
  {
    key: "write_ssh_keys",
    pattern: /\b(ssh-keygen|ssh-add)\b.*(-f|>)/i,
    category: "sensitive_write",
    description: "写入SSH密钥文件",
    level: "high",
  },
  {
    key: "write_crontab",
    pattern: /\bcrontab\b.*(-e|-r|<|>)/i,
    category: "sensitive_write",
    description: "修改定时任务(crontab)",
    level: "high",
  },
];

// ─── 核心检测函数 ──────────────────────────────────────────

/**
 * 规范化命令文本 — 预处理后再做模式匹配
 *
 * 参考 Hermes _normalize_command_for_detection():
 * 1. ANSI转义剥离 (tools.ansi_strip)
 * 2. null字节移除
 * 3. Unicode NFKC规范化
 */
function normalizeCommand(command: string): string {
  let normalized = command;

  // Step 1: ANSI剥离
  normalized = stripAnsi(normalized);

  // Step 2: null字节移除
  normalized = normalized.replace(/\0/g, "");

  // Step 3: Unicode NFKC规范化 (防止全宽字符绕过)
  normalized = normalizeUnicode(normalized);

  return normalized;
}

/**
 * 检测命令是否危险
 *
 * 纯函数 — 不产生副作用，不修改任何外部状态。
 * 仅被 terminal 工具的 execute() 内部调用。
 *
 * @param command 要检测的命令字符串
 * @returns 检测结果
 */
export function checkCommand(command: string): CommandGuardResult {
  // Step 1: 输入规范化
  const normalized = normalizeCommand(command);

  // Step 2: 小写转换用于匹配(但保留原始用于日志)
  const commandLower = normalized.toLowerCase();

  // Step 3: 逐条匹配危险模式
  for (const dp of DANGER_PATTERNS) {
    // 注意: 某些模式需要大小写敏感(如 git branch -D)
    const testStr = dp.pattern.flags.includes("i") ? commandLower : normalized;
    if (dp.pattern.test(testStr)) {
      logger.warn(
        { command: command.slice(0, 100), pattern: dp.key, category: dp.category },
        "检测到危险命令",
      );

      return {
        isDangerous: true,
        category: dp.category,
        description: dp.description,
        patternKey: dp.key,
        level: dp.level,
      };
    }
  }

  // Step 4: 额外检查 — 敏感路径写入
  if (SENSITIVE_PATH_PATTERN.test(normalized) && />\s*|tee\s+|cp\s+|mv\s+|install\s+/.test(normalized)) {
    return {
      isDangerous: true,
      category: "sensitive_write",
      description: "检测到向敏感路径的写入操作",
      patternKey: "generic_sensitive_write",
      level: "high",
    };
  }

  return { isDangerous: false };
}

/**
 * 批量检测多条命令
 * 用于检测通过 && 或 ; 连接的复合命令
 *
 * @param commands 命令列表
 * @returns 第一个危险命令的检测结果，全部安全返回 { isDangerous: false }
 */
export function checkCommands(commands: string[]): CommandGuardResult {
  for (const cmd of commands) {
    const result = checkCommand(cmd);
    if (result.isDangerous) return result;
  }
  return { isDangerous: false };
}

/**
 * 从复合命令中拆分子命令
 * 处理 &&, ||, ;, | 等连接符
 */
export function splitCompoundCommand(command: string): string[] {
  // 引号感知拆分 — 在单/双引号内的 &&、||、; 不做拆分
  // 采用保守策略：仅识别完整引号对，引号不平衡时不拆分（安全优先）
  const parts: string[] = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    // 处理转义字符：反斜杠后的字符原样保留
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      // 单引号内反斜杠不转义（Shell 语义）
      current += ch;
      escaped = true;
      continue;
    }

    // 引号状态切换
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
      continue;
    }

    // 仅在引号外才识别分隔符
    if (!inSingle && !inDouble) {
      // 检测 &&
      if (ch === "&" && command[i + 1] === "&") {
        parts.push(current.trim());
        current = "";
        i++; // 跳过第二个 &
        continue;
      }
      // 检测 ||
      if (ch === "|" && command[i + 1] === "|") {
        parts.push(current.trim());
        current = "";
        i++; // 跳过第二个 |
        continue;
      }
      // 检测 ;
      if (ch === ";") {
        parts.push(current.trim());
        current = "";
        continue;
      }
    }

    current += ch;
  }

  // 收尾：最后一段命令
  if (current.trim()) {
    parts.push(current.trim());
  }

  return parts.filter(s => s.length > 0);
}

/**
 * 检测复合命令（自动拆分后逐一检查）
 */
export function checkCompoundCommand(command: string): CommandGuardResult {
  const subCommands = splitCompoundCommand(command);
  return checkCommands(subCommands);
}

/**
 * 获取所有危险模式的描述列表（用于文档/调试）
 */
export function listDangerPatterns(): Array<{ key: string; category: string; description: string; level: string }> {
  return DANGER_PATTERNS.map(p => ({
    key: p.key,
    category: p.category,
    description: p.description,
    level: p.level,
  }));
}
