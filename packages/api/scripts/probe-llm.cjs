/**
 * 临时诊断脚本：直接调用 DashScope / DeepSeek API，验证网络与 API key 可用性。
 */
const path = require("path");
const fs = require("fs");
const { createDecipheriv, createHash } = require("crypto");

const initSqlJs = require("D:/Ruanjian Kaifa/qoder/Super Lv/super-agent/node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js");

(async () => {
  const SQL = await initSqlJs();
  const dbPath = path.resolve(__dirname, "..", "data", "super-agent.db");
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));

  const ENC_KEY = createHash("sha256")
    .update(process.env.SA_ENCRYPTION_KEY || "super-agent-default-encryption-key-v1")
    .digest();
  const decrypt = (hex, ivHex) => {
    const iv = Buffer.from(ivHex, "hex");
    const d = createDecipheriv("aes-256-cbc", ENC_KEY, iv);
    return d.update(hex, "hex", "utf8") + d.final("utf8");
  };

  const rows = db.exec("SELECT id, api_key, api_key_iv FROM llm_providers WHERE id='qwen'")[0];
  const qwenKey = decrypt(rows.values[0][1], rows.values[0][2]);
  console.log(`qwen key length: ${qwenKey.length}`);

  // 1. 测试 DashScope 兼容模式 /models
  async function test(url, key, label) {
    console.log(`\n--- ${label} ---`);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const t0 = Date.now();
      const r = await fetch(url, {
        method: "GET",
        headers: { Authorization: `Bearer ${key}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      const text = await r.text();
      console.log(`status=${r.status} ms=${Date.now() - t0}`);
      console.log(`body(first 400): ${text.slice(0, 400)}`);
    } catch (e) {
      clearTimeout(timer);
      console.log(`FETCH ERROR: ${e.name}: ${e.message}`);
      if (e.cause) console.log(`cause: ${e.cause.code || ""} ${e.cause.message || e.cause}`);
    }
  }

  await test("https://dashscope.aliyuncs.com/compatible-mode/v1/models", qwenKey, "DashScope GET /models");

  // 2. 测试 chat completion（最小调用）
  console.log("\n--- DashScope chat completions (qwen-plus) ---");
  try {
    const t0 = Date.now();
    const r = await fetch("https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${qwenKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "qwen-plus",
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 5,
      }),
    });
    const text = await r.text();
    console.log(`status=${r.status} ms=${Date.now() - t0}`);
    console.log(`body: ${text.slice(0, 500)}`);
  } catch (e) {
    console.log(`FETCH ERROR: ${e.name}: ${e.message}`);
    if (e.cause) console.log(`cause: ${e.cause.code || ""} ${e.cause.message || e.cause}`);
  }

  // 3. 测试 DeepSeek（即使 DB 无记录，catalog baseUrl 有默认值）
  await test("https://api.deepseek.com/v1/models", "", "DeepSeek GET /models (no key)");
})();
