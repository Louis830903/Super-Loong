/**
 * 工具代码生成器 — LLM 驱动的 ToolDefinition 生成。
 *
 * 核心设计：
 * - 输入自然语言需求 → LLM 生成完整 TypeScript 工具文件
 * - 模板基座约束：骨架代码（imports、接口、execute 函数签名），LLM 只填充业务逻辑
 * - 质量检查：Zod schema 语法校验、导出契约验证、安全模式扫描
 * - 输出：完整 .ts 文件内容 + 注册元数据（供 tool-registrar 使用）
 *
 * 参考：Gödel Agent 的 action_adjust_logic + ADAS Meta Agent 代码生成
 */

import { z } from "zod";

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 工具生成的输入需求 */
export interface ToolRequirement {
  /** 自然语言描述 */
  description: string;
  /** 工具分类 */
  category: "filesystem" | "code" | "web" | "system" | "data" | "media" | "productivity";
  /** 工具名（snake_case） */
  toolName: string;
  /** 期望的参数列表（key → 类型） */
  expectedParams?: Record<string, "string" | "number" | "boolean" | "array">;
}

/** 生成工具的输出 */
export interface GeneratedTool {
  /** 工具名 */
  name: string;
  /** 工具分类 */
  category: string;
  /** 完整 .ts 文件内容 */
  sourceCode: string;
  /** 导出的 ToolDefinition 数组变量名 */
  exportName: string;
  /** 注册元数据 */
  registration: {
    /** 文件路径（相对于 tools/ 目录） */
    filePath: string;
    /** 延迟加载条目（插入到 tools/index.ts loaders 数组中） */
    loaderEntry: string;
    /** Feature Flag 环境变量名 */
    featureFlag: string;
  };
  /** 依赖的 npm 包列表 */
  dependencies: string[];
  /** 质量验证结果 */
  validation?: ValidationResult;
}

/** 代码验证结果 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ═══════════════════════════════════════════════════════════════
// 模板基座 — 骨架代码约束
// ═══════════════════════════════════════════════════════════════

/**
 * 工具代码模板基座。
 *
 * LLM 只需填充：
 * 1. {TOOL_DESCRIPTION} — 工具描述
 * 2. {PARAM_SCHEMA} — Zod schema 定义（如 z.object({ url: z.string() })）
 * 3. {EXECUTE_BODY} — execute 函数体内的业务逻辑
 * 4. {EXPORTS_NAME} — 导出变量名
 * 5. {TOOL_NAME} — 工具名
 * 6. {MODULE_DESCRIPTION} — 模块头注释
 * 7. {EXTRA_IMPORTS} — 额外 import 语句
 */
const TOOL_TEMPLATE = `/**
 * {MODULE_DESCRIPTION}
 *
 * 由 Evolution Engine 自动生成。
 * 生成时间: {GENERATED_AT}
 * 需求描述: {REQUIREMENT_DESC}
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext, ToolResult } from "../types/index.js";
{EXTRA_IMPORTS}

// ─── 参数 Schema ──────────────────────────────────────────

const {SCHEMA_VAR_NAME} = {PARAM_SCHEMA};

// ─── 核心执行逻辑 ──────────────────────────────────────────

async function execute{EXECUTE_FN_SUFFIX}(
  params: z.infer<typeof {SCHEMA_VAR_NAME}>,
  _context: ToolContext,
): Promise<ToolResult> {
{EXECUTE_BODY}
}

// ─── 工具定义 ──────────────────────────────────────────────

const {TOOL_VAR_NAME}: ToolDefinition = {
  name: "{TOOL_NAME}",
  description: {TOOL_DESCRIPTION},
  parameters: {SCHEMA_VAR_NAME},
  execute: async (params: unknown, context: ToolContext): Promise<ToolResult> => {
    const parsed = {SCHEMA_VAR_NAME}.parse(params);
    return execute{EXECUTE_FN_SUFFIX}(parsed, context);
  },
};

export const {EXPORTS_NAME}: ToolDefinition[] = [{TOOL_VAR_NAME}];
`;

// ═══════════════════════════════════════════════════════════════
// Schema 模板 — 常见参数模式
// ═══════════════════════════════════════════════════════════════

/** 参数类型 → Zod schema 片段映射 */
const PARAM_TYPE_MAP: Record<string, string> = {
  string: "z.string().describe(\"{DESC}\")",
  number: "z.number().describe(\"{DESC}\")",
  boolean: "z.boolean().describe(\"{DESC}\")",
  array: "z.array(z.string()).describe(\"{DESC}\")",
  optional_string: "z.string().optional().describe(\"{DESC}\")",
  optional_number: "z.number().optional().describe(\"{DESC}\")",
  optional_boolean: "z.boolean().optional().describe(\"{DESC}\")",
};

// ═══════════════════════════════════════════════════════════════
// 工具代码生成器
// ═══════════════════════════════════════════════════════════════

export class ToolGenerator {
  /** 生成的工具历史记录（用于审计和回滚） */
  private generationHistory: GeneratedTool[] = [];

  /**
   * 根据自然语言需求生成工具代码（模板+LLM 混合模式）。
   *
   * **工作流程**：
   * 1. 根据 expectedParams 生成 Zod schema
   * 2. 填充模板骨架
   * 3. 质量检查
   * 4. 返回 GeneratedTool
   *
   * **注意**：execute 函数体需要 LLM 填充，本方法只生成骨架。
   * 调用方应先用本方法生成骨架，再让 LLM 填充 {EXECUTE_BODY} 部分，
   * 然后调用 `fillExecuteBody()` 完成最终代码。
   */
  generateSkeleton(req: ToolRequirement): GeneratedTool {
    const safeName = req.toolName.replace(/[^a-zA-Z0-9_]/g, "_");
    const schemaVarName = `${safeName}Schema`;
    const toolVarName = `${safeName}Tool`;
    const exportsName = `${safeName}Tools`;
    const executeFnSuffix = safeName.charAt(0).toUpperCase() + safeName.slice(1);

    // 生成 Zod schema
    const schemaBody = this.buildSchema(req.expectedParams ?? {});

    // 文件路径（kebab-case）
    const fileName = req.toolName.replace(/_/g, "-");
    const filePath = `evolution-generated/${fileName}.ts`;

    // Feature Flag
    const featureFlag = `SUPER_AGENT_TOOL_${safeName.toUpperCase()}`;

    // 填充模板
    const sourceCode = TOOL_TEMPLATE
      .replace("{MODULE_DESCRIPTION}", req.description.slice(0, 100))
      .replace("{GENERATED_AT}", new Date().toISOString())
      .replace("{REQUIREMENT_DESC}", req.description)
      .replace("{EXTRA_IMPORTS}", "")
      .replace(/\{SCHEMA_VAR_NAME\}/g, schemaVarName)
      .replace("{PARAM_SCHEMA}", schemaBody)
      .replace(/\{EXECUTE_FN_SUFFIX\}/g, executeFnSuffix)
      .replace("{EXECUTE_BODY}", "  // TODO: LLM 生成的业务逻辑")
      .replace(/\{TOOL_VAR_NAME\}/g, toolVarName)
      .replace("{TOOL_NAME}", safeName)
      .replace("{TOOL_DESCRIPTION}", `"${req.description.replace(/"/g, '\\"')}"`)
      .replace(/\{EXPORTS_NAME\}/g, exportsName);

    const generated: GeneratedTool = {
      name: safeName,
      category: req.category,
      sourceCode,
      exportName: exportsName,
      registration: {
        filePath: `./${filePath}`,
        loaderEntry: `{ name: "${safeName}", load: () => import("./${filePath}").then(m => m.${exportsName}) }`,
        featureFlag,
      },
      dependencies: [],
    };

    // 质量检查
    generated.validation = this.validate(generated.sourceCode);

    this.generationHistory.push(generated);
    return generated;
  }

  /**
   * 用 LLM 生成的业务逻辑填充 execute 函数体，完成最终代码。
   *
   * @param skeleton — generateSkeleton() 返回的骨架
   * @param executeBody — LLM 生成的 execute 函数体代码
   * @param extraImports — LLM 检测到的额外 import 语句
   * @param dependencies — 检测到的 npm 依赖列表
   */
  fillExecuteBody(
    skeleton: GeneratedTool,
    executeBody: string,
    extraImports: string = "",
    dependencies: string[] = [],
  ): GeneratedTool {
    let code = skeleton.sourceCode;

    // 替换 execute 函数体
    code = code.replace(
      "  // TODO: LLM 生成的业务逻辑",
      executeBody.split("\n").map(l => `  ${l}`).join("\n"),
    );

    // 替换额外 imports
    code = code.replace("{EXTRA_IMPORTS}", extraImports ? `\n${extraImports}` : "");

    const result: GeneratedTool = {
      ...skeleton,
      sourceCode: code,
      dependencies,
      validation: this.validate(code),
    };

    // 更新历史记录
    const idx = this.generationHistory.findIndex(
      h => h.name === skeleton.name && h.registration.filePath === skeleton.registration.filePath,
    );
    if (idx >= 0) {
      this.generationHistory[idx] = result;
    } else {
      this.generationHistory.push(result);
    }

    return result;
  }

  /**
   * 验证生成的代码质量。
   *
   * 检查项：
   * 1. 是否导出 ToolDefinition[]（导出契约）
   * 2. 是否包含必要的 imports（zod、ToolDefinition、ToolContext、ToolResult）
   * 3. execute 函数签名是否正确
   * 4. 安全模式扫描（危险模式）
   */
  validate(code: string): ValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 导出契约：是否导出 ToolDefinition[]
    if (!/export\s+(const|let|var)\s+\w+\s*:\s*ToolDefinition\[\]/.test(code)) {
      errors.push("Missing export of ToolDefinition[]");
    }

    // 2. 必要 imports
    if (!/from\s+["']zod["']/.test(code)) {
      errors.push("Missing 'zod' import");
    }
    if (!/ToolDefinition/.test(code)) {
      errors.push("Missing ToolDefinition type reference");
    }
    if (!/ToolContext/.test(code)) {
      warnings.push("ToolContext not imported (not always required)");
    }
    if (!/ToolResult/.test(code)) {
      errors.push("Missing ToolResult type reference");
    }

    // 3. execute 函数签名检查
    if (!/execute\s*:\s*async\s*\(/.test(code)) {
      errors.push("Missing execute async function in ToolDefinition");
    }

    // 4. Zod schema parse 调用
    if (!/\.parse\(params\)/.test(code)) {
      warnings.push("Missing .parse(params) — schema validation may not be enforced");
    }

    // 5. 安全模式扫描
    const dangerousPatterns = [
      { pattern: /\brequire\s*\(['"]child_process['"]\)/, msg: "Raw child_process require (use spawn from node:child_process)" },
      { pattern: /eval\s*\(/, msg: "eval() detected — potential code injection" },
      { pattern: /fs\.(unlink|rm)Sync\s*\(/, msg: "Dangerous filesystem operation" },
    ];

    for (const { pattern, msg } of dangerousPatterns) {
      if (pattern.test(code)) {
        warnings.push(`Security: ${msg}`);
      }
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  /**
   * 获取生成历史
   */
  getHistory(): GeneratedTool[] {
    return [...this.generationHistory];
  }

  /**
   * 撤销最近的生成（从历史中移除）
   */
  undoLast(): GeneratedTool | null {
    return this.generationHistory.pop() ?? null;
  }

  // ─── 私有方法 ──────────────────────────────────────────

  /**
   * 根据参数描述构建 Zod schema 字符串
   */
  private buildSchema(params: Record<string, string>): string {
    if (Object.keys(params).length === 0) {
      // 无参数：default 模式 — 允许空对象
      return `z.object({
    _dummy: z.string().optional().describe("预留字段，实际无需参数"),
  })`;
    }

    const fields: string[] = [];
    for (const [key, type] of Object.entries(params)) {
      const typeTemplate = PARAM_TYPE_MAP[type] ?? PARAM_TYPE_MAP.string;
      const desc = `${key} 参数`;
      fields.push(`    ${key}: ${typeTemplate.replace("{DESC}", desc)},`);
    }

    return `z.object({\n${fields.join("\n")}\n  })`;
  }
}
