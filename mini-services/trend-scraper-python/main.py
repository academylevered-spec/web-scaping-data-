"""
TrendScraper service v7 "scope-command" — berjalan 24/7:
  • HTTP server port 4020:
      GET  /health            — liveness
      GET  /status            — status ringkas (kompatibel v5)
      GET  /snapshot          — keadaan penuh (jobs, queue, slices, session, alerts, metrics)
      POST /jobs              — enqueue/unhold job scope-driven {scopeType:'global'|'country', scopeValue}
      GET  /jobs              — daftar job terakhir
      POST /jobs/cancel       — batalkan job {id} (ready/held langsung; running graceful)
      POST /jobs/promote      — prioritas-kan job ready {id} (klik ulang UI)
      POST /jobs/retry-failed — requeue slice dead (retry manual dari UI)
      POST /alerts/resolve    — tandai alert resolved
      POST /trigger           — LEGACY: enqueue global job (dipakai /api/sync lama)
  • Scheduler drift-proof + PREEMPTION (v7):
      - boot → recover (resume job/slice dari proses mati)
      - klik UI (priority 0) MENDAHULUI job berjalan: thread preemptor menandai
        ctx.preempted → queue berhenti elegan, slice kembali 'ready', job → 'held',
        job prioritas tinggi langsung jalan; held auto-resume setelahnya.
      - freshness TTL: data segar dipakai ulang, hanya slice basi di-refresh.
  • Zombie isolation: vocabulary status v7 (ready/held) tak pernah disentuh proses
    v6 zombie (owner=INSTANCE_ID); slice 'pending' buatan zombie diadopsi berkala.
  • Session resilience: re-login otomatis; gagal berulang → human_required → job hold
    + alert; recovery loop login tiap 5 mnt; pulih → auto-resume.
  • status.json: ditulis saat job mulai (running=true), heartbeat 30 dtk, dan selesai.
"""
import json
import os
import signal
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import config
import discovery
from creatok import CreatoKClient
from scraper import CycleContext, run_job
from session import SessionManager
from slice_queue import CircuitBreaker
from store import Store

STARTED_AT = time.time()

# state global proses (dilindungi lock)
state = {
    "running": False,          # ada job yang sedang dieksekusi
    "current_job": None,       # dict job berjalan
    "ctx": None,               # CycleContext berjalan (heartbeat)
    "last_result": None,       # result job terakhir
    "next_run_at_ms": None,
}
state_lock = threading.Lock()
SHUTDOWN = threading.Event()
WAKE = threading.Event()


# ═══════════════════════════════════════════════════════════════════════
# status.json
# ═══════════════════════════════════════════════════════════════════════
def _read_status_file() -> dict | None:
    try:
        with open(config.STATUS_PATH, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _atomic_write_json(path: str, obj: dict):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, default=str)
    os.replace(tmp, path)


def live_progress(ctx: CycleContext) -> dict:
    """Snapshot progres job berjalan (heartbeat)."""
    now_ms = int(time.time() * 1000)
    job = ctx.job
    return {
        "live": True,
        "jobId": job.get("id"),
        "scopeType": job.get("scopeType"),
        "scopeValue": job.get("scopeValue"),
        "trigger": ctx.trigger,
        "phase": ctx.phase,
        "startedAtMs": int(ctx.started_at * 1000),
        "elapsedMs": now_ms - int(ctx.started_at * 1000),
        "requests": ctx.requests,
        "fetched": ctx.fetched,
        "qualifying": ctx.qualifying,
        "upserted": ctx.upserted,
        "newVideos": ctx.new_videos,
        "productsUpdated": ctx.products_updated,
        "errorCount": len(ctx.errors),
    }


def write_status(store: Store, client: CreatoKClient, session_mgr: SessionManager,
                 breaker: CircuitBreaker, running: bool, next_run_at_ms: int | None,
                 cycle_progress: dict | None = None):
    prev = _read_status_file() or {}
    last_result = state.get("last_result")
    slices = store.slice_status_counts()
    disc = discovery.load_cached()
    status = {
        "ok": True,
        "service": "trend-scraper-python",
        "version": "7.0",
        "instance": config.INSTANCE_ID,
        "running": running,
        "nextRunAtMs": next_run_at_ms,
        "intervalSeconds": config.INTERVAL_SECONDS,
        "minSales": config.MIN_SALES,
        "minViews": config.MIN_VIEWS,
        "workers": config.WORKERS,
        "session": {
            "hasSession": client.has_session(),
            "ageDays": client.session_age_days(),
            "state": session_mgr.state if session_mgr else "unknown",
        },
        "circuit": breaker.snapshot() if breaker else None,
        "metrics": client.metrics_snapshot(),
        "slices": slices,
        "queueLen": len(store.active_jobs()),
        "discovery": {
            "regions": len(disc.regions) if disc else 0,
            "categories": len(disc.get("categories", [])) if disc else 0,
            "source": disc.get("source") if disc else None,
            "updatedAtMs": disc.get("updatedAtMs") if disc else None,
        },
        "totalVideos": store.total_videos(),
        # kompatibilitas v5: lastCycle = hasil job terakhir
        "lastCycle": last_result if last_result is not None else prev.get("lastCycle"),
    }
    if cycle_progress is not None:
        status["cycleProgress"] = cycle_progress
    _atomic_write_json(config.STATUS_PATH, status)


def update_status_progress(progress: dict):
    """Heartbeat: perbarui cycleProgress TANPA menyentuh SQLite (thread-safe)."""
    status = _read_status_file()
    if not status:
        return
    status["running"] = True
    status["cycleProgress"] = progress
    _atomic_write_json(config.STATUS_PATH, status)


# ═══════════════════════════════════════════════════════════════════════
# Watchdog Next.js dev server (v4.3/v5.1 — terbukti, dipertahankan)
# ═══════════════════════════════════════════════════════════════════════
def watch_next_dev():
    """Jaga rantai proses tetap hidup: supervisor → bot; dan Next.js dev :3000.
    Latar: sandbox mereap proses keturunan tool-call; hanya keturunan proses
    long-lived/boot-anchored yang selamat. Rantai: next-server → supervisor → bot."""
    import subprocess
    import urllib.request

    PROJECT = "/home/z/my-project"
    SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))

    def supervisor_alive() -> bool:
        try:
            with open(f"{SERVICE_DIR}/.supervisor.lock", "r", encoding="utf-8") as f:
                pid = int(f.read().strip())
        except Exception:
            return False
        if not os.path.exists(f"/proc/{pid}"):
            return False
        try:
            with open(f"/proc/{pid}/cmdline", "r", encoding="utf-8") as f:
                return "supervisor.ts" in f.read()
        except Exception:
            return True

    def ensure_supervisor():
        if supervisor_alive():
            return
        print("[watchdog] supervisor mati — spawn ulang bun supervisor.ts ...", flush=True)
        try:
            logf = open(f"{PROJECT}/.zscripts/mini-service-trend-scraper-python.log", "ab")
            subprocess.Popen(
                ["bun", "supervisor.ts"],
                cwd=SERVICE_DIR,
                stdout=logf,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except Exception as e:
            print(f"[watchdog] spawn supervisor gagal: {e}", flush=True)

    def serving() -> bool:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3000/", timeout=4) as r:
                return r.status == 200
        except Exception:
            return False

    def port_bound(timeout: float = 1.0) -> bool:
        import socket
        try:
            with socket.create_connection(("127.0.0.1", 3000), timeout=timeout):
                return True
        except Exception:
            return False

    def realtime_alive() -> bool:
        import socket
        try:
            with socket.create_connection(("127.0.0.1", 4030), timeout=1.0):
                return True
        except Exception:
            return False

    def ensure_realtime():
        """v6 — jaga realtime socket.io service (:4030) tetap hidup.
        Bot hidup 24/7 → realtime service lahir sebagai anak bot → rantai proses
        tak putus (pola sama dengan watchdog Next.js)."""
        if realtime_alive():
            return
        print("[realtime] :4030 mati — spawn trend-realtime-service ...", flush=True)
        try:
            rt_dir = f"{PROJECT}/mini-services/trend-realtime-service"
            logf = open(f"{PROJECT}/.zscripts/realtime-service.log", "ab")
            subprocess.Popen(
                ["bun", "index.ts"],
                cwd=rt_dir,
                stdout=logf,
                stderr=subprocess.STDOUT,
                stdin=subprocess.DEVNULL,
            )
        except Exception as e:
            print(f"[realtime] spawn gagal: {e}", flush=True)

    while True:
        try:
            ensure_supervisor()
            ensure_realtime()
            if not serving() and not port_bound():
                print("[nextdev] :3000 mati — spawn Next.js dev server ...", flush=True)
                logf = open(f"{PROJECT}/.zscripts/nextdev.log", "ab")
                subprocess.Popen(
                    ["bun", "run", "dev"],
                    cwd=PROJECT,
                    stdout=logf,
                    stderr=subprocess.STDOUT,
                    stdin=subprocess.DEVNULL,
                )
                for _ in range(90):
                    time.sleep(2)
                    if serving():
                        print("[nextdev] Next.js dev server HIDUP (:3000)", flush=True)
                        break
                else:
                    print("[nextdev] dev server belum siap dalam 180s — coba lagi nanti", flush=True)
        except Exception as e:
            print(f"[nextdev] error: {e}", flush=True)
        time.sleep(15)


# ═══════════════════════════════════════════════════════════════════════
# Scheduler
# ═══════════════════════════════════════════════════════════════════════
def should_preempt(running_job: dict, nxt: dict | None) -> bool:
    """v7 aturan preemption:
    1. priority nxt LEBIH KECIL → preempt (aturan umum).
    2. job berjalan GLOBAL + nxt COUNTRY dengan priority ≤ → preempt:
       fokus negara user SELALU mendahului sweep global (scope sempit dulu),
       global di-hold dan auto-resume setelah negara selesai (tanpa data hilang).
    """
    if nxt is None:
        return False
    if nxt["priority"] < running_job["priority"]:
        return True
    if running_job["scopeType"] == "global" and nxt["scopeType"] == "country" \
            and nxt["priority"] <= running_job["priority"]:
        return True
    return False


def prefer_ready_over_held(ready: dict | None, held: dict | None) -> bool:
    """v7: apakah 'ready' diklaim dulu daripada resume 'held'?
    True bila ready prio < held prio, ATAU ready country vs held global (fokus user)."""
    if ready is None:
        return False
    if held is None:
        return True
    if ready["priority"] < held["priority"]:
        return True
    return held["scopeType"] == "global" and ready["scopeType"] == "country" \
        and ready["priority"] <= held["priority"]


def preemptor_loop(store: Store):
    """Thread preemptor (v7): cek tiap 2 dtk — bila ada job 'ready' dengan priority
    LEBIH TINGGI (angka lebih kecil) dari job berjalan → tandai ctx.preempted.
    SliceQueue berhenti elegan, run_job men-finish job sbg 'held', scheduler
    langsung mengklaim job prioritas tinggi. Juga mengadopsi slice 'pending'
    buatan zombie secara berkala."""
    last_adopt = 0.0
    while not SHUTDOWN.wait(timeout=2):
        try:
            with state_lock:
                running = state["running"]
                ctx = state["ctx"]
                job = state["current_job"]
            if running and ctx is not None and job is not None \
                    and not ctx.preempted and not ctx.cancel_requested:
                nxt = store.next_ready_job()
                if should_preempt(job, nxt):
                    ctx.preempt_reason = (f"preempted oleh {nxt['scopeType']}:"
                                          f"{nxt['scopeValue']} (prio {nxt['priority']})")
                    ctx.preempted = True
                    print(f"[preempt] job {job['id'][:8]} "
                          f"({job['scopeType']}:{job['scopeValue']}) → "
                          f"{ctx.preempt_reason}")
            if time.time() - last_adopt > config.ADOPT_EVERY_SEC:
                last_adopt = time.time()
                n = store.adopt_pending_slices()
                if n:
                    print(f"[adopt] {n} slice legacy 'pending' → 'ready'")
        except Exception as e:
            print(f"[preempt] error: {e}")


def scheduler_loop(client: CreatoKClient, store: Store, session_mgr: SessionManager,
                   breaker: CircuitBreaker):
    """v7: satu job pada satu waktu DENGAN preemption prioritas.
    Urutan keputusan (bila tidak ada job berjalan):
      1. ready job prio < held job prio → claim ready (preemption by order)
      2. ada held → resume held ter-atas (FIFO prio)
      3. idle & data basi → scheduled global job (prio 10)
      4. claim ready apa adanya
    Preemption MID-RUN ditangani thread preemptor_loop."""
    while not SHUTDOWN.is_set():
        try:
            if session_mgr.is_healthy():
                if not state["running"]:
                    ready = store.next_ready_job()
                    held_jobs = [j for j in store.active_jobs() if j["status"] == "held"]
                    held = held_jobs[0] if held_jobs else None
                    job = None
                    if prefer_ready_over_held(ready, held):
                        job = store.claim_next_job()
                    elif held is not None:
                        job = store.resume_held_job()
                    else:
                        # idle: jadwalkan global freshness bila data basi (> interval − 5 mnt)
                        last = store.last_sync_at_ms()
                        stale_after = config.INTERVAL_SECONDS * 1000 - 5 * 60_000
                        if time.time() * 1000 - last > stale_after:
                            store.create_job("global", "ALL", "scheduled",
                                             priority=config.JOB_PRIORITY["scheduled"])
                            print("[scheduler] data basi — global job dijadwalkan")
                        job = store.claim_next_job()

                    if job:
                        _execute_job(client, store, session_mgr, breaker, job)
                else:
                    with state_lock:
                        state["next_run_at_ms"] = None
            else:
                # Bukan healthy: 'authing' → coba login langsung (anti deadlock:
                # boot tanpa session.json tidak boleh menunggu tanpa upaya);
                # 'human_required' → biarkan recovery loop (backoff 5 mnt) yang menangani.
                if session_mgr.state == "authing":
                    session_mgr.relogin("scheduler")
                with state_lock:
                    state["next_run_at_ms"] = None

            # nextRunAtMs utk UI: last sync + interval (atau sekarang bila sudah basi)
            if session_mgr.is_healthy() and not store.active_jobs():
                last = store.last_sync_at_ms()
                nxt = last + config.INTERVAL_SECONDS * 1000
                with state_lock:
                    state["next_run_at_ms"] = int(nxt) if nxt > time.time() * 1000 \
                        else int(time.time() * 1000)
            elif not state["running"]:
                with state_lock:
                    state["next_run_at_ms"] = None
        except Exception as e:
            print(f"[scheduler] error: {e}")
            import traceback as _tb
            _tb.print_exc(limit=3)
        SHUTDOWN.wait(timeout=8)
        WAKE.clear()


def _execute_job(client, store, session_mgr, breaker, job):
    with state_lock:
        state["running"] = True
        state["current_job"] = job

    def _on_ctx(ctx):
        with state_lock:
            state["ctx"] = ctx

    try:
        result = run_job(client, store, session_mgr, job, breaker=breaker, on_ctx=_on_ctx)
        with state_lock:
            state["last_result"] = result
            state["ctx"] = None
        write_status(store, client, session_mgr, breaker, False, None)
    finally:
        with state_lock:
            state["running"] = False
            state["current_job"] = None


def heartbeat_loop(client: CreatoKClient, store: Store, session_mgr: SessionManager,
                   breaker: CircuitBreaker):
    """Tulis progres live ke status.json tiap 30 dtk (TANPA SQLite — thread aman)."""
    while True:
        if SHUTDOWN.wait(timeout=30):
            return
        with state_lock:
            running = state["running"]
            ctx = state["ctx"]
        if not running or ctx is None:
            continue
        try:
            update_status_progress(live_progress(ctx))
        except Exception:
            pass


# ═══════════════════════════════════════════════════════════════════════
# HTTP API
# ═══════════════════════════════════════════════════════════════════════
def make_handler(client, store, session_mgr, breaker):
    class Handler(BaseHTTPRequestHandler):
        def _json(self, obj, code=200):
            body = json.dumps(obj, ensure_ascii=False, default=str).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _body(self) -> dict:
            try:
                n = int(self.headers.get("Content-Length") or 0)
                if n <= 0:
                    return {}
                return json.loads(self.rfile.read(n).decode() or "{}")
            except Exception:
                return {}

        def do_GET(self):
            if self.path == "/health":
                return self._json({
                    "ok": True, "service": "trend-scraper-python", "version": "7.0",
                    "instance": config.INSTANCE_ID,
                    "uptimeMs": int((time.time() - STARTED_AT) * 1000),
                    "running": state["running"],
                    "sessionState": session_mgr.state,
                })
            if self.path == "/status":
                st = _read_status_file()
                return self._json({
                    "ok": True, "running": state["running"],
                    "nextRunAtMs": state["next_run_at_ms"], "status": st,
                })
            if self.path == "/snapshot":
                return self._json(self._snapshot())
            if self.path == "/jobs":
                return self._json({"ok": True, "jobs": store.list_jobs(20)})
            return self._json({"ok": False, "error": "not found"}, 404)

        def _snapshot(self) -> dict:
            with state_lock:
                ctx = state["ctx"]
                cur_job = state["current_job"]
            # v7: activeJob = job milik instance INI (bukan job legacy zombie)
            prog = store.job_progress(cur_job["id"]) if cur_job else \
                {"total": 0, "done": 0, "failed": 0, "itemsUpserted": 0}
            current = {**cur_job, "progress": prog} if cur_job else None
            if current is not None and ctx is not None:
                current["live"] = {
                    "phase": ctx.phase, "elapsedMs": int((time.time() - ctx.started_at) * 1000),
                    "requests": ctx.requests, "fetched": ctx.fetched,
                    "qualifying": ctx.qualifying, "upserted": ctx.upserted,
                    "newVideos": ctx.new_videos,
                }
            # v7: queue = semua job aktif (ready/running/held) + progress utk running/held
            queue = []
            for j in store.active_jobs():
                item = {k: j[k] for k in ("id", "scopeType", "scopeValue", "status",
                                          "trigger", "priority", "pausedReason",
                                          "createdAt", "owner")}
                if j["status"] in ("running", "held"):
                    item["progress"] = store.job_progress(j["id"])
                # v7: 'mine' = dibuat/diklaim instance ini (bukan legacy zombie)
                item["mine"] = (j.get("owner") or "") == config.INSTANCE_ID
                queue.append(item)
            return {
                "ok": True,
                "running": state["running"],
                "instance": {"version": "7.0", "id": config.INSTANCE_ID,
                             "pid": os.getpid()},
                "session": session_mgr.snapshot(),
                "circuit": breaker.snapshot(),
                "metrics": client.metrics_snapshot(),
                "activeJob": current,
                "queue": queue,
                "lastResult": state.get("last_result"),
                "jobs": store.list_jobs(10),
                "slices": store.slice_status_counts(),
                "perCountry": store.per_country_summary(),
                "failedSample": store.failed_slices_sample(20),
                "alerts": store.list_alerts(30),
                "unresolvedAlerts": len(store.list_alerts(200, unresolved_only=True)),
                "discovery": discovery.load_cached(),
                "totalVideos": store.total_videos(),
                "nextRunAtMs": state.get("next_run_at_ms"),
                "uptimeMs": int((time.time() - STARTED_AT) * 1000),
            }

        def do_POST(self):
            if self.path == "/jobs":
                body = self._body()
                scope_type = body.get("scopeType", "global")
                scope_value = (body.get("scopeValue") or "ALL").upper()
                if scope_type not in ("global", "country"):
                    return self._json({"ok": False, "error": "scopeType harus global|country"}, 400)
                if scope_type == "country" and not scope_value:
                    return self._json({"ok": False, "error": "scopeValue wajib utk country"}, 400)
                if scope_type == "global":
                    scope_value = "ALL"
                priority = config.JOB_PRIORITY["ui"] if (
                    body.get("priority") == "high" or body.get("source") == "ui"
                ) else config.JOB_PRIORITY["scheduled"]
                job, created, unheld = store.create_or_unhold_job(
                    scope_type, scope_value, body.get("trigger", "ui"), priority=priority)
                WAKE.set()
                return self._json({
                    "ok": True, "started": created, "unheld": unheld,
                    "alreadyQueued": not created and not unheld, "job": job,
                })
            if self.path == "/jobs/cancel":
                body = self._body()
                job_id = body.get("id") or ""
                job = store._get_job_by_id(job_id)
                if not job:
                    return self._json({"ok": False, "error": "job tidak ditemukan"}, 404)
                if job["status"] == "running":
                    with state_lock:
                        ctx = state["ctx"]
                        cur = state["current_job"]
                    if cur and cur["id"] == job_id and ctx is not None:
                        # job running = pasti milik instance ini (state proses lokal)
                        ctx.cancel_requested = True
                        WAKE.set()
                        return self._json({"ok": True, "cancelling": True, "job": job})
                    return self._json({"ok": False,
                                       "error": "job running bukan milik instance ini"}, 409)
                if job["status"] in ("ready", "held"):
                    store.cancel_job(job_id)
                    WAKE.set()
                    return self._json({"ok": True, "cancelled": True,
                                       "job": store._get_job_by_id(job_id)})
                return self._json({"ok": False, "error": f"status {job['status']} tak bisa dicancel"}, 400)
            if self.path == "/jobs/promote":
                body = self._body()
                job = store.promote_job(body.get("id") or "")
                WAKE.set()
                return self._json({"ok": bool(job), "job": job})
            if self.path == "/trigger":
                # LEGACY (kompat /api/sync v5): global job; dedup via create_or_unhold
                job, created, _u = store.create_or_unhold_job(
                    "global", "ALL", "manual", priority=config.JOB_PRIORITY["scheduled"])
                WAKE.set()
                return self._json({"ok": True, "started": created, "job": job})
            if self.path == "/jobs/retry-failed":
                n = store.requeue_dead()
                created = None
                if not store.active_jobs():
                    created = store.create_job("global", "ALL", "retry-failed",
                                               priority=config.JOB_PRIORITY["retry"])
                WAKE.set()
                return self._json({"ok": True, "requeued": n, "job": created})
            if self.path == "/alerts/resolve":
                body = self._body()
                n = store.resolve_alerts(type_=body.get("type"), prefix=body.get("prefix"))
                return self._json({"ok": True, "resolved": n})
            if self.path == "/session/invalidate":
                # Simulasi logout/token dicabut: hapus cookie in-memory → request berikutnya
                # dapat 401 → auth_hook → re-login otomatis → job berlanjut.
                client._cookies = []
                client.session_issued_at = 0
                client._local.s = None
                return self._json({"ok": True, "invalidated": True,
                                   "sessionState": session_mgr.state})
            if self.path == "/session/force-relogin":
                res = client.login()
                if res.get("ok"):
                    session_mgr._on_login_success()
                return self._json({"ok": bool(res.get("ok")), "detail": res.get("detail"),
                                   "sessionState": session_mgr.state})
            return self._json({"ok": False, "error": "not found"}, 404)

        def log_message(self, fmt, *args):
            print(f"[http] {fmt % args}")

    return Handler


# ═══════════════════════════════════════════════════════════════════════
# main
# ═══════════════════════════════════════════════════════════════════════
def session_has_cookies() -> bool:
    """KEEP-ALIVE L4: true bila session.json masih memuat cookies —
    bot boleh boot degraded (mode sesi) walau kredensial .env hilang."""
    try:
        import json
        with open(config.SESSION_PATH, "r", encoding="utf-8") as f:
            data = json.load(f)
        return bool(data.get("cookies"))
    except Exception:
        return False


def main():
    problems = config.validate()
    if problems:
        if session_has_cookies():
            # KEEP-ALIVE L4 — session-first boot: kredensial hilang TAPI cookie
            # tersimpan masih ada → bot tetap hidup (degraded). Saat cookie
            # kedaluwarsa, SessionManager → human_required + alert (akurat).
            for p in problems:
                print(f"[config] WARNING (mode sesi): {p}")
        else:
            for p in problems:
                print(f"[config] FATAL: {p}")
            raise SystemExit(1)

    client = CreatoKClient()
    store = Store()
    session_mgr = SessionManager(client, store)
    breaker = CircuitBreaker(store)

    # KEEP-ALIVE: alert lifecycle konfigurasi
    if problems:
        store.insert_alert(
            "critical",
            "config",
            "Kredensial CREATOK hilang (.env) — bot berjalan MODE SESI dengan cookie "
            "tersimpan. Isi mini-services/trend-scraper-python/.env agar relogin "
            "otomatis pulih (supervisor/ensure_env akan mencoba memulihkan sendiri).",
            dedupe_sec=3600,
        )
    else:
        store.resolve_alerts(type_="config")

    # Recovery sekali di boot: zombie SyncLog + slice running→pending + job running→paused
    store.recover_boot()

    # thread: watchdog Next.js + supervisor (terbukti v5.1)
    threading.Thread(target=watch_next_dev, daemon=True).start()
    # thread: heartbeat progres job → status.json
    threading.Thread(target=heartbeat_loop, args=(client, store, session_mgr, breaker),
                     daemon=True).start()
    # thread: PREEMPTOR v7 — preemption mid-run + adopsi slice legacy
    threading.Thread(target=preemptor_loop, args=(store,), daemon=True).start()
    # thread: recovery login saat human_required
    threading.Thread(target=session_mgr.recovery_loop, daemon=True).start()

    server = ThreadingHTTPServer(("0.0.0.0", config.SERVICE_PORT), make_handler(
        client, store, session_mgr, breaker))
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    print(f"[service] HTTP listening di port {config.SERVICE_PORT}")

    def on_term(signum, frame):
        print("[service] SIGTERM — keluar (slice pending di-resume saat boot berikutnya)")
        try:
            write_status(store, client, session_mgr, breaker, False, None)
        except Exception:
            pass
        os._exit(0)  # pastikan keluar walau thread utama terblokir di C-call

    signal.signal(signal.SIGTERM, on_term)
    signal.signal(signal.SIGINT, on_term)

    # ── Scheduler loop (job satu-satu + preemption; boot resume + jadwal global) ──
    print("[scheduler] v7 aktif — boot resume + preemption prioritas + jadwal freshness")
    scheduler_loop(client, store, session_mgr, breaker)
    server.shutdown()


if __name__ == "__main__":
    main()
