/**
 * Token Proxy — 解析 {{secret:NAME}} 引用，并对输出做凭据脱敏
 *
 * 设计目标："model never sees plaintext credentials"：
 * - Agent 看到的是 `{{secret:OPENAI_KEY}}` 形式的占位符
 * - 工具执行时由 TokenProxy 即时解引用为真实值
 * - 日志/输出回传前由 maskSecrets 把已知凭据值替换成掩码
 *
 * @why 拆分自原 security/sandbox.ts（v3 Task 9 上帝文件拆分）
 */

import pino from "pino";
import { CredentialVault } from "./credential-vault.js";

const logger = pino({ name: "security" });

export class TokenProxy {
  private vault: CredentialVault;
  private static readonly TOKEN_PATTERN = /\{\{secret:([^}]+)\}\}/g;

  constructor(vault: CredentialVault) {
    this.vault = vault;
  }

  /** Check if a string contains token references */
  hasTokens(text: string): boolean {
    return /\{\{secret:([^}]+)\}\}/.test(text);
  }

  /** Resolve all {{secret:NAME}} references in a string */
  resolve(text: string, agentId?: string, toolName?: string): string {
    return text.replace(TokenProxy.TOKEN_PATTERN, (_match, name: string) => {
      const value = this.vault.retrieve(name.trim(), agentId, toolName);
      if (value === null) {
        logger.warn({ name, agentId, toolName }, "Token reference unresolved");
        return `{{secret:${name}:UNRESOLVED}}`;
      }
      return value;
    });
  }

  /** Resolve token references in an object (deep) */
  resolveObject(obj: unknown, agentId?: string, toolName?: string): unknown {
    if (typeof obj === "string") return this.resolve(obj, agentId, toolName);
    if (Array.isArray(obj)) return obj.map((v) => this.resolveObject(v, agentId, toolName));
    if (obj && typeof obj === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(obj)) {
        result[key] = this.resolveObject(value, agentId, toolName);
      }
      return result;
    }
    return obj;
  }

  /** Mask credential values in output (prevent leakage) */
  maskSecrets(text: string): string {
    // 把所有已知凭据值替换为掩码，避免日志/响应回传明文
    let masked = text;
    for (const entry of this.vault.list()) {
      const value = this.vault._retrieveSystem(entry.name);
      if (value) {
        // P2-08: 短密码（≤4 字符）整段掩码
        const maskValue = value.length <= 4
          ? "*".repeat(value.length)
          : "*".repeat(value.length - 4) + value.slice(-4);
        masked = masked.split(value).join(maskValue);
      }
    }
    return masked;
  }
}
