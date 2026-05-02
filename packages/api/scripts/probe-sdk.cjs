/**
 * 用 OpenAI SDK 直接调用 qwen-plus，重现 Agent Runtime 的 "Connection error"
 * 使用与 LLMProvider 完全相同的参数：timeout=120s, maxRetries=1
 */
const path = require("path");
const fs = require("fs");
const { createDecipheriv, createHash } = require("crypto");

const OpenAI = require("D:/Ruanjian Kaifa/qoder/Super Lv/super-agent/node_modules/.pnpm/openai@4.104.0_ws@8.20.0_zod@3.25.76/node_modules/openai").default;

(async () => {
  const initSqlJs = require("D:/Ruanjian Kaifa/qoder/Super Lv/super-agent/node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js");
  const SQL = await initSqlJs();
  const dbPath = path.resolve(__dirname, "..", "data", "super-agent.db");
  const db = new SQL.Database(new Uint8Array(fs.readFileSync(dbPath)));
  const ENC_KEY = createHash("sha256").update("super-agent-default-encryption-key-v1").digest();
  const rows = db.exec("SELECT id, api_key, api_key_iv FROM llm_providers WHERE id='qwen'")[0];
  const iv = Buffer.from(rows.values[0][2], "hex");
  const dec = createDecipheriv("aes-256-cbc", ENC_KEY, iv);
  const qwenKey = dec.update(rows.values[0][1], "hex", "utf8") + dec.final("utf8");
  console.log(`qwen key OK (len=${qwenKey.length})`);

  const client = new OpenAI({
    apiKey: qwenKey,
    baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    timeout: 120_000,
    maxRetries: 1,
  });

  console.log("\n--- calling qwen-plus via OpenAI SDK (no tools) ---");
  try {
    const t0 = Date.now();
    const resp = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: "Say pong." },
      ],
      max_tokens: 10,
    });
    console.log(`OK ms=${Date.now() - t0}`);
    console.log(`response: ${JSON.stringify(resp.choices[0].message)}`);
  } catch (e) {
    console.log(`ERROR: ${e.name}: ${e.message}`);
    console.log(`status=${e.status} code=${e.code}`);
    if (e.cause) console.log(`cause: ${e.cause.code || ""} ${e.cause.message || e.cause}`);
    if (e.stack) console.log(`stack: ${e.stack.split("\n").slice(0, 10).join("\n")}`);
  }

  // 有 tools 的调用（writer 必带 tools）
  console.log("\n--- calling qwen-plus with tools ---");
  try {
    const t0 = Date.now();
    const resp = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "You are a writer." },
        { role: "user", content: "写一句猫的口号。" },
      ],
      max_tokens: 50,
      tools: [
        {
          type: "function",
          function: {
            name: "finish",
            description: "Finish the task",
            parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
          },
        },
      ],
    });
    console.log(`OK ms=${Date.now() - t0}`);
    console.log(`response: ${JSON.stringify(resp.choices[0].message).slice(0, 400)}`);
  } catch (e) {
    console.log(`ERROR: ${e.name}: ${e.message}`);
    console.log(`status=${e.status} code=${e.code}`);
    if (e.cause) console.log(`cause: ${e.cause.code || ""} ${e.cause.message || e.cause}`);
    if (e.stack) console.log(`stack: ${e.stack.split("\n").slice(0, 10).join("\n")}`);
  }
})();
