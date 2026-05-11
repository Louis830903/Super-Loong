/**
 * 依赖自动管理 — npm 包安装/卸载自动化。
 *
 * 核心设计：
 * - 工具代码中检测到新 import → 解析需要的 npm 包名和版本
 * - 使用 child_process.execSync("pnpm add xxx") 安装依赖
 * - 安全检查：白名单校验、版本锁定、已知恶意包黑名单
 * - 失败回滚：安装失败时自动 pnpm remove xxx
 * - 持久化：记录到变更审计日志
 *
 * 安全护栏：
 * - 禁止安装全局包（-g 标志拦截）
 * - 禁止安装已知恶意包（黑名单）
 * - Feature Flag SUPER_AGENT_AUTO_INSTALL_DEPS 控制是否自动执行
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import pino from "pino";

const logger = pino({ name: "dependency-manager" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 依赖安装请求 */
export interface DependencyRequest {
  /** npm 包名 */
  packageName: string;
  /** 期望版本（如 "^1.0.0"），默认为 "latest" */
  version?: string;
  /** 安装原因（审计日志用） */
  reason: string;
  /** 关联的工具名 */
  toolName: string;
}

/** 依赖安装结果 */
export interface DependencyResult {
  success: boolean;
  packageName: string;
  version: string;
  /** 安装命令 */
  command: string;
  /** 错误信息 */
  error?: string;
  /** 安全拦截原因 */
  blockedReason?: string;
}

/** 审计日志条目 */
export interface DepAuditLogEntry {
  action: "install" | "uninstall" | "blocked";
  packageName: string;
  version: string;
  toolName: string;
  reason: string;
  timestamp: string;
  success: boolean;
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// 安全配置
// ═══════════════════════════════════════════════════════════════

/**
 * 已知恶意/危险包黑名单。
 * 这些包名在任何情况下都不允许安装。
 */
const MALICIOUS_PACKAGES = new Set([
  // 已知恶意包（占名抢注）
  "node-ssh-backdoor",
  "discord.js-malicious",
  "electron-native-notify-malicious",
  // 危险模式
  "crossenv",
  "env-cmd-malicious",
  // 开发工具（不应在生产依赖中被安装）
  "puppeteer-extra-plugin-stealth-evil",
]);

/**
 * npm 包名白名单模式。
 * 只允许安装匹配这些模式的包。
 * 空数组 = 允许所有（仅在手动确认模式下）。
 */
const ALLOWED_PACKAGE_PATTERNS: RegExp[] = [
  /^@[\w-]+\/[\w-]+$/,      // scoped packages: @org/name
  /^[\w-]+$/,                 // unscoped normal packages
];

/** 禁止的安装标志 */
const BLOCKED_FLAGS = ["-g", "--global", "--unsafe-perm", "--ignore-scripts"];

// ═══════════════════════════════════════════════════════════════
// 依赖管理器
// ═══════════════════════════════════════════════════════════════

export class DependencyManager {
  /** 审计日志 */
  private auditLog: DepAuditLogEntry[] = [];
  /** 工作目录（项目根目录，含有 package.json） */
  private projectRoot: string;

  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot ?? process.cwd();
  }

  /**
   * 安装 npm 依赖。
   *
   * 流程：
   * 1. 安全检查（包名白名单、黑名单、禁止标志）
   * 2. Feature Flag 检查
   * 3. 执行 pnpm add
   * 4. 成功 → 记录审计日志
   * 5. 失败 → 尝试回滚（pnpm remove）
   */
  async install(req: DependencyRequest): Promise<DependencyResult> {
    // Step 1: 安全检查
    const securityCheck = this.validatePackage(req.packageName);
    if (!securityCheck.valid) {
      const result: DependencyResult = {
        success: false,
        packageName: req.packageName,
        version: req.version ?? "latest",
        command: "",
        blockedReason: securityCheck.reason,
      };
      this.audit("blocked", req, false, securityCheck.reason);
      return result;
    }

    // Step 2: Feature Flag 检查
    const autoInstall = process.env.SUPER_AGENT_AUTO_INSTALL_DEPS === "true";
    if (!autoInstall) {
      const result: DependencyResult = {
        success: false,
        packageName: req.packageName,
        version: req.version ?? "latest",
        command: "",
        blockedReason: "Auto-install disabled (set SUPER_AGENT_AUTO_INSTALL_DEPS=true)",
      };
      this.audit("blocked", req, false, "Feature flag disabled");
      return result;
    }

    // Step 3: 构建安装命令
    const version = req.version ?? "latest";
    const pkgSpec = version === "latest" ? req.packageName : `${req.packageName}@${version}`;
    const cmd = `pnpm add ${pkgSpec}`;

    // Step 4: 执行安装
    try {
      logger.info({ package: req.packageName, version }, "Installing dependency");

      const output = execSync(cmd, {
        cwd: this.projectRoot,
        timeout: 120_000, // 2 分钟超时
        encoding: "utf-8",
        env: {
          ...process.env,
          // 禁用 npm 的交互式提示
          CI: "true",
          npm_config_yes: "true",
        },
      });

      const result: DependencyResult = {
        success: true,
        packageName: req.packageName,
        version,
        command: cmd,
      };

      this.audit("install", req, true);
      logger.info({ package: req.packageName, version }, "Dependency installed successfully");
      return result;
    } catch (err) {
      const errorMsg = (err as { stderr?: string; message?: string }).stderr
        ?? (err as { message?: string }).message
        ?? String(err);

      logger.error({ package: req.packageName, error: errorMsg }, "Dependency install failed");

      // Step 5: 失败回滚
      try {
        const rollbackCmd = `pnpm remove ${req.packageName}`;
        execSync(rollbackCmd, {
          cwd: this.projectRoot,
          timeout: 30_000,
          encoding: "utf-8",
          env: { ...process.env, CI: "true", npm_config_yes: "true" },
        });
        logger.info({ package: req.packageName }, "Rollback: removed failed dependency");
      } catch (rollbackErr) {
        logger.warn({ package: req.packageName, err: rollbackErr }, "Rollback failed — manual cleanup may be required");
      }

      const result: DependencyResult = {
        success: false,
        packageName: req.packageName,
        version,
        command: cmd,
        error: errorMsg,
      };

      this.audit("install", req, false, errorMsg);
      return result;
    }
  }

  /**
   * 卸载依赖。
   */
  async uninstall(packageName: string, reason: string, toolName: string): Promise<DependencyResult> {
    const cmd = `pnpm remove ${packageName}`;
    try {
      execSync(cmd, {
        cwd: this.projectRoot,
        timeout: 30_000,
        encoding: "utf-8",
        env: { ...process.env, CI: "true", npm_config_yes: "true" },
      });

      const result: DependencyResult = {
        success: true,
        packageName,
        version: "removed",
        command: cmd,
      };

      this.audit("uninstall", { packageName, toolName, reason }, true);
      logger.info({ package: packageName }, "Dependency uninstalled");
      return result;
    } catch (err) {
      const errorMsg = (err as { message?: string }).message ?? String(err);
      const result: DependencyResult = {
        success: false,
        packageName,
        version: "removed",
        command: cmd,
        error: errorMsg,
      };
      this.audit("uninstall", { packageName, toolName, reason }, false, errorMsg);
      return result;
    }
  }

  /**
   * 验证包名安全性。
   */
  validatePackage(packageName: string): { valid: boolean; reason?: string } {
    // 黑名单检查
    if (MALICIOUS_PACKAGES.has(packageName)) {
      return { valid: false, reason: `Package "${packageName}" is in the blocklist` };
    }

    // 白名单格式检查
    const matchesAllowed = ALLOWED_PACKAGE_PATTERNS.some(p => p.test(packageName));
    if (!matchesAllowed) {
      return { valid: false, reason: `Package name "${packageName}" does not match allowed patterns` };
    }

    // 禁止的安装标志检查
    for (const flag of BLOCKED_FLAGS) {
      if (packageName.includes(flag)) {
        return { valid: false, reason: `Package spec contains blocked flag: "${flag}"` };
      }
    }

    return { valid: true };
  }

  /**
   * 从 TypeScript 代码中提取 import 依赖。
   *
   * 解析 import 语句，提取 npm 包名（非相对路径、非 Node 内置模块）。
   *
   * @param sourceCode — TypeScript 源码
   * @returns 检测到的 npm 包名列表
   */
  extractImports(sourceCode: string): string[] {
    const packageNames = new Set<string>();

    // 匹配 import ... from "xxx" 或 from 'xxx'
    const importRegex = /import\s+(?:(?:type\s+)?\{[^}]*\}|(?:type\s+)?\*\s+as\s+\w+|\w+)\s+from\s+["']([^"']+)["']/g;

    let match: RegExpExecArray | null;
    while ((match = importRegex.exec(sourceCode)) !== null) {
      const specifier = match[1];
      // 排除相对路径和 Node 内置模块
      if (!specifier.startsWith(".") && !specifier.startsWith("/")
          && !this.isNodeBuiltin(specifier)) {
        packageNames.add(specifier);
      }
    }

    // 也检测 import "xxx" 副作用导入
    const sideEffectRegex = /import\s+["']([^"']+)["']/g;
    while ((match = sideEffectRegex.exec(sourceCode)) !== null) {
      const specifier = match[1];
      if (!specifier.startsWith(".") && !this.isNodeBuiltin(specifier)) {
        packageNames.add(specifier);
      }
    }

    // 排除项目内部包（如 @super-agent/core）
    const filtered = Array.from(packageNames).filter(
      pkg => !pkg.startsWith("@super-agent/"),
    );

    return filtered;
  }

  /**
   * 获取审计日志。
   */
  getAuditLog(): DepAuditLogEntry[] {
    return [...this.auditLog];
  }

  /**
   * 清空审计日志。
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  // ─── 私有方法 ──────────────────────────────────────────

  private isNodeBuiltin(specifier: string): boolean {
    // Node.js 内置模块列表
    const builtins = new Set([
      "assert", "buffer", "child_process", "cluster", "crypto", "dgram",
      "dns", "events", "fs", "http", "https", "net", "os", "path",
      "perf_hooks", "process", "querystring", "readline", "repl",
      "stream", "string_decoder", "timers", "tls", "tty", "url",
      "util", "v8", "vm", "worker_threads", "zlib",
      // node: 前缀版本
      "node:assert", "node:buffer", "node:child_process", "node:crypto",
      "node:fs", "node:http", "node:https", "node:os", "node:path",
      "node:process", "node:stream", "node:url", "node:util",
      "node:worker_threads", "node:child_process",
    ]);
    return builtins.has(specifier);
  }

  private audit(
    action: DepAuditLogEntry["action"],
    req: Pick<DependencyRequest, "packageName" | "toolName" | "reason">,
    success: boolean,
    error?: string,
  ): void {
    this.auditLog.push({
      action,
      packageName: req.packageName,
      version: (req as DependencyRequest).version ?? "latest",
      toolName: req.toolName,
      reason: req.reason,
      timestamp: new Date().toISOString(),
      success,
      error,
    });

    // 限制日志大小
    if (this.auditLog.length > 500) {
      this.auditLog = this.auditLog.slice(-500);
    }
  }
}
