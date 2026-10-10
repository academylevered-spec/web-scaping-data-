"""CLI: jalankan satu job scraping (untuk backfill/tes manual).

Contoh:
  python3 run_once.py                        # job global penuh
  python3 run_once.py --smoke                # uji cepat terbatas (env SMOKE)
  python3 run_once.py --country ID           # job satu negara (semua kategori & window)
"""
import argparse

import config
from creatok import CreatoKClient
from session import SessionManager
from store import Store
from scraper import run_job
from slice_queue import CircuitBreaker


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--smoke", action="store_true", help="uji cepat terbatas")
    ap.add_argument("--country", default=None, help="kode negara (mis. ID) → job country")
    ap.add_argument("--trigger", default="manual")
    args = ap.parse_args()

    if args.smoke:
        # SMOKE: batasi via env override config (queue & slice bekerja normal)
        config.FALLBACK_REGIONS = ["ID"]
        config.FALLBACK_CATEGORIES = config.FALLBACK_CATEGORIES[:2]
        config.BUCKETS = [b for b in config.BUCKETS if b["id"] == 1]
        config.DAILY_BUCKETS = []
        config.MAX_REQUESTS_PER_CYCLE = 12
        config.PRODUCT_MAX_REQUESTS = 2
        config.JOB_SOFT_DEADLINE_MIN = 6

    store = Store()
    client = CreatoKClient()
    session_mgr = SessionManager(client, store)
    breaker = CircuitBreaker(store)

    scope_type = "country" if args.country else "global"
    scope_value = (args.country or "ALL").upper()
    job = store.create_job(scope_type, scope_value, args.trigger, priority=0)
    print(f"[run_once] job {job['id']} scope={scope_type}:{scope_value}")
    result = run_job(client, store, session_mgr, job, breaker=breaker)
    import json
    print(json.dumps(result, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
