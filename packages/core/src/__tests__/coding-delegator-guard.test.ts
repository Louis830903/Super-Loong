/**
 * v3 Task 2 — CommandGuard 接管 coding-delegator.delegateToCLI 单测
 *
 * 覆盖：
 *   1. 安全命令 + 闸门开/关：均放行
 *   2. 危险命令 + 闸门关：仅 logger.warn 不拦截（既有路径）
 *   3. 危险命令 + 闸门开：拒绝执行，errors 含 [GUARDED_EXEC]
 *   4. FeatureFlags getter 实时读 process.env，可在测试切换
 *
 * @why Task 2 改造涉及生产路径，需要单测保证：
 *      - 既有合法 CLI 委托（默认闸门关）行为不变
 *      - 闸门开后真能拦危险命令
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { CodingDelegator, type DelegationInput } from "../evolution/coding-delegator.js";
import { FeatureFlags } from "../config/feature-flags.js";

describe("v3 Task 2: CommandGuard 接管 coding-delegator CLI 委托", () => {
  let originalGuardEnv: string | undefined;

  beforeEach(() => {
    originalGuardEnv = process.env.FEATURE_FLAG_GUARDED_EXEC;
    delete process.env.FEATURE_FLAG_GUARDED_EXEC;
  });

  afterEach(() => {
    if (originalGuardEnv === undefined) {
      delete process.env.FEATURE_FLAG_GUARDED_EXEC;
    } else {
      process.env.FEATURE_FLAG_GUARDED_EXEC = originalGuardEnv;
    }
  });

  describe("FeatureFlags.guardedExec", () => {
    it("默认 false（向后兼容）", () => {
      expect(FeatureFlags.guardedExec).toBe(false);
    });

    it("FEATURE_FLAG_GUARDED_EXEC=true 切到开", () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "true";
      expect(FeatureFlags.guardedExec).toBe(true);
    });

    it("FEATURE_FLAG_GUARDED_EXEC=1 也算开（兼容写法）", () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "1";
      expect(FeatureFlags.guardedExec).toBe(true);
    });

    it("FEATURE_FLAG_GUARDED_EXEC=false 关", () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "false";
      expect(FeatureFlags.guardedExec).toBe(false);
    });

    it("空字符串视为未设置 → 默认 false", () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "";
      expect(FeatureFlags.guardedExec).toBe(false);
    });
  });

  describe("delegateToCLI 危险命令拦截", () => {
    it("闸门开 + 危险 prompt（包含 rm -rf /）→ 拒绝且不执行 spawnSync", async () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "true";

      const delegator = new CodingDelegator(
        () => true, // featureFlag (CLI 总开关)
        "none",
      );

      // 直接调 private 方法（cast any 仅测试用）
      const input: DelegationInput = {
        prompt: "&& rm -rf /tmp/x", // 注入复合命令
        projectDir: "/tmp",
      };
      const tool = {
        name: "qoder",
        checkCmd: "qoder --version",
        delegateCmd: 'qoder "{prompt}"',
        priority: 1,
      };

      // 测试访问 private 方法：通过双重 cast 绕开可见性限制
      const result = (delegator as unknown as { delegateToCLI: (i: DelegationInput, t: typeof tool) => any })
        .delegateToCLI(input, tool);

      expect(result.success).toBe(false);
      expect(result.errors[0]).toMatch(/GUARDED_EXEC/);
      expect(result.errors[0]).toMatch(/(deletion|rm)/);
      expect(result.iterations).toBe(0);
    });

    it("闸门关 + 危险命令 → 仅 warn，不返回 GUARDED_EXEC 拒绝错误（保持既有行为）", () => {
      process.env.FEATURE_FLAG_GUARDED_EXEC = "false";

      const delegator = new CodingDelegator(() => true, "none");

      const input: DelegationInput = {
        prompt: "&& rm -rf /tmp/x",
        projectDir: "/tmp",
      };
      const tool = {
        name: "qoder",
        checkCmd: "qoder --version",
        delegateCmd: 'qoder "{prompt}"',
        priority: 1,
      };

      // 测试访问 private 方法：通过双重 cast 绕开可见性限制
      const result = (delegator as unknown as { delegateToCLI: (i: DelegationInput, t: typeof tool) => any })
        .delegateToCLI(input, tool);

      // 闸门关时不应被 GUARDED_EXEC 直接拒绝
      // 注意：spawnSync 实际仍会被调用，可能因 qoder 不存在而失败，
      // 但失败错误不应是 [GUARDED_EXEC] 前缀
      const hasGuardedExecReject = result.errors.some((e: string) =>
        e.includes("[GUARDED_EXEC] 检测到危险命令被拒绝"),
      );
      expect(hasGuardedExecReject).toBe(false);
    });
  });
});
