/**
 * Tool Executor — 工具注册、执行、反思的独立模块。
 *
 * 从 AgentRuntime 中提取，降低 runtime.ts 的复杂度。
 * 所有函数设计为纯函数风格，通过参数接收所需状态，不依赖类实例。
 *
 * 职责：
 *   - buildToolDefinitions：将注册的工具转换为 LLM function calling 格式
 *   - executeTool：完整的工具执行管线（权限检查 → 沙箱选择 → 参数解析 → 执行 → 超时保护）
 *   - collectAttachments：从工具结果中提取文件附件
 *   - handleToolReflection：工具失败后的反思钩子（软引导注入 + Evolution 联动）
 *   - summarizeRecentSteps：摘要近 3 步动作供反思 Prompt 使用
 *   - appendReflectionRecord：将反思记录追写到 session.metadata
 */

import { zodToJsonSchema } from "zod-to-json-schema";
import pino from "pino";
import type { LLMToolDef } from "../llm/provider.js";
import type { LLMProvider } from "../llm/provider.js";
import type {
  Attachment,
  Session,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";
import type { SecurityManager } from "../security/sandbox.js";
import {
  CODE_EXEC_TOOL_NAMES,
  checkCodeExecAllowed,
  isBuiltinByMetadata,
} from "../security/code-exec-guard.js";
import type { ReflectionEngine, ReflectionResult } from "./reflection.js";
import { mapReflectionCategoryToFailureCategory } from "../evolution/engine.js";
import {
  truncateToolResult,
  calculateMaxSingleResultChars,
} from "../context/tool-result-truncation.js";
import { getModelById } from "../llm/model-catalog.js";

const logger = pino({ name: "tool-executor" });

// ─── 类型定义 ──────────────────────────────────────────────

/** executeTool 所需的全部运行时状态（避免传递整个 AgentRuntime）。 */
export interface ExecuteToolParams {
  name: string;
  argsString: string;
  tools: Map<string, ToolDefinition>;
  securityManager?: SecurityManager;
  agentId: string;
  session: Session;
  /** Agent 配置元数据，用于 checkCodeExecAllowed 的 builtin 判定。 */
  configMetadata?: Record<string, unknown>;
}

/** handleToolReflection 所需的参数。 */
export interface HandleToolReflectionParams {
  session: Session;
  toolName: string;
  argsString: string;
  result: ToolResult;
  reflection: ReflectionEngine;
  llm: LLMProvider;
  agentId: string;
}

/** buildToolDefinitions 所需的参数。 */
export interface BuildToolDefsParams {
  tools: Map<string, ToolDefinition>;
  /** 模型 provider ID（用于 model-catalog 查找）。 */
  providerId: string;
  /** 模型名称。 */
  model: string;
  /** 预获取的模型定义（避免重复 DB 查询），可选。 */
  modelDefCache?: ReturnType<typeof getModelById>;
}

// ─── buildToolDefinitions ──────────────────────────────────

/**
 * 将注册的工具转换为 LLM function calling 格式。
 *
 * Task 4: 动态裁剪 — 工具数超过上限时优先保留核心工具。
 * Task 7: 模型不支持函数调用时跳过工具定义。
 */
export function buildToolDefinitions(params: BuildToolDefsParams): LLMToolDef[] {
  const { tools, providerId, model } = params;

  // Task 7: 如果模型不支持函数调用，跳过工具定义（节省 token）
  const modelDef = params.modelDefCache ?? getModelById(providerId, model);
  if (modelDef && !modelDef.supportsFunctions) {
    logger.info(
      { model: modelDef.id, supportsFunctions: false },
      "Model does not support functions, skipping tool definitions",
    );
    return [];
  }

  const defs: LLMToolDef[] = [];
  for (const [name, tool] of tools) {
    // Prefer rawJsonSchema (used by MCP tools) over Zod→JSON conversion
    const parameters = tool.rawJsonSchema
      ? tool.rawJsonSchema
      : tool.parameters
        ? (zodToJsonSchema(tool.parameters, { target: "openAi" }) as Record<string, unknown>)
        : { type: "object", properties: {} };

    defs.push({
      type: "function",
      function: {
        name,
        description: tool.description,
        parameters,
      },
    });
  }

  // Task 4+6.1: 三级裁剪 — core(不裁) > sysops(次优先裁) > mcp_(最先裁)
  // 扩展原有二级裁剪，新增 sysops 前缀识别层
  const MAX_TOOL_DEFS = 60;
  if (defs.length > MAX_TOOL_DEFS) {
    // 三级分类
    const isSysops = (d: LLMToolDef) => {
      const n = d.function.name;
      return n === "terminal" || n === "process_poll" || n === "process_kill" || n === "computer_use"
        || n.startsWith("docker_") || n.startsWith("service_") || n.startsWith("net_")
        || n.startsWith("sys_") || n.startsWith("deploy_") || n.startsWith("mouse_")
        || n.startsWith("keyboard_") || n.startsWith("window_") || n.startsWith("screen_")
        || n.startsWith("app_") || n.startsWith("pkg_") || n.startsWith("test_")
        || n.startsWith("build_") || n.startsWith("lint_") || n.startsWith("env_");
    };
    const core = defs.filter((d) => !isSysops(d) && !d.function.name.startsWith("mcp_"));
    const sysops = defs.filter((d) => isSysops(d));
    const external = defs.filter((d) => d.function.name.startsWith("mcp_"));

    // 裁剪优先级: 先裁 mcp_ → 再裁 sysops → core 永不裁
    let pruned: LLMToolDef[];
    let budget = MAX_TOOL_DEFS - core.length;
    if (budget <= 0) {
      pruned = core.slice(0, MAX_TOOL_DEFS);
    } else {
      const keptSysops = sysops.slice(0, Math.min(sysops.length, budget));
      budget -= keptSysops.length;
      const keptExternal = budget > 0 ? external.slice(0, budget) : [];
      pruned = [...core, ...keptSysops, ...keptExternal];
    }

    logger.warn(
      {
        original: defs.length, pruned: pruned.length,
        core: core.length, sysops: sysops.length, external: external.length,
        droppedSysops: sysops.length - pruned.filter(d => isSysops(d)).length,
        droppedExternal: external.length - pruned.filter(d => d.function.name.startsWith("mcp_")).length,
      },
      "Dynamic tool pruning: three-tier truncation applied",
    );
    return pruned;
  }

  return defs;
}

// ─── executeTool ───────────────────────────────────────────

/**
 * 执行单个工具调用，包含完整的权限检查、沙箱选择、参数解析、执行、超时保护管线。
 *
 * 安全等级（由低到高）：
 *   none → process → container/docker → ssh
 */
export async function executeTool(params: ExecuteToolParams): Promise<ToolResult> {
  const { name, argsString, tools, securityManager, agentId, session, configMetadata } = params;

  const tool = tools.get(name);
  if (!tool) {
    return {
      success: false,
      output: `Tool "${name}" not found.`,
      error: `Unknown tool: ${name}`,
    };
  }

  try {
    // Security check: verify tool permission
    let sandboxLevel: "none" | "process" | "container" | "docker" | "ssh" = "none";
    if (securityManager) {
      const perm = securityManager.checkPermission(name, agentId);
      if (!perm.allowed) {
        logger.warn({ agentId, tool: name, reason: perm.reason }, "Tool execution denied");
        return {
          success: false,
          output: `Permission denied for tool "${name}": ${perm.reason ?? "blocked by policy"}`,
          error: "Permission denied",
        };
      }
      sandboxLevel = perm.sandboxLevel;
    }

    // SEC-P0-03: 代码执行工具集中拦截（方案 B 最小侵入）
    // 在 checkPermission 之后、参数解析之前做一次补充判定，避免用户自定义
    // Agent 通过默认 policy（defaultSandbox=none）绕过沙箱直接 spawn 宿主进程。
    if (CODE_EXEC_TOOL_NAMES.has(name)) {
      const isBuiltin = isBuiltinByMetadata(configMetadata);
      const decision = checkCodeExecAllowed({
        toolName: name,
        isBuiltinAgent: isBuiltin,
        sandboxLevel,
      });
      if (!decision.allowed) {
        if (securityManager) {
          securityManager.recordExecution(name, agentId, "denied");
        }
        logger.warn(
          { agentId, tool: name, sandboxLevel },
          "Code execution denied by SEC-P0-03 guard",
        );
        return {
          success: false,
          output: decision.reason ?? "Code execution denied",
          error: "Permission denied (code-exec guard)",
        };
      }
      // 环境变量提升场景：sandboxLevel=none → process，走 ProcessSandbox 分支
      if (decision.effectiveSandboxLevel !== sandboxLevel) {
        logger.info(
          { agentId, tool: name, from: sandboxLevel, to: decision.effectiveSandboxLevel },
          "Code execution sandboxLevel auto-upgraded by env",
        );
        sandboxLevel = decision.effectiveSandboxLevel;
      }
      if (decision.viaWhitelist) {
        logger.debug(
          { agentId, tool: name },
          "Code execution allowed via builtin-agent whitelist",
        );
      }
    }

    // P2-09: Parse args separately with clear error message
    let args: unknown;
    try {
      args = JSON.parse(argsString);
    } catch (parseErr) {
      const parseMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
      logger.warn({ agentId, tool: name, error: parseMsg }, "Invalid tool arguments JSON");
      return {
        success: false,
        output: `Invalid arguments for tool "${name}": ${parseMsg}`,
        error: `JSON parse error: ${parseMsg}`,
      };
    }

    // Security: resolve {{secret:NAME}} token references in args
    if (securityManager) {
      args = securityManager.tokenProxy.resolveObject(args, agentId, name);
    }

    const context = {
      agentId,
      sessionId: session.id,
      userId: session.userId,
      channelId: session.channelId,
    };

    // Execute with process-level sandbox if required
    if (sandboxLevel === "process" && securityManager) {
      logger.info({ agentId, tool: name }, "Executing tool in process sandbox");
      const sandboxResult = await securityManager.sandbox.executeWithTimeout(
        () => tool.execute(args, context),
        { timeoutMs: 30000, maxHeapMB: 128 },
      );

      if (sandboxResult.timedOut) {
        securityManager.recordExecution(name, agentId, "error");
        return {
          success: false,
          output: `Tool "${name}" timed out in sandbox`,
          error: sandboxResult.error,
        };
      }
      if (sandboxResult.error) {
        securityManager.recordExecution(name, agentId, "error");
        return {
          success: false,
          output: `Tool "${name}" error in sandbox: ${sandboxResult.error}`,
          error: sandboxResult.error,
        };
      }

      // P1-10: Safe access — result may be undefined if sandbox had an unexpected exit
      securityManager.recordExecution(name, agentId, "success");
      return sandboxResult.result ?? {
        success: true,
        output: "Tool completed (no structured result returned)",
      };
    }

    // Execute with Docker container sandbox
    if ((sandboxLevel === "docker" || sandboxLevel === "container") && securityManager) {
      const dockerBackend = securityManager.dockerSandbox;
      if (dockerBackend) {
        logger.info({ agentId, tool: name }, "Executing tool in Docker sandbox");
        const dockerResult = await dockerBackend.execute(
          JSON.stringify(args),
          "javascript",
        );

        if (!dockerResult.success) {
          securityManager.recordExecution(name, agentId, "error");
          return {
            success: false,
            output: `Tool "${name}" error in Docker sandbox: ${dockerResult.error ?? dockerResult.output}`,
            error: dockerResult.error,
          };
        }

        securityManager.recordExecution(name, agentId, "success");
        return { success: true, output: dockerResult.output };
      }
      // Fallback to process sandbox if Docker not available
      // P2 沙箱降级透明化：标注实际沙箱级别，消除安全预期落差
      logger.warn({ agentId, tool: name }, "Docker sandbox not available, falling back to process sandbox");
      const fallbackResult = await securityManager.sandbox.executeWithTimeout(
        () => tool.execute(args, context),
        { timeoutMs: 30000, maxHeapMB: 128 },
      );
      securityManager.recordExecution(name, agentId, fallbackResult.error ? "error" : "success");
      return fallbackResult.result ?? {
        success: !fallbackResult.error,
        output: fallbackResult.error ?? "Tool completed (fallback from Docker to process sandbox)",
        error: fallbackResult.error,
        _sandboxLevel: "process",
        _sandboxNote: "Docker 不可用，已自动降级到进程隔离。如需容器隔离，请确保 Docker 已启动。",
      };
    }

    // Execute with SSH remote sandbox
    if (sandboxLevel === "ssh" && securityManager) {
      const sshBackend = securityManager.sshSandbox;
      if (sshBackend) {
        logger.info({ agentId, tool: name }, "Executing tool in SSH sandbox");
        const sshResult = await sshBackend.execute(
          JSON.stringify(args),
          "javascript",
        );

        if (!sshResult.success) {
          securityManager.recordExecution(name, agentId, "error");
          return {
            success: false,
            output: `Tool "${name}" error in SSH sandbox: ${sshResult.error ?? sshResult.output}`,
            error: sshResult.error,
          };
        }

        securityManager.recordExecution(name, agentId, "success");
        return { success: true, output: sshResult.output };
      }
      // Fallback to process sandbox if SSH not configured
      // P2 沙箱降级透明化：标注实际沙箱级别
      logger.warn({ agentId, tool: name }, "SSH sandbox not available, falling back to process sandbox");
      const fallbackResult = await securityManager.sandbox.executeWithTimeout(
        () => tool.execute(args, context),
        { timeoutMs: 30000, maxHeapMB: 128 },
      );
      securityManager.recordExecution(name, agentId, fallbackResult.error ? "error" : "success");
      return fallbackResult.result ?? {
        success: !fallbackResult.error,
        output: fallbackResult.error ?? "Tool completed (fallback from SSH to process sandbox)",
        error: fallbackResult.error,
        _sandboxLevel: "process",
        _sandboxNote: "SSH 沙箱不可用，已自动降级到进程隔离。",
      };
    }

    // Normal execution (no sandbox or sandbox level is "none")
    // P1 安全加固：Promise.race 添加 60s 超时保护，防止工具死循环挂死 Agent
    const result = await Promise.race([
      tool.execute(args, context),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Tool "${name}" execution timed out after 60s`)), 60_000)
      ),
    ]);
    if (securityManager) {
      securityManager.recordExecution(name, agentId, "success");
    }
    return result;
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    logger.error({ agentId, tool: name, error: errMsg }, "Tool execution error");
    if (securityManager) {
      securityManager.recordExecution(name, agentId, "error");
    }
    return {
      success: false,
      output: `Error executing tool "${name}": ${errMsg}`,
      error: errMsg,
    };
  }
}

// ─── collectAttachments ────────────────────────────────────

/**
 * 从工具结果中收集文件附件。
 * 支持 data.filePath（string）、data.outputPath（string）、
 * data.files（string[] 或 {path, caption}[]）。
 */
export function collectAttachments(result: ToolResult, attachments: Attachment[]): void {
  if (!result.success || !result.data) return;
  const d = result.data as Record<string, unknown>;

  // Single file path
  if (typeof d.filePath === "string" && d.filePath) {
    attachments.push({ path: d.filePath, caption: typeof d.caption === "string" ? d.caption : undefined });
  }
  if (typeof d.outputPath === "string" && d.outputPath) {
    attachments.push({ path: d.outputPath });
  }

  // Array of files
  if (Array.isArray(d.files)) {
    for (const f of d.files) {
      if (typeof f === "string" && f) {
        attachments.push({ path: f });
      } else if (f && typeof f === "object" && typeof (f as Record<string, unknown>).path === "string") {
        const fo = f as Record<string, unknown>;
        attachments.push({
          path: fo.path as string,
          caption: typeof fo.caption === "string" ? fo.caption : undefined,
          mimeType: typeof fo.mimeType === "string" ? fo.mimeType : undefined,
        });
      }
    }
  }
}

// ─── 反思相关 ──────────────────────────────────────────────

/**
 * T2: 处理工具执行后的反思钩子。
 *
 * 行为：
 *   - 成功：清零该工具的连续失败计数
 *   - 失败：触发反思；若获得有效建议，将 user 消息注入下一轮对话作为弱引导；
 *     同时将反思结果写入 session.metadata.reflections 供 T2.4 Evolution 联动使用
 *
 * 容错：任何异常都不会向上抛，保证主对话循环不被反思问题中断。
 */
export async function handleToolReflection(params: HandleToolReflectionParams): Promise<void> {
  const { session, toolName, argsString, result, reflection, llm, agentId } = params;

  try {
    if (result.success) {
      // 成功时清零该工具的连续失败计数
      reflection.noteToolSuccess(session.id, toolName);
      return;
    }

    // 失败分支：尝试解析参数以供反思使用（解析失败并不阻止流程，直接用原始字符串）
    let parsedArgs: unknown = argsString;
    try {
      parsedArgs = JSON.parse(argsString);
    } catch {
      /* 参数 JSON 解析失败时保留原始字符串 */
    }
    const errorText = result.error ?? result.output ?? "(unknown error)";

    const reflectionResult = await reflection.reflect(
      session.id,
      toolName,
      parsedArgs,
      errorText,
      llm,
      { recentSteps: summarizeRecentSteps(session) },
    );

    if (!reflectionResult) return;

    // 1) 软引导：用 user 角色注入提示（与 buildInvalidToolCallRejectMessage 模式一致，部分
    //    LLM provider 不允许非 standards 的 system 角色穿插在对话中间）
    session.messages.push({
      role: "user",
      content: `[系统提示] [Reflection] ${reflectionResult.suggestion}`,
    });

    // 2) 写入 session.metadata.reflections 供 T2.4 Evolution 联动（metadata.source="reflection" 去重）
    appendReflectionRecord(session, toolName, reflectionResult);

    logger.info(
      {
        agentId,
        sessionId: session.id,
        tool: toolName,
        category: reflectionResult.category,
        strategy: reflectionResult.strategy,
        shouldRetry: reflectionResult.shouldRetry,
      },
      "Reflection injected after tool failure",
    );
  } catch (err) {
    // 反思钩子任何异常都不能影响主对话
    logger.warn(
      { agentId, tool: toolName, err: err instanceof Error ? err.message : String(err) },
      "handleToolReflection error (non-fatal)",
    );
  }
}

/**
 * 摘要近 3 步动作（tool_call / assistant），供反思 Prompt 参考。
 * 格式："step1 → step2 → step3"
 */
export function summarizeRecentSteps(session: Session): string {
  const steps: string[] = [];
  for (let i = session.messages.length - 1; i >= 0 && steps.length < 3; i--) {
    const m = session.messages[i];
    if (m.role === "assistant" && m.toolCalls?.length) {
      steps.unshift(m.toolCalls.map((t) => t.function.name).join(","));
    } else if (m.role === "tool") {
      const content = typeof m.content === "string" ? m.content : "";
      steps.unshift(`tool:${content.slice(0, 60).replace(/\s+/g, " ")}`);
    }
  }
  return steps.join(" → ");
}

/** 将单条反思记录追写到 session.metadata.reflections */
export function appendReflectionRecord(
  session: Session,
  toolName: string,
  reflection: ReflectionResult,
): void {
  const metaAny = session.metadata as Record<string, unknown>;
  const list = Array.isArray(metaAny.reflections)
    ? (metaAny.reflections as Array<Record<string, unknown>>)
    : [];
  list.push({
    toolName,
    category: reflection.category,
    strategy: reflection.strategy,
    suggestion: reflection.suggestion,
    shouldRetry: reflection.shouldRetry,
    timestamp: new Date().toISOString(),
  });
  metaAny.reflections = list;
}
