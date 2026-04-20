/**
 * Memory System — Comprehensive Tests.
 *
 * Covers: InMemoryBackend, MemoryManager (with SimpleEmbedding), SQLiteBackend.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import { InMemoryBackend, MemoryManager, type CoreMemoryBlock } from "../memory/manager.js";
import { SQLiteBackend, initDatabase, closeDatabase } from "../persistence/sqlite.js";
import type { MemoryEntry } from "../types/index.js";

function makeEntry(id: string, overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    id,
    agentId: "agent-1",
    content: `Memory content for ${id}`,
    type: "core",
    createdAt: new Date(),
    updatedAt: new Date(),
    metadata: {},
    ...overrides,
  };
}

// ─── InMemoryBackend ───────────────────────────────────────
describe("InMemoryBackend", () => {
  it("should add and get a memory", async () => {
    const backend = new InMemoryBackend();
    const entry = makeEntry("mem-1");
    await backend.add(entry);

    const loaded = await backend.get("mem-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("Memory content for mem-1");
  });

  it("should return null for missing memory", async () => {
    const backend = new InMemoryBackend();
    expect(await backend.get("no-such")).toBeNull();
  });

  it("should update a memory", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("mem-u"));
    await backend.update("mem-u", { content: "updated content" });

    const loaded = await backend.get("mem-u");
    expect(loaded!.content).toBe("updated content");
  });

  it("should throw on update of non-existent memory", async () => {
    const backend = new InMemoryBackend();
    await expect(backend.update("no-id", { content: "x" })).rejects.toThrow();
  });

  it("should delete a memory", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("mem-d"));
    expect(await backend.delete("mem-d")).toBe(true);
    expect(await backend.get("mem-d")).toBeNull();
    expect(await backend.delete("mem-d")).toBe(false);
  });

  it("should list memories with filters", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("l1", { agentId: "a1", type: "core" }));
    await backend.add(makeEntry("l2", { agentId: "a1", type: "recall" }));
    await backend.add(makeEntry("l3", { agentId: "a2", type: "core" }));

    const a1 = await backend.list({ agentId: "a1" });
    expect(a1.length).toBe(2);

    const cores = await backend.list({ type: "core" });
    expect(cores.length).toBe(2);

    const a1cores = await backend.list({ agentId: "a1", type: "core" });
    expect(a1cores.length).toBe(1);
  });

  it("should count memories", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("c1", { agentId: "a1" }));
    await backend.add(makeEntry("c2", { agentId: "a1" }));
    await backend.add(makeEntry("c3", { agentId: "a2" }));

    expect(await backend.count({ agentId: "a1" })).toBe(2);
    expect(await backend.count({})).toBe(3);
  });

  it("should clear memories matching filter", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("cl1", { agentId: "a1" }));
    await backend.add(makeEntry("cl2", { agentId: "a1" }));
    await backend.add(makeEntry("cl3", { agentId: "a2" }));

    const cleared = await backend.clear({ agentId: "a1" });
    expect(cleared).toBe(2);
    expect(await backend.count({})).toBe(1);
  });

  it("should search memories by keyword", async () => {
    const backend = new InMemoryBackend();
    await backend.add(makeEntry("s1", { content: "TypeScript programming is great", agentId: "a1" }));
    await backend.add(makeEntry("s2", { content: "Python is also nice", agentId: "a1" }));
    await backend.add(makeEntry("s3", { content: "TypeScript and React", agentId: "a1" }));

    const results = await backend.search("TypeScript", { agentId: "a1" }, 10);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0].score).toBeGreaterThan(0);
  });
});

// ─── SQLiteBackend ─────────────────────────────────────────
describe("SQLiteBackend", () => {
  const DB_PATH = path.join(process.cwd(), "data", "test-memory.db");

  beforeAll(async () => {
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
    await initDatabase(DB_PATH);
  });

  afterAll(() => {
    closeDatabase();
    if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
  });

  it("should add and get a memory from SQLite", async () => {
    const backend = new SQLiteBackend();
    await backend.add(makeEntry("sqlite-1", { content: "SQLite test memory" }));

    const loaded = await backend.get("sqlite-1");
    expect(loaded).not.toBeNull();
    expect(loaded!.content).toBe("SQLite test memory");
  });

  it("should update memory in SQLite", async () => {
    const backend = new SQLiteBackend();
    await backend.add(makeEntry("sqlite-u", { content: "original" }));
    await backend.update("sqlite-u", { content: "updated" });

    const loaded = await backend.get("sqlite-u");
    expect(loaded!.content).toBe("updated");
  });

  it("should delete memory from SQLite", async () => {
    const backend = new SQLiteBackend();
    await backend.add(makeEntry("sqlite-d"));
    expect(await backend.delete("sqlite-d")).toBe(true);
    expect(await backend.get("sqlite-d")).toBeNull();
  });

  it("should list and count in SQLite", async () => {
    const backend = new SQLiteBackend();
    await backend.add(makeEntry("sq-l1", { agentId: "a1", type: "core" }));
    await backend.add(makeEntry("sq-l2", { agentId: "a1", type: "recall" }));

    const list = await backend.list({ agentId: "a1" });
    expect(list.length).toBeGreaterThanOrEqual(2);

    const count = await backend.count({ agentId: "a1" });
    expect(count).toBeGreaterThanOrEqual(2);
  });

  it("should search in SQLite using keyword matching", async () => {
    const backend = new SQLiteBackend();
    await backend.add(makeEntry("sq-s1", { content: "JavaScript frameworks comparison", agentId: "a-search" }));
    await backend.add(makeEntry("sq-s2", { content: "Rust performance benchmarks", agentId: "a-search" }));

    const results = await backend.search("JavaScript", { agentId: "a-search" }, 10);
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].entry.content).toContain("JavaScript");
  });

  it("should handle bulk operations", async () => {
    const backend = new SQLiteBackend();
    const start = performance.now();

    for (let i = 0; i < 100; i++) {
      await backend.add(makeEntry(`bulk-${i}`, {
        agentId: "bulk-agent",
        content: `Bulk memory entry number ${i} with some extra text for search testing`,
      }));
    }

    const writeMs = performance.now() - start;
    const count = await backend.count({ agentId: "bulk-agent" });
    expect(count).toBe(100);
    expect(writeMs).toBeLessThan(10000);

    // Search performance
    const searchStart = performance.now();
    const results = await backend.search("number 50", { agentId: "bulk-agent" }, 10);
    const searchMs = performance.now() - searchStart;
    expect(searchMs).toBeLessThan(2000);
  });
});

// ─── MemoryManager ─────────────────────────────────────────
describe("MemoryManager", () => {
  it("should create with InMemoryBackend and core blocks", () => {
    const mgr = new MemoryManager({
      backend: new InMemoryBackend(),
      agentId: "test-agent",
      coreBlocks: [
        { label: "persona", description: "Agent persona", value: "I am a test agent", limit: 2000, readOnly: false },
        { label: "human", description: "User info", value: "", limit: 2000, readOnly: false },
      ],
    });

    const core = mgr.getCoreBlock("persona");
    expect(core).toBeDefined();
    expect(core!.value).toBe("I am a test agent");
  });

  it("should append to core memory", () => {
    const mgr = new MemoryManager({
      backend: new InMemoryBackend(),
      agentId: "test-agent",
      coreBlocks: [
        { label: "human", description: "User info", value: "Name: Alice", limit: 2000, readOnly: false },
      ],
    });

    mgr.appendCoreBlock("human", "\nAge: 30");
    const block = mgr.getCoreBlock("human");
    expect(block!.value).toContain("Name: Alice");
    expect(block!.value).toContain("Age: 30");
  });

  it("should replace in core memory", () => {
    const mgr = new MemoryManager({
      backend: new InMemoryBackend(),
      agentId: "test-agent",
      coreBlocks: [
        { label: "human", description: "User info", value: "Name: Alice", limit: 2000, readOnly: false },
      ],
    });

    mgr.replaceCoreBlock("human", "Name: Alice", "Name: Bob");
    const block = mgr.getCoreBlock("human");
    expect(block!.value).toContain("Name: Bob");
    expect(block!.value).not.toContain("Name: Alice");
  });

  it("should not modify read-only core blocks", () => {
    const mgr = new MemoryManager({
      backend: new InMemoryBackend(),
      agentId: "test-agent",
      coreBlocks: [
        { label: "system", description: "System info", value: "DO NOT CHANGE", limit: 2000, readOnly: true },
      ],
    });

    expect(() => mgr.appendCoreBlock("system", " extra")).toThrow();
  });

  it("should enforce core block size limit", () => {
    const mgr = new MemoryManager({
      backend: new InMemoryBackend(),
      agentId: "test-agent",
      coreBlocks: [
        { label: "tiny", description: "Tiny block", value: "", limit: 10, readOnly: false },
      ],
    });

    expect(() => mgr.appendCoreBlock("tiny", "This is way too long for the limit")).toThrow();
  });
});
