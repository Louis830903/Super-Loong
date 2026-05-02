/**
 * 代码执行工具安全网关（SEC-P0-03 · 方案 B 最小侵入）
 *
 * 设计意图：
 *   code-exec.ts 里的 run_python / run_javascript / run_shell 直接通过
 *   child_process.spawn 以宿主进程权限执行任意代码，在"用户自定义 Agent"
 *   场景下是明显的逃逸风险。本模块提供**纯函数形式**的集中拦截规则，
 *   由 runtime.executeTool 在 checkPermission 之后调用，以避免侵入
 *   code-exec.ts 已验证的 spawn/timeout 链路。
 *
 * 判定顺序（与 docs/AUDIT-FIX-SPEC-2026-04-24.md SEC-P0-03 v2 一致）：
 *   1. 工具名不在代码执行白名单集合 → 不拦截（直接放行，非本模块职责）
 *   2. Agent.metadata.isBuiltin === true（ResearchCrew / DataAnalyst 等
 *      内置系统级 Agent）→ 白名单放行，保留开箱即用体验
 *   3. 环境变量 SUPER_AGENT_SANDBOX_LEVEL 或 SUPER_AGENT_CODE_EXEC_ENABLED
 *      决定默认 sandboxLevel：
 *        - SUPER_AGENT_SANDBOX_LEVEL=process|docker|container → 直接放行
 *        - SUPER_AGENT_CODE_EXEC_ENABLED=true （兼容旧开关）→ 视为 process
 *        - 均未设置 → 用户自定义 Agent 的 sandboxLevel=none 时拒绝
 *   4. SecurityManager.checkPermission 返回的 sandboxLevel 不是 "none"
 *      → 已有沙箱隔离（process/docker/container/ssh）→ 放行
 *   5. 其它情况（sandboxLevel=none + 非内置 + 环境变量未开启）→ 拒绝
 */

/** 受本模块拦截的代码执行工具名集合（与 tools/code-exec.ts 的 3 个工具对应） */
export const CODE_EXEC_TOOL_NAMES: ReadonlySet<string> = new Set([
  "run_python",
  "run_javascript",
  "run_shell",
]);

/** sandboxLevel 取值域（与 SecurityManager.checkPermission 返回一致） */
export type SandboxLevel = "none" | "process" | "container" | "docker" | "ssh";

/**
 * 从环境变量解析默认 sandboxLevel 来源：
 *   - SUPER_AGENT_SANDBOX_LEVEL 优先级最高（支持 process/docker/container，不支持 ssh）
 *   - SUPER_AGENT_CODE_EXEC_ENABLED=true 兼容旧版本开关，等价于 process
 *   - 均未设置返回 null，由调用方决定拒绝策略
 */
export function resolveEnvSandboxLevel(): SandboxLevel | null {
  const raw = process.env.SUPER_AGENT_SANDBOX_LEVEL?.trim().toLowerCase();
  if (raw === "process" || raw === "docker" || raw === "container") {
    return raw;
  }
  // 明确拒绝场景：SUPER_AGENT_SANDBOX_LEVEL=none → 返回 none，走拒绝分支
  if (raw === "none") {
    return "none";
  }
  if (process.env.SUPER_AGENT_CODE_EXEC_ENABLED === "true") {
    return "process";
  }
  return null;
}

/** 拦截判定输入 */
export interface CodeExecGuardInput {
  /** 工具名，与 ToolDefinition.name 对齐 */
  toolName: string;
  /** 当前 Agent 是否为系统级内置 Agent（通常来自 config.metadata.isBuiltin） */
  isBuiltinAgent: boolean;
  /** SecurityManager.checkPermission() 返回的 sandboxLevel */
  sandboxLevel: SandboxLevel;
}

/** 拦截判定结果 */
export interface CodeExecGuardDecision {
  /** true = 允许执行；false = 拒绝 */
  allowed: boolean;
  /**
   * 最终生效的 sandboxLevel。allowed=true 时有效。
   * 当 sandboxLevel="none" 但环境变量开启 process 级别时，本字段会返回
   * "process"，runtime 应据此将执行路径切到 ProcessSandbox。
   */
  effectiveSandboxLevel: SandboxLevel;
  /** 拒绝原因（用户可读），allowed=false 时必填 */
  reason?: string;
  /** 是否受白名单放行（供审计日志使用） */
  viaWhitelist?: boolean;
}

/**
 * 统一拒绝文案 —— 告诉管理员怎么开启，避免静默失败。
 */
function buildDeniedMessage(toolName: string): string {
  return (
    `代码执行工具 "${toolName}" 已被沙箱策略拒绝。\n` +
    "当前 Agent 非系统级内置 Agent，且未配置任何代码执行沙箱（sandboxLevel=none）。\n" +
    "开启方式（任选其一）：\n" +
    '  - 设置环境变量 SUPER_AGENT_CODE_EXEC_ENABLED=true 后重启（等价 process 级）\n' +
    '  - 设置环境变量 SUPER_AGENT_SANDBOX_LEVEL=process|docker|container 后重启\n' +
    "  - 管理员在安全策略中将该工具的 sandboxLevel 配置为非 none（推荐 process/docker）\n" +
    "仅限可信环境使用，生产环境建议使用 docker 沙箱。"
  );
}

/**
 * 集中判定 —— runtime.executeTool 在 checkPermission 之后调用。
 *
 * 注意：本函数**纯函数**，不读取全局状态（环境变量读取封装在 resolveEnvSandboxLevel 内，
 * 由调用方在合适时机取值后传入；这里保留直接调用以简化 runtime 集成）。
 */
export function checkCodeExecAllowed(
  input: CodeExecGuardInput,
): CodeExecGuardDecision {
  const { toolName, isBuiltinAgent, sandboxLevel } = input;

  // 非代码执行工具 —— 本模块不做判定（runtime 侧通过 CODE_EXEC_TOOL_NAMES 提前过滤）
  if (!CODE_EXEC_TOOL_NAMES.has(toolName)) {
    return { allowed: true, effectiveSandboxLevel: sandboxLevel };
  }

  // ① 系统级内置 Agent 白名单放行（保留 ResearchCrew/DataAnalyst/VideoCrew 开箱即用）
  if (isBuiltinAgent) {
    return {
      allowed: true,
      effectiveSandboxLevel: sandboxLevel,
      viaWhitelist: true,
    };
  }

  // ② 已有非 none 沙箱 —— 直接放行（policy 已按 process/docker/container/ssh 隔离）
  if (sandboxLevel !== "none") {
    return { allowed: true, effectiveSandboxLevel: sandboxLevel };
  }

  // ③ sandboxLevel=none，尝试从环境变量提升
  const envLevel = resolveEnvSandboxLevel();
  if (envLevel && envLevel !== "none") {
    return { allowed: true, effectiveSandboxLevel: envLevel };
  }

  // ④ 其它情况 —— 拒绝
  return {
    allowed: false,
    effectiveSandboxLevel: "none",
    reason: buildDeniedMessage(toolName),
  };
}

/**
 * 便捷判断：给定 AgentConfig.metadata 判定是否为内置 Agent。
 * 统一 Day 1 已验证的 metadata.isBuiltin === true 判据，避免多处散落。
 */
export function isBuiltinByMetadata(
  metadata: Record<string, unknown> | undefined | null,
): boolean {
  if (!metadata || typeof metadata !== "object") return false;
  return (metadata as { isBuiltin?: unknown }).isBuiltin === true;
}
