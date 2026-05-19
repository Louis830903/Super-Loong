/**
 * @super-agent/web-types
 *
 * 前后端共享的纯类型与纯运行时常量。
 *
 * ⚠️ 严格约束：
 * - 禁止引入任何 Node-only 依赖（sql.js / pino / fs / better-sqlite3 等），
 *   否则会把后端运行时带进前端 bundle，导致 Next.js 编译失败。
 * - 仅允许放置：纯字面量常量、纯 type/interface、ES 基础运算。
 * - 若需共享带 Node 副作用的类型，请在 @super-agent/core 另行 export。
 *
 * 新增条目前，先评估：
 * 1) 前端是否真的需要？
 * 2) 是否引入了 Node/Browser 专有 API？
 */

// ─── 视频 Crew Agent ID 常量 ──────────────────────────────
// 与 @super-agent/core 的 video-crew-presets.ts 保持单一数据源：
// core 改为从此包 re-export，前端直接 import 即可。
// CTR-P1-01 / CTR-P1-03：消除"前端硬编码字符串 vs 后端常量"的双份维护隐患。
export const VIDEO_AGENT_IDS = {
  WRITER: "video-crew-writer",
  DESIGNER: "video-crew-designer",
  STORYBOARD: "video-crew-storyboard",
  VOICE: "video-crew-voice",
  VIDEO: "video-crew-video",
  EDITOR: "video-crew-editor",
} as const;

/** 视频 Crew Agent ID 联合类型，例如 "video-crew-writer" */
export type VideoAgentId = (typeof VIDEO_AGENT_IDS)[keyof typeof VIDEO_AGENT_IDS];

// ─── API Wire Types（CTR-P1-01：前端 API 契约单一数据源）───
// 所有 interface 从 ./api-types 子模块 re-export，保持此 index.ts 简洁。
export * from "./api-types";

// ─── v3 Task 6 — 自动生成类型（zod schema → openapi.json → generated.ts）───
// 与手写 api-types.ts 共存：
//   - 已生成的 schema 优先用 SchemaOf<"XxxEnvelope"> 强类型访问
//   - 未迁移路由继续走 ./api-types 手写 interface，逐步替换
// 漂移检测由 pnpm gen:types:check 在 CI 强制执行，禁止手工修改 generated.ts。
import type { components } from "./generated";
export type { components, paths, operations, webhooks, $defs } from "./generated";

/** OpenAPI components.schemas 全集类型别名。 */
export type Schemas = components["schemas"];

/** 按名字取出某个 schema 的 TS 类型。例：`SchemaOf<"ApiErrorEnvelope">` */
export type SchemaOf<K extends keyof Schemas> = Schemas[K];

// ─── v3 Task 11 — 错误码字典 + i18n 中文映射 ──────────────────────
export * from "./error-codes";
