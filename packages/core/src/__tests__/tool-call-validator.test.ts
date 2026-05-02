/**
 * tool-call-validator 单元测试
 *
 * 覆盖场景：
 *   1. 全部合法 → valid 长度匹配，invalid 为空
 *   2. 全部破损 → invalid 长度匹配，valid 为空
 *   3. 混合情况 → 正确分拣
 *   4. 真实案例：write_file content 含未转义引号（复现 Qwen 400 场景）
 *   5. 空数组 → 两组都为空
 *   6. reject message 格式校验（含工具名、错误详情、转义提示）
 */
import { describe, it, expect } from "vitest";
import type { LLMToolCall } from "../types/index.js";
import {
  partitionToolCallsByJsonValidity,
  buildInvalidToolCallRejectMessage,
} from "../llm/tool-call-validator.js";

// ─── 测试辅助：构造 tool_call ───────────────────────────────
function mkToolCall(id: string, name: string, argsString: string): LLMToolCall {
  return {
    id,
    type: "function",
    function: { name, arguments: argsString },
  };
}

describe("partitionToolCallsByJsonValidity", () => {
  it("全部合法 → valid 长度匹配，invalid 为空", () => {
    const calls: LLMToolCall[] = [
      mkToolCall("t1", "write_file", '{"path":"/tmp/a.txt","content":"hello"}'),
      mkToolCall("t2", "read_file", '{"path":"/tmp/b.txt"}'),
    ];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(0);
    expect(valid[0].id).toBe("t1");
    expect(valid[1].id).toBe("t2");
  });

  it("全部破损 → invalid 长度匹配，valid 为空", () => {
    const calls: LLMToolCall[] = [
      mkToolCall("t1", "write_file", '{"path":"/tmp/a.txt","content":"bad'),
      mkToolCall("t2", "broken", "not json at all"),
    ];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(2);
    expect(invalid[0].toolCall.id).toBe("t1");
    expect(invalid[0].error).toMatch(/json|unexpected|expected/i);
    expect(invalid[1].toolCall.id).toBe("t2");
  });

  it("混合情况 → 正确分拣 + 保留原顺序", () => {
    const calls: LLMToolCall[] = [
      mkToolCall("t1", "ok", '{"a":1}'),
      mkToolCall("t2", "bad", '{"a":'),
      mkToolCall("t3", "ok2", '{"b":2}'),
      mkToolCall("t4", "bad2", '{"c": "unterminated'),
    ];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(2);
    expect(invalid).toHaveLength(2);
    expect(valid.map((v) => v.id)).toEqual(["t1", "t3"]);
    expect(invalid.map((i) => i.toolCall.id)).toEqual(["t2", "t4"]);
  });

  it("空数组 → 两组都为空", () => {
    const { valid, invalid } = partitionToolCallsByJsonValidity([]);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(0);
  });

  it("真实案例：write_file content 含未转义引号（复现 Qwen 400 场景）", () => {
    // 模拟 Qwen 返回的破损 arguments：content 字段里有未转义的 "
    // 这种字符串在 JSON.parse 时会在引号位置报错
    const brokenArgs =
      '{"path":"script.json","content":"旁白说："咖啡的历史很悠久"。"}';
    const calls: LLMToolCall[] = [mkToolCall("tc-qwen-1", "write_file", brokenArgs)];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(0);
    expect(invalid).toHaveLength(1);
    expect(invalid[0].toolCall.function.name).toBe("write_file");
    expect(invalid[0].error).toBeTruthy();
  });

  it("合法但内容为空对象 {} → 应视为合法", () => {
    const calls: LLMToolCall[] = [mkToolCall("t1", "noop", "{}")];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(1);
    expect(invalid).toHaveLength(0);
  });

  it("arguments 是数字/字符串字面量 → 合法 JSON（JSON.parse 接受）", () => {
    // 虽然工具层后续会拒绝非对象 args，但在 JSON 合法性这一层这是合法的
    const calls: LLMToolCall[] = [
      mkToolCall("t1", "x", "123"),
      mkToolCall("t2", "y", '"hello"'),
      mkToolCall("t3", "z", "null"),
    ];
    const { valid, invalid } = partitionToolCallsByJsonValidity(calls);
    expect(valid).toHaveLength(3);
    expect(invalid).toHaveLength(0);
  });
});

describe("buildInvalidToolCallRejectMessage", () => {
  it("包含 [SYSTEM] 前缀、工具名、错误详情、转义提示", () => {
    const msg = buildInvalidToolCallRejectMessage([
      {
        toolCall: mkToolCall("t1", "write_file", "bad"),
        error: "Unexpected token b in JSON at position 0",
      },
    ]);
    expect(msg).toContain("[SYSTEM]");
    expect(msg).toContain("write_file");
    expect(msg).toContain("Unexpected token b");
    // 转义提示
    expect(msg).toMatch(/转义|escape/);
    expect(msg).toContain("\\n");
  });

  it("多个破损工具 → 全部列出", () => {
    const msg = buildInvalidToolCallRejectMessage([
      { toolCall: mkToolCall("t1", "tool_a", "x"), error: "err A" },
      { toolCall: mkToolCall("t2", "tool_b", "y"), error: "err B" },
    ]);
    expect(msg).toContain("tool_a");
    expect(msg).toContain("tool_b");
    expect(msg).toContain("err A");
    expect(msg).toContain("err B");
  });

  it("空数组 → 仍返回包含转义提示的模板（防御性）", () => {
    const msg = buildInvalidToolCallRejectMessage([]);
    expect(msg).toContain("[SYSTEM]");
    expect(msg).toMatch(/转义|escape/);
  });
});
