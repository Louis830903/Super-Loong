/**
 * sources/router.ts — 统一技能源路由器 全面测试
 *
 * 覆盖: SourceRouter (addSource, removeSource, getSources, getSource,
 *        unifiedSearch, fetchFirst)
 */
import { describe, it, expect, vi } from "vitest";
import { SourceRouter } from "../skills/sources/router.js";
import { SkillSource, type SkillMeta, type SkillBundle } from "../skills/sources/base.js";
import type { TrustLevel } from "../skills/guard.js";

// ─── Mock SkillSource 实现 ──────────────────────────────────

class MockSource extends SkillSource {
  readonly sourceId: string;
  private _trustLevel: TrustLevel;
  private _results: SkillMeta[];
  private _bundle: SkillBundle | null;

  constructor(id: string, trust: TrustLevel = "community", results: SkillMeta[] = [], bundle: SkillBundle | null = null) {
    super();
    this.sourceId = id;
    this._trustLevel = trust;
    this._results = results;
    this._bundle = bundle;
  }

  async search(query: string, limit?: number): Promise<SkillMeta[]> {
    return this._results.slice(0, limit);
  }

  async fetch(identifier: string): Promise<SkillBundle | null> {
    return this._bundle;
  }

  trustLevel(): TrustLevel {
    return this._trustLevel;
  }
}

function makeMeta(name: string, source: string): SkillMeta {
  return { name, description: `${name} desc`, source, identifier: `${source}:${name}`, trustLevel: "community" };
}

function makeBundle(name: string, source: string): SkillBundle {
  return {
    name,
    files: new Map([["SKILL.md", `# ${name}\nContent`]]),
    source,
    identifier: `${source}:${name}`,
    trustLevel: "community",
  };
}

// ═══════════════════════════════════════════════════════════
// SourceRouter — 源管理
// ═══════════════════════════════════════════════════════════

describe("SourceRouter — 源管理", () => {
  it("初始化为空路由器", () => {
    const router = new SourceRouter();
    expect(router.getSources()).toHaveLength(0);
  });

  it("通过构造函数初始化源", () => {
    const s1 = new MockSource("local");
    const s2 = new MockSource("github");
    const router = new SourceRouter([s1, s2]);
    expect(router.getSources()).toHaveLength(2);
  });

  it("addSource 应添加到末尾", () => {
    const router = new SourceRouter();
    router.addSource(new MockSource("a"));
    router.addSource(new MockSource("b"));
    const ids = router.getSources().map((s) => s.sourceId);
    expect(ids).toEqual(["a", "b"]);
  });

  it("addSource 应拒绝重复 sourceId", () => {
    const router = new SourceRouter();
    router.addSource(new MockSource("a"));
    router.addSource(new MockSource("a")); // 重复
    expect(router.getSources()).toHaveLength(1);
  });

  it("removeSource 应移除指定源", () => {
    const router = new SourceRouter([new MockSource("a"), new MockSource("b"), new MockSource("c")]);
    router.removeSource("b");
    const ids = router.getSources().map((s) => s.sourceId);
    expect(ids).toEqual(["a", "c"]);
  });

  it("removeSource 不存在的 ID 不应报错", () => {
    const router = new SourceRouter([new MockSource("a")]);
    expect(() => router.removeSource("nonexistent")).not.toThrow();
    expect(router.getSources()).toHaveLength(1);
  });

  it("getSource 应返回匹配的源", () => {
    const s = new MockSource("github");
    const router = new SourceRouter([s]);
    expect(router.getSource("github")).toBe(s);
    expect(router.getSource("unknown")).toBeUndefined();
  });

  it("getSources 应返回副本", () => {
    const router = new SourceRouter([new MockSource("a")]);
    const sources = router.getSources();
    sources.push(new MockSource("b")); // 修改副本
    expect(router.getSources()).toHaveLength(1); // 原数据不变
  });
});

// ═══════════════════════════════════════════════════════════
// SourceRouter — unifiedSearch
// ═══════════════════════════════════════════════════════════

describe("SourceRouter — unifiedSearch", () => {
  it("无源时应返回空数组", async () => {
    const router = new SourceRouter();
    expect(await router.unifiedSearch("test")).toEqual([]);
  });

  it("应并发查询所有源并合并结果", async () => {
    const s1 = new MockSource("local", "trusted", [makeMeta("skill-a", "local")]);
    const s2 = new MockSource("github", "community", [makeMeta("skill-b", "github")]);
    const router = new SourceRouter([s1, s2]);
    const results = await router.unifiedSearch("test");
    expect(results).toHaveLength(2);
    expect(results.map((r) => r.name)).toContain("skill-a");
    expect(results.map((r) => r.name)).toContain("skill-b");
  });

  it("同名技能应去重（保留优先级更高的源）", async () => {
    const s1 = new MockSource("local", "trusted", [makeMeta("git-commit", "local")]);
    const s2 = new MockSource("github", "community", [makeMeta("git-commit", "github")]);
    const router = new SourceRouter([s1, s2]); // local 优先
    const results = await router.unifiedSearch("git");
    expect(results).toHaveLength(1);
    expect(results[0].source).toBe("local"); // 保留优先级高的
  });

  it("应尊重 limit 参数", async () => {
    const metas = Array.from({ length: 10 }, (_, i) => makeMeta(`skill-${i}`, "github"));
    const s = new MockSource("github", "community", metas);
    const router = new SourceRouter([s]);
    const results = await router.unifiedSearch("test", 5);
    expect(results).toHaveLength(5);
  });

  it("源搜索失败时应优雅降级（不影响其他源）", async () => {
    const s1 = new MockSource("local", "trusted", [makeMeta("good", "local")]);
    // 模拟搜索失败的源
    const s2 = new MockSource("broken", "community");
    vi.spyOn(s2, "search").mockRejectedValue(new Error("Network error"));
    const router = new SourceRouter([s1, s2]);
    const results = await router.unifiedSearch("test");
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe("good");
  });
});

// ═══════════════════════════════════════════════════════════
// SourceRouter — fetchFirst
// ═══════════════════════════════════════════════════════════

describe("SourceRouter — fetchFirst", () => {
  it("通过 sourceId 前缀路由到指定源", async () => {
    const bundle = makeBundle("test", "github");
    const s = new MockSource("github", "community", [], bundle);
    const router = new SourceRouter([s]);
    const result = await router.fetchFirst("github:test");
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test");
  });

  it("无前缀时应回退尝试所有源", async () => {
    const s1 = new MockSource("local", "trusted", [], null);
    const s2 = new MockSource("github", "community", [], makeBundle("test", "github"));
    const router = new SourceRouter([s1, s2]);
    const result = await router.fetchFirst("some-identifier");
    expect(result).not.toBeNull();
    expect(result!.source).toBe("github");
  });

  it("所有源都找不到时应返回 null", async () => {
    const s1 = new MockSource("local", "trusted", [], null);
    const s2 = new MockSource("github", "community", [], null);
    const router = new SourceRouter([s1, s2]);
    expect(await router.fetchFirst("nonexistent")).toBeNull();
  });

  it("指定源 fetch 失败时应回退到其他源", async () => {
    const s1 = new MockSource("broken", "community");
    vi.spyOn(s1, "fetch").mockRejectedValue(new Error("fail"));
    const s2 = new MockSource("github", "community", [], makeBundle("test", "github"));
    const router = new SourceRouter([s1, s2]);
    // 前缀指定 "broken"，失败后回退
    const result = await router.fetchFirst("broken:test");
    // 回退到全量尝试，github 源应该返回 bundle
    expect(result).not.toBeNull();
  });

  it("空路由器应返回 null", async () => {
    const router = new SourceRouter();
    expect(await router.fetchFirst("anything")).toBeNull();
  });
});
