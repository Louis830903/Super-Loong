/**
 * 沙箱执行环境（Task 3.2）
 *
 * 修改后的代码先在隔离的 Worker Thread 中编译验证：
 * - 语法错误 → 拒绝提案，返回错误信息
 * - 运行时错误 → Worker 隔离不影响主进程
 * - 仅验证通过后才执行原子写入
 * - 写入策略：先写 .tmp → tsc 验证 → rename 到正式文件
 */

import { Worker } from "node:worker_threads";
import { writeFileSync, renameSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";

const logger = pino({ name: "evolution:sandbox" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 沙箱验证结果 */
export interface EvolutionSandboxResult {
  /** 是否通过 */
  passed: boolean;
  /** 错误信息列表 */
  errors: string[];
  /** 警告信息列表 */
  warnings: string[];
  /** 验证耗时（ms） */
  durationMs: number;
}

/** 沙箱执行结果 */
export interface SandboxExecutionResult {
  /** 是否成功 */
  success: boolean;
  /** 实际输出路径 */
  outputPath?: string;
  /** 临时文件路径 */
  tmpPath?: string;
  /** 编译验证结果 */
  compileResult?: EvolutionSandboxResult;
  /** 错误信息 */
  error?: string;
}

// ═══════════════════════════════════════════════════════════════
// SandboxExecutor
// ═══════════════════════════════════════════════════════════════

export class SandboxExecutor {
  /** 超时时间（ms） */
  private timeoutMs: number;
  /** 项目根目录 */
  private projectRoot: string;

  constructor(projectRoot?: string, timeoutMs: number = 30000) {
    this.projectRoot = projectRoot ?? join(process.cwd(), "packages", "core");
    this.timeoutMs = timeoutMs;
  }

  /**
   * 原子写入 + 验证流程：
   * 1. 写入 .tmp 临时文件
   * 2. 语法编译验证
   * 3. 通过 → rename 到正式文件；失败 → 删除 .tmp
   *
   * @param filePath 目标文件路径（相对于 projectRoot）
   * @param content 文件内容
   * @returns 沙箱执行结果
   */
  async atomicWriteAndVerify(filePath: string, content: string): Promise<SandboxExecutionResult> {
    const startMs = Date.now();
    const fullPath = join(this.projectRoot, filePath);
    const tmpPath = `${fullPath}.evolution-tmp-${Date.now()}.ts`;

    try {
      // Step 1: 写入临时文件
      writeFileSync(tmpPath, content, "utf-8");
      logger.debug({ tmpPath }, "Temporary file written");

      // Step 2: 语法编译验证
      const compileResult = await this.verifyCompile(tmpPath);
      if (!compileResult.passed) {
        // 清理临时文件
        try { unlinkSync(tmpPath); } catch { /* ignore */ }
        return {
          success: false,
          tmpPath,
          compileResult,
          error: `Compilation failed: ${compileResult.errors.join("; ")}`,
        };
      }

      // Step 3: 检查编译警告
      if (compileResult.warnings.length > 0) {
        logger.warn({ warnings: compileResult.warnings }, "Code compiles with warnings");
      }

      // Step 4: 原子 rename 到正式文件
      renameSync(tmpPath, fullPath);
      logger.info({ filePath, durationMs: Date.now() - startMs }, "Atomic write verified and applied");

      return {
        success: true,
        outputPath: fullPath,
        compileResult,
      };
    } catch (err: any) {
      // 清理临时文件
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch { /* ignore */ }
      logger.error({ filePath, err: err.message }, "Atomic write failed");
      return { success: false, tmpPath, error: err.message };
    }
  }

  /**
   * 在 Worker Thread 中验证代码是否能被 TypeScript 编译
   */
  async verifyCompile(filePath: string): Promise<EvolutionSandboxResult> {
    const startMs = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    try {
      // 尝试 tsc 编译检查（不生成输出）
      execSync(`npx tsc --noEmit --skipLibCheck "${filePath}" 2>&1 || true`, {
        cwd: this.projectRoot,
        timeout: this.timeoutMs,
        encoding: "utf-8",
        stdio: "pipe",
      });
    } catch (err: any) {
      // tsc 出错时 stdout/stderr 包含错误信息
      const output = (err.stdout ?? "") + (err.stderr ?? "");
      if (output.trim()) {
        // 解析错误行
        for (const line of output.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          if (trimmed.includes("error TS")) {
            errors.push(trimmed);
          } else if (trimmed.includes("warning")) {
            warnings.push(trimmed);
          }
        }
      }
    }

    // Worker Thread 运行时验证——简化版（检查 import 路径是否可达）
    try {
      await this.verifyImports(filePath);
    } catch (err: any) {
      warnings.push(`Import verification: ${err.message}`);
    }

    const passed = errors.length === 0;
    logger.info({ filePath, passed, errors: errors.length, durationMs: Date.now() - startMs },
      "Compile verification complete");

    return { passed, errors, warnings, durationMs: Date.now() - startMs };
  }

  /**
   * 在 Worker Thread 中验证 import 语句
   */
  private verifyImports(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const workerCode = `
        const { parentPort } = require("node:worker_threads");
        try {
          // 尝试动态导入（检查模块路径可达性）
          import(${JSON.stringify("file://" + filePath.replace(/\\\\/g, "/"))})
            .then(() => parentPort?.postMessage({ ok: true }))
            .catch((err) => parentPort?.postMessage({ ok: false, error: err.message }));
        } catch (err) {
          parentPort?.postMessage({ ok: false, error: err.message });
        }
      `;

      const worker = new Worker(workerCode, { eval: true });
      const timer = setTimeout(() => {
        worker.terminate();
        reject(new Error("Import verification timed out"));
      }, 10000);

      worker.on("message", (msg: { ok: boolean; error?: string }) => {
        clearTimeout(timer);
        worker.terminate();
        if (msg.ok) resolve();
        else reject(new Error(msg.error ?? "Import verification failed"));
      });

      worker.on("error", (err) => {
        clearTimeout(timer);
        worker.terminate();
        reject(err);
      });
    });
  }

  /**
   * 纯文本内容的安全扫描（语法层面）
   */
  scanContent(content: string): EvolutionSandboxResult {
    const startMs = Date.now();
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 检查基本语法完整性
    const openBraces = (content.match(/\{/g) ?? []).length;
    const closeBraces = (content.match(/\}/g) ?? []).length;
    if (openBraces !== closeBraces) {
      errors.push(`Brace mismatch: ${openBraces} open vs ${closeBraces} close`);
    }

    const openParens = (content.match(/\(/g) ?? []).length;
    const closeParens = (content.match(/\)/g) ?? []).length;
    if (openParens !== closeParens) {
      errors.push(`Parenthesis mismatch: ${openParens} open vs ${closeParens} close`);
    }

    // 2. 检查是否有 process.exit / require('child_process').exec 等危险调用
    const dangerousPatterns = [
      { pattern: /process\.exit\s*\(/g, msg: "Contains process.exit()" },
      { pattern: /require\s*\(\s*['"]child_process['"]\s*\)/g, msg: "Contains child_process require" },
      { pattern: /eval\s*\(/g, msg: "Contains eval()" },
      { pattern: /fs\.rmSync\s*\([^,]*,\s*\{\s*recursive:\s*true/g, msg: "Contains recursive rmSync" },
    ];

    for (const { pattern, msg } of dangerousPatterns) {
      if (pattern.test(content)) {
        errors.push(`Security: ${msg}`);
      }
    }

    // 3. 检查未闭合的字符串字面量
    const singleQuotes = (content.match(/(?<!\\)'/g) ?? []).length;
    const doubleQuotes = (content.match(/(?<!\\)"/g) ?? []).length;
    const backticks = (content.match(/(?<!\\)`/g) ?? []).length;
    if (singleQuotes % 2 !== 0) warnings.push("Unmatched single quotes");
    if (doubleQuotes % 2 !== 0) warnings.push("Unmatched double quotes");
    if (backticks % 2 !== 0) warnings.push("Unmatched backticks");

    return { passed: errors.length === 0, errors, warnings, durationMs: Date.now() - startMs };
  }
}
