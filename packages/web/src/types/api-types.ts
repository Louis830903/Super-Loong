/**
 * 前端 API 类型定义 — 与 @super-agent/core 手动同步
 *
 * 源文件：packages/core/src/types/index.ts + 各模块输出类型
 * 同步策略：后端修改类型后，通过代码审查确保此文件同步更新
 *
 * ⚠️ 不直接依赖 @super-agent/core，因其包含 pino/better-sqlite3 等 Node.js 模块，
 *    会导致 Next.js 编译报错。
 */

// ─── 进化引擎相关 ─────────────────────────────────────────

/** 技能提案 — 对应 core EvolutionEngine 产出 */
export interface SkillProposal {
  id: string;
  action: "create" | "update" | "patch" | "no_change";
  skillName: string;
  description: string;
  content: string;
  reasoning: string;
  basedOnCases: string[];
  status: "pending" | "approved" | "applied" | "rejected";
  createdAt: string;
  qualityScore?: number;
}

/** 进化统计数据 */
export interface EvolutionStats {
  totalInteractions: number;
  failedInteractions: number;
  successRate: number;
  totalProposals: number;
  appliedProposals: number;
  pendingProposals: number;
  totalSnapshots: number;
  bestScore: number;
  nudges: { memory: number; skill: number };
}

/** 进化快照 */
export interface Snapshot {
  id: string;
  label?: string;
  stageIndex: number;
  avgScore: number;
  totalCases: number;
  failureCases: number;
  timestamp: string;
}

/** Nudge 配置 */
export interface NudgeConfig {
  memoryReviewInterval: number;
  skillReviewInterval: number;
  autoApplySkills: boolean;
  combinedReview: boolean;
  flushMinTurns: number;
}

// ─── 协作相关 ─────────────────────────────────────────────

/** 附件轻量类型 */
export interface AttachmentItem {
  path?: string;
  url?: string;
  filename?: string;
  mimeType?: string;
  kind?: string;
  size?: number;
  caption?: string;
}

/** Crew 模式任务输出 */
export interface TaskOutputItem {
  taskId: string;
  agentId: string;
  output: string;
  retries: number;
  durationMs: number;
  attachments?: AttachmentItem[];
}

/** GroupChat 模式消息 */
export interface CollabMessageItem {
  id: string;
  agentId: string;
  agentName: string;
  content: string;
  role: string;
  attachments?: AttachmentItem[];
}

/** 协作历史项 — Discriminated Union 支持 Crew 和 GroupChat */
export interface CollabHistoryItem {
  /** G-1: Discriminated Union 类型标识 */
  type?: "crew" | "groupchat";
  // Crew 模式字段
  crewId?: string;
  process?: "sequential" | "hierarchical";
  taskOutputs?: TaskOutputItem[];
  finalOutput?: string;
  // GroupChat 模式字段
  chatId?: string;
  messages?: CollabMessageItem[];
  turns?: number;
  summary?: string;
  // 共有字段
  name: string;
  status: string;
  totalDurationMs: number;
  error?: string;
  /** 所有产出的去重文件聚合 */
  allAttachments?: AttachmentItem[];
  /** 工作空间目录路径 */
  workspaceDir?: string;
}

// ─── 记忆相关 ─────────────────────────────────────────────

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  content: string;
  type: string;
  agentId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  /** 信任评分 0~1，后端已返回 */
  trustScore?: number;
  /** 搜索相关性分数 — 仅语义搜索时填充 */
  _score?: number;
}

// ─── 安全相关 ─────────────────────────────────────────────

/** API 凭证 */
export interface Credential {
  name: string;
  createdAt: string;
}

/** 审计日志条目 */
export interface AuditEntry {
  id: string;
  action: string;
  resource: string;
  result: string;
  timestamp: string;
  details?: string;
}

/** 安全策略 */
export interface SecurityPolicy {
  id: string;
  name: string;
  defaultSandbox: string;
  defaultPermission: string;
  maxConcurrentSandboxes: number;
}

/** 命令审批项 */
export interface ApprovalItem {
  id: string;
  command: string;
  guardResult: { level: string; patternKey?: string; reason?: string };
  scope: string;
  status: string;
  sessionKey: string;
  createdAt: string;
}
