/**
 * SQLite 持久化层共享常量与共享类型（零依赖底座）。
 *
 * 所有需要 Schema 版本号或 sql.js 类型的子模块都从此处 import，
 * 避免产生 client.ts ↔ migrations.ts 等循环依赖。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts L11-12 + L32 抽出。
 * 注：SENSITIVE_KEYS / SENSITIVE_SUFFIXES 紧耦合 audit-repo，
 *    留在 audit-repo.ts（批 2b）内就近声明，不搬入本文件。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

/** sql.js Database 类型别名（any，因 sql.js 类型通过模块声明提供） */
export type SqlJsDatabase = any;

/** sql.js 静态命名空间类型 */
export type SqlJsStatic = { Database: new (data?: ArrayLike<number> | Buffer | null) => SqlJsDatabase };

/**
 * Schema 当前版本号（每次新增 migration 必须同步 bump，并在 runMigrations 中新增 migrateVN 调用）。
 * 版本语义：v1 = baseline（initDatabase 内 CREATE TABLE 事务块）；v2..v16 = migrations.ts 内 migrateVN 函数。
 */
export const CURRENT_SCHEMA_VERSION = 16;
