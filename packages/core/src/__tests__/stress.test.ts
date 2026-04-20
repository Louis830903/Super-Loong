/**
 * Extreme Stress Tests — Comprehensive Load Testing.
 *
 * Validates system stability under heavy load:
 * - Concurrent SQLite operations
 * - Large-scale credential management
 * - Parallel sandbox executions
 * - Memory system bulk operations
 * - Evolution system under high throughput
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  initDatabase,
  closeDatabase,
  saveDatabase,
  getDatabase,
  saveAgentConfig,
  loadAllAgentConfigs,
  deleteAgentConfig,
  saveSession,
  loadSession,
  saveCronJob,
  loadCronJobs,
  saveCollabHistory,
  loadCollabHistory,
} from "../persistence/sqlite.js";
import { CredentialVault, ProcessSandbox, SecurityManager } from "../security/sandbox.js";
import { InMemoryBackend } from "../memory/manager.js";
import { CaseCollector, NudgeTracker } from "../evolution/engine.js";
import type { MemoryEntry } from "../types/index.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test-stress.db");

beforeAll(async () => {
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  await initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── SQLite Concurrent Operations ──────────────────────────
describe("SQLite Stress: Concurrent Operations", () => {
  it("should handle 500 rapid agent config writes", () => {
    const start = performance.now();
    for (let i = 0; i < 500; i++) {
      saveAgentConfig(`stress-agent-${i}`, {
        name: `Stress Agent ${i}`,
        model: "gpt-4",
        temperature: Math.random(),
        tools: Array.from({ length: 10 }, (_, j) => `tool-${j}`),
      });
    }
    const writeMs = performance.now() - start;

    const readStart = performance.now();
    const all = loadAllAgentConfigs();
    const readMs = performance.now() - readStart;

    console.log(`  [PERF] 500 agent writes: ${writeMs.toFixed(1)}ms, read all: ${readMs.toFixed(1)}ms`);

    expect(all.length).toBeGreaterThanOrEqual(500);
    expect(writeMs).toBeLessThan(15000);
    expect(readMs).toBeLessThan(3000);

    // Cleanup
    for (let i = 0; i < 500; i++) deleteAgentConfig(`stress-agent-${i}`);
  });

  it("should handle 300 session writes with large messages", () => {
    const start = performance.now();
    const bigMessages = Array.from({ length: 50 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(500), // 500-char messages
    }));

    for (let i = 0; i < 300; i++) {
      saveSession(`stress-sess-${i}`, `agent-${i % 10}`, bigMessages);
    }
    const elapsed = performance.now() - start;

    console.log(`  [PERF] 300 session writes (50 msgs each): ${elapsed.toFixed(1)}ms`);

    expect(elapsed).toBeLessThan(30000);

    // Verify data integrity
    const s = loadSession("stress-sess-150");
    expect(s).not.toBeNull();
    expect(s!.messages).toHaveLength(50);
  });

  it("should handle 200 cron job writes", () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      saveCronJob({
        id: `stress-cron-${i}`,
        name: `Stress Cron ${i}`,
        expression: `${i % 60} * * * *`,
        agentId: `agent-${i % 5}`,
        message: `Run task ${i}`,
        enabled: i % 3 !== 0,
        createdAt: new Date().toISOString(),
      });
    }
    const elapsed = performance.now() - start;

    const jobs = loadCronJobs();
    console.log(`  [PERF] 200 cron writes: ${elapsed.toFixed(1)}ms, loaded: ${jobs.length}`);

    expect(jobs.length).toBeGreaterThanOrEqual(200);
    expect(elapsed).toBeLessThan(10000);
  });

  it("should handle 200 collab history writes", () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      saveCollabHistory({
        id: `stress-collab-${i}`,
        type: i % 2 === 0 ? "crew" : "groupchat",
        name: `Collab ${i}`,
        status: "completed",
        result: JSON.stringify({ output: `Result ${i}`, data: { x: i } }),
        durationMs: Math.floor(Math.random() * 10000),
      });
    }
    const elapsed = performance.now() - start;
    const history = loadCollabHistory(200);

    console.log(`  [PERF] 200 collab writes: ${elapsed.toFixed(1)}ms, loaded: ${history.length}`);

    expect(history.length).toBe(200);
    expect(elapsed).toBeLessThan(10000);
  });
});

// ─── Credential Vault Stress ───────────────────────────────
describe("CredentialVault Stress", () => {
  it("should handle 200 credentials store/retrieve cycle", () => {
    const vault = new CredentialVault("stress-master-key");
    const start = performance.now();

    for (let i = 0; i < 200; i++) {
      vault.store(`CRED_${i}`, `secret-value-${i}-${"x".repeat(100)}`);
    }
    const storeMs = performance.now() - start;

    // Retrieve all
    const retrieveStart = performance.now();
    let successCount = 0;
    for (let i = 0; i < 200; i++) {
      const val = vault.retrieve(`CRED_${i}`);
      if (val && val.startsWith("secret-value-")) successCount++;
    }
    const retrieveMs = performance.now() - retrieveStart;

    console.log(`  [PERF] 200 creds: store ${storeMs.toFixed(1)}ms, retrieve ${retrieveMs.toFixed(1)}ms`);

    expect(successCount).toBe(200);
    expect(vault.size).toBe(200);
    expect(storeMs).toBeLessThan(5000);
    expect(retrieveMs).toBeLessThan(5000);
  });

  it("should handle concurrent access patterns", () => {
    const vault = new CredentialVault("key");
    vault.store("SHARED", "value", { allowedAgents: ["a1", "a2", "a3"] });

    // Simulate rapid access from multiple agents
    const results: (string | null)[] = [];
    for (let i = 0; i < 100; i++) {
      results.push(vault.retrieve("SHARED", `a${(i % 3) + 1}`));
    }

    const successes = results.filter((r) => r !== null).length;
    expect(successes).toBe(100);

    const entry = vault.list().find((e) => e.name === "SHARED");
    expect(entry!.accessCount).toBe(100);
  });
});

// ─── ProcessSandbox Stress ─────────────────────────────────
describe("ProcessSandbox Stress", () => {
  it("should handle 5 concurrent sandbox executions", async () => {
    const sandbox = new ProcessSandbox(5);
    const start = performance.now();

    const promises = Array.from({ length: 5 }, (_, i) =>
      sandbox.execute(`return ${i} * ${i};`, {}, { timeoutMs: 10000 })
    );

    const results = await Promise.all(promises);
    const elapsed = performance.now() - start;

    console.log(`  [PERF] 5 concurrent sandboxes: ${elapsed.toFixed(1)}ms`);

    const successes = results.filter((r) => r.success).length;
    expect(successes).toBe(5);

    // Verify correctness
    for (let i = 0; i < 5; i++) {
      expect(results[i].output).toContain(String(i * i));
    }
  }, 30000);

  it("should handle executeWithTimeout concurrently", async () => {
    const sandbox = new ProcessSandbox(10);
    const start = performance.now();

    const promises = Array.from({ length: 10 }, (_, i) =>
      sandbox.executeWithTimeout(
        async () => `result-${i}`,
        { timeoutMs: 5000 },
      )
    );

    const results = await Promise.all(promises);
    const elapsed = performance.now() - start;

    console.log(`  [PERF] 10 timeout-wrapped executions: ${elapsed.toFixed(1)}ms`);

    expect(results.every((r) => !r.timedOut)).toBe(true);
    expect(results.every((r) => r.result?.startsWith("result-"))).toBe(true);
  });
});

// ─── Memory Backend Stress ─────────────────────────────────
describe("InMemoryBackend Stress", () => {
  it("should handle 1000 memory entries", async () => {
    const backend = new InMemoryBackend();
    const start = performance.now();

    for (let i = 0; i < 1000; i++) {
      await backend.add({
        id: `stress-mem-${i}`,
        agentId: `agent-${i % 5}`,
        content: `Memory entry ${i}: ${"lorem ipsum ".repeat(10)}`,
        type: i % 3 === 0 ? "core" : i % 3 === 1 ? "recall" : "archival",
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: { index: i, category: `cat-${i % 10}` },
      } as MemoryEntry);
    }
    const writeMs = performance.now() - start;

    // Count
    const count = await backend.count({});
    expect(count).toBe(1000);

    // Filter
    const filterStart = performance.now();
    const agent0 = await backend.list({ agentId: "agent-0" });
    const filterMs = performance.now() - filterStart;

    // Search
    const searchStart = performance.now();
    const results = await backend.search("entry 500", {}, 10);
    const searchMs = performance.now() - searchStart;

    console.log(`  [PERF] 1000 memories: write ${writeMs.toFixed(1)}ms, filter ${filterMs.toFixed(1)}ms, search ${searchMs.toFixed(1)}ms`);

    expect(agent0.length).toBe(200);
    expect(writeMs).toBeLessThan(5000);
    expect(filterMs).toBeLessThan(1000);
    expect(searchMs).toBeLessThan(2000);
  });
});

// ─── SecurityManager Integration Stress ────────────────────
describe("SecurityManager Stress", () => {
  it("should handle rapid permission checks", () => {
    const mgr = new SecurityManager({ masterKey: "stress-key" });
    mgr.setPolicy({
      id: "stress-policy",
      name: "Stress Policy",
      defaultSandbox: "process",
      defaultPermission: "allow",
      toolPermissions: Array.from({ length: 20 }, (_, i) => ({
        toolName: `tool-${i}`,
        action: i % 3 === 0 ? "deny" as const : "allow" as const,
        sandboxLevel: "process" as const,
      })),
      blockedTools: ["dangerous-tool"],
      maxConcurrentSandboxes: 10,
      auditEnabled: true,
    });

    const start = performance.now();
    let allowed = 0;
    let denied = 0;

    for (let i = 0; i < 1000; i++) {
      const result = mgr.checkPermission(
        `tool-${i % 25}`,
        `agent-${i % 10}`,
        "stress-policy",
      );
      if (result.allowed) allowed++;
      else denied++;
    }
    const elapsed = performance.now() - start;

    console.log(`  [PERF] 1000 permission checks: ${elapsed.toFixed(1)}ms (${allowed} allowed, ${denied} denied)`);

    expect(allowed + denied).toBe(1000);
    expect(elapsed).toBeLessThan(1000);
  });

  it("should handle rapid audit log writes", () => {
    const mgr = new SecurityManager({ masterKey: "key", maxAuditEntries: 5000 });
    const start = performance.now();

    for (let i = 0; i < 2000; i++) {
      mgr.recordExecution(`tool-${i % 50}`, `agent-${i % 10}`, i % 5 === 0 ? "error" : "success");
    }
    const elapsed = performance.now() - start;

    const stats = mgr.getStats();
    console.log(`  [PERF] 2000 audit entries: ${elapsed.toFixed(1)}ms, total: ${stats.auditLogSize}`);

    expect(stats.totalExecutions).toBe(2000);
    expect(stats.auditLogSize).toBeLessThanOrEqual(5000);
    expect(elapsed).toBeLessThan(3000);
  });
});

// ─── Evolution Stress ──────────────────────────────────────
describe("Evolution System Stress", () => {
  it("should handle rapid NudgeTracker operations", () => {
    const tracker = new NudgeTracker({ memoryReviewInterval: 10, skillReviewInterval: 5 });
    const start = performance.now();
    let memoryReviews = 0;
    let skillReviews = 0;

    for (let i = 0; i < 1000; i++) {
      const result = tracker.recordTurn();
      if (result.shouldReviewMemory) memoryReviews++;
      const toolResult = tracker.recordToolIteration();
      if (toolResult.shouldReviewSkills) skillReviews++;
    }
    const elapsed = performance.now() - start;

    console.log(`  [PERF] 1000 nudge cycles: ${elapsed.toFixed(1)}ms (${memoryReviews} memory reviews, ${skillReviews} skill reviews)`);

    expect(memoryReviews).toBe(100); // 1000/10
    expect(skillReviews).toBe(200);  // 1000/5
    expect(elapsed).toBeLessThan(500);
  });
});

// ─── Cross-Module Integration Stress ───────────────────────
describe("Cross-Module Integration Stress", () => {
  it("should handle mixed operations across all modules", () => {
    const start = performance.now();

    // Simulate real-world mixed usage pattern
    for (let cycle = 0; cycle < 50; cycle++) {
      // Agent config
      saveAgentConfig(`mixed-agent-${cycle}`, { name: `Mixed ${cycle}` });

      // Session
      saveSession(`mixed-sess-${cycle}`, `mixed-agent-${cycle}`, [
        { role: "user", content: `Question ${cycle}` },
        { role: "assistant", content: `Answer ${cycle}` },
      ]);

      // Cron
      saveCronJob({
        id: `mixed-cron-${cycle}`,
        name: `Mixed Cron ${cycle}`,
        expression: "0 * * * *",
        agentId: `mixed-agent-${cycle}`,
        message: `task ${cycle}`,
        enabled: true,
        createdAt: new Date().toISOString(),
      });

      // Collab
      saveCollabHistory({
        id: `mixed-collab-${cycle}`,
        type: cycle % 2 === 0 ? "crew" : "groupchat",
        name: `Collab ${cycle}`,
        status: "completed",
        result: JSON.stringify({ output: cycle }),
        durationMs: cycle * 100,
      });
    }
    const writeMs = performance.now() - start;

    // Read all
    const readStart = performance.now();
    const agents = loadAllAgentConfigs();
    const crons = loadCronJobs();
    const collabs = loadCollabHistory(50);
    const readMs = performance.now() - readStart;

    console.log(`  [PERF] 50-cycle mixed writes: ${writeMs.toFixed(1)}ms, reads: ${readMs.toFixed(1)}ms`);

    expect(agents.length).toBeGreaterThanOrEqual(50);
    expect(crons.length).toBeGreaterThanOrEqual(50);
    expect(collabs.length).toBe(50);
    expect(writeMs).toBeLessThan(15000);
    expect(readMs).toBeLessThan(3000);
  });
});
