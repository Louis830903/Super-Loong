/**
 * v3 Task 1 — sql-safe.ts 白名单单测
 * 覆盖：合法标识符、首字符非字母数字、含分号/单引号、过长、批量校验
 */
import { describe, it, expect } from "vitest";
import {
  SAFE_IDENT_RE,
  assertSafeIdentifier,
  safeIdent,
  assertSafeIdentifiers,
} from "../persistence/sqlite/sql-safe.js";

describe("v3 Task 1: SQL identifier whitelist", () => {
  describe("SAFE_IDENT_RE", () => {
    it.each([
      ["users"],
      ["user_id"],
      ["_internal"],
      ["t1"],
      ["a".repeat(64)],
      ["v20_old"],
      ["credentials_v18"],
    ])("接受合法标识符：%s", (name) => {
      expect(SAFE_IDENT_RE.test(name)).toBe(true);
    });

    it.each([
      [""],
      ["1users"],          // 数字开头
      ["users;"],          // 分号
      ["users--"],         // SQL 注释
      ["users'"],          // 单引号
      ['users"'],          // 双引号
      ["DROP TABLE x"],    // 空格
      ["users.name"],      // 点
      ["users-name"],      // 连字符
      ["a".repeat(65)],    // 超长
      [" users"],          // 前导空格
      ["你好"],             // 非 ASCII
    ])("拒绝非法标识符：%s", (name) => {
      expect(SAFE_IDENT_RE.test(name)).toBe(false);
    });
  });

  describe("assertSafeIdentifier", () => {
    it("合法返回原值", () => {
      expect(assertSafeIdentifier("video_jobs", "table")).toBe("video_jobs");
    });

    it("非法抛错（含上下文）", () => {
      expect(() => assertSafeIdentifier("users; DROP TABLE x", "table")).toThrow(
        /Unsafe SQL table/,
      );
    });

    it("空字符串抛错", () => {
      expect(() => assertSafeIdentifier("", "column")).toThrow();
    });

    it("非字符串抛错", () => {
      // @ts-expect-error 故意传非法类型测试运行时校验
      expect(() => assertSafeIdentifier(123, "table")).toThrow();
    });
  });

  describe("safeIdent (alias)", () => {
    it("行为与 assertSafeIdentifier 一致", () => {
      expect(safeIdent("kb_chunks")).toBe("kb_chunks");
      expect(() => safeIdent("'; DROP--")).toThrow();
    });
  });

  describe("assertSafeIdentifiers (batch)", () => {
    it("全部合法返回副本", () => {
      const r = assertSafeIdentifiers(["a", "b", "c_1"], "column");
      expect(r).toEqual(["a", "b", "c_1"]);
    });

    it("含非法时一次性抛汇总错误", () => {
      expect(() =>
        assertSafeIdentifiers(["a", "1bad", "c;d"], "column"),
      ).toThrow(/Unsafe SQL columns.*"1bad".*"c;d"/);
    });
  });
});
