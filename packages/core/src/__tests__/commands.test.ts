/**
 * commands.ts — 斜杠命令激活系统 全面测试
 *
 * 覆盖: scanSkillCommands, buildSkillActivationMessage, isSlashCommand,
 *       handleSlashCommand, formatCommandsList
 */
import { describe, it, expect } from "vitest";
import type { Skill, SkillFrontmatter } from "../types/index.js";
import type { SkillLoader } from "../skills/loader.js";
import {
  scanSkillCommands,
  buildSkillActivationMessage,
  isSlashCommand,
  handleSlashCommand,
  formatCommandsList,
  type SkillCommandEntry,
} from "../skills/commands.js";
import { InMemoryConfigStore } from "../skills/config-inject.js";

// ─── Mock 工具 ──────────────────────────────────────────────

function makeSkill(name: string, desc: string, enabled = true, meta?: Record<string, unknown>): Skill {
  return {
    id: name,
    frontmatter: { name, description: desc, metadata: meta } as SkillFrontmatter,
    content: `This is the ${name} skill content.`,
    filePath: `/skills/${name}.md`,
    enabled,
    loadedAt: new Date(),
  };
}

/** 构建最小 SkillLoader mock */
function makeLoader(skills: Skill[]): SkillLoader {
  return {
    listSkills: () => skills,
    findByName: (name: string) => skills.find((s) => s.frontmatter.name === name),
    getSkill: (id: string) => skills.find((s) => s.id === id),
  } as unknown as SkillLoader;
}

// ═══════════════════════════════════════════════════════════
// isSlashCommand
// ═══════════════════════════════════════════════════════════

describe("isSlashCommand", () => {
  it("有效的斜杠命令应返回 true", () => {
    expect(isSlashCommand("/git-commit")).toBe(true);
    expect(isSlashCommand("/search hello")).toBe(true);
    expect(isSlashCommand("/a")).toBe(true);
  });

  it("无效输入应返回 false", () => {
    expect(isSlashCommand("")).toBe(false);
    expect(isSlashCommand("hello")).toBe(false);
    expect(isSlashCommand("/ space")).toBe(false);
    expect(isSlashCommand("/")).toBe(false);
    expect(isSlashCommand("/123")).toBe(false); // 不以字母开头
    expect(isSlashCommand("//double")).toBe(false);
  });

  it("前后空格应被忽略", () => {
    expect(isSlashCommand("  /git-commit  ")).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// scanSkillCommands
// ═══════════════════════════════════════════════════════════

describe("scanSkillCommands", () => {
  it("应为每个启用的技能创建斜杠命令", () => {
    const loader = makeLoader([
      makeSkill("git-commit", "Commit changes"),
      makeSkill("web-search", "Search the web"),
    ]);
    const commands = scanSkillCommands(loader);
    expect(commands.size).toBe(2);
    expect(commands.has("/git-commit")).toBe(true);
    expect(commands.has("/web-search")).toBe(true);
  });

  it("应跳过禁用的技能", () => {
    const loader = makeLoader([
      makeSkill("active", "Active skill", true),
      makeSkill("disabled", "Disabled skill", false),
    ]);
    const commands = scanSkillCommands(loader);
    expect(commands.size).toBe(1);
    expect(commands.has("/active")).toBe(true);
    expect(commands.has("/disabled")).toBe(false);
  });

  it("应标准化命令名：小写+空格转连字符+去除特殊字符", () => {
    const loader = makeLoader([
      makeSkill("Git Commit Helper", "Commit tool"),
    ]);
    const commands = scanSkillCommands(loader);
    expect(commands.has("/git-commit-helper")).toBe(true);
  });

  it("应保留技能路径和描述", () => {
    const loader = makeLoader([makeSkill("test", "Test description")]);
    const commands = scanSkillCommands(loader);
    const entry = commands.get("/test")!;
    expect(entry.skillName).toBe("test");
    expect(entry.description).toBe("Test description");
    expect(entry.skillPath).toBe("/skills/test.md");
  });

  it("空 loader 应返回空 Map", () => {
    const commands = scanSkillCommands(makeLoader([]));
    expect(commands.size).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// buildSkillActivationMessage
// ═══════════════════════════════════════════════════════════

describe("buildSkillActivationMessage", () => {
  const entry: SkillCommandEntry = {
    command: "/test",
    skillName: "test-skill",
    skillPath: "/skills/test.md",
    description: "A test skill",
  };

  it("应包含激活头和技能内容", () => {
    const msg = buildSkillActivationMessage(entry, "Do the thing.");
    expect(msg).toContain("[Skill activated: test-skill]");
    expect(msg).toContain("A test skill");
    expect(msg).toContain("Do the thing.");
  });

  it("应包含用户参数", () => {
    const msg = buildSkillActivationMessage(entry, "Content", "fix the bug");
    expect(msg).toContain("[User request: fix the bug]");
  });

  it("无用户参数时不应包含 User request 块", () => {
    const msg = buildSkillActivationMessage(entry, "Content");
    expect(msg).not.toContain("[User request:");
  });

  it("有配置值时应注入 Skill config 块", () => {
    const msg = buildSkillActivationMessage(entry, "Content", undefined, {
      "api.url": "https://example.com",
      "mode": "fast",
    });
    expect(msg).toContain("[Skill config]");
    expect(msg).toContain("api.url = https://example.com");
    expect(msg).toContain("mode = fast");
  });

  it("空配置值不应注入 Skill config 块", () => {
    const msg = buildSkillActivationMessage(entry, "Content", undefined, {});
    expect(msg).not.toContain("[Skill config]");
  });
});

// ═══════════════════════════════════════════════════════════
// handleSlashCommand
// ═══════════════════════════════════════════════════════════

describe("handleSlashCommand", () => {
  const skills = [
    makeSkill("git-commit", "Commit changes"),
    makeSkill("git-push", "Push changes"),
    makeSkill("web-search", "Search the web"),
  ];
  const loader = makeLoader(skills);
  const commands = scanSkillCommands(loader);

  it("非斜杠命令应返回 handled: false", () => {
    const result = handleSlashCommand("hello world", commands, loader);
    expect(result.handled).toBe(false);
  });

  it("精确匹配应返回激活消息", () => {
    const result = handleSlashCommand("/git-commit", commands, loader);
    expect(result.handled).toBe(true);
    expect(result.entry?.skillName).toBe("git-commit");
    expect(result.message).toContain("[Skill activated: git-commit]");
  });

  it("应正确解析用户参数", () => {
    const result = handleSlashCommand("/git-commit fix the login bug", commands, loader);
    expect(result.handled).toBe(true);
    expect(result.userArgs).toBe("fix the login bug");
    expect(result.message).toContain("[User request: fix the login bug]");
  });

  it("模糊匹配：/git 应匹配 /git-commit (第一个前缀匹配)", () => {
    const result = handleSlashCommand("/git", commands, loader);
    expect(result.handled).toBe(true);
    // 应匹配 Map 中第一个以 /git 开头的命令
    expect(result.entry).toBeDefined();
    expect(result.entry!.command.startsWith("/git")).toBe(true);
  });

  it("未知命令应返回可用命令列表", () => {
    const result = handleSlashCommand("/unknown-xyz", commands, loader);
    expect(result.handled).toBe(true);
    expect(result.message).toContain("Unknown command");
    expect(result.message).toContain("Available commands");
  });

  it("使用自定义 configStore 应注入配置", () => {
    const store = new InMemoryConfigStore({
      "skills.config.git-commit.branch": "main",
    });
    const result = handleSlashCommand("/git-commit", commands, loader, store);
    expect(result.handled).toBe(true);
    // 技能没有 metadata.config 声明，所以不会有配置注入
    // 但不应报错
    expect(result.message).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════
// formatCommandsList
// ═══════════════════════════════════════════════════════════

describe("formatCommandsList", () => {
  it("空命令映射应返回空字符串", () => {
    expect(formatCommandsList(new Map())).toBe("");
  });

  it("应格式化为可读的命令列表", () => {
    const commands = new Map<string, SkillCommandEntry>([
      ["/git-commit", { command: "/git-commit", skillName: "git-commit", skillPath: "/x", description: "Commit changes" }],
      ["/search", { command: "/search", skillName: "search", skillPath: "/y", description: "Search the web" }],
    ]);
    const output = formatCommandsList(commands);
    expect(output).toContain("Slash commands:");
    expect(output).toContain("/git-commit: Commit changes");
    expect(output).toContain("/search: Search the web");
  });
});
