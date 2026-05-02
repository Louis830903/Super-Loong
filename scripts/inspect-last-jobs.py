import sqlite3
import json
import os

for DB in [
    r"D:\Ruanjian Kaifa\qoder\Super Lv\super-agent\packages\api\data\super-agent.db",
    r"D:\Ruanjian Kaifa\qoder\Super Lv\super-agent\data\super-agent.db",
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

