#!/usr/bin/env node
/**
 * v3 Task 0a — 敏感文件扫描器（纵深防御第二道）
 *
 * 用途：
 *   1. 扫描 git 索引中已追踪但应被忽略的敏感文件
 *   2. 输出建议的 `git rm --cached` 命令清单（不自动执行，需人工审阅）
 *   3. CI 集成时以非零退出码阻断包含敏感文件的提交
 *
 * 用法：
 *   node scripts/check-sensitive-files.mjs            # 仅检查并报告
 *   node scripts/check-sensitive-files.mjs --ci       # CI 模式：发现即退出 1
 *   node scripts/check-sensitive-files.mjs --apply    # 直接执行 git rm --cached（危险，需 -y）
 *
 * @why 项目历史上可能已经把 .env.production / *.db / vault key 提交进 git，
 *      仅靠 .gitignore 无法清理已追踪文件，必须 git rm --cached 后重新提交。
 *      此脚本不直接破坏，只列清单 + 提示，最大化安全。
 */
import { execSync } from "node:child_process";
import process from "node:process";

const SENSITIVE_PATTERNS = [
  // 环境变量
  /^\.env$/,
  /^\.env\.production$/,
  /^\.env\.staging$/,
  /^\.env\..*\.local$/,
  /^\.env\.local$/,
  // 数据库
  /\.db$/,
  /\.db-wal$/,
  /\.db-shm$/,
  /\.db-journal$/,
  // 凭据 / 证书
  /\.master\.key$/,
  /\.vault\.json$/,
  /^vault\/.+\.(json|key)$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  // IM 网关渠道凭据
  /^services\/im-gateway\/data\/.*\.json$/,
  // 通用 secret 命名
  /(^|\/)secrets?\.(json|yaml|yml|env)$/i,
];

// 白名单：example 模板允许入库
const ALLOWLIST = [/\.example\./, /\.example$/, /^\.env\.example$/];

const args = new Set(process.argv.slice(2));
const isCI = args.has("--ci");
const isApply = args.has("--apply");

function tryGitLsFiles() {
  try {
    return execSync("git ls-files", { encoding: "utf8" })
      .split(/\r?\n/)
      .filter(Boolean);
  } catch (err) {
    console.error("[check-sensitive] 无法读取 git 索引：", err.message);
    console.error("[check-sensitive] 提示：本脚本需要在 git 仓库内运行。");
    process.exit(2);
  }
}

function isSensitive(file) {
  if (ALLOWLIST.some((re) => re.test(file))) return false;
  return SENSITIVE_PATTERNS.some((re) => re.test(file));
}

const tracked = tryGitLsFiles();
const offenders = tracked.filter(isSensitive);

if (offenders.length === 0) {
  console.log("✅ [check-sensitive] git 索引干净，未发现敏感文件。");
  process.exit(0);
}

console.warn(`⚠️  [check-sensitive] 发现 ${offenders.length} 个已追踪的敏感文件：\n`);
for (const f of offenders) console.warn(`   • ${f}`);

console.warn(`\n📋 建议执行（请人工审阅后运行）：`);
console.warn(`   git rm --cached ${offenders.map((f) => `"${f}"`).join(" ")}`);
console.warn(`   git commit -m "[chore] 移除误入库的敏感文件 (v3 Task 0a)"`);
console.warn(`\n🔐 重要：如这些文件中含真实凭据，请同步执行密钥轮换！`);

if (isApply) {
  if (!args.has("-y")) {
    console.error("\n❌ --apply 必须配合 -y 才会真正执行（防误操作）。");
    process.exit(3);
  }
  for (const f of offenders) {
    try {
      execSync(`git rm --cached "${f}"`, { stdio: "inherit" });
    } catch (err) {
      console.error(`[check-sensitive] git rm --cached 失败：${f}`, err.message);
    }
  }
  console.warn("\n✅ 已执行 git rm --cached，请记得提交并轮换泄露的凭据。");
}

if (isCI) process.exit(1);
process.exit(0);
