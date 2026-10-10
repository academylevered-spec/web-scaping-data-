"""Probe v3 — diagnosa fase produk (batch-detail) + verifikasi bucket harian disjoint.
Tidak mengubah state apapun; hanya membaca session.json & DB, GET ke sumber.
"""
import json
import time

import requests

import config

now = int(time.time())

# ── 1. Session dari session.json ─────────────────────────────────────────
s = requests.Session()
data = json.load(open(config.SESSION_PATH))
for c in data["cookies"]:
    s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
s.headers.update(
    {
        "User-Agent": config.UA,
        "Accept": "application/json",
        "Referer": f"{config.BASE_URL}/app/trending",
        "Origin": config.BASE_URL,
    }
)

# ── 2. Ambil product ID pending dari DB ─────────────────────────────────
import sqlite3

con = sqlite3.connect(config.DB_PATH)
rows = con.execute(
    """SELECT DISTINCT shopUrl FROM TrendVideo
       WHERE isShopProduct=1 AND productTitle IS NULL AND shopUrl IS NOT NULL
       ORDER BY views DESC LIMIT 40"""
).fetchall()
pids = [r[0].rstrip("/").rsplit("/", 1)[-1] for r in rows]
enriched = con.execute(
    "SELECT COUNT(*) FROM TrendVideo WHERE productTitle IS NOT NULL"
).fetchone()[0]
shoppable = con.execute("SELECT COUNT(*) FROM TrendVideo WHERE isShopProduct=1").fetchone()[0]
print(f"[db] shoppable={shoppable}, enriched(productTitle!=NULL)={enriched}, pending sample={len(pids)}")
print(f"[db] sample pids: {pids[:5]}")

# ── 3. Probe batch-detail ────────────────────────────────────────────────
if pids:
    r = s.get(
        f"{config.BASE_URL}/app/api/product/batch-detail",
        params={"product_ids": ",".join(pids[:20])},
        timeout=30,
    )
    print(f"\n[batch-detail] HTTP {r.status_code}")
    try:
        body = r.json()
        print(f"[batch-detail] code={body.get('code')} keys={list(body.keys())}")
        d = body.get("data")
        print(f"[batch-detail] data type={type(d).__name__} len={len(d) if hasattr(d, '__len__') else None}")
        if d:
            print("[batch-detail] sample:", json.dumps(d, ensure_ascii=False)[:600])
    except Exception as e:
        print("[batch-detail] parse error:", e, r.text[:300])

# ── 4. Probe bucket harian disjoint (usia 2-3 hari, region ID, Beauty) ──
t_max = now - 2 * 86400
t_min = now - 3 * 86400
r2 = s.get(
    f"{config.BASE_URL}/app/api/trending",
    params={
        "pageNum": 1,
        "pageSize": 5,
        "region": "ID",
        "contentType": "all",
        "salesFlag": "withSales",
        "createdByAi": "false",
        "product_category_id": "601450",
        "minCreateTime": t_min,
        "maxCreateTime": t_max,
    },
    timeout=30,
)
print(f"\n[daily-bucket 2-3d] HTTP {r2.status_code}")
try:
    b2 = r2.json()
    items = b2.get("data") or []
    print(f"[daily-bucket 2-3d] code={b2.get('code')} items={len(items)}")
    for it in items[:3]:
        print(
            f"  - sales={it.get('salesCount')} views={it.get('views')} "
            f"cat={it.get('category')} url={str(it.get('video_url'))[:60]}"
        )
except Exception as e:
    print("[daily-bucket] parse error:", e, r2.text[:300])

# ── 5. Probe bucket harian 6-7 hari ─────────────────────────────────────
t_max = now - 6 * 86400
t_min = now - 7 * 86400
r3 = s.get(
    f"{config.BASE_URL}/app/api/trending",
    params={
        "pageNum": 1,
        "pageSize": 5,
        "region": "US",
        "contentType": "all",
        "salesFlag": "withSales",
        "createdByAi": "false",
        "product_category_id": "601152",
        "minCreateTime": t_min,
        "maxCreateTime": t_max,
    },
    timeout=30,
)
print(f"\n[daily-bucket 6-7d] HTTP {r3.status_code}")
try:
    b3 = r3.json()
    items = b3.get("data") or []
    print(f"[daily-bucket 6-7d] code={b3.get('code')} items={len(items)}")
except Exception as e:
    print("[daily-bucket 6-7d] parse error:", e)
