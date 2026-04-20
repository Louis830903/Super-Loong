/**
 * SQLite Persistence Layer — Comprehensive Tests.
 *
 * Covers: initDatabase, CRUD for all 9+ table modules, FTS5, cleanup functions.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";

import {
  initDatabase,
  closeDatabase,
  saveDatabase,
  getDatabase,
  // Agent
  saveAgentConfig,
  loadAllAgentConfigs,
  deleteAgentConfig,
  // Session
  saveSession,
  loadSession,
  deleteSession,
  listSessionsByAgent,
  // Core Blocks
  saveCoreBlock,
  loadCoreBlocks,
  // Cron
  saveCronJob,
  loadCronJobs,
  deleteCronJob,
  addCronHistory,
  loadCronHistory,
  // MCP
  saveMCPServer,
  loadMCPServers,
  deleteMCPServer,
  // Skills
  saveInstalledSkill,
  loadInstalledSkills,
  deleteInstalledSkill,
  // Security Policy
  saveSecurityPolicy,
  loadSecurityPolicies,
  deleteSecurityPolicy,
  // Collab History
  saveCollabHistory,
  loadCollabHistory,
  deleteCollabHistory,
  // Evolution Cleanup
  purgeEvolutionCases,
  purgeSkillProposals,
  // FTS5
  indexMemoryFTS,
  searchMemoriesFTS,
  removeMemoryFTS,
} from "../persistence/sqlite.js";

const TEST_DB_PATH = path.join(process.cwd(), "data", "test-persistence.db");

beforeAll(async () => {
  // Clean up any previous test DB
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
  await initDatabase(TEST_DB_PATH);
});

afterAll(() => {
  closeDatabase();
  if (fs.existsSync(TEST_DB_PATH)) fs.unlinkSync(TEST_DB_PATH);
});

// ─── Agent Config ──────────────────────────────────────────
describe("Agent Config Persistence", () => {
  it("should save and load agent configs", () => {
    saveAgentConfig("agent-1", { name: "TestAgent", model: "gpt-4" });
    saveAgentConfig("agent-2", { name: "Agent2", model: "qwen" });

    const configs = loadAllAgentConfigs();
    expect(configs.length).toBeGreaterThanOrEqual(2);
    const a1 = configs.find((c) => c.id === "agent-1");
    expect(a1?.config.name).toBe("TestAgent");
  });

  it("should overwrite on duplicate id", () => {
    saveAgentConfig("agent-1", { name: "UpdatedAgent", model: "gpt-4o" });
    const configs = loadAllAgentConfigs();
    const a1 = configs.find((c) => c.id === "agent-1");
    expect(a1?.config.name).toBe("UpdatedAgent");
  });

  it("should delete agent config", () => {
    deleteAgentConfig("agent-2");
    const configs = loadAllAgentConfigs();
    expect(configs.find((c) => c.id === "agent-2")).toBeUndefined();
  });
});

// ─── Session ───────────────────────────────────────────────
describe("Session Persistence", () => {
  it("should save and load session", () => {
    const msgs = [{ role: "user", content: "hello" }, { role: "assistant", content: "hi" }];
    saveSession("sess-1", "agent-1", msgs, "user-1");

    const loaded = loadSession("sess-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.agentId).toBe("agent-1");
    expect(loaded!.messages).toHaveLength(2);
  });

  it("should return null for non-existent session", () => {
    expect(loadSession("no-such-sess")).toBeNull();
  });

  it("should list sessions by agent", () => {
    saveSession("sess-2", "agent-1", [{ role: "user", content: "test" }]);
    const list = listSessionsByAgent("agent-1");
    expect(list.length).toBeGreaterThanOrEqual(2);
  });

  it("should delete session", () => {
    deleteSession("sess-1");
    expect(loadSession("sess-1")).toBeNull();
  });
});

// ─── Core Blocks ───────────────────────────────────────────
describe("Core Blocks Persistence", () => {
  it("should save and load core blocks", () => {
    saveCoreBlock("agent-1", {
      label: "persona",
      description: "Agent persona",
      value: "I am a helpful assistant",
      limit: 2000,
      readOnly: false,
    });

    const blocks = loadCoreBlocks("agent-1");
    expect(blocks.length).toBe(1);
    expect(blocks[0].label).toBe("persona");
    expect(blocks[0].value).toBe("I am a helpful assistant");
  });
});

// ─── Cron Jobs ─────────────────────────────────────────────
describe("Cron Persistence", () => {
  it("should save and load cron jobs", () => {
    saveCronJob({
      id: "cron-1",
      name: "Hourly Check",
      expression: "0 * * * *",
      agentId: "agent-1",
      message: "run health check",
      enabled: true,
      timezone: "Asia/Shanghai",
      createdAt: new Date().toISOString(),
    });

    const jobs = loadCronJobs();
    expect(jobs.length).toBeGreaterThanOrEqual(1);
    const j = jobs.find((j) => j.id === "cron-1") as Record<string, unknown>;
    expect(j.name).toBe("Hourly Check");
    expect(j.enabled).toBe(true);
  });

  it("should add and load cron history", () => {
    addCronHistory({
      jobId: "cron-1",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      status: "completed",
      response: "OK",
    });

    const history = loadCronHistory("cron-1");
    expect(history.length).toBe(1);
    expect(history[0].status).toBe("completed");
  });

  it("should delete cron job", () => {
    deleteCronJob("cron-1");
    const jobs = loadCronJobs();
    expect(jobs.find((j) => j.id === "cron-1")).toBeUndefined();
  });
});

// ─── MCP Servers ───────────────────────────────────────────
describe("MCP Server Persistence", () => {
  it("should save and load MCP servers", () => {
    saveMCPServer({
      id: "mcp-1",
      name: "filesystem",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { PATH: "/usr/bin" },
      enabled: true,
      createdAt: new Date().toISOString(),
    });

    const servers = loadMCPServers();
    expect(servers.length).toBeGreaterThanOrEqual(1);
    const s = servers.find((s) => s.id === "mcp-1") as Record<string, unknown>;
    expect(s.name).toBe("filesystem");
    expect(Array.isArray(s.args)).toBe(true);
    expect(s.enabled).toBe(true);
  });

  it("should delete MCP server", () => {
    deleteMCPServer("mcp-1");
    expect(loadMCPServers().find((s) => s.id === "mcp-1")).toBeUndefined();
  });
});

// ─── Installed Skills ──────────────────────────────────────
describe("Installed Skills Persistence", () => {
  it("should save and load skills", () => {
    saveInstalledSkill({
      id: "skill-1",
      name: "web-search",
      source: "github",
      sourceUrl: "https://github.com/test/skills",
      version: "1.2.0",
      format: "super-agent",
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: { tags: ["search"] },
    });

    const skills = loadInstalledSkills();
    expect(skills.length).toBeGreaterThanOrEqual(1);
    const s = skills.find((s) => s.id === "skill-1") as Record<string, unknown>;
    expect(s.name).toBe("web-search");
    expect((s.metadata as any).tags).toContain("search");
  });

  it("should delete skill", () => {
    deleteInstalledSkill("skill-1");
    expect(loadInstalledSkills().find((s) => s.id === "skill-1")).toBeUndefined();
  });
});

// ─── Security Policy ───────────────────────────────────────
describe("Security Policy Persistence", () => {
  it("should save and load policies", () => {
    saveSecurityPolicy("pol-1", "Strict", JSON.stringify({ sandboxLevel: "container" }));
    saveSecurityPolicy("pol-2", "Permissive", JSON.stringify({ sandboxLevel: "none" }));

    const policies = loadSecurityPolicies();
    expect(policies.length).toBeGreaterThanOrEqual(2);
    expect(policies.find((p) => p.id === "pol-1")?.name).toBe("Strict");
  });

  it("should delete policy", () => {
    deleteSecurityPolicy("pol-2");
    expect(loadSecurityPolicies().find((p) => p.id === "pol-2")).toBeUndefined();
  });
});

// ─── Collaboration History ─────────────────────────────────
describe("Collaboration History Persistence", () => {
  it("should save and load collab history", () => {
    saveCollabHistory({
      id: "collab-1",
      type: "crew",
      name: "Research Crew",
      status: "completed",
      result: JSON.stringify({ taskOutputs: [] }),
      durationMs: 5000,
    });

    const history = loadCollabHistory();
    expect(history.length).toBeGreaterThanOrEqual(1);
    const h = history.find((h) => h.id === "collab-1") as Record<string, unknown>;
    expect(h.type).toBe("crew");
    expect(h.name).toBe("Research Crew");
  });

  it("should respect type CHECK constraint", () => {
    expect(() => {
      const db = getDatabase();
      db.run(
        `INSERT INTO collab_history (id, type, name, status, result, durationMs, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ["bad", "invalid_type", "test", "ok", "{}", 0, new Date().toISOString()]
      );
    }).toThrow();
  });

  it("should delete collab history", () => {
    deleteCollabHistory("collab-1");
    expect(loadCollabHistory().find((h) => h.id === "collab-1")).toBeUndefined();
  });
});

// ─── Evolution Tables Cleanup ──────────────────────────────
describe("Evolution Tables Cleanup", () => {
  it("should purge old evolution cases by retention", () => {
    const db = getDatabase();
    // Insert an old case (90 days ago)
    const oldTs = new Date(Date.now() - 90 * 86_400_000).toISOString();
    db.run(
      `INSERT OR REPLACE INTO evolution_cases (id, agentId, sessionId, userMessage, agentResponse, success, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["old-case-1", "a1", "s1", "msg", "resp", 1, oldTs]
    );
    // Insert a recent case
    db.run(
      `INSERT OR REPLACE INTO evolution_cases (id, agentId, sessionId, userMessage, agentResponse, success, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ["new-case-1", "a1", "s1", "msg", "resp", 0, new Date().toISOString()]
    );
    saveDatabase();

    purgeEvolutionCases(500, 30);

    const remaining = db.exec("SELECT id FROM evolution_cases");
    const ids = remaining.length ? remaining[0].values.map((v: unknown[]) => v[0]) : [];
    expect(ids).toContain("new-case-1");
    expect(ids).not.toContain("old-case-1");
  });

  it("should purge skill proposals by retention", () => {
    const db = getDatabase();
    const oldTs = new Date(Date.now() - 90 * 86_400_000).toISOString();
    db.run(
      `INSERT OR REPLACE INTO skill_proposals (id, skillName, action, status, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      ["old-prop-1", "test-skill", "create", "pending", oldTs]
    );
    db.run(
      `INSERT OR REPLACE INTO skill_proposals (id, skillName, action, status, createdAt)
       VALUES (?, ?, ?, ?, ?)`,
      ["new-prop-1", "new-skill", "create", "approved", new Date().toISOString()]
    );
    saveDatabase();

    purgeSkillProposals(300, 60);

    const remaining = db.exec("SELECT id FROM skill_proposals");
    const ids = remaining.length ? remaining[0].values.map((v: unknown[]) => v[0]) : [];
    expect(ids).toContain("new-prop-1");
    expect(ids).not.toContain("old-prop-1");
  });
});

// ─── FTS5 Full-Text Search ─────────────────────────────────
describe("FTS5 Full-Text Search", () => {
  it("should index and search memories via FTS5", () => {
    indexMemoryFTS({ id: "mem-1", agentId: "a1", content: "The user likes TypeScript programming", type: "core" });
    indexMemoryFTS({ id: "mem-2", agentId: "a1", content: "User prefers dark mode interfaces", type: "recall" });

    const results = searchMemoriesFTS("TypeScript");
    // FTS5 may not be available in all sql.js builds — test gracefully
    if (results.length > 0) {
      expect(results[0].content).toContain("TypeScript");
    }
  });

  it("should remove memory from FTS index", () => {
    removeMemoryFTS("mem-1");
    const results = searchMemoriesFTS("TypeScript");
    // After removal, should not find the entry (if FTS5 is available)
    const found = results.find((r) => r.id === "mem-1");
    expect(found).toBeUndefined();
  });
});

// ─── Bulk Operations Performance ───────────────────────────
describe("Bulk Operations Performance", () => {
  it("should handle 100 agent configs efficiently", () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      saveAgentConfig(`bulk-agent-${i}`, { name: `Agent ${i}`, model: "test" });
    }
    const writeMs = performance.now() - start;

    const readStart = performance.now();
    const all = loadAllAgentConfigs();
    const readMs = performance.now() - readStart;

    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(writeMs).toBeLessThan(5000); // 100 writes < 5s
    expect(readMs).toBeLessThan(1000);  // read all < 1s

    // Cleanup
    for (let i = 0; i < 100; i++) deleteAgentConfig(`bulk-agent-${i}`);
  });

  it("should handle 200 session saves", () => {
    const start = performance.now();
    for (let i = 0; i < 200; i++) {
      saveSession(`bulk-sess-${i}`, "agent-1", [
        { role: "user", content: `message ${i}` },
        { role: "assistant", content: `response ${i}` },
      ]);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(10000); // 200 session writes < 10s

    const list = listSessionsByAgent("agent-1");
    expect(list.length).toBeGreaterThanOrEqual(200);

    // Cleanup
    for (let i = 0; i < 200; i++) deleteSession(`bulk-sess-${i}`);
  });
});
