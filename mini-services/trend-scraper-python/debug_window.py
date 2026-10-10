"""Debug semantik window createTime + region ID."""
import json
import time
import requests

BASE = "https://www.creatok.ai"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

s = requests.Session()
s.headers.update({"User-Agent": UA, "Accept": "application/json"})
r = s.post(f"{BASE}/api/auth/sign-in/email",
           json={"email": "academylevered@gmail.com", "password": "academylevered"},
           headers={"Origin": BASE, "Referer": f"{BASE}/login"}, timeout=30)
print("LOGIN:", r.status_code)

now = int(time.time())
def probe(label, minc, maxc, region="ID", cat="601450"):
    url = (f"{BASE}/app/api/trending?pageNum=1&pageSize=100&region={region}&contentType=all"
           f"&salesFlag=withSales&createdByAi=false&product_category_id={cat}"
           f"&minCreateTime={minc}&maxCreateTime={maxc}")
    d = s.get(url, headers={"Referer": f"{BASE}/app/trending"}, timeout=30).json()
    items = d.get("data") or []
    print(f"{label:28s} code={d.get('code')} items={len(items)}")
    return items

i1 = probe("24h window", now-86400, now)
i2 = probe("7d window", now-7*86400, now)
i3 = probe("30d window", now-30*86400, now)
i4 = probe("30d→now reversed", now, now-30*86400)  # cek kemungkinan param terbalik
i5 = probe("no window params", now, now)
# tanpa min/max sama sekali
url = (f"{BASE}/app/api/trending?pageNum=1&pageSize=100&region=ID&contentType=all"
       f"&salesFlag=withSales&createdByAi=false&product_category_id=601450")
d = s.get(url, headers={"Referer": f"{BASE}/app/trending"}, timeout=30).json()
print(f"{'tanpa min/max sama sekali':28s} code={d.get('code')} items={len(d.get('data') or [])}")

if i2:
    print("\ncontoh item 7d keys:", sorted(i2[0].keys()))
