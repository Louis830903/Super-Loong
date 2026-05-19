/**
 * v3 Task 1 — SQL 标识符白名单（P0 安全加固）
 *
 * 背景：
 *   migrations.ts / *-repo.ts 中存在多处 `${col}`、`${table}` 字符串拼接。
 *   虽然当前来源都是常量数组或 SQLite PRAGMA 内置返回值（受信），
 *   但缺少防御层。一旦后续有人误把外部输入接进去，即埋下 SQL 注入炸弹。
 *
 * 设计：
 *   - assertSafeIdentifier：白名单正则 + 抛错，强制所有动态标识符过一遍
 *   - safeIdent：糖装版，返回原值便于嵌入模板字符串
 *   - SAFE_IDENT_RE：仅允许 [A-Za-z_][A-Za-z0-9_]{0,63}，匹配 SQLite 标准
 *
 * 使用：
 *   import { assertSafeIdentifier, safeIdent } from './sql-safe.js';
 *   db.run(`ALTER TABLE ${safeIdent(tableName)} RENAME TO ${safeIdent(oldName)}`);
 *
 * @why 即使内部常量调用，也走一遍白名单，保留升级时夹带外部输入的防御网。
 *      生产升级前需 dump 真实 schema 全部表/列名喂正则验证，避免老库炸。
 */

/**
 * SQLite 标识符白名单正则。
 * - 起始：字母或下划线
 * - 后续：字母、数字、下划线
 * - 最大 64 字符（保守上限）
 *
 * @why SQLite 允许多种引用标识符（双引号/反引号/[]），不同方言造成转义不一致；
 *       进一步限制为有序字符集后，可直接嵌入模板字符串而不需转义。
 */
export const SAFE_IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * 校验 SQL 标识符（表名 / 列名 / 索引名）是否安全。
 *
 * @param name - 待校验的标识符
 * @param ctx - 上下文（出错时打印用，例如 'table' / 'column'）
 * @returns 原 name（便于链式调用）
 * @throws 不匹配白名单时抛错
 *
 * @why 抹除以后调用者误传外部输入进模板拼接的 SQL 注入炸弹；外炸优于隐性失败。
 */
export function assertSafeIdentifier(name: string, ctx = "identifier"): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error(`[sql-safe] ${ctx} must be non-empty string, got: ${typeof name}`);
  }
  if (!SAFE_IDENT_RE.test(name)) {
    throw new Error(
      `[sql-safe] Unsafe SQL ${ctx}: ${JSON.stringify(name)} (allowed: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/)`,
    );
  }
  return name;
}

/**
 * 糖装版：assertSafeIdentifier 的别名，便于嵌入模板字符串。
 *
 * @example
 *   db.run(`ALTER TABLE ${safeIdent(t)} RENAME TO ${safeIdent(t + '_old')}`);
 *
 * @why 源码可读性优先：在 SQL 模板中调用名越短越容易随手加，降低遗漏概率。
 */
export function safeIdent(name: string, ctx = "identifier"): string {
  return assertSafeIdentifier(name, ctx);
}

/**
 * 批量校验：将一组标识符（如多列名）一次性走白名单。
 * 对失败项汇总报错，便于一次定位。
 *
 * @why 迁移场景常需一次校验几十个列名，逐个抛错会让调用者体验碎片化。
 */
export function assertSafeIdentifiers(names: readonly string[], ctx = "identifier"): string[] {
  const failures: string[] = [];
  for (const n of names) {
    if (typeof n !== "string" || !SAFE_IDENT_RE.test(n)) failures.push(JSON.stringify(n));
  }
  if (failures.length > 0) {
    throw new Error(
      `[sql-safe] Unsafe SQL ${ctx}s: ${failures.join(", ")} (allowed: /^[A-Za-z_][A-Za-z0-9_]{0,63}$/)`,
    );
  }
  return [...names];
}
