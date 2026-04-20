/**
 * Security Module — Comprehensive Tests.
 *
 * Covers: CredentialVault, TokenProxy, ProcessSandbox, SecurityManager, SandboxBackend interface.
 */
import { describe, it, expect, vi } from "vitest";

import {
  CredentialVault,
  TokenProxy,
  ProcessSandbox,
  SecurityManager,
  type SandboxBackend,
  type SandboxResult,
} from "../security/sandbox.js";

// ─── CredentialVault ───────────────────────────────────────
describe("CredentialVault", () => {
  it("should store and retrieve a credential", () => {
    const vault = new CredentialVault("test-master-key-12345678");
    vault.store("MY_API_KEY", "sk-secret-value-123");

    const retrieved = vault.retrieve("MY_API_KEY");
    expect(retrieved).toBe("sk-secret-value-123");
  });

  it("should mark persistent=true when master key is provided", () => {
    const vault = new CredentialVault("my-stable-key");
    expect(vault.persistent).toBe(true);
  });

  it("should mark persistent=false when no master key", () => {
    // Remove env var temporarily
    const original = process.env.CREDENTIAL_MASTER_KEY;
    delete process.env.CREDENTIAL_MASTER_KEY;
    const vault = new CredentialVault();
    expect(vault.persistent).toBe(false);
    if (original) process.env.CREDENTIAL_MASTER_KEY = original;
  });

  it("should enforce access control by agent", () => {
    const vault = new CredentialVault("key");
    vault.store("RESTRICTED", "secret", { allowedAgents: ["agent-A"] });

    // Allowed agent
    expect(vault.retrieve("RESTRICTED", "agent-A")).toBe("secret");
    // Denied agent
    expect(vault.retrieve("RESTRICTED", "agent-B")).toBeNull();
  });

  it("should enforce access control by tool", () => {
    const vault = new CredentialVault("key");
    vault.store("TOOL_SECRET", "value", { allowedTools: ["web-search"] });

    expect(vault.retrieve("TOOL_SECRET", undefined, "web-search")).toBe("value");
    expect(vault.retrieve("TOOL_SECRET", undefined, "file-write")).toBeNull();
  });

  it("should track access count", () => {
    const vault = new CredentialVault("key");
    vault.store("COUNTER", "val");
    vault.retrieve("COUNTER");
    vault.retrieve("COUNTER");
    vault.retrieve("COUNTER");

    const list = vault.list();
    const entry = list.find((e) => e.name === "COUNTER");
    expect(entry?.accessCount).toBe(3);
  });

  it("should delete a credential", () => {
    const vault = new CredentialVault("key");
    vault.store("TO_DELETE", "val");
    expect(vault.delete("TO_DELETE")).toBe(true);
    expect(vault.retrieve("TO_DELETE")).toBeNull();
    expect(vault.delete("TO_DELETE")).toBe(false); // already deleted
  });

  it("should list credentials without exposing values", () => {
    const vault = new CredentialVault("key");
    vault.store("KEY_A", "value_a");
    vault.store("KEY_B", "value_b");

    const list = vault.list();
    expect(list.length).toBe(2);
    // Should not have encryptedValue or iv exposed
    for (const entry of list) {
      expect(entry).not.toHaveProperty("encryptedValue");
      expect(entry).not.toHaveProperty("iv");
    }
  });

  it("should handle size property", () => {
    const vault = new CredentialVault("key");
    expect(vault.size).toBe(0);
    vault.store("A", "1");
    vault.store("B", "2");
    expect(vault.size).toBe(2);
  });
});

// ─── TokenProxy ────────────────────────────────────────────
describe("TokenProxy", () => {
  it("should detect token references", () => {
    const vault = new CredentialVault("key");
    const proxy = new TokenProxy(vault);
    expect(proxy.hasTokens("use {{secret:API_KEY}} here")).toBe(true);
    expect(proxy.hasTokens("no tokens here")).toBe(false);
  });

  it("should resolve token references", () => {
    const vault = new CredentialVault("key");
    vault.store("API_KEY", "sk-123");
    const proxy = new TokenProxy(vault);

    const resolved = proxy.resolve("Bearer {{secret:API_KEY}}");
    expect(resolved).toBe("Bearer sk-123");
  });

  it("should mark unresolved tokens", () => {
    const vault = new CredentialVault("key");
    const proxy = new TokenProxy(vault);

    const resolved = proxy.resolve("{{secret:MISSING_KEY}}");
    expect(resolved).toContain("UNRESOLVED");
  });

  it("should resolve tokens in nested objects", () => {
    const vault = new CredentialVault("key");
    vault.store("DB_PASS", "mypassword");
    const proxy = new TokenProxy(vault);

    const obj = { conn: { password: "{{secret:DB_PASS}}", host: "localhost" }, list: ["{{secret:DB_PASS}}"] };
    const resolved = proxy.resolveObject(obj) as any;

    expect(resolved.conn.password).toBe("mypassword");
    expect(resolved.conn.host).toBe("localhost");
    expect(resolved.list[0]).toBe("mypassword");
  });

  it("should mask secrets in output", () => {
    const vault = new CredentialVault("key");
    vault.store("SECRET", "mysecretvalue123");
    const proxy = new TokenProxy(vault);

    const masked = proxy.maskSecrets("The password is mysecretvalue123 in the config");
    expect(masked).not.toContain("mysecretvalue123");
    expect(masked).toContain("****"); // partial mask
  });
});

// ─── ProcessSandbox ────────────────────────────────────────
describe("ProcessSandbox", () => {
  it("should execute simple code in sandbox", async () => {
    const sandbox = new ProcessSandbox(5);
    const result = await sandbox.execute("return 42;");
    expect(result.success).toBe(true);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("should handle errors in sandbox", async () => {
    const sandbox = new ProcessSandbox(5);
    const result = await sandbox.execute("throw new Error('test error');");
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it("should enforce timeout", async () => {
    const sandbox = new ProcessSandbox(5);
    const result = await sandbox.execute(
      "while(true) {}",
      {},
      { timeoutMs: 2000 },
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain("timeout");
  }, 10000);

  it("should enforce max concurrent limit", async () => {
    const sandbox = new ProcessSandbox(1);
    // Start one long-running task
    const p1 = sandbox.execute("return new Promise(r => setTimeout(() => r('ok'), 1000));", {}, { timeoutMs: 5000 });
    // Immediately try another — should be rejected
    const p2 = sandbox.execute("return 1;");

    const r2 = await p2;
    expect(r2.success).toBe(false);
    expect(r2.error).toContain("concurrent");

    await p1; // cleanup
  });

  it("should track active count", () => {
    const sandbox = new ProcessSandbox(10);
    expect(sandbox.active).toBe(0);
  });

  it("should execute with timeout wrapper", async () => {
    const sandbox = new ProcessSandbox(5);
    const result = await sandbox.executeWithTimeout(
      async () => {
        return "hello from timeout wrapper";
      },
      { timeoutMs: 5000 },
    );

    expect(result.timedOut).toBe(false);
    expect(result.result).toBe("hello from timeout wrapper");
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("should timeout in executeWithTimeout", async () => {
    const sandbox = new ProcessSandbox(5);
    const result = await sandbox.executeWithTimeout(
      () => new Promise((resolve) => setTimeout(resolve, 10000)),
      { timeoutMs: 500 },
    );

    expect(result.timedOut).toBe(true);
    expect(result.error).toContain("timeout");
  });
});

// ─── SandboxBackend Interface ──────────────────────────────
describe("SandboxBackend Interface", () => {
  it("should accept objects implementing SandboxBackend", () => {
    const mockBackend: SandboxBackend = {
      active: 0,
      isAvailable: async () => true,
      execute: async (code: string, language: "javascript" | "python" | "shell") => ({
        success: true,
        output: `executed ${language}: ${code.slice(0, 20)}`,
        durationMs: 10,
      }),
    };

    expect(mockBackend.active).toBe(0);
  });

  it("SecurityManager should accept SandboxBackend for docker/ssh", () => {
    const mgr = new SecurityManager({ masterKey: "test" });

    const mockDocker: SandboxBackend = {
      active: 0,
      isAvailable: async () => true,
      execute: async () => ({ success: true, output: "docker result", durationMs: 50 }),
    };

    mgr.setDockerSandbox(mockDocker);
    expect(mgr.dockerSandbox).toBe(mockDocker);

    mgr.setSSHSandbox(mockDocker);
    expect(mgr.sshSandbox).toBe(mockDocker);
  });
});

// ─── SecurityManager ───────────────────────────────────────
describe("SecurityManager", () => {
  it("should create with default policy", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    const defaultPolicy = mgr.getPolicy("default");
    expect(defaultPolicy).toBeDefined();
    expect(defaultPolicy!.name).toContain("Default");
  });

  it("should set and list policies", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    mgr.setPolicy({
      id: "strict",
      name: "Strict Policy",
      defaultSandbox: "container",
      defaultPermission: "deny",
      toolPermissions: [],
      blockedTools: ["rm", "exec"],
      maxConcurrentSandboxes: 5,
      auditEnabled: true,
    });

    const policies = mgr.listPolicies();
    expect(policies.length).toBe(2); // default + strict
    expect(policies.find((p) => p.id === "strict")?.name).toBe("Strict Policy");
  });

  it("should not delete default policy", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    expect(mgr.deletePolicy("default")).toBe(false);
  });

  it("should check tool permissions correctly", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    mgr.setPolicy({
      id: "test-pol",
      name: "Test",
      defaultSandbox: "process",
      defaultPermission: "allow",
      toolPermissions: [
        { toolName: "file-write", action: "deny", sandboxLevel: "process" },
        { toolName: "web-search", action: "allow", sandboxLevel: "none" },
      ],
      blockedTools: ["rm"],
      maxConcurrentSandboxes: 10,
      auditEnabled: true,
    });

    // Blocked tool
    const rm = mgr.checkPermission("rm", "agent-1", "test-pol");
    expect(rm.allowed).toBe(false);

    // Denied tool
    const fw = mgr.checkPermission("file-write", "agent-1", "test-pol");
    expect(fw.allowed).toBe(false);

    // Allowed tool
    const ws = mgr.checkPermission("web-search", "agent-1", "test-pol");
    expect(ws.allowed).toBe(true);

    // Default permission
    const unknown = mgr.checkPermission("some-tool", "agent-1", "test-pol");
    expect(unknown.allowed).toBe(true);
  });

  it("should record and retrieve audit log", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    mgr.recordExecution("test-tool", "agent-1", "success");
    mgr.recordExecution("test-tool", "agent-1", "error");

    const log = mgr.getAuditLog({ limit: 10 });
    expect(log.length).toBeGreaterThanOrEqual(2);
  });

  it("should provide stats", () => {
    const mgr = new SecurityManager({ masterKey: "key" });
    mgr.storeCredential("K1", "v1");
    mgr.recordExecution("t1", "a1", "success");

    const stats = mgr.getStats();
    expect(stats.totalCredentials).toBe(1);
    expect(stats.totalExecutions).toBe(1);
  });
});
