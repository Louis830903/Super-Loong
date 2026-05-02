/**
 * bootstrap.findMonorepoRoot — monorepo 根目录定位函数单元测试
 *
 * 背景：
 *   bootstrap.ts 在源码位置（packages/core/src/runtime/）与打包后位置
 *   （packages/core/dist/）层级不同，tsup 扁平化会让硬编码"上 N 级"推断越位。
 *   本模块基于标识文件（默认 pnpm-workspace.yaml）向上查找，两种场景都能找对根。
 *
 * 测试矩阵：
 *   1. 标识文件恰好在起点目录 → 返回起点自身
 *   2. 多层子目录 → 向上找到含标识文件的父目录
 *   3. 深层嵌套（5 级）→ 仍可定位，模拟打包后的实际路径
 *   4. 未找到标识文件 → 返回 null
 *   5. 到达文件系统根不会无限循环
 *   6. 自定义标识文件数组 → 按顺序第一个命中即返回
 *   7. 真实工作区验证：从 packages/core/src/runtime 向上找到 super-agent
 *
 * 覆盖：findMonorepoRoot 的正常路径、边界条件、兜底行为。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findMonorepoRoot } from "../runtime/bootstrap.js";

// ─── 测试工具 ──────────────────────────────────────────────

/**
 * 在系统临时目录下创建一个隔离的目录树：
 *   <tmp>/monorepo-root-test-<random>/
 *     ├── pnpm-workspace.yaml    ← 可选：若 withMarker=true
 *     └── packages/
 *         └── core/
 *             └── src/
 *                 └── runtime/
 *
 * 返回 { rootDir, leafDir }，测试结束前由 afterEach 删除。
 */
function buildTempMonorepo(withMarker: boolean): { rootDir: string; leafDir: string } {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "monorepo-root-test-"));
  const leafDir = path.join(rootDir, "packages", "core", "src", "runtime");
  fs.mkdirSync(leafDir, { recursive: true });
  if (withMarker) {
    fs.writeFileSync(path.join(rootDir, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n");
  }
  return { rootDir, leafDir };
}

// ═══════════════════════════════════════════════════════════
// findMonorepoRoot
// ═══════════════════════════════════════════════════════════

describe("findMonorepoRoot", () => {
  let createdDirs: string[] = [];

  beforeEach(() => {
    createdDirs = [];
  });

  afterEach(() => {
    // 清理本轮用例创建的所有临时目录
    for (const dir of createdDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // 忽略清理失败（Windows 文件锁等），不影响后续用例
      }
    }
  });

  /** 便捷包装：建好临时 monorepo 并自动登记清理列表 */
  function buildAndTrack(withMarker: boolean): { rootDir: string; leafDir: string } {
    const ret = buildTempMonorepo(withMarker);
    createdDirs.push(ret.rootDir);
    return ret;
  }

  // ── 场景 1：起点就是 monorepo 根 ──
  it("起点目录自身含标识文件时应直接返回该目录", () => {
    const { rootDir } = buildAndTrack(true);
    const result = findMonorepoRoot(rootDir);
    // 用 realpath 消除 Windows 下 `C:\Users\...\Temp` 与 `C:\Users\...\AppData\Local\Temp` 等软链差异
    expect(fs.realpathSync(result!)).toBe(fs.realpathSync(rootDir));
  });

  // ── 场景 2：从子目录向上查找 ──
  it("从一级子目录应能向上找到 monorepo 根", () => {
    const { rootDir } = buildAndTrack(true);
    const subDir = path.join(rootDir, "packages");
    const result = findMonorepoRoot(subDir);
    expect(fs.realpathSync(result!)).toBe(fs.realpathSync(rootDir));
  });

  // ── 场景 3：深层嵌套（模拟打包后 packages/core/dist 场景的上游等价） ──
  it("从深层叶子目录（4-5 级）应能定位到 monorepo 根", () => {
    const { rootDir, leafDir } = buildAndTrack(true);
    // leafDir = <root>/packages/core/src/runtime  （4 级）
    const result = findMonorepoRoot(leafDir);
    expect(fs.realpathSync(result!)).toBe(fs.realpathSync(rootDir));
  });

  // ── 场景 4：目录树中不存在标识文件 → null ──
  it("目录树中不存在标识文件时应返回 null", () => {
    const { leafDir } = buildAndTrack(false); // 不放 marker
    // 注意：向上一直到临时目录根都没有 pnpm-workspace.yaml；
    // 再往上是系统 tmp 或用户目录，几乎不可能有此文件（极端场景见场景 5 断言策略）。
    const result = findMonorepoRoot(leafDir, ["___super_unlikely_marker_file___.xxx"]);
    expect(result).toBeNull();
  });

  // ── 场景 5：到达文件系统根不会死循环 ──
  it("到达文件系统根时应优雅返回，不会无限循环", () => {
    // 选一个几乎绝无可能存在自定义 marker 的起点：系统根 / 或 盘符根
    const fsRoot = path.parse(process.cwd()).root; // Windows: "D:\\"；POSIX: "/"
    // 用极端不可能的文件名，确保一路找不到
    const start = Date.now();
    const result = findMonorepoRoot(fsRoot, ["___nonexistent_marker_xxx___"]);
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    // 即便 10 级循环，每次 existsSync + dirname 都非常快，应在 1s 内返回
    expect(elapsed).toBeLessThan(1000);
  });

  // ── 场景 6：自定义标识文件数组 ──
  it("支持自定义 markers 数组，按顺序第一个命中即返回", () => {
    const { rootDir, leafDir } = buildAndTrack(false);
    // 放一个非默认的 marker
    fs.writeFileSync(path.join(rootDir, "my-custom-root.marker"), "");

    // 默认 marker 找不到
    const defaultResult = findMonorepoRoot(leafDir);
    expect(defaultResult).toBeNull();

    // 自定义 marker 可以找到
    const customResult = findMonorepoRoot(leafDir, ["my-custom-root.marker"]);
    expect(fs.realpathSync(customResult!)).toBe(fs.realpathSync(rootDir));

    // 多个 marker 时，优先命中的仍然是存在的那个
    const multiResult = findMonorepoRoot(leafDir, [
      "not-exists-first.marker",
      "my-custom-root.marker",
    ]);
    expect(fs.realpathSync(multiResult!)).toBe(fs.realpathSync(rootDir));
  });

  // ── 场景 7：真实工作区验证 ──
  // 核心目的：证明本修复对真实 super-agent 仓库也生效。
  // 从测试文件自身位置（packages/core/src/__tests__）向上查找，必须命中 super-agent 根。
  it("从本测试文件位置应能定位到真实的 super-agent monorepo 根", () => {
    // 测试文件在 packages/core/src/__tests__/ 下；
    // super-agent 根含 pnpm-workspace.yaml
    const startDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/i, "$1"));
    const decoded = decodeURIComponent(startDir);
    const result = findMonorepoRoot(decoded);
    expect(result).not.toBeNull();
    // 结果应以 "super-agent" 结尾（跨平台兼容，直接比路径末段）
    expect(path.basename(result!)).toBe("super-agent");
    // 且该目录下确实存在 pnpm-workspace.yaml
    expect(fs.existsSync(path.join(result!, "pnpm-workspace.yaml"))).toBe(true);
  });
});
