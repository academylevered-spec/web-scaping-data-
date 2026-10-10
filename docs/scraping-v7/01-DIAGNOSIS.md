# PHASE 0 — DIAGNOSIS: Scope-Driven Scraping System (v7 investigation)

Date: 2026-10-09 · Investigator: main agent · Method: full repo scan + live reproduction.
No code was changed during diagnosis. All findings below carry evidence.

---

## RC1 — CRITICAL: Zombie dual-instance bot racing on the same SQLite DB

**Evidence**
- `ps`: PID 920 (**root**, started 04:37, `/app/.venv/bin/python main.py`) AND PID 16278
  (user `z`, started 08:25, our service dir). Port 4020 is bound **only** by 16278
  → PID 920's HTTP server is dead but its **scheduler threads are alive**.
- Job `6fc43ee5` (SG, created 08:01:51, started 08:32:53) failed with
  `module 'config' has no attribute 'PRODUCT_MAX_REQUESTS'`. Current `config.py`
  defines that attr and was last modified **08:16:29**; current z-process started **08:25:47**.
  → the claimer must have had **old in-memory modules** ⇒ PID 920 (booted 04:37).
- PID 920 shares: `ScrapeJob`, `ScrapeSlice`, `SyncLog`, `status.json`, `session.json`.
- The running global job `62a901d4` was claimed by the zombie at 08:12:57, then the z-bot
  booted at 08:25 and `recover_boot()`→`resume_paused_job()` re-adopted it (resumedCount=3)
  ⇒ **both processes execute the same job concurrently**, double-claiming slices.
- PID 920 is root-owned; `kill` → EPERM; no sudo in sandbox. **Cannot be killed.**

**Consequences**: duplicate requests against the same account (politeness budget halved),
races on slice claims, status.json/lastCycle confusion, unpredictable job execution.

## RC2 — CRITICAL: Circuit breaker mis-tuned for a *chronically flaky* source → self-paralysis

**Evidence (controlled probe, 12 sequential requests, ~2.5 req/s, identical params
US×Beauty×36h):** 6/12 returned `{"code":500,"msg":"Internal Server Error","data":{}}`
in 0.5–3.5s, interleaved with 200s. A single probe one minute earlier: 200.
Zero HTTP 429 in all metrics ever recorded (`metrics: {"ok":1440,"5xx":1345,"429":0}`).
→ The source API fails **~50% of requests at random even at polite rates** (server-side
flakiness), it is NOT rate-limiting us and NOT a login/auth problem.

**Design flaw**: `CircuitBreaker` opens at ≥60% failure over a 40-request window.
With p(500)≈0.5 the breaker trips constantly (openCount=6 in 46 min), waits 60s,
half-open probe fails → reopens. Live log: endless
`OPEN → HALF-OPEN → probe gagal → OPEN` loop. Combined with slice-level backoff
(5/15/45s) the job spends most of its time **waiting instead of scraping**
(a global job stretches to 60–90 min).

**Correct fix**: fast per-request retries (an immediate retry succeeds ~50% of the time)
+ breaker that only opens on true collapse (fail ratio ≥ ~0.9 over a full window),
never on chronic 50% flakiness.

## RC3 — CRITICAL: Scope selection does NOT preempt the running job (core UX failure)

**Evidence**: user clicked US→ID→GB→TH→FR→DE→SA between 08:13–08:30 → 7 jobs created
`priority=0, trigger=ui`. At 09:11 **all 7 still `queued`** behind the global job started
08:12 (still running). Scheduler is strictly one-job-at-a-time and
`resume_paused_job()` runs **before** claiming queued jobs; nothing in the codebase can
cancel, preempt or deprioritize a running job.

→ "I click Indonesia and nothing happens for an hour" — the #1 reported symptom.

## RC4 — CRITICAL: No freshness policy — after the first full sweep the bot never scrapes again

**Evidence**: `ensure_slices` = `INSERT OR IGNORE`; `claim_slices` takes only
`status='pending'`; `complete_slice` leaves successful slices `done` **forever**; nothing
ever resets `done→pending` by age. The hourly scheduler creates a global job, sees
`pending=0` and finishes instantly ("semua slice scope ini sudah fresh").
→ Once the first sweep completes, all later jobs are no-ops: data ages forever,
"last updated" metadata freezes → the bot *appears dead*.

## RC5 — HIGH (historical): supervisor crash-loops

12 bot (re)starts recorded. Boot crashes: `ModuleNotFoundError: No module named 'requests'`
(boot pipeline raced venv readiness — since fixed by supervisor preflight) and
`UnboundLocalError: heartbeat_loop` (source edited while restarting). Current chain
`next-server → bot-anchor → supervisor → bot` works (uptime 46 min at time of writing).

## RC6 — MEDIUM: alert noise + status cosmetics

- "Sumber creatok.ai tertekan … circuit OPEN" every 600s (by-design cooldown) → 8 alerts/hour.
- `status.json.discovery.regions` always 0 (reads key `discoveryRegions` that is never written).
- `lastCycle` in status.json can show the zombie's stale error (RC1).
- `login OK ({email})` prints the account email to logs — secrets/PII policy violation.

## RC7 — MEDIUM: frontend silently swallows scope clicks

`trend-explorer.tsx: triggerScrape` skips enqueueing when data <30 min old
(toast "masih segar") and when the same scope is active. Requirement says
**selecting a scope IS the command** — the decision must be the backend's
(dedup / freshness / stale-only refresh), surfaced honestly in the UI, not a silent no-op.

---

## Verified WORKING (keep — do not regress)

| Area | Evidence |
|---|---|
| Login & session persistence | session.json (better-auth cookie), SessionManager state machine, 401→auth_hook→relogin→retry path; recovery loop with 5-min backoff; tests exist (`tests/test_session_recovery.py`, `test_human_required.py`) |
| Dynamic discovery | discovery.json: **16 regions × 29 categories**, source=live, TTL 6h, alert on new entries |
| Data integrity | TrendVideo unique per (tiktokId, country); idempotent upserts; slice = country×category×bucket; no cross-country contamination in code paths |
| Crash recovery | recover_boot(): zombie SyncLog, running slices→pending, running jobs→paused (in z-vocabulary: → held) |
| Realtime | socket.io :4030 via Caddy gateway (`io("/?XTransformPort=4030")`), events bot:status / job:update / data:update / alert:new / slices:update; UI invalidates queries on data:update (new data without refresh) |
| Next.js contracts | /api/scrape (POST scope→/jobs), /api/meta, /api/videos, /api/alerts, CONTRACT.md documents the system |
| Current data | 68,870 videos across 16 countries; job/slice tables live |

## Root-cause → requirement mapping (what v7 must add)

1. **Isolate the zombie** (RC1) → status-namespace separation + job `owner` column
   (z-bot claims only its vocabulary; periodic adoption of zombie-created rows).
2. **Preemption** (RC3) → priority-aware scheduler: UI country/global click preempts a
   running lower-priority job gracefully (in-flight finishes, rest released, no data loss),
   held jobs auto-resume when nothing higher-priority remains.
3. **Freshness TTL** (RC4) → per-bucket TTL; job start reclaims stale done slices
   (scope-respecting); fresh data is reused, only stale is refreshed.
4. **Breaker/retry retune** (RC2) → fast 5xx retry curve, collapse-only breaker,
   moderate politeness (workers 12, adaptive throttle).
5. **Cancel/promote + queue visibility** (RC3/RC6/RC7) → new bot endpoints, queue event
   over socket.io, ops-panel queue table with cancel/promote, honest chips/toasts.
6. **Hygiene** (RC5/RC6) → no email in logs, status.json fixes, alert dedupe tightened.

Residual risk (documented, cannot eliminate without root): if the sandbox ever restarts
PID 920, its `recover_boot()` may briefly re-mark z-owned running jobs. Mitigation:
z-bot boot adoption re-claims stale-heartbeat z-owned jobs automatically.
