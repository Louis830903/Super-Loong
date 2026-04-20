/**
 * System & Data Tools — utilities, time, math, encoding.
 */

import { z } from "zod";
import { v4 as uuid } from "uuid";
import type { ToolDefinition, ToolResult } from "../types/index.js";

export const getCurrentTimeTool: ToolDefinition = {
  name: "get_current_time",
  description: "Get the current date and time in ISO format and various timezones.",
  parameters: z.object({
    timezone: z.string().default("Asia/Shanghai").describe("IANA timezone name"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { timezone } = params as { timezone: string };
    const now = new Date();
    try {
      const formatted = now.toLocaleString("en-US", { timeZone: timezone });
      return {
        success: true,
        output: `Current time (${timezone}): ${formatted}\nISO: ${now.toISOString()}\nTimestamp: ${now.getTime()}`,
        data: { iso: now.toISOString(), timezone, formatted, timestamp: now.getTime() },
      };
    } catch {
      return {
        success: true,
        output: `Current time (UTC): ${now.toISOString()}\nTimestamp: ${now.getTime()}`,
        data: { iso: now.toISOString(), timestamp: now.getTime() },
      };
    }
  },
};

export const jsonParseTool: ToolDefinition = {
  name: "json_parse",
  description: "Parse, format, or extract data from a JSON string.",
  parameters: z.object({
    input: z.string().describe("JSON string to parse"),
    path: z.string().optional().describe("Optional JSONPath-like selector (e.g., 'data.items[0].name')"),
    pretty: z.boolean().default(true).describe("Whether to pretty-print the output"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { input, path, pretty } = params as { input: string; path?: string; pretty: boolean };
    try {
      let data = JSON.parse(input);
      if (path) {
        const parts = path.split(".").flatMap((p) => {
          const match = p.match(/^(\w+)\[(\d+)\]$/);
          return match ? [match[1], parseInt(match[2])] : [p];
        });
        for (const part of parts) {
          if (data == null) break;
          data = typeof part === "number" ? data[part] : data[part];
        }
      }
      const output = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
      return { success: true, output, data };
    } catch (err: any) {
      return { success: false, output: `JSON parse error: ${err.message}`, error: err.message };
    }
  },
};

export const base64EncodeTool: ToolDefinition = {
  name: "base64_encode",
  description: "Encode or decode data using Base64.",
  parameters: z.object({
    input: z.string().describe("Input string"),
    mode: z.enum(["encode", "decode"]).default("encode"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { input, mode } = params as { input: string; mode: string };
    try {
      const result = mode === "encode"
        ? Buffer.from(input, "utf-8").toString("base64")
        : Buffer.from(input, "base64").toString("utf-8");
      return { success: true, output: result };
    } catch (err: any) {
      return { success: false, output: `Base64 ${mode} error: ${err.message}`, error: err.message };
    }
  },
};

export const calculateTool: ToolDefinition = {
  name: "calculate",
  description: "Evaluate a mathematical expression. Supports basic arithmetic, Math functions, and constants.",
  parameters: z.object({
    expression: z.string().describe("Math expression (e.g., '2 + 3 * 4', 'Math.sqrt(16)', 'Math.PI * 2')"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { expression } = params as { expression: string };
    try {
      // P0-A4: 安全数学计算—用严格的 token 白名单替代有缺陷的正则
      // 允许: 数字(含小数/负数), 运算符(+-*/%), 括号, 空格, 逗号, Math.函数/常量
      const SAFE_MATH_PATTERN = /^[\d+\-*/().%,\s]+(Math\.[a-zA-Z]+[\d+\-*/().%,\s]*)*$/;
      // 先移除所有合法的 Math.xxx token，检查剩余部分是否全是安全字符
      const ALLOWED_MATH_FNS = new Set([
        "Math.abs", "Math.ceil", "Math.floor", "Math.round", "Math.trunc",
        "Math.sqrt", "Math.cbrt", "Math.pow", "Math.log", "Math.log2", "Math.log10",
        "Math.sin", "Math.cos", "Math.tan", "Math.asin", "Math.acos", "Math.atan", "Math.atan2",
        "Math.min", "Math.max", "Math.random", "Math.sign", "Math.exp", "Math.hypot",
        "Math.PI", "Math.E", "Math.LN2", "Math.LN10", "Math.SQRT2",
      ]);

      // 提取所有 Math.xxx token 并验证
      const mathTokens = expression.match(/Math\.[a-zA-Z_][a-zA-Z0-9_]*/g) || [];
      for (const token of mathTokens) {
        if (!ALLOWED_MATH_FNS.has(token)) {
          throw new Error(`Disallowed Math function: ${token}`);
        }
      }

      // 移除 Math.xxx 后，剩余字符只允许数字和运算符
      const stripped = expression.replace(/Math\.[a-zA-Z_][a-zA-Z0-9_]*/g, "");
      if (!/^[\d+\-*/().%,\s]*$/.test(stripped)) {
        throw new Error(`Unsafe characters in expression: ${stripped.replace(/[\d+\-*/().%,\s]/g, "").slice(0, 20)}`);
      }

      const fn = new Function("Math", `"use strict"; return (${expression})`);
      const result = fn(Math);
      if (typeof result !== "number" || !isFinite(result)) {
        return { success: false, output: `Result is not a finite number: ${result}`, error: "Non-finite result" };
      }
      return { success: true, output: `${expression} = ${result}`, data: { result } };
    } catch (err: any) {
      return { success: false, output: `Calculation error: ${err.message}`, error: err.message };
    }
  },
};

export const generateUuidTool: ToolDefinition = {
  name: "generate_uuid",
  description: "Generate a new UUID v4.",
  parameters: z.object({
    count: z.number().default(1).describe("Number of UUIDs to generate (max 10)"),
  }),
  execute: async (params: unknown): Promise<ToolResult> => {
    const { count } = params as { count: number };
    const n = Math.min(count, 10);
    const uuids = Array.from({ length: n }, () => uuid());
    return {
      success: true,
      output: uuids.join("\n"),
      data: { uuids },
    };
  },
};

export const systemDataTools: ToolDefinition[] = [
  getCurrentTimeTool,
  jsonParseTool,
  base64EncodeTool,
  calculateTool,
  generateUuidTool,
];
