/**
 * SecurityManager — 安全引擎统一入口
 *
 * 组合三大子组件：
 * - CredentialVault：AES-256-CBC 加密的凭据保险库
 * - TokenProxy：{{secret:NAME}} 占位符解析 + 输出脱敏
 * - ProcessSandbox：child_process + node:vm 双层进程沙箱
 *
 * 同时承担：
 * - 安全策略 CRUD（含 SQLite 持久化）
 * - 工具执行许可检查（policy → blockedTools/toolPermissions/默认动作）
 * - 审计日志（内存 + JSONL 文件，重启不丢失）
 * - Docker / SSH 沙箱后端注册（可选）
 *
 * @why 拆分自原 security/sandbox.ts（v3 Task 9 上帝文件拆分）
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "eventemitter3";

import {
  saveSecurityPolicy,
  loadSecurityPolicies,
  deleteSecurityPolicy as deleteSecurityPolicyDB,
} from "../persistence/sqlite.js";
import { CredentialVault } from "./credential-vault.js";
import { TokenProxy } from "./token-proxy.js";
import { ProcessSandbox } from "./process-sandbox.js";
import type {
  SandboxLevel,
  SecurityPolicy,
  CredentialEntry,
  AuditLogEntry,
  SecurityStats,
  SandboxBackend,
} from "./sandbox-types.js";

const logger = pino({ name: "security" });

export class SecurityManager extends EventEmitter {
  readonly vault: CredentialVault;
  readonly tokenProxy: TokenProxy;
  readonly sandbox: ProcessSandbox;
  private _dockerSandbox: SandboxBackend | null = null;
  private _sshSandbox: SandboxBackend | null = null;
  private policies: Map<string, SecurityPolicy> = new Map();
  private auditLog: AuditLogEntry[] = [];
  private executionCount: number = 0;
  private deniedCount: number = 0;
  private maxAuditEntries: number;
  /** P4-T6: 审计日志 JSONL 文件路径（为空则仅内存记录） */
  private auditFilePath: string | null = null;

  constructor(options?: { masterKey?: string; maxAuditEntries?: number; maxConcurrentSandboxes?: number; dataDir?: string }) {
    super();
    this.vault = new CredentialVault(options?.masterKey);
    this.tokenProxy = new TokenProxy(this.vault);
    this.sandbox = new ProcessSandbox(options?.maxConcurrentSandboxes ?? 10);
    this.maxAuditEntries = options?.maxAuditEntries ?? 10000;

    // P4-T6: 若指定 dataDir，启用审计日志 JSONL 持久化
    if (options?.dataDir) {
      const dir = options.dataDir;
      if (!existsSync(dir)) {
        try { mkdirSync(dir, { recursive: true }); } catch { /* 目录创建失败则降级为仅内存 */ }
      }
      if (existsSync(dir)) {
        this.auditFilePath = join(dir, "security-audit.jsonl");
      }
    }

    // 创建默认策略
    this.policies.set("default", {
      id: "default",
      name: "Default Security Policy",
      description: "Default policy — allows all tools with process-level sandbox",
      defaultSandbox: "none",
      defaultPermission: "allow",
      toolPermissions: [],
      blockedTools: [],
      maxConcurrentSandboxes: 10,
      auditEnabled: true,
    });

    // 从数据库恢复持久化策略
    this.loadPoliciesFromDB();
  }

  /** 从 SQLite 加载已持久化的策略 */
  private loadPoliciesFromDB(): void {
    try {
      const rows = loadSecurityPolicies();
      for (const row of rows) {
        try {
          const policy = JSON.parse(row.config) as SecurityPolicy;
          policy.id = row.id;
          this.policies.set(row.id, policy);
        } catch {
          logger.warn({ id: row.id }, "Failed to parse persisted security policy");
        }
      }
      if (rows.length > 0) {
        logger.info({ count: rows.length }, "Security policies restored from database");
      }
    } catch {
      // 数据库尚未初始化或首次运行
    }
  }

  // ─── Policy Management ─────────────────────────────────────

  /** Get a policy by ID */
  getPolicy(id: string): SecurityPolicy | undefined {
    return this.policies.get(id);
  }

  /** Set or update a policy */
  setPolicy(policy: SecurityPolicy): void {
    this.policies.set(policy.id, policy);
    // 持久化到 SQLite
    try {
      saveSecurityPolicy(policy.id, policy.name, JSON.stringify(policy));
    } catch {
      logger.warn({ id: policy.id }, "Failed to persist security policy");
    }
    this.audit("policy_change", { details: `Policy '${policy.name}' updated` });
    this.emit("policy:updated", policy);
  }

  /** List all policies */
  listPolicies(): SecurityPolicy[] {
    return Array.from(this.policies.values());
  }

  /** Delete a policy (cannot delete default) */
  deletePolicy(id: string): boolean {
    if (id === "default") return false;
    const result = this.policies.delete(id);
    if (result) {
      // [v3 Task 5] 内存删除已成功，DB 持久化失败不阻塞当前操作
      // @why 启动期或 DB 不可用时仍允许策略热更新；下次启动会从内存重建
      try { deleteSecurityPolicyDB(id); } catch (err: unknown) {
        logger.debug({ id, err: err instanceof Error ? err.message : String(err) }, "deleteSecurityPolicyDB failed (non-fatal)");
      }
    }
    return result;
  }

  // ─── Tool Execution Gate ───────────────────────────────────

  /** Check if a tool execution is allowed under a policy */
  checkPermission(
    toolName: string,
    agentId: string,
    policyId: string = "default",
  ): { allowed: boolean; sandboxLevel: SandboxLevel; reason?: string } {
    const policy = this.policies.get(policyId);
    if (!policy) {
      return { allowed: false, sandboxLevel: "none", reason: "Policy not found" };
    }

    // 检查屏蔽列表
    if (policy.blockedTools.includes(toolName)) {
      this.deniedCount++;
      this.audit("permission_denied", {
        agentId, toolName, details: "Tool is blocked by policy", outcome: "denied",
      });
      return { allowed: false, sandboxLevel: "none", reason: "Tool is blocked" };
    }

    // 检查特定工具权限
    const toolPerm = policy.toolPermissions.find((p) => p.toolName === toolName);
    if (toolPerm) {
      if (toolPerm.action === "deny") {
        this.deniedCount++;
        this.audit("permission_denied", {
          agentId, toolName, details: "Tool denied by permission rule", outcome: "denied",
        });
        return { allowed: false, sandboxLevel: toolPerm.sandboxLevel, reason: "Permission denied" };
      }
      return { allowed: true, sandboxLevel: toolPerm.sandboxLevel };
    }

    // 默认权限
    const allowed = policy.defaultPermission !== "deny";
    if (!allowed) this.deniedCount++;
    return { allowed, sandboxLevel: policy.defaultSandbox };
  }

  /** Record a tool execution in the audit log */
  recordExecution(
    toolName: string,
    agentId: string,
    outcome: "success" | "denied" | "error",
  ): void {
    this.executionCount++;
    this.audit("tool_execute", { agentId, toolName, outcome });
  }

  // ─── Credential Management ─────────────────────────────────

  /** Store a credential */
  storeCredential(name: string, value: string, options?: {
    description?: string;
    allowedAgents?: string[];
    allowedTools?: string[];
  }): Omit<CredentialEntry, "encryptedValue" | "iv"> {
    const entry = this.vault.store(name, value, options);
    this.audit("credential_create", { credentialName: name });
    const { encryptedValue: _encryptedValue, iv: _iv, ...safe } = entry;
    return safe;
  }

  /** Delete a credential */
  deleteCredential(name: string): boolean {
    const result = this.vault.delete(name);
    if (result) {
      this.audit("credential_delete", { credentialName: name });
    }
    return result;
  }

  /** List credentials (safe — no values) */
  listCredentials(): Array<Omit<CredentialEntry, "encryptedValue" | "iv">> {
    return this.vault.list();
  }

  /** Resolve token references in tool arguments */
  resolveTokens(args: unknown, agentId?: string, toolName?: string): unknown {
    const resolved = this.tokenProxy.resolveObject(args, agentId, toolName);
    if (agentId && toolName) {
      this.audit("credential_access", { agentId, toolName, outcome: "success" });
    }
    return resolved;
  }

  // ─── Audit Log ─────────────────────────────────────────────

  private audit(
    action: AuditLogEntry["action"],
    data?: Partial<AuditLogEntry>,
  ): void {
    const entry: AuditLogEntry = {
      id: `audit_${uuid().slice(0, 8)}`,
      timestamp: new Date(),
      action,
      outcome: "success",
      ...data,
    };

    this.auditLog.push(entry);

    // 超出最大条数时裁剪
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.maxAuditEntries);
    }

    // P4-T6: 持久化到 JSONL 文件，确保重启后审计记录不丢失
    if (this.auditFilePath) {
      try {
        appendFileSync(this.auditFilePath, JSON.stringify(entry) + "\n", "utf-8");
      } catch {
        // 文件写入失败不阻塞主流程
      }
    }

    this.emit("audit:entry", entry);
  }

  /** Get audit log entries */
  getAuditLog(options?: {
    limit?: number;
    action?: AuditLogEntry["action"];
    agentId?: string;
    since?: Date;
  }): AuditLogEntry[] {
    let entries = this.auditLog;

    if (options?.action) entries = entries.filter((e) => e.action === options.action);
    if (options?.agentId) entries = entries.filter((e) => e.agentId === options.agentId);
    if (options?.since) entries = entries.filter((e) => e.timestamp >= options.since!);

    // 最新优先
    entries = entries.slice().reverse();

    if (options?.limit) entries = entries.slice(0, options.limit);
    return entries;
  }

  // ─── Multi-Backend Sandbox Access ─────────────────────────

  /** Set Docker sandbox backend */
  setDockerSandbox(dockerSandbox: SandboxBackend): void {
    this._dockerSandbox = dockerSandbox;
    logger.info("Docker sandbox backend registered");
  }

  /** Set SSH sandbox backend */
  setSSHSandbox(sshSandbox: SandboxBackend): void {
    this._sshSandbox = sshSandbox;
    logger.info("SSH sandbox backend registered");
  }

  /** Get Docker sandbox (may be null if not configured) */
  get dockerSandbox(): SandboxBackend | null {
    return this._dockerSandbox;
  }

  /** Get SSH sandbox (may be null if not configured) */
  get sshSandbox(): SandboxBackend | null {
    return this._sshSandbox;
  }

  // ─── Stats ─────────────────────────────────────────────────

  getStats(): SecurityStats {
    return {
      totalExecutions: this.executionCount,
      deniedExecutions: this.deniedCount,
      credentialAccesses: this.auditLog.filter((e) => e.action === "credential_access").length,
      activeSandboxes: this.sandbox.active,
      totalCredentials: this.vault.size,
      auditLogSize: this.auditLog.length,
      policies: this.policies.size,
    };
  }
}
