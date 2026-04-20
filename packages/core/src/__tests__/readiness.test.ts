/**
 * readiness.ts — 技能就绪状态机 全面测试
 *
 * 覆盖: evaluateReadiness, collectMissingSecrets, selectPreferredInstall, formatReadinessMessage
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Skill, SkillFrontmatter } from "../types/index.js";
import {
  evaluateReadiness,
  collectMissingSecrets,
  selectPreferredInstall,
  formatReadinessMessage,
  SkillReadinessStatus,
  type SecretSpec,
  type SkillInstallOption,
  type SkillReadinessResult,
} from "../skills/readiness.js";

// ─── 测试工具 ──────────────────────────────────────────────

/** 构建最小 Skill mock 对象 */
function makeSkill(fm: Partial<SkillFrontmatter> & { name: string; description: string }): Skill {
  return {
    id: fm.name,
    frontmatter: { ...fm } as SkillFrontmatter,
    content: "Test content",
    filePath: `/test/${fm.name}.md`,
    enabled: true,
    loadedAt: new Date(),
  };
}

// ═══════════════════════════════════════════════════════════
// evaluateReadiness
// ═══════════════════════════════════════════════════════════

describe("evaluateReadiness", () => {
  // 保存和恢复环境变量
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedEnv.TEST_API_KEY = process.env.TEST_API_KEY;
    savedEnv.MY_SECRET = process.env.MY_SECRET;
    savedEnv.SOME_TOKEN = process.env.SOME_TOKEN;
  });

  afterEach(() => {
    // 恢复环境变量
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("无依赖的技能应返回 AVAILABLE", () => {
    const skill = makeSkill({ name: "hello", description: "Hi" });
    const result = evaluateReadiness(skill);
    expect(result.status).toBe(SkillReadinessStatus.AVAILABLE);
    expect(result.missingEnvVars).toHaveLength(0);
    expect(result.missingBins).toHaveLength(0);
  });

  it("平台不支持时应返回 UNSUPPORTED", () => {
    const skill = makeSkill({
      name: "mac-only",
      description: "Mac skill",
      platforms: ["macos"],
    });
    // 在 Windows 上 currentPlatform = "windows"，应不匹配 "macos"
    // 但在 CI/macOS 上可能匹配，所以用一个完全不存在的平台名测试
    const skill2 = makeSkill({
      name: "alien-os",
      description: "alien",
      platforms: ["alienOS"],
    });
    const result = evaluateReadiness(skill2);
    expect(result.status).toBe(SkillReadinessStatus.UNSUPPORTED);
    expect(result.setupHelp).toContain("alienOS");
  });

  it("缺少环境变量时应返回 SETUP_NEEDED", () => {
    delete process.env.TEST_API_KEY;
    const skill = makeSkill({
      name: "api-skill",
      description: "Uses API",
      prerequisites: { envVars: ["TEST_API_KEY"] },
    });
    const result = evaluateReadiness(skill);
    expect(result.status).toBe(SkillReadinessStatus.SETUP_NEEDED);
    expect(result.missingEnvVars).toContain("TEST_API_KEY");
  });

  it("环境变量已设置时不应报告缺失", () => {
    process.env.TEST_API_KEY = "test-value";
    const skill = makeSkill({
      name: "api-skill",
      description: "Uses API",
      prerequisites: { envVars: ["TEST_API_KEY"] },
    });
    const result = evaluateReadiness(skill);
    expect(result.missingEnvVars).not.toContain("TEST_API_KEY");
  });

  it("缺少命令时应添加到 missingBins", () => {
    const skill = makeSkill({
      name: "tool-skill",
      description: "Needs tool",
      prerequisites: { commands: ["__nonexistent_binary_xyz__"] },
    });
    const result = evaluateReadiness(skill);
    expect(result.missingBins).toContain("__nonexistent_binary_xyz__");
    expect(result.status).toBe(SkillReadinessStatus.SETUP_NEEDED);
  });

  it("已安装的命令不应报告为缺失 (node 应该可用)", () => {
    const skill = makeSkill({
      name: "node-skill",
      description: "Needs node",
      prerequisites: { commands: ["node"] },
    });
    const result = evaluateReadiness(skill);
    expect(result.missingBins).not.toContain("node");
  });

  it("应处理 metadata.requires.bins 和 env", () => {
    delete process.env.SOME_TOKEN;
    const skill = makeSkill({
      name: "extended",
      description: "Extended requires",
      metadata: {
        requires: {
          bins: ["__nonexistent_cli__"],
          env: ["SOME_TOKEN"],
          config: ["api_url"],
        },
      },
    } as any);
    const result = evaluateReadiness(skill);
    expect(result.missingBins).toContain("__nonexistent_cli__");
    expect(result.missingEnvVars).toContain("SOME_TOKEN");
    expect(result.missingConfig).toContain("api_url");
  });

  it("应处理 setup.collect_secrets", () => {
    delete process.env.MY_SECRET;
    const skill = makeSkill({
      name: "secret-skill",
      description: "Needs secrets",
      metadata: {
        setup: {
          collect_secrets: [
            { env_var: "MY_SECRET", prompt: "Enter your secret", provider_url: "https://example.com", secret: true },
          ],
          help: "Visit example.com to get your secret",
        },
      },
    } as any);
    const result = evaluateReadiness(skill);
    expect(result.missingEnvVars).toContain("MY_SECRET");
    expect(result.secretSpecs.length).toBeGreaterThan(0);
    const spec = result.secretSpecs.find((s) => s.envVar === "MY_SECRET");
    expect(spec).toBeDefined();
    expect(spec!.prompt).toBe("Enter your secret");
    expect(spec!.providerUrl).toBe("https://example.com");
    expect(result.setupHelp).toBe("Visit example.com to get your secret");
  });

  it("应解析 install 选项", () => {
    const skill = makeSkill({
      name: "installable",
      description: "Has install options",
      metadata: {
        install: [
          { kind: "node", label: "npm install foo", bins: ["foo"] },
          { kind: "brew", label: "brew install foo", bins: ["foo"] },
        ],
      },
    } as any);
    const result = evaluateReadiness(skill);
    expect(result.installOptions).toHaveLength(2);
    expect(result.installOptions[0].kind).toBe("node");
    expect(result.installOptions[1].kind).toBe("brew");
  });

  it("缺失密钥应自动关联 secret 属性", () => {
    delete process.env.TEST_API_KEY;
    const skill = makeSkill({
      name: "key-skill",
      description: "Uses key",
      prerequisites: { envVars: ["TEST_API_KEY"] },
    });
    const result = evaluateReadiness(skill);
    const spec = result.secretSpecs.find((s) => s.envVar === "TEST_API_KEY");
    expect(spec).toBeDefined();
    // "key" 在环境变量名中 → secret = true
    expect(spec!.secret).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// collectMissingSecrets
// ═══════════════════════════════════════════════════════════

describe("collectMissingSecrets", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    originalEnv.__TEST_SECRET_A = process.env.__TEST_SECRET_A;
    originalEnv.__TEST_SECRET_B = process.env.__TEST_SECRET_B;
    delete process.env.__TEST_SECRET_A;
    delete process.env.__TEST_SECRET_B;
  });

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("应收集所有缺失的密钥", async () => {
    const specs: SecretSpec[] = [
      { envVar: "__TEST_SECRET_A", prompt: "Enter A", secret: true },
      { envVar: "__TEST_SECRET_B", prompt: "Enter B", secret: false },
    ];
    const callback = vi.fn()
      .mockResolvedValueOnce("value-a")
      .mockResolvedValueOnce("value-b");

    const collected = await collectMissingSecrets(specs, callback);
    expect(collected.__TEST_SECRET_A).toBe("value-a");
    expect(collected.__TEST_SECRET_B).toBe("value-b");
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it("callback 返回 null 时应跳过该密钥", async () => {
    const specs: SecretSpec[] = [
      { envVar: "__TEST_SECRET_A", prompt: "Enter A", secret: true },
    ];
    const callback = vi.fn().mockResolvedValue(null);
    const collected = await collectMissingSecrets(specs, callback);
    expect(Object.keys(collected)).toHaveLength(0);
  });

  it("已存在于环境中的变量应跳过", async () => {
    process.env.__TEST_SECRET_A = "existing";
    const specs: SecretSpec[] = [
      { envVar: "__TEST_SECRET_A", prompt: "Enter A", secret: true },
    ];
    const callback = vi.fn();
    await collectMissingSecrets(specs, callback);
    expect(callback).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// selectPreferredInstall
// ═══════════════════════════════════════════════════════════

describe("selectPreferredInstall", () => {
  it("空数组应返回 undefined", () => {
    expect(selectPreferredInstall([])).toBeUndefined();
  });

  it("应优先选择 uv", () => {
    const options: SkillInstallOption[] = [
      { id: "1", kind: "node", label: "npm", bins: [] },
      { id: "2", kind: "uv", label: "uv pip", bins: [] },
      { id: "3", kind: "go", label: "go install", bins: [] },
    ];
    const preferred = selectPreferredInstall(options);
    expect(preferred?.kind).toBe("uv");
  });

  it("无 uv 时应选择 node", () => {
    const options: SkillInstallOption[] = [
      { id: "1", kind: "go", label: "go install", bins: [] },
      { id: "2", kind: "node", label: "npm", bins: [] },
    ];
    const preferred = selectPreferredInstall(options);
    expect(preferred?.kind).toBe("node");
  });

  it("只有 download 时应返回 download", () => {
    const options: SkillInstallOption[] = [
      { id: "1", kind: "download", label: "Download binary", bins: [] },
    ];
    expect(selectPreferredInstall(options)?.kind).toBe("download");
  });
});

// ═══════════════════════════════════════════════════════════
// formatReadinessMessage
// ═══════════════════════════════════════════════════════════

describe("formatReadinessMessage", () => {
  it("AVAILABLE 应返回空字符串", () => {
    const result: SkillReadinessResult = {
      status: SkillReadinessStatus.AVAILABLE,
      missingEnvVars: [],
      missingBins: [],
      missingConfig: [],
      secretSpecs: [],
      installOptions: [],
    };
    expect(formatReadinessMessage(result)).toBe("");
  });

  it("UNSUPPORTED 应包含平台信息", () => {
    const result: SkillReadinessResult = {
      status: SkillReadinessStatus.UNSUPPORTED,
      missingEnvVars: [],
      missingBins: [],
      missingConfig: [],
      secretSpecs: [],
      installOptions: [],
      setupHelp: "Only supports: macos",
    };
    const msg = formatReadinessMessage(result);
    expect(msg).toContain("UNSUPPORTED");
    expect(msg).toContain("macos");
  });

  it("SETUP_NEEDED 应列出缺失项", () => {
    const result: SkillReadinessResult = {
      status: SkillReadinessStatus.SETUP_NEEDED,
      missingEnvVars: ["API_KEY"],
      missingBins: ["python3"],
      missingConfig: [],
      secretSpecs: [
        { envVar: "API_KEY", prompt: "Enter your key", providerUrl: "https://api.example.com", secret: true },
      ],
      installOptions: [],
      setupHelp: "Install Python and set API_KEY",
    };
    const msg = formatReadinessMessage(result);
    expect(msg).toContain("SETUP NEEDED");
    expect(msg).toContain("API_KEY");
    expect(msg).toContain("python3");
    expect(msg).toContain("https://api.example.com");
    expect(msg).toContain("Help:");
  });

  it("有 installOptions 时应显示推荐安装方式", () => {
    const result: SkillReadinessResult = {
      status: SkillReadinessStatus.SETUP_NEEDED,
      missingEnvVars: ["X"],
      missingBins: [],
      missingConfig: [],
      secretSpecs: [],
      installOptions: [
        { id: "1", kind: "node", label: "npm install foo", bins: ["foo"] },
      ],
    };
    const msg = formatReadinessMessage(result);
    expect(msg).toContain("Recommended install");
    expect(msg).toContain("npm install foo");
  });
});
