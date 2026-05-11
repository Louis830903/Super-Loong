/**
 * SQLite 持久化层共享常量与共享类型（零依赖底座）。
 *
 * 所有需要 Schema 版本号或 better-sqlite3 类型的子模块都从此处 import，
 * 避免产生 client.ts ↔ migrations.ts 等循环依赖。
 *
 * CORE-P1-02 批 1：从原 sqlite.ts L11-12 + L32 抽出。
 * better-sqlite3 迁移：SqlJsDatabase → BetterSqlite3.Database，
 * SqlJsStatic 已移除（不再需要 WASM 静态初始化）。
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import type BetterSqlite3 from "better-sqlite3";

/**
 * SqlJsDatabase 类型别名（宽类型，兼容 SqlJsCompatDB 包装层与 better-sqlite3 原生 Database）。
 * better-sqlite3 迁移后，所有 repo 通过 SqlJsCompatDB wrapper 访问数据库，
 * 但 schema.ts / migrations.ts 直接操作 better-sqlite3 原生 API。
 */
export type SqlJsDatabase = any;

/** 内部使用：better-sqlite3 原生 Database 类型（仅 schema.ts / migrations.ts 消费） */
export type NativeDatabase = BetterSqlite3.Database;

/**
 * Schema 当前版本号（每次新增 migration 必须同步 bump，并在 runMigrations 中新增 migrateVN 调用）。
 * 版本语义：v1 = baseline（initDatabase 内 CREATE TABLE 事务块）；v2..v17 = migrations.ts 内 migrateVN 函数。
 */
export const CURRENT_SCHEMA_VERSION = 17;
