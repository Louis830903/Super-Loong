/**
 * v3 Task 12.5：双轨切换闸门 CI 检查脚本
 *
 * 用途：
 *   1. 扫描 FLAG_SUNSET_PLAN 中所有已过期（超过 sunsetDate）的 flag
 *   2. 对每个过期 flag，在源码仓库中运行 legacyGrep 模式，验证旧路径已被清理
 *   3. 存在逾期未清理的旧路径 → exit(1) 阻断 CI/CD pipeline
 *
 * 运行方式：
 *   npx tsx src/config/sunset-check.ts
 *   # 或集成到 CI：
 *   pnpm run sunset:check
 *
 * 退出码：
 *   0 — 所有闸门合规，无逾期旧路径残留
 *   1 — 检测到逾期旧路径，CI 应阻断
 *   2 — 脚本自身错误（文件系统访问失败等）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as child_process from "node:child_process";
import {
  FLAG_SUNSET_PLAN,
  findOverdueSunsets,
  type FlagSunsetEntry,
} from "../config/feature-flags.js";

// ─── 配置 ────────────────────────────────────────────────────

// 项目根目录：从 core 包上溯到 super-agent 根
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// core/src/config → core/src → core → packages → super-agent
const PROJECT_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

// grep search scope: super-agent/packages (exclude node_modules, dist, .git)
const SEARCH_SCOPE = path.join(PROJECT_ROOT, "packages");

// 14 天内即将过期的 flag 显示警告（非阻断）
const WARN_DAYS = 14;

// ─── 工具函数 ────────────────────────────────────────────────

/** 在指定目录内 grep（使用 ripgrep 或 node fs fallback） */
function grepInDir(pattern: string, dir: string): string[] {
  // 排除目录
  const excludePatterns = [
    "--glob", "!node_modules/**",
    "--glob", "!dist/**",
    "--glob", "!.git/**",
    "--glob", "!*.db",
    "--glob", "!*.db-journal",
    "--glob", "!*.db-wal",
    "--glob", "!*.db-shm",
    "--glob", "!*.test.ts",
    "--glob", "!*__tests__/**",
  ];

  try {
    const result = child_process.execFileSync(
      "rg",
      ["--line-number", "--no-heading", pattern, dir, ...excludePatterns],
      {
        encoding: "utf-8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024, // 4MB
      },
    );
    return result.trim().split("\n").filter(Boolean);
  } catch (err: any) {
    if (err.status === 1) return []; // rg exits 1 = no matches
    if (err.code === "ENOENT") {
      // rg 不可用时回退到 node fs
      return fallbackGrep(pattern, dir);
    }
    console.warn(`[sunset-check] rg failed: ${err.message}`);
    return fallbackGrep(pattern, dir);
  }
}

/** 简单 fs 递归 grep 回退（rg 不可用时） */
function fallbackGrep(pattern: string, dir: string): string[] {
  const results: string[] = [];
  const regex = new RegExp(pattern, "gm");

  function walk(currentDir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (
        entry.isFile() &&
        /\.[tj]sx?$/.test(entry.name) &&
        !entry.name.includes(".test.") &&
        !fullPath.includes("__tests__")
      ) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          const lines = content.split("\n");
          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              // reset lastIndex after test
              regex.lastIndex = 0;
              results.push(`${fullPath}:${i + 1}: ${lines[i].trim()}`);
            }
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return results;
}

/** 计算两个 YYYY-MM-DD 字符串之间的天数差 */
function daysBetween(a: string, b: string): number {
  return Math.ceil(
    (new Date(a).getTime() - new Date(b).getTime()) / 86_400_000,
  );
}

// ─── 主逻辑 ──────────────────────────────────────────────────

async function main(): Promise<number> {
  console.log("=".repeat(60));
  console.log("[sunset-check] v3 Task 12.5 双轨切换闸门扫描");
  console.log(`[sunset-check] 项目根: ${PROJECT_ROOT}`);
  console.log(`[sunset-check] 扫描范围: ${SEARCH_SCOPE}`);
  console.log(`[sunset-check] 日期: ${new Date().toISOString().slice(0, 10)}`);
  console.log("=".repeat(60));

  if (!fs.existsSync(SEARCH_SCOPE)) {
    console.error(`[sunset-check] ERROR: 扫描目录不存在: ${SEARCH_SCOPE}`);
    return 2;
  }

  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // 1. 检查已过期的 flag
  const overdue = findOverdueSunsets(now);

  if (overdue.length > 0) {
    console.log(
      `\n⚠️  发现 ${overdue.length} 个已过期 flag：`,
    );
    for (const e of overdue) {
      console.log(`   - ${e.flag} (过期于 ${e.sunsetDate})`);
    }
  } else {
    console.log("\n✅ 无已过期 flag");
  }

  // 2. 检查即将过期的 flag（14 天内预警）
  const soon = FLAG_SUNSET_PLAN.filter((e) => {
    const days = daysBetween(e.sunsetDate, today);
    return days > 0 && days <= WARN_DAYS;
  });
  if (soon.length > 0) {
    console.log(`\n⚠️  ${WARN_DAYS} 天内即将过期的 flag：`);
    for (const e of soon) {
      const days = daysBetween(e.sunsetDate, today);
      console.log(`   - ${e.flag}: ${e.sunsetDate} (${days} 天后)`);
    }
  }

  // 3. 对每个已过期 flag，运行 legacyGrep
  let violations = 0;

  for (const entry of overdue) {
    if (!entry.legacyGrep) {
      console.log(
        `\nℹ️  ${entry.flag}: 未配置 legacyGrep 模式，跳过扫描`,
      );
      continue;
    }

    console.log(
      `\n🔍 扫描旧路径残留: ${entry.flag} — "${entry.legacyGrep}"`,
    );
    const matches = grepInDir(entry.legacyGrep, SEARCH_SCOPE);

    if (matches.length > 0) {
      console.error(
        `❌ ${entry.flag}: 在 ${matches.length} 处发现逾期旧路径残留！`,
      );
      const shown = matches.slice(0, 10);
      for (const m of shown) {
        console.error(`     ${m}`);
      }
      if (matches.length > 10) {
        console.error(`     ... 及其他 ${matches.length - 10} 处`);
      }
      violations++;
    } else {
      console.log(
        `✅ ${entry.flag}: 旧路径已清理，grep 零残留`,
      );
    }
  }

  // 4. 输出最终判定
  console.log("\n" + "=".repeat(60));

  if (overdue.length === 0) {
    console.log("[sunset-check] ✅ PASS — 无逾期 flag，所有闸门未过期");
  }

  if (violations > 0) {
    console.error(
      `[sunset-check] ❌ FAIL — ${violations} 个 flag 存在逾期旧路径残留，CI 应阻断`,
    );
    return 1;
  }

  // 显示全部闸门状态一览
  console.log("\n📊 全部闸门状态一览：");
  for (const entry of FLAG_SUNSET_PLAN) {
    const days = daysBetween(entry.sunsetDate, today);
    const status =
      days < 0
        ? "🔴 已过期"
        : days <= WARN_DAYS
          ? "🟡 即将过期"
          : "🟢 正常";
    console.log(
      `   ${status} ${entry.flag.padEnd(30)} ${entry.sunsetDate} (${days > 0 ? days + "天后" : "已过" + Math.abs(days) + "天"}) [${entry.description.slice(0, 40)}]`,
    );
  }

  console.log(`\n[sunset-check] ✅ PASS`);
  return 0;
}

main()
  .then((exitCode) => {
    process.exit(exitCode);
  })
  .catch((err) => {
    console.error("[sunset-check] 脚本异常:", err);
    process.exit(2);
  });
