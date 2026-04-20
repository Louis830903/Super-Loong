/**
 * Security Engine — sandbox isolation, token proxy, and credential management.
 *
 * Implements a defense-in-depth approach:
 *
 * 1. **Sandbox Isolation** (risk-graded):
 *    - NONE: No sandbox (trusted code, read-only operations)
 *    - PROCESS: Node.js child_process with resource limits
 *    - CONTAINER: Docker container isolation (configurable)
 *    - Each tool execution can declare a required sandbox level
 *
 * 2. **Token Proxy** ("model never sees plaintext credentials"):
 *    - Credentials stored in a secure vault (encrypted at rest)
 *    - Agent receives opaque token references like `{{secret:OPENAI_KEY}}`
 *    - Token proxy resolves references at execution time only
 *    - Audit log tracks every credential access
 *
 * 3. **Permission System**:
 *    - Tool-level permissions (which tools an agent can use)
 *    - Resource-level permissions (file paths, network hosts)
 *    - Approval workflows for dangerous operations
 */

import { v4 as uuid } from "uuid";
import pino from "pino";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { EventEmitter } from "eventemitter3";

import { saveSecurityPolicy, loadSecurityPolicies, deleteSecurityPolicy as deleteSecurityPolicyDB, saveCredentialToDB, loadCredentialsFromDB, deleteCredentialFromDB } from "../persistence/sqlite.js";

const logger = pino({ name: "security" });

// ═══════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════

export type SandboxLevel = "none" | "process" | "container" | "docker" | "ssh";

export type PermissionAction = "allow" | "deny" | "ask";

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

export interface SecurityStats {
  totalExecutions: number;
  deniedExecutions: number;
  credentialAccesses: number;
  activeSandboxes: number;
  totalCredentials: number;
  auditLogSize: number;
  policies: number;
}

/** Common interface for pluggable sandbox backends (Docker, SSH, etc.) */
export interface SandboxBackend {
  /** Number of currently active sandbox executions */
  readonly active: number;
  /** Check whether the backend runtime is available on this host */
  isAvailable(): Promise<boolean>;
  /** Execute code and return the result */
  execute(code: string, language: "javascript" | "python" | "shell", ...rest: unknown[]): Promise<SandboxResult>;
}

// ═══════════════════════════════════════════════════════════════
// Process Sandbox (child_process isolation for risky tool execution)
// ═══════════════════════════════════════════════════════════════

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

/**
 * Process-level sandbox that executes code in an isolated child_process.
 *
 * Provides:
 * - Timeout enforcement (kills process on timeout)
 * - Memory limits via --max-old-space-size
 * - Isolated execution context (no access to parent process globals)
 * - IPC-based result passing
 */
export class ProcessSandbox {
  private activeCount = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent = 10) {
    this.maxConcurrent = maxConcurrent;
  }

  get active(): number {
    return this.activeCount;
  }

  /**
   * Execute a function in an isolated child process.
   * The function is serialized to a string, sent to a worker, and executed there.
   * Only works with pure functions (no closures over parent scope).
   */
  async execute(
    code: string,
    args: Record<string, unknown> = {},
    options: ProcessSandboxOptions = {},
  ): Promise<SandboxResult> {
    const { fork } = await import("node:child_process");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { writeFileSync, unlinkSync } = await import("node:fs");

    if (this.activeCount >= this.maxConcurrent) {
      return {
        success: false,
        output: "Sandbox limit reached",
        error: "Max concurrent sandboxes exceeded",
        durationMs: 0,
      };
    }

    const timeoutMs = options.timeoutMs ?? 30000;
    const maxHeapMB = options.maxHeapMB ?? 128;
    const start = Date.now();

    // Write a temporary worker script
    const workerId = `sa_sandbox_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const workerPath = join(tmpdir(), `${workerId}.mjs`);

    // P2-06: Removed unused worker_threads import (this is a child_process fork, not a worker)
    // P1-08: Use vm.runInNewContext to restrict available APIs in sandbox
    // FIX: Use resolve/reject callbacks to correctly propagate async results from VM context
    const workerCode = `
import { createContext, runInNewContext } from 'node:vm';
// Sandbox worker — receives code + args, executes in restricted VM context
process.on('message', async (msg) => {
  try {
    let _resolve, _reject;
    const resultPromise = new Promise((resolve, reject) => {
      _resolve = resolve;
      _reject = reject;
    });
    const sandbox = {
      args: msg.args,
      console: { log() {}, warn() {}, error() {} },
      setTimeout, clearTimeout,
      Promise,
      JSON,
      Math,
      Date,
      Array, Object, String, Number, Boolean, Map, Set,
      Buffer,
      _resolve,
      _reject,
      code: msg.code,
    };
    runInNewContext(
      '(async () => { try { const fn = new Function("args", code); const r = await fn(args); _resolve(r); } catch(e) { _reject(e); } })()',
      sandbox,
      { timeout: 30000 },
    );
    const result = await resultPromise;
    process.send({ success: true, output: String(result ?? ''), data: result });
  } catch (err) {
    process.send({ success: false, output: err.message, error: err.message });
  }
  process.exit(0);
});
`;

    writeFileSync(workerPath, workerCode, "utf-8");

    this.activeCount++;

    return new Promise<SandboxResult>((resolve) => {
      let settled = false;

      const child = fork(workerPath, [], {
        execArgv: [`--max-old-space-size=${maxHeapMB}`],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: {}, // Clean environment — no inherited secrets
      });

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill("SIGKILL");
          this.activeCount--;
          cleanup();
          resolve({
            success: false,
            output: "Execution timed out",
            error: `Sandbox timeout after ${timeoutMs}ms`,
            durationMs: Date.now() - start,
          });
        }
      }, timeoutMs);

      const cleanup = () => {
        try { unlinkSync(workerPath); } catch { /* ignore */ }
      };

      child.on("message", (msg: SandboxResult) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({ ...msg, durationMs: Date.now() - start });
        }
      });

      child.on("error", (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({
            success: false,
            output: err.message,
            error: err.message,
            durationMs: Date.now() - start,
          });
        }
      });

      child.on("exit", (exitCode) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          this.activeCount--;
          cleanup();
          resolve({
            success: exitCode === 0,
            output: exitCode === 0 ? "" : `Process exited with code ${exitCode}`,
            error: exitCode !== 0 ? `Exit code: ${exitCode}` : undefined,
            durationMs: Date.now() - start,
          });
        }
      });

      // Send code + args to the child
      child.send({ code, args });
    });
  }

  /**
   * Execute a tool's function with a timeout wrapper (NOT process isolation).
   *
   * P1-07: This method provides **only timeout enforcement** — the function still
   * runs in the main process. Use `execute()` for true child_process isolation.
   *
   * For closure-based tool functions that cannot be serialized to a child process,
   * this provides a safety net against runaway execution.
   *
   * @param fn - Async function to execute (runs in current process)
   * @param options.timeoutMs - Max execution time (default: 30000ms)
   * @param options.maxHeapMB - P2-10: Ignored in this path; only effective in `execute()` which uses child_process
   */
  async executeWithTimeout<T>(
    fn: () => Promise<T>,
    options: ProcessSandboxOptions = {},
  ): Promise<{ result?: T; timedOut: boolean; durationMs: number; error?: string }> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const start = performance.now();
    this.activeCount++;

    try {
      const result = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Sandbox timeout after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
      return { result, timedOut: false, durationMs: Math.max(1, Math.round(performance.now() - start)) };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const timedOut = msg.includes("Sandbox timeout");
      return { timedOut, durationMs: Math.max(1, Math.round(performance.now() - start)), error: msg };
    } finally {
      this.activeCount--;
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Credential Vault (encrypted at rest)
// ═══════════════════════════════════════════════════════════════

export class CredentialVault {
  private credentials: Map<string, CredentialEntry> = new Map();
  private encryptionKey: Buffer;

  /** Whether credentials persist across restarts (true only with a stable master key) */
  readonly persistent: boolean;

  constructor(masterKey?: string) {
    // P1-09: Require an explicit master key — falling back to randomBytes means
    // all encrypted credentials become unrecoverable after restart.
    const keySource = masterKey ?? process.env.CREDENTIAL_MASTER_KEY;
    this.persistent = !!keySource;
    if (!keySource) {
      logger.error(
        "[SECURITY] CREDENTIAL_MASTER_KEY is NOT set! " +
        "Credentials will use an ephemeral key and become UNRECOVERABLE after restart. " +
        "Set CREDENTIAL_MASTER_KEY in your .env file for production use.",
      );
    }
    this.encryptionKey = createHash("sha256").update(keySource ?? randomBytes(32).toString("hex")).digest();

    // B-17: 持久化模式下，从 SQLite 加载已存储的凭证
    if (this.persistent) {
      try {
        const saved = loadCredentialsFromDB();
        for (const row of saved) {
          this.credentials.set(row.name, {
            id: `cred_restored`,
            name: row.name,
            encryptedValue: row.encryptedValue,
            iv: row.iv,
            description: row.description,
            allowedAgents: row.allowedAgents,
            allowedTools: row.allowedTools,
            createdAt: new Date(row.createdAt),
            accessCount: 0,
          });
        }
        if (saved.length > 0) {
          logger.info({ count: saved.length }, "Credentials restored from SQLite");
        }
      } catch {
        // DB might not be initialized yet
      }
    }
  }

  /** Store a credential (encrypted) */
  store(name: string, value: string, options?: {
    description?: string;
    allowedAgents?: string[];
    allowedTools?: string[];
  }): CredentialEntry {
    const iv = randomBytes(16);
    const cipher = createCipheriv("aes-256-cbc", this.encryptionKey, iv);
    let encrypted = cipher.update(value, "utf8", "hex");
    encrypted += cipher.final("hex");

    const entry: CredentialEntry = {
      id: `cred_${uuid().slice(0, 8)}`,
      name,
      encryptedValue: encrypted,
      iv: iv.toString("hex"),
      description: options?.description,
      allowedAgents: options?.allowedAgents,
      allowedTools: options?.allowedTools,
      createdAt: new Date(),
      accessCount: 0,
    };

    this.credentials.set(name, entry);

    // B-17: 持久化到 SQLite
    if (this.persistent) {
      try {
        saveCredentialToDB({
          name,
          encryptedValue: encrypted,
          iv: iv.toString("hex"),
          description: options?.description,
          allowedAgents: options?.allowedAgents,
          allowedTools: options?.allowedTools,
        });
      } catch { /* DB might not be initialized */ }
    }

    logger.info({ name, id: entry.id }, "Credential stored");
    return entry;
  }

  /** Retrieve a credential value (decrypted) — only called by token proxy */
  retrieve(name: string, agentId?: string, toolName?: string): string | null {
    const entry = this.credentials.get(name);
    if (!entry) return null;

    // Check access control
    if (entry.allowedAgents?.length && agentId && !entry.allowedAgents.includes(agentId)) {
      logger.warn({ name, agentId }, "Credential access denied: agent not allowed");
      return null;
    }
    if (entry.allowedTools?.length && toolName && !entry.allowedTools.includes(toolName)) {
      logger.warn({ name, toolName }, "Credential access denied: tool not allowed");
      return null;
    }

    try {
      const iv = Buffer.from(entry.iv, "hex");
      const decipher = createDecipheriv("aes-256-cbc", this.encryptionKey, iv);
      let decrypted = decipher.update(entry.encryptedValue, "hex", "utf8");
      decrypted += decipher.final("utf8");

      entry.lastAccessedAt = new Date();
      entry.accessCount++;
      return decrypted;
    } catch {
      logger.error({ name }, "Credential decryption failed");
      return null;
    }
  }

  /** Delete a credential */
  delete(name: string): boolean {
    const deleted = this.credentials.delete(name);
    // B-17: 从 SQLite 也删除
    if (deleted && this.persistent) {
      try { deleteCredentialFromDB(name); } catch { /* best-effort */ }
    }
    return deleted;
  }

  /**
   * @internal
   * Retrieve credential value bypassing ACL — for internal system use only (e.g. maskSecrets).
   * P2-07: This method is NOT part of the public API and should never be called by agents.
   */
  _retrieveSystem(name: string): string | null {
    const entry = this.credentials.get(name);
    if (!entry) return null;
    try {
      const iv = Buffer.from(entry.iv, "hex");
      const decipher = createDecipheriv("aes-256-cbc", this.encryptionKey, iv);
      let decrypted = decipher.update(entry.encryptedValue, "hex", "utf8");
      decrypted += decipher.final("utf8");
      return decrypted;
    } catch {
      return null;
    }
  }

  /** List credentials (without values) */
  list(): Array<Omit<CredentialEntry, "encryptedValue" | "iv">> {
    return Array.from(this.credentials.values()).map(({ encryptedValue, iv, ...rest }) => rest);
  }

  /** Check if a credential exists */
  has(name: string): boolean {
    return this.credentials.has(name);
  }

  get size(): number {
    return this.credentials.size;
  }
}

// ═══════════════════════════════════════════════════════════════
// Token Proxy — resolves {{secret:NAME}} references
// ═══════════════════════════════════════════════════════════════

export class TokenProxy {
  private vault: CredentialVault;
  private static readonly TOKEN_PATTERN = /\{\{secret:([^}]+)\}\}/g;

  constructor(vault: CredentialVault) {
    this.vault = vault;
  }

  /** Check if a string contains token references */
  hasTokens(text: string): boolean {
    return /\{\{secret:([^}]+)\}\}/.test(text);
  }

  /** Resolve all {{secret:NAME}} references in a string */
  resolve(text: string, agentId?: string, toolName?: string): string {
    return text.replace(TokenProxy.TOKEN_PATTERN, (_match, name: string) => {
      const value = this.vault.retrieve(name.trim(), agentId, toolName);
      if (value === null) {
        logger.warn({ name, agentId, toolName }, "Token reference unresolved");
        return `{{secret:${name}:UNRESOLVED}}`;
      }
      return value;
    });
  }

  /** Resolve token references in an object (deep) */
  resolveObject(obj: unknown, agentId?: string, toolName?: string): unknown {
    if (typeof obj === "string") return this.resolve(obj, agentId, toolName);
    if (Array.isArray(obj)) return obj.map((v) => this.resolveObject(v, agentId, toolName));
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveObject(value, agentId, toolName);
      }
      return result;
    }
    return obj;
  }

  /** Mask credential values in output (prevent leakage) */
  maskSecrets(text: string): string {
    // Replace any known credential values with masked versions
    let masked = text;
    for (const entry of this.vault.list()) {
      const value = this.vault._retrieveSystem(entry.name);
      if (value) {
        // P2-08: Handle short passwords (≤4 chars) — mask entirely
        const maskValue = value.length <= 4
          ? "*".repeat(value.length)
          : "*".repeat(value.length - 4) + value.slice(-4);
        masked = masked.split(value).join(maskValue);
      }
    }
    return masked;
  }
}

// ═══════════════════════════════════════════════════════════════
// Security Manager (Unified)
// ═══════════════════════════════════════════════════════════════

export class SecurityManager extends EventEmitter {
  readonly vault: CredentialVault;
  readonly tokenProxy: TokenProxy;
  readonly sandbox: ProcessSandbox;
  private _dockerSandbox: SandboxBackend | null = null;
  private _sshSandbox: SandboxBackend | null = null;
  private policies: Map<string, SecurityPolicy> = new Map();
  private auditLog: AuditLogEntry[] = [];
  private activeSandboxes: number = 0;
  private executionCount: number = 0;
  private deniedCount: number = 0;
  private maxAuditEntries: number;

  constructor(options?: { masterKey?: string; maxAuditEntries?: number; maxConcurrentSandboxes?: number }) {
    super();
    this.vault = new CredentialVault(options?.masterKey);
    this.tokenProxy = new TokenProxy(this.vault);
    this.sandbox = new ProcessSandbox(options?.maxConcurrentSandboxes ?? 10);
    this.maxAuditEntries = options?.maxAuditEntries ?? 10000;

    // Create default policy
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

    // Restore persisted policies from database
    this.loadPoliciesFromDB();
  }

  /** Load persisted policies from SQLite */
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
      // DB not initialized yet or first run
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
    // Persist to SQLite
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
      try { deleteSecurityPolicyDB(id); } catch {}
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

    // Check blocked tools
    if (policy.blockedTools.includes(toolName)) {
      this.deniedCount++;
      this.audit("permission_denied", {
        agentId, toolName, details: "Tool is blocked by policy", outcome: "denied",
      });
      return { allowed: false, sandboxLevel: "none", reason: "Tool is blocked" };
    }

    // Check tool-specific permission
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

    // Default permission
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
    const { encryptedValue, iv, ...safe } = entry;
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

    // Trim if exceeded max
    if (this.auditLog.length > this.maxAuditEntries) {
      this.auditLog = this.auditLog.slice(-this.maxAuditEntries);
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

    // Return most recent first
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
