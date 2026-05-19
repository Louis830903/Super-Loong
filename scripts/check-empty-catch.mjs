#!/usr/bin/env node
/**
 * v3 Task 5 — 空 catch 守卫（增量 lint 替代方案）
 *
 * 用途：
 *   扫描所有 TypeScript / JavaScript 源码，禁止出现完全空的 catch 块：
 *     - } catch {}  /  } catch (e) {}  /  } catch (_: unknown) {}
 *   带注释或带语句的 catch 不报错，例如：
 *     - } catch { // DB 还没初始化 }                ✅
 *     - } catch (err) { logger.debug(...) }         ✅
 *     - } catch (e: unknown) { // @why ... }        ✅
 *
 * 设计原则（V3 计划 §13.5 - 异常处理规范）：
 *   1. swallow 必须有 @why 注释或语句体（哪怕只是 logger.debug）
 *   2. 增量守卫：只阻止新增的空 catch，存量带注释 catch 保持兼容
 *   3. 零依赖：不引入 ESLint 全量改造，仅一个 50 行 Node 脚本
 *
 * 用法：
 *   node scripts/check-empty-catch.mjs           # 全量扫描，发现即退出 1
 *   node scripts/check-empty-catch.mjs --staged  # 只扫 git staged 文件（pre-commit hook 用）
 *
 * @why V3 修复中已把全仓库 11 处空 catch 全部改造为带 logger.debug + @why 注释，
 *      此脚本守住"零空 catch"红线，避免后续提交回滚。
 */
import { execSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, relative, sep, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import process from "node:process";

// 跨平台 ROOT 计算：Windows 上 new URL(...).pathname 会返回 /D:/... 需用 fileURLToPath
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname); // scripts/ 的上一级即 super-agent/
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  ".git",
  "out",
  ".turbo",
  // Python 虚拟环境（services/im-gateway / services/video-forge 内嵌）
  ".venv",
  "venv",
  "__pycache__",
  "site-packages",
  // Vite/Next 打包产物
  ".vite",
  "public",
]);
const TARGET_EXT = /\.(ts|mts|cts|tsx|js|mjs|cjs|jsx)$/;
// 跳过：压缩产物、本身脚本（注释里的 `catch {}` 示例不算违规）
const SKIP_FILE_RE = /(\.min\.(?:js|mjs|cjs)$)|(check-empty-catch\.mjs$)/;

// 完全空的 catch（无注释、无语句体）：
//   } catch {} / } catch (...) {} / } catch (...) {\n} / } catch {\n   \n}
// 容错：花括号内仅空白字符
const EMPTY_CATCH_RE = /catch\s*(?:\([^)]*\))?\s*\{\s*\}/g;

/** 返回相对路径列表 */
function listFiles(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      listFiles(full, acc);
    } else if (TARGET_EXT.test(name) && !SKIP_FILE_RE.test(name)) {
      acc.push(full);
    }
  }
  return acc;
}

/** 仅扫描 git staged 文件 */
function listStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      cwd: ROOT,
      encoding: "utf8",
    });
    return out.split("\n")
      .filter(Boolean)
      .filter((p) => TARGET_EXT.test(p))
      .map((p) => join(ROOT, p));
  } catch (err) {
    console.error("[check-empty-catch] git diff 失败：", err.message);
    process.exit(2);
  }
}

const args = process.argv.slice(2);
const stagedOnly = args.includes("--staged");

const files = stagedOnly ? listStagedFiles() : listFiles(ROOT);
const violations = [];

for (const f of files) {
  let content;
  try { content = readFileSync(f, "utf8"); } catch { continue; }
  const matches = content.matchAll(EMPTY_CATCH_RE);
  for (const m of matches) {
    const idx = m.index ?? 0;
    const line = content.slice(0, idx).split("\n").length;
    const rel = relative(ROOT, f).replaceAll(sep, "/");
    violations.push({ file: rel, line, snippet: m[0] });
  }
}

if (violations.length > 0) {
  console.error("\n❌ 发现完全空的 catch 块（v3 Task 5 红线）：\n");
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}  →  ${v.snippet}`);
  }
  console.error(`\n共 ${violations.length} 处违规。`);
  console.error("修复方法：");
  console.error("  1. 加 logger.debug({...}, '...')；或");
  console.error("  2. 加 @why 注释说明为什么吞错（仅注释也算合规）。\n");
  process.exit(1);
}

if (!stagedOnly) {
  console.log(`✅ 已扫描 ${files.length} 个文件，未发现空 catch。`);
}
process.exit(0);
