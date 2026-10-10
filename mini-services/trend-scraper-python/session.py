"""
SessionManager v6 — kesehatan sesi creatok.ai dengan deteksi human-required.

State machine:
  healthy        → sesi siap (login sukses / session.json valid)
  authing        → sedang mencoba login
  human_required → login gagal >= LOGIN_MAX_CONSECUTIVE_FAILS berturut-turut
                   (indikasi captcha/2FA/akun terkunci/kredensial berubah)
                   → job DIPAUSE + alert critical; thread recovery retry login
                     tiap LOGIN_RETRY_BACKOFF_SEC; sukses → auto-resume.

Integrasi:
- attach(client): pasang auth_hook — 401/403 mid-run diarahkan ke sini
  (gagal login terhitung; sukses mengembalikan sesi sehat).
- Job runner memanggil is_healthy() sebelum dequeue tiap batch; bila
  human_required → job paused (pauseReason='session') sampai pulih.
"""
import threading
import time

import config


class SessionManager:
    def __init__(self, client, store):
        self.client = client
        self.store = store
        self._lock = threading.Lock()
        self.state = "healthy" if client.has_session() else "authing"
        self.login_failures = 0
        self.last_login_at = 0.0
        self.last_error: str | None = None
        self._alert_open = False
        self._stop = threading.Event()
        # v7: serialisasi login — bila banyak worker kena 401 bersamaan,
        # HANYA satu yang POST /sign-in (lain memakai hasilnya). Mencegah
        # thundering-herd pada endpoint login (terbukti: 5× 429 beruntun).
        self._auth_lock = threading.Lock()
        self._last_auth_ok_at = 0.0
        self.client.auth_hook = self.handle_auth_challenge

    # ── Inti state ──────────────────────────────────────────────────────
    def is_healthy(self) -> bool:
        with self._lock:
            return self.state == "healthy"

    def ensure_ready(self) -> bool:
        """Pastikan sesi siap sebelum job dimulai. True bila healthy."""
        if self.is_healthy() and self.client.has_session() and not self.client.session_expired():
            return True
        return self.relogin("boot/proaktif")

    def relogin(self, reason: str) -> bool:
        with self._lock:
            if self.state == "human_required":
                return False  # hanya thread recovery yang boleh mencoba lagi
            self.state = "authing"
            self.last_login_at = time.time()
        res = self.client.login()
        if res.get("ok"):
            self._on_login_success()
            return True
        self._on_login_failure(res.get("status"), res.get("detail"), reason)
        return False

    def handle_auth_challenge(self) -> bool:
        """auth_hook dari CreatoKClient saat 401/403 mid-run. True bila sesi pulih.
        v7: diserialisasi — worker lain yang 401 bersamaan memakai hasil login
        pertama (bila sukses < 15 dtk lalu) tanpa POST login lagi."""
        with self._auth_lock:
            if self.state == "healthy" and \
                    time.time() - self._last_auth_ok_at < 15 and \
                    self.client.has_session():
                return True  # worker lain baru saja memulihkan sesi
            res = self.client.login()
            if res.get("ok"):
                self._last_auth_ok_at = time.time()
                self._on_login_success()
                return True
        self._on_login_failure(res.get("status"), res.get("detail"), "challenge 401/403 mid-run")
        return False

    # ── Transisi ────────────────────────────────────────────────────────
    def _on_login_success(self):
        with self._lock:
            self.state = "healthy"
            self.login_failures = 0
            self.last_error = None
            had_alert = self._alert_open
            self._alert_open = False
        if had_alert:
            try:
                self.store.resolve_alerts(type_="session")
                self.store.insert_alert(
                    "info", "session",
                    "Sesi creatok.ai pulih — scraping dilanjutkan otomatis dari titik berhenti.",
                )
            except Exception:
                pass

    def _on_login_failure(self, status, detail, reason):
        with self._lock:
            self.login_failures += 1
            self.last_error = f"HTTP {status}: {detail}" if status else str(detail)
            fails = self.login_failures
        print(f"[session] login gagal #{fails} ({reason}): {self.last_error}")
        if fails >= config.LOGIN_MAX_CONSECUTIVE_FAILS:
            with self._lock:
                self.state = "human_required"
                need_alert = not self._alert_open
                self._alert_open = True
            if need_alert:
                try:
                    self.store.insert_alert(
                        "critical", "session",
                        "Login creatok.ai gagal berulang — kemungkinan butuh tindakan manusia "
                        "(captcha / 2FA / akun terkunci / kredensial berubah). "
                        f"Job scraping di-PAUSE otomatis. Detail terakhir: {self.last_error}",
                    )
                except Exception:
                    pass

    # ── Recovery loop (dipanggil main sebagai daemon thread) ────────────
    def recovery_loop(self):
        """Saat human_required: coba login ulang berkala hingga pulih."""
        while not self._stop.is_set():
            if self._stop.wait(timeout=config.LOGIN_RETRY_BACKOFF_SEC):
                return
            with self._lock:
                needs = self.state == "human_required"
            if not needs:
                continue
            print("[session] recovery: mencoba login ulang …")
            res = self.client.login()
            if res.get("ok"):
                self._on_login_success()
                print("[session] recovery: login SUKSES — job di-resume oleh scheduler")
            else:
                self._on_login_failure(res.get("status"), res.get("detail"), "recovery loop")

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self.state,
                "hasSession": self.client.has_session(),
                "ageDays": self.client.session_age_days(),
                "loginFailures": self.login_failures,
                "lastError": self.last_error,
                "lastLoginAt": int(self.last_login_at * 1000) or None,
            }

    def stop(self):
        self._stop.set()
