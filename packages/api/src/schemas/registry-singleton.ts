/**
 * v3 Task 6 — OpenAPI registry 单例
 *
 * @why 拆出独立文件避免 envelope.ts ↔ index.ts 循环依赖；envelope.ts 在被
 *       index.ts re-export 时也需要访问 registry 做注册。
 */

import { OpenAPIRegistry } from "@asteasolutions/zod-to-openapi";

/**
 * 全局共享的 OpenAPI registry。
 *
 * @why 单例让所有 schema 文件共享同一注册表，gen-openapi 脚本一处 import
 *       即可拿到全部声明。
 */
export const registry = new OpenAPIRegistry();
