/**
 * 自修改引擎（Task 3.1 + Task 3.3）
 *
 * 借鉴 Gödel Agent 的 action_adjust_logic / action_environment_aware：
 * - 读取、修改、新增、删除 TypeScript 源码
 * - 自动快照（修改前备份）
 * - 自动回滚（成功率下降触发）
 * - 安全护栏：禁止修改核心通信方法
 *
 * 不依赖 ts-morph（降低引入风险），使用 Node.js 内置 fs 操作。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";

const logger = pino({ name: "evolution:self-modification" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 源码操作类型 */
export type CodeOperation = "modify" | "add" | "delete";

/** 源码修改请求 */
export interface CodeChangeRequest {
  /** 目标模块路径（相对于项目 src 目录） */
  modulePath: string;
  /** 目标函数/类/方法名 */
  targetName: string;
  /** 新代码（modify: 替换体; add: 完整函数） */
  newCode: string;
  /** 操作类型 */
  operation: CodeOperation;
  /** 提案 ID（用于审计追踪） */
  proposalId: string;
}

/** 源码修改结果 */
export interface CodeChangeResult {
  /** 是否成功 */
  success: boolean;
  /** 操作类型 */
  operation: CodeOperation;
  /** 快照 ID（用于回滚） */
  snapshotId?: string;
  /** 错误信息 */
  error?: string;
  /** 修改后的文件路径 */
  filePath?: string;
}

/** 源码快照 */
export interface CodeSnapshot {
  id: string;
  modulePath: string;
  targetName: string;
  operation: CodeOperation;
  /** 原始文件路径 */
  originalPath: string;
  /** 备份路径 */
  backupPath: string;
  /** 创建时间 */
  timestamp: string;
  /** 关联提案 ID */
  proposalId: string;
}

/** 模块清单项 */
export interface ModuleInfo {
  /** 模块路径 */
  path: string;
  /** 导出的函数/类/方法名 */
  exports: string[];
  /** 是否可修改 */
  modifiable: boolean;
}

// ═══════════════════════════════════════════════════════════════
// 安全护栏：禁止修改的核心方法
// ═══════════════════════════════════════════════════════════════

/**
 * 对标 Gödel Agent 第 132-135 行的拦截：
 * 禁止修改 LLM 调用、工具执行等核心通信方法。
 */
const FORBIDDEN_TARGETS: RegExp[] = [
  /action_call_llm/i,
  /execute_tool/i,
  /chat/i,
  /sendMessage/i,
  /agentRuntime/i,
  /processSandbox/i,
  /credentialVault/i,
];

/** 禁止修改的核心文件（审查修正：增加路径前缀边界） */
const FORBIDDEN_FILES: RegExp[] = [
  /(?:^|\/)security\/sandbox\.ts$/i,
  /(?:^|\/)security\/docker-sandbox\.ts$/i,
  /(?:^|\/)agent\/runtime\.ts$/i,
  /(?:^|\/)agent\/manager\.ts$/i,
  /(?:^|\/)llm\/index\.ts$/i,
];

// ═══════════════════════════════════════════════════════════════
// SelfModificationEngine
// ═══════════════════════════════════════════════════════════════

export class SelfModificationEngine {
  /** 项目 src 目录 */
  private srcDir: string;
  /** 快照备份目录 */
  private snapshotDir: string;
  /** 内存中的快照索引 */
  private snapshots: Map<string, CodeSnapshot> = new Map();

  constructor(srcDir?: string) {
    this.srcDir = srcDir ?? join(process.cwd(), "packages", "core", "src");
    this.snapshotDir = join(this.srcDir, "..", ".evolution-snapshots");
    this.ensureSnapshotDir();
  }

  // ─── Public API ──────────────────────────────────────────────

  /**
   * 读取指定模块的源码
   * @param modulePath 模块路径（相对于 srcDir）
   * @param targetName 目标函数/类名（可选，不传则返回整个文件）
   */
  readLogic(modulePath: string, targetName?: string): string {
    const fullPath = join(this.srcDir, modulePath);
    try {
      const content = readFileSync(fullPath, "utf-8");
      if (!targetName) return content;

      // 尝试提取指定函数的源码
      return this.extractFunction(content, targetName);
    } catch (err: any) {
      logger.warn({ modulePath, err: err.message }, "Failed to read module logic");
      return "";
    }
  }

  /**
   * 修改/新增/删除源码（对标 Gödel adjustLogic）
   */
  adjustLogic(request: CodeChangeRequest): CodeChangeResult {
    // 安全检查
    const safetyCheck = this.safetyCheck(request);
    if (!safetyCheck.pass) {
      return { success: false, operation: request.operation, error: safetyCheck.reason };
    }

    const fullPath = join(this.srcDir, request.modulePath);
    try {
      const originalContent = existsSync(fullPath) ? readFileSync(fullPath, "utf-8") : "";

      // 操作前快照
      const snapshotId = this.createSnapshot({
        modulePath: request.modulePath,
        targetName: request.targetName,
        operation: request.operation,
        originalPath: fullPath,
        proposalId: request.proposalId,
      });

      let newContent: string;

      switch (request.operation) {
        case "modify":
          newContent = this.applyModify(originalContent, request.targetName, request.newCode);
          break;
        case "add":
          newContent = this.applyAdd(originalContent, request.targetName, request.newCode);
          break;
        case "delete":
          newContent = this.applyDelete(originalContent, request.targetName);
          break;
        default:
          return { success: false, operation: request.operation, error: "Unknown operation" };
      }

      // 写入文件
      writeFileSync(fullPath, newContent, "utf-8");
      logger.info({ modulePath: request.modulePath, targetName: request.targetName, operation: request.operation },
        "Source code modified");

      return { success: true, operation: request.operation, snapshotId, filePath: fullPath };
    } catch (err: any) {
      logger.error({ modulePath: request.modulePath, err: err.message }, "Failed to adjust logic");
      return { success: false, operation: request.operation, error: err.message };
    }
  }

  /**
   * 回滚到指定版本（Task 3.3）
   * @param modulePath 模块路径
   * @param targetName 目标函数名
   * @param snapshotId 快照 ID（不传则回滚到最近一个快照）
   */
  rollback(modulePath: string, targetName: string, snapshotId?: string): CodeChangeResult {
    let snapshot: CodeSnapshot | undefined;

    if (snapshotId) {
      snapshot = this.snapshots.get(snapshotId);
    } else {
      // 找最近的快照
      const entries = Array.from(this.snapshots.values())
        .filter((s) => s.modulePath === modulePath && s.targetName === targetName)
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
      snapshot = entries[0];
    }

    if (!snapshot) {
      return { success: false, operation: "modify", error: "Snapshot not found" };
    }

    try {
      // 从备份恢复
      const targetPath = join(this.srcDir, modulePath);
      copyFileSync(snapshot.backupPath, targetPath);
      logger.info({ modulePath, targetName, snapshotId: snapshot.id, operation: snapshot.operation }, "Rollback completed");
      // 修正P2-1：使用快照中保存的原始操作类型，而非硬编码 "modify"
      return { success: true, operation: snapshot.operation, snapshotId: snapshot.id, filePath: targetPath };
    } catch (err: any) {
      logger.error({ modulePath, err: err.message }, "Rollback failed");
      return { success: false, operation: snapshot.operation, error: err.message };
    }
  }

  /**
   * 列出当前运行时环境可用资源（对标 Gödel environment_aware）
   */
  environmentAware(): string {
    const modules: string[] = [];
    try {
      // 使用 git ls-files 获取源码列表（更安全）
      const result = execSync("git ls-files -- '*.ts'", {
        cwd: this.srcDir,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      modules.push(...result.split("\n").filter(Boolean));
    } catch {
      // git 不可用时跳过
    }

    const moduleInfos: ModuleInfo[] = modules.slice(0, 50).map((path) => ({
      path,
      exports: [], // 简化：不解析 AST
      modifiable: this.isModifiable(path),
    }));

    return JSON.stringify({ modules: moduleInfos, sourceDir: this.srcDir }, null, 2);
  }

  /**
   * 检查是否需要自动回滚（Task 3.3）
   *
   * 自动触发条件：
   * 1. afterSuccessRate - beforeSuccessRate < -0.1（成功率下降 >10%）
   * 2. 或新代码导致新的错误类型出现
   */
  shouldAutoRollback(
    snapshotId: string,
    beforeSuccessRate: number,
    afterSuccessRate: number,
    newErrorTypes: string[],
  ): boolean {
    const delta = afterSuccessRate - beforeSuccessRate;
    if (delta < -0.1) {
      logger.warn({ snapshotId, delta: delta.toFixed(2) }, "Auto-rollback triggered: success rate dropped >10%");
      return true;
    }
    if (newErrorTypes.length > 0) {
      logger.warn({ snapshotId, newErrors: newErrorTypes }, "Auto-rollback triggered: new error types detected");
      return true;
    }
    return false;
  }

  /** 获取所有快照 */
  getSnapshots(): CodeSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  // ─── Private: Safety ─────────────────────────────────────────

  private safetyCheck(request: CodeChangeRequest): { pass: boolean; reason?: string } {
    // 1. 禁止修改核心方法
    for (const pattern of FORBIDDEN_TARGETS) {
      if (pattern.test(request.targetName)) {
        return { pass: false, reason: `Target '${request.targetName}' is a core method and cannot be modified` };
      }
    }

    // 2. 禁止修改核心文件
    for (const pattern of FORBIDDEN_FILES) {
      if (pattern.test(request.modulePath)) {
        return { pass: false, reason: `File '${request.modulePath}' is a core module and cannot be modified` };
      }
    }

    // 3. 禁止修改 .test.ts 测试文件
    if (/\.test\.ts$/.test(request.modulePath) || /\.spec\.ts$/.test(request.modulePath)) {
      return { pass: false, reason: "Test files cannot be modified by evolution engine" };
    }

    return { pass: true };
  }

  private isModifiable(modulePath: string): boolean {
    for (const pattern of FORBIDDEN_FILES) {
      if (pattern.test(modulePath)) return false;
    }
    if (/\.test\.ts$/.test(modulePath) || /\.spec\.ts$/.test(modulePath)) return false;
    return true;
  }

  // ─── Private: Code Operations ────────────────────────────────

  /**
   * 从源码中提取指定函数的完整定义
   */
  private extractFunction(content: string, targetName: string): string {
    // 简化的函数提取（基于正则，非 AST）
    const patterns = [
      // export function / async function
      new RegExp(
        `(?:export\\s+)?(?:async\\s+)?function\\s+${this.escapeRegex(targetName)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*\\{[\\s\\S]*?\\n\\}`,
        "m"
      ),
      // class method
      new RegExp(
        `(?:async\\s+)?${this.escapeRegex(targetName)}\\s*\\([^)]*\\)\\s*(?::\\s*[^{]+)?\\s*\\{[\\s\\S]*?\\n\\s*\\}`,
        "m"
      ),
      // arrow function const
      new RegExp(
        `(?:export\\s+)?const\\s+${this.escapeRegex(targetName)}\\s*[:=]\\s*(?:async\\s+)?\\([^)]*\\)\\s*(?::\\s*[^=]+)?\\s*=>\\s*\\{[\\s\\S]*?\\n\\}`,
        "m"
      ),
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) return match[0];
    }

    return `// Function '${targetName}' not found in source\n`;
  }

  /**
   * 替换函数体（审查修正版：增强替换精度与安全验证）
   */
  private applyModify(content: string, targetName: string, newCode: string): string {
    const oldFunc = this.extractFunction(content, targetName);
    if (!oldFunc || oldFunc.startsWith("// Function")) {
      throw new Error(`Function '${targetName}' not found in source`);
    }

    const beforeLines = content.split("\n").length;
    const newContent = content.replace(oldFunc, newCode);

    // 替换后验证：确保替换确实发生了（新内容与旧内容不同）
    if (newContent === content) {
      throw new Error(`Function '${targetName}' replacement had no effect (string match failed)`);
    }

    // 验证一：旧函数名不应再出现（remove=true 表示不应该存在）
    const oldNameRegex = new RegExp(
      `\\b(?:function|const|async)\\s+${this.escapeRegex(targetName)}\\b`,
    );
    const oldOccurrences = newContent.match(oldNameRegex);
    if (oldOccurrences && oldOccurrences.length > 0) {
      throw new Error(
        `Function '${targetName}' still appears ${oldOccurrences.length} time(s) after replacement`,
      );
    }

    // 验证二：新函数名应恰好出现一次
    const newFuncMatch = newCode.match(
      /(?:function|const|async)\s+(\w+)\s*[<(]/,
    );
    if (newFuncMatch) {
      const newFuncName = newFuncMatch[1];
      const newNameRegex = new RegExp(
        `\\b(?:function|const|async)\\s+${this.escapeRegex(newFuncName)}\\b`,
      );
      const newOccurrences = newContent.match(newNameRegex);
      if (!newOccurrences || newOccurrences.length !== 1) {
        throw new Error(
          `New function '${newFuncName}' appears ${newOccurrences?.length ?? 0} time(s), expected exactly 1`,
        );
      }
    }

    // 验证三：替换后文件语法结构完整性（括号匹配）
    const openBraces = (newContent.match(/\{/g) ?? []).length;
    const closeBraces = (newContent.match(/\}/g) ?? []).length;
    if (openBraces !== closeBraces) {
      throw new Error(
        `Brace mismatch after replacement: ${openBraces} open vs ${closeBraces} close`,
      );
    }

    const afterLines = newContent.split("\n").length;
    const delta = afterLines - beforeLines;
    logger.info({
      targetName,
      beforeLines,
      afterLines,
      delta: `${delta >= 0 ? "+" : ""}${delta} lines`,
    }, "Function modified with validation");

    return newContent;
  }

  /**
   * 在文件末尾新增导出函数
   */
  private applyAdd(content: string, targetName: string, newCode: string): string {
    // 在文件末尾添加，确保有换行
    const trimmed = content.trimEnd();
    return `${trimmed}\n\n${newCode}\n`;
  }

  /**
   * 删除指定函数
   */
  private applyDelete(content: string, targetName: string): string {
    const func = this.extractFunction(content, targetName);
    if (!func || func.startsWith("// Function")) {
      throw new Error(`Function '${targetName}' not found in source`);
    }
    // 删除函数并清理多余空行
    return content.replace(func, "").replace(/\n{3,}/g, "\n\n");
  }

  // ─── Private: Snapshot ───────────────────────────────────────

  private ensureSnapshotDir(): void {
    if (!existsSync(this.snapshotDir)) {
      mkdirSync(this.snapshotDir, { recursive: true });
    }
  }

  /**
   * 创建快照（备份原文件到 .evolution-snapshots/）
   */
  private createSnapshot(meta: {
    modulePath: string;
    targetName: string;
    operation: CodeOperation;
    originalPath: string;
    proposalId: string;
  }): string {
    const id = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const backupName = `${meta.targetName}.${id}.ts.bak`;
    const backupPath = join(this.snapshotDir, backupName);

    try {
      if (existsSync(meta.originalPath)) {
        copyFileSync(meta.originalPath, backupPath);
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, "Snapshot backup failed, continuing without backup");
    }

    const snapshot: CodeSnapshot = {
      id,
      modulePath: meta.modulePath,
      targetName: meta.targetName,
      operation: meta.operation,
      originalPath: meta.originalPath,
      backupPath,
      timestamp: new Date().toISOString(),
      proposalId: meta.proposalId,
    };

    this.snapshots.set(id, snapshot);
    logger.info({ id, modulePath: meta.modulePath, targetName: meta.targetName }, "Snapshot created");
    return id;
  }

  // ─── Private: Helpers ────────────────────────────────────────

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
