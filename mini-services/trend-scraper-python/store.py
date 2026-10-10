"""
Layer database Z.ai (SQLite WAL) v7 — akses bersama dengan Prisma (Next.js).
KONTRAK PENTING: Prisma menyimpan DateTime sebagai INTEGER epoch-milidetik;
semua kolom datetime ditulis eksplisit sebagai int ms agar 100% kompatibel.

v7 (scope-command — bukti: docs/scraping-v7/01-DIAGNOSIS.md):
- VOKABULARY STATUS TERPISAH dari proses zombie v6 yang tak bisa dibunuh:
    ScrapeJob : ready | running | held | completed | failed | cancelled
    ScrapeSlice: ready | running | done | failed | dead
  Zombie hanya SELECT 'queued'/'pending'/'paused' ⇒ tak pernah melihat/mengklaim
  row milik v7. Kolom ScrapeJob.owner = config.INSTANCE_ID saat v7 mengklaim.
- reclaim_stale(): slice 'done' lebih tua dari TTL bucket → 'ready' (freshness RC4).
- adopt_pending_slices(): row 'pending' buatan zombie (≥10 mnt tak disentuh) → 'ready'.
- Preemption helpers: hold_job, cancel_job, promote_job, next_ready_job.
"""
import sqlite3
import threading
import time
import uuid

import config

_INSERT_SQL = """
INSERT INTO TrendVideo (
  id, tiktokId, videoUrl, authorHandle, authorName, authorAvatar, thumbnail,
  caption, hashtags, country, category, sourceCategory, duration, durationSec,
  views, likes, comments, shares, sales, gmv, trafficType, isShopProduct,
  shopUrl, productTitle, productPriceMin, productPriceMax, productSold,
  productImage, trendingScore, createTimeMin, createTimeMax, windowBucket,
  postedAt, firstSeenAt, updatedAt
) VALUES (
  :id, :tiktokId, :videoUrl, :authorHandle, :authorName, :authorAvatar, :thumbnail,
  :caption, :hashtags, :country, :category, :sourceCategory, :duration, :durationSec,
  :views, :likes, :comments, :shares, :sales, :gmv, :trafficType, :isShopProduct,
  :shopUrl, :productTitle, :productPriceMin, :productPriceMax, :productSold,
  :productImage, :trendingScore, :createTimeMin, :createTimeMax, :windowBucket,
  :postedAt, :firstSeenAt, :updatedAt
)
ON CONFLICT(tiktokId, country) DO UPDATE SET
  videoUrl=excluded.videoUrl,
  authorHandle=excluded.authorHandle,
  authorName=excluded.authorName,
  authorAvatar=excluded.authorAvatar,
  thumbnail=excluded.thumbnail,
  caption=excluded.caption,
  hashtags=excluded.hashtags,
  category=excluded.category,
  sourceCategory=excluded.sourceCategory,
  duration=excluded.duration,
  durationSec=excluded.durationSec,
  views=excluded.views,
  likes=excluded.likes,
  sales=excluded.sales,
  gmv=excluded.gmv,
  trafficType=excluded.trafficType,
  isShopProduct=excluded.isShopProduct,
  shopUrl=excluded.shopUrl,
  trendingScore=excluded.trendingScore,
  createTimeMin=excluded.createTimeMin,
  createTimeMax=excluded.createTimeMax,
  windowBucket=excluded.windowBucket,
  updatedAt=excluded.updatedAt
"""

# Prioritas claim slice: core bucket dulu (1..4), lalu harian segar-dulu (10..5)
_BUCKET_RANK_SQL = """
CASE bucket WHEN 1 THEN 0 WHEN 2 THEN 1 WHEN 3 THEN 2 WHEN 4 THEN 3
            WHEN 10 THEN 4 WHEN 9 THEN 5 WHEN 8 THEN 6 WHEN 7 THEN 7
            WHEN 6 THEN 8 WHEN 5 THEN 9 ELSE 10 END
"""

_JOB_COLS = (
    "id, scopeType, scopeValue, status, trigger, priority, totalSlices, doneSlices, "
    "failedSlices, requests, fetched, qualifying, upserted, newVideos, productsUpdated, "
    "pruned, resumedCount, pausedReason, errorSummary, startedAt, finishedAt, "
    "lastHeartbeatAt, createdAt, updatedAt, owner"
)


def _uuid() -> str:
    return uuid.uuid4().hex


def _now_ms() -> int:
    return int(time.time() * 1000)


def _row_to_job(row) -> dict:
    keys = [
        "id", "scopeType", "scopeValue", "status", "trigger", "priority", "totalSlices",
        "doneSlices", "failedSlices", "requests", "fetched", "qualifying", "upserted",
        "newVideos", "productsUpdated", "pruned", "resumedCount", "pausedReason",
        "errorSummary", "startedAt", "finishedAt", "lastHeartbeatAt", "createdAt", "updatedAt",
        "owner",
    ]
    return dict(zip(keys, row))


class Store:
    def __init__(self, db_path: str = config.DB_PATH):
        # v6: check_same_thread=False — Store juga dipakai thread HTTP handler.
        # SEMUA akses diserialisasi lewat self._lock (RLock) — aman lintas thread.
        self.con = sqlite3.connect(db_path, timeout=15, check_same_thread=False)
        self._lock = threading.RLock()
        self.con.execute("PRAGMA journal_mode=WAL")
        self.con.execute("PRAGMA busy_timeout=10000")
        self.con.execute("PRAGMA synchronous=NORMAL")
        self.con.execute("PRAGMA cache_size=-32000")
        self.con.execute("PRAGMA mmap_size=134217728")
        self.con.execute("PRAGMA temp_store=MEMORY")
        self.ensure_schema()

    # ── v7: skema additive (idempotent) ─────────────────────────────────
    def ensure_schema(self):
        """Tambah kolom ScrapeJob.owner bila belum ada — tanpa menunggu prisma db push."""
        cols = [r[1] for r in self.con.execute("PRAGMA table_info(ScrapeJob)").fetchall()]
        if "owner" not in cols:
            self.con.execute("ALTER TABLE ScrapeJob ADD COLUMN owner TEXT")
            self.con.commit()
            print("[store] kolom ScrapeJob.owner ditambahkan (v7)")

    # ══ TrendVideo ══════════════════════════════════════════════════════
    def upsert_videos(self, rows: list[dict]) -> tuple[int, int]:
        """Return (new, updated). Duplikat intra-batch dibuang (per (tiktokId, country))."""
        if not rows:
            return 0, 0
        now_ms = _now_ms()
        dedup: dict[tuple[str, str], dict] = {}
        for r in rows:
            dedup[(r["tiktokId"], r["country"])] = r
        rows = list(dedup.values())

        keys = [(r["tiktokId"], r["country"]) for r in rows]
        existing: set[tuple[str, str]] = set()
        for i in range(0, len(keys), 400):
            chunk = keys[i : i + 400]
            q = ",".join(["(?,?)"] * len(chunk))
            flat = [v for pair in chunk for v in pair]
            cur = self.con.execute(
                f"SELECT tiktokId, country FROM TrendVideo WHERE (tiktokId, country) IN ({q})",
                flat,
            )
            existing.update((row[0], row[1]) for row in cur.fetchall())

        prepared = []
        for r in rows:
            row = dict(r)
            row.setdefault("id", _uuid())
            row.setdefault("authorName", None)
            row.setdefault("authorAvatar", None)
            row.setdefault("comments", 0)
            row.setdefault("shares", 0)
            row.setdefault("productTitle", None)
            row.setdefault("productPriceMin", None)
            row.setdefault("productPriceMax", None)
            row.setdefault("productSold", None)
            row.setdefault("productImage", None)
            row.setdefault("firstSeenAt", now_ms)
            row.setdefault("postedAt", now_ms)
            row["updatedAt"] = now_ms
            row["isShopProduct"] = 1 if row.get("isShopProduct") else 0
            prepared.append(row)

        self.con.executemany(_INSERT_SQL, prepared)
        self.con.commit()
        new = sum(1 for k in keys if k not in existing)
        return new, len(prepared) - new

    def known_pairs(self) -> set[tuple[str, str]]:
        """Set (tiktokId, country) untuk early-stop cerdas — dimuat sekali per job."""
        cur = self.con.execute("SELECT tiktokId, country FROM TrendVideo")
        return {(row[0], row[1]) for row in cur.fetchall()}

    # ── Produk TikTok Shop ──────────────────────────────────────────────
    def pending_product_urls(self, limit: int) -> list[tuple[str, str]]:
        cur = self.con.execute(
            """SELECT DISTINCT shopUrl FROM TrendVideo
               WHERE isShopProduct=1 AND productTitle IS NULL
                 AND shopUrl IS NOT NULL
               LIMIT ?""",
            (limit,),
        )
        urls = [row[0] for row in cur.fetchall()]
        out: list[tuple[str, str]] = []
        seen: set[str] = set()
        for u in urls:
            pid = u.rstrip("/").rsplit("/", 1)[-1]
            if pid and pid not in seen:
                seen.add(pid)
                out.append((pid, u))
        return out

    def update_product(self, pid: str, p: dict) -> int:
        cur = self.con.execute(
            """UPDATE TrendVideo SET
                 productTitle=?, productImage=?, productPriceMin=?,
                 productPriceMax=?, productSold=?, updatedAt=?
               WHERE shopUrl=?""",
            (
                p.get("name"),
                p.get("cover"),
                p.get("minPrice"),
                p.get("maxPrice"),
                p.get("totalSaleCnt"),
                _now_ms(),
                f"https://www.tiktok.com/shop/pdp/{pid}",
            ),
        )
        return cur.rowcount

    def mark_products_missing(self, pids: list[str]) -> int:
        total = 0
        for pid in pids:
            try:
                cur = self.con.execute(
                    "UPDATE TrendVideo SET productTitle='' WHERE shopUrl=? AND productTitle IS NULL",
                    (f"https://www.tiktok.com/shop/pdp/{pid}",),
                )
                total += max(cur.rowcount, 0)
            except Exception:
                continue
        return total

    def commit(self):
        self.con.commit()

    # ── Hygiene ─────────────────────────────────────────────────────────
    def prune_stale(self, days: int = config.PRUNE_DAYS) -> int:
        cutoff = _now_ms() - days * 86400_000
        cur = self.con.execute("DELETE FROM TrendVideo WHERE updatedAt < ?", (cutoff,))
        n = cur.rowcount
        cur2 = self.con.execute(
            "DELETE FROM TrendVideo WHERE sales < ? OR views <= ?",
            (config.MIN_SALES, config.MIN_VIEWS),
        )
        self.con.commit()
        return n + cur2.rowcount

    def total_videos(self) -> int:
        return self.con.execute("SELECT COUNT(*) FROM TrendVideo").fetchone()[0]

    def last_sync_at_ms(self) -> int:
        try:
            row = self.con.execute(
                "SELECT lastSyncAt FROM SyncState WHERE id='singleton'"
            ).fetchone()
            return int(row[0]) if row and row[0] else 0
        except Exception:
            return 0

    # ══ ScrapeJob ═══════════════════════════════════════════════════════
    def create_job(self, scope_type: str, scope_value: str, trigger: str,
                   priority: int = 10) -> dict:
        """v7: insert job 'ready'. Dedup: job aktif (ready/running/held) scope sama
        → return job yang sudah ada. Lihat create_or_unhold_job untuk unhold otomatis."""
        job, _created, _unheld = self.create_or_unhold_job(scope_type, scope_value,
                                                           trigger, priority)
        return job

    def create_or_unhold_job(self, scope_type: str, scope_value: str, trigger: str,
                             priority: int = 10) -> tuple[dict, bool, bool]:
        """v7 scope-command core:
        - tidak ada job aktif utk scope → buat 'ready' (created=True).
        - job 'held' utk scope sama → unhold: 'ready' + prioritas dinaikkan
          (unheld=True) — klik ulang scope yang di-hold = lanjutkan + prioritaskan.
        - job 'ready'/'running' utk scope sama → return apa adanya (dedup).
        Return (job, created, unheld)."""
        with self.con:
            existing = self.con.execute(
                f"""SELECT {_JOB_COLS} FROM ScrapeJob WHERE scopeType=? AND scopeValue=?
                   AND status IN ('ready','running','held') LIMIT 1""",
                (scope_type, scope_value),
            ).fetchone()
            now_ms = _now_ms()
            if existing:
                job = _row_to_job(existing)
                if job["status"] == "held":
                    self.con.execute(
                        """UPDATE ScrapeJob SET status='ready', pausedReason=NULL,
                               priority=MIN(priority, ?), updatedAt=? WHERE id=?""",
                        (priority, now_ms, job["id"]),
                    )
                    job = self._get_job_by_id(job["id"])
                    return job, False, True
                return job, False, False
            self.con.execute(
                """INSERT INTO ScrapeJob (id, scopeType, scopeValue, status, trigger,
                     priority, createdAt, updatedAt, owner)
                   VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?)""",
                (_uuid(), scope_type, scope_value, trigger, priority, now_ms, now_ms,
                 config.INSTANCE_ID),
            )
        row = self.con.execute(
            f"""SELECT {_JOB_COLS} FROM ScrapeJob WHERE scopeType=? AND scopeValue=?
               AND status='ready' ORDER BY createdAt DESC LIMIT 1""",
            (scope_type, scope_value),
        ).fetchone()
        return _row_to_job(row), True, False

    def _get_job_by_id(self, job_id: str) -> dict | None:
        row = self.con.execute(
            f"SELECT {_JOB_COLS} FROM ScrapeJob WHERE id=?", (job_id,)
        ).fetchone()
        return _row_to_job(row) if row else None

    def claim_next_job(self) -> dict | None:
        """v7: ready → running (FIFO by priority lalu createdAt). Set owner=instance.
        Hanya v7 yang melihat 'ready' — zombie tak pernah bisa mengklaim job kita."""
        with self.con:
            row = self.con.execute(
                """SELECT id FROM ScrapeJob WHERE status='ready'
                   ORDER BY priority ASC, createdAt ASC LIMIT 1"""
            ).fetchone()
            if not row:
                return None
            now_ms = _now_ms()
            self.con.execute(
                """UPDATE ScrapeJob SET status='running', startedAt=COALESCE(startedAt, ?),
                       lastHeartbeatAt=?, owner=?, updatedAt=? WHERE id=?""",
                (now_ms, now_ms, config.INSTANCE_ID, now_ms, row[0]),
            )
        return self._get_job_by_id(row[0])

    def next_ready_job(self) -> dict | None:
        """v7: peek job 'ready' berikutnya TANPA mengklaim (untuk cek preemption)."""
        row = self.con.execute(
            f"""SELECT {_JOB_COLS} FROM ScrapeJob WHERE status='ready'
               ORDER BY priority ASC, createdAt ASC LIMIT 1"""
        ).fetchone()
        return _row_to_job(row) if row else None

    def resume_held_job(self) -> dict | None:
        """v7: held → running (resume setelah restart/session/preemption)."""
        with self.con:
            row = self.con.execute(
                """SELECT id FROM ScrapeJob WHERE status='held'
                   ORDER BY priority ASC, createdAt ASC LIMIT 1"""
            ).fetchone()
            if not row:
                return None
            now_ms = _now_ms()
            self.con.execute(
                """UPDATE ScrapeJob SET status='running', pausedReason=NULL,
                       resumedCount=resumedCount+1, lastHeartbeatAt=?, owner=?,
                       updatedAt=? WHERE id=?""",
                (now_ms, config.INSTANCE_ID, now_ms, row[0]),
            )
        job = self._get_job_by_id(row[0])
        print(f"[job] resume {job['id'][:8]} (resumed #{job['resumedCount']}, "
              f"reason sebelumnya: {job.get('pausedReason')})")
        return job

    def hold_job(self, job_id: str, reason: str):
        """v7: running/ready → held (preemption / session human-required).
        'held' TIDAK ada di vocabulary zombie — aman dari resume_paused_job-nya."""
        self.update_job(job_id, status="held", pausedReason=reason[:300])

    def cancel_job(self, job_id: str) -> dict | None:
        """v7: ready/held → cancelled (segera). Job running dibatalkan graceful
        lewat ctx.cancel_requested oleh pemanggil (main.py)."""
        with self.con:
            self.con.execute(
                """UPDATE ScrapeJob SET status='cancelled',
                       errorSummary=COALESCE(errorSummary,'dibatalkan dari UI'),
                       finishedAt=?, updatedAt=?
                   WHERE id=? AND status IN ('ready','held')""",
                (_now_ms(), _now_ms(), job_id),
            )
        return self._get_job_by_id(job_id)

    def promote_job(self, job_id: str) -> dict | None:
        """v7: klik ulang scope yang masih 'ready' → prioritas 0 (didahulukan).
        Return job bila memang 'ready' dan dipromosikan; None bila tidak."""
        with self.con:
            cur = self.con.execute(
                """UPDATE ScrapeJob SET priority=0, trigger='ui', updatedAt=?
                   WHERE id=? AND status='ready'""",
                (_now_ms(), job_id),
            )
            if cur.rowcount <= 0:
                return None
        return self._get_job_by_id(job_id)

    def active_jobs(self) -> list[dict]:
        rows = self.con.execute(
            f"""SELECT {_JOB_COLS} FROM ScrapeJob
                WHERE status IN ('ready','running','held')
                ORDER BY priority ASC, createdAt ASC"""
        ).fetchall()
        return [_row_to_job(r) for r in rows]

    def pause_job(self, job_id: str, reason: str):
        """Legacy name — v7: sama dengan hold_job."""
        self.hold_job(job_id, reason)

    def update_job(self, job_id: str, **fields):
        allowed = {
            "status", "pausedReason", "errorSummary", "startedAt", "finishedAt",
            "lastHeartbeatAt", "totalSlices", "requests", "fetched", "qualifying",
            "upserted", "newVideos", "productsUpdated", "pruned",
        }
        sets, vals = [], []
        for k, v in fields.items():
            if k in allowed:
                sets.append(f"{k}=?")
                vals.append(v)
        if not sets:
            return
        sets.append("updatedAt=?")
        vals.append(_now_ms())
        vals.append(job_id)
        with self.con:
            self.con.execute(f"UPDATE ScrapeJob SET {', '.join(sets)} WHERE id=?", vals)

    def finish_job(self, job_id: str, status: str, error_summary: str | None = None):
        now_ms = _now_ms()
        with self.con:
            self.con.execute(
                """UPDATE ScrapeJob SET status=?, finishedAt=?, errorSummary=?,
                       lastHeartbeatAt=?, updatedAt=? WHERE id=?""",
                (status, now_ms, error_summary, now_ms, now_ms, job_id),
            )

    def list_jobs(self, limit: int = 20) -> list[dict]:
        rows = self.con.execute(
            f"""SELECT {_JOB_COLS} FROM ScrapeJob
                ORDER BY createdAt DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [_row_to_job(r) for r in rows]

    def job_progress(self, job_id: str) -> dict:
        """Progress job dihitung dari slice (tahan restart): count per status."""
        row = self.con.execute(
            """SELECT
                 COUNT(*),
                 SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),
                 SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END),
                 COALESCE(SUM(itemsUpserted), 0)
               FROM ScrapeSlice WHERE lastJobId=?""",
            (job_id,),
        ).fetchone()
        total, done, failed, items = row
        return {
            "total": int(total or 0),
            "done": int(done or 0),
            "failed": int(failed or 0),
            "itemsUpserted": int(items or 0),
        }

    # ══ ScrapeSlice ═════════════════════════════════════════════════════
    def reclaim_stale(self, scope_type: str, scope_value: str) -> int:
        """v7 (RC4 freshness): slice 'done' lebih tua dari TTL bucket-nya → 'ready' lagi.
        Scope-respecting: country job hanya me-reclaim slice negara itu.
        Return jumlah slice basi yang di-refresh."""
        now_ms = _now_ms()
        case = " ".join(
            f"WHEN {bid} THEN {ttl} " for bid, ttl in sorted(config.SLICE_TTL_MS.items())
        )
        where = "1=1" if scope_type in ("global", "retry_failed") else "country=?"
        params: list = [] if scope_type in ("global", "retry_failed") else [scope_value]
        with self.con:
            cur = self.con.execute(
                f"""UPDATE ScrapeSlice SET status='ready', updatedAt=?
                    WHERE status='done'
                      AND (lastSuccessAt IS NULL OR
                           lastSuccessAt < ? - COALESCE(CASE bucket {case} END,
                                                        {6 * 3600_000}))
                      AND {where}""",
                (now_ms, now_ms, *params),
            )
        n = max(cur.rowcount, 0)
        if n:
            print(f"[store] reclaim_stale({scope_type}:{scope_value}) → {n} slice basi di-refresh")
        return n

    def adopt_pending_slices(self) -> int:
        """v7: adopsi slice 'pending' (vocabulary zombie) yang tak disentuh ≥10 mnt
        → 'ready'. Zombie boleh tetap scrape-nya; upsert idempotent."""
        cutoff = _now_ms() - config.ADAPT_PENDING_AFTER_MS
        with self.con:
            cur = self.con.execute(
                """UPDATE ScrapeSlice SET status='ready', updatedAt=?
                   WHERE status='pending' AND updatedAt < ?""",
                (_now_ms(), cutoff),
            )
        return max(cur.rowcount, 0)

    def ensure_slices(self, regions: list[str], categories: list[tuple[str, str]],
                      buckets: list[dict]) -> int:
        """INSERT OR IGNORE semua combo region×kategori×bucket (v7 status 'ready')."""
        now_ms = _now_ms()
        rows = []
        for region in regions:
            for cat_id, cat_name in categories:
                for b in buckets:
                    rows.append((_uuid(), region, str(cat_id), cat_name, int(b["id"]),
                                 "ready", 0, now_ms, now_ms))
        with self.con:
            before = self.con.execute("SELECT COUNT(*) FROM ScrapeSlice").fetchone()[0]
            self.con.executemany(
                """INSERT OR IGNORE INTO ScrapeSlice
                     (id, country, categoryId, categoryName, bucket, status, attempts,
                      createdAt, updatedAt)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                rows,
            )
            after = self.con.execute("SELECT COUNT(*) FROM ScrapeSlice").fetchone()[0]
        return after - before

    def scope_slice_counts(self, scope_type: str, scope_value: str) -> dict:
        """Ringkasan slice per scope (untuk planning job)."""
        where = "1=1" if scope_type in ("global", "retry_failed") else "country=?"
        params: tuple = () if scope_type in ("global", "retry_failed") else (scope_value,)
        rows = self.con.execute(
            f"SELECT status, COUNT(*) FROM ScrapeSlice WHERE {where} GROUP BY status",
            params,
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    def requeue_failed(self, hard_attempts: int = config.SLICE_HARD_ATTEMPTS) -> int:
        """failed→ready (attempts < hard). Slice >= hard → 'dead' (butuh retry manual).
        Dipanggil saat job global baru dibuat — self-healing antar siklus."""
        with self.con:
            cur = self.con.execute(
                """UPDATE ScrapeSlice SET status='dead', updatedAt=?
                   WHERE status='failed' AND attempts >= ?""",
                (_now_ms(), hard_attempts),
            )
            cur2 = self.con.execute(
                """UPDATE ScrapeSlice SET status='ready', updatedAt=?
                   WHERE status='failed' AND attempts < ?""",
                (_now_ms(), hard_attempts),
            )
        return max(cur2.rowcount, 0)

    def requeue_dead(self) -> int:
        """Retry manual dari UI: dead → ready (attempts direset 0)."""
        with self.con:
            cur = self.con.execute(
                "UPDATE ScrapeSlice SET status='ready', attempts=0, lastError=NULL, updatedAt=? "
                "WHERE status='dead'",
                (_now_ms(),),
            )
        return max(cur.rowcount, 0)

    def claim_slices(self, job: dict, limit: int) -> list[dict]:
        """v7: ready → running (priority bucket core dulu; never-scraped duluan).
        'ready' tak pernah diklaim zombie — unit kerja 100% milik v7.
        Aman single-claim: hanya job runner yang memanggil."""
        scope_value = job["scopeValue"]
        where = "1=1" if scope_value == "ALL" else "country=?"
        params: list = [] if scope_value == "ALL" else [scope_value]
        now_ms = _now_ms()
        with self.con:
            rows = self.con.execute(
                f"""SELECT id, country, categoryId, categoryName, bucket FROM ScrapeSlice
                    WHERE status='ready' AND {where}
                    ORDER BY {_BUCKET_RANK_SQL} ASC,
                             (lastSuccessAt IS NULL) DESC, lastSuccessAt ASC
                    LIMIT ?""",
                (*params, limit),
            ).fetchall()
            if not rows:
                return []
            ids = [r[0] for r in rows]
            q = ",".join("?" * len(ids))
            self.con.execute(
                f"""UPDATE ScrapeSlice SET status='running', lastJobId=?, lastError=NULL,
                       updatedAt=? WHERE id IN ({q})""",
                (job["id"], now_ms, *ids),
            )
        return [
            {"id": r[0], "country": r[1], "categoryId": r[2],
             "categoryName": r[3], "bucket": r[4]}
            for r in rows
        ]

    def complete_slice(self, slice_id: str, ok: bool, pages: int, items: int,
                       error: str | None, attempts_used: int):
        now_ms = _now_ms()
        with self.con:
            if ok:
                self.con.execute(
                    """UPDATE ScrapeSlice SET status='done', lastSuccessAt=?, lastError=NULL,
                           pagesScraped=pagesScraped+?, itemsUpserted=itemsUpserted+?,
                           attempts=0, updatedAt=? WHERE id=?""",
                    (now_ms, max(pages, 0), max(items, 0), now_ms, slice_id),
                )
            else:
                status = "dead" if attempts_used >= config.SLICE_HARD_ATTEMPTS else "failed"
                self.con.execute(
                    """UPDATE ScrapeSlice SET status=?, lastError=?, attempts=attempts+?,
                           updatedAt=? WHERE id=?""",
                    (status, (error or "unknown")[:300], attempts_used, now_ms, slice_id),
                )

    def release_slices(self, slice_ids: list[str]):
        """running → ready (shutdown/pause/preempt — slice diambil job berikutnya)."""
        if not slice_ids:
            return
        q = ",".join("?" * len(slice_ids))
        with self.con:
            self.con.execute(
                f"UPDATE ScrapeSlice SET status='ready', updatedAt=? WHERE id IN ({q})",
                (_now_ms(), *slice_ids),
            )

    def release_running_slices(self, job_id: str):
        """v7 safety net: semua slice 'running' milik job → 'ready'
        (dipanggil saat job selesai karena preempt/cancel)."""
        with self.con:
            self.con.execute(
                "UPDATE ScrapeSlice SET status='ready', updatedAt=? "
                "WHERE lastJobId=? AND status='running'",
                (_now_ms(), job_id),
            )

    def slice_status_counts(self) -> dict:
        rows = self.con.execute(
            "SELECT status, COUNT(*) FROM ScrapeSlice GROUP BY status"
        ).fetchall()
        return {r[0]: r[1] for r in rows}

    def per_country_summary(self) -> list[dict]:
        """Freshness per negara — konsumen: /api/meta + realtime UI.
        v7: 'pending' menghitung ready + legacy pending (vocabulary zombie)."""
        rows = self.con.execute(
            """SELECT country,
                     SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),
                     SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END),
                     SUM(CASE WHEN status IN ('ready','pending') THEN 1 ELSE 0 END),
                     MAX(lastSuccessAt),
                     SUM(CASE WHEN status='running' THEN 1 ELSE 0 END)
               FROM ScrapeSlice GROUP BY country ORDER BY country"""
        ).fetchall()
        return [
            {
                "country": r[0],
                "done": int(r[1] or 0),
                "failed": int(r[2] or 0),
                "pending": int(r[3] or 0),
                "running": int(r[5] or 0),
                "lastSuccessAt": int(r[4]) if r[4] else None,
            }
            for r in rows
        ]

    def failed_slices_sample(self, limit: int = 20) -> list[dict]:
        rows = self.con.execute(
            """SELECT country, categoryName, bucket, status, attempts, lastError
               FROM ScrapeSlice WHERE status IN ('failed','dead')
               ORDER BY updatedAt DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [
            {"country": r[0], "category": r[1], "bucket": r[2], "status": r[3],
             "attempts": r[4], "error": r[5]}
            for r in rows
        ]

    # ══ Alert ═══════════════════════════════════════════════════════════
    def insert_alert(self, severity: str, type_: str, message: str,
                     meta: str = "", dedupe_sec: int = 600) -> str | None:
        """Insert alert (dedupe: pesan identik unresolved dalam dedupe_sec → skip).
        Return alert id bila dibuat, None bila ter-dedupe."""
        cutoff = _now_ms() - dedupe_sec * 1000
        dup = self.con.execute(
            """SELECT id FROM Alert WHERE message=? AND resolvedAt IS NULL AND createdAt > ?
               LIMIT 1""",
            (message, cutoff),
        ).fetchone()
        if dup:
            return None
        alert_id = _uuid()
        with self.con:
            self.con.execute(
                """INSERT INTO Alert (id, severity, type, message, meta, createdAt)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (alert_id, severity, type_, message[:1000], meta[:1000], _now_ms()),
            )
        return alert_id

    def resolve_alerts(self, type_: str | None = None, prefix: str | None = None) -> int:
        q = "UPDATE Alert SET resolvedAt=? WHERE resolvedAt IS NULL"
        params: list = [_now_ms()]
        if type_:
            q += " AND type=?"
            params.append(type_)
        if prefix:
            q += " AND message LIKE ?"
            params.append(prefix + "%")
        with self.con:
            cur = self.con.execute(q, params)
        return max(cur.rowcount, 0)

    def list_alerts(self, limit: int = 50, unresolved_only: bool = False) -> list[dict]:
        q = "SELECT id, severity, type, message, meta, createdAt, resolvedAt FROM Alert "
        if unresolved_only:
            q += "WHERE resolvedAt IS NULL "
        q += "ORDER BY createdAt DESC LIMIT ?"
        rows = self.con.execute(q, (limit,)).fetchall()
        return [
            {"id": r[0], "severity": r[1], "type": r[2], "message": r[3], "meta": r[4],
             "createdAt": r[5], "resolvedAt": r[6]}
            for r in rows
        ]

    # ══ Recovery boot ═══════════════════════════════════════════════════
    def recover_boot(self, max_age_ms: int = config.JOB_HEARTBEAT_STALE_MS) -> dict:
        """v7 — bersihkan jejak proses mati + MIGRASI vocabulary satu kali:
        - SyncLog 'running' tua → 'interrupted'
        - SyncState 'syncing' → 'idle'
        - ScrapeSlice 'running'/'pending' → 'ready' (unit kerja milik v7;
          zombie yang kebetulan sedang scrape slice itu tetap selesai — idempotent)
        - ScrapeJob 'queued' → 'cancelled' (legacy; klik ulang scope di UI)
        - ScrapeJob 'paused' → 'held' (milik v7, auto-resume)
        - ScrapeJob 'running' dgn heartbeat basi (> max_age) → 'held';
          running dgn heartbeat SEGAR + owner NULL = job zombie yang masih hidup
          → dibiarkan (zombie menyelesaikannya sendiri)."""
        now_ms = _now_ms()
        cutoff = now_ms - max_age_ms
        out = {}
        cur = self.con.execute(
            """UPDATE SyncLog SET finishedAt=?, status='interrupted',
                 errors='proses mati sebelum siklus selesai (recover boot)'
               WHERE status='running' AND startedAt < ?""",
            (now_ms, cutoff),
        )
        out["synclogs"] = max(cur.rowcount, 0)
        self.con.execute(
            """UPDATE SyncState SET status='idle',
                 lastError=COALESCE(lastError,'sinkron terputus — auto-recover')
               WHERE status='syncing'"""
        )
        cur2 = self.con.execute(
            "UPDATE ScrapeSlice SET status='ready', updatedAt=? WHERE status IN ('running','pending')",
            (now_ms,),
        )
        out["slices"] = max(cur2.rowcount, 0)
        cur3 = self.con.execute(
            """UPDATE ScrapeJob SET status='cancelled',
                   errorSummary='migrasi v7 — pilih scope lagi di UI', updatedAt=?
               WHERE status='queued'""",
            (now_ms,),
        )
        out["jobs_legacy_queued"] = max(cur3.rowcount, 0)
        cur4 = self.con.execute(
            """UPDATE ScrapeJob SET status='held', owner=?,
                   pausedReason='migrasi/restart — auto-resume', updatedAt=?
               WHERE status='paused'""",
            (config.INSTANCE_ID, now_ms),
        )
        out["jobs_legacy_paused"] = max(cur4.rowcount, 0)
        cur5 = self.con.execute(
            """UPDATE ScrapeJob SET status='held', owner=?,
                   pausedReason='restart — auto-resume', updatedAt=?
               WHERE status='running' AND owner=?""",
            (config.INSTANCE_ID, now_ms, config.INSTANCE_ID),
        )
        out["jobs_z_stale"] = max(cur5.rowcount, 0)
        cur6 = self.con.execute(
            """UPDATE ScrapeJob SET status='held', owner=?,
                   pausedReason='restart — auto-resume (heartbeat basi)', updatedAt=?
               WHERE status='running' AND owner IS NULL
                  AND (lastHeartbeatAt IS NULL OR lastHeartbeatAt < ?)""",
            (config.INSTANCE_ID, now_ms, cutoff),
        )
        out["jobs_orphan_stale"] = max(cur6.rowcount, 0)
        self.con.commit()
        if any(out.values()):
            print(f"[store] recovery boot: {out}")
        return out

    # ══ Legacy SyncLog / SyncState (kompatibilitas script/report) ═══════
    def create_sync_log(self, trigger: str) -> str:
        log_id = _uuid()
        with self.con:
            self.con.execute(
                """INSERT INTO SyncLog (id, startedAt, status, trigger)
                   VALUES (?, ?, 'running', ?)""",
                (log_id, _now_ms(), trigger),
            )
        return log_id

    def finish_sync_log(self, log_id: str, status: str, fetched: int, qualifying: int,
                        upserted: int, new_videos: int, requests: int, errors: list[str]):
        with self.con:
            self.con.execute(
                """UPDATE SyncLog SET finishedAt=?, status=?, fetched=?, qualifying=?,
                     upserted=?, newVideos=?, requests=?, errors=? WHERE id=?""",
                (_now_ms(), status, fetched, qualifying, upserted, new_videos,
                 requests, " | ".join(errors[:20])[:4000], log_id),
            )

    def write_sync_state(self, status: str, bump: bool = False,
                         last_error: str | None = None,
                         interval_seconds: int = config.INTERVAL_SECONDS):
        now_ms = _now_ms()
        with self.con:
            if bump:
                self.con.execute(
                    """INSERT INTO SyncState (id, lastSyncAt, nextSyncAt, syncCount, status, lastError)
                       VALUES ('singleton', ?, ?, 1, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET
                         lastSyncAt=?, nextSyncAt=?, syncCount=syncCount+1, status=?, lastError=?""",
                    (now_ms, now_ms + interval_seconds * 1000, status, last_error,
                     now_ms, now_ms + interval_seconds * 1000, status, last_error),
                )
            else:
                self.con.execute(
                    """INSERT INTO SyncState (id, lastSyncAt, nextSyncAt, syncCount, status, lastError)
                       VALUES ('singleton', ?, ?, 0, ?, ?)
                       ON CONFLICT(id) DO UPDATE SET status=?, lastError=?""",
                    (now_ms, now_ms + interval_seconds * 1000, status, last_error,
                     status, last_error),
                )

    def close(self):
        try:
            self.con.close()
        except Exception:
            pass


# ── Serialisasi akses lintas-thread ─────────────────────────────────────
# Semua method publik Store dibungkus RLock: scheduler thread, heartbeat,
# dan HTTP handler berbagi satu koneksi dengan aman (urutan dijamin).
def _synchronized(fn):
    def wrapper(self, *args, **kwargs):
        with self._lock:
            return fn(self, *args, **kwargs)
    wrapper.__name__ = fn.__name__
    wrapper.__doc__ = fn.__doc__
    return wrapper


for _name in list(vars(Store)):
    _fn = getattr(Store, _name)
    if callable(_fn) and not _name.startswith("__"):
        setattr(Store, _name, _synchronized(_fn))
