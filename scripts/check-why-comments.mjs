/**
 * v3 Task 5.6 — 关键导出 @why 注释守卫
 *
 * 设计原因：
 *   完整接入 eslint-plugin-jsdoc 需要给整个 monorepo 配 ESLint，体量大；
 *   实操中"必须有 @why"的强需求只覆盖 v3 修复落地的关键模块。本脚本走与
 *   check-empty-catch.mjs 同款轻量守卫思路：
 *     - 维护一份 ALLOWLIST（v3 关键模块）
 *     - 对每个 `export function | const | interface | type | class` 上方
 *       JSDoc 块进行扫描，未出现 `@why` 标签则视为违规
 *     - 退出码 1 阻断 CI；本地可加 --fix-suggest 输出建议位置
 *
 * 命令：
 *   node ./scripts/check-why-comments.mjs           # 扫 ALLOWLIST 全量
 *   node ./scripts/check-why-comments.mjs --staged  # 仅扫 git add 的 ALLOWLIST 文件
 *
 * @why 给所有 v3 改造的关键导出强制标记设计动机，便于 reviewers 一眼识别
 *       "为什么这样写"，避免后续 refactor 误删保护层。
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(__dirname);

/**
 * v3 关键模块 allowlist（相对仓库根的 POSIX 风格路径）。
 * 新增 v3 落地文件请同步加进来；不在清单内的文件不会被扫描。
 */
const ALLOWLIST = [
  // Task 1：SQL 标识符白名单
  "packages/core/src/persistence/sqlite/sql-safe.ts",
  // Task 2：CommandGuard + FeatureFlags 闸门
  "packages/core/src/security/command-guard.ts",
  "packages/core/src/config/feature-flags.ts",
  // Task 3：响应壳
  "packages/api/src/routes/response-helper.ts",
  "packages/api/src/middleware/response-envelope.ts",
  // Task 4：IM 网关 HMAC 鉴权
  "packages/api/src/middleware/internal-auth.ts",
  // Task 5：空 catch 清理（脚本本身）
  "scripts/check-empty-catch.mjs",
  // Task 5.5：凭据 fail-fast
  "packages/core/src/security/credential-vault.ts",
  // Task 5.6：@why 注释守卫（本脚本）
  "scripts/check-why-comments.mjs",
  // Task 10：LLM 语义缓存
  "packages/core/src/llm/cache.ts",
  // Task 11：错误码字典
  "packages/web-types/src/error-codes.ts",
  // Task 12：API 鉴权收口
  "packages/api/src/auth/index.ts",
  // Task 12.5：双轨切换闸门（已在 Task 2 的 feature-flags.ts）
  // Task 6：zod → OpenAPI schema 模块（v3 T6）
  "packages/api/src/schemas/models.ts",
  "packages/api/src/schemas/agents.ts",
  "packages/api/src/schemas/voice.ts",
  "packages/api/src/schemas/cron.ts",
  "packages/api/src/schemas/files.ts",
  // Task 7：OpenTelemetry 基础设施（v3 T7）
  "packages/core/src/telemetry/instrumentation.ts",
];

/** 提取所有"`export <kind> <name>` + 上方 JSDoc"匹配 */
function extractExports(src) {
  // 匹配 JSDoc 块（含或不含）+ export 声明
  // 兼容 export function / async function / const / interface / type / class
  const re =
    /(\/\*\*[\s\S]*?\*\/\s*)?^export\s+(?:async\s+)?(function|const|let|interface|type|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({
      jsdoc: m[1] ?? "",
      kind: m[2],
      name: m[3],
      line: src.slice(0, m.index).split("\n").length,
    });
  }
  return out;
}

function getStagedFiles() {
  try {
    const out = execSync("git diff --cached --name-only --diff-filter=ACMR", {
      cwd: ROOT,
      encoding: "utf8",
    });
    return new Set(out.split("\n").filter(Boolean));
  } catch {
    return new Set();
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const stagedOnly = args.has("--staged");
  const fixSuggest = args.has("--fix-suggest");

  const stagedFiles = stagedOnly ? getStagedFiles() : null;

  let totalScanned = 0;
  let totalExports = 0;
  const violations = [];

  for (const rel of ALLOWLIST) {
    if (stagedFiles && !stagedFiles.has(rel)) continue;
    const abs = join(ROOT, ...rel.split("/"));
    let src;
    try {
      src = readFileSync(abs, "utf8");
    } catch (err) {
      console.warn(`[skip] ${rel}: ${err.message}`);
      continue;
    }
    totalScanned++;

    const exports = extractExports(src);
    totalExports += exports.length;

    for (const e of exports) {
      if (!/@why\b/.test(e.jsdoc)) {
        violations.push({
          file: rel,
          line: e.line,
          name: e.name,
          kind: e.kind,
          hasJsdoc: e.jsdoc.length > 0,
        });
      }
    }
  }

  if (violations.length === 0) {
    console.log(
      `[check-why-comments] OK — scanned ${totalScanned} file(s), ${totalExports} export(s).`,
    );
    process.exit(0);
  }

  console.error(
    `[check-why-comments] FAIL — ${violations.length} export(s) missing @why tag:\n`,
  );
  for (const v of violations) {
    const tag = v.hasJsdoc ? "needs @why" : "no JSDoc";
    console.error(`  ${v.file}:${v.line}  export ${v.kind} ${v.name}  (${tag})`);
  }
  if (fixSuggest) {
    console.error(
      "\nSuggested fix: prepend each export with a JSDoc block ending with `@why <one-line reason>`.\n",
    );
  }
  process.exit(1);
}

main();
