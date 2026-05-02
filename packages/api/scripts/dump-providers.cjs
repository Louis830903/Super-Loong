/**
 * 临时脚本：导出 providers 表中的 API key（用于诊断连通性）
 * 用完后立即删除，避免敏感信息泄漏
 */
const path = require("path");
const fs = require("fs");

(async () => {
  const initSqlJs = require("D:/Ruanjian Kaifa/qoder/Super Lv/super-agent/node_modules/.pnpm/sql.js@1.14.1/node_modules/sql.js");
  const SQL = await initSqlJs();
  const dbPath = path.resolve(__dirname, "..", "data", "super-agent.db");
  const buf = fs.readFileSync(dbPath);
  const db = new SQL.Database(new Uint8Array(buf));

  const tbl = db.exec("SELECT name FROM sqlite_master WHERE type='table'")[0];
  if (tbl) console.log("Tables:", tbl.values.map((v) => v[0]).join(","));

  try {
    const cols = db.exec("PRAGMA table_info(llm_providers)")[0];
    if (cols) console.log("llm_providers columns:", cols.values.map((v) => v[1]).join(","));
    const r = db.exec("SELECT * FROM llm_providers")[0];
    if (r) {
      console.log("Row count:", r.values.length);
      const { createDecipheriv, createHash } = require("crypto");
      const ENC_KEY = createHash("sha256")
        .update(process.env.SA_ENCRYPTION_KEY || "super-agent-default-encryption-key-v1")
        .digest();
      const decrypt = (hex, ivHex) => {
        if (!hex || !ivHex) return "";
        try {
          const iv = Buffer.from(ivHex, "hex");
          const d = createDecipheriv("aes-256-cbc", ENC_KEY, iv);
          return d.update(hex, "hex", "utf8") + d.final("utf8");
        } catch (e) { return `<decrypt-fail:${e.message}>`; }
      };
      for (const row of r.values) {
        const obj = {};
        r.columns.forEach((c, i) => (obj[c] = row[i]));
        const plain = decrypt(obj.api_key, obj.api_key_iv);
        console.log(`${obj.id}: base_url="${obj.base_url}" model="${obj.selected_model}" keyLen=${plain.length} keyPrefix="${plain.slice(0,8)}...${plain.slice(-4)}"`);
      }
    } else {
      console.log("providers table empty");
    }
  } catch (e) {
    console.error("Error:", e.message);
  }
})();
