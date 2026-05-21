/**
 * v3 Task 6 — zod schema registry入口（API 契约单一数据源）
 *
 * @why 集中维护所有路由的 zod schema 定义，作为 OpenAPI 文档与 TS 类型生成的
 *       唯一数据源。后续路由迁移时只需在此目录下新增 schema 文件 + register
 *       到 registry，gen:types 链路自动生效。
 *
 * 设计：
 *   - registry 在 registry-singleton.ts 中定义，防止循环依赖
 *   - 每个业务领域一个 file（envelope / channels / collaboration / ...）
 *   - Task 6-C 阶段仅落地基础设施 + envelope；业务路由分批迁移
 *
 * 使用：
 *   import { registry } from "./schemas/index.js";
 *   registry.register("MyType", MyTypeSchema);
 */

// 起 import 副作用：以下模块 import 即触发 registry.register(...) 调用
import "./envelope.js";
import "./channels.js";
import "./gateway.js";
import "./models.js";
import "./agents.js";
import "./voice.js";
import "./cron.js";
import "./files.js";

export { registry } from "./registry-singleton.js";
export * from "./envelope.js";
export * from "./channels.js";
export * from "./gateway.js";
export * from "./models.js";
export * from "./agents.js";
export * from "./voice.js";
export * from "./cron.js";
export * from "./files.js";
