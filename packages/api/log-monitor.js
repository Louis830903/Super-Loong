/**
 * Super Agent — Real-time Log Monitor Dashboard
 *
 * Spawns the API server as a child process, captures all stdout/stderr,
 * and serves a web dashboard with SSE real-time streaming.
 *
 * Usage:  node log-monitor.js
 * Dashboard: http://localhost:3002
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createWriteStream, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 是否为 dev 模式（通过 --dev 参数或 NODE_ENV=development 判断）
const IS_DEV = process.argv.includes("--dev") || process.env.NODE_ENV === "development";

const MONITOR_PORT = 3002;
const LOG_DIR = join(__dirname, "logs");
const MAX_BUFFER = 2000;
const API_ENTRY = join(__dirname, "dist", "index.js");

// B4: 内置 INTERNAL_TOKEN 鉴权 — 防止未授权访问日志/Trace 数据
const MONITOR_TOKEN = process.env.INTERNAL_TOKEN || "";
// 独立监控窗口开关（环境变量 MONITOR_WINDOW=false 可禁用）
const MONITOR_WINDOW_ENABLED = process.env.MONITOR_WINDOW !== "false";
const MONITOR_PKG_DIR = join(__dirname, "..", "monitor");

const logBuffer = [];
const traceBuffer = [];  // 单独存储 Trace Span 事件
const MAX_TRACE_BUFFER = 500;
const sseClients = new Set();

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const ts = new Date().toISOString().slice(0, 10);
const logFile = createWriteStream(join(LOG_DIR, `api-${ts}.log`), { flags: "a" });

function broadcast(line) {
  const parsed = tryParseJson(line);
  const isSpan = parsed && parsed.extra && parsed.extra._type === "span";
  const entry = { raw: line, parsed, ts: Date.now(), isSpan };
  logBuffer.push(entry);
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift();
  logFile.write(line + "\n");
  // Span 事件也存入单独的 traceBuffer
  if (isSpan) {
    traceBuffer.push(entry);
    if (traceBuffer.length > MAX_TRACE_BUFFER) traceBuffer.shift();
  }
  const data = JSON.stringify(entry);
  for (const res of sseClients) {
    res.write(`data: ${data}\n\n`);
  }
}

function tryParseJson(line) {
  try {
    const obj = JSON.parse(line);
    // 识别 Trace Span 格式
    if (obj._type === "span") {
      return {
        level: obj.status === "error" ? "ERROR" : "TRACE",
        time: obj.endTime ? new Date(obj.endTime).toLocaleTimeString() : new Date().toLocaleTimeString(),
        name: obj.operation || "span",
        msg: `[${obj.operation}] ${obj.duration || 0}ms (${obj.status}) traceId=${obj.traceId?.slice(0, 8)}`,
        err: obj.status === "error" ? (obj.attributes?.error || "") : "",
        extra: obj,
      };
    }
    return {
      level: levelName(obj.level),
      time: obj.time ? new Date(obj.time).toLocaleTimeString() : "",
      name: obj.name || "",
      msg: obj.msg || "",
      err: obj.err || obj.error || "",
      extra: obj,
    };
  } catch {
    const level = /error/i.test(line) ? "ERROR" : /warn/i.test(line) ? "WARN" : /info/i.test(line) ? "INFO" : "LOG";
    return { level, time: new Date().toLocaleTimeString(), name: "", msg: line, err: "", extra: null };
  }
}

function levelName(n) {
  if (n >= 60) return "FATAL";
  if (n >= 50) return "ERROR";
  if (n >= 40) return "WARN";
  if (n >= 30) return "INFO";
  if (n >= 20) return "DEBUG";
  return "TRACE";
}

// ── Spawn API ───────────────────────────────────────────
const apiCmd = IS_DEV ? "npx" : "node";
const apiArgs = IS_DEV ? ["tsx", "watch", "src/index.ts"] : [API_ENTRY];
console.log(`[monitor] Starting API (${IS_DEV ? "dev" : "prod"}): ${apiCmd} ${apiArgs.join(" ")}`);
const child = spawn(apiCmd, apiArgs, {
  cwd: __dirname,
  env: { ...process.env },
  stdio: ["ignore", "pipe", "pipe"],
  shell: process.platform === "win32",
});

function handleOutput(stream) {
  let remainder = "";
  stream.on("data", (chunk) => {
    const text = remainder + chunk.toString();
    const lines = text.split("\n");
    remainder = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        broadcast(line);
        process.stdout.write(line + "\n");
      }
    }
  });
}
handleOutput(child.stdout);
handleOutput(child.stderr);

child.on("exit", (code) => {
  broadcast(`[monitor] API process exited with code ${code}`);
  console.log(`[monitor] API exited (code=${code}). Monitor stays alive for log review.`);
});

// ── HTTP Dashboard ──────────────────────────────────────
// B4: 监控面板鉴权检查 — INTERNAL_TOKEN 非空时，对 SSE / API 端点校验 token
function checkMonitorAuth(req) {
  if (!MONITOR_TOKEN) return true; // 未配置 token 时放行（开发环境向后兼容）
  // 支持两种传入方式：Header（Electron/API 调用）或 query param（浏览器 EventSource）
  const headerToken = req.headers["x-internal-token"];
  if (headerToken && headerToken === MONITOR_TOKEN) return true;
  const urlObj = new URL(req.url, `http://localhost:${MONITOR_PORT}`);
  const queryToken = urlObj.searchParams.get("token");
  return queryToken === MONITOR_TOKEN;
}

const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // B4: 对数据端点强制鉴权（Dashboard HTML 页面本身不拦截，token 已内嵌于 SSE URL）
  const pathname = new URL(req.url, `http://localhost:${MONITOR_PORT}`).pathname;
  if ((pathname === "/events" || pathname.startsWith("/api/")) && !checkMonitorAuth(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Unauthorized", message: "Missing or invalid INTERNAL_TOKEN" }));
    return;
  }

  if (req.url === "/events" || req.url.startsWith("/events?")) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    for (const entry of logBuffer) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  if (req.url === "/api/logs" || req.url.startsWith("/api/logs?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(logBuffer));
    return;
  }

  // Trace 事件查询端点（供监控窗口使用）
  if (req.url === "/api/traces" || req.url.startsWith("/api/traces?")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(traceBuffer));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(DASHBOARD_HTML);
});

server.listen(MONITOR_PORT, () => {
  console.log(`[monitor] Dashboard ready at http://localhost:${MONITOR_PORT}`);
  // API 进程启动后自动拉起 Electron 监控窗口
  if (MONITOR_WINDOW_ENABLED) {
    launchElectronWindow();
  }
});

// ── 启动 Electron 独立监控窗口 ──────────────────────

function launchElectronWindow() {
  // 检查 electron 是否可用
  const electronBin = join(MONITOR_PKG_DIR, "node_modules", ".bin", process.platform === "win32" ? "electron.cmd" : "electron");
  const electronFallback = "npx";

  const cmd = existsSync(electronBin) ? electronBin : electronFallback;
  const args = cmd === electronFallback
    ? ["--yes", "electron", MONITOR_PKG_DIR]
    : [MONITOR_PKG_DIR];

  try {
    const monitor = spawn(cmd, args, {
      cwd: MONITOR_PKG_DIR,
      env: {
        ...process.env,
        MONITOR_PORT: String(MONITOR_PORT),
        API_PORT: String(process.env.PORT || 3001),
      },
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    });
    monitor.unref(); // 主进程退出不影响窗口
    console.log(`[monitor] Electron window launched (pid=${monitor.pid || 'detached'})`);
  } catch (err) {
    console.log(`[monitor] Failed to launch Electron window: ${err.message}`);
    console.log(`[monitor] You can manually start it: cd packages/monitor && npx electron .`);
  }
}

process.on("SIGINT", () => { child.kill(); server.close(); logFile.end(); process.exit(0); });
process.on("SIGTERM", () => { child.kill(); server.close(); logFile.end(); process.exit(0); });

// ── Dashboard HTML ──────────────────────────────────────
const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<title>Super Agent Log Monitor</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:'Cascadia Code','Consolas','SF Mono',monospace;background:#0d1117;color:#c9d1d9;font-size:13px}
#toolbar{position:fixed;top:0;left:0;right:0;z-index:10;background:#161b22;border-bottom:1px solid #30363d;padding:8px 16px;display:flex;align-items:center;gap:12px}
#toolbar h1{font-size:14px;color:#58a6ff;white-space:nowrap}
#toolbar .stats{font-size:12px;color:#8b949e;white-space:nowrap}
.filter-btn{padding:3px 10px;border-radius:12px;border:1px solid #30363d;background:transparent;color:#8b949e;cursor:pointer;font-size:12px;font-family:inherit;transition:all .15s}
.filter-btn.active{border-color:#58a6ff;color:#58a6ff;background:#58a6ff18}
.filter-btn:hover{border-color:#58a6ff}
#search{flex:1;min-width:120px;padding:4px 10px;border-radius:6px;border:1px solid #30363d;background:#0d1117;color:#c9d1d9;font-family:inherit;font-size:12px;outline:none}
#search:focus{border-color:#58a6ff}
#clear-btn{padding:3px 10px;border-radius:6px;border:1px solid #da3633;background:transparent;color:#da3633;cursor:pointer;font-size:12px;font-family:inherit}
#clear-btn:hover{background:#da363318}
#logs{margin-top:44px;padding:8px 12px;overflow-y:auto;height:calc(100vh - 68px)}
.log-line{padding:3px 8px;border-radius:4px;margin:1px 0;display:flex;gap:8px;line-height:1.5;border-left:3px solid transparent}
.log-line:hover{background:#161b22}
.log-line.FATAL,.log-line.ERROR{border-left-color:#da3633;background:#da363312}
.log-line.WARN{border-left-color:#d29922;background:#d2992208}
.log-line.INFO{border-left-color:#238636}
.log-line.TRACE{border-left-color:#58a6ff;background:#58a6ff12}
.log-level.TRACE{color:#58a6ff}
.log-time{color:#8b949e;min-width:72px;flex-shrink:0}
.log-level{min-width:48px;font-weight:600;flex-shrink:0}
.log-level.ERROR,.log-level.FATAL{color:#f85149}
.log-level.WARN{color:#d29922}
.log-level.INFO{color:#3fb950}
.log-level.DEBUG{color:#8b949e}
.log-name{color:#bc8cff;min-width:100px;max-width:140px;overflow:hidden;text-overflow:ellipsis;flex-shrink:0}
.log-msg{color:#c9d1d9;flex:1;word-break:break-all}
.log-msg .err-detail{color:#f85149;margin-left:8px}
.log-line.hidden{display:none}
#status-bar{position:fixed;bottom:0;left:0;right:0;background:#161b22;border-top:1px solid #30363d;padding:4px 16px;font-size:11px;color:#8b949e;display:flex;justify-content:space-between}
.pulse{display:inline-block;width:8px;height:8px;border-radius:50%;background:#3fb950;margin-right:6px;animation:pulse 2s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
</style>
</head>
<body>
<div id="toolbar">
  <h1>Super Agent Log Monitor</h1>
  <button class="filter-btn active" data-level="all">ALL</button>
  <button class="filter-btn active" data-level="ERROR">ERROR</button>
  <button class="filter-btn active" data-level="WARN">WARN</button>
  <button class="filter-btn active" data-level="INFO">INFO</button>
  <button class="filter-btn active" data-level="TRACE">TRACE</button>
  <button class="filter-btn" data-level="DEBUG">DEBUG</button>
  <input id="search" type="text" placeholder="Search logs...">
  <span class="stats" id="stats">0 lines</span>
  <button id="clear-btn">Clear</button>
</div>
<div id="logs"></div>
<div id="status-bar">
  <span><span class="pulse"></span>Connected - streaming live</span>
  <span id="last-update">-</span>
</div>
<script>
const logsEl=document.getElementById('logs'),statsEl=document.getElementById('stats'),searchEl=document.getElementById('search'),lastUpdateEl=document.getElementById('last-update');
let lineCount=0,autoScroll=true,activeFilters=new Set(['ERROR','WARN','INFO','TRACE','FATAL','LOG','all']);
logsEl.addEventListener('mouseenter',()=>autoScroll=false);
logsEl.addEventListener('mouseleave',()=>{autoScroll=true;scrollBottom()});
function scrollBottom(){if(autoScroll)logsEl.scrollTop=logsEl.scrollHeight}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function addLogLine(entry){
  const p=entry.parsed||{},level=p.level||'LOG';
  const div=document.createElement('div');
  div.className='log-line '+level;
  div.dataset.level=level;
  div.dataset.text=(p.msg+' '+p.name+' '+(p.err||'')).toLowerCase();
  let errHtml='';
  if(p.err){const es=typeof p.err==='string'?p.err:JSON.stringify(p.err);errHtml='<span class="err-detail">'+esc(es)+'</span>'}
  div.innerHTML='<span class="log-time">'+esc(p.time||'')+'</span><span class="log-level '+level+'">'+level+'</span><span class="log-name">'+esc(p.name||'')+'</span><span class="log-msg">'+esc(p.msg||entry.raw||'')+errHtml+'</span>';
  if(!shouldShow(div))div.classList.add('hidden');
  logsEl.appendChild(div);lineCount++;
  statsEl.textContent=lineCount+' lines';
  lastUpdateEl.textContent='Last: '+new Date().toLocaleTimeString();
  scrollBottom();
}
function shouldShow(div){
  const level=div.dataset.level;
  if(!activeFilters.has(level)&&!activeFilters.has('all'))return false;
  const q=searchEl.value.toLowerCase();
  if(q&&!div.dataset.text.includes(q))return false;
  return true;
}
function refilter(){for(const div of logsEl.children)div.classList.toggle('hidden',!shouldShow(div))}
document.querySelectorAll('.filter-btn').forEach(btn=>{
  btn.addEventListener('click',()=>{
    const level=btn.dataset.level;
    if(level==='all'){
      const allActive=btn.classList.contains('active');
      document.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active',!allActive));
      if(!allActive)activeFilters=new Set(['ERROR','WARN','INFO','DEBUG','TRACE','FATAL','LOG','all']);
      else activeFilters.clear();
    }else{
      btn.classList.toggle('active');
      if(btn.classList.contains('active'))activeFilters.add(level);
      else{activeFilters.delete(level);activeFilters.delete('all')}
    }
    refilter();
  });
});
searchEl.addEventListener('input',refilter);
document.getElementById('clear-btn').addEventListener('click',()=>{logsEl.innerHTML='';lineCount=0;statsEl.textContent='0 lines'});
const _monitorToken=${JSON.stringify(MONITOR_TOKEN)};const evtSource=new EventSource(_monitorToken?'/events?token='+encodeURIComponent(_monitorToken):'/events');
evtSource.onmessage=(e)=>{try{addLogLine(JSON.parse(e.data))}catch(err){console.debug('[log-monitor] parse error',err)}};
evtSource.onerror=()=>{document.querySelector('.pulse').style.background='#da3633';document.querySelector('#status-bar span').innerHTML='<span class="pulse" style="background:#da3633"></span>Disconnected - retrying...'};
</script>
</body>
</html>`;
