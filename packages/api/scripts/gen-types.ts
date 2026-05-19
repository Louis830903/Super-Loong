#!/usr/bin/env tsx
/**
 * v3 Task 6 — 生成 TS 客户端类型（openapi.json → web-types/src/generated.ts）
 *
 * @why 把上一步生成的 openapi.json 用 openapi-typescript 转成强类型 TS，
 *       供 @super-agent/web 直接 import 使用，前后端契约同源。
 *       --check 模式用于 CI 漂移闸门：再生成后与已提交版本比对，
 *       如果开发者改了 zod schema 但没跑 gen:types，CI 会失败拦截。
 *
 * 使用：
 *   pnpm --filter @super-agent/api gen:types          # 重新生成
 *   pnpm --filter @super-agent/api gen:types:check    # 漂移检测
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAPI_JSON = resolve(__dirname, "..", "openapi", "openapi.json");
const OUTPUT = resolve(
  __dirname,
  "..",
  "..",
  "web-types",
  "src",
  "generated.ts",
);

const isCheck = process.argv.includes("--check");

/**
 * 自动生成文件头部说明：明确标记此文件为代码生成产物，
 * 任何手工编辑都会被下一次 gen:types 覆盖。
 */
const HEADER = `/* eslint-disable */
/* prettier-ignore */
/**
 * 此文件由 packages/api/scripts/gen-types.ts 自动生成 — 请勿手工修改。
 *
 * 数据源：packages/api/src/schemas/* (zod) → openapi.json → 此文件
 * 重新生成：pnpm gen:types
 * 漂移检测：pnpm gen:types:check（CI 强制闸门）
 */

`;

async function main(): Promise<void> {
  if (!existsSync(OPENAPI_JSON)) {
    console.error(
      `✗ 未找到 ${OPENAPI_JSON}，请先跑 pnpm --filter @super-agent/api gen:openapi`,
    );
    process.exit(1);
  }

  // openapi-typescript v7 需要 URL 或字符串路径；使用 pathToFileURL 处理 Windows 路径
  const ast = await openapiTS(pathToFileURL(OPENAPI_JSON));
  const generated = HEADER + astToString(ast);

  if (isCheck) {
    if (!existsSync(OUTPUT)) {
      console.error(
        `✗ 漂移检测失败：${OUTPUT} 不存在，请先跑 pnpm gen:types 并提交结果。`,
      );
      process.exit(1);
    }
    const current = readFileSync(OUTPUT, "utf8");
    // 用 trim 兼容尾部换行差异，但内部内容必须严格一致
    if (current.trim() !== generated.trim()) {
      console.error(
        "✗ 漂移检测失败：generated.ts 与 zod schema 不同步。\n" +
          "  请跑 `pnpm gen:types` 重新生成并提交结果。",
      );
      process.exit(1);
    }
    console.log(`✓ 漂移检测通过：${OUTPUT} 与 zod schema 一致。`);
    return;
  }

  writeFileSync(OUTPUT, generated, "utf8");
  console.log(`✓ TS 类型已生成：${OUTPUT}`);
  console.log(`  文件大小：${generated.length} bytes`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
