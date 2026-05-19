/**
 * Security Engine — 类型定义集中文件
 *
 * @why v3 Task 9 上帝文件拆分：原 sandbox.ts 981 行包含 5 个类 + 10 个 interface，
 *      按"类型/进程沙箱/凭据保险柜/Token 代理/统一管理器"五职责拆出。
 *      本文件集中所有 type/interface，让其它子模块能纯粹关注实现细节。
 *      barrel sandbox.ts 仍 re-export 全部符号，外部 import 路径不变。
 */

// ─── Sandbox Level / Permission ──────────────────────────────────

export type SandboxLevel = "none" | "process" | "container" | "docker" | "ssh";

export type PermissionAction = "allow" | "deny" | "ask";

// ─── Tool Permission / Security Policy ───────────────────────────

export interface ToolPermission {
  toolName: string;
  action: PermissionAction;
  sandboxLevel: SandboxLevel;
  /** Allowed argument patterns (glob-style) */
  allowedArgs?: Record<string, string>;
  /** Resource restrictions */
  restrictions?: {
    allowedPaths?: string[];
    blockedPaths?: string[];
    allowedHosts?: string[];
    blockedHosts?: string[];
    maxExecutionMs?: number;
  };
}

export interface SecurityPolicy {
  id: string;
  name: string;
  description?: string;
  /** Default sandbox level for tools without explicit config */
  defaultSandbox: SandboxLevel;
  /** Default permission for tools without explicit config */
  defaultPermission: PermissionAction;
  /** Tool-specific permissions */
  toolPermissions: ToolPermission[];
  /** Global blocked tool patterns */
  blockedTools: string[];
  /** Maximum concurrent sandbox executions */
  maxConcurrentSandboxes: number;
  /** Whether to log all tool executions to audit log */
  auditEnabled: boolean;
}

// ─── Credential Entry ────────────────────────────────────────────

export interface CredentialEntry {
  id: string;
  name: string;
  /** Encrypted value */
  encryptedValue: string;
  /** IV for AES decryption */
  iv: string;
  /** Description for human reference (never sent to agents) */
  description?: string;
  /** Which agents/tools can access this credential */
  allowedAgents?: string[];
  allowedTools?: string[];
  createdAt: Date;
  lastAccessedAt?: Date;
  accessCount: number;
}

// ─── Audit Log Entry ─────────────────────────────────────────────

export interface AuditLogEntry {
  id: string;
  timestamp: Date;
  action: "tool_execute" | "credential_access" | "credential_create" | "credential_delete"
    | "policy_change" | "sandbox_start" | "sandbox_stop" | "permission_denied";
  agentId?: string;
  toolName?: string;
  credentialName?: string;
  details?: string;
  outcome: "success" | "denied" | "error";
}

// ─── Security Stats ──────────────────────────────────────────────

export interface SecurityStats {
  totalExecutions: number;
  deniedExecutions: number;
  credentialAccesses: number;
  activeSandboxes: number;
  totalCredentials: number;
  auditLogSize: number;
  policies: number;
}

// ─── Sandbox Backend / Process Sandbox Options ───────────────────

/** Common interface for pluggable sandbox backends (Docker, SSH, etc.) */
export interface SandboxBackend {
  /** Number of currently active sandbox executions */
  readonly active: number;
  /** Check whether the backend runtime is available on this host */
  isAvailable(): Promise<boolean>;
  /** Execute code and return the result */
  execute(code: string, language: "javascript" | "python" | "shell", ...rest: unknown[]): Promise<SandboxResult>;
}

export interface ProcessSandboxOptions {
  /** Max execution time in ms. Default: 30000 (30s) */
  timeoutMs?: number;
  /** Max heap size in MB for the child process. Default: 128 */
  maxHeapMB?: number;
}

export interface SandboxResult {
  success: boolean;
  output: string;
  data?: unknown;
  error?: string;
  durationMs: number;
}
