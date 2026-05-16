/**
 * A2A 消息签名与校验 — HMAC-SHA256 防篡改
 *
 * 向后兼容设计：
 * - 旧客户端不传 timestamp/nonce/signature 字段 → 降级为无签名模式（仅日志警告）
 * - 新客户端必传这三个字段 → 服务端校验时间窗口(±5min)和签名一致性
 *
 * 签名流程：
 * 1. 生成 timestamp (ms) + nonce (UUID)
 * 2. payload = JSON.stringify(message 去除 signature 字段)
 * 3. signature = HMAC-SHA256(payload, secret)
 *
 * 校验流程：
 * 1. 检查 timestamp 是否在 ±5min 窗口内
 * 2. 用相同 payload + secret 计算 HMAC，对比 signature
 *
 * @see a2a-types.ts — A2AMessage 接口
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { A2AMessage } from "./a2a-types.js";

/** 签名时间窗口（毫秒），默认 ±5 分钟 */
const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** 从 A2AMessage 中提取 payload 用于签名（排除 signature 字段避免循环依赖） */
export function messagePayload(message: A2AMessage & { timestamp?: number; nonce?: string; signature?: string }): string {
  const { signature: _, timestamp: __, nonce: ___, ...rest } = message as any;
  // 用稳定序列化（按 key 排序）
  return JSON.stringify(rest, Object.keys(rest).sort());
}

/**
 * 对 A2A 消息生成 HMAC-SHA256 签名并注入 timestamp/nonce/signature 字段。
 * 修改原 message 对象，无返回值。
 */
export function signA2AMessage(
  message: A2AMessage & { timestamp?: number; nonce?: string; signature?: string },
  secret: string,
): void {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const payload = messagePayload(message);
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  message.timestamp = timestamp;
  message.nonce = nonce;
  message.signature = signature;
}

/**
 * 校验 A2A 消息的 HMAC-SHA256 签名。
 *
 * @returns 校验结果：{ valid: boolean, reason?: string }
 *   - valid=true: 签名通过或消息未携带签名字段（降级模式）
 *   - valid=false: 签名校验失败（应拒绝请求）
 */
export function verifyA2AMessage(
  message: A2AMessage & { timestamp?: number; nonce?: string; signature?: string },
  secret: string,
): { valid: boolean; reason?: string; degraded: boolean } {
  // 向后兼容：未携带签名字段 → 降级为无签名模式
  if (message.timestamp === undefined || message.signature === undefined) {
    return { valid: true, degraded: true, reason: "消息未携带签名（旧客户端），降级为无签名模式" };
  }

  if (message.nonce === undefined) {
    return { valid: false, degraded: false, reason: "签名消息缺少 nonce 字段" };
  }

  // 时间窗口校验（±5 分钟）
  const now = Date.now();
  if (Math.abs(now - message.timestamp) > SIGNATURE_WINDOW_MS) {
    return { valid: false, degraded: false, reason: `消息时间戳超出窗口（差 ${Math.round(Math.abs(now - message.timestamp) / 1000)} 秒）` };
  }

  // HMAC 签名一致性校验
  const expectedSignature = createHmac("sha256", secret)
    .update(messagePayload({ ...message, signature: undefined } as any))
    .digest("hex");

  const sigBuf = Buffer.from(message.signature, "hex");
  const expectedBuf = Buffer.from(expectedSignature, "hex");

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    return { valid: false, degraded: false, reason: "消息签名不一致（可能被篡改）" };
  }

  return { valid: true, degraded: false };
}
