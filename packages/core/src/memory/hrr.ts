/**
 * Holographic Reduced Representations (HRR) — 相位编码向量符号架构
 *
 * 移植自 Hermes Agent holographic.py，TypeScript 实现保持跨语言互操作性。
 * 核心概念：每个原子概念用 [0, 2π) 范围的相位向量表示，三种代数操作：
 *   bind   — 圆卷积（逐元素相位加法）  — 关联两个概念
 *   unbind — 圆相关（逐元素相位减法）  — 从记忆中提取关联值
 *   bundle — 超叠加（复指数圆均值）    — 合并多个概念
 *
 * 原子向量通过 SHA-256 确定性生成，跨进程/跨机器/跨语言结果一致。
 * 零外部依赖（不需要 numpy / 千问 API / 任何向量数据库）。
 *
 * References:
 *   Plate (1995) — Holographic Reduced Representations
 *   Gayler (2004) — Vector Symbolic Architectures answer Jackendoff's challenges
 */

import { createHash } from "node:crypto";

// ─── 核心常量 ───────────────────────────────────────────────

export const TWO_PI = 2.0 * Math.PI;
export const DEFAULT_DIM = 1024;

/** 相位向量类型：Float64Array，每个元素在 [0, 2π) 范围 */
export type PhaseVector = Float64Array;

// 角色原子（与 Hermes 保持一致的保留字符串）
const ROLE_CONTENT_KEY = "__hrr_role_content__";
const ROLE_ENTITY_KEY = "__hrr_role_entity__";

// 缓存已编码的角色原子，避免重复计算 SHA-256
let _cachedRoleContent: PhaseVector | null = null;
let _cachedRoleEntity: PhaseVector | null = null;
let _cachedDim = 0;

function getRoleContent(dim: number): PhaseVector {
  if (_cachedRoleContent && _cachedDim === dim) return _cachedRoleContent;
  _cachedDim = dim;
  _cachedRoleContent = encodeAtom(ROLE_CONTENT_KEY, dim);
  _cachedRoleEntity = encodeAtom(ROLE_ENTITY_KEY, dim);
  return _cachedRoleContent;
}

function getRoleEntity(dim: number): PhaseVector {
  if (_cachedRoleEntity && _cachedDim === dim) return _cachedRoleEntity;
  getRoleContent(dim); // 同时缓存两个
  return _cachedRoleEntity!;
}

// ─── 核心操作 ───────────────────────────────────────────────

/**
 * 确定性相位向量编码 — 与 Hermes encode_atom 完全对齐。
 *
 * 算法：
 *   1. 对 f"{word}:{i}" (i=0,1,2...) 分别做 SHA-256
 *   2. 每个 32 字节 digest 解析为 16 个 uint16 (little-endian)
 *   3. 拼接所有 uint16，截取前 dim 个
 *   4. 缩放到 [0, 2π)：phase = value * (2π / 65536)
 */
export function encodeAtom(word: string, dim: number = DEFAULT_DIM): PhaseVector {
  const valuesPerBlock = 16; // 每个 SHA-256 digest = 32 bytes = 16 uint16
  const blocksNeeded = Math.ceil(dim / valuesPerBlock);

  const uint16Values: number[] = [];
  for (let i = 0; i < blocksNeeded; i++) {
    const digest = createHash("sha256").update(`${word}:${i}`).digest();
    // 按 little-endian 解析为 uint16，与 Python struct.unpack("<16H", digest) 对齐
    for (let j = 0; j < 32; j += 2) {
      uint16Values.push(digest[j] | (digest[j + 1] << 8));
    }
  }

  const phases = new Float64Array(dim);
  const scale = TWO_PI / 65536.0;
  for (let i = 0; i < dim; i++) {
    phases[i] = uint16Values[i] * scale;
  }
  return phases;
}

/**
 * 圆卷积（绑定）— 逐元素相位加法。
 * 将两个概念关联为一个复合向量，结果与两个输入都准正交。
 */
export function bind(a: PhaseVector, b: PhaseVector): PhaseVector {
  const result = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    result[i] = (a[i] + b[i]) % TWO_PI;
  }
  return result;
}

/**
 * 圆相关（解绑）— 逐元素相位减法。
 * 从记忆向量中提取与 key 关联的值：unbind(bind(a, b), a) ≈ b
 */
export function unbind(memory: PhaseVector, key: PhaseVector): PhaseVector {
  const result = new Float64Array(memory.length);
  for (let i = 0; i < memory.length; i++) {
    result[i] = ((memory[i] - key[i]) % TWO_PI + TWO_PI) % TWO_PI;
  }
  return result;
}

/**
 * 超叠加（捆绑）— 复指数圆均值。
 * 合并多个向量为一个，结果与每个输入都相似。
 * 容量约 O(sqrt(dim)) 个条目后相似度开始退化。
 */
export function bundle(...vectors: PhaseVector[]): PhaseVector {
  if (vectors.length === 0) {
    throw new Error("bundle() requires at least one vector");
  }
  if (vectors.length === 1) return new Float64Array(vectors[0]);

  const dim = vectors[0].length;
  const result = new Float64Array(dim);

  for (let i = 0; i < dim; i++) {
    let sumReal = 0;
    let sumImag = 0;
    for (const v of vectors) {
      sumReal += Math.cos(v[i]);
      sumImag += Math.sin(v[i]);
    }
    // atan2 返回 [-π, π]，mod TWO_PI 映射到 [0, 2π)
    result[i] = (Math.atan2(sumImag, sumReal) % TWO_PI + TWO_PI) % TWO_PI;
  }
  return result;
}

/**
 * 相位余弦相似度。范围 [-1, 1]。
 * 同一向量 → 1.0，无关向量 → ≈0.0，反相关 → -1.0
 */
export function similarity(a: PhaseVector, b: PhaseVector): number {
  if (a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.cos(a[i] - b[i]);
  }
  return sum / a.length;
}

// ─── 文本编码 ───────────────────────────────────────────────

/**
 * 词袋编码：对文本分词后，每个 token 编码为 atom，再 bundle 所有 atom。
 * 与 Hermes encode_text 保持一致的分词和标点剥离策略。
 */
export function encodeText(text: string, dim: number = DEFAULT_DIM): PhaseVector {
  const tokens = text
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/^[.,!?;:"'()\[\]{}]+|[.,!?;:"'()\[\]{}]+$/g, ""))
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return encodeAtom("__hrr_empty__", dim);
  }

  const atomVectors = tokens.map((token) => encodeAtom(token, dim));
  return bundle(...atomVectors);
}

/**
 * 结构化编码：内容绑定到 ROLE_CONTENT，每个实体绑定到 ROLE_ENTITY，全部 bundle。
 *
 * 这种编码方式支持代数提取：
 *   unbind(fact, bind(entity, ROLE_ENTITY)) ≈ content_vector
 *
 * 与 Hermes encode_fact 完全对齐。
 */
export function encodeFact(
  content: string,
  entities: string[],
  dim: number = DEFAULT_DIM,
): PhaseVector {
  const roleContent = getRoleContent(dim);
  const roleEntity = getRoleEntity(dim);

  // 第一个 component：内容文本绑定角色
  const components: PhaseVector[] = [bind(encodeText(content, dim), roleContent)];

  // 每个实体：原子绑定实体角色
  for (const entity of entities) {
    components.push(bind(encodeAtom(entity.toLowerCase(), dim), roleEntity));
  }

  return bundle(...components);
}

// ─── 序列化 ─────────────────────────────────────────────────

/** 将相位向量序列化为 Buffer（Float64，dim=1024 时 8KB） */
export function phasesToBuffer(phases: PhaseVector): Buffer {
  return Buffer.from(phases.buffer, phases.byteOffset, phases.byteLength);
}

/** 从 Buffer 反序列化为相位向量 */
export function bufferToPhases(buf: Buffer): PhaseVector {
  // 复制一份以确保可变性（Buffer 可能是只读视图）
  const copy = new Float64Array(buf.byteLength / 8);
  const view = new Float64Array(buf.buffer, buf.byteOffset, buf.byteLength / 8);
  copy.set(view);
  return copy;
}

/** number[] ↔ PhaseVector 互转（兼容 MemoryEntry.embedding 的 number[] 格式） */
export function fromNumberArray(arr: number[]): PhaseVector {
  return Float64Array.from(arr);
}

export function toNumberArray(phases: PhaseVector): number[] {
  return Array.from(phases);
}

// ─── SNR 估计 ───────────────────────────────────────────────

/**
 * 全息存储信噪比估计。
 * SNR = sqrt(dim / n_items)，n_items > dim/4 时检索可能出错。
 */
export function snrEstimate(dim: number, nItems: number): number {
  if (nItems <= 0) return Infinity;

  const snr = Math.sqrt(dim / nItems);

  if (snr < 2.0) {
    console.warn(
      `[HRR] Storage near capacity: SNR=${snr.toFixed(2)} (dim=${dim}, n_items=${nItems}). ` +
        `Retrieval accuracy may degrade. Consider increasing dim or reducing stored items.`,
    );
  }

  return snr;
}
