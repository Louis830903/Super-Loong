/**
 * config-inject.ts — 技能配置变量注入 全面测试
 *
 * 覆盖: extractConfigVars, resolveConfigValues, injectSkillConfig, applyConfigInjection,
 *       discoverAllConfigVars, formatMissingConfigMessage, InMemoryConfigStore, ConfigStoreAdapter
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { Skill, SkillFrontmatter } from "../types/index.js";
import type { SkillLoader } from "../skills/loader.js";
import {
  extractConfigVars,
  resolveConfigValues,
  injectSkillConfig,
  applyConfigInjection,
  discoverAllConfigVars,
  formatMissingConfigMessage,
  InMemoryConfigStore,
  ConfigStoreAdapter,
} from "../skills/config-inject.js";

// ─── 测试工具 ──────────────────────────────────────────────

function makeSkill(name: string, content: string, meta?: Record<string, unknown>): Skill {
  return {
    id: name,
    frontmatter: { name, description: `${name} desc`, metadata: meta } as SkillFrontmatter,
    content,
    filePath: `/skills/${name}.md`,
    enabled: true,
    loadedAt: new Date(),
  };
}

function makeLoader(skills: Skill[]): SkillLoader {
  return {
    listSkills: () => skills,
  } as unknown as SkillLoader;
}

// ═══════════════════════════════════════════════════════════
// InMemoryConfigStore
// ═══════════════════════════════════════════════════════════

describe("InMemoryConfigStore", () => {
  it("应支持 get/set/getAll", () => {
    const store = new InMemoryConfigStore();
    expect(store.get("key")).toBeUndefined();
    store.set("key", "value");
    expect(store.get("key")).toBe("value");
    expect(store.getAll()).toEqual({ key: "value" });
  });

  it("应支持初始值构造", () => {
    const store = new InMemoryConfigStore({ a: "1", b: "2" });
    expect(store.get("a")).toBe("1");
    expect(store.get("b")).toBe("2");
    expect(Object.keys(store.getAll())).toHaveLength(2);
  });

  it("空初始化应返回空对象", () => {
    const store = new InMemoryConfigStore();
    expect(store.getAll()).toEqual({});
  });
});

// ═══════════════════════════════════════════════════════════
// ConfigStoreAdapter
// ═══════════════════════════════════════════════════════════

describe("ConfigStoreAdapter", () => {
  it("应正确剥离 skills. 前缀并转发到 realStore", () => {
    const realStore = {
      get: (serviceId: string, key: string) => {
        if (serviceId === "skills" && key === "config.git-commit.api_key") return "my-key";
        return null;
      },
      getAll: (serviceId: string): Record<string, string> => serviceId === "skills" ? { "config.git-commit.api_key": "my-key" } : {},
    };
    const adapter = new ConfigStoreAdapter(realStore);
    // "skills.config.git-commit.api_key" → realStore.get("skills", "config.git-commit.api_key")
    expect(adapter.get("skills.config.git-commit.api_key")).toBe("my-key");
  });

  it("无 skills. 前缀时应直接传递 key", () => {
    const realStore = {
      get: (serviceId: string, key: string) => {
        if (serviceId === "skills" && key === "raw-key") return "raw-value";
        return null;
      },
      getAll: () => ({}),
    };
    const adapter = new ConfigStoreAdapter(realStore);
    expect(adapter.get("raw-key")).toBe("raw-value");
  });

  it("realStore 返回 null 时应转换为 undefined", () => {
    const realStore = {
      get: () => null,
      getAll: () => ({}),
    };
    const adapter = new ConfigStoreAdapter(realStore);
    expect(adapter.get("any")).toBeUndefined();
  });

  it("getAll 应委托给 realStore.getAll", () => {
    const realStore = {
      get: () => null,
      getAll: (serviceId: string): Record<string, string> => serviceId === "skills" ? { a: "1" } : {},
    };
    const adapter = new ConfigStoreAdapter(realStore);
    expect(adapter.getAll()).toEqual({ a: "1" });
  });
});

// ═══════════════════════════════════════════════════════════
// extractConfigVars
// ═══════════════════════════════════════════════════════════

describe("extractConfigVars", () => {
  it("无 metadata 时应返回空数组", () => {
    const fm = { name: "test", description: "test" } as SkillFrontmatter;
    expect(extractConfigVars(fm)).toEqual([]);
  });

  it("应从 metadata.config 提取配置变量", () => {
    const fm = {
      name: "wiki",
      description: "Wiki skill",
      metadata: {
        config: [
          { key: "wiki.path", description: "Wiki directory", default: "~/wiki", prompt: "Enter path" },
          { key: "api.url", description: "API URL", required: true },
        ],
      },
    } as unknown as SkillFrontmatter;
    const specs = extractConfigVars(fm);
    expect(specs).toHaveLength(2);
    expect(specs[0].key).toBe("wiki.path");
    expect(specs[0].defaultValue).toBe("~/wiki");
    expect(specs[0].prompt).toBe("Enter path");
    expect(specs[1].key).toBe("api.url");
    expect(specs[1].required).toBe(true);
  });

  it("应从 metadata.hermes.config 提取配置变量", () => {
    const fm = {
      name: "hermes-skill",
      description: "Hermes format",
      metadata: {
        hermes: {
          config: [
            { key: "model", description: "Model name", default: "gpt-4" },
          ],
        },
      },
    } as unknown as SkillFrontmatter;
    const specs = extractConfigVars(fm);
    expect(specs).toHaveLength(1);
    expect(specs[0].key).toBe("model");
    expect(specs[0].defaultValue).toBe("gpt-4");
  });

  it("两种格式重复 key 应去重", () => {
    const fm = {
      name: "dual",
      description: "Dual format",
      metadata: {
        config: [{ key: "api_key", description: "API Key" }],
        hermes: { config: [{ key: "api_key", description: "API Key (hermes)" }] },
      },
    } as unknown as SkillFrontmatter;
    const specs = extractConfigVars(fm);
    expect(specs).toHaveLength(1);
    expect(specs[0].description).toBe("API Key"); // 第一个格式优先
  });

  it("非对象 config 条目应跳过", () => {
    const fm = {
      name: "weird",
      description: "Weird",
      metadata: { config: ["not-an-object", null, 42] },
    } as unknown as SkillFrontmatter;
    expect(extractConfigVars(fm)).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// resolveConfigValues
// ═══════════════════════════════════════════════════════════

describe("resolveConfigValues", () => {
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.SKILL_CONFIG_WIKI_PATH = process.env.SKILL_CONFIG_WIKI_PATH;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("应从 store 获取配置值", () => {
    const store = new InMemoryConfigStore({
      "skills.config.wiki.path": "/my/wiki",
    });
    const specs = [{ key: "path", description: "Wiki path" }];
    const values = resolveConfigValues("wiki", specs, store);
    expect(values.path).toBe("/my/wiki");
  });

  it("store 无值时应回退到环境变量", () => {
    const envKey = "SKILL_CONFIG_WIKI_PATH";
    process.env[envKey] = "/env/wiki";
    const store = new InMemoryConfigStore();
    const specs = [{ key: "path", description: "Wiki path" }];
    const values = resolveConfigValues("wiki", specs, store);
    expect(values.path).toBe("/env/wiki");
  });

  it("环境变量也没有时应回退到默认值", () => {
    const store = new InMemoryConfigStore();
    const specs = [{ key: "mode", description: "Mode", defaultValue: "fast" }];
    const values = resolveConfigValues("test", specs, store);
    expect(values.mode).toBe("fast");
  });

  it("全都没有时应跳过该变量", () => {
    const store = new InMemoryConfigStore();
    const specs = [{ key: "missing", description: "Missing key" }];
    const values = resolveConfigValues("test", specs, store);
    expect(Object.keys(values)).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// injectSkillConfig
// ═══════════════════════════════════════════════════════════

describe("injectSkillConfig", () => {
  it("有值时应在内容前注入 [Skill config] 块", () => {
    const result = injectSkillConfig("Original content", { "wiki.path": "~/wiki", "mode": "fast" });
    expect(result).toContain("[Skill config]");
    expect(result).toContain("wiki.path = ~/wiki");
    expect(result).toContain("mode = fast");
    expect(result).toContain("Original content");
    // 配置块应在内容之前
    expect(result.indexOf("[Skill config]")).toBeLessThan(result.indexOf("Original content"));
  });

  it("空值对象时应返回原内容", () => {
    expect(injectSkillConfig("Content", {})).toBe("Content");
  });
});

// ═══════════════════════════════════════════════════════════
// applyConfigInjection
// ═══════════════════════════════════════════════════════════

describe("applyConfigInjection", () => {
  it("无配置变量的技能应返回原内容", () => {
    const skill = makeSkill("simple", "Just a skill");
    const store = new InMemoryConfigStore();
    expect(applyConfigInjection(skill, store)).toBe("Just a skill");
  });

  it("有配置变量和值时应注入配置", () => {
    const skill = makeSkill("wiki", "Wiki content", {
      config: [{ key: "path", description: "Path", default: "/default/wiki" }],
    });
    const store = new InMemoryConfigStore({
      "skills.config.wiki.path": "/custom/wiki",
    });
    const result = applyConfigInjection(skill, store);
    expect(result).toContain("[Skill config]");
    expect(result).toContain("path = /custom/wiki");
  });

  it("有配置变量但无值时应返回原内容", () => {
    const skill = makeSkill("cfg", "Content", {
      config: [{ key: "missing_key", description: "No default, not required" }],
    });
    const store = new InMemoryConfigStore();
    const result = applyConfigInjection(skill, store);
    expect(result).toBe("Content");
  });
});

// ═══════════════════════════════════════════════════════════
// discoverAllConfigVars
// ═══════════════════════════════════════════════════════════

describe("discoverAllConfigVars", () => {
  it("应发现所有技能的配置变量", () => {
    const skills = [
      makeSkill("a", "Content A", {
        config: [{ key: "key1", description: "Key 1" }],
      }),
      makeSkill("b", "Content B", {
        config: [{ key: "key2", description: "Key 2" }],
      }),
      makeSkill("c", "Content C"), // 无配置变量
    ];
    const loader = makeLoader(skills);
    const result = discoverAllConfigVars(loader);
    expect(result.size).toBe(2);
    expect(result.has("a")).toBe(true);
    expect(result.has("b")).toBe(true);
    expect(result.has("c")).toBe(false);
  });

  it("空 loader 应返回空 Map", () => {
    expect(discoverAllConfigVars(makeLoader([])).size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// formatMissingConfigMessage
// ═══════════════════════════════════════════════════════════

describe("formatMissingConfigMessage", () => {
  it("全部配置已设置时应返回空字符串", () => {
    const store = new InMemoryConfigStore({ "skills.config.test.key1": "val" });
    const specs = [{ key: "key1", description: "Key 1" }];
    const msg = formatMissingConfigMessage("test", specs, store);
    expect(msg).toBe("");
  });

  it("有缺失配置时应格式化提示", () => {
    const store = new InMemoryConfigStore();
    const specs = [
      { key: "api_key", description: "API Key", required: true },
      { key: "mode", description: "Mode", defaultValue: "auto" },
    ];
    const msg = formatMissingConfigMessage("my-skill", specs, store);
    expect(msg).toContain("Missing skill config");
    expect(msg).toContain("api_key: API Key");
    expect(msg).toContain("[REQUIRED]");
    // mode 有 defaultValue 所以不算缺失，不应出现在列表中
  });

  it("应包含设置指引", () => {
    const store = new InMemoryConfigStore();
    const specs = [{ key: "x", description: "X var" }];
    const msg = formatMissingConfigMessage("skill-name", specs, store);
    expect(msg).toContain("skills.config.skill-name");
  });
});
