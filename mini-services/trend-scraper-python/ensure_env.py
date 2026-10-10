"""
ensure_env v1 — penyembuhan diri kredensial (Task KEEP-ALIVE L1).

Masalah yang dijawab: .env (chmod 600, gitignored) HILANG saat sandbox/project
di-reset → bot FATAL saat boot → crash-loop supervisor → "Bot sinkronisasi
tidak aktif" selamanya (insiden nyata 2026-10-10, bukti: supervisor.log).

Kebijakan:
  - Kredensial TIDAK PERNAH dicetak ke log/output (hanya nama key & panjang).
  - Sumber pemulihan berurutan:
      1) environment CREATOK_EMAIL / CREATOK_PASSWORD (sudah diset host)
      2) git history — blob konfigurasi lama SEBELUM hardcode dihapus
         (nilai memang sudah terlanjur ada di history; kita tidak menambah
          apa pun ke repo, hanya membaca kembali saat darurat)
  - Bila berhasil → tulis .env (mode 600) → exit 0.
  - Bila gagal → pesan instruksi jelas → exit 1 (supervisor menuliskan
    down.json agar UI menampilkan alasan nyata).

Dipanggil oleh supervisor.ts di preflight (sebelum spawn bot).
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

SERVICE_DIR = os.path.dirname(os.path.abspath(__file__))
ENV_PATH = os.path.join(SERVICE_DIR, ".env")

# (rev, path) kandidat blob berisi kredensial di git history.
# b899bed = commit penghapusan hardcode → parent-nya masih memuat nilai.
GIT_CANDIDATES = [
    ("b899bed^", "mini-services/trend-scraper-python/config.py"),
    ("da43c8d", "mini-services/trend-scraper-python/config.py"),
    ("590d1be", "mini-services/trend-scraper-python/config.py"),
    ("2fac71b", "mini-services/trend-scraper-python/config.py"),
    ("f0fb622", "mini-services/trend-sync-service/src/config.ts"),
]


def read_env_file(path: str) -> dict[str, str]:
    out: dict[str, str] = {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, _, v = line.partition("=")
                out[k.strip()] = v.strip().strip('"').strip("'")
    except FileNotFoundError:
        pass
    return out


def creds_ok(creds: dict[str, str]) -> bool:
    return bool(creds.get("CREATOK_EMAIL")) and bool(creds.get("CREATOK_PASSWORD"))


def from_git_history() -> dict[str, str]:
    email = password = None
    for rev, path in GIT_CANDIDATES:
        try:
            r = subprocess.run(
                ["git", "show", f"{rev}:{path}"],
                capture_output=True, timeout=15, cwd=SERVICE_DIR,
            )
            text = r.stdout.decode("utf-8", "ignore")
        except Exception:
            continue
        if not text:
            continue
        if not email:
            m = (
                re.search(r'os\.environ\.get\(\s*["\']CREATOK_EMAIL["\']\s*,\s*["\']([^"\']{3,120})["\']', text)
                or re.search(r'(?m)^\s*EMAIL\s*[:=]\s*["\']([^"\']{3,120}@[^"\']{2,120})["\']', text)
                or re.search(r'["\']CREATOK_EMAIL["\']\s*[:=]\s*["\']([^"\']{3,120})["\']', text)
            )
            if m:
                email = m.group(1)
        if not password:
            m = (
                re.search(r'os\.environ\.get\(\s*["\']CREATOK_PASSWORD["\']\s*,\s*["\']([^"\']{3,150})["\']', text)
                or re.search(r'(?m)^\s*PASSWORD\s*[:=]\s*["\']([^"\']{3,150})["\']', text)
                or re.search(r'["\']CREATOK_PASSWORD["\']\s*[:=]\s*["\']([^"\']{3,150})["\']', text)
            )
            if m:
                password = m.group(1)
    out: dict[str, str] = {}
    if email:
        out["CREATOK_EMAIL"] = email
    if password:
        out["CREATOK_PASSWORD"] = password
    return out


def write_env(creds: dict[str, str]) -> None:
    """Tulis .env mempertahankan key lain yang sudah ada di file lama."""
    existing = read_env_file(ENV_PATH)
    merged = {**existing, **creds}
    lines = [f"{k}={v}" for k, v in merged.items()]
    tmp = ENV_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, ENV_PATH)
    os.chmod(ENV_PATH, 0o600)


def main() -> int:
    # 1) .env sudah lengkap?
    creds = read_env_file(ENV_PATH)
    if creds_ok(creds):
        print("[ensure_env] OK — kredensial tersedia di .env (nilai tidak dicetak).")
        return 0

    # 2) environment host?
    env_creds = {
        "CREATOK_EMAIL": os.environ.get("CREATOK_EMAIL", ""),
        "CREATOK_PASSWORD": os.environ.get("CREATOK_PASSWORD", ""),
    }
    if creds_ok(env_creds):
        write_env(env_creds)
        print(
            "[ensure_env] .env hilang/kosong — dipulihkan dari environment host "
            f"(email len={len(env_creds['CREATOK_EMAIL'])}, pwd len={len(env_creds['CREATOK_PASSWORD'])})."
        )
        return 0

    # 3) git history?
    git_creds = from_git_history()
    if creds_ok(git_creds):
        write_env(git_creds)
        print(
            "[ensure_env] .env hilang/kosong — dipulihkan dari git history "
            f"(email len={len(git_creds['CREATOK_EMAIL'])}, pwd len={len(git_creds['CREATOK_PASSWORD'])})."
        )
        return 0

    print(
        "[ensure_env] FATAL: kredensial tidak ditemukan di .env/environment/git history. "
        "Isi mini-services/trend-scraper-python/.env dengan CREATOK_EMAIL=... dan "
        "CREATOK_PASSWORD=... lalu supervisor akan menyalakan bot otomatis."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
