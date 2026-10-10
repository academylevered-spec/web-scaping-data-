# PHASE 1 — ARCHITECTURE & ORDERED PLAN: TrendScraper v7 "scope-command"

Reads: docs/scraping-v7/01-DIAGNOSIS.md. Every step is small + testable + states verification.

---

## 1. Final architecture (delta from v6)

```
 UI (Next.js :3000)
   │ click scope chip (Global / Country)  = THE COMMAND, no extra start step
   │ POST /api/scrape {scope, country}    → proxy
   ▼
 Bot HTTP :4020  POST /jobs ──► ScrapeJob(status='ready', priority 0|5|10, owner='z7')
   ▲                                │
   │ scheduler (single worker loop) │
   │   1. adopt stale z-owned running jobs (crash recovery)
   │   2. PREEMPT: if a 'ready' job has priority < running job's priority
   │      → signal ctx.preempted → in-flight slices finish, rest released
   │      → running job → 'held' (pausedReason='preempted') → claim high-prio job
   │   3. else resume oldest 'held' job (priority ≤ nothing-ready rule)
   │   4. else claim next 'ready' (priority ASC, createdAt ASC)
   ▼                                ▼
 SliceQueue (12 workers) ──► ScrapeSlice(status='ready') ──► creatok.ai
   │  fast 5xx retry (0.4..6.4s) + collapse-only breaker + adaptive throttle
   ▼
 Store (SQLite WAL, shared w/ Prisma & realtime RO)
   upsert TrendVideo (unique tiktokId+country) · ScrapeSlice.lastSuccessAt (freshness)
 Realtime :4030 (socket.io)  ←poll /snapshot + SQLite RO→  bot:status · job:update
                                                          · queue:update · data:update
                                                          · alert:new · slices:update
```

### Job model (v7 vocabulary — THE ZOMBIE SHIELD)
- **Z-vocabulary (used by v7 bot only)**: ScrapeJob status ∈ `ready, running, held,
  completed, failed, cancelled`; ScrapeSlice status ∈ `ready, running, done, failed, dead`.
- **Zombie vocabulary (PID 920, unkillable)**: jobs `queued/running/paused/…`, slices
  `pending/…`. It only SELECTs those literals ⇒ it can never see or claim z7 rows.
- `ScrapeJob.owner TEXT DEFAULT NULL` — set to `'z7'` when v7 claims a job. Boot adoption
  only touches z-owned or stale-heartbeat rows. Overlap `running` in zombie's dedup query
  is INTENTIONAL (prevents zombie scheduling duplicate global jobs while ours runs).
- Adoption thread promotes orphan zombie rows: `pending` slices (untouched >10 min) →
  `ready`; zombie `queued` jobs are left to the zombie (it runs them itself with pending=0
  after migration → harmless instant no-op; their SyncLog rows are informational).

### Priorities
| priority | source | meaning |
|---|---|---|
| 0 | UI click (scope = command) | preempts anything ≥ its rank |
| 5 | retry-failed (manual) | dead-letter requeue |
| 10 | scheduled freshness sweep | background refresh |

Preemption rule: `exists(ready job.priority < running job.priority)` → preempt.
Same-scope click while held/queued → **unhold / promote** (never duplicate).
Dedup: create_job returns existing active job for the scope.

### Freshness TTL (RC4) — config dict, env-overridable
| bucket | window | TTL |
|---|---|---|
| 1 | 36h (Kemarin) | 90 min |
| 2 | 7d | 4 h |
| 3 | 15d | 8 h |
| 4 | 30d | 12 h |
| 10..5 | day:2..day:7 | 6 h |

Job start: `reclaim_stale(scope)` flips `done → ready` where
`lastSuccessAt < now - TTL(bucket)` (scope-respecting). Fresh slices are reused; only
stale ones are re-scraped. If 0 slices to do → job completes instantly `already-fresh`.

### Breaker & retry (RC2)
- `get_json` 5xx curve: 0.4s, 0.8s, 1.6s, 3.2s, 6.4s (+jitter ±30%) — 5 attempts; a
  retry succeeds ~50% immediately, so effective success ≈ 97% per call.
- Breaker opens ONLY when fail ratio ≥ 0.9 over ≥ 30 requests (true collapse). Half-open
  probe requires 3 consecutive successes. 429 handling unchanged (throttle ×2).
- Politeness: WORKERS=12, throttle base 300ms adaptive 220–900ms (unchanged), global
  rate-lock shared across threads (unchanged).

### Session resilience (kept from v6, verified + exercised in E2E)
- 401/403 mid-run → auth_hook → relogin → retry same request (session recovery).
- 3 consecutive login failures → `human_required` → only affected behavior pauses
  (queue stops claiming; other jobs wait), critical alert; recovery loop retries login
  every 5 min; success → auto-resume held jobs. `/session/invalidate` exists for tests.

### Realtime contract (additive; full doc in CONTRACT.md v7)
| Event | Payload | When |
|---|---|---|
| `bot:status` | unchanged + `queueLen` | 2s |
| `job:update` | `{...job, progress, live}` | active job 2s / finish |
| `queue:update` | `{jobs:[{id,scopeType,scopeValue,status,priority,progress,pausedReason}]}` (ready/held/running) | 2s on change |
| `data:update` | `{totalVideos, delta}` | on new videos |
| `alert:new` / `slices:update` | unchanged | on change |

### API (bot :4020 additions)
- `POST /jobs` — body `{scopeType, scopeValue?, priority?, source?}`; dedups active scope;
  if same scope `held` → unhold; returns `{ok, started, alreadyQueued|unheld, job}`.
- `POST /jobs/cancel` — `{id}` → cancel `ready/held` instantly; running → graceful
  preempt-to-cancel (job → `cancelled`).
- `POST /jobs/promote` — `{id}` → priority 0 + unhold (UI re-click while queued).
- `GET /snapshot` — adds `queue` (visible jobs) + `instance:{version,owner,pid}`.
- Legacy `/trigger`, `/status`, `/jobs/retry-failed`, `/alerts/resolve` kept.

### Next.js API (:3000)
- `POST /api/scrape` — unchanged shape + `{action:'cancel'|'promote', id}` pass-through.
- `GET /api/scrape` — adds `queue`.
- `GET /api/meta` — adds `queue` summary (running/ready counts) + `nextRunAtMs`.

### Frontend
- **Chips = command**: every click POSTs; backend decides (dedup/unhold/stale-only) —
  toasts mirror the backend verdict (started / already running / already fresh).
- Chip ring states: running (amber pulse), queued/held (zinc), done (none) — from
  `queue:update`.
- SyncPill: active scope + progress + session health dot + next-run countdown.
- OpsPanel: queue table (scope, status, priority, progress, cancel ×, promote ↑),
  retry-failed, alerts, metrics, circuit, session.
- New-data toast + query invalidation on `data:update` (kept).

### Storage changes
- `ScrapeJob.owner TEXT NULL` (additive; mirrored in prisma/schema.prisma + bot-side
  `ALTER TABLE` guard so bot works even before prisma push). No other schema change.

## 2. Failure modes → handling

| Failure | Handling |
|---|---|
| Source 5xx ~50% (chronic) | fast retry per request; breaker stays closed |
| Source true collapse | breaker OPEN 45s → probe → resume; alert (cooldown 10 min) |
| HTTP 429 | throttle ×2 (max 900ms), backoff |
| Login failure / 401 mid-run | auth_hook relogin; request retried; job continues |
| 3× login fail (captcha/2FA/lock) | human_required: stop claiming, job → held (reason session), critical alert; recovery loop; auto-resume |
| Scope switch mid-run | preemption: in-flight finishes, rest released → ready; job → held; higher-prio starts; held resumes later |
| Bot crash / kill | slices running→ready, jobs running→held at boot; heartbeat adoption; resumedCount++ |
| Duplicate job creation | create_job dedup on active scope; UI unhold/promote |
| Zombie interference | vocabulary separation + owner column + pending-adoption (>10 min) |
| SQLite contention | WAL + busy_timeout; single writer thread per process; realtime RO |
| Realtime down | UI falls back to polling /api/meta (30s), socket auto-reconnects |

## 3. Ordered checklist (each step: action → verification)

1. **P-config** config.py v7 constants (TTL, breaker, workers, retries) → `python3 -c
   "import config"` OK.
2. **P-client** creatok.py fast-5xx curve + no email in logs → unit run 20 requests:
   ≥95% eventual success, no email printed.
3. **P-breaker** slice_queue.py collapse-only breaker → offline fake-client test
   (tests/test_v7_offline.py) asserts closed at 50% fail, open at ≥90%.
4. **P-store** store.py v7: ALTER owner, vocabulary, reclaim_stale, adopt_pending,
   promote/cancel/resume-held helpers, scope-aware claim → offline test on a TEMP DB
   copy asserts: claim order, stale reclaim, vocabulary isolation.
5. **P-engine** scraper.py run_job: reclaim at start, `already-fresh` path, preempted
   finish status → offline test.
6. **P-main** main.py v7 scheduler: adoption, preemption, resume-held, heartbeat,
   new endpoints → restart bot; `GET /health` shows version 7.0.
7. **P-migrate** run one-time SQL: legacy running slices→ready (except zombie's live),
   legacy queued country jobs (the 7 stuck) → cancelled with note (they'll be re-created
   by UI clicks; avoids zombie claiming them mid-migration... actually zombie only claims
   one at a time and is busy; safer: leave them, adoption ignores 'queued').
   → verify by SQL counts.
8. **P-api-bridge** realtime index.ts: queue:update + status vocab mapping → connect a
   socket.io client script, receive events.
9. **P-nextapi** /api/scrape + /api/meta additions, prisma schema owner column →
   `bun run lint` + curl through :3000.
10. **P-ui** trend-explorer / country-chips / sync-pill / ops-panel updates →
    agent-browser: click Indonesia → toast + chip ring + LIVE progress < 10s.
11. **E2E-A scope command**: click ID → only ID slices run (SQL: running slices all
    country=ID); click Global → preempt check; verify held + resume after.
12. **E2E-B session**: POST /session/invalidate mid-run → 401→relogin→job continues
    (snapshot job requests keep rising; session state healthy).
13. **E2E-C kill**: `kill -9` bot mid-run → supervisor respawns → job auto-resumes
    (resumedCount+1), no slice lost (SQL delta).
14. **E2E-D concurrency**: enqueue 5 country jobs rapid-fire → queue forms, all complete,
    zero duplicates (video count stable vs upserts), no deadlock (jobs list drains).
15. **E2E-E realtime**: agent-browser observes progress WITHOUT refresh; data:update
    increments visible in UI totals.
16. **P-quality**: `bun run lint` + `npx tsc --noEmit`(if configured) + python tests;
    final report + worklog update.

## 4. Assumptions (recorded, no user input needed)
- "Windows = yesterday/7/15/30d" maps to existing buckets 1-4 (+ daily buckets for the
  day:N view) — already the system's model.
- Stale-only refresh inside a clicked scope is the desired "reuse fresh data" behavior;
  TTLs are config-tunable (env).
- The 7 legacy stuck 'queued' jobs are left to the zombie/legacy path; UI clicks create
  fresh v7 jobs. No data loss either way.
- Zombie PID 920 remains alive; isolation is by vocabulary, not by killing it.
- No new runtime dependencies (socket.io, requests, etc. already present).
