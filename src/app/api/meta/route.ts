import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  COUNTRIES, ensureEngine, fetchScraperSnapshot, getSyncState, mergeDiscoveredCountries,
  SYNC_INTERVAL_MS, windowWhereFor, WINDOWS, readScraperStatus, MIN_SALES, MIN_VIEWS,
} from "@/lib/trend-engine";

export const dynamic = "force-dynamic";

// TTL cache 15 detik — lindungi DB dari polling klien saat bot menulis (UI tetap terasa real-time)
const META_CACHE_TTL_MS = 15_000;
const metaCache = new Map<string, { at: number; payload: unknown }>();

export async function GET(req: NextRequest) {
  try {
    await ensureEngine();
    const windowKey = req.nextUrl.searchParams.get("window") ?? "30d";

    const cached = metaCache.get(windowKey);
    if (cached && Date.now() - cached.at < META_CACHE_TTL_MS) {
      return NextResponse.json(cached.payload);
    }

    // Statistik window saat ini: rolling (createTimeMax) atau day:N (windowBucket equality)
    const windowWhere = windowWhereFor(windowKey);
    const nowSec = Math.floor(Date.now() / 1000);
    // Cutoff per window (identik dengan definisi WINDOWS) untuk rollup 1 query
    const cutoff = Object.fromEntries(
      WINDOWS.map((w) => [w.key, nowSec - w.seconds])
    ) as Record<string, number>;
    const bucketDay = [2, 3, 4, 5, 6, 7]; // day:N → windowBucket = 12-N (bucket 5..10)

    const [byCountry, byCategory, totals, state, rollupRows, perDayRows] = await Promise.all([
      db.trendVideo.groupBy({ by: ["country"], _count: { _all: true }, where: windowWhere }),
      db.trendVideo.groupBy({
        by: ["category"], _count: { _all: true }, where: windowWhere,
        orderBy: { _count: { category: "desc" } },
      }),
      db.trendVideo.aggregate({
        _count: { _all: true },
        _sum: { views: true, likes: true, sales: true, gmv: true },
        where: windowWhere,
      }),
      getSyncState(),
      // Jumlah video per window (badge pill Kemarin/7/15/30) — 1 query SUM CASE (hemat 3 count)
      db.$queryRaw<Array<{ kemarin: number; w7: number; w15: number; w30: number }>>`
        SELECT
          COALESCE(SUM(CASE WHEN createTimeMax >= ${cutoff.kemarin} THEN 1 ELSE 0 END), 0) AS kemarin,
          COALESCE(SUM(CASE WHEN createTimeMax >= ${cutoff["7d"]} THEN 1 ELSE 0 END), 0) AS w7,
          COALESCE(SUM(CASE WHEN createTimeMax >= ${cutoff["15d"]} THEN 1 ELSE 0 END), 0) AS w15,
          COALESCE(SUM(CASE WHEN createTimeMax >= ${cutoff["30d"]} THEN 1 ELSE 0 END), 0) AS w30
        FROM TrendVideo`,
      // Jumlah video per hari H-2..H-7 — 1 query GROUP BY (hemat 5 count)
      db.$queryRaw<Array<{ windowBucket: number; cnt: number }>>`
        SELECT windowBucket, COUNT(*) AS cnt FROM TrendVideo
        WHERE windowBucket IN (5, 6, 7, 8, 9, 10)
        GROUP BY windowBucket`,
    ]);

    const rollup = rollupRows[0] ?? { kemarin: 0, w7: 0, w15: 0, w30: 0 };
    const windowCounts = [
      { key: "kemarin", count: Number(rollup.kemarin) },
      { key: "7d", count: Number(rollup.w7) },
      { key: "15d", count: Number(rollup.w15) },
      { key: "30d", count: Number(rollup.w30) },
    ];
    const perDayMap = new Map(
      perDayRows.map((r) => [Number(r.windowBucket), Number(r.cnt)])
    );
    const perDay = bucketDay.map((day) => ({
      day,
      count: perDayMap.get(12 - day) ?? 0,
    }));

    const countries = COUNTRIES.map((c) => {
      const hit = byCountry.find((b) => b.country === c.code);
      return { ...c, count: hit?._count._all ?? 0 };
    });
    const categories = byCategory.map((b) => ({ name: b.category, count: b._count._all }));

    const scraper = readScraperStatus();

    // v6 — snapshot bot: freshness per negara (slice), session state, job aktif, alerts.
    const snap = await fetchScraperSnapshot();
    const perCountry = (snap?.perCountry ?? []) as Array<{
      country: string; done: number; failed: number; pending: number; running: number;
      lastSuccessAt: number | null;
    }>;
    const freshnessMap = new Map(perCountry.map((p) => [p.country, p]));
    const discoveredRegions = Object.entries(
      ((snap?.discovery as Record<string, unknown>)?.regions ?? {}) as Record<string, string>
    ).map(([code, name]) => ({ code, name }));
    const mergedDefs = mergeDiscoveredCountries(discoveredRegions);
    const countriesV6 = mergedDefs.map((c) => {
      const hit = byCountry.find((b) => b.country === c.code);
      const fresh = freshnessMap.get(c.code);
      return {
        ...c,
        count: hit?._count._all ?? 0,
        lastScrapedAt: fresh?.lastSuccessAt ?? null,
        failedSlices: fresh?.failed ?? 0,
        pendingSlices: fresh?.pending ?? 0,
        runningSlices: fresh?.running ?? 0,
      };
    });

    const session = (snap?.session ?? null) as Record<string, unknown> | null;
    const activeJob = (snap?.activeJob ?? null) as Record<string, unknown> | null;
    const unresolvedAlerts = Number(snap?.unresolvedAlerts ?? 0);

    // v5.1 — progres siklus berjalan (heartbeat bot tiap 30 dtk) + nextSyncAt efektif:
    // saat siklus berjalan → null (UI menampilkan "Siklus berjalan", bukan countdown palsu);
    // idle → pakai nextRunAtMs bot (sumber paling akurat) → fallback SyncState.nextSyncAt.
    const cycleProgress = scraper?.cycleProgress ?? null;
    const scraperRunning = scraper?.running ?? false;
    const nextRunMs = scraperRunning
      ? null
      : (scraper?.nextRunAtMs ?? null) ?? (state.nextSyncAt ? state.nextSyncAt.getTime() : null);
    const nextSyncAtIso = nextRunMs ? new Date(nextRunMs).toISOString() : null;

    const payload = {
      ok: true,
      source: "real",
      storage: "z-ai-cloud-db",
      minRules: { minSales: MIN_SALES, minViews: MIN_VIEWS },
      countries: countriesV6,
      categories,
      windowCounts,
      perDay,
      stats: {
        videos: totals._count._all,
        views: totals._sum.views ?? 0,
        likes: totals._sum.likes ?? 0,
        sales: totals._sum.sales ?? 0,
        gmv: totals._sum.gmv ?? 0,
        countries: countriesV6.filter((c) => c.count > 0).length,
      },
      // v6: ringkasan sistem scraping (session, job aktif, alerts, freshness)
      system: {
        sessionState: (session?.state as string) ?? "unknown",
        sessionAgeDays: (session?.ageDays as number) ?? null,
        botReachable: snap !== null,
        circuit: snap?.circuit ?? null,
        activeJob,
        // v7: antrian job lengkap (ready/running/held) — untuk UI status per scope
        queue: (snap?.queue ?? []) as Array<Record<string, unknown>>,
        unresolvedAlerts,
        slices: snap?.slices ?? null,
      },
      alerts: ((snap?.alerts ?? []) as Array<Record<string, unknown>>)
        .filter((a) => !a.resolvedAt)
        .slice(0, 10),
      sync: {
        lastSyncAt: state.lastSyncAt,
        nextSyncAt: nextSyncAtIso,
        syncCount: state.syncCount,
        status: scraperRunning ? "syncing" : state.status,
        lastError: state.lastError,
        intervalMs: SYNC_INTERVAL_MS,
        scraper: scraper
          ? {
              running: scraper.running ?? false,
              nextRunAtMs: scraper.nextRunAtMs ?? null,
              sessionDays: scraper.session?.ageDays ?? null,
              cycle: cycleProgress,
              lastCycle: scraper.lastCycle
                ? {
                    ok: scraper.lastCycle.ok,
                    phase: scraper.lastCycle.phase,
                    trigger: scraper.lastCycle.trigger,
                    finishedAtMs: scraper.lastCycle.finishedAtMs,
                    durationMs: scraper.lastCycle.durationMs,
                    requests: scraper.lastCycle.requests,
                    fetched: scraper.lastCycle.fetched,
                    upserted: scraper.lastCycle.upserted,
                    newVideos: scraper.lastCycle.newVideos,
                    productsUpdated: scraper.lastCycle.productsUpdated,
                  }
                : null,
            }
          : null,
      },
    };

    metaCache.set(windowKey, { at: Date.now(), payload });
    return NextResponse.json(payload);
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
