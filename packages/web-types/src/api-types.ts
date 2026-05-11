/**
 * API Wire Types —— 前后端网络契约的"序列化形态"。
 *
 * 定位：
 *   - 此文件定义的是 API 响应/请求在 JSON over HTTP/WS 传输时的**线上形态**，
 *     与 @super-agent/core 里的 domain type 存在刻意分层：
 *       · core domain type： Date 对象、内部字段（embedding/patchOperations/...）、可选 Node 类型
 *       · web-types wire type：string 时间戳、仅暴露前端消费的字段、零 Node 依赖
 *   - 例：core MemoryEntry.createdAt 是 Date，序列化到前端后 wire type 为 string。
 *
 * 维护规约：
 *   - 这里是**单一数据源**。前端从 @super-agent/web-types 消费，
 *     后端路由层在返回前应做 domain → wire 的序列化（后续 Step 2 提供 serialize*() 工具）。
 *   - 新增字段时：先在此处加 wire 字段，再在 core 路由层序列化函数对齐。
 *   - 禁止引入任何 Node-only 依赖（保持 web-types 的零副作用约束）。
 *
 * 源头：原 packages/web/src/types/api-types.ts（CTR-P1-01 物理迁移到共享包）
 */

// ─── 进化引擎相关 ─────────────────────────────────────────

/** 技能提案 — 对应 core EvolutionEngine 产出（wire 形态：createdAt 为 ISO 字符串） */
export interface SkillProposal {
  id: string;
  /** 提案操作类型 — [审查 P2-6] 补全 modify/delete */
  action: "create" | "update" | "modify" | "delete" | "patch" | "no_change";
  skillName: string;
  description: string;
  content: string;
  reasoning: string;
  basedOnCases: string[];
  status: "pending" | "approved" | "applied" | "rejected";
  createdAt: string;
  qualityScore?: number;
  /** Task 3.1: 自修改目标代码 — 当提案包含源码级修改时填充 */
  targetCode?: {
    /** 目标模块路径 */
    modulePath: string;
    /** 目标函数/类/方法名 */
    targetName: string;
    /** 新代码内容 */
    newCode: string;
    /** 操作类型 */
    operation: "modify" | "add" | "delete";
  };
  /** Task 3.5: 是否需要人工审核 — modify 操作默认要求人工确认 */
  requiresHumanReview?: boolean;
  /** 审核理由 — 解释为何需要人工审核 */
  reviewReason?: string;
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

/** 进化快照（wire 形态：timestamp 为 ISO 字符串） */
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

/**
 * 记忆条目 wire 形态。
 *
 * 与 core MemoryEntry 的刻意差异：
 *   - createdAt: Date → string（JSON 序列化天然形态）
 *   - 省略 embedding / updatedAt / helpfulCount / retrievalCount / embeddingType / priority / relevanceScore
 *     （这些是领域内部字段，前端无需感知）
 */
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

/** API 凭证 wire 形态（不含 encryptedValue/IV 等后端内部字段） */
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

/**
 * 安全策略 wire 形态。
 *
 * 与 core SecurityPolicy 的差异：
 *   - 省略 description / toolPermissions / blockedTools / auditEnabled（后端内部字段）
 *   - defaultSandbox / defaultPermission 从枚举退化为 string，适配前端展示
 */
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
