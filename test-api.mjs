/**
 * 快速测试 LLM API 连通性的脚本
 * 用法：先在 .env 中配置 LLM_API_KEY 和 LLM_BASE_URL，然后运行：
 *   node test-api.mjs
 */
import { config } from "dotenv";
config();

const BASE_URL = process.env.LLM_BASE_URL || "https://api.openai.com/v1";
const API_KEY = process.env.LLM_API_KEY;

if (!API_KEY) {
  console.error("ERROR: LLM_API_KEY not set in .env");
  process.exit(1);
}

const resp = await fetch(`${BASE_URL}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`
  },
  body: JSON.stringify({
    model: process.env.LLM_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 10
  }),
  signal: AbortSignal.timeout(15000)
}).catch(e => { console.error("FETCH_ERROR:", e.message); process.exit(1); });

console.log("STATUS:", resp.status);
const body = await resp.text();
console.log("BODY:", body.slice(0, 500));
