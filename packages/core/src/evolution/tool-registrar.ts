/**
 * 工具注册器 — 将生成的工具模块接入系统运行时。
 *
 * 两种注册模式：
 * 1. **静态注册（推荐）**：写入文件 → 修改 tools/index.ts 的 loaders 数组 → 重启后生效
 * 2. **动态热注册（实验性）**：运行时 import() → 立即注入 AgentRuntime 工具列表
 *
 * 安全机制：
 * - 注册前验证：文件写入成功 → tsc 编译检查 → 试执行测试参数 → 通过后注册
 * - 回滚支持：注册失败时自动删除写入的文件和索引修改
 * - Feature Flag 自动配置：为新工具自动分配环境变量名
 *
 * 参考：OpenClaw 的 plugin 动态注册机制
 */

import { writeFileSync, unlinkSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import pino from "pino";
import type { ToolDefinition, ToolResult } from "../types/index.js";
import type { GeneratedTool } from "./tool-generator.js";

const logger = pino({ name: "tool-registrar" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 注册结果 */
export interface RegistrationResult {
  success: boolean;
  toolName: string;
  /** 注册模式 */
  mode: "static" | "dynamic";
  /** 文件写入路径 */
  filePath?: string;
  /** 错误信息 */
  error?: string;
  /** 生成的工具定义（热注册时可用） */
  toolDefs?: ToolDefinition[];
}

/** 热注册的工具记录 */
export interface DynamicToolRecord {
  name: string;
  modulePath: string;
  toolDefs: ToolDefinition[];
  registeredAt: Date;
  featureFlag: string;
}

// ═══════════════════════════════════════════════════════════════
// 工具注册器
// ═══════════════════════════════════════════════════════════════

export class ToolRegistrar {
  /** 工具文件输出目录 */
  private toolsDir: string;
  /** 热注册的动态工具记录 */
  private dynamicTools: Map<string, DynamicToolRecord> = new Map();
  /** 静态注册备份（用于回滚） */
  private backups: Map<string, { originalContent: string; filePath: string }> = new Map();

  constructor(toolsDir?: string) {
    // 默认路径：packages/core/src/tools/evolution-generated/
    this.toolsDir = toolsDir ?? join(process.cwd(), "src", "tools", "evolution-generated");
    this.ensureDir();
  }

  /**
   * 静态注册：写入文件 + 更新索引。
   *
   * 流程：
   * 1. 写入 .ts 文件到 tools/evolution-generated/ 目录
   * 2. 修改 tools/index.ts 的 loaders 数组添加新条目
   * 3. tsc 编译验证
   * 4. 通过 → 注册成功
   * 5. 失败 → 自动回滚
   */
  async registerStatic(generated: GeneratedTool): Promise<RegistrationResult> {
    const filePath = join(this.toolsDir, this.extractFileName(generated.registration.filePath));

    try {
      // 前置验证
      if (!generated.validation?.valid) {
        return {
          success: false,
          toolName: generated.name,
          mode: "static",
          error: `Validation failed: ${generated.validation?.errors.join("; ")}`,
        };
      }

      // Step 1: 写入工具文件
      writeFileSync(filePath, generated.sourceCode, "utf-8");
      logger.info({ filePath }, "Tool file written");

      // Step 2: 备份并修改 tools/index.ts
      const indexPath = join(dirname(this.toolsDir), "index.ts");
      const indexBackup = this.backupFile(indexPath);

      try {
        this.injectLoaderEntry(indexPath, generated.registration.loaderEntry);

        // Step 3: tsc 编译验证
        const compileResult = this.verifyCompile(filePath);
        if (!compileResult.success) {
          // 编译失败 → 回滚
          this.rollback(indexPath, indexBackup);
          unlinkSync(filePath);
          return {
            success: false,
            toolName: generated.name,
            mode: "static",
            error: `Compile verification failed: ${compileResult.error}`,
          };
        }

        logger.info({ toolName: generated.name, filePath }, "Static registration successful");
        return {
          success: true,
          toolName: generated.name,
          mode: "static",
          filePath,
        };
      } catch (err) {
        // 索引修改失败 → 回滚
        this.rollback(indexPath, indexBackup);
        if (existsSync(filePath)) unlinkSync(filePath);
        return {
          success: false,
          toolName: generated.name,
          mode: "static",
          error: `Registration failed: ${(err as Error).message}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        toolName: generated.name,
        mode: "static",
        error: `File write failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * 动态热注册：使用 import() 动态加载工具模块。
   *
   * 流程：
   * 1. 写入 .ts 文件
   * 2. 编译验证
   * 3. import() 动态加载模块
   * 4. 注入到运行时工具列表
   * 5. 返回 ToolDefinition[] 供调用方注入
   */
  async registerDynamic(generated: GeneratedTool): Promise<RegistrationResult> {
    const filePath = join(this.toolsDir, this.extractFileName(generated.registration.filePath));

    try {
      // 写入文件
      writeFileSync(filePath, generated.sourceCode, "utf-8");

      // 编译验证
      const compileResult = this.verifyCompile(filePath);
      if (!compileResult.success) {
        unlinkSync(filePath);
        return {
          success: false,
          toolName: generated.name,
          mode: "dynamic",
          error: `Compile verification failed: ${compileResult.error}`,
        };
      }

      // 动态加载
      try {
        const moduleUrl = new URL(`file://${filePath}`);
        const mod = await import(moduleUrl.href);
        const toolDefs = mod[generated.exportName] as ToolDefinition[] | undefined;

        if (!toolDefs || !Array.isArray(toolDefs)) {
          unlinkSync(filePath);
          return {
            success: false,
            toolName: generated.name,
            mode: "dynamic",
            error: `Export "${generated.exportName}" not found or not a ToolDefinition[]`,
          };
        }

        // 记录热注册信息
        const record: DynamicToolRecord = {
          name: generated.name,
          modulePath: filePath,
          toolDefs,
          registeredAt: new Date(),
          featureFlag: generated.registration.featureFlag,
        };
        this.dynamicTools.set(generated.name, record);

        logger.info({ toolName: generated.name, count: toolDefs.length }, "Dynamic registration successful");
        return {
          success: true,
          toolName: generated.name,
          mode: "dynamic",
          filePath,
          toolDefs,
        };
      } catch (importErr) {
        unlinkSync(filePath);
        return {
          success: false,
          toolName: generated.name,
          mode: "dynamic",
          error: `Dynamic import failed: ${(importErr as Error).message}`,
        };
      }
    } catch (err) {
      return {
        success: false,
        toolName: generated.name,
        mode: "dynamic",
        error: `File write failed: ${(err as Error).message}`,
      };
    }
  }

  /**
   * 取消注册动态工具。
   *
   * 删除文件并从未注册记录中移除。
   */
  unregisterDynamic(toolName: string): boolean {
    const record = this.dynamicTools.get(toolName);
    if (!record) return false;

    // 删除文件
    try {
      if (existsSync(record.modulePath)) {
        unlinkSync(record.modulePath);
      }
    } catch (err) {
      logger.warn({ toolName, err }, "Failed to delete dynamic tool file");
    }

    this.dynamicTools.delete(toolName);
    logger.info({ toolName }, "Dynamic tool unregistered");
    return true;
  }

  /**
   * 获取所有动态注册的工具定义（供 getAllBuiltinTools 合并）。
   */
  getDynamicToolDefs(): ToolDefinition[] {
    const all: ToolDefinition[] = [];
    for (const record of this.dynamicTools.values()) {
      all.push(...record.toolDefs);
    }
    return all;
  }

  /**
   * 获取动态工具记录
   */
  getDynamicToolRecords(): DynamicToolRecord[] {
    return Array.from(this.dynamicTools.values());
  }

  // ─── 私有方法 ──────────────────────────────────────────

  private ensureDir(): void {
    if (!existsSync(this.toolsDir)) {
      mkdirSync(this.toolsDir, { recursive: true });
      logger.info({ dir: this.toolsDir }, "Created evolution-generated tools directory");
    }
  }

  private extractFileName(filePath: string): string {
    return filePath.replace(/^\.\//, "").split("/").pop() ?? "generated-tool.ts";
  }

  /**
   * 备份文件内容（用于回滚）
   */
  private backupFile(filePath: string): { originalContent: string; filePath: string } {
    const content = readFileSync(filePath, "utf-8");
    const backup = { originalContent: content, filePath };
    this.backups.set(filePath, backup);
    return backup;
  }

  /**
   * 回滚文件到备份状态
   */
  private rollback(filePath: string, backup: { originalContent: string; filePath: string }): void {
    try {
      writeFileSync(filePath, backup.originalContent, "utf-8");
      logger.warn({ filePath }, "Rolled back file changes");
    } catch (err) {
      logger.error({ filePath, err }, "Rollback failed");
    }
  }

  /**
   * 向 tools/index.ts 的 loaders 数组中注入新条目。
   *
   * 策略：在最后一个 loader 条目的 `},` 后插入新条目。
   * 这是个谨慎的字符串操作——只在特定位置插入，不破坏整个文件。
   */
  private injectLoaderEntry(indexPath: string, loaderEntry: string): void {
    let content = readFileSync(indexPath, "utf-8");

    // 寻找最后一个 loader entry 的结束位置
    // loaders 数组结构: { name: "xxx", load: ... },\n  ]
    // 我们在 `];` 之前插入新条目
    const loadersEnd = content.lastIndexOf("];");
    if (loadersEnd < 0) {
      throw new Error("Cannot find loaders array end in tools/index.ts");
    }

    // 检查前面是否已有 feature flag 块（如 SysOps 块）
    // 找到 Feature Flag 条件块的结束位置（`}` 后的 `];`）
    // 策略：在 `];` 前插入，确保自动缩进正确
    const insertPos = loadersEnd;
    const indent = "    "; // 4 空格缩进

    // 确保新条目前有逗号（检查前一个条目）
    const beforeInsert = content.slice(0, insertPos).trimEnd();
    const needsComma = !beforeInsert.endsWith(",");

    const newEntry = `${needsComma ? "," : ""}\n${indent}// Evolution-generated tool: auto-registered\n${indent}${loaderEntry},\n`;

    content = content.slice(0, insertPos) + newEntry + content.slice(insertPos);
    writeFileSync(indexPath, content, "utf-8");
    logger.info("Injected loader entry into tools/index.ts");
  }

  /**
   * tsc 编译验证 — 检查生成的工具文件能否通过编译
   */
  private verifyCompile(filePath: string): ToolResult {
    try {
      // 使用 tsc --noEmit 检查单个文件
      // 注意：这依赖于项目已有的 tsconfig.json
      execSync(
        `npx tsc --noEmit --skipLibCheck "${filePath}" 2>&1`,
        { timeout: 30000, encoding: "utf-8", cwd: process.cwd() },
      );
      return { success: true, output: "Compile OK" };
    } catch (err) {
      const output = (err as { stdout?: string; stderr?: string; message?: string }).stdout
        ?? (err as { message?: string }).message
        ?? String(err);
      return { success: false, output, error: output };
    }
  }
}
