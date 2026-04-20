/**
 * lockfile.ts — 版本锁定与更新检测 全面测试
 *
 * 覆盖: SkillLockfileManager (CRUD + 更新检测 + 审计日志 + 工具方法)
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SkillLockfileManager, type SkillLockEntry } from "../skills/lockfile.js";

// ─── 测试工具 ──────────────────────────────────────────────

function makeTempDir(): string {
  const dir = join(tmpdir(), `lockfile-test-${randomBytes(6).toString("hex")}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeEntry(overrides?: Partial<Omit<SkillLockEntry, "installedAt">>): Omit<SkillLockEntry, "installedAt"> {
  return {
    source: "github",
    identifier: "user/repo/SKILL.md",
    trustLevel: "community",
    verdict: "safe",
    contentHash: "a".repeat(64),
    installPath: "/skills/test-skill",
    version: "1.0.0",
    sourceUrl: "https://github.com/user/repo",
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════
// SkillLockfileManager
// ═══════════════════════════════════════════════════════════

describe("SkillLockfileManager", () => {
  let tempDir: string;
  let manager: SkillLockfileManager;

  beforeEach(() => {
    tempDir = makeTempDir();
    manager = new SkillLockfileManager(tempDir);
  });

  afterEach(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  // ── 初始状态 ──

  it("新建管理器应初始化为空", () => {
    expect(manager.count).toBe(0);
    expect(manager.getAllEntries()).toEqual({});
  });

  // ── recordInstall ──

  it("应正确记录安装", () => {
    manager.recordInstall("test-skill", makeEntry());
    expect(manager.count).toBe(1);
    const entry = manager.getEntry("test-skill");
    expect(entry).toBeDefined();
    expect(entry!.source).toBe("github");
    expect(entry!.version).toBe("1.0.0");
    expect(entry!.installedAt).toBeGreaterThan(0);
  });

  it("安装应持久化到文件系统", () => {
    manager.recordInstall("test-skill", makeEntry());
    const lockfilePath = join(tempDir, "lock.json");
    expect(existsSync(lockfilePath)).toBe(true);
    const content = JSON.parse(readFileSync(lockfilePath, "utf-8"));
    expect(content.version).toBe(1);
    expect(content.skills["test-skill"]).toBeDefined();
  });

  it("安装应写入审计日志", () => {
    manager.recordInstall("test-skill", makeEntry());
    const logs = manager.readAuditLog();
    expect(logs.length).toBe(1);
    expect(logs[0].action).toBe("install");
    expect(logs[0].skillName).toBe("test-skill");
  });

  // ── recordUninstall ──

  it("应正确记录卸载", () => {
    manager.recordInstall("test-skill", makeEntry());
    expect(manager.count).toBe(1);
    manager.recordUninstall("test-skill");
    expect(manager.count).toBe(0);
    expect(manager.getEntry("test-skill")).toBeUndefined();
  });

  it("卸载应写入审计日志", () => {
    manager.recordInstall("test-skill", makeEntry());
    manager.recordUninstall("test-skill");
    const logs = manager.readAuditLog();
    expect(logs.length).toBe(2);
    expect(logs[1].action).toBe("uninstall");
  });

  it("卸载不存在的技能不应报错", () => {
    expect(() => manager.recordUninstall("nonexistent")).not.toThrow();
  });

  // ── recordUpdate ──

  it("应正确记录更新", () => {
    manager.recordInstall("test-skill", makeEntry());
    manager.recordUpdate("test-skill", {
      contentHash: "b".repeat(64),
      version: "2.0.0",
    });
    const entry = manager.getEntry("test-skill");
    expect(entry!.contentHash).toBe("b".repeat(64));
    expect(entry!.version).toBe("2.0.0");
  });

  it("更新不存在的技能不应报错", () => {
    expect(() => manager.recordUpdate("nonexistent", { version: "2.0.0" })).not.toThrow();
  });

  // ── getAllEntries ──

  it("getAllEntries 应返回副本", () => {
    manager.recordInstall("skill-a", makeEntry({ version: "1.0" }));
    manager.recordInstall("skill-b", makeEntry({ version: "2.0" }));
    const all = manager.getAllEntries();
    expect(Object.keys(all)).toHaveLength(2);
    // 修改副本不应影响原数据
    delete all["skill-a"];
    expect(manager.getEntry("skill-a")).toBeDefined();
  });

  // ── hasUpdate ──

  it("哈希不同时 hasUpdate 应返回 true", () => {
    manager.recordInstall("test-skill", makeEntry({ contentHash: "old_hash" }));
    expect(manager.hasUpdate("test-skill", "new_hash")).toBe(true);
  });

  it("哈希相同时 hasUpdate 应返回 false", () => {
    manager.recordInstall("test-skill", makeEntry({ contentHash: "same" }));
    expect(manager.hasUpdate("test-skill", "same")).toBe(false);
  });

  it("不存在的技能 hasUpdate 应返回 false", () => {
    expect(manager.hasUpdate("nonexistent", "any")).toBe(false);
  });

  // ── checkForUpdates ──

  it("应检测到有更新的技能", async () => {
    manager.recordInstall("skill-a", makeEntry({ contentHash: "old" }));
    manager.recordInstall("skill-b", makeEntry({ contentHash: "same" }));

    const results = await manager.checkForUpdates(async (entry) => {
      if (entry.contentHash === "old") return { hash: "new", version: "2.0" };
      return { hash: "same" };
    });

    expect(results).toHaveLength(2);
    const updated = results.find((r) => r.name === "skill-a");
    expect(updated!.status).toBe("update_available");
    expect(updated!.latestVersion).toBe("2.0");
    const upToDate = results.find((r) => r.name === "skill-b");
    expect(upToDate!.status).toBe("up_to_date");
  });

  it("回调返回 null 时应标记为 error", async () => {
    manager.recordInstall("broken", makeEntry());
    const results = await manager.checkForUpdates(async () => null);
    expect(results[0].status).toBe("error");
  });

  it("回调抛异常时应标记为 error", async () => {
    manager.recordInstall("broken", makeEntry());
    const results = await manager.checkForUpdates(async () => { throw new Error("network"); });
    expect(results[0].status).toBe("error");
    expect(results[0].error).toBe("network");
  });

  it("空 lockfile 时 checkForUpdates 应返回空数组", async () => {
    const results = await manager.checkForUpdates(async () => ({ hash: "x" }));
    expect(results).toHaveLength(0);
  });

  // ── 审计日志 ──

  it("应能追加和读取审计日志", () => {
    manager.appendAuditLog("scan", "test-skill", { result: "clean" });
    manager.appendAuditLog("block", "evil-skill");
    const logs = manager.readAuditLog();
    expect(logs).toHaveLength(2);
    expect(logs[0].action).toBe("scan");
    expect(logs[1].action).toBe("block");
  });

  it("readAuditLog 应支持 limit 参数", () => {
    for (let i = 0; i < 10; i++) {
      manager.appendAuditLog("install", `skill-${i}`);
    }
    const logs = manager.readAuditLog(3);
    expect(logs).toHaveLength(3);
  });

  it("不存在审计日志文件时应返回空数组", () => {
    const freshDir = makeTempDir();
    const freshManager = new SkillLockfileManager(freshDir);
    expect(freshManager.readAuditLog()).toEqual([]);
    try { rmSync(freshDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  });

  // ── 持久化跨实例 ──

  it("新实例应能读取之前的锁定数据", () => {
    manager.recordInstall("test-skill", makeEntry({ version: "1.0" }));
    // 创建新实例读取同一目录
    const manager2 = new SkillLockfileManager(tempDir);
    expect(manager2.count).toBe(1);
    expect(manager2.getEntry("test-skill")!.version).toBe("1.0");
  });

  // ── 静态方法 ──

  it("computeHash 应返回合法 SHA256", () => {
    const hash = SkillLockfileManager.computeHash("test content");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("formatUpdateResults 空数组应返回提示文本", () => {
    expect(SkillLockfileManager.formatUpdateResults([])).toContain("No installed skills");
  });

  it("formatUpdateResults 应正确格式化各种状态", () => {
    const output = SkillLockfileManager.formatUpdateResults([
      { name: "a", status: "update_available", currentVersion: "1.0", latestVersion: "2.0" },
      { name: "b", status: "up_to_date", currentVersion: "1.0" },
      { name: "c", status: "error", error: "timeout" },
    ]);
    expect(output).toContain("1 update(s) available");
    expect(output).toContain("↑ a");
    expect(output).toContain("1 skill(s) up to date");
    expect(output).toContain("1 check(s) failed");
    expect(output).toContain("✗ c: timeout");
  });
});
