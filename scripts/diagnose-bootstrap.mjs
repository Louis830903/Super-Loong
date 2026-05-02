// 诊断脚本：直接调用 ensureVideoForgeDeps，观察 bootstrap 行为
// 用法: node scripts/diagnose-bootstrap.mjs
import { ensureVideoForgeDeps } from "../packages/core/dist/index.js";
import path from "node:path";

const monorepoRoot = path.resolve(process.cwd());
const videoForgeDir = path.join(monorepoRoot, "services", "video-forge");

console.log("[diagnose] monorepoRoot =", monorepoRoot);
console.log("[diagnose] videoForgeDir =", videoForgeDir);
console.log("[diagnose] process.env.PATH head =", (process.env.PATH || "").split(";").slice(0, 5).join(" | "));

try {
  const result = await ensureVideoForgeDeps({ monorepoRoot, videoForgeDir });
  console.log("[diagnose] ensureVideoForgeDeps OK:");
  console.log(JSON.stringify({
    pythonPath: result.pythonPath,
    pythonVersion: result.pythonVersion,
    ffmpegPath: result.ffmpegPath,
    venvDir: result.venvDir,
  }, null, 2));
} catch (err) {
  console.error("[diagnose] ensureVideoForgeDeps FAILED:", err);
  process.exit(1);
}
