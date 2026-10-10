# TrendScraper Python — Bot TrendPulse (v4)

Bot scraping real 24/7 dari creatok.ai → database cloud Z.ai (`db/custom.db`, SQLite WAL,
dibagi dengan Next.js/Prisma). **Data 100% real, filter wajib: penjualan ≥ 10 & views ≥ 10.000.**

## Operasional harian

| Aksi | Perintah |
|---|---|
| Start (auto-restart 24/7) | `bun run dev` di folder ini (background) |
| Siklus penuh sekali | `bun run once` |
| Uji cepat aman | `bun run smoke` (1 negara × 2 kategori, ±12 request) |
| Trigger siklus manual berjalan | `curl -X POST http://localhost:4020/trigger` |
| Cek hidup | `curl http://localhost:4020/health` |
| Status lengkap | `curl http://localhost:4020/status` (atau baca `status.json`) |

Next.js membaca bot via `/api/sync` (GET status, POST trigger) di port 3000.

## Arsitektur v4 (tercepat)

- **16 worker paralel** + HTTP keep-alive per thread (thread-local session)
- **Adaptive throttle self-tuning**: 250 ms → turun bertahap ke 180 ms saat sumber bersih
  (streak 200 sukses), naik otomatis hingga 700 ms saat 429/5xx — cepat & sopan sekaligus
- **Early-stop known-ids**: halaman ≥2 yang ≥70% videonya sudah di DB → pagination combo
  dihentikan (ekor basi); ribuan request dihemat → budget beralih ke coverage baru
- **Budget**: 9.000 request sweep + 420 request produk (8.400 produk) per siklus
- **Self-heal**: re-login otomatis (401/403), retry backoff, recovery SyncLog zombie &
  SyncState menggantung saat boot/awal siklus
- **Smart-boot**: bila siklus terakhir selesai < 30 menit lalu (SyncState.lastSyncAt di DB),
  boot sweep dilewati — restart kapan pun tanpa boros request
- **status.json live**: ditulis saat siklus MULAI (running=true) & SELESAI — UI selalu akurat
- **Metrik per siklus**: reqPerSec, pagesSaved, productsUpdated, pruned, errors

## Jadwal

Siklus penuh saat boot (kecuali di-skip), lalu **tiap 1 jam** drift-proof
(next = selesai + 3600s). 13 negara × 29 kategori × 10 bucket waktu
(36jam / 7d / 15d / 30d + atribusi harian H-2..H-7).

## File penting

- `config.py` — SEMUA parameter (worker, throttle, budget, bucket, kredensial via env)
- `status.json` — status terakhir (jangan edit manual)
- `session.json` — cookie sesi creatok.ai (auto-refresh; hapus bila login bermasalah)
- `../trend-sync-service/` — DEPRECATED (digantikan bot ini)
