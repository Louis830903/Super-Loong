/**
 * AgentMatcher — Hierarchical 模式下的智能 Agent 匹配与动态创建。
 *
 * 职责（两阶段筛选）：
 *   阶段 1A: 关键词粗筛 — 从现有 Agent 池中按 role/goal/description 字符串匹配打分，取 top-10
 *   阶段 1B: LLM 精选   — Manager 从候选中选最佳匹配，或决定需要新建
 *   阶段 2 : 动态创建   — 若选定"新建"，由 LLM 输出 AgentConfig，调用 AgentManager.createAgent()
 *
 * 设计原则：
 * - 低耦合：仅依赖 AgentManager / AgentRuntime，不侵入 Orchestrator 其它流程
 * - 向后兼容：autoAssign=false 时整个模块不被调用
 * - 安全边界：动态 Agent 继承 globalLlmConfig（不允许 LLM 自指定模型）
 *               tools 从全局工具池白名单筛选（不允许凭空发明工具）
 */

import pino from "pino";
import type { AgentManager } from "../agent/manager.js";
import type { AgentRuntime } from "../agent/runtime.js";
import type { LLMProviderConfig } from "../types/index.js";

const logger = pino({ name: "agent-matcher" });

/**
 * P0-2：匹配阶段 LLM 精选并发上限。
 * 限制单批 crew 内同时对 Manager LLM 的请求数，避免 5+ 任务瞬时打爆上游限流/配额。
 * 取值权衡：
 *   - 过低（1）= 退化为串行，失去并发收益
 *   - 过高（>=5）= 可能触发 OpenAI/Anthropic 的 RPM 限流
 *   - 3 = 经验值，兼顾吞吐与稳定性；必要时可改为从环境变量读取
 */
const MATCH_CONCURRENCY = 3;

/**
 * P0-2：自实现信号量式并发限流器（不引入 p-limit 外部依赖）。
 * 语义等价于 Promise.allSettled + 最多 limit 个在途，保证单任务失败不拖垮整批。
 *
 * @param items 待处理项
 * @param limit 最大并发度（会自动与 items.length 取较小值）
 * @param fn    每项的异步处理函数
 * @returns 与输入顺序对齐的 PromiseSettledResult 数组
 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  if (items.length === 0) return results;
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const idx = cursor++;
      if (idx >= items.length) return;
      try {
        const value = await fn(items[idx], idx);
        results[idx] = { status: "fulfilled", value };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// ─── 类型定义 ───────────────────────────────────────────────

/** Agent 匹配请求 */
export interface MatchRequest {
  taskId: string;
  taskDescription: string;
  expectedOutput: string;
  requiredCapabilities?: string[];
}

/** LLM 生成的新 Agent 规格（受限字段，防止 LLM 输出非法配置） */
export interface NewAgentSpec {
  name: string;
  role: string;
  goal: string;
  backstory: string;
  /** 从全局工具池白名单中选择的工具名 */
  tools: string[];
  /** 技能名列表 */
  skills: string[];
}

/** Agent 匹配结果 */
export interface MatchResult {
  taskId: string;
  /** 匹配到的现有 Agent ID（与 newAgentConfig 互斥，至少一个非空） */
  matchedAgentId: string | null;
  /** 需要新建的 Agent 配置（与 matchedAgentId 互斥） */
  newAgentConfig: NewAgentSpec | null;
  /** 匹配/新建原因（用于日志追溯） */
  reason: string;
}

/** 候选 Agent 条目（粗筛阶段内部使用） */
interface AgentCandidate {
  id: string;
  name: string;
  role: string;
  goal: string;
  description: string;
  tools: string[];
  skills: string[];
  score: number;
}

// ─── 工具函数 ───────────────────────────────────────────────

/** 简单超时包装（不引入外部依赖，与 orchestrator.ts withTimeout 语义一致） */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 从 LLM 输出中提取最后一个合法 JSON 对象（策略与 orchestrator.extractJsonArray 对齐） */
function extractJsonObject(text: string): Record<string, unknown> | null {
  // 策略 1: 直接解析
  try {
    const obj = JSON.parse(text.trim());
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      return obj as Record<string, unknown>;
    }
  } catch {
    /* 继续下一策略 */
  }
  // P2-2：策略 2 重写——括号平衡扫描，正确处理嵌套对象 / 转义字符 / 字符串。
  // 原实现使用 /\{[\s\S]*?\}/g 非贪婪匹配，遇到第一个 '}' 即刪断，
  // 导致嵌套对象（如 { spec: { role: "..." } }）或字符串中包含 '}' 时解析失败。
  const candidates = findBalancedJsonObjects(text);
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const obj = JSON.parse(candidates[i]);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        return obj as Record<string, unknown>;
      }
    } catch {
      /* 跳过无效候选 */
    }
  }
  return null;
}

/**
 * P2-2：以括号平衡法扫描文本，抓取所有顶层完整的 `{...}` 子串。
 * 平衡规则：
 *   - 遇 '{' depth++；遇 '}' depth--，depth 归零时记录一个候选
 *   - 在字符串内部（" ... "）忽略所有括号
 *   - 处理转义字符 \" \\，避免把转义引号误判为字符串结束
 * 性能：O(n) 单遭扫描，对几 KB 级的 LLM 输出完全足够。
 */
function findBalancedJsonObjects(text: string): string[] {
  const results: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start !== -1) {
          results.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return results;
}

/** 简易分词（中英文混合友好：按空白、标点、中文字符切分） */
function tokenize(text: string): string[] {
  if (!text) return [];
  // 提取英文单词（长度 >=2）和单个中文字符
  const tokens: string[] = [];
  const enMatches = text.toLowerCase().match(/[a-z0-9]{2,}/g);
  if (enMatches) tokens.push(...enMatches);
  const cnMatches = text.match(/[\u4e00-\u9fa5]/g);
  if (cnMatches) tokens.push(...cnMatches);
  return tokens;
}

// ─── AgentMatcher ───────────────────────────────────────────

export class AgentMatcher {
  /** 候选池大小（粗筛后 top-N 进入 LLM 精选） */
  private static readonly TOP_CANDIDATES = 10;
  /** LLM 精选超时（毫秒） */
  private static readonly LLM_SELECT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly agentManager: AgentManager,
    private readonly managerAgent: AgentRuntime,
    private readonly globalLlmConfig: LLMProviderConfig,
  ) {}

  /**
   * 批量匹配：对每个无 agentId 的任务，返回匹配结果或新建规格。
   *
   * P0-2 两阶段执行：
   *   第一轮（并发 + 限流）：用 mapLimit 以最多 MATCH_CONCURRENCY 并发执行 preFilter + llmSelect，
   *                        allowCreate 统一为 maxDynamic>0；单任务失败由 Promise.allSettled 捕获
   *   第二轮（串行）：按原顺序处理结果，应用 dynamicQuota 配额逻辑（耗尽则降级到 top-1 或抛错）
   *
   * @param requests 待分配的任务请求列表
   * @param maxDynamic 单次最多动态创建的 Agent 数（硬上限）
   */
  async matchAll(requests: MatchRequest[], maxDynamic: number): Promise<MatchResult[]> {
    if (requests.length === 0) return [];

    const cap = Math.max(0, Math.min(maxDynamic, 30)); // 硬上限 30
    const allowCreate = cap > 0;

    // 第一轮：并发限流执行 preFilter + llmSelect
    const preliminary = await mapLimit(
      requests,
      MATCH_CONCURRENCY,
      (req) => this.matchOne(req, allowCreate),
    );

    // 第二轮：按顺序应用配额
    const results: MatchResult[] = [];
    let dynamicQuota = cap;
    for (let i = 0; i < preliminary.length; i++) {
      const settled = preliminary[i];
      const req = requests[i];

      if (settled.status === "rejected") {
        // 单任务异常：记录后抛出，交由上层 runHierarchical 的 try/catch 处理
        logger.error(
          { taskId: req.taskId, err: settled.reason },
          "matchOne failed in concurrent phase",
        );
        throw settled.reason instanceof Error
          ? settled.reason
          : new Error(String(settled.reason));
      }

      const { result, candidates } = settled.value;

      // 动态创建配额管理（串行扣减，保证单调）
      if (result.newAgentConfig) {
        if (dynamicQuota <= 0) {
          // 配额耗尽但仍请求新建 → 降级到粗筛第一名或标记失败
          if (candidates.length > 0) {
            logger.warn(
              { taskId: req.taskId, cap: maxDynamic },
              "Dynamic agent quota exhausted, falling back to top-1 candidate",
            );
            results.push({
              taskId: req.taskId,
              matchedAgentId: candidates[0].id,
              newAgentConfig: null,
              reason: `Dynamic quota exhausted, fallback to top candidate ${candidates[0].name}`,
            });
            continue;
          }
          // 无候选也无配额：抛错，由上层处理
          throw new Error(
            `Task '${req.taskId}' requires a new agent but quota (${maxDynamic}) exhausted and no candidates available`,
          );
        }
        dynamicQuota--;
      }

      results.push(result);
    }

    return results;
  }

  /**
   * P0-2：单任务匹配（供 mapLimit 并发调用）。
   * 封装 preFilter + llmSelect 两步，返回结果与候选池（第二轮降级需要候选）。
   * allowCreate 由 matchAll 外部传入（基于整批 maxDynamic 判断），本方法不感知剩余配额。
   */
  private async matchOne(
    req: MatchRequest,
    allowCreate: boolean,
  ): Promise<{ result: MatchResult; candidates: AgentCandidate[] }> {
    // 阶段 1A: 粗筛
    const candidates = this.preFilter(req);
    logger.debug(
      { taskId: req.taskId, candidateCount: candidates.length },
      "AgentMatcher pre-filter done",
    );
    // 阶段 1B: LLM 精选（若无候选，直接走新建路径）
    const result = await this.llmSelect(req, candidates, allowCreate);
    return { result, candidates };
  }

  /**
   * 阶段 1A: 关键词粗筛。
   * 评分规则：
   *   - task.description / expectedOutput 分词
   *   - 对 agent.role + goal + description 逐词匹配：精确 +3、包含 +1
   *   - requiredCapabilities 命中 agent.tools/skills：+5/次
   * 返回 score > 0 的候选，按分数降序取 top-10。
   */
  private preFilter(request: MatchRequest): AgentCandidate[] {
    const taskText = `${request.taskDescription} ${request.expectedOutput}`;
    const taskTokens = new Set(tokenize(taskText));
    if (taskTokens.size === 0) return [];

    const requiredCaps = (request.requiredCapabilities ?? []).map((c) => c.toLowerCase());

    const scored: AgentCandidate[] = [];
    for (const state of this.agentManager.listAgents()) {
      const cfg = state.config;
      const agentText = [
        cfg.role ?? "",
        cfg.goal ?? "",
        cfg.description ?? "",
        cfg.name,
      ].join(" ");
      const agentTokens = tokenize(agentText);
      if (agentTokens.length === 0) continue;

      let score = 0;
      const agentTextLower = agentText.toLowerCase();

      // 逐 task token 匹配
      for (const t of taskTokens) {
        if (agentTokens.includes(t)) score += 3; // 精确匹配
        else if (agentTextLower.includes(t)) score += 1; // 包含匹配
      }

      // requiredCapabilities 加权
      if (requiredCaps.length > 0) {
        const agentCaps = [...(cfg.tools ?? []), ...(cfg.skills ?? [])].map((x) =>
          x.toLowerCase(),
        );
        for (const cap of requiredCaps) {
          if (agentCaps.some((ac) => ac.includes(cap) || cap.includes(ac))) {
            score += 5;
          }
        }
      }

      if (score > 0) {
        scored.push({
          id: cfg.id,
          name: cfg.name,
          role: cfg.role ?? "",
          goal: cfg.goal ?? "",
          description: cfg.description ?? "",
          tools: cfg.tools ?? [],
          skills: cfg.skills ?? [],
          score,
        });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, AgentMatcher.TOP_CANDIDATES);
  }

  /**
   * 阶段 1B: LLM 精选。
   * Manager Agent 从候选中选择最佳匹配，或输出新建 Agent 规格。
   *
   * @param allowCreate 是否允许返回 createNew=true（配额耗尽时为 false）
   */
  private async llmSelect(
    request: MatchRequest,
    candidates: AgentCandidate[],
    allowCreate: boolean,
  ): Promise<MatchResult> {
    // 构建候选列表摘要
    const candidateList =
      candidates.length > 0
        ? candidates
            .map(
              (c, i) =>
                `${i + 1}. [id=${c.id}] ${c.name}\n   role: ${c.role || "(unspecified)"}\n   goal: ${c.goal || "(unspecified)"}`,
            )
            .join("\n\n")
        : "(no existing candidates — you must create a new agent)";

    const capsHint = request.requiredCapabilities?.length
      ? `\nRequired capabilities: ${request.requiredCapabilities.join(", ")}`
      : "";

    const createClause = allowCreate
      ? `Option B - If none of the candidates is a good fit (or there are no candidates), respond with a new agent specification:\n{"createNew": true, "spec": {"name": "...", "role": "...", "goal": "...", "backstory": "...", "tools": [], "skills": []}, "reason": "why a new agent is needed"}`
      : `(creating new agents is disabled — you MUST pick from existing candidates)`;

    const prompt = `You are assigning an agent to execute a task.

Task: ${request.taskDescription}
Expected output: ${request.expectedOutput}${capsHint}

Candidates:
${candidateList}

Respond with ONE of the following JSON formats, and nothing else:

Option A - If a candidate matches well:
{"agentId": "<the id of the chosen candidate>", "reason": "why this candidate fits"}

${createClause}

Only output the JSON object. Do not include any explanation outside the JSON.`;

    let raw: string;
    try {
      const { response } = await withTimeout(
        this.managerAgent.chat(prompt, `agent_match_${request.taskId}`),
        AgentMatcher.LLM_SELECT_TIMEOUT_MS,
        `AgentMatcher.llmSelect(${request.taskId})`,
      );
      raw = response;
    } catch (err: any) {
      logger.warn(
        { taskId: request.taskId, error: err.message },
        "LLM select failed, falling back to top-1 candidate or create",
      );
      // LLM 失败 → 降级：若有候选取第一名，否则标记需新建
      if (candidates.length > 0) {
        return {
          taskId: request.taskId,
          matchedAgentId: candidates[0].id,
          newAgentConfig: null,
          reason: `LLM unavailable, fallback to top-1 candidate: ${candidates[0].name}`,
        };
      }
      if (!allowCreate) {
        throw new Error(
          `Task '${request.taskId}' has no candidates and creation disabled; LLM also failed: ${err.message}`,
        );
      }
      return {
        taskId: request.taskId,
        matchedAgentId: null,
        newAgentConfig: this.buildFallbackSpec(request),
        reason: "LLM unavailable, generated fallback generic agent spec",
      };
    }

    const parsed = extractJsonObject(raw);
    if (!parsed) {
      logger.warn(
        { taskId: request.taskId, raw: raw.slice(0, 200) },
        "LLM output not parseable, falling back",
      );
      if (candidates.length > 0) {
        return {
          taskId: request.taskId,
          matchedAgentId: candidates[0].id,
          newAgentConfig: null,
          reason: "LLM output unparseable, fallback to top-1 candidate",
        };
      }
      return {
        taskId: request.taskId,
        matchedAgentId: null,
        newAgentConfig: allowCreate ? this.buildFallbackSpec(request) : null,
        reason: "LLM output unparseable, generated fallback spec",
      };
    }

    // Option A: 选中现有 Agent
    const pickedId = typeof parsed.agentId === "string" ? parsed.agentId : null;
    if (pickedId) {
      // 验证 id 确实在候选中（防 LLM 幻觉 ID）
      const valid = candidates.find((c) => c.id === pickedId);
      if (valid) {
        return {
          taskId: request.taskId,
          matchedAgentId: valid.id,
          newAgentConfig: null,
          reason: typeof parsed.reason === "string" ? parsed.reason : "selected by manager",
        };
      }
      logger.warn(
        { taskId: request.taskId, pickedId },
        "LLM returned id not in candidates, falling back to top-1",
      );
      if (candidates.length > 0) {
        return {
          taskId: request.taskId,
          matchedAgentId: candidates[0].id,
          newAgentConfig: null,
          reason: `LLM picked unknown id ${pickedId}, fallback to top-1`,
        };
      }
    }

    // Option B: 新建
    if (allowCreate && parsed.createNew === true && parsed.spec && typeof parsed.spec === "object") {
      const spec = this.normalizeSpec(parsed.spec as Record<string, unknown>, request);
      if (spec) {
        return {
          taskId: request.taskId,
          matchedAgentId: null,
          newAgentConfig: spec,
          reason: typeof parsed.reason === "string" ? parsed.reason : "new agent required",
        };
      }
    }

    // 兜底：无法解析出有效结果
    if (candidates.length > 0) {
      return {
        taskId: request.taskId,
        matchedAgentId: candidates[0].id,
        newAgentConfig: null,
        reason: "Unable to parse LLM decision, fallback to top-1 candidate",
      };
    }
    if (!allowCreate) {
      throw new Error(
        `Task '${request.taskId}' has no candidates, creation disabled, and LLM returned unusable output`,
      );
    }
    return {
      taskId: request.taskId,
      matchedAgentId: null,
      newAgentConfig: this.buildFallbackSpec(request),
      reason: "Unable to parse LLM decision, generated fallback spec",
    };
  }

  /**
   * 标准化 LLM 输出的 spec：校验必填字段 + 工具/技能白名单过滤。
   * 返回 null 表示 spec 无效。
   *
   * P1-2 / P2-1：
   *   - tools 白名单来源改为 agentManager.listAvailableToolNames()（统一聚合点）
   *   - skills 白名单来源改为 agentManager.listAvailableSkillNames()（修复 LLM 可能凭空造技能名的问题）
   */
  private normalizeSpec(
    raw: Record<string, unknown>,
    request: MatchRequest,
  ): NewAgentSpec | null {
    const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 100) : "";
    const role = typeof raw.role === "string" ? raw.role.trim().slice(0, 200) : "";
    const goal = typeof raw.goal === "string" ? raw.goal.trim().slice(0, 500) : "";
    if (!name || !role || !goal) {
      logger.warn({ taskId: request.taskId }, "spec missing required fields (name/role/goal)");
      return null;
    }
    const backstory =
      typeof raw.backstory === "string" ? raw.backstory.trim().slice(0, 1000) : "";

    // P2-1：工具白名单统一从 agentManager.listAvailableToolNames() 获取。
    // 同时兼容历史逻辑：其他现有 Agent 已用过的工具名也归为合法（可能包含动态注册的自定义工具）
    const knownTools = new Set<string>(this.agentManager.listAvailableToolNames());
    for (const s of this.agentManager.listAgents()) {
      for (const t of s.config.tools ?? []) knownTools.add(t);
    }
    const rawTools = Array.isArray(raw.tools) ? (raw.tools as unknown[]) : [];
    const tools = rawTools
      .filter((t): t is string => typeof t === "string")
      .filter((t) => knownTools.has(t));

    // P1-2：技能名白名单过滤——LLM 可能凭空造一个不存在的技能名，
    // 创建 Agent 时载入器会因找不到对应文件而静默忽略。提前过滤以备日志可观测。
    // 若 SkillLoader 未注入（listAvailableSkillNames 返回 []），降级为 “不过滤” 以保证向后兼容。
    const availableSkills = this.agentManager.listAvailableSkillNames();
    const rawSkills = Array.isArray(raw.skills) ? (raw.skills as unknown[]) : [];
    const skillStrings = rawSkills
      .filter((s): s is string => typeof s === "string")
      .slice(0, 20);
    const skills =
      availableSkills.length === 0
        ? skillStrings
        : skillStrings.filter((s) => {
            const ok = availableSkills.includes(s);
            if (!ok) {
              logger.warn(
                { taskId: request.taskId, skill: s },
                "LLM-proposed skill not found in whitelist, dropped",
              );
            }
            return ok;
          });

    return { name, role, goal, backstory, tools, skills };
  }

  /**
   * 兜底新 Agent 规格（当 LLM 不可用或输出不可解析时使用）。
   * 生成一个通用执行者，依赖全局工具和 LLM 能力完成任务。
   */
  private buildFallbackSpec(request: MatchRequest): NewAgentSpec {
    const shortDesc = request.taskDescription.slice(0, 50);
    return {
      name: `Auto-${request.taskId.slice(0, 8)}`,
      role: "Task Executor",
      goal: `完成任务：${shortDesc}`,
      backstory: "由 Crew Manager 自动分配创建的通用执行者。",
      tools: [],
      skills: [],
    };
  }

  /** 获取全局 LLM 配置（供 Orchestrator 创建 Agent 时复用） */
  getGlobalLlmConfig(): LLMProviderConfig {
    return this.globalLlmConfig;
  }
}
