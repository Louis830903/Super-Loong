/**
 * SQLite 持久化层共享 logger 实例（零依赖底座）。
 *
 * 所有 persistence/sqlite/* 子模块必须从此处 import logger，
 * 避免在每个文件重新 `pino()` 初始化导致实例不一致。
 * CORE-P1-02 批 1：从原 sqlite.ts L28 抽出为独立模块。
 */
import pino from "pino";

export const logger = pino({ name: "sqlite" });
