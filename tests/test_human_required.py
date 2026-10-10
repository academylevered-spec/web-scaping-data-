"""E2E human_required test — password salah 3x → state human_required + alert critical;
lalu kredensial benar → recovery → alert resolved. Menjalankan state machine yang sama
dipakai bot (SessionManager + recovery path)."""
import sys
sys.path.insert(0, "/home/z/my-project/mini-services/trend-scraper-python")

import config
from creatok import CreatoKClient
from session import SessionManager
from store import Store

store = Store("/home/z/my-project/db/custom.db")
client = CreatoKClient()
sm = SessionManager(client, store)

REAL_PASSWORD = config.PASSWORD
assert REAL_PASSWORD, "kredensial .env hilang"

# ── 1. Password salah ×3 → human_required ──
config.PASSWORD = "salah-total-bukan-password"
for i in range(3):
    ok = sm.relogin(f"test-wrong-{i+1}")
    print(f"login #{i+1} → ok={ok} state={sm.state}")
assert sm.state == "human_required", "harusnya human_required"
print("✓ human_required tercapai setelah 3 kegagalan")

# pastikan job akan di-pause oleh run_job (cek logika keputusan)
assert not sm.is_healthy()
print("✓ is_healthy()=False → SliceQueue berhenti & run_job pause job")

# ── 2. Alert critical tercatat ──
alerts = [a for a in store.list_alerts(10, unresolved_only=True) if a["type"] == "session"]
assert alerts and alerts[0]["severity"] == "critical", alerts
print("✓ alert critical/session tercatat:", alerts[0]["message"][:90], "…")

# ── 3. Recovery: password benar → login sukses → healthy + alert resolved ──
config.PASSWORD = REAL_PASSWORD
import time
res = {"ok": False}
for i in range(10):  # source rate-limit login (429) → retry pasien, seperti recovery loop
    res = client.login()
    if res["ok"]:
        break
    print(f"recovery login #{i+1} gagal: {res.get('status')} — tunggu 20s")
    time.sleep(20)
assert res["ok"], res
sm._on_login_success()  # path yang sama dipanggil recovery loop
assert sm.state == "healthy" and sm.is_healthy()
resolved = [a for a in store.list_alerts(10) if a["type"] == "session" and a["id"] == alerts[0]["id"]]
assert resolved and resolved[0]["resolvedAt"], resolved
print("✓ recovery sukses → healthy; alert session resolved otomatis")
print("✓ info alert 'pulih' tercatat:", any(
    a["type"] == "session" and "pulih" in a["message"] for a in store.list_alerts(5)))

print("\nHUMAN_REQUIRED STATE MACHINE E2E LOLOS ✅")
