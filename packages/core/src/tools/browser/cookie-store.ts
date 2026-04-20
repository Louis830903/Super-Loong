/**
 * Cookie 持久化 — 基于 SQLite 的浏览器 Cookie/Storage 存储
 *
 * 参考 CamoFox UUID5 确定性 Profile：
 * - 基于用户/任务 ID 的确定性存储路径
 * - Cookie 序列化/反序列化
 * - 会话恢复时自动加载
 */

import pino from "pino";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { CookieEntry } from "./types.js";

const logger = pino({ name: "browser-cookie-store" });

/**
 * Cookie 持久化存储。
 *
 * 使用 JSON 文件存储 Cookie（轻量级，不依赖额外 SQLite 实例）。
 * 每个用户/任务 ID 对应一个独立的 Cookie 文件。
 */
export class CookieStore {
  private storeDir: string;

  constructor(storeDir: string) {
    this.storeDir = storeDir;
    if (!existsSync(storeDir)) {
      mkdirSync(storeDir, { recursive: true });
    }
  }

  /**
   * 生成确定性存储路径（参考 CamoFox UUID5 哈希）。
   */
  private getFilePath(profileId: string): string {
    const hash = createHash("sha256").update(profileId).digest("hex").slice(0, 16);
    return join(this.storeDir, `cookies_${hash}.json`);
  }

  /**
   * 保存 Cookie 到持久化存储。
   */
  save(profileId: string, cookies: CookieEntry[]): void {
    const filePath = this.getFilePath(profileId);
    try {
      writeFileSync(filePath, JSON.stringify(cookies, null, 2), "utf-8");
      logger.debug({ profileId, count: cookies.length, path: filePath }, "Cookie 已保存");
    } catch (err) {
      logger.error({ profileId, err }, "Cookie 保存失败");
    }
  }

  /**
   * 从持久化存储加载 Cookie。
   */
  load(profileId: string): CookieEntry[] {
    const filePath = this.getFilePath(profileId);
    try {
      if (!existsSync(filePath)) return [];
      const data = readFileSync(filePath, "utf-8");
      const cookies = JSON.parse(data) as CookieEntry[];
      logger.debug({ profileId, count: cookies.length }, "Cookie 已加载");
      return cookies;
    } catch (err) {
      logger.error({ profileId, err }, "Cookie 加载失败");
      return [];
    }
  }

  /**
   * 清除指定 profile 的 Cookie。
   */
  clear(profileId: string): void {
    const filePath = this.getFilePath(profileId);
    try {
      if (existsSync(filePath)) {
        writeFileSync(filePath, "[]", "utf-8");
      }
    } catch (err) {
      logger.error({ profileId, err }, "Cookie 清除失败");
    }
  }

  /**
   * 检查是否有已保存的 Cookie。
   */
  has(profileId: string): boolean {
    const filePath = this.getFilePath(profileId);
    return existsSync(filePath);
  }
}
