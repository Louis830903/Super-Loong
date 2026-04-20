/**
 * SkillSource — 技能源抽象基类
 *
 * 对标 Hermes SkillSource ABC (tools/skills_hub.py L252-L278)
 * 定义统一的搜索/获取/信任等级接口
 */

import type { TrustLevel } from "../guard.js";

/** 技能元数据（搜索结果条目） */
export interface SkillMeta {
  name: string;
  description: string;
  source: string;
  identifier: string;
  trustLevel: TrustLevel;
  tags?: string[];
  version?: string;
}

/** 技能包（完整可安装的技能内容） */
export interface SkillBundle {
  name: string;
  files: Map<string, string | Uint8Array>;
  source: string;
  identifier: string;
  trustLevel: TrustLevel;
  metadata?: Record<string, unknown>;
}

/**
 * 技能源抽象基类 — 对标 Hermes SkillSource ABC
 *
 * 所有市场源（GitHub/SkillHub/ClawHub/Local）必须实现此接口
 */
export abstract class SkillSource {
  /** 源唯一标识 */
  abstract readonly sourceId: string;

  /** 搜索技能 */
  abstract search(query: string, limit?: number): Promise<SkillMeta[]>;

  /** 获取技能包 */
  abstract fetch(identifier: string): Promise<SkillBundle | null>;

  /** 此源的默认信任等级 */
  abstract trustLevel(): TrustLevel;
}
