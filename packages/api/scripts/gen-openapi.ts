#!/usr/bin/env tsx
/**
 * v3 Task 6 — 生成 OpenAPI 3.1 文档（zod schema → openapi.json）
 *
 * @why 把 packages/api/src/schemas/* 的 zod 注册表导出为 OpenAPI JSON，
 *       作为 openapi-typescript 生成 TS 类型的中间产物，
 *       同时也是 API 契约对外发布的单一数据源。
 *
 * 使用：pnpm --filter @super-agent/api gen:openapi
 * 输出：packages/api/openapi/openapi.json
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { OpenApiGeneratorV31 } from "@asteasolutions/zod-to-openapi";

// 注意：tsx 运行时支持 .js 后缀映射到源码 .ts
import { registry } from "../src/schemas/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT = resolve(__dirname, "..", "openapi", "openapi.json");

const generator = new OpenApiGeneratorV31(registry.definitions);

const document = generator.generateDocument({
  openapi: "3.1.0",
  info: {
    title: "Super Agent API",
    version: "0.1.0",
    description:
      "Super Agent monorepo API 契约（v3 Task 6 — zod schema 单一数据源自动生成，请勿手工修改）",
  },
  servers: [{ url: "http://localhost:3001", description: "本地开发" }],
});

mkdirSync(dirname(OUTPUT), { recursive: true });
writeFileSync(OUTPUT, JSON.stringify(document, null, 2) + "\n", "utf8");

const schemaCount = Object.keys(document.components?.schemas ?? {}).length;
const pathCount = Object.keys(document.paths ?? {}).length;

console.log(`✓ OpenAPI 文档已生成：${OUTPUT}`);
console.log(`  components.schemas: ${schemaCount}`);
console.log(`  paths: ${pathCount}`);
