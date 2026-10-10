"""
SliceQueue v7 — worker pool paralel per slice dengan:
- Retry PASIEN per slice (SLICE_MAX_ATTEMPTS, backoff 2/6/15s + jitter).
- Circuit breaker per-REQUEST (callback dari CreatoKClient): window bergulir;
  v7: OPEN HANYA saat COLLAPSE nyata (rasio gagal ≥ 0.9 pada window penuh).
  Bukti diagnosis: sumber gagal ~50% request secara acak — breaker v6 (0.6) membuka
  terus-menerus dan bot lebih banyak menunggu daripada scrape.
- Budget & deadline per job: soft deadline → stop DEQUEUE (in-flight selesai,
  slice sisa TETAP READY utk job berikutnya — tidak ada data terbuang).
- PREEMPTION v7: ctx.preempted → stop dequeue + worker neutral-stop secepatnya;
  slice in-flight/pending dikembalikan 'ready' (tanpa penalti) → job lain jalan.
- Session-aware: human_required → pause dequeue.
- "Neutral stop": slice yang terputus oleh budget/circuit/session/preempt
  dikembalikan ke 'ready' TANPA penalti attempts (bukan failure).
- SQLite HANYA dari thread utama (worker murni; upsert di main thread).

CATATAN: nama file slice_queue.py (BUKAN queue.py) agar tidak membayangi
modul stdlib `queue` yang dipakai concurrent.futures.
"""
import random
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from threading import Lock

import config
from scraper import scrape_combo


class CircuitBreaker:
    """Proteksi sumber: window bergulir hasil request (5xx/429/timeout = gagal)."""

    def __init__(self, store=None):
        self._lock = Lock()
        self._window: deque[bool] = deque(maxlen=config.CIRCUIT_WINDOW)
        self.state = "closed"          # closed | open | half_open
        self.opened_at = 0.0
        self.open_count = 0
        self._probe_ok = 0
        self._last_alert_at = 0.0
        self.store = store

    def record(self, ok: bool):
        """Callback per-request dari CreatoKClient."""
        with self._lock:
            if self.state == "open":
                return  # tidak seharusnya ada request saat open
            if self.state == "half_open":
                if ok:
                    self._probe_ok += 1
                    if self._probe_ok >= 3:
                        self.state = "closed"
                        self._window.clear()
                        print("[circuit] CLOSED — sumber pulih")
                else:
                    self.state = "open"
                    self.opened_at = time.time()
                    print("[circuit] probe gagal → OPEN lagi")
                return
            # closed
            self._window.append(ok)
            fails = sum(1 for x in self._window if not x)
            # v7: OPEN hanya saat collapse — window PENUH + rasio ≥ threshold.
            # Dengan p(500)≈0.5 kronis, rasio 0.9 praktis tak pernah tercapai;
            # saat sumber benar-benar down (semua gagal), breaker terbuka cepat.
            if len(self._window) >= config.CIRCUIT_WINDOW and \
                    fails / len(self._window) >= config.CIRCUIT_FAIL_RATIO:
                self.state = "open"
                self.opened_at = time.time()
                self.open_count += 1
                self._window.clear()
                print(f"[circuit] OPEN #{self.open_count} — sumber COLLAPSE "
                      f"(rasio gagal ≥ {config.CIRCUIT_FAIL_RATIO:.0%}), "
                      f"cooldown {config.CIRCUIT_OPEN_SEC}s")
                if self.store and time.time() - self._last_alert_at > config.CIRCUIT_ALERT_COOLDOWN_SEC:
                    self._last_alert_at = time.time()
                    try:
                        self.store.insert_alert(
                            "warning", "source",
                            "Sumber creatok.ai collapse (rasio error sangat tinggi) — circuit "
                            f"breaker OPEN, scrape dijeda {config.CIRCUIT_OPEN_SEC}s lalu probe otomatis.",
                            dedupe_sec=config.CIRCUIT_ALERT_COOLDOWN_SEC,
                        )
                    except Exception:
                        pass

    def allow(self) -> bool:
        with self._lock:
            if self.state == "closed":
                return True
            if self.state == "open":
                if time.time() - self.opened_at >= config.CIRCUIT_OPEN_SEC:
                    self.state = "half_open"
                    self._probe_ok = 0
                    print("[circuit] HALF-OPEN — probe dievaluasi")
                    return True
                return False
            return True  # half_open

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "openCount": self.open_count,
                "windowSize": len(self._window),
                "failRatio": round(sum(1 for x in self._window if not x) / len(self._window), 2)
                if self._window else 0.0,
            }


class SliceQueue:
    def __init__(self, client, store, ctx, session_mgr=None,
                 breaker: CircuitBreaker | None = None):
        self.client = client
        self.store = store
        self.ctx = ctx
        self.session_mgr = session_mgr
        self.breaker = breaker or CircuitBreaker(store)
        self.client.breaker_cb = self.breaker.record  # per-request signal

    # ── Worker murni (tanpa DB): retry pasien per slice ─────────────────
    def _work_slice(self, slice_: dict, known_pairs: set) -> dict:
        bucket = self.ctx.bucket_by_id(slice_["bucket"])
        if bucket is None:
            return {"slice": slice_, "ok": False, "stopped": False, "pages": 0,
                    "items": 0, "fetched": 0, "qualifying": 0, "rows": [],
                    "error": f"bucket {slice_['bucket']} tidak dikenal", "attempts": 1}

        out = {"slice": slice_, "ok": False, "stopped": False, "pages": 0,
               "fetched": 0, "qualifying": 0, "rows": [], "error": None, "attempts": 0}
        delays = list(config.SLICE_RETRY_DELAYS)

        for attempt in range(1, config.SLICE_MAX_ATTEMPTS + 1):
            # Neutral-stop check (budget/deadline/session/circuit/PREEMPT)
            if self.ctx.soft_stop or self.ctx.aborted_budget or getattr(self.ctx, "preempted", False):
                out["stopped"] = True
                out["error"] = "stop (budget/deadline/preempt)"
                return out
            if self.session_mgr and not self.session_mgr.is_healthy():
                out["stopped"] = True
                out["error"] = "stop (session human-required)"
                return out

            # Circuit open → tunggu (maks 3× cooldown) lalu neutral-stop
            waited = 0.0
            while not self.breaker.allow():
                if self.ctx.soft_stop or self.ctx.aborted_budget or getattr(self.ctx, "preempted", False):
                    out["stopped"] = True
                    out["error"] = "stop (circuit+preempt/budget)"
                    return out
                time.sleep(2)
                waited += 2
                if waited > config.CIRCUIT_OPEN_SEC * 3:
                    out["stopped"] = True
                    out["error"] = "stop (circuit terlalu lama)"
                    return out

            out["attempts"] = attempt
            # reset akumulasi per attempt (attempt baru = scrape ulang dari halaman 1)
            rows: list = []
            fetched = qualifying = pages_ok = 0
            errors: list[str] = []
            try:
                res = scrape_combo(
                    self.client, self.ctx, slice_["country"], slice_["categoryId"],
                    slice_["categoryName"], bucket, self.ctx.now,
                    known_pairs=known_pairs,
                )
            except Exception as e:  # worker crash-proof
                res = {"fetched": 0, "qualifying": 0, "rows": [],
                       "errors": [f"worker exc: {str(e)[:120]}"], "pages_ok": 0,
                       "pages_saved": 0}

            rows = res.get("rows") or []
            fetched = res.get("fetched", 0)
            qualifying = res.get("qualifying", 0)
            pages_ok = res.get("pages_ok", 0)
            errors = res.get("errors") or []

            hard_failed = any("bad response" in e for e in errors)
            neutral = any(("budget/deadline" in e) or ("budget habis" in e) for e in errors) \
                or self.ctx.soft_stop or self.ctx.aborted_budget \
                or getattr(self.ctx, "preempted", False)

            for err in errors:
                self.ctx.errors.append(f"{slice_['country']}/{slice_['categoryName']}/"
                                       f"b{slice_['bucket']}: {err[:120]}")

            if neutral:
                out.update(stopped=True, error="stop (budget/deadline mid-scrape)",
                           pages=pages_ok, fetched=fetched, qualifying=qualifying, rows=rows)
                return out

            if not hard_failed:
                out.update(ok=True, pages=pages_ok, fetched=fetched,
                           qualifying=qualifying, rows=rows, error=None)
                return out

            # hard failure → backoff pasien + jitter, kecuali attempt terakhir
            if attempt < config.SLICE_MAX_ATTEMPTS:
                delay = delays[min(attempt - 1, len(delays) - 1)] + random.uniform(0, 3)
                print(f"[queue] slice {slice_['country']}/{slice_['categoryName']}/"
                      f"b{slice_['bucket']} gagal (attempt {attempt}) — retry {delay:.0f}s")
                time.sleep(delay)

        out["error"] = f"bad response setelah {out['attempts']} attempt"
        return out

    # ── Loop utama (satu-satunya yang menyentuh Store) ──────────────────
    def run(self, known_pairs: set) -> dict:
        summary = {"done": 0, "failed": 0, "stopped": 0, "pages": 0, "items": 0}
        inflight: dict = {}
        pool = ThreadPoolExecutor(max_workers=config.WORKERS)
        last_hb = 0.0
        try:
            while True:
                # heartbeat job (main thread — satu-satunya yang boleh pegang Store di loop ini)
                if time.time() - last_hb > 30:
                    last_hb = time.time()
                    try:
                        self.store.update_job(self.ctx.job["id"],
                                              lastHeartbeatAt=int(time.time() * 1000))
                    except Exception:
                        pass
                # ── Kondisi stop dequeue ──
                if self.ctx.soft_stop:
                    print("[queue] soft deadline — stop dequeue (in-flight diselesaikan)")
                    break
                if getattr(self.ctx, "preempted", False):
                    print("[queue] PREEMPTED — stop dequeue (sisa slice kembali 'ready')")
                    break
                if self.session_mgr and not self.session_mgr.is_healthy():
                    print("[queue] session human-required — stop dequeue")
                    break

                capacity = max(0, config.WORKERS * 2 - len(inflight))

                claimed = False
                claim_attempted = False
                if capacity > 0 and not self.ctx.aborted_budget:
                    if self.breaker.allow():
                        batch = self.store.claim_slices(self.ctx.job, capacity)
                        for s in batch:
                            inflight[s["id"]] = pool.submit(self._work_slice, s, known_pairs)
                        claimed = bool(batch)
                        claim_attempted = True

                # ── Kumpulkan hasil selesai ──
                done_ids = []
                for fut_id, fut in list(inflight.items()):
                    if not fut.done():
                        continue
                    done_ids.append(fut_id)
                    try:
                        out = fut.result()
                    except Exception as e:
                        out = {"slice": {"id": fut_id}, "ok": False, "stopped": False,
                               "pages": 0, "items": 0, "fetched": 0, "qualifying": 0,
                               "rows": [], "error": str(e)[:200], "attempts": 1}
                    self._apply_result(out, summary)
                for sid in done_ids:
                    inflight.pop(sid, None)

                if not inflight and not claimed:
                    if claim_attempted:
                        break  # tidak ada slice tersisa untuk scope → selesai
                    if self.ctx.aborted_budget:
                        break  # budget habis & tak ada in-flight
                    time.sleep(1)  # circuit open / kapasitas 0 → tunggu
                    continue

                time.sleep(0.05)
        finally:
            pool.shutdown(wait=True)
            for fut_id, fut in list(inflight.items()):
                try:
                    out = fut.result(timeout=300)
                    self._apply_result(out, summary)
                except Exception:
                    self.store.complete_slice(fut_id, False, 0, 0, "worker lost", 1)

        return summary

    def _apply_result(self, out: dict, summary: dict):
        rows = out.get("rows") or []
        items = 0
        if out.get("stopped"):
            # neutral stop → kembalikan ke pending TANPA penalti attempt
            self.store.release_slices([out["slice"]["id"]])
            summary["stopped"] += 1
        else:
            new = updated = 0
            if rows:
                new, updated = self.store.upsert_videos(rows)
            items = new + updated
            self.store.complete_slice(
                out["slice"]["id"], out["ok"], out.get("pages", 0), items,
                out.get("error"), out.get("attempts", 1),
            )
            if out["ok"]:
                summary["done"] += 1
            else:
                summary["failed"] += 1
            with self.ctx.lock:
                self.ctx.upserted += items
                self.ctx.new_videos += new
        with self.ctx.lock:
            self.ctx.fetched += out.get("fetched", 0)
            self.ctx.qualifying += out.get("qualifying", 0)
            self.ctx.pages_saved += out.get("pages", 0)
        summary["pages"] += out.get("pages", 0)
        summary["items"] += items
