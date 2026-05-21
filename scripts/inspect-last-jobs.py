import sqlite3
import json
import os

# 自动定位 monorepo 根目录（运行时相对于当前脚本位置）
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(SCRIPT_DIR)

for DB in [
    os.path.join(ROOT_DIR, "packages", "api", "data", "super-agent.db"),
    os.path.join(ROOT_DIR, "data", "super-agent.db"),
]:
    if not os.path.exists(DB):
        continue
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    # list tables
    cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
    tables = [r[0] for r in cur.fetchall()]
    print(f"### {DB}")
    print("tables:", tables)
    if "video_jobs" in tables:
        cur.execute(
            "SELECT id, status, agent_providers, agent_provider_template_id, error, created_at "
            "FROM video_jobs ORDER BY created_at DESC LIMIT 5"
        )
        for row in cur.fetchall():
            jid, status, providers, tpl, err, created = row
            print(f"=== {jid} status={status} tpl={tpl} created={created}")
            if providers:
                try:
                    print("providers:", json.dumps(json.loads(providers), ensure_ascii=False, indent=2))
                except Exception:
                    print("providers(raw):", providers[:300])
            else:
                print("providers: NULL")
            print("error:", (err or "")[:180])
            print()
    conn.close()

