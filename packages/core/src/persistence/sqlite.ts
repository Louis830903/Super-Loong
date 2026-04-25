/**
 * SQLite Persistence Layer —— 门面文件（CORE-P1-02 批 3 完成后的终态）。
 *
 * 全部业务段（SQLiteBackend / FTS / Conversation / Subagent / 各 repo CRUD）
 * 已拆分至 ./sqlite/ 子目录：
 *   批 1 ：基础设施层（logger / constants / schema / migrations / client）
 *   批 2a：无共享状态 CRUD（mcp / skill / security / channel / credential）
 *   批 2b：中等独立块（core-block / audit / config-store / video-job / provider-template）
 *   批 2c：联动块（agent-config / session / cron / collab / maintenance）
 *   批 3 ：核心高耦合四块（memory-backend / fts / conversation / subagent）
 *
 * 上游 25+ 处 `from "../persistence/sqlite.js"` 通过本门面 re-export 继续工作，
 * 保持向后兼容的公开 API。后续所有新增持久化逻辑请直接写入 ./sqlite/ 下的对应 repo。
 */

export * from "./sqlite/index.js";
