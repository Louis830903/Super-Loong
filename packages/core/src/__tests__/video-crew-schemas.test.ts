/**
 * T2.9 — video-crew-schemas Vitest 测试
 *
 * 覆盖 3 种漂移形态 + feedback 格式正确性 + JSON 解析失败兜底
 */
import { describe, it, expect } from "vitest";
import {
  ScriptSchema,
  ImagePromptsSchema,
  StoryboardSchema,
  buildGuardrail,
  scriptGuardrail,
  imagePromptsGuardrail,
  storyboardGuardrail,
} from "../collaboration/video-crew-schemas.js";

// ─── 合规数据工厂 ──────────────────────────────────────────

function makeValidScript() {
  return {
    title: "咖啡因的秘密",
    narration_full: "咖啡因是世界上最广泛使用的精神活性物质，每天有数十亿人摄入含咖啡因的饮品。",
    scenes: Array.from({ length: 6 }, (_, i) => ({
      index: i,
      narration_text: `第${i + 1}段旁白内容，描述咖啡因的不同方面`,
      duration_s: 5,
    })),
  };
}

function makeValidImagePrompts() {
  return {
    style_tag: "realistic_photo",
    prompts: Array.from({ length: 6 }, (_, i) => ({
      index: i,
      prompt_en: "A beautiful cup of coffee on a wooden table with morning sunlight",
    })),
  };
}

function makeValidStoryboard() {
  return {
    title: "咖啡因的秘密",
    style_tag: "realistic_photo",
    frames: Array.from({ length: 6 }, (_, i) => ({
      index: i,
      narration_text: `第${i + 1}段旁白`,
      image_prompt: "A steaming cup of coffee in warm lighting",
      duration_s: 5,
    })),
  };
}

// ─── 1. ScriptSchema 测试 ──────────────────────────────────

describe("ScriptSchema", () => {
  it("合规数据通过校验", () => {
    const result = ScriptSchema.safeParse(makeValidScript());
    expect(result.success).toBe(true);
  });

  it("漂移形态 1：缺少必填字段", () => {
    const data = { title: "测试" }; // 缺少 narration_full 和 scenes
    const result = ScriptSchema.safeParse(data);
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("narration_full");
      expect(paths).toContain("scenes");
    }
  });

  it("漂移形态 2：类型错误（duration_s 为字符串）", () => {
    const data = makeValidScript();
    (data.scenes[0] as any).duration_s = "five"; // 应为 number
    const result = ScriptSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("漂移形态 3：段数不对（5 段而非 6 段）", () => {
    const data = makeValidScript();
    data.scenes.pop(); // 5 段
    const result = ScriptSchema.safeParse(data);
    expect(result.success).toBe(false);
    if (!result.success) {
      // Zod .length(6) 对 5 元素数组会报错，错误路径指向 scenes
      expect(result.error.issues.some((i) => i.path.includes("scenes") || i.path[0] === "scenes")).toBe(true);
    }
  });

  it("title 超长被拦截", () => {
    const data = makeValidScript();
    // 确保超过 40 个字符（中文每字算 1 个字符）
    data.title = "这是一个非常非常非常非常非常非常非常非常非常非常非常非常非常长的标题超过四十个字符";
    expect(data.title.length).toBeGreaterThan(40);
    const result = ScriptSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ─── 2. ImagePromptsSchema 测试 ────────────────────────────

describe("ImagePromptsSchema", () => {
  it("合规数据通过校验", () => {
    const result = ImagePromptsSchema.safeParse(makeValidImagePrompts());
    expect(result.success).toBe(true);
  });

  it("prompt_en 过短被拦截", () => {
    const data = makeValidImagePrompts();
    data.prompts[0].prompt_en = "short"; // min 10 chars
    const result = ImagePromptsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("prompts 数量不足被拦截", () => {
    const data = makeValidImagePrompts();
    data.prompts.splice(0, 2); // 只剩 4 个
    const result = ImagePromptsSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ─── 3. StoryboardSchema 测试 ──────────────────────────────

describe("StoryboardSchema", () => {
  it("合规数据通过校验", () => {
    const result = StoryboardSchema.safeParse(makeValidStoryboard());
    expect(result.success).toBe(true);
  });

  it("缺少 style_tag 被拦截", () => {
    const data = makeValidStoryboard();
    delete (data as any).style_tag;
    const result = StoryboardSchema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

// ─── 4. buildGuardrail 适配器测试 ──────────────────────────

describe("buildGuardrail", () => {
  it("合规 JSON 字符串 → valid: true", () => {
    const result = scriptGuardrail(JSON.stringify(makeValidScript()));
    expect(result.valid).toBe(true);
    expect(result.feedback).toBeUndefined();
  });

  it("缺字段 JSON → valid: false + feedback 包含字段路径", () => {
    const result = scriptGuardrail(JSON.stringify({ title: "test" }));
    expect(result.valid).toBe(false);
    expect(result.feedback).toBeDefined();
    expect(result.feedback).toContain("narration_full");
    expect(result.feedback).toContain("scenes");
  });

  it("非 JSON 字符串 → valid: false + feedback 包含解析错误", () => {
    const result = scriptGuardrail("This is not JSON at all");
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("JSON 解析失败");
  });

  it("类型错误 → feedback 精确指向错误路径", () => {
    const data = makeValidScript();
    (data.scenes[2] as any).duration_s = "wrong";
    const result = scriptGuardrail(JSON.stringify(data));
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("scenes.2.duration_s");
  });

  it("段数不对 → feedback 指出数组长度问题", () => {
    const data = makeValidScript();
    data.scenes.pop();
    const result = scriptGuardrail(JSON.stringify(data));
    expect(result.valid).toBe(false);
    expect(result.feedback).toContain("scenes");
  });

  it("imagePromptsGuardrail 工作正常", () => {
    const valid = imagePromptsGuardrail(JSON.stringify(makeValidImagePrompts()));
    expect(valid.valid).toBe(true);

    const invalid = imagePromptsGuardrail(JSON.stringify({ style_tag: "" }));
    expect(invalid.valid).toBe(false);
  });

  it("storyboardGuardrail 工作正常", () => {
    const valid = storyboardGuardrail(JSON.stringify(makeValidStoryboard()));
    expect(valid.valid).toBe(true);
  });
});
