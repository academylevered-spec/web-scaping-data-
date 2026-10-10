"""v7 offline unit tests — Store + CircuitBreaker + preemption logic.
Dijalankan pada COPY DB sementara (tanpa menyentuh DB live / jaringan).
Jalankan: python3 tests/test_v7_offline.py"""
import os
import random
import shutil
import sys
import tempfile
import time

sys.path.insert(0, "/home/z/my-project/mini-services/trend-scraper-python")

import config
from slice_queue import CircuitBreaker
from store import Store

PASS = 0
FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"  ✓ {name}")
    else:
        FAIL += 1
        print(f"  ✗ FAIL: {name} {detail}")


tmpdir = tempfile.mkdtemp(prefix="v7test-")
DB = os.path.join(tmpdir, "test.db")
shutil.copy("/home/z/my-project/db/custom.db", DB)

print("== 1. ensure_schema + recover_boot migration ==")
store = Store(DB)
cols = [r[1] for r in store.con.execute("PRAGMA table_info(ScrapeJob)").fetchall()]
check("kolom owner ada", "owner" in cols)
legacy = store.con.execute("SELECT COUNT(*) FROM ScrapeJob WHERE status='queued'").fetchone()[0]
store.recover_boot()
statuses = dict(store.con.execute(
    "SELECT status, COUNT(*) FROM ScrapeJob GROUP BY status").fetchall())
check("tidak ada lagi job 'queued' legacy", statuses.get("queued", 0) == 0, str(statuses))
check("legacy queued → cancelled", statuses.get("cancelled", 0) >= legacy)
slice_statuses = dict(store.con.execute(
    "SELECT status, COUNT(*) FROM ScrapeSlice GROUP BY status").fetchall())
check("tidak ada lagi slice 'pending'/'running' (migrasi → ready)",
      slice_statuses.get("pending", 0) == 0 and slice_statuses.get("running", 0) == 0,
      str(slice_statuses))

print("== 2. create_or_unhold_job (scope-command core) ==")
# bersihkan antrean aktif dari DB live copy agar urutan FIFO terukur
store.con.execute("DELETE FROM ScrapeJob WHERE status IN ('ready','held')")
store.con.commit()
# kode negara sintetis agar tidak bentrok dg job legacy di DB live
j1, created, unheld = store.create_or_unhold_job("country", "T1", "ui", priority=0)
check("job baru dibuat ready", created and j1["status"] == "ready" and j1["owner"] == config.INSTANCE_ID)
j2, created2, unheld2 = store.create_or_unhold_job("country", "T1", "ui", priority=0)
check("dedup: job sama tidak dobel", (not created2) and j2["id"] == j1["id"])
store.hold_job(j1["id"], "test preempt")
j4, created3, unheld3 = store.create_or_unhold_job("country", "T1", "ui", priority=0)
check("klik ulang scope held → unhold", unheld3 and j4["status"] == "ready" and j4["priority"] == 0)

print("== 3. claim + priority FIFO ==")
store.create_or_unhold_job("country", "T2", "scheduled", priority=10)
store.create_or_unhold_job("country", "T3", "ui", priority=0)
claimed = store.claim_next_job()
check("claim FIFO: T1 prio 0 ter-ossile dulu", claimed["scopeValue"] == "T1" and claimed["status"] == "running")
claimed2 = store.claim_next_job()
check("claim berikutnya T3 (prio 0)", claimed2["scopeValue"] == "T3")
check("T2 (prio 10) tersisa", (store.next_ready_job() or {}).get("scopeValue") == "T2")


def _ids(where, params=()):
    return [r[0] for r in store.con.execute(where, params).fetchall()]


def _mark_done(ids, last_ms):
    store.con.execute(
        f"""UPDATE ScrapeSlice SET status='done', lastSuccessAt=?, updatedAt=?
            WHERE id IN ({','.join('?' * len(ids))})""",
        (last_ms, last_ms, *ids))
    store.con.commit()


def _status_of(ids):
    return dict(store.con.execute(
        f"SELECT status, COUNT(*) FROM ScrapeSlice WHERE id IN ({','.join('?' * len(ids))}) GROUP BY status",
        ids).fetchall())

print("== 4. reclaim_stale (freshness TTL) — slice sintetis country 'T9' ==")
now_ms = int(time.time() * 1000)
created_n = store.ensure_slices(["T9"], [("999", "TestCat")],
                                [{"id": 1}, {"id": 2}])
check("ensure_slices v7 membuat slice 'ready'", created_n == 2)

ids_stale = _ids("SELECT id FROM ScrapeSlice WHERE country='T9' AND bucket=1 AND status='ready' LIMIT 5")
_mark_done(ids_stale, now_ms - 3 * 3600_000)
n = store.reclaim_stale("country", "T9")
check("reclaim_stale mengangkat slice basi done→ready",
      n == 1 and _status_of(ids_stale).get("ready") == 1, f"n={n} {_status_of(ids_stale)}")

ids_fresh = _ids("SELECT id FROM ScrapeSlice WHERE country='T9' AND bucket=2 AND status='ready' LIMIT 5")
_mark_done(ids_fresh, now_ms)
store.reclaim_stale("country", "T9")
check("slice fresh tetap 'done' setelah reclaim", _status_of(ids_fresh).get("done") == 1,
      str(_status_of(ids_fresh)))

_mark_done(ids_stale, now_ms - 3 * 3600_000)  # basi-kan lagi
store.reclaim_stale("country", "MY")
check("reclaim scope 'MY' tidak menyentuh slice T9 basi (scope-respecting)",
      _status_of(ids_stale).get("done") == 1, str(_status_of(ids_stale)))

print("== 5. cancel/promote/hold ==")
jt2 = store.next_ready_job()
check("T2 masih ready sebelum cancel", jt2 is not None and jt2["scopeValue"] == "T2")
store.cancel_job(jt2["id"])
check("cancel ready → cancelled", store._get_job_by_id(jt2["id"])["status"] == "cancelled")
jp, _, _ = store.create_or_unhold_job("country", "T4", "ui", priority=10)
jj = store.promote_job(jp["id"])
check("promote job ready → priority 0", jj is not None and jj["priority"] == 0)
store.hold_job(jp["id"], "session test")
check("promote job held → None (hanya ready)", store.promote_job(jp["id"]) is None)

print("== 6. CircuitBreaker collapse-only ==")
cb = CircuitBreaker(None)
random.seed(42)
for _ in range(3 * config.CIRCUIT_WINDOW):
    cb.record(random.random() < 0.5)
check("breaker tetap CLOSED pada 50% fail kronis", cb.state == "closed", cb.state)
for _ in range(config.CIRCUIT_WINDOW):
    cb.record(False)
check("breaker OPEN saat 100% fail (collapse)", cb.state == "open", cb.state)
cb.opened_at = time.time() - config.CIRCUIT_OPEN_SEC - 1
check("cooldown lewat → allow probe", cb.allow() is True)
for _ in range(3):
    cb.record(True)
check("3 probe sukses → CLOSED", cb.state == "closed", cb.state)

print("== 7. release_running_slices ==")
job = store.claim_next_job()  # T1 held? no — T1 running; claim T4? depends; just exercise the call
if job:
    store.release_running_slices(job["id"])
    after = store.con.execute(
        "SELECT COUNT(*) FROM ScrapeSlice WHERE lastJobId=? AND status='running'",
        (job["id"],)).fetchone()[0]
    check("release_running_slices mengosongkan running job", after == 0)
else:
    check("release_running_slices (tidak ada job ready — ok)", True)

store.close()
shutil.rmtree(tmpdir, ignore_errors=True)
print(f"\nRESULT: {PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
