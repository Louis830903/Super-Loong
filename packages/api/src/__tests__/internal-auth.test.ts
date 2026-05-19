/**
 * v3 Task 4：IM 网关 INTERNAL_TOKEN + HMAC 双侧鉴权 — 单元测试
 *
 * 测试矩阵：
 *   1. flag off → 仅旧 x-api-key（向后兼容）
 *   2. flag on + 凭据齐全 → 完整签名头（X-Internal-Token / X-Timestamp / X-Signature）
 *   3. flag on + 凭据缺 + fallback=true → 仅 token（开发期），不 throw
 *   4. flag on + 凭据缺 + fallback=false → loadInternalCredentials 启动 throw
 *   5. Canonical 字符串与签名算法与 Python hmac 严格一致（位级对照）
 *   6. verifyInboundSignature：通过 / 时间戳过期 / 签名错误 / 缺头
 *   7. body 对签名敏感（改一字节 → 验签失败）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash, createHmac } from "node:crypto";
import {
  signedGatewayHeaders,
  buildCanonicalString,
  hmacSign,
  sha256Hex,
  verifyInboundSignature,
  reloadInternalCredentialsForTest,
  TIMESTAMP_TOLERANCE_MS,
} from "../middleware/internal-auth.js";

const ENV_KEYS = [
  "FEATURE_FLAG_INTERNAL_AUTH",
  "VAULT_ALLOW_ENV_FALLBACK",
  "INTERNAL_TOKEN",
  "INTERNAL_HMAC_SECRET",
  "IM_GATEWAY_API_KEY",
];

function clearEnv() {
  for (const k of ENV_KEYS) delete process.env[k];
  reloadInternalCredentialsForTest();
}

describe("v3 Task 4: internal-auth (HMAC 双侧鉴权)", () => {
  beforeEach(clearEnv);
  afterEach(clearEnv);

  describe("Canonical 与算法一致性", () => {
    it("buildCanonicalString 严格按 METHOD\\nPATH\\nTS\\nSHA256(BODY) 拼接", () => {
      const ts = "1700000000000";
      const bodyHex = sha256Hex(JSON.stringify({ a: 1 }));
      const c = buildCanonicalString("post", "/internal/deliver", ts, bodyHex);
      expect(c).toBe(`POST\n/internal/deliver\n${ts}\n${bodyHex}`);
    });

    it("空 body 的 SHA256 与空串等价（与 Python hashlib.sha256(b'') 一致）", () => {
      // Python 侧：hashlib.sha256(b'').hexdigest() == 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
      expect(sha256Hex("")).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      expect(sha256Hex(undefined)).toBe(sha256Hex(""));
      expect(sha256Hex(null)).toBe(sha256Hex(""));
    });

    it("hmacSign 与原生 createHmac 行为等价", () => {
      const secret = "my-secret-for-test-123";
      const canonical = "GET\n/api/gateway/health\n1700000000000\nabc";
      const expected = createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
      expect(hmacSign(secret, canonical)).toBe(expected);
    });
  });

  describe("signedGatewayHeaders — flag off 兼容路径", () => {
    it("flag 未启用时只回退 x-api-key，不附签名头", () => {
      process.env.IM_GATEWAY_API_KEY = "legacy-key-xyz";
      reloadInternalCredentialsForTest();
      const h = signedGatewayHeaders("POST", "/api/gateway/x", "{}");
      expect(h["x-api-key"]).toBe("legacy-key-xyz");
      expect(h["x-internal-token"]).toBeUndefined();
      expect(h["x-signature"]).toBeUndefined();
      expect(h["x-timestamp"]).toBeUndefined();
    });

    it("flag 未启用且无 IM_GATEWAY_API_KEY 时仅返回 Content-Type", () => {
      const h = signedGatewayHeaders("GET", "/api/gateway/health");
      expect(h["Content-Type"]).toBe("application/json");
      expect(Object.keys(h)).toEqual(["Content-Type"]);
    });
  });

  describe("signedGatewayHeaders — flag on 签名生成", () => {
    beforeEach(() => {
      process.env.FEATURE_FLAG_INTERNAL_AUTH = "true";
      process.env.VAULT_ALLOW_ENV_FALLBACK = "true";
      process.env.INTERNAL_TOKEN = "tok-" + "a".repeat(60);
      process.env.INTERNAL_HMAC_SECRET = "sec-" + "b".repeat(60);
      reloadInternalCredentialsForTest();
    });

    it("生成完整 X-Internal-Token / X-Timestamp / X-Signature 三件套", () => {
      const body = JSON.stringify({ chat_id: "c1", text: "hello" });
      const before = Date.now();
      const h = signedGatewayHeaders("POST", "/internal/deliver", body);
      const after = Date.now();

      expect(h["x-internal-token"]).toBe(process.env.INTERNAL_TOKEN);
      expect(h["x-timestamp"]).toBeDefined();
      expect(h["x-signature"]).toMatch(/^[0-9a-f]{64}$/);

      const ts = Number(h["x-timestamp"]);
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);

      // 签名必须与重算结果一致（与 Python 侧验证逻辑同款）
      const bodyHex = createHash("sha256").update(body, "utf8").digest("hex");
      const canonical = `POST\n/internal/deliver\n${h["x-timestamp"]}\n${bodyHex}`;
      const expected = createHmac("sha256", process.env.INTERNAL_HMAC_SECRET!)
        .update(canonical, "utf8")
        .digest("hex");
      expect(h["x-signature"]).toBe(expected);
    });

    it("body 改一个字节 → 签名完全不同（防篡改）", () => {
      const h1 = signedGatewayHeaders("POST", "/x", JSON.stringify({ a: 1 }));
      const h2 = signedGatewayHeaders("POST", "/x", JSON.stringify({ a: 2 }));
      expect(h1["x-signature"]).not.toBe(h2["x-signature"]);
    });

    it("path 不同 → 签名不同（防替换路径）", () => {
      const h1 = signedGatewayHeaders("POST", "/internal/deliver", "{}");
      const h2 = signedGatewayHeaders("POST", "/internal/admin", "{}");
      expect(h1["x-signature"]).not.toBe(h2["x-signature"]);
    });

    it("method 不同 → 签名不同", () => {
      const h1 = signedGatewayHeaders("POST", "/x", "{}");
      const h2 = signedGatewayHeaders("PUT", "/x", "{}");
      expect(h1["x-signature"]).not.toBe(h2["x-signature"]);
    });

    it("升级期同时携带旧 x-api-key 兼容头", () => {
      process.env.IM_GATEWAY_API_KEY = "legacy-key";
      reloadInternalCredentialsForTest();
      const h = signedGatewayHeaders("POST", "/x", "{}");
      expect(h["x-api-key"]).toBe("legacy-key");
      expect(h["x-internal-token"]).toBeDefined();
    });
  });

  describe("凭据加载策略", () => {
    it("flag on + fallback=false + 凭据缺失 → throw（生产 fail-fast）", () => {
      process.env.FEATURE_FLAG_INTERNAL_AUTH = "true";
      process.env.VAULT_ALLOW_ENV_FALLBACK = "false";
      reloadInternalCredentialsForTest();
      expect(() => signedGatewayHeaders("POST", "/x", "{}")).toThrow(/INTERNAL_TOKEN|VAULT_ALLOW_ENV_FALLBACK|Vault/);
    });

    it("flag on + fallback=true + 凭据缺失 → 不 throw，仅返回 Content-Type", () => {
      process.env.FEATURE_FLAG_INTERNAL_AUTH = "true";
      process.env.VAULT_ALLOW_ENV_FALLBACK = "true";
      reloadInternalCredentialsForTest();
      const h = signedGatewayHeaders("POST", "/x", "{}");
      expect(h["x-signature"]).toBeUndefined();
      expect(h["x-internal-token"]).toBeUndefined();
    });
  });

  describe("verifyInboundSignature", () => {
    const SECRET = "verify-secret-" + "c".repeat(40);
    const TOKEN = "verify-token-" + "d".repeat(40);

    beforeEach(() => {
      process.env.FEATURE_FLAG_INTERNAL_AUTH = "true";
      process.env.VAULT_ALLOW_ENV_FALLBACK = "true";
      process.env.INTERNAL_TOKEN = TOKEN;
      process.env.INTERNAL_HMAC_SECRET = SECRET;
      reloadInternalCredentialsForTest();
    });

    it("正确签名 → valid=true", () => {
      const ts = Date.now().toString();
      const body = JSON.stringify({ ok: 1 });
      const bodyHex = sha256Hex(body);
      const sig = hmacSign(SECRET, `POST\n/x\n${ts}\n${bodyHex}`);
      const r = verifyInboundSignature({
        method: "POST",
        path: "/x",
        body,
        timestampHeader: ts,
        signatureHeader: sig,
      });
      expect(r.valid).toBe(true);
    });

    it("时间戳超过 5min 容忍 → 拒绝", () => {
      const ts = (Date.now() - TIMESTAMP_TOLERANCE_MS - 10_000).toString();
      const body = "{}";
      const sig = hmacSign(SECRET, `POST\n/x\n${ts}\n${sha256Hex(body)}`);
      const r = verifyInboundSignature({
        method: "POST",
        path: "/x",
        body,
        timestampHeader: ts,
        signatureHeader: sig,
      });
      expect(r.valid).toBe(false);
      expect(r.reason).toMatch(/skew|stale/);
    });

    it("签名被篡改 → bad_sig", () => {
      const ts = Date.now().toString();
      const body = "{}";
      const r = verifyInboundSignature({
        method: "POST",
        path: "/x",
        body,
        timestampHeader: ts,
        signatureHeader: "0".repeat(64),
      });
      expect(r.valid).toBe(false);
      expect(r.reason).toBe("bad_sig");
    });

    it("缺头 → missing_headers", () => {
      const r = verifyInboundSignature({
        method: "POST",
        path: "/x",
        body: "{}",
        timestampHeader: null,
        signatureHeader: null,
      });
      expect(r.valid).toBe(false);
      expect(r.reason).toBe("missing_headers");
    });
  });
});
