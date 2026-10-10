"""Offline integration test v6 — Store/job/slice lifecycle + upsert pair integrity.
Pakai DB TEMPORARY — tidak menyentuh db/custom.db."""
import os
import sqlite3
import tempfile
import time

import config
config.DB_PATH = tempfile.mktemp(suffix=".db")

from store import Store  # noqa: E402

# bikin tabel (schema asli via prisma belum ada di temp db → replikasi minimal)
con = sqlite3.connect(config.DB_PATH)
con.executescript("""
CREATE TABLE TrendVideo (
  id TEXT PRIMARY KEY, tiktokId TEXT NOT NULL, videoUrl TEXT, authorHandle TEXT,
  authorName TEXT, authorAvatar TEXT, thumbnail TEXT, caption TEXT, hashtags TEXT DEFAULT '',
  country TEXT, category TEXT, sourceCategory TEXT DEFAULT '', duration TEXT,
  durationSec INTEGER DEFAULT 0, views INTEGER DEFAULT 0, likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0, shares INTEGER DEFAULT 0, sales INTEGER DEFAULT 0,
  gmv REAL DEFAULT 0, trafficType TEXT DEFAULT 'organic', isShopProduct INTEGER DEFAULT 0,
  shopUrl TEXT, productTitle TEXT, productPriceMin REAL, productPriceMax REAL,
  productSold INTEGER, productImage TEXT, trendingScore REAL DEFAULT 0,
  createTimeMin INTEGER DEFAULT 0, createTimeMax INTEGER DEFAULT 0,
  windowBucket INTEGER DEFAULT 0, postedAt INTEGER, firstSeenAt INTEGER, updatedAt INTEGER
);
CREATE UNIQUE INDEX TrendVideo_tiktokId_country_key ON TrendVideo(tiktokId, country);
CREATE TABLE ScrapeJob (
  id TEXT PRIMARY KEY, scopeType TEXT, scopeValue TEXT DEFAULT 'ALL', status TEXT DEFAULT 'queued',
  trigger TEXT DEFAULT 'manual', priority INTEGER DEFAULT 10, totalSlices INTEGER DEFAULT 0,
  doneSlices INTEGER DEFAULT 0, failedSlices INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
  fetched INTEGER DEFAULT 0, qualifying INTEGER DEFAULT 0, upserted INTEGER DEFAULT 0,
  newVideos INTEGER DEFAULT 0, productsUpdated INTEGER DEFAULT 0, pruned INTEGER DEFAULT 0,
  resumedCount INTEGER DEFAULT 0, pausedReason TEXT, errorSummary TEXT, startedAt INTEGER,
  finishedAt INTEGER, lastHeartbeatAt INTEGER, createdAt INTEGER, updatedAt INTEGER
);
CREATE TABLE ScrapeSlice (
  id TEXT PRIMARY KEY, country TEXT, categoryId TEXT, categoryName TEXT, bucket INTEGER,
  status TEXT DEFAULT 'pending', attempts INTEGER DEFAULT 0, lastError TEXT,
  lastSuccessAt INTEGER, lastJobId TEXT, pagesScraped INTEGER DEFAULT 0,
  itemsUpserted INTEGER DEFAULT 0, createdAt INTEGER, updatedAt INTEGER,
  UNIQUE(country, categoryId, bucket)
);
CREATE TABLE Alert (
  id TEXT PRIMARY KEY, severity TEXT DEFAULT 'warning', type TEXT, message TEXT,
  meta TEXT DEFAULT '', createdAt INTEGER, resolvedAt INTEGER
);
CREATE TABLE SyncLog (id TEXT PRIMARY KEY, startedAt INTEGER, finishedAt INTEGER,
  status TEXT DEFAULT 'running', fetched INTEGER DEFAULT 0, qualifying INTEGER DEFAULT 0,
  upserted INTEGER DEFAULT 0, newVideos INTEGER DEFAULT 0, requests INTEGER DEFAULT 0,
  errors TEXT DEFAULT '', trigger TEXT DEFAULT 'scheduled');
CREATE TABLE SyncState (id TEXT PRIMARY KEY, lastSyncAt INTEGER, nextSyncAt INTEGER,
  syncCount INTEGER DEFAULT 0, status TEXT DEFAULT 'idle', lastError TEXT);
""")
con.commit()
con.close()

s = Store(config.DB_PATH)
ok = lambda label: print(f"  ✓ {label}")

# 1. Job lifecycle
job = s.create_job("global", "ALL", "test", priority=10)
dup = s.create_job("global", "ALL", "test", priority=10)
assert job["id"] == dup["id"], "dedup job gagal"
ok("create_job + dedup scope sama")

claimed = s.claim_next_job()
assert claimed and claimed["id"] == job["id"] and claimed["status"] == "running"
ok("claim_next_job queued→running")

# 2. Slice lifecycle
created = s.ensure_slices(["ID", "US"], [("700645", "Health"), ("601352", "Shoes")],
                          [{"id": 1}, {"id": 2}])
assert created == 2 * 2 * 2, f"created={created}"
created2 = s.ensure_slices(["ID", "US"], [("700645", "Health"), ("601352", "Shoes")],
                           [{"id": 1}, {"id": 2}])
assert created2 == 0, "ensure_slices tidak idempoten"
ok(f"ensure_slices idempoten ({created} slice dibuat, kedua kali 0)")

batch = s.claim_slices(claimed, 3)
assert len(batch) == 3 and all("id" in b and "bucket" in b for b in batch)
assert batch[0]["bucket"] == 1, "prioritas bucket core dulu"
ok(f"claim_slices urut prioritas (bucket pertama={batch[0]['bucket']})")

s.complete_slice(batch[0]["id"], True, 2, 50, None, 1)
s.complete_slice(batch[1]["id"], False, 0, 0, "p1: bad response", 3)
prog = s.job_progress(job["id"])
assert prog["done"] == 1 and prog["failed"] == 1, prog
ok(f"complete_slice + job_progress {prog}")

# 3. Requeue failed (1 done, 1 failed→pending, 1 masih running)
s.requeue_failed()
counts = s.slice_status_counts()
assert counts.get("pending", 0) == 6 and counts.get("failed", 0) == 0 \
    and counts.get("running", 0) == 1, counts
ok(f"requeue_failed failed→pending {counts}")

# 4. Dead-letter
sl = s.claim_slices(claimed, 1)  # slice running tersisa
for _ in range(6):
    s.complete_slice(sl[0]["id"], False, 0, 0, "bad", 6)
counts = s.slice_status_counts()
assert counts.get("dead", 0) == 1, counts
n = s.requeue_dead()
counts = s.slice_status_counts()
assert n == 1 and counts.get("pending", 0) == 6, counts  # 8 total -1 done -1 running(batch[2])
ok("dead-letter setelah hard attempts + requeue_dead reset")

# 5. Upsert pair integrity (anti kontaminasi negara)
rows = [{"tiktokId": "111", "country": "ID", "videoUrl": "u", "authorHandle": "a",
         "thumbnail": "t", "caption": "c", "hashtags": "", "category": "Health",
         "sourceCategory": "Health", "duration": "00:15", "durationSec": 15,
         "views": 20000, "likes": 100, "sales": 20, "gmv": 5.0, "trafficType": "organic",
         "isShopProduct": 1, "shopUrl": "s", "trendingScore": 1.0,
         "createTimeMin": 0, "createTimeMax": 0, "windowBucket": 1}]
new, upd = s.upsert_videos(rows)
assert (new, upd) == (1, 0)
# video sama di negara lain = baris baru (bukan menimpa)
rows2 = [dict(rows[0], country="US")]
new, upd = s.upsert_videos(rows2)
assert (new, upd) == (1, 0), (new, upd)
# re-scrape negara sama = update
new, upd = s.upsert_videos([dict(rows[0], views=30000)])
assert (new, upd) == (0, 1), (new, upd)
n = s.con.execute("SELECT COUNT(*) FROM TrendVideo").fetchone()[0]
assert n == 2, n
ok(f"upsert (tiktokId,country): video di 2 negara = 2 baris, re-scrape = update")

# 6. Alert dedupe + resolve
a1 = s.insert_alert("critical", "session", "login gagal berulang XYZ")
a2 = s.insert_alert("critical", "session", "login gagal berulang XYZ")
assert a1 and a2 is None, (a1, a2)
n = s.resolve_alerts(type_="session")
assert n == 1
ok("alert dedupe + resolve")

# 7. recover_boot
s.update_job(job["id"], status="running")  # simulate crash state
s.recover_boot()
jobs = s.list_jobs(5)
assert jobs[0]["status"] == "paused", jobs[0]
ok("recover_boot: job running→paused (auto-resume)")

# 8. per-country summary
summ = s.per_country_summary()
assert {d["country"] for d in summ} == {"ID", "US"}
ok(f"per_country_summary {len(summ)} negara")

print("\nSEMUA TEST OFFLINE LOLOS ✅")
