/**
 * API 测试共享 Mock 工具
 *
 * 集中放置所有路由测试共用的 mock 类，避免每个测试文件重复造轮子。
 * 模式：沿用 kb-rest.test.ts 的"最小 AppContext"策略 —— 只 mock 路由实际用到的字段。
 */

import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import type { AppContext } from "../context.js";
import type { KBEmbedder } from "@super-agent/core";

// ─── MockEmbedder：128 维确定性向量（与 kb-rest.test.ts 同） ───

export class MockEmbedder implements KBEmbedder {
  readonly embeddingType = "simple" as const;

  async embed(text: string): Promise<number[]> {
    const dim = 128;
    const vec = new Array<number>(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[text.charCodeAt(i) % dim] += 1;
    }
    // 归一化
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    if (norm === 0) return vec;
    return vec.map((v) => v / norm);
  }
}

// ─── MockLLMProvider：可控制输出的假 LLM ──────────────────────

export class MockLLMProvider {
  /** 预设的响应文本，测试可自定义 */
  responseText = "这是模拟的 LLM 回复";
  /** 是否抛出错误 */
  shouldError = false;
  errorMessage = "Mock LLM error";

  async chat(message: string, _sessionId?: string) {
    if (this.shouldError) throw new Error(this.errorMessage);
    return { sessionId: _sessionId ?? "mock-session", response: this.responseText, toolCalls: [], attachments: [] };
  }

  async *chatStream(message: string, _sessionId?: string) {
    if (this.shouldError) {
      yield { type: "error" as const, message: this.errorMessage };
      return;
    }
    for (const chunk of this.responseText.split(" ")) {
      yield { type: "content" as const, text: chunk + " " };
    }
  }
}

// ─── MockVoiceProvider：假语音转写 ───────────────────────────

export class MockVoiceProvider {
  transcribeResult = "这是模拟的语音转写结果";
  shouldError = false;

  async transcribe(_audioBuffer: Buffer, _opts?: { language?: string; format?: string }) {
    if (this.shouldError) throw new Error("Mock voice transcribe error");
    return { text: this.transcribeResult };
  }

  async synthesize(text: string, _opts?: { voice?: string; speed?: number; volume?: number; format?: string }) {
    return Buffer.from(text, "utf-8");
  }
}

// ─── MockAgentManager（最小实现）─────────────────────────────

export class MockAgentManager {
  agents = new Map<string, any>();
  private idCounter = 1;

  listAgents() {
    return Array.from(this.agents.values());
  }

  getAgent(id: string) {
    return this.agents.get(id);
  }

  addAgent(config: any) {
    const id = config.id ?? `agent-${this.idCounter++}`;
    const agent = {
      id,
      config,
      state: { id, config, status: "ready" },
      createdAt: new Date(),
    };
    this.agents.set(id, agent);
    return agent;
  }

  /** 路由实际调用 createAgent，别名同 addAgent */
  createAgent(config: any) {
    return this.addAgent(config);
  }

  updateAgent(id: string, patch: any) {
    const agent = this.agents.get(id);
    if (!agent) return null;
    agent.config = { ...agent.config, ...patch };
    return agent;
  }

  deleteAgent(id: string) {
    return this.agents.delete(id);
  }

  removeAgent(id: string) {
    return this.deleteAgent(id);
  }
}

// ─── MockCronScheduler（返回假数据）──────────────────────────

export class MockCronScheduler {
  private jobs = new Map<string, any>();
  private history: any[] = [];

  listJobs() {
    return Array.from(this.jobs.values());
  }

  getJob(id: string) {
    return this.jobs.get(id);
  }

  addJob(job: any) {
    const id = `job-${Date.now()}`;
    const newJob = { id, ...job };
    this.jobs.set(id, newJob);
    return newJob;
  }

  updateJob(id: string, updates: Record<string, unknown>) {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, updates);
  }

  enableJob(id: string) {
    const job = this.jobs.get(id);
    if (job) job.enabled = true;
  }

  disableJob(id: string) {
    const job = this.jobs.get(id);
    if (job) job.enabled = false;
  }

  removeJob(id: string) {
    return this.jobs.delete(id);
  }

  isCronExecutionContext(_agentId: string) {
    return false;
  }

  async executeNow(id: string) {
    const job = this.jobs.get(id);
    if (!job) throw new Error("Job not found");
    return `Executed: ${job.name}`;
  }

  getHistory(_id: string, _limit: number) {
    return this.history;
  }
}

// ─── MockSkillLoader：技能加载器 ───────────────────────────

export class MockSkillLoader {
  private skills = new Map<string, any>();

  constructor(initialSkills: any[] = []) {
    for (const s of initialSkills) {
      this.skills.set(s.id, {
        id: s.id,
        frontmatter: s.frontmatter ?? { name: s.id, description: "", version: "1.0.0", triggers: [] },
        enabled: s.enabled ?? true,
        content: s.content ?? "",
        filePath: s.filePath,
        loadedAt: s.loadedAt,
      });
    }
  }

  listSkills() {
    return Array.from(this.skills.values());
  }

  getSkill(id: string) {
    return this.skills.get(id);
  }

  updateSkill(id: string, body: { enabled?: boolean }) {
    const skill = this.skills.get(id);
    if (!skill) return null;
    if (body.enabled !== undefined) skill.enabled = body.enabled;
    return skill;
  }

  loadAll() {
    return Array.from(this.skills.values());
  }
}

// ─── MockSkillMarketplace：技能市场 ─────────────────────────

export class MockSkillMarketplace {
  searchResults: any[] = [];
  searchShouldError = false;
  installResult: { success: boolean; error?: string } = { success: true };
  installed: any[] = [];
  sources: any[] = [{ name: "official", url: "https://skills.example.com" }];

  async search(_q: string, _opts?: { source?: string }) {
    if (this.searchShouldError) throw new Error("Search failed");
    return this.searchResults;
  }

  async install(_sourceUrl: string, _sourceName?: string) {
    return this.installResult;
  }

  listInstalled() {
    return this.installed;
  }

  async uninstall(_id: string) {
    // 成功时不抛异常
  }

  getSources() {
    return this.sources;
  }
}

// ─── MockCollaborationOrchestrator：协作编排器 ─────────────

export class MockCollaborationOrchestrator {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  private history: any[] = [];
  private runningTasks: any[] = [];
  private results = new Map<string, any>();

  on(event: string, fn: (...args: any[]) => void) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
  }

  off(event: string, fn: (...args: any[]) => void) {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: string, ...args: any[]) {
    this.listeners.get(event)?.forEach((fn) => fn(...args));
  }

  async runCrew(config: any) {
    const result = {
      type: "crew" as const,
      id: `crew-${Date.now()}`,
      name: config.name,
      status: "completed",
      finalOutput: "任务完成",
      tasks: config.tasks,
      allAttachments: [],
      workspaceDir: "/tmp/workspace/crew",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.history.push(result);
    this.results.set(result.id, result);
    return result;
  }

  async runGroupChat(config: any, initialMessage: string) {
    const result = {
      type: "groupchat" as const,
      id: `gc-${Date.now()}`,
      name: config.name,
      status: "completed",
      summary: "讨论完成",
      messages: [{ role: "agent", content: initialMessage }],
      allAttachments: [],
      workspaceDir: "/tmp/workspace/gc",
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    };
    this.history.push(result);
    this.results.set(result.id, result);
    return result;
  }

  getHistory() {
    return [...this.history];
  }

  getHistoryPaginated(page: number, pageSize: number, _type?: string) {
    const start = (page - 1) * pageSize;
    return { results: this.history.slice(start, start + pageSize), total: this.history.length };
  }

  getRunningTasks() {
    return this.runningTasks;
  }

  abort(taskId: string): boolean {
    const task = this.runningTasks.find((t) => t.id === taskId);
    if (!task) return false;
    this.runningTasks = this.runningTasks.filter((t) => t.id !== taskId);
    return true;
  }

  getResultById(id: string) {
    return this.results.get(id);
  }

  getStats() {
    return { totalCrews: 0, totalGroupChats: 0, runningTasks: 0 };
  }
}

// ─── MockMemoryManager：记忆管理器 ────────────────────────

export class MockMemoryManager {
  private entries = new Map<string, any>();
  private nextId = 1;
  private coreBlocks = new Map<string, Map<string, string>>();

  async list(_filters: { agentId?: string; userId?: string; type?: any }) {
    return Array.from(this.entries.values());
  }

  async add(entry: { agentId: string; content: string; type?: string; userId?: string; metadata?: any }) {
    const id = `mem-${this.nextId++}`;
    const created = { id, ...entry, createdAt: new Date().toISOString() };
    this.entries.set(id, created);
    return created;
  }

  async search(query: string, _filters: any, topK: number) {
    return [{ id: "mem-1", content: query, score: 0.9 }];
  }

  stats(_agentId?: string) {
    return { total: this.entries.size, byType: {} };
  }

  async get(id: string) {
    return this.entries.get(id) ?? null;
  }

  async update(id: string, content: string, _metadata?: any) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Not found");
    entry.content = content;
  }

  async delete(id: string) {
    return this.entries.delete(id);
  }

  async clear(_filters: { agentId?: string; userId?: string; type?: any }) {
    const count = this.entries.size;
    this.entries.clear();
    return count;
  }

  getCoreBlocks(agentId: string) {
    const blocks = this.coreBlocks.get(agentId);
    if (!blocks) return [];
    return Array.from(blocks.entries()).map(([label, value]) => ({ label, value }));
  }

  getCoreBlock(agentId: string, label: string) {
    return this.coreBlocks.get(agentId)?.get(label) ?? null;
  }

  updateCoreBlock(agentId: string, label: string, value: string) {
    if (!this.coreBlocks.has(agentId)) this.coreBlocks.set(agentId, new Map());
    this.coreBlocks.get(agentId)!.set(label, value);
    return { label, value };
  }

  appendCoreBlock(agentId: string, label: string, text: string) {
    if (!this.coreBlocks.has(agentId)) this.coreBlocks.set(agentId, new Map());
    const blocks = this.coreBlocks.get(agentId)!;
    const current = blocks.get(label) ?? "";
    blocks.set(label, current + text);
    return { label, value: current + text };
  }

  async contradict(_filters: any, _threshold: number, _limit: number) {
    return [];
  }
}

// ─── MockKnowledgeGraph：知识图谱 ──────────────────────────

export class MockKnowledgeGraph {
  countTriples() {
    return 5;
  }

  findEntityId(_name: string) {
    return 1;
  }

  getOutgoing(_entityId: number) {
    return [{ predicate: "knows", object: "Entity2" }];
  }

  getIncoming(_entityId: number) {
    return [{ predicate: "knownBy", subject: "Entity0" }];
  }

  subgraph(_rootId: number, _maxDepth: number) {
    return { nodes: [], edges: [] };
  }

  findPath(_fromId: number, _toId: number, _maxHops: number) {
    return [{ from: 1, predicate: "links", to: 2 }];
  }

  exportSubgraph(_rootId: number, _depth: number, format: string) {
    if (format === "mermaid") return "graph TD\n  1-->2";
    if (format === "graphml") return "<graphml/>";
    return JSON.stringify({ nodes: [], edges: [] });
  }

  addTriple(data: any) {
    return "triple-1";
  }

  removeTriple(_id: string) {
    return true;
  }

  removeBySource(_source: string) {
    return 2;
  }
}

// ─── Fastify 实例构造辅助 ──────────────────────────────────

/**
 * 创建最简可用 Fastify 实例（未注册任何路由）。
 *
 * 注意：不调用 app.listen()，只调用 app.ready()。
 * 测试通过 app.inject() 进行内存调用。
 */
export function createFastify(): FastifyInstance {
  return Fastify({ logger: false });
}

/**
 * 注册路由并 ready。
 *
 * @param registerFn - 路由注册函数（如 (app, ctx) => channelRoutes(app, ctx)）
 * @param ctx - mock 的 AppContext（可按需只填需要的字段）
 * @returns 已 ready 的 FastifyInstance
 */
export async function buildApp(
  registerFn: (app: FastifyInstance, ctx: AppContext) => Promise<void>,
  ctx: Partial<AppContext> = {},
): Promise<FastifyInstance> {
  const app = createFastify();
  await registerFn(app, ctx as AppContext);
  await app.ready();
  return app;
}

/**
 * 创建无需 ctx 的路由 App（文件解析、版本查询等）。
 *
 * @param registerFn - 路由注册函数（如 (app) => fileRoutes(app)）
 * @returns 已 ready 的 FastifyInstance
 */
export async function buildAppNoCtx(
  registerFn: (app: FastifyInstance) => Promise<void> | void,
): Promise<FastifyInstance> {
  const app = createFastify();
  await registerFn(app);
  await app.ready();
  return app;
}
