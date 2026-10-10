"""
HTTP client creatok.ai v7 — login, sesi persisten (session.json), self-heal:
re-login otomatis saat 401/403, throttle politeness adaptif + jitter,
RETRY CEPAT 5xx (bukti: sumber gagal ~50% request secara ACAK — bukan rate-limit),
thread-local sessions, METRICS untuk circuit breaker.

v7 perubahan:
- 5xx/invalid → kurva retry cepat RETRY_DELAY_5XX (0.4..6.4s + jitter ±30%).
  Bukti diagnosis: p(500)≈0.5 konstan; retry seketika ~50% sukses → efektif ~97%.
- 429 tetap: throttle ×2 + backoff panjang (sinyal rate-limit sungguhan).
- KEAMANAN: email TIDAK lagi dicetak ke log.
"""
import json
import os
import random
import threading
import time

import requests

import config


class CreatoKClient:
    def __init__(self):
        self._local = threading.local()
        self.cookie_names = ("__Secure-better-auth.session_token",)
        self.session_issued_at = 0
        self.requests_made = 0
        self._rate_lock = threading.Lock()
        self._last_request_at = 0.0
        self._count_lock = threading.Lock()
        self._metrics_lock = threading.Lock()
        # metrics: dipakai circuit breaker + status endpoint
        self.metrics = {"ok": 0, "429": 0, "5xx": 0, "network": 0, "auth": 0, "other": 0}
        # Adaptive throttle — self-tuning politeness
        self._current_throttle_ms = float(config.THROTTLE_MS)
        self._clean_streak = 0
        # Hook yang diset SessionManager: dipanggil saat 401/403 mid-run.
        # Harus return True bila sesi kembali sehat (boleh retry request).
        self.auth_hook = None
        # Hook circuit breaker (diset SliceQueue): callback(ok: bool) per request
        self.breaker_cb = None
        self._load_session()

    # ── Session per-thread (cookie dibagi dari hasil login) ─────────────
    def _session(self) -> requests.Session:
        s = getattr(self._local, "s", None)
        if s is None:
            s = requests.Session()
            s.headers.update(
                {
                    "User-Agent": config.UA,
                    "Accept": "application/json",
                    "Referer": f"{config.BASE_URL}/app/trending",
                    "Origin": config.BASE_URL,
                }
            )
            for c in self._cookies:
                s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
            self._local.s = s
        return s

    def session_for_discovery(self) -> requests.Session:
        """Session segar ber-cookie aktif (untuk discovery page/chunk fetch)."""
        s = requests.Session()
        s.headers.update({
            "User-Agent": config.UA,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Referer": f"{config.BASE_URL}/app/dashboard",
        })
        for c in self._cookies:
            s.cookies.set(c["name"], c["value"], domain=c.get("domain"), path=c.get("path", "/"))
        return s

    # ── Persistensi sesi ────────────────────────────────────────────────
    def _load_session(self):
        self._cookies: list[dict] = []
        try:
            with open(config.SESSION_PATH, "r", encoding="utf-8") as f:
                data = json.load(f)
            issued = int(data.get("issuedAt", 0))
            if issued and time.time() * 1000 - issued < config.SESSION_MAX_AGE_MS:
                self._cookies = data.get("cookies", [])
                self.session_issued_at = issued
                print(f"[client] session dimuat ({len(self._cookies)} cookie)")
        except FileNotFoundError:
            pass
        except Exception as e:
            print(f"[client] gagal memuat session: {e}")

    def _save_session(self):
        try:
            tmp = config.SESSION_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump({"issuedAt": self.session_issued_at, "cookies": self._cookies}, f)
            os.replace(tmp, config.SESSION_PATH)
        except Exception as e:
            print(f"[client] gagal menyimpan session: {e}")

    # ── Login ───────────────────────────────────────────────────────────
    def login(self) -> dict:
        """Attempt login. Return {ok, status, detail} — TIDAK pernah melempar.
        v6.1: cookie lama/basi dibersihkan dulu — bila token dicabut server,
        mengirim session_token basi pada request login BISA membuat 401."""
        if not config.EMAIL or not config.PASSWORD:
            return {"ok": False, "status": None, "detail": "kredensial kosong (.env)"}
        try:
            s = self._session()
            s.cookies.clear()  # buang session basi — login harus bersih
            r = s.post(
                f"{config.BASE_URL}/api/auth/sign-in/email",
                json={"email": config.EMAIL, "password": config.PASSWORD},
                headers={"Referer": f"{config.BASE_URL}/login"},
                timeout=30,
            )
            with self._count_lock:
                self.requests_made += 1
        except Exception as e:
            return {"ok": False, "status": None, "detail": f"network: {e}"}
        if r.status_code != 200:
            detail = r.text[:200] if r.headers.get("content-type", "").startswith("text/") else f"HTTP {r.status_code}"
            return {"ok": False, "status": r.status_code, "detail": detail}
        cookies = [
            {"name": c.name, "value": c.value, "domain": c.domain, "path": c.path}
            for c in self._session().cookies
            if c.name.startswith("__Secure-better-auth")
        ]
        if not cookies:
            return {"ok": False, "status": r.status_code, "detail": "cookie sesi tidak ditemukan"}
        self._cookies = cookies
        # sebarkan cookie ke session thread ini
        self._local.s.cookies.clear()
        for c in cookies:
            self._local.s.cookies.set(c["name"], c["value"], domain=c["domain"], path=c["path"])
        self.session_issued_at = int(time.time() * 1000)
        self._save_session()
        print("[client] login OK")  # v7: email tidak dicetak (keamanan/PII)
        return {"ok": True, "status": 200, "detail": "ok"}

    def session_age_days(self):
        if not self.session_issued_at:
            return None
        return (time.time() * 1000 - self.session_issued_at) / 86400_000

    def has_session(self) -> bool:
        return bool(self._cookies)

    def session_expired(self) -> bool:
        return (
            not self.has_session()
            or (time.time() * 1000 - self.session_issued_at) > config.SESSION_MAX_AGE_MS
        )

    def ensure_session(self, force: bool = False) -> bool:
        """Fallback internal (bila tanpa SessionManager)."""
        if force or self.session_expired():
            for attempt in range(1, 4):
                if self.login().get("ok"):
                    return True
                time.sleep(attempt * 3)
            return False
        return True

    # ── Rate limiter global (semua thread) ──────────────────────────────
    def _throttle(self):
        while True:
            with self._rate_lock:
                wait = (self._current_throttle_ms / 1000) - (time.time() - self._last_request_at)
                if wait <= 0:
                    self._last_request_at = time.time()
                    # jitter ±20% — anti sinkronisasi worker
                    self._last_request_at += random.uniform(0, self._current_throttle_ms / 5000)
                    return
            time.sleep(min(wait, 0.5))

    def _note_success(self):
        with self._rate_lock:
            self._clean_streak += 1
            if self._clean_streak >= config.THROTTLE_EASE_STREAK:
                self._clean_streak = 0
                old = self._current_throttle_ms
                self._current_throttle_ms = max(
                    float(config.THROTTLE_MIN_MS), self._current_throttle_ms * 0.90
                )
                if self._current_throttle_ms < old - 1:
                    print(f"[client] throttle diturunkan → {self._current_throttle_ms:.0f}ms")

    def _note_pressure(self, reason: str):
        """429 → naikkan throttle (mundur sopan, jaga reputasi akun)."""
        with self._rate_lock:
            self._clean_streak = 0
            old = self._current_throttle_ms
            self._current_throttle_ms = min(
                float(config.THROTTLE_MAX_MS),
                max(self._current_throttle_ms, float(config.THROTTLE_MS)) * 2,
            )
            print(f"[client] tekanan sumber ({reason}) — throttle dinaikkan → "
                  f"{self._current_throttle_ms:.0f}ms")

    def _bump(self, key: str, n: int = 1):
        with self._metrics_lock:
            self.metrics[key] = self.metrics.get(key, 0) + n

    def metrics_snapshot(self) -> dict:
        with self._metrics_lock:
            return dict(self.metrics)

    # ── GET JSON resilient (thread-safe) ────────────────────────────────
    def get_json(self, path: str, allow_relogin: bool = True):
        """GET + throttle global + retry; None jika gagal permanen.
        Setiap attempt tercatat di metrics (ok/429/5xx/network/auth/other)
        dan disinyalkan ke circuit breaker (auth TIDAK dihitung — bukan tekanan sumber)."""
        for attempt in range(config.MAX_RETRIES + 1):
            self._throttle()
            try:
                r = self._session().get(f"{config.BASE_URL}{path}", timeout=30)
                with self._count_lock:
                    self.requests_made += 1
            except Exception:
                self._bump("network")
                if self.breaker_cb:
                    self.breaker_cb(False)
                time.sleep(1.5 * (attempt + 1))
                continue

            if r.status_code in (401, 403):
                self._bump("auth")
                if allow_relogin:
                    recovered = False
                    if self.auth_hook:
                        try:
                            recovered = bool(self.auth_hook())
                        except Exception:
                            recovered = False
                    else:
                        recovered = self.ensure_session(force=True)
                    if recovered:
                        self._local.s = None  # cookie baru → reset session thread ini
                        return self.get_json(path, allow_relogin=False)
                return None
            if r.status_code == 429:
                self._bump("429")
                if self.breaker_cb:
                    self.breaker_cb(False)
                self._note_pressure("HTTP 429")
                delay = min(30, 2 * (2.5**attempt))
                time.sleep(delay)
                continue
            if r.status_code >= 500:
                self._bump("5xx")
                if self.breaker_cb:
                    self.breaker_cb(False)
                # v7: 5xx sumber = flakiness ACAK (bukti diagnosis) → retry cepat.
                # Throttle TIDAK dinaikkan; backoff pendek + jitter.
                base = config.RETRY_DELAY_5XX[min(attempt, len(config.RETRY_DELAY_5XX) - 1)]
                time.sleep(base * (1 + random.uniform(-config.RETRY_JITTER, config.RETRY_JITTER)))
                continue
            if r.status_code != 200:
                self._bump("other")
                return None
            try:
                data = r.json()
                self._bump("ok")
                if self.breaker_cb:
                    self.breaker_cb(True)
                self._note_success()
                return data
            except Exception:
                self._bump("other")
                if self.breaker_cb:
                    self.breaker_cb(False)
                return None
        return None
