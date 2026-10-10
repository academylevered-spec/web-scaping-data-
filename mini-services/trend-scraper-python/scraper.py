"""
Mesin scraping v6 — job-based:
  run_job(client, store, session_mgr, job) — orchestrator:
    1. Discovery dinamis (region/kategori) — cache, fallback, alert perubahan
    2. ensure_slices (persisten: negara×kategori×bucket) + requeue failed
    3. SliceQueue: paralel + retry pasien + circuit breaker + budget/deadline
    4. Enrichment produk (budget sendiri)
    5. Hygiene (prune), finish job, SyncLog legacy

Catatan threading: akses SQLite hanya dari thread pemanggil run_job.
"""
import random
import time
import traceback
from threading import Lock

import config
import discovery
from creatok import CreatoKClient
from parseutil import parse_count, video_id_from_url, duration_to_sec, extract_hashtags, compute_score
from store import Store


class CycleContext:
    """Konteks 1 job — budget, deadline, counter thread-safe.
    v7: preempted / cancel_requested — diset thread preemptor (main.py) saat
    job scope lain yang lebih prioritas masuk atau user membatalkan."""

    def __init__(self, job: dict, buckets: list[dict]):
        self.job = job
        self.trigger = job.get("trigger", "manual")
        self.buckets = buckets
        self.started_at = time.time()
        self.now = int(self.started_at)
        self.soft_deadline = self.started_at + config.JOB_SOFT_DEADLINE_MIN * 60
        self.hard_deadline = self.started_at + config.JOB_HARD_DEADLINE_MIN * 60
        self.lock = Lock()
        self.requests = 0
        self.fetched = 0
        self.qualifying = 0
        self.upserted = 0
        self.new_videos = 0
        self.combos = 0
        self.products_updated = 0
        self.products_looked = 0
        self.products_missing_total = 0
        self.pruned = 0
        self.errors: list[str] = []
        self.pages_saved = 0
        self.phase = "scraping"
        self.product_requests = 0
        self.products_aborted = False
        # v6: soft_stop = stop DEQUEUE (in-flight selesai, slice sisa tetap ready)
        self.soft_stop = False
        self.aborted_budget = False
        # v7: preemption & cancellation (graceful — slice kembali 'ready')
        self.preempted = False
        self.preempt_reason: str | None = None
        self.cancel_requested = False

    def bucket_by_id(self, bucket_id: int) -> dict | None:
        for b in self.buckets:
            if b["id"] == bucket_id:
                return b
        return None

    def add_request(self, n: int = 1) -> bool:
        """Akuntansi request sweep. True bila budget/deadline/preempt tercapai."""
        with self.lock:
            self.requests += n
            if self.requests >= config.MAX_REQUESTS_PER_CYCLE:
                self.aborted_budget = True
            if time.time() > self.hard_deadline or time.time() > self.soft_deadline:
                self.soft_stop = True
            return self.aborted_budget or self.soft_stop or self.preempted or self.cancel_requested

    def add_product_request(self, n: int = 1) -> bool:
        with self.lock:
            self.product_requests += n
            self.requests += n
            pdl = getattr(self, "products_deadline", self.hard_deadline)
            if self.product_requests >= config.PRODUCT_MAX_REQUESTS or \
                    time.time() > pdl or time.time() > self.hard_deadline:
                self.products_aborted = True
            return self.products_aborted


def build_row(item: dict, region: str, category_name: str, t_min: int, t_max: int,
              bucket_id: int) -> dict | None:
    """Item API → baris DB. None bila tak lolos filter kualitas."""
    video_url = item.get("video_url") or ""
    tiktok_id = video_id_from_url(video_url) or str(item.get("id") or "")
    if not tiktok_id:
        return None

    views = parse_count(item.get("views"))
    sales = int(item.get("salesCount") or 0)

    # ATURAN WAJIB: sales >= 10 & views > 10.000 (strictly >)
    if sales < config.MIN_SALES or views <= config.MIN_VIEWS:
        return None

    likes = parse_count(item.get("likes"))
    gmv = float(item.get("salesGmv") or 0)
    duration_sec = duration_to_sec(item.get("duration"))
    product_ids = [p for p in (item.get("productIds") or []) if p]
    product_id = product_ids[0] if product_ids else None
    caption = item.get("caption") or ""

    return {
        "tiktokId": tiktok_id,
        "videoUrl": video_url,
        "authorHandle": item.get("uniqueId") or "",
        "authorAvatar": item.get("avatar") or None,
        "thumbnail": item.get("thumbnail") or "",
        "caption": caption,
        "hashtags": extract_hashtags(caption),
        "country": region,
        "category": category_name,
        "sourceCategory": category_name,
        "duration": item.get("duration") or "00:00",
        "durationSec": duration_sec,
        "views": views,
        "likes": likes,
        "sales": sales,
        "gmv": gmv,
        "trafficType": "ads" if item.get("isAd") else "organic",
        "isShopProduct": bool(product_id),
        "shopUrl": f"https://www.tiktok.com/shop/pdp/{product_id}" if product_id else None,
        "trendingScore": compute_score(views, likes, sales, gmv, duration_sec),
        "createTimeMin": t_min,
        "createTimeMax": t_max,
        "windowBucket": bucket_id,
    }


def _bucket_bounds(bucket: dict, now: int) -> tuple[int, int]:
    t_max = now - int(bucket["min_days"] * 86400)
    t_min = now - int(bucket["max_days"] * 86400)
    return t_min, t_max


def scrape_combo(
    client: CreatoKClient, ctx: CycleContext,
    region: str, cat_id: str, cat_name: str, bucket: dict, now: int,
    known_pairs: set | None = None,
) -> dict:
    """Worker murni (tanpa DB): scrape 1 combo region×kategori×bucket.

    v6: known_pairs = set[(tiktokId, country)] — early-stop per negara.
    Return: {fetched, qualifying, rows, errors, pages_ok, pages_saved}
      pages_ok = jumlah halaman sukses (slice dianggap gagal bila 0 hard-fail).
    """
    out = {"fetched": 0, "qualifying": 0, "rows": [], "errors": [],
           "pages_ok": 0, "pages_saved": 0}
    t_min, t_max = _bucket_bounds(bucket, now)
    low_pages = 0
    skip_early_stop = bucket["id"] in config.EARLY_STOP_SKIP_BUCKET_IDS

    for page in range(1, bucket["max_pages"] + 1):
        if ctx.add_request(0):
            out["errors"].append("budget/deadline")
            break
        path = (
            f"/app/api/trending?pageNum={page}&pageSize={config.PAGE_SIZE}"
            f"&region={region}&contentType=all&salesFlag=withSales&createdByAi=false"
            f"&product_category_id={cat_id}&minCreateTime={t_min}&maxCreateTime={t_max}"
        )
        res = client.get_json(path)
        ctx.add_request(1)

        if not res or res.get("code") != 0:
            out["errors"].append(f"p{page}: bad response")
            break  # halaman gagal → sisa pagination dibatalkan (retry level slice)

        items = res.get("data") or []
        out["fetched"] += len(items)
        out["pages_ok"] += 1

        rows = []
        for item in items:
            row = build_row(item, region, cat_name, t_min, t_max, bucket["id"])
            if row:
                rows.append(row)
        out["qualifying"] += len(rows)
        out["rows"].extend(rows)

        # Early-stop cerdas berbasis known pairs (per negara — anti kontaminasi)
        if (
            known_pairs is not None
            and not skip_early_stop
            and page >= config.EARLY_STOP_MIN_PAGE
            and rows
        ):
            known_hits = sum(1 for r in rows if (r["tiktokId"], region) in known_pairs)
            if known_hits / len(rows) >= config.EARLY_STOP_KNOWN_RATIO:
                out["pages_saved"] = bucket["max_pages"] - page
                break

        if len(items) < config.PAGE_SIZE:
            break  # halaman terakhir
        if len(rows) == 0:
            break  # ekor tidak lolos filter kualitas
        if len(rows) < config.PAGE_SIZE * 0.25:
            low_pages += 1
            if low_pages >= 2:
                break
        else:
            low_pages = 0

    return out


def enrich_products(client: CreatoKClient, store: Store, ctx: CycleContext):
    """Detail produk (judul/harga/terjual/cover) — budget waktu & request sendiri."""
    from concurrent.futures import ThreadPoolExecutor

    ctx.phase = "products"
    ctx.aborted_budget = False  # fase produk diberi kesempatan penuh
    ctx.products_deadline = time.time() + config.PRODUCT_PHASE_MINUTES * 60  # budget waktu sendiri
    pending = store.pending_product_urls(config.MAX_PRODUCT_LOOKUPS)
    ctx.products_looked = len(pending)
    print(f"[products] {len(pending)} produk unik perlu detail")

    batches = [pending[i : i + config.PRODUCT_BATCH]
               for i in range(0, len(pending), config.PRODUCT_BATCH)]

    def fetch_batch(batch):
        if ctx.products_aborted:
            return None
        res = client.get_json(
            f"/app/api/product/batch-detail?product_ids={','.join(pid for pid, _ in batch)}"
        )
        ctx.add_product_request(1)
        return res

    with ThreadPoolExecutor(max_workers=config.WORKERS) as pool:
        for res, batch in zip(pool.map(fetch_batch, batches), batches):
            if not res or res.get("code") != 0 or not res.get("data"):
                if ctx.products_aborted:
                    break
                continue
            data = res.get("data") or {}
            for pid, detail in data.items():
                if detail and detail.get("productId"):
                    ctx.products_updated += store.update_product(pid, detail)
            missing = [pid for pid, _ in batch if pid not in data]
            if missing:
                ctx.products_missing_total += store.mark_products_missing(missing)
            store.commit()
            if ctx.products_aborted:
                break
    ctx.phase = "scraping"
    print(f"[products] selesai — {ctx.products_updated} video ter-update, req={ctx.product_requests}")


def run_job(client: CreatoKClient, store: Store, session_mgr, job: dict,
            breaker=None, on_ctx=None) -> dict:
    """Jalankan 1 ScrapeJob end-to-end. Return result dict (untuk status.json).
    on_ctx: callback(ctx|None) — memberi akses CycleContext ke heartbeat utama."""
    from slice_queue import SliceQueue, CircuitBreaker  # import lokal (anti siklus)

    # CATATAN v6.1: recover_boot() TIDAK dipanggil di sini — hanya di boot main().
    # (Bug v6.0: recover di sini menandai job yang BARU diklaim (status='running')
    #  sebagai 'paused' — job tetap jalan tapi statusnya salah di UI.)
    log_id = store.create_sync_log(job.get("trigger", "manual"))
    store.write_sync_state("syncing")
    scope_label = "GLOBAL" if job["scopeValue"] == "ALL" else job["scopeValue"]
    print(f"[job] === MULAI {job['id'][:8]} scope={job['scopeType']}:{scope_label} "
          f"trigger={job['trigger']} resume#{job.get('resumedCount', 0)} ===")

    result: dict = {
        "jobId": job["id"], "scopeType": job["scopeType"], "scopeValue": job["scopeValue"],
        "ok": False, "error": None, "phase": "scraping",
        "startedAtMs": int(time.time() * 1000),
    }
    try:
        # ── 1. Sesi ──
        if not session_mgr.ensure_ready():
            raise RuntimeError("sesi tidak siap (human-required atau login gagal)")

        # ── 2. Discovery dinamis ──
        disc = discovery.refresh(client, store)
        regions: list[str] = list(disc.regions) or list(config.FALLBACK_REGIONS)
        categories: list[tuple[str, str]] = disc.categories or list(config.FALLBACK_CATEGORIES)

        # ── Blocklist region (config.EXCLUDED_REGIONS) — saring SEBELUM apapun ──
        regions = [r for r in regions if r not in config.EXCLUDED_REGIONS]

        if job["scopeType"] == "country":
            if job["scopeValue"] in config.EXCLUDED_REGIONS:
                raise RuntimeError(
                    f"Negara '{job['scopeValue']}' dinonaktifkan pemilik "
                    f"(EXCLUDED_REGIONS) — scrape dibatalkan."
                )
            if job["scopeValue"] not in regions:
                store.insert_alert(
                    "warning", "data",
                    f"Scope negara '{job['scopeValue']}' tidak ada di daftar discovery sumber "
                    f"({len(regions)} region). Scrape tetap dicoba.",
                )
            regions = [job["scopeValue"]]
        else:
            random.shuffle(regions)  # fairness rotasi antar siklus

        buckets = list(config.BUCKETS) + list(config.DAILY_BUCKETS)

        # ── 3. Persisten slice + requeue failed (self-healing antar job) ──
        created = store.ensure_slices(regions, categories, buckets)
        if created:
            print(f"[job] {created} slice baru didaftarkan (region/kategori/bucket baru)")
        if job["scopeType"] == "global":
            requeued = store.requeue_failed()
            if requeued:
                print(f"[job] {requeued} slice failed direqueue (self-heal)")

        # ── v7 (RC4): reclaim slice 'done' yang sudah basi (sesuai scope) —
        # data segar dipakai ulang, hanya yang basi di-refresh.
        store.reclaim_stale(job["scopeType"], job["scopeValue"])

        counts = store.scope_slice_counts(job["scopeType"], job["scopeValue"])
        pending_total = counts.get("ready", 0)
        result["pendingSlices"] = pending_total
        print(f"[job] slice scope: {counts} — ready={pending_total}")

        if pending_total == 0:
            result.update(ok=True, phase="done", note="semua slice scope ini sudah fresh",
                          finishedAtMs=int(time.time() * 1000))
            store.finish_job(job["id"], "completed", None)
            store.finish_sync_log(log_id, "success", 0, 0, 0, 0, 0, [])
            store.write_sync_state("idle", bump=True)
            return result

        known = store.known_pairs()
        print(f"[job] known-pairs dimuat: {len(known)} (video×negara)")

        ctx = CycleContext(job, buckets)
        if on_ctx:
            on_ctx(ctx)
        q = SliceQueue(client, store, ctx, session_mgr=session_mgr,
                       breaker=breaker or CircuitBreaker(store))
        summary = q.run(known)
        print(f"[job] queue selesai: {summary}")

        # ── v7: PREEMPT / CANCEL — selesai cepat tanpa fase produk.
        # Semua slice claimed sudah diamankan SliceQueue (done/failed/release).
        if ctx.preempted or ctx.cancel_requested:
            store.release_running_slices(job["id"])
            remaining = store.scope_slice_counts(job["scopeType"], job["scopeValue"]).get("ready", 0)
            if ctx.cancel_requested:
                store.finish_job(job["id"], "cancelled", "dibatalkan — scope diganti/dicancel UI")
                store.finish_sync_log(log_id, "partial", ctx.fetched, ctx.qualifying,
                                      ctx.upserted, ctx.new_videos, ctx.requests, ctx.errors)
                store.write_sync_state("idle", bump=False, last_error="cancelled")
                if on_ctx:
                    on_ctx(None)
                result.update({"ok": True, "phase": "cancelled",
                               "error": None, "cancelled": True,
                               "finishedAtMs": int(time.time() * 1000),
                               "doneSlices": summary["done"], "failedSlices": summary["failed"],
                               "remainingSlices": remaining})
                print(f"[job] CANCELLED — done={summary['done']} remaining={remaining}")
                return result
            reason = ctx.preempt_reason or "preempted oleh job prioritas lebih tinggi"
            store.hold_job(job["id"], reason)
            store.finish_sync_log(log_id, "partial", ctx.fetched, ctx.qualifying,
                                  ctx.upserted, ctx.new_videos, ctx.requests, ctx.errors)
            store.write_sync_state("idle", bump=False, last_error=f"hold: {reason}")
            if on_ctx:
                on_ctx(None)
            result.update({"ok": True, "phase": "held", "error": None,
                           "held": True, "heldReason": reason,
                           "finishedAtMs": int(time.time() * 1000),
                           "doneSlices": summary["done"], "failedSlices": summary["failed"],
                           "remainingSlices": remaining})
            print(f"[job] HELD (preempt: {reason}) — done={summary['done']} remaining={remaining}")
            return result

        # ── 4. Produk ──
        enrich_products(client, store, ctx)

        # ── 5. Hygiene + finish ──
        ctx.pruned = store.prune_stale()

        remaining = store.scope_slice_counts(job["scopeType"], job["scopeValue"]).get("ready", 0)
        prog = store.job_progress(job["id"])
        ok = (summary["done"] + prog["done"]) > 0
        err_summary = None
        if summary["failed"] or remaining:
            err_summary = (f"{summary['failed']} slice gagal, {remaining} slice ready "
                           f"(dilanjutkan job berikutnya)")

        # Session turun mid-job → HELD (bukan completed) agar auto-resume saat pulih
        session_down = session_mgr is not None and not session_mgr.is_healthy()
        if session_down and (summary.get("stopped", 0) or remaining):
            store.hold_job(job["id"], "session human-required — auto-resume saat pulih")
            store.finish_sync_log(log_id, "partial", ctx.fetched, ctx.qualifying,
                                  ctx.upserted, ctx.new_videos, ctx.requests, ctx.errors)
            store.write_sync_state("idle", bump=False, last_error="hold: session human-required")
            if on_ctx:
                on_ctx(None)
            result.update({"ok": False, "phase": "held",
                           "error": "session human-required — job di-hold, auto-resume saat pulih",
                           "finishedAtMs": int(time.time() * 1000),
                           "doneSlices": summary["done"], "failedSlices": summary["failed"],
                           "remainingSlices": remaining})
            print(f"[job] HELD (session) — done={summary['done']} remaining={remaining}")
            return result

        store.finish_job(job["id"], "completed" if ok else "failed", err_summary)
        store.finish_sync_log(log_id, "success" if ok else "partial",
                              ctx.fetched, ctx.qualifying, ctx.upserted,
                              ctx.new_videos, ctx.requests, ctx.errors)
        store.write_sync_state("idle" if ok else "partial", bump=True,
                               last_error=err_summary)
        ctx.phase = "done"
        if on_ctx:
            on_ctx(None)
        result.update({
            "ok": ok, "phase": "done", "error": err_summary,
            "finishedAtMs": int(time.time() * 1000),
            "durationMs": int((time.time() - ctx.started_at) * 1000),
            "requests": ctx.requests, "fetched": ctx.fetched,
            "qualifying": ctx.qualifying, "upserted": ctx.upserted,
            "newVideos": ctx.new_videos, "doneSlices": summary["done"],
            "failedSlices": summary["failed"], "remainingSlices": remaining,
            "stoppedSlices": summary.get("stopped", 0),
            "productsUpdated": ctx.products_updated, "pruned": ctx.pruned,
            "errors": ctx.errors[:10],
        })
        print(f"[job] === SELESAI ok={ok} done={summary['done']} failed={summary['failed']} "
              f"remaining={remaining} new={ctx.new_videos} req={ctx.requests} "
              f"durasi={time.time()-ctx.started_at:.0f}s ===")
        return result

    except Exception as e:
        err = str(e)
        traceback.print_exc(limit=3)
        if on_ctx:
            on_ctx(None)
        try:
            store.finish_job(job["id"], "failed", err[:300])
            store.finish_sync_log(log_id, "error", 0, 0, 0, 0, 0, [err[:300]])
            store.write_sync_state("error", bump=True, last_error=str(e)[:300])
        except Exception:
            pass
        result.update(ok=False, error=err[:300], phase="error",
                      finishedAtMs=int(time.time() * 1000))
        print(f"[job] ERROR: {err[:300]}")
        return result
