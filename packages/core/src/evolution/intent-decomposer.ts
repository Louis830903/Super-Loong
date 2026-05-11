/**
 * 意图分解引擎 — 将用户自然语言目标层次化分解为可执行的子目标与步骤。
 *
 * 输入：用户自然语言目标（如"帮我准备季度销售报告"）
 * 输出：层次化分解结果 → 自动转换为 WorkflowDefinition
 *
 * 关键特性：
 *   - 支持并行子目标（无依赖的自动并行执行）
 *   - 子目标间依赖管理（DAG 拓扑排序）
 *   - 分解结果自动转换为 WorkflowDefinition（复用 P4 的工作流引擎）
 *   - 执行进度向用户实时汇报
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import type { WorkflowStep } from "./workflow-engine.js";

const logger = pino({ name: "intent-decomposer" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

/** 分解步骤（最小可执行单元） */
export interface DecomposedStep {
  /** 步骤 ID */
  id: string;
  /** 步骤描述（人类可读） */
  description: string;
  /** 工具名 */
  tool: string;
  /** 工具参数 */
  params: Record<string, unknown>;
  /** 预估执行时间（毫秒） */
  estimatedDuration: number;
  /** 成功条件（自然语言断言） */
  successCondition?: string;
  /** 失败时最大重试次数 */
  maxRetries?: number;
  /** 失败降级步骤 ID */
  fallbackStepId?: string;
}

/** 子目标：包含一组有向无环图（DAG）步骤 */
export interface SubGoal {
  /** 子目标 ID */
  id: string;
  /** 子目标名称 */
  name: string;
  /** 子目标描述 */
  description: string;
  /** 步骤列表 */
  steps: DecomposedStep[];
  /** 依赖的其他子目标 ID 列表 */
  dependsOn: string[];
  /** 是否可并行执行（与其他无依赖的子目标并行） */
  parallelizable: boolean;
  /** 子目标产出（供后续子目标使用） */
  outputs: SubGoalOutput[];
  /** 优先级（数字越小越先执行） */
  priority: number;
  /** 子目标状态 */
  status: SubGoalStatus;
  /** 关联的 Agent ID */
  assignedAgentId?: string;
}

/** 子目标产出 */
export interface SubGoalOutput {
  /** 产出名称 */
  name: string;
  /** 产出类型 */
  type: "file" | "data" | "text" | "screenshot" | "confirmation";
  /** 产出描述 */
  description: string;
  /** 产出路径/标识（供依赖方引用） */
  reference: string;
}

/** 子目标状态 */
export type SubGoalStatus = "pending" | "in_progress" | "completed" | "failed" | "skipped";

/** 完整意图分解结果 */
export interface DecompositionResult {
  /** 分解 ID */
  id: string;
  /** 原始用户意图 */
  originalIntent: string;
  /** 意图摘要 */
  summary: string;
  /** 子目标列表 */
  subGoals: SubGoal[];
  /** 依赖图（邻接表） */
  dependencyGraph: Map<string, string[]>;
  /** 执行顺序（拓扑排序） */
  executionOrder: string[][]; // 每层可并行的子目标 ID 组
  /** 全局变量（子目标间共享） */
  globalVariables: Record<string, unknown>;
  /** 分解置信度 (0-1) */
  confidence: number;
  /** 分解时间 */
  decomposedAt: Date;
  /** 总预估执行时间（毫秒） */
  totalEstimatedDuration: number;
}

/** 执行进度事件 */
export interface DecompositionProgress {
  /** 当前执行层 */
  currentLayer: number;
  /** 总层数 */
  totalLayers: number;
  /** 当前层中的子目标状态 */
  layerStatus: Array<{
    subGoalId: string;
    name: string;
    status: SubGoalStatus;
    progress: number; // 0-100
  }>;
  /** 全局进度 0-100 */
  overallProgress: number;
  /** 进度描述文本 */
  message: string;
}

/** 意图分解器配置 */
export interface DecomposerConfig {
  /** 最大子目标数（默认 10） */
  maxSubGoals: number;
  /** 每子目标最大步骤数（默认 5） */
  maxStepsPerSubGoal: number;
  /** 单层最大并行子目标数（默认 3） */
  maxParallelSubGoals: number;
  /** 分解最小置信度阈值（默认 0.6） */
  minConfidence: number;
}

const DEFAULT_CONFIG: DecomposerConfig = {
  maxSubGoals: 10,
  maxStepsPerSubGoal: 5,
  maxParallelSubGoals: 3,
  minConfidence: 0.6,
};

// ═══════════════════════════════════════════════════════════════
// 意图分解引擎
// ═══════════════════════════════════════════════════════════════

export class IntentDecomposer {
  private config: DecomposerConfig;
  /** 进度回调 */
  private onProgress?: (progress: DecompositionProgress) => void;

  constructor(config?: Partial<DecomposerConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置进度回调。
   */
  setProgressCallback(cb: (progress: DecompositionProgress) => void): void {
    this.onProgress = cb;
  }

  /**
   * 从自然语言描述分解意图。
   *
   * 当前使用基于规则 + 模板的分解策略。
   * 生产环境应接入 LLM 进行智能分解。
   */
  decompose(intent: string, context?: {
    /** 可用的工具列表 */
    availableTools?: string[];
    /** 之前的会话上下文 */
    previousContext?: string;
    /** 环境快照信息 */
    environmentInfo?: string;
  }): DecompositionResult {
    const result: DecompositionResult = {
      id: `decomp_${uuid().slice(0, 8)}`,
      originalIntent: intent,
      summary: "",
      subGoals: [],
      dependencyGraph: new Map(),
      executionOrder: [],
      globalVariables: {},
      confidence: 0.7,
      decomposedAt: new Date(),
      totalEstimatedDuration: 0,
    };

    // 基于关键词+模式匹配的规则分解
    const subGoals = this.ruleBasedDecompose(intent, context?.availableTools ?? []);

    // 应用配置约束
    const boundedGoals = subGoals.slice(0, this.config.maxSubGoals);

    // 构建依赖图
    const depGraph = this.buildDependencyGraph(boundedGoals);
    result.dependencyGraph = depGraph;

    // 拓扑排序 → 执行顺序
    result.executionOrder = this.topoSort(boundedGoals, depGraph);

    // 计算总预估时长
    result.totalEstimatedDuration = boundedGoals.reduce(
      (sum, sg) => sum + sg.steps.reduce((s, step) => s + step.estimatedDuration, 0),
      0,
    );

    result.subGoals = boundedGoals;
    result.summary = this.generateSummary(intent, boundedGoals);
    result.confidence = this.estimateConfidence(intent, boundedGoals);

    logger.info(
      { decompId: result.id, subGoalCount: boundedGoals.length, layers: result.executionOrder.length },
      "Intent decomposed",
    );
    return result;
  }

  /**
   * 将分解结果转换为 WorkflowStep 列表（兼容 P4 的 WorkflowEngine）。
   */
  toWorkflowSteps(result: DecompositionResult): WorkflowStep[] {
    const steps: WorkflowStep[] = [];

    for (const layer of result.executionOrder) {
      for (const sgId of layer) {
        const sg = result.subGoals.find(g => g.id === sgId);
        if (!sg) continue;

        for (const step of sg.steps) {
          steps.push({
            id: step.id,
            tool: step.tool,
            params: step.params,
            description: `[${sg.name}] ${step.description}`,
            successCondition: step.successCondition,
            maxRetries: step.maxRetries,
            fallbackStep: step.fallbackStepId,
          });
        }
      }
    }

    return steps;
  }

  /**
   * 将分解结果格式化为面向用户的可读报告。
   */
  formatReport(result: DecompositionResult): string {
    const lines: string[] = [
      `## 意图分解报告`,
      ``,
      `**原始意图**: ${result.originalIntent}`,
      `**摘要**: ${result.summary}`,
      `**置信度**: ${(result.confidence * 100).toFixed(0)}%`,
      `**预估耗时**: ${this.formatDuration(result.totalEstimatedDuration)}`,
      `**子目标数**: ${result.subGoals.length}`,
      ``,
      `### 执行计划`,
      ``,
    ];

    for (let layerIdx = 0; layerIdx < result.executionOrder.length; layerIdx++) {
      const layer = result.executionOrder[layerIdx];
      const parallel = layer.length > 1;

      lines.push(`#### 第 ${layerIdx + 1} 层${parallel ? "（可并行）" : ""}`);

      for (const sgId of layer) {
        const sg = result.subGoals.find(g => g.id === sgId);
        if (!sg) continue;

        const deps = sg.dependsOn.length > 0
          ? ` (依赖: ${sg.dependsOn.map(d => {
            const dep = result.subGoals.find(g => g.id === d);
            return dep?.name ?? d;
          }).join(", ")})`
          : "";

        lines.push(`- **${sg.name}**${deps}`);
        for (const step of sg.steps) {
          lines.push(`  - \`${step.tool}\`: ${step.description}`);
        }
      }

      lines.push("");
    }

    return lines.join("\n");
  }

  // ─── 规则分解引擎 ──────────────────────────────────────

  /**
   * 基于规则的意图分解。
   * 识别意图中的关键词模式，映射到预设的子目标模板。
   */
  private ruleBasedDecompose(intent: string, availableTools: string[]): SubGoal[] {
    const intentLower = intent.toLowerCase();
    const subGoals: SubGoal[] = [];
    let priority = 1;

    // ─── 模式 1: 数据获取（导出、查询、获取、下载） ───
    if (
      intentLower.includes("导出") || intentLower.includes("获取") ||
      intentLower.includes("查询") || intentLower.includes("下载") ||
      intentLower.includes("数据") || intentLower.includes("select") ||
      intentLower.includes("fetch") || intentLower.includes("download")
    ) {
      const steps = this.extractDataSteps(intent, availableTools);
      if (steps.length > 0) {
        subGoals.push({
          id: `sg_${uuid().slice(0, 6)}`,
          name: "获取数据",
          description: "从数据源获取所需数据",
          steps,
          dependsOn: [],
          parallelizable: true,
          outputs: [{ name: "raw_data", type: "data", description: "原始数据", reference: "{dataOutput}" }],
          priority: priority++,
          status: "pending",
        });
      }
    }

    // ─── 模式 2: 数据处理/分析（图表、分析、生成、处理） ───
    if (
      intentLower.includes("图表") || intentLower.includes("分析") ||
      intentLower.includes("生成") || intentLower.includes("处理") ||
      intentLower.includes("可视化") || intentLower.includes("统计") ||
      intentLower.includes("chart") || intentLower.includes("analyze")
    ) {
      const steps = this.extractAnalysisSteps(intent, availableTools);
      if (steps.length > 0) {
        const dataDeps = subGoals.filter(sg => sg.name === "获取数据").map(sg => sg.id);
        subGoals.push({
          id: `sg_${uuid().slice(0, 6)}`,
          name: "分析处理",
          description: "对数据进行分析和可视化处理",
          steps,
          dependsOn: dataDeps,
          parallelizable: false,
          outputs: [
            { name: "analysis_result", type: "file", description: "分析结果文件", reference: "{analysisOutput}" },
            { name: "chart_screenshot", type: "screenshot", description: "图表截图", reference: "{chartPath}" },
          ],
          priority: priority++,
          status: "pending",
        });
      }
    }

    // ─── 模式 3: 文档/报告撰写（报告、文档、摘要、撰写） ───
    if (
      intentLower.includes("报告") || intentLower.includes("文档") ||
      intentLower.includes("摘要") || intentLower.includes("撰写") ||
      intentLower.includes("写") || intentLower.includes("生成报告") ||
      intentLower.includes("report") || intentLower.includes("document")
    ) {
      const steps = this.extractDocumentSteps(intent, availableTools);
      if (steps.length > 0) {
        const analysisDeps = subGoals.filter(sg => sg.name === "分析处理").map(sg => sg.id);
        const dataDeps = subGoals.filter(sg => sg.name === "获取数据").map(sg => sg.id);
        subGoals.push({
          id: `sg_${uuid().slice(0, 6)}`,
          name: "撰写文档",
          description: "生成文字报告或摘要文档",
          steps,
          dependsOn: [...analysisDeps, ...dataDeps],
          parallelizable: false,
          outputs: [{ name: "document", type: "file", description: "生成的文档", reference: "{documentPath}" }],
          priority: priority++,
          status: "pending",
        });
      }
    }

    // ─── 模式 4: 发送/分享（邮件、发送、分享、上传） ───
    if (
      intentLower.includes("发送") || intentLower.includes("邮件") ||
      intentLower.includes("分享") || intentLower.includes("上传") ||
      intentLower.includes("发布") || intentLower.includes("mail") ||
      intentLower.includes("send") || intentLower.includes("share")
    ) {
      const steps = this.extractSendSteps(intent, availableTools);
      if (steps.length > 0) {
        const allPrevDeps = subGoals.map(sg => sg.id);
        subGoals.push({
          id: `sg_${uuid().slice(0, 6)}`,
          name: "发送交付",
          description: "将结果发送或分享给目标收件人",
          steps,
          dependsOn: allPrevDeps.length > 0 ? [allPrevDeps[allPrevDeps.length - 1]] : [],
          parallelizable: false,
          outputs: [{ name: "confirmation", type: "confirmation", description: "发送确认", reference: "{sendStatus}" }],
          priority: priority++,
          status: "pending",
        });
      }
    }

    // ─── 模式 5: 文件操作（打开、编辑、保存、文件） ───
    if (
      intentLower.includes("打开") || intentLower.includes("编辑") ||
      intentLower.includes("文件") || intentLower.includes("保存") ||
      intentLower.includes("读取") || intentLower.includes("open") ||
      intentLower.includes("edit")
    ) {
      const steps = this.extractFileOperationSteps(intent, availableTools);
      if (steps.length > 0) {
        subGoals.push({
          id: `sg_${uuid().slice(0, 6)}`,
          name: "文件操作",
          description: "对文件进行读写操作",
          steps,
          dependsOn: [],
          parallelizable: true,
          outputs: [{ name: "file_result", type: "file", description: "操作后的文件", reference: "{fileOutput}" }],
          priority: priority++,
          status: "pending",
        });
      }
    }

    // ─── 模式 6: 验证/确认（检查、验证、确认） ───
    if (
      intentLower.includes("检查") || intentLower.includes("验证") ||
      intentLower.includes("确认") || intentLower.includes("审核") ||
      intentLower.includes("verify") || intentLower.includes("check")
    ) {
      const allPrevDeps = subGoals.map(sg => sg.id);
      subGoals.push({
        id: `sg_${uuid().slice(0, 6)}`,
        name: "验证结果",
        description: "验证所有步骤的执行结果",
        steps: [
          {
            id: `step_${uuid().slice(0, 6)}`,
            description: "检查所有输出文件的完整性和正确性",
            tool: "run_shell",
            params: { command: "echo 'Verifying outputs...'" },
            estimatedDuration: 5000,
            successCondition: "所有文件存在且非空",
          },
        ],
        dependsOn: allPrevDeps,
        parallelizable: false,
        outputs: [{ name: "verification", type: "confirmation", description: "验证结果", reference: "{verifyStatus}" }],
        priority: priority++,
        status: "pending",
      });
    }

    // 如果没有匹配到任何模式，创建通用子目标
    if (subGoals.length === 0) {
      const words = intent.split(/[,，\s]+/).filter(w => w.length > 1);
      const keyword = words.slice(0, 3).join("_");
      subGoals.push({
        id: `sg_${uuid().slice(0, 6)}`,
        name: keyword || "执行任务",
        description: intent.slice(0, 50),
        steps: [
          {
            id: `step_${uuid().slice(0, 6)}`,
            description: intent.slice(0, 100),
            tool: "computer_use",
            params: { action: intent },
            estimatedDuration: 30000,
            maxRetries: 2,
          },
        ],
        dependsOn: [],
        parallelizable: false,
        outputs: [{ name: "result", type: "text", description: "执行结果", reference: "{result}" }],
        priority: 1,
        status: "pending",
      });
    }

    return subGoals;
  }

  // ─── 步骤提取辅助方法 ──────────────────────────────────

  /**
   * 提取数据获取步骤。
   */
  private extractDataSteps(intent: string, tools: string[]): DecomposedStep[] {
    const steps: DecomposedStep[] = [];
    const hasTerminal = tools.length === 0 || tools.includes("run_shell");

    if (intent.includes("sql") || intent.includes("数据库") || intent.includes("database")) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "执行数据库查询导出数据",
        tool: "run_shell",
        params: { command: "echo 'Executing database query...'" },
        estimatedDuration: 15000,
        successCondition: "数据导出成功且文件非空",
        maxRetries: 1,
      });
    } else if (intent.includes("网页") || intent.includes("web") || intent.includes("抓取")) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "从网页获取数据",
        tool: "browser_navigate",
        params: { url: "{dataSourceUrl}" },
        estimatedDuration: 20000,
        maxRetries: 2,
      });
    }

    if (steps.length === 0 && hasTerminal) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "从数据源获取数据",
        tool: "run_shell",
        params: { command: "echo 'Fetching data...'" },
        estimatedDuration: 10000,
        successCondition: "数据获取成功",
      });
    }

    return steps;
  }

  /**
   * 提取分析处理步骤。
   */
  private extractAnalysisSteps(intent: string, tools: string[]): DecomposedStep[] {
    const steps: DecomposedStep[] = [];

    if (intent.includes("Excel") || intent.includes("excel") || intent.includes("表格")) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "启动 Excel 打开数据文件",
        tool: "app_launch",
        params: { app: "Excel", file: "{dataOutput}" },
        estimatedDuration: 15000,
        maxRetries: 1,
      });
    }

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: intent.includes("图表") ? "创建分析图表" : "进行数据分析",
      tool: "computer_use",
      params: { action: intent.includes("图表") ? "创建数据可视化图表" : "分析数据" },
      estimatedDuration: 30000,
      maxRetries: 2,
    });

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "截图保存分析结果",
      tool: "screen_capture",
      params: { region: "chart_area" },
      estimatedDuration: 5000,
      successCondition: "截图文件已保存",
    });

    return steps;
  }

  /**
   * 提取文档撰写步骤。
   */
  private extractDocumentSteps(intent: string, tools: string[]): DecomposedStep[] {
    const steps: DecomposedStep[] = [];

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "启动文字处理软件",
      tool: intent.includes("Word") ? "app_launch" : "write_file",
      params: intent.includes("Word")
        ? { app: "Word", file: "{documentPath}" }
        : { path: "{documentPath}", content: "{summaryContent}" },
      estimatedDuration: 10000,
      maxRetries: 1,
    });

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "撰写分析摘要内容",
      tool: "computer_use",
      params: { action: "基于数据分析结果撰写文字摘要" },
      estimatedDuration: 20000,
      maxRetries: 2,
    });

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "保存文档",
      tool: "computer_use",
      params: { action: "按 Ctrl+S 保存文档" },
      estimatedDuration: 5000,
      successCondition: "文档已保存",
    });

    return steps;
  }

  /**
   * 提取发送/分享步骤。
   */
  private extractSendSteps(intent: string, tools: string[]): DecomposedStep[] {
    const steps: DecomposedStep[] = [];

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "打开邮箱/通讯工具",
      tool: "browser_navigate",
      params: { url: "{mailUrl}" },
      estimatedDuration: 15000,
      maxRetries: 2,
      fallbackStepId: undefined,
    });

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "填写收件人、主题并上传附件",
      tool: "computer_use",
      params: { action: "填写邮件收件人和主题，上传附件" },
      estimatedDuration: 30000,
      maxRetries: 2,
    });

    steps.push({
      id: `step_${uuid().slice(0, 6)}`,
      description: "点击发送按钮",
      tool: "computer_use",
      params: { action: "点击发送按钮" },
      estimatedDuration: 10000,
      successCondition: "邮件已发送",
    });

    return steps;
  }

  /**
   * 提取文件操作步骤。
   */
  private extractFileOperationSteps(intent: string, tools: string[]): DecomposedStep[] {
    const steps: DecomposedStep[] = [];
    const hasTerminal = tools.length === 0 || tools.includes("run_shell");

    if (intent.includes("打开") || intent.includes("open")) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "打开目标文件",
        tool: "app_launch",
        params: { file: "{targetFile}" },
        estimatedDuration: 10000,
        maxRetries: 1,
      });
    }

    if (intent.includes("编辑") || intent.includes("修改") || intent.includes("edit")) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "编辑文件内容",
        tool: "computer_use",
        params: { action: "修改文件内容" },
        estimatedDuration: 20000,
        maxRetries: 2,
      });
    }

    if (steps.length === 0 && hasTerminal) {
      steps.push({
        id: `step_${uuid().slice(0, 6)}`,
        description: "对文件进行操作",
        tool: "run_shell",
        params: { command: "echo 'Processing file...'" },
        estimatedDuration: 5000,
      });
    }

    return steps;
  }

  // ─── 依赖图与排序 ──────────────────────────────────────

  /**
   * 构建子目标之间的依赖图。
   */
  private buildDependencyGraph(subGoals: SubGoal[]): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const sg of subGoals) {
      // 检查显式依赖
      const deps = sg.dependsOn;

      // 检查隐式依赖：通过 outputs 引用
      for (const other of subGoals) {
        if (other.id === sg.id) continue;
        if (deps.includes(other.id)) continue;

        // 检查当前子目标的步骤是否引用了其他子目标的产出
        for (const step of sg.steps) {
          const paramsStr = JSON.stringify(step.params);
          for (const output of other.outputs) {
            if (paramsStr.includes(output.reference)) {
              if (!deps.includes(other.id)) {
                deps.push(other.id);
              }
            }
          }
        }
      }

      graph.set(sg.id, deps);
    }

    return graph;
  }

  /**
   * 拓扑排序：将子目标分组为可并行执行的层。
   */
  private topoSort(
    subGoals: SubGoal[],
    graph: Map<string, string[]>,
  ): string[][] {
    const inDegree = new Map<string, number>();
    const adjList = new Map<string, string[]>();

    // 初始化
    for (const sg of subGoals) {
      inDegree.set(sg.id, 0);
      adjList.set(sg.id, []);
    }

    // 构建入度表和邻接表
    for (const [sgId, deps] of graph) {
      inDegree.set(sgId, deps.length);
      for (const dep of deps) {
        const list = adjList.get(dep) ?? [];
        list.push(sgId);
        adjList.set(dep, list);
      }
    }

    const layers: string[][] = [];
    const processed = new Set<string>();

    while (processed.size < subGoals.length) {
      // 找出所有入度为 0 的节点
      const currentLayer: string[] = [];

      for (const [sgId, degree] of inDegree) {
        if (degree === 0 && !processed.has(sgId)) {
          currentLayer.push(sgId);
        }
      }

      if (currentLayer.length === 0) {
        // 检测到循环依赖 → 警告并打破循环
        logger.warn("Circular dependency detected in sub-goal graph");

        // 将剩余未处理的全部放入一层
        for (const sg of subGoals) {
          if (!processed.has(sg.id)) {
            currentLayer.push(sg.id);
          }
        }
        layers.push(currentLayer);
        break;
      }

      // 限制每层并行数
      const bounded = currentLayer.slice(0, this.config.maxParallelSubGoals);
      layers.push(bounded);

      // 标记已处理并更新入度
      for (const sgId of bounded) {
        processed.add(sgId);
        const neighbors = adjList.get(sgId) ?? [];
        for (const neighbor of neighbors) {
          const currentDegree = inDegree.get(neighbor) ?? 0;
          inDegree.set(neighbor, Math.max(0, currentDegree - 1));
        }
      }
    }

    return layers;
  }

  // ─── 辅助方法 ──────────────────────────────────────────

  /**
   * 生成意图分解摘要。
   */
  private generateSummary(intent: string, subGoals: SubGoal[]): string {
    const names = subGoals.map(sg => sg.name);
    return `将"${intent.slice(0, 60)}"分解为 ${subGoals.length} 个子目标：${names.join(" → ")}`;
  }

  /**
   * 估算分解置信度。
   */
  private estimateConfidence(intent: string, subGoals: SubGoal[]): number {
    if (subGoals.length === 0) return 0.3;
    if (subGoals.length === 1 && subGoals[0].name.length < 5) return 0.4;

    // 意图越长、子目标越多 → 可能越复杂，置信度略降
    const complexityFactor = Math.max(0.5, 1 - (subGoals.length - 1) * 0.05);
    const lengthFactor = Math.max(0.6, 1 - intent.length / 500);

    return parseFloat((complexityFactor * lengthFactor * 0.9).toFixed(2));
  }

  /**
   * 格式化时长。
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}min`;
  }
}
