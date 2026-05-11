/**
 * 跨应用工作流引擎 — 编排多步骤跨工具操作。
 *
 * 当前系统有 collaboration/orchestrator.ts（多 Agent 协作编排），
 * 但缺少"跨工具工作流"编排。本引擎处理：
 *   "打开 Excel → 读取数据 → 生成图表 → 发邮件"
 *   这种跨应用串联场景。
 *
 * 架构：
 *   WorkflowDefinition (声明式工作流)
 *     │
 *     ├── Step[] (有序步骤列表)
 *     │     ├── Step 1: open_app("Excel", file="report.xlsx")
 *     │     ├── Step 2: computer_use("截图分析表格内容")
 *     │     └── ...
 *     │
 *     ├── ExecutionEngine (运行时执行器)
 *     │     ├── 顺序执行各步骤
 *     │     ├── 步骤间自动截屏验证（computer_use 的视觉推理）
 *     │     ├── 失败重试与降级策略
 *     │     └── 进度回调
 *     │
 *     └── WorkflowLibrary (工作流模板库)
 *           ├── 预置模板：发送邮件报告、批量文件处理等
 *           └── LLM 从自然语言生成工作流定义
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const logger = pino({ name: "workflow-engine" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 工作流步骤 */
export interface WorkflowStep {
  /** 步骤 ID */
  id: string;
  /** 工具名（如 "app_launch", "computer_use", "browser_navigate"） */
  tool: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 步骤描述（给 LLM 看的） */
  description: string;
  /** 步骤成功条件：工具返回 success=true 或自定义断言 */
  successCondition?: string;
  /** 失败时最大重试次数，默认 0 */
  maxRetries?: number;
  /** 失败降级策略：降级步骤 ID */
  fallbackStep?: string;
  /** 超时时间（毫秒），默认 30000 */
  timeout?: number;
}

/** 工作流定义 */
export interface WorkflowDefinition {
  /** 工作流 ID */
  id: string;
  /** 工作流名称 */
  name: string;
  /** 工作流描述 */
  description: string;
  /** 有序步骤列表 */
  steps: WorkflowStep[];
  /** 生成来源 */
  source: "manual" | "llm_generated" | "template";
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 标签（供搜索用） */
  tags: string[];
}

/** 工作流执行上下文 */
export interface WorkflowContext {
  /** 当前会话 ID */
  sessionId: string;
  /** 关联的 Agent ID */
  agentId: string;
  /** 工作流变量（步骤间传递数据） */
  variables: Record<string, unknown>;
  /** 步骤间截屏存档 */
  screenshots: string[];
  /** 是否取消执行 */
  cancelled: boolean;
}

/** 单步执行结果 */
export interface StepResult {
  stepId: string;
  stepIndex: number;
  success: boolean;
  output: string;
  error?: string;
  /** 执行耗时（毫秒） */
  duration: number;
  /** 重试次数 */
  retries: number;
  /** 截屏路径 */
  screenshot?: string;
}

/** 工作流执行结果 */
export interface WorkflowResult {
  workflowId: string;
  success: boolean;
  /** 所有步骤的结果 */
  steps: StepResult[];
  /** 总耗时（毫秒） */
  totalDuration: number;
  /** 失败步骤索引（如有） */
  failedStepIndex?: number;
  /** 错误信息 */
  error?: string;
}

/** 工作流执行回调 */
export interface WorkflowProgressCallback {
  (event: {
    type: "step_start" | "step_complete" | "step_failed" | "step_retry" | "step_fallback" | "workflow_complete" | "workflow_failed";
    workflowId: string;
    stepIndex?: number;
    stepId?: string;
    result?: StepResult;
    overall?: WorkflowResult;
  }): void;
}

/** 工作流执行工具（由调用方注入） */
export interface WorkflowToolExecutor {
  /** 执行单个工具调用 */
  execute(toolName: string, params: Record<string, unknown>, sessionId: string): Promise<{
    success: boolean;
    output: string;
    data?: unknown;
  }>;
  /** 截屏（用于步骤间验证） */
  screenshot?(): Promise<string>; // 返回截屏路径
}

// ═══════════════════════════════════════════════════════════════
// 预置工作流模板库
// ═══════════════════════════════════════════════════════════════

/**
 * 预置模板定义。
 * 用户可以从模板库中选择并实例化。
 */
export const WORKFLOW_TEMPLATES: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">[] = [
  {
    name: "send_email_report",
    description: "发送邮件报告：打开浏览器 → 登录邮箱 → 撰写邮件 → 发送",
    source: "template",
    tags: ["email", "report", "browser"],
    steps: [
      {
        id: "open_browser",
        tool: "browser_navigate",
        params: { url: "https://mail.google.com" },
        description: "打开邮箱（Gmail）",
        maxRetries: 1,
        timeout: 30000,
      },
      {
        id: "compose_email",
        tool: "computer_use",
        params: { action: "填写收件人、主题、正文，并上传附件" },
        description: "撰写邮件",
        maxRetries: 2,
        timeout: 60000,
      },
      {
        id: "send_email",
        tool: "computer_use",
        params: { action: "点击发送按钮" },
        description: "发送邮件",
        maxRetries: 1,
        timeout: 15000,
      },
    ],
  },
  {
    name: "batch_file_process",
    description: "批量文件处理：遍历目录 → 处理每个文件 → 输出结果",
    source: "template",
    tags: ["filesystem", "batch", "automation"],
    steps: [
      {
        id: "list_files",
        tool: "list_directory",
        params: { path: "{sourceDir}" },
        description: "列出源目录中的所有文件",
        maxRetries: 1,
        timeout: 10000,
      },
      {
        id: "process_file",
        tool: "run_shell",
        params: { command: "{processCommand}" },
        description: "处理文件",
        maxRetries: 2,
        timeout: 120000,
      },
      {
        id: "output_result",
        tool: "write_file",
        params: { path: "{outputPath}", content: "{processedData}" },
        description: "写入处理结果",
        maxRetries: 1,
        timeout: 10000,
      },
    ],
  },
  {
    name: "data_collection",
    description: "定时数据采集：抓取网页 → 解析数据 → 存储",
    source: "template",
    tags: ["data", "web", "scheduled"],
    steps: [
      {
        id: "fetch_data",
        tool: "web_search",
        params: { query: "{searchQuery}" },
        description: "获取数据源",
        maxRetries: 2,
        timeout: 30000,
      },
      {
        id: "parse_data",
        tool: "run_python",
        params: { code: "{parseScript}" },
        description: "解析提取结构化数据",
        maxRetries: 1,
        timeout: 30000,
      },
      {
        id: "store_data",
        tool: "write_file",
        params: { path: "{outputPath}", content: "{structuredData}" },
        description: "存储数据",
        maxRetries: 1,
        timeout: 10000,
      },
    ],
  },
];

// ═══════════════════════════════════════════════════════════════
// 工作流引擎
// ═══════════════════════════════════════════════════════════════

export class WorkflowEngine {
  /** 模板库 */
  private templates: Map<string, Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">> = new Map();
  /** 已定义的工作流 */
  private workflows: Map<string, WorkflowDefinition> = new Map();
  /** 工作流存储目录 */
  private storageDir: string;
  /** 工具执行器 */
  private toolExecutor?: WorkflowToolExecutor;

  constructor(storageDir?: string) {
    this.storageDir = storageDir ?? join(process.cwd(), "skills", "workflows");

    // 注册预置模板
    for (const tpl of WORKFLOW_TEMPLATES) {
      this.templates.set(tpl.name, tpl);
    }
  }

  /**
   * 设置工具执行器（必须在 execute 前调用）。
   */
  setToolExecutor(executor: WorkflowToolExecutor): void {
    this.toolExecutor = executor;
  }

  // ─── 工作流定义 ─────────────────────────────────────────

  /**
   * 从 JSON 创建/注册工作流定义。
   */
  defineWorkflow(def: Omit<WorkflowDefinition, "id" | "createdAt" | "updatedAt">): WorkflowDefinition {
    const now = new Date();
    const workflow: WorkflowDefinition = {
      ...def,
      id: `wf_${uuid().slice(0, 8)}`,
      createdAt: now,
      updatedAt: now,
    };

    // 确保每个步骤有 ID
    for (const step of workflow.steps) {
      if (!step.id) {
        step.id = `step_${uuid().slice(0, 6)}`;
      }
    }

    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  /**
   * 从模板创建实例。
   */
  createFromTemplate(templateName: string, overrides?: Partial<WorkflowDefinition>): WorkflowDefinition | null {
    const tpl = this.templates.get(templateName);
    if (!tpl) {
      logger.warn({ templateName }, "Template not found");
      return null;
    }

    return this.defineWorkflow({
      ...tpl,
      name: overrides?.name ?? tpl.name,
      description: overrides?.description ?? tpl.description,
      steps: overrides?.steps ?? tpl.steps.map(s => ({ ...s })),
      source: overrides?.source ?? "template",
      tags: overrides?.tags ?? tpl.tags,
    });
  }

  /**
   * 获取已定义的工作流。
   */
  getWorkflow(id: string): WorkflowDefinition | undefined {
    return this.workflows.get(id);
  }

  /**
   * 列出所有工作流。
   */
  listWorkflows(filter?: { tags?: string[]; source?: WorkflowDefinition["source"] }): WorkflowDefinition[] {
    let workflows = Array.from(this.workflows.values());

    if (filter?.tags?.length) {
      workflows = workflows.filter(w => filter.tags!.some(t => w.tags.includes(t)));
    }
    if (filter?.source) {
      workflows = workflows.filter(w => w.source === filter.source);
    }

    return workflows;
  }

  /**
   * 列出所有模板
   */
  listTemplates(): string[] {
    return Array.from(this.templates.keys());
  }

  /**
   * 删除工作流。
   */
  deleteWorkflow(id: string): boolean {
    return this.workflows.delete(id);
  }

  // ─── 工作流执行 ─────────────────────────────────────────

  /**
   * 执行工作流。
   *
   * 流程：
   * 1. 验证工作流定义
   * 2. 顺序执行每个步骤
   * 3. 步骤失败时按配置重试
   * 4. 重试耗尽后尝试降级步骤
   * 5. 每步完成后触发进度回调
   */
  async execute(
    workflowId: string,
    ctx: WorkflowContext,
    onProgress?: WorkflowProgressCallback,
  ): Promise<WorkflowResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return {
        workflowId,
        success: false,
        steps: [],
        totalDuration: 0,
        error: `Workflow "${workflowId}" not found`,
      };
    }

    if (!this.toolExecutor) {
      return {
        workflowId,
        success: false,
        steps: [],
        totalDuration: 0,
        error: "No tool executor configured",
      };
    }

    const startTime = Date.now();
    const stepResults: StepResult[] = [];

    onProgress?.({ type: "step_start", workflowId, stepIndex: 0, stepId: workflow.steps[0]?.id });

    for (let i = 0; i < workflow.steps.length; i++) {
      if (ctx.cancelled) {
        return {
          workflowId,
          success: false,
          steps: stepResults,
          totalDuration: Date.now() - startTime,
          error: "Workflow cancelled by user",
        };
      }

      const step = workflow.steps[i];
      const result = await this.executeStep(step, i, workflowId, ctx, onProgress);
      stepResults.push(result);

      if (!result.success) {
        // 尝试降级步骤
        if (step.fallbackStep) {
          onProgress?.({ type: "step_fallback", workflowId, stepIndex: i, stepId: step.id });
          const fallbackResult = await this.executeFallbackStep(step.fallbackStep, i, workflowId, ctx, onProgress);
          stepResults.push(fallbackResult);
          if (!fallbackResult.success) {
            return this.buildResult(workflowId, false, stepResults, startTime, i, `Step "${step.id}" and its fallback both failed`);
          }
          // 降级成功，继续下一个步骤
          continue;
        }

        // 无降级 → 工作流失败
        return this.buildResult(workflowId, false, stepResults, startTime, i, `Step "${step.id}" failed: ${result.error}`);
      }
    }

    const finalResult = this.buildResult(workflowId, true, stepResults, startTime);
    onProgress?.({ type: "workflow_complete", workflowId, overall: finalResult });
    return finalResult;
  }

  /**
   * 执行单个步骤（含重试逻辑）。
   */
  private async executeStep(
    step: WorkflowStep,
    index: number,
    workflowId: string,
    ctx: WorkflowContext,
    onProgress?: WorkflowProgressCallback,
  ): Promise<StepResult> {
    const maxRetries = step.maxRetries ?? 0;
    let lastError: string | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const stepStart = Date.now();

      if (attempt > 0) {
        onProgress?.({ type: "step_retry", workflowId, stepIndex: index, stepId: step.id });
        logger.info({ stepId: step.id, attempt }, "Retrying failed step");
      }

      try {
        // 替换参数中的变量占位符
        const resolvedParams = this.resolveVariables(step.params, ctx.variables);

        const execResult = await this.toolExecutor!.execute(
          step.tool,
          resolvedParams,
          ctx.sessionId,
        );

        const duration = Date.now() - stepStart;

        // 步骤间截屏验证
        let screenshot: string | undefined;
        if (this.toolExecutor!.screenshot) {
          try {
            screenshot = await this.toolExecutor!.screenshot();
            ctx.screenshots.push(screenshot);
          } catch {
            // 截屏失败不阻塞流程
          }
        }

        if (execResult.success) {
          const result: StepResult = {
            stepId: step.id,
            stepIndex: index,
            success: true,
            output: execResult.output,
            duration,
            retries: attempt,
            screenshot,
          };
          onProgress?.({ type: "step_complete", workflowId, stepIndex: index, stepId: step.id, result });
          return result;
        }

        lastError = execResult.output || "Unknown error";
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    // 所有重试均失败
    const duration = Date.now() - Date.now(); // approximate
    const result: StepResult = {
      stepId: step.id,
      stepIndex: index,
      success: false,
      output: "",
      error: lastError,
      duration: 0,
      retries: maxRetries,
    };
    onProgress?.({ type: "step_failed", workflowId, stepIndex: index, stepId: step.id, result });
    return result;
  }

  /**
   * 执行降级步骤。
   */
  private async executeFallbackStep(
    fallbackStepId: string,
    originalIndex: number,
    workflowId: string,
    ctx: WorkflowContext,
    onProgress?: WorkflowProgressCallback,
  ): Promise<StepResult> {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) {
      return {
        stepId: fallbackStepId,
        stepIndex: originalIndex,
        success: false,
        output: "",
        error: "Workflow not found for fallback",
        duration: 0,
        retries: 0,
      };
    }

    const fallbackStep = workflow.steps.find(s => s.id === fallbackStepId);
    if (!fallbackStep) {
      return {
        stepId: fallbackStepId,
        stepIndex: originalIndex,
        success: false,
        output: "",
        error: `Fallback step "${fallbackStepId}" not found`,
        duration: 0,
        retries: 0,
      };
    }

    logger.info({ stepId: fallbackStep.id, originalStepIndex: originalIndex }, "Executing fallback step");
    return this.executeStep(fallbackStep, originalIndex, workflowId, ctx, onProgress);
  }

  // ─── 变量解析 ───────────────────────────────────────────

  /**
   * 解析参数中的变量占位符。
   *
   * 将 `{varName}` 替换为 ctx.variables 中的实际值。
   */
  private resolveVariables(
    params: Record<string, unknown>,
    variables: Record<string, unknown>,
  ): Record<string, unknown> {
    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string") {
        resolved[key] = value.replace(/\{(\w+)\}/g, (_, varName) => {
          const varValue = variables[varName];
          return varValue !== undefined ? String(varValue) : `{${varName}}`;
        });
      } else {
        resolved[key] = value;
      }
    }
    return resolved;
  }

  // ─── 持久化 ────────────────────────────────────────────

  /**
   * 将工作流保存为 .md 文件（与技能系统共用基础设施）。
   */
  saveAsFile(workflowId: string): boolean {
    const workflow = this.workflows.get(workflowId);
    if (!workflow) return false;

    try {
      if (!existsSync(this.storageDir)) {
        mkdirSync(this.storageDir, { recursive: true });
      }

      // 生成 Markdown 格式的工作流文件
      const lines = [
        "---",
        `name: ${workflow.name}`,
        `description: ${workflow.description}`,
        `source: ${workflow.source}`,
        `tags: [${workflow.tags.join(", ")}]`,
        `created_at: ${workflow.createdAt.toISOString()}`,
        `updated_at: ${workflow.updatedAt.toISOString()}`,
        "---",
        "",
        `# ${workflow.name}`,
        "",
        workflow.description,
        "",
        "## 执行步骤",
        "",
        ...workflow.steps.flatMap((step, i) => [
          `### Step ${i + 1}: ${step.tool}`,
          "",
          `- **描述**: ${step.description}`,
          `- **参数**: \`${JSON.stringify(step.params)}\``,
          step.maxRetries ? `- **最大重试**: ${step.maxRetries}` : "",
          step.fallbackStep ? `- **降级步骤**: ${step.fallbackStep}` : "",
          "",
        ]),
      ];

      const filePath = join(this.storageDir, `${workflow.name}.md`);
      writeFileSync(filePath, lines.filter(l => l !== "").join("\n") + "\n", "utf-8");
      logger.info({ workflowId, filePath }, "Workflow saved to file");
      return true;
    } catch (err) {
      logger.error({ workflowId, err }, "Failed to save workflow file");
      return false;
    }
  }

  /**
   * 从文件加载工作流。
   */
  loadFromFile(filePath: string): WorkflowDefinition | null {
    try {
      const content = readFileSync(filePath, "utf-8");
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) return null;

      // 简单的 YAML frontmatter 解析（不依赖外部库）
      const frontmatter = frontmatterMatch[1];
      const getField = (key: string) => {
        const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
        return match ? match[1].trim() : undefined;
      };

      const name = getField("name") ?? "unnamed_workflow";
      const description = getField("description") ?? "";
      const source = (getField("source") as WorkflowDefinition["source"]) ?? "manual";
      const tagsStr = getField("tags") ?? "";
      const tags = tagsStr.replace(/[\[\]]/g, "").split(",").map(t => t.trim()).filter(Boolean);
      const createdAt = getField("created_at") ? new Date(getField("created_at")!) : new Date();

      // 解析步骤（从 Markdown 内容）
      const steps: WorkflowStep[] = [];
      const stepRegex = /### Step \d+: (\w+)\n\n- \*\*描述\*\*: (.+?)\n- \*\*参数\*\*: `(.+?)`/g;
      let match: RegExpExecArray | null;
      while ((match = stepRegex.exec(content)) !== null) {
        let params: Record<string, unknown> = {};
        try {
          params = JSON.parse(match[3]);
        } catch { /* keep empty */ }

        steps.push({
          id: `step_${uuid().slice(0, 6)}`,
          tool: match[1],
          params,
          description: match[2],
        });
      }

      return this.defineWorkflow({
        name,
        description,
        source,
        tags,
        steps: steps.length > 0 ? steps : [
          { id: `step_${uuid().slice(0, 6)}`, tool: "run_shell", params: {}, description: "占位步骤" },
        ],
      });
    } catch (err) {
      logger.error({ filePath, err }, "Failed to load workflow file");
      return null;
    }
  }

  // ─── 辅助方法 ──────────────────────────────────────────

  /**
   * 构建工作流结果。
   */
  private buildResult(
    workflowId: string,
    success: boolean,
    steps: StepResult[],
    startTime: number,
    failedStepIndex?: number,
    error?: string,
  ): WorkflowResult {
    return {
      workflowId,
      success,
      steps,
      totalDuration: Date.now() - startTime,
      failedStepIndex,
      error,
    };
  }
}
