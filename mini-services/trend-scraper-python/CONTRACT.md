# TrendPulse Scraping System — API & Event Contract (v6)

Sumber kebenaran kontrak frontend/backend. Perubahan pada file ini harus disepakati kedua sisi.

## Komponen

| Service | Port | Peran |
|---|---|---|
| Bot scraper (Python) | 4020 | scraping, job queue, session manager, discovery |
| Realtime service (Bun + socket.io) | 4030 | push live status ke UI |
| Next.js API | 3000 | proxy + agregasi untuk UI |
| SQLite (WAL) | — | `db/custom.db` (dibagi: Prisma ↔ bot ↔ realtime RO) |

## Model Data Inti

- **ScrapeJob** — 1 unit pekerjaan (scope `global` | `country`). Status: `queued → running → completed|failed|paused`.
- **ScrapeSlice** — 1 negara × 1 kategori × 1 window bucket. Status: `pending → running → done|failed|dead`.
  Persisten → resume setelah restart, freshness per slice, dead-letter jelas.
- **Alert** — severity `info|warning|critical`, type `session|source|system|data`, `resolvedAt` null = aktif.

## Aturan Scope (requirement owner)

- **Global** → SEMUA negara hasil discovery × SEMUA kategori × window (Kemarin/7d/15d/30d + bucket harian H-2..H-7).
- **Country (mis. ID)** → HANYA negara itu, semua kategori & window.
- Region/kategori DIDISCOVERY dinamis dari creatok.ai (RSC payload + JS chunk), cache `discovery.json`,
  fallback daftar terakhir. Negara/kategori baru otomatis masuk + alert info.

## Bot HTTP API (:4020)

| Method & Path | Deskripsi |
|---|---|
| `GET /health` | liveness `{ok, running, sessionState, uptimeMs}` |
| `GET /status` | ringkas, kompatibel v5 (`status.json` mirror) |
| `GET /snapshot` | keadaan penuh: session, circuit, metrics, activeJob, jobs, slices, perCountry, alerts, discovery |
| `POST /jobs` | body `{scopeType:'global'\|'country', scopeValue?, priority?}` → `{ok, started, alreadyQueued, job}` |
| `GET /jobs` | 20 job terakhir |
| `POST /jobs/retry-failed` | requeue slice `dead` → job global prioritas tinggi |
| `POST /alerts/resolve` | body `{type?, prefix?}` → tandai resolved |
| `POST /trigger` | LEGACY global job → `200 {started}` / `409 alreadyRunning` |

## Next.js API (:3000)

| Method & Path | Deskripsi |
|---|---|
| `GET /api/meta?window=` | meta UI: countries (+`lastScrapedAt`,`failedSlices`), stats, sync (scraper status + session), alerts aktif |
| `POST /api/scrape` | body `{scope:'global'} \| {scope:'country', country:'ID'}` → proxy `/jobs` → `200/409/502`; `body {action:'retry-failed'}` → proxy `/jobs/retry-failed` |
| `GET /api/scrape` | job list + ringkasan antrian (session, circuit, slices, perCountry, discovery) |
| `GET /api/alerts` | daftar alert (unresolved dulu) |
| `POST /api/alerts` | body `{action:'resolve', id?, type?}` |
| `GET /api/videos` | TIDAK BERUBAH (filter/sort/pagination) — global kini dedupe per tiktokId |
| `POST /api/sync` | LEGACY → global scrape (kompatibel) |

## WebSocket (socket.io :4030 via gateway)

Connect: `io("/?XTransformPort=4030", { path: "/" })`.

| Event | Payload | Frekuensi |
|---|---|---|
| `bot:status` | `{reachable, running, session, circuit, metrics, slices, unresolvedAlerts, nextRunAtMs, totalVideos, atMs}` | 2 dtk |
| `job:update` | job aktif `{...job, progress:{total,done,failed}, live:true}` atau hasil job terakhir `live:false` | 2 dtk / on-change |
| `data:update` | `{totalVideos, delta}` | saat total naik |
| `alert:new` | `{alert}` | alert baru |
| `slices:update` | `{perCountry:[{country,done,failed,pending,running,lastSuccessAt}]}` | ≤5 dtk / on-change |
| `hello` | snapshot awal `{perCountry, alerts, totalVideos}` | on-connect |

## Session Resilience

- 401/403 mid-run → re-login otomatis (auth_hook) → request diulang.
- Login gagal 3× berturut → state `human_required` → **job pause otomatis** + alert `critical/session`;
  recovery loop mencoba login tiap 5 mnt; pulih → alert resolve + job auto-resume (sisa slice pending).

## Restart Recovery

- Boot: `recover_boot()` → slice `running→pending`, job `running→paused` → scheduler resume
  (job `pausedReason: 'restart — auto-resume'`).
- Job global otomatis per jam bila idle & data basi (> 55 mnt).
- Budget/deadline job → stop dequeue; slice sisa tetap `pending` → dilanjutkan job berikutnya (tanpa data terbuang).

## Politeness

- Throttle adaptif global 300ms (min 220 / max 900 saat 429) + jitter ±20%.
- Circuit breaker: window 40 request; ≥60% gagal (5xx/429/timeout) → OPEN 60s → half-open probe 3× → closed.
- Slice retry pasien: 3 attempt (backoff 5/15/45s + jitter); ≥6 attempt kumulatif → `dead` (retry manual).

---

# v7 — scope-command (2026-10-09)

Diagnosis: docs/scraping-v7/01-DIAGNOSIS.md · Plan: docs/scraping-v7/02-PLAN.md

## Perubahan inti v7

1. **Vocabulary status baru (ISOLASI ZOMBIE)** — proses v6 zombie (root, tak bisa dibunuh)
   hanya SELECT `queued`/`pending`/`paused`:
   - `ScrapeJob.status`: `ready → running → held → completed | failed | cancelled`
   - `ScrapeSlice.status`: `ready → running → done | failed | dead`
   - Kolom baru `ScrapeJob.owner` = `z7` saat di-klaim v7.
2. **Scope = perintah** (tanpa tombol start): POST /jobs dedup + unhold otomatis.
3. **Preemption**: klik UI (priority 0) mendahului job berjalan (priority 10) —
   thread preemptor menandai `ctx.preempted` → in-flight selesai, sisa slice kembali
   `ready`, job → `held` (auto-resume saat antrean kosong). Tidak ada data hilang.
4. **Freshness TTL** per bucket (RC4): `SLICE_TTL_MS` — job start me-reclaim slice `done`
   yang basi → `ready`. Fresh dipakai ulang, basi di-refresh.
5. **Breaker collapse-only**: OPEN hanya bila rasio gagal ≥ 0.9 pada window penuh 30 req
   (sumber terbukti gagal ~50% request secara ACAK — bukan rate-limit; retry cepat 0.4–6.4s).
6. **Kill-recovery**: boot → slice running→ready, job running (heartbeat basi) → held
   (auto-resume), job legacy queued → cancelled.

## Endpoint baru (:4020)

| Method & Path | Body | Respons |
|---|---|---|
| `POST /jobs` | `{scopeType:'global'\|'country', scopeValue?, source?}` | `{ok, started, unheld, alreadyQueued, job}` |
| `POST /jobs/cancel` | `{id}` | `{ok, cancelled}` / `{ok, cancelling}` utk running |
| `POST /jobs/promote` | `{id}` | `{ok, job}` (hanya status ready) |

## Event socket.io baru (:4030)

| Event | Payload | Frekuensi |
|---|---|---|
| `queue:update` | `{jobs:[{id,scopeType,scopeValue,status,trigger,priority,pausedReason,progress?,createdAt,owner}]}` | 2 dtk (on change) |

## Next.js API v7

| Method & Path | Perubahan |
|---|---|
| `POST /api/scrape` | + `{action:'cancel', id}` dan `{action:'promote', id}` pass-through |
| `GET /api/scrape` | + field `queue` (dari snapshot) |
| `GET /api/meta` | + `queue` ringkas + `nextRunAtMs` |

## KEEP-ALIVE v8 (2026-10-10) — bot tetap hidup terus-menerus

Insiden: sandbox reset menghapus `.env` (gitignored, chmod 600) → bot FATAL boot →
crash-loop supervisor → UI "Bot sinkronisasi tidak aktif" selamanya. Dua akar:
(1) kredensial tidak resilien, (2) probe `Bun.connect({hostname,port})` supervisor
SELALU gagal (TypeError: SocketOptions.socket is required di Bun 1.3.14) → mode
adopsi tidak pernah berfungsi → spawn-ganda EADDRINUSE tiap siklus.

Lapisan baru:

| Lapisan | Komponen | Perilaku |
|---|---|---|
| L0 | `ensure_env.py` | Pulihkan kredensial: env host → git history (blob lama) → tulis `.env` 600. Nilai TIDAK pernah dicetak. |
| L1 | supervisor preflight | Jalankan `ensure_env.py` sebelum spawn; gagal → `down.json` + tunggu 60s (bukan crash-loop). |
| L2 | `down.json` → realtime → UI | Bot mati cepat (<60s) → supervisor diagnosa `config.validate()` (tanpa rahasia) → tulis `down.json` {reason, lastExitCode, sinceMs, restarts}. Realtime (:4030) membacanya saat bot unreachable → field `down` di `bot:status`. OpsPanel menampilkan "Penyebab: …", toast 502 `/api/scrape` menyertakan `reason`. `down.json` dihapus otomatis saat bot hidup (>90s / terdeteksi). |
| L3 | probe fix | `botAlive()` kini `node:net` connect (pola bot-anchor.ts) — adopsi bot hidup benar-benar berfungsi (terbukti: "mode pasif (cek 30s)" muncul pertama kalinya). |
| L4 | session-first boot (main.py) | Kredensial hilang TAPI `session.json` berisi cookie → boot DEGRADED + alert critical `type=config` (bukan mati). Kredensial kembali → alert config di-resolve otomatis saat boot sehat. |

Rantai pengawasan lengkap (semua teruji):
next-server (bot-anchor, 60s) → supervisor (lock+preflight+backoff) → bot
(watchdog internal menumbuhkan supervisor & realtime & next-dev bila mati).

Contrak `bot:status` +field: `down?: {reason: string; lastExitCode: number|null; sinceMs: number|null} | null`.
