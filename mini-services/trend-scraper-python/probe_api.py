"""Probe cepat API creatok.ai — verifikasi field mentah, createTime, pageSize, filter sales."""
import json
import time
import requests

BASE = "https://www.creatok.ai"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
EMAIL = "academylevered@gmail.com"
PASSWORD = "academylevered"

s = requests.Session()
s.headers.update({"User-Agent": UA, "Accept": "application/json"})

# 1) LOGIN
r = s.post(
    f"{BASE}/api/auth/sign-in/email",
    json={"email": EMAIL, "password": PASSWORD},
    headers={"Origin": BASE, "Referer": f"{BASE}/login"},
    timeout=30,
)
print("LOGIN:", r.status_code)
print("COOKIES:", [c.name for c in s.cookies])

now = int(time.time())

# 2) TRENDING probe — US, Beauty, 7 hari, salesFlag=withSales
url = (f"{BASE}/app/api/trending?pageNum=1&pageSize=50&region=US&contentType=all"
       f"&salesFlag=withSales&createdByAi=false&product_category_id=601450"
       f"&minCreateTime={now - 7*86400}&maxCreateTime={now}")
r2 = s.get(url, headers={"Referer": f"{BASE}/app/trending"}, timeout=30)
d = r2.json()
print("\nTRENDING code:", d.get("code"), "msg:", d.get("msg"), "items:", len(d.get("data") or []))
items = d.get("data") or []
if items:
    print("\n=== RAW ITEM (keys + values) ===")
    print(json.dumps(items[0], indent=1, ensure_ascii=False)[:2500])

# 3) pageSize=100 test
url100 = (f"{BASE}/app/api/trending?pageNum=1&pageSize=100&region=ID&contentType=all"
          f"&salesFlag=withSales&createdByAi=false&product_category_id=601450"
          f"&minCreateTime={now - 7*86400}&maxCreateTime={now}")
r3 = s.get(url100, headers={"Referer": f"{BASE}/app/trending"}, timeout=30)
d3 = r3.json()
print("\nPAGE_SIZE=100 items:", len(d3.get("data") or []))

# 4) salesFlag=tanpa filter (bandingkan volume)
url4 = (f"{BASE}/app/api/trending?pageNum=1&pageSize=50&region=ID&contentType=all"
        f"&salesFlag=all&createdByAi=false&product_category_id=601450"
        f"&minCreateTime={now - 7*86400}&maxCreateTime={now}")
r4 = s.get(url4, headers={"Referer": f"{BASE}/app/trending"}, timeout=30)
d4 = r4.json()
print("salesFlag=all items:", len(d4.get("data") or []))

# 5) window 30 hari (volume untuk planning)
url5 = (f"{BASE}/app/api/trending?pageNum=1&pageSize=50&region=ID&contentType=all"
        f"&salesFlag=withSales&createdByAi=false&product_category_id=601450"
        f"&minCreateTime={now - 30*86400}&maxCreateTime={now}")
r5 = s.get(url5, headers={"Referer": f"{BASE}/app/trending"}, timeout=30)
d5 = r5.json()
print("window=30d items p1:", len(d5.get("data") or []))

# 6) PRODUCT batch probe
if items:
    pids = [p for p in (items[0].get("productIds") or []) if p][:5]
    if pids:
        url6 = f"{BASE}/app/api/product/batch-detail?product_ids={','.join(pids)}"
        r6 = s.get(url6, headers={"Referer": f"{BASE}/app/trending"}, timeout=30)
        print("\nPRODUCT probe:", json.dumps(r6.json(), indent=1, ensure_ascii=False)[:1200])

# 7) salesCount range check (berapa yang >= 10 sales & views >= 10k di p1)
qual = 0
for it in items:
    sc = it.get("salesCount") or 0
    vw = it.get("views")
    if isinstance(vw, str):
        m = vw.strip()
        mult = 1
        if m.endswith("K"): mult, m = 1_000, m[:-1]
        elif m.endswith("M"): mult, m = 1_000_000, m[:-1]
        elif m.endswith("B"): mult, m = 1_000_000_000, m[:-1]
        try: vw = int(float(m.replace(",", "")) * mult)
        except Exception: vw = 0
    if sc >= 10 and vw >= 10000:
        qual += 1
print(f"\nQUALIFYING p1 (sales>=10 & views>=10k): {qual}/{len(items)}")
