"""E2E session-recovery test — simulasi logout (token dicabut) saat request berjalan:
request dengan cookie RUSAK → 401 dari server → auth_hook (SessionManager) →
re-login dengan kredensial .env → request diulang → sukses.
Menjalankan path kode persis seperti mid-run logout di bot."""
import sys
sys.path.insert(0, "/home/z/my-project/mini-services/trend-scraper-python")

from creatok import CreatoKClient
from session import SessionManager
from store import Store

client = CreatoKClient()
store = Store("/home/z/my-project/db/custom.db")
sm = SessionManager(client, store)

# simulasi LOGOUT PENUH: hapus SEMUA cookie dari session thread (bukti probe:
# API tanpa cookie → 401 Unauthorized Access; token basi pun masih 200 —
# auth sumber hanya cek keberadaan cookie. Yang penting: path 401 → relogin → retry.)
s = client._session()
s.cookies.clear()
print("semua cookie dihapus (logout penuh); state awal:", sm.state)

path = ("/app/api/trending?pageNum=1&pageSize=5&region=ID&contentType=all"
        "&salesFlag=withSales&createdByAi=false&product_category_id=700645"
        f"&minCreateTime={1791000000}&maxCreateTime={1791600000}")
data = client.get_json(path)

ok = data is not None and data.get("code") == 0
print("request setelah recovery sukses:", ok,
      "| items:", len((data or {}).get("data") or []) if ok else 0)
print("session state akhir:", sm.state, "| metrics:", client.metrics_snapshot())
print("session.json tersimpan ulang:", end=" ")
import json
d = json.load(open("/home/z/my-project/mini-services/trend-scraper-python/session.json"))
print(len(d.get("cookies", [])), "cookie (token baru)")
assert ok and sm.state == "healthy", "RECOVERY GAGAL"
print("\nSESSION RECOVERY E2E LOLOS ✅ (401 → relogin → retry → 200)")
