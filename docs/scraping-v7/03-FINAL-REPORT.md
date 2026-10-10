# FINAL REPORT — Scope-Driven Scraping System v7 "scope-command"

Date: 2026-10-09 · Task: build/fix scope-driven scraping (one UI click = the command)
Deliverables: diagnosis, architecture, implementation, live E2E evidence, operations guide.

---

## 1. Root causes found (Phase 0 — evidence in `docs/scraping-v7/01-DIAGNOSIS.md`)

| # | Root cause | Evidence | Severity |
|---|---|---|---|
| RC1 | Zombie v6 bot process (root-owned, unkillable) racing on the same SQLite DB, status.json, session.json — double-executed jobs | stale-config `AttributeError` on SG job; global job adopted by 2nd process (resumedCount=3); two `python main.py` PIDs | CRITICAL |
| RC2 | Source fails **~50% of requests randomly** (HTTP 500 JSON body; **zero** 429 ever) — NOT rate-limiting, NOT auth. v6 circuit breaker (60% threshold) opened constantly → bot waited more than scraped | controlled probe: 6/12 identical requests = `{"code":500}`; live log: endless OPEN→probe→OPEN; `ok:1440, 5xx:1345` | CRITICAL |
| RC3 | Scope clicks did NOT preempt the running job — 7 user country clicks queued 1h+ behind a 60–90-min global sweep; no cancel/deprioritize path existed | ScrapeJob table: 7 jobs `priority=0 trigger=ui` created 08:13–08:30, still `queued` at 09:11 | CRITICAL |
| RC4 | No freshness policy — `done` slices stayed done forever; after the first sweep every scheduled job was a no-op; data aged indefinitely | `claim_slices` takes only `pending`; nothing ever reset `done→ready` | CRITICAL |
| RC5 | Boot crash-loops (missing `requests` module; mid-edit `UnboundLocalError`) — 12 restarts in supervisor log | historical, mitigated by preflight since v5.1 | HIGH |
| RC6 | Alert noise (breaker alert every 10 min), status.json `discovery.regions` always 0, account email printed to logs | log + status.json inspection | MEDIUM |
| RC7 | Frontend silently swallowed scope clicks (<30-min freshness skip, client-side dedup) | `triggerScrape` in trend-explorer.tsx | MEDIUM |

## 2. Final architecture

```
UI chip click (Global / Country) = THE COMMAND — no extra start step
  └─ POST /api/scrape ──► Bot :4020 POST /jobs
        create_or_unhold_job: dedup active scope · unhold held job · promote re-click
Scheduler (one job at a time) + PREEMPTOR thread (2s):
  - country job ready  ⇒ ALWAYS preempts a running GLOBAL sweep (hold, no data loss)
  - lower priority ready ⇒ preempts running (ui=0 < retry=5 < scheduled=10)
  - idle ⇒ resume oldest held (auto) ⇒ scheduled freshness global sweep
Freshness TTL per window bucket: 36h→90m · 7d→4h · 15d→8h · 30d→12h · day:N→6h
  job start reclaims stale `done` slices (scope-respecting) → fresh data reused, stale refreshed
SliceQueue (12 workers): fast 5xx retry (0.4–6.4s + jitter) · collapse-only breaker
  (OPEN only ≥90% fail over full 30-request window) · adaptive politeness throttle
Session: session.json persistence · 401→serialized re-login→retry · 3 fails = human_required
  → jobs hold + critical alert → recovery loop → auto-resume
Zombie isolation (RC1, cannot kill root PID): v7 vocabulary `ready/running/held/cancelled`
  vs zombie's `queued/pending/paused` + ScrapeJob.owner='z7' — zombie can never see/claim v7 work;
  adoption loop pulls orphan zombie rows (pending slices >10 min, stale-heartbeat jobs)
Realtime :4030 (socket.io via Caddy gateway): bot:status · job:update · queue:update (NEW) ·
  data:update (UI invalidates queries → new data without refresh) · alert:new · slices:update
Storage: shared SQLite WAL — TrendVideo unique (tiktokId, country) · ScrapeSlice per
  country×category×window with lastSuccessAt (per-slice "last updated" metadata) · idempotent upserts
```

## 3. Changes per file

**Python bot (`mini-services/trend-scraper-python/`)**
- `config.py` — v7 constants: SLICE_TTL_MS (env-overridable), collapse-only breaker params, WORKERS 12, RETRY_DELAY_5XX curve, INSTANCE_ID/JOB_PRIORITY, `slice_ttl_ms()`
- `creatok.py` — fast 5xx retry curve + jitter; removed email from logs
- `store.py` — `ensure_schema` (owner column), `create_or_unhold_job`, `claim_next_job`(ready+owner), `next_ready_job`, `resume_held_job`, `hold_job`, `cancel_job`, `promote_job`, `reclaim_stale`, `adopt_pending_slices`, `release_running_slices`, v7 `recover_boot` migration, vocabulary updates everywhere
- `slice_queue.py` — collapse-only CircuitBreaker; preempt-aware neutral stops; releases slices to `ready`
- `scraper.py` — CycleContext `preempted`/`cancel_requested`; scope-aware stale reclaim at job start; instant `already-fresh` completion; held/cancelled finish paths (skip product phase)
- `session.py` — serialized `handle_auth_challenge` (fixes thundering-herd logins → 5× 429 storm)
- `main.py` — `should_preempt`/`prefer_ready_over_held` (country-beats-global rule), preemptor thread, `/jobs/cancel` + `/jobs/promote`, queue in `/snapshot`, status.json v7 fixes, instance tagging
- `supervisor.ts`, `CONTRACT.md` — contract v7 section (events, endpoints, vocabulary)

**Next.js**
- `prisma/schema.prisma` — `ScrapeJob.owner String?`, v7 status docs (additive push)
- `src/app/api/scrape/route.ts` — `action: cancel|promote` pass-through; GET returns `queue` + `instance`
- `src/app/api/meta/route.ts` — `system.queue`
- `src/hooks/use-realtime.ts` — `QueueJob` type, `queue:update` listener, `scopeJobMap()`
- `src/components/trend/trend-explorer.tsx` — scope-command triggerScrape (always POST; backend decides; honest toasts incl. unhold)
- `src/components/trend/country-chips.tsx` — per-scope ring: running (amber) / queued (zinc)
- `src/components/trend/ops-panel.tsx` — live queue table with progress, pausedReason, legacy tag, cancel buttons
- `tests/test_v7_offline.py` — NEW 23-assertion offline suite (temp DB copy)
- `docs/scraping-v7/01-DIAGNOSIS.md`, `02-PLAN.md`, `03-FINAL-REPORT.md` — this document

## 4. How to run & operate

- Everything self-heals: `next-server → bot-anchor → supervisor → python bot` (watchdog both directions), realtime :4030 respawned by bot watchdog.
- **Operate from the UI only**: click a country chip (or Global) = scrape that scope now; LIVE pill shows progress; panel "Sistem" shows queue + cancel × per job; alerts surface session problems (captcha/2FA) with auto-recovery.
- Bot HTTP ops (`:4020`): `GET /snapshot`, `POST /jobs {scopeType,scopeValue}`, `POST /jobs/cancel {id}`, `POST /jobs/promote {id}`, `POST /jobs/retry-failed`, `POST /session/invalidate` (test logout).
- Config via `mini-services/trend-scraper-python/.env` (credentials — never logged) + optional `SLICE_TTL_MS_JSON` env for freshness tuning.
- Tests: `python3 tests/test_v7_offline.py` (23 assertions), `tests/test_session_recovery.py`, `tests/test_human_required.py`.

## 5. How scope selection & session recovery work (verified live)

**Scope = command**: click → POST → dedup/unhold → scheduler/preemptor enforce priority.
**Mid-run switch**: country click preempts a global sweep — in-flight slices finish (bounded seconds), the rest return to `ready` untouched, job → `held` with reason, the new scope starts immediately, the held job auto-resumes afterward with zero data loss.
**Freshness**: clicking an already-fresh scope completes instantly ("semua slice sudah fresh"); only stale slices are re-scraped.
**Session recovery**: cookie invalidation mid-run → 401 → single serialized re-login → request retried → job continues (log evidence: `[client] login OK` then requests kept rising). True human-required (captcha/2FA/lock) → only affected jobs hold + critical alert → recovery loop retries every 5 min → auto-resume.
**Crash recovery**: `kill -9` → supervisor respawns → boot migration adopts orphans, holds interrupted jobs, resumes them (resumedCount+1) — verified twice.

## 6. Test evidence (live platform, this session)

| Test | Result |
|---|---|
| Scope isolation (Indonesia) | all running slices `country=ID` (24/24); 170/194 slices done in ~4 min |
| Scope isolation (SA) | running slices all `country=SA` after preemption |
| Preemption mid-run | `[preempt] job 6cc0074d (global:ALL) → preempted oleh country:SA (prio 0)`; global held at 92 slices done, 0 lost; SA started instantly |
| Session logout simulation | cookies wiped mid-run → 401 → relogin OK → SA job continued (requests 163→329→511, 203/203 done) |
| Kill -9 ×2 | supervisor respawn; orphan adoption (`jobs_z_stale:1, jobs_orphan_stale:1`); interrupted jobs resumed automatically |
| Concurrency + dedup | 15+ jobs enqueued (mine + user's live clicks); drained FIFO; **0 duplicates** on `(tiktokId, country)`; double-click dedup `alreadyQueued:true` |
| Freshness | fresh scopes complete instantly; stale BR genuinely re-scraped (71/95 → fresh timestamps); video total 68,870 → 70,863+ live |
| Breaker stability | CLOSED at failRatio 0.33–0.66 (v6 would have been OPEN); 5xx absorbed by fast retries |
| Realtime UI (gateway :81, agent-browser) | LIVE badge, Sesi sehat, live queue (Global ditahan · FR jalan 150/163 · …), UI cancel works ("Scrape 🇫🇷 FR dibatalkan"), totals update without refresh |
| Quality gates | `bun run lint` clean · `tsc --noEmit` clean for `src/` (20 pre-existing errors confined to Bun-runtime files) · python offline suite 23/23 PASS |

## 7. Known limitations

1. The zombie v6 process (root) remains alive by constraint; isolation is by DB vocabulary. If the sandbox ever restarts it, its `recover_boot` may briefly touch legacy-vocabulary rows only — v7 boots self-heal. 
2. A full global sweep with many stale slices can take 30–60 min at polite rates — by design (politeness + flaky source); country work always preempts it.
3. The source's ~50% random 500s persist (server-side); v7 absorbs them (fast retries → ~97% call success) but they bound throughput.
4. The 7 legacy stuck `queued` jobs were cancelled at migration (by design — re-click the scope to run it under v7).
5. `tsc` reports 20 pre-existing errors in Bun-runtime files (`mini-services/`, `examples/`) — outside the Next.js app, unchanged by this task.

## 8. Recommended next improvements

1. Prometheus-style `/metrics` endpoint + Grafana-style panel in OpsPanel (currently snapshot-based metrics).
2. Per-category and per-window progress in the UI (slice table already has the data).
3. Session cookie refresh proactively at ~6 days (already configured) + second-account failover for human_required periods.
4. Move job/slice claiming to `UPDATE ... WHERE status='ready' ... RETURNING` for stricter single-claim semantics if a second v7 instance is ever added.
5. Consider an optional headless-browser (Playwright) fallback for login when captcha appears, behind an explicit human-approval step.
