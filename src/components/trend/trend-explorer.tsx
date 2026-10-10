"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { BadgeCheck, Globe, Play, SearchX, Zap } from "lucide-react";
import { VideoCard } from "./video-card";
import { VideoDetailDialog } from "./video-detail-dialog";
import { FilterBar, FilterState } from "./filter-bar";
import { CountryChips } from "./country-chips";
import { StatsStrip } from "./stats-strip";
import { SyncPill } from "./sync-pill";
import { WindowPills } from "./window-pills";
import { Navbar } from "./navbar";
import { OpsPanel } from "./ops-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { pill } from "@/lib/ui";
import { toast } from "sonner";
import { useRealtime, scopeJobMap } from "@/hooks/use-realtime";
import {
  MetaResponse,
  TrendVideo,
  VideosResponse,
  WINDOW_KEY_DEFAULT,
  WindowKey,
  isDayWindow,
  windowLabel,
} from "@/lib/trend-utils";

const DEFAULT_FILTERS: FilterState = {
  country: "all",
  category: "all",
  duration: "all",
  views: "all",
  traffic: "all",
  sort: "sales",
  search: "",
  shopOnly: false,
};

const PAGE_SIZE = 24;

/** Kelas grid video — SINGLE SOURCE (dipakai grid data & skeleton agar tak pernah beda). */
const VIDEO_GRID =
  "mt-4 grid grid-cols-2 gap-x-4 gap-y-8 sm:gap-x-5 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5";

const SORT_LABELS: Record<string, string> = {
  sales: "penjualan",
  gmv: "GMV",
  views: "views",
  likes: "suka",
  trending: "skor trending",
  newest: "terbaru",
};

interface VideosPage {
  ok: boolean;
  items: TrendVideo[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

async function fetchMeta(windowKey: WindowKey): Promise<MetaResponse> {
  const res = await fetch(`/api/meta?window=${windowKey}`, { cache: "no-store" });
  const json = (await res.json()) as MetaResponse;
  if (!json.ok) throw new Error("Gagal memuat metadata");
  return json;
}

async function fetchVideosPage(
  windowKey: WindowKey,
  f: FilterState,
  page: number
): Promise<VideosPage> {
  const params = new URLSearchParams({
    window: windowKey,
    country: f.country,
    category: f.category,
    duration: f.duration,
    views: f.views,
    traffic: f.traffic,
    sort: f.sort,
    search: f.search,
    shopOnly: f.shopOnly ? "1" : "0",
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const res = await fetch(`/api/videos?${params.toString()}`, { cache: "no-store" });
  const json = (await res.json()) as VideosPage;
  if (!json.ok) throw new Error("Gagal memuat video");
  return json;
}

export function TrendExplorer() {
  const queryClient = useQueryClient();
  const [windowKey, setWindowKey] = useState<WindowKey>(WINDOW_KEY_DEFAULT);
  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [selected, setSelected] = useState<TrendVideo | null>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [playOnOpen, setPlayOnOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [opsOpen, setOpsOpen] = useState(false);
  const rt = useRealtime();

  // Search ter-debounce: input langsung respons, query menyusul 350ms
  const debouncedSearch = useDebounced(filters.search, 350);
  const queryFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch]
  );

  // ── Meta (polling 30 detik agar status LIVE selalu segar) ──
  const metaQuery = useQuery({
    queryKey: ["meta", windowKey],
    queryFn: () => fetchMeta(windowKey),
    refetchInterval: syncing ? 5_000 : 30_000,
    refetchIntervalInBackground: false,
  });
  const meta = metaQuery.data ?? null;

  // ── Video list (infinite) ──
  const videosQuery = useInfiniteQuery({
    queryKey: ["videos", windowKey, queryFilters],
    queryFn: ({ pageParam }) => fetchVideosPage(windowKey, queryFilters, pageParam),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.hasMore ? last.page + 1 : undefined),
  });

  const flatVideos: Array<{ v: TrendVideo; rank: number }> = [];
  videosQuery.data?.pages.forEach((pg, pi) => {
    pg.items.forEach((v, i) => flatVideos.push({ v, rank: pi * pg.pageSize + i + 1 }));
  });
  const total = videosQuery.data?.pages[0]?.total ?? 0;
  const loadingVideos = videosQuery.isLoading;
  const loadingMore = videosQuery.isFetchingNextPage;

  // Prefetch halaman berikut saat hover tombol — klik terasa instan (v4)
  const prefetchNext = useCallback(() => {
    if (!videosQuery.hasNextPage || videosQuery.isFetchingNextPage || videosQuery.isFetching) return;
    void videosQuery.fetchNextPage();
  }, [videosQuery.hasNextPage, videosQuery.isFetchingNextPage, videosQuery.isFetching, videosQuery]);

  // ── v6: data baru masuk dari bot → invalidate query video (realtime tanpa refresh) ──
  useEffect(() => {
    if (rt.dataVersion > 0) {
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.invalidateQueries({ queryKey: ["meta"] });
    }
  }, [rt.dataVersion, queryClient]);

  // ── v6: toast saat job scraping selesai (live → selesai) ──
  const prevJobRef = useRef<{ live: boolean; id: string } | null>(null);
  useEffect(() => {
    const job = rt.job;
    if (!job) return;
    const prev = prevJobRef.current;
    prevJobRef.current = { live: job.live, id: job.id };
    if (prev && prev.live && !job.live) {
      toast.success("Scrape selesai", {
        description:
          (job.scopeType === "global"
            ? "Global"
            : job.scopeValue) +
        ` · ${(job.newVideos ?? 0).toLocaleString("id-ID")} video baru · ${
          job.progress?.done ?? 0
        } slice.`,
      });
      queryClient.invalidateQueries({ queryKey: ["videos"] });
      queryClient.invalidateQueries({ queryKey: ["meta"] });
    }
  }, [rt.job, queryClient]);

  // ── v7 scope-command: klik scope = PERINTAH. Selalu POST; backend yang memutuskan
  // (dedup / unhold / stale-only refresh). UI hanya menyampaikan hasilnya jujur. ──
  const triggerScrape = useCallback(
    async (scope: "global" | "country", country?: string) => {
      const label = scope === "global" ? "Global" : country ?? "";
      try {
        const res = await fetch("/api/scrape", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope, country, source: "ui" }),
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          started?: boolean;
          unheld?: boolean;
          alreadyQueued?: boolean;
          error?: string;
          reason?: string | null;
          job?: { status?: string } | null;
        } | null;
        if (res.status === 502) {
          // KEEP-ALIVE: tampilkan alasan nyata bila supervisor melaporkannya (down.json)
          toast.error("Bot sinkronisasi tidak aktif", {
            description: json?.reason
              ? json.reason
              : "Supervisor akan menyalakannya otomatis — coba lagi 1–2 menit.",
          });
          return false;
        }
        if (res.ok && json?.ok) {
          if (json.alreadyQueued) {
            // job scope sama sudah aktif (running/ready) — bukan error, info saja
            toast.info(`Scrape ${label} sudah berjalan/antre`, {
              description: "Pantau progres di pill LIVE atau panel Sistem.",
            });
          } else if (json.unheld) {
            toast.success(`Scrape ${label} dilanjutkan & diprioritaskan`, {
              description: "Job yang tertahan kini mendahului antrean.",
            });
          } else {
            toast.success(
              scope === "global"
                ? "Scrape GLOBAL dimulai"
                : `Scrape ${label} dimulai`,
              {
                description:
                  scope === "global"
                    ? "Semua negara × semua kategori × semua window — data segar dilewati, basi di-refresh."
                    : "Hanya negara ini, semua kategori & window — data segar dilewati.",
              }
            );
          }
          return true;
        }
        toast.error(json?.error ?? "Gagal memulai scrape");
        return false;
      } catch {
        toast.error("Gagal menghubungi server");
        return false;
      }
    },
    []
  );

  // ── Sync manual (v6): tombol sync = scrape GLOBAL (dedup via triggerScrape) ──
  const handleSync = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    try {
      await triggerScrape("global");
    } finally {
      setSyncing(false);
    }
  }, [syncing, triggerScrape]);

  // ── v6: klik chip negara = filter view + trigger scrape negara itu ──
  const handleCountrySelect = useCallback(
    (code: string) => {
      setFilters((f) => ({ ...f, country: code }));
      if (code === "all") {
        void triggerScrape("global");
      } else {
        void triggerScrape("country", code);
      }
    },
    [triggerScrape]
  );

  const resetAll = useCallback(() => {
    setFilters(DEFAULT_FILTERS);
    setWindowKey(WINDOW_KEY_DEFAULT);
  }, []);

  const openDetail = useCallback((v: TrendVideo, play = false) => {
    setSelected(v);
    setPlayOnOpen(play);
    setDetailOpen(true);
  }, []);

  const closeDetail = useCallback((open: boolean) => {
    setDetailOpen(open);
    if (!open) setPlayOnOpen(false);
  }, []);

  // Atribusi harian (v3): "day:N" ↔ select "Hari posting"
  const dayValue = isDayWindow(windowKey) ? windowKey : "all";
  const handleDayChange = useCallback((v: string) => {
    setWindowKey(v === "all" ? WINDOW_KEY_DEFAULT : (v as WindowKey));
  }, []);

  const dayCounts: Record<string, number> = {};
  (meta?.perDay ?? []).forEach((d) => {
    dayCounts[`day:${d.day}`] = d.count;
  });

  const windowCounts: Record<string, number> = {};
  (meta?.windowCounts ?? []).forEach((w) => {
    windowCounts[w.key] = w.count;
  });

  const minRules = meta?.minRules ?? { minSales: 10, minViews: 10_000 };
  const activeWindowLabel = windowLabel(windowKey);

  // v7: freshness per negara (socket) → map utk chip + status job per scope utk indikator
  const freshnessMap = useMemo(
    () => new Map(rt.perCountry.map((p) => [p.country, p])),
    [rt.perCountry]
  );
  const scopeJobs = useMemo(() => scopeJobMap(rt.queue), [rt.queue]);

  return (
    <>
      <Navbar
        onSync={handleSync}
        syncing={syncing}
        onOpenOps={() => setOpsOpen(true)}
        alertCount={rt.alerts.filter((a) => !a.resolvedAt).length}
        jobRunning={Boolean(rt.job?.live)}
      />

      {/* Hero dengan gradient halus (token warna brand terpusat di .hero-glow) */}
      <section className="relative overflow-hidden">
        <div className="hero-glow pointer-events-none absolute inset-0 -z-10" aria-hidden />
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: [0.23, 1, 0.32, 1] }}
          className="mx-auto w-full max-w-7xl px-4 pt-12 text-center sm:px-6 sm:pt-16 lg:px-8"
        >
          <SyncPill
            lastSyncAt={meta?.sync.lastSyncAt ?? new Date().toISOString()}
            nextSyncAt={meta?.sync.nextSyncAt ?? null}
            scraper={meta?.sync.scraper ?? null}
            job={rt.job}
            onSync={handleSync}
            syncing={syncing}
            onOpenOps={() => setOpsOpen(true)}
          />

          <h1 className="mx-auto mt-7 max-w-3xl font-semibold tracking-[-0.035em] text-zinc-900 dark:text-zinc-50 text-display-sm sm:text-display-md lg:text-display-lg">
            Trending.
            <br className="hidden sm:block" />
            <span className="bg-gradient-to-r from-emerald-600 via-emerald-500 to-teal-500 bg-clip-text text-transparent dark:from-emerald-400 dark:via-emerald-300 dark:to-teal-300">
              {" "}
              Terjual. Global.
            </span>
          </h1>

          <p className="mx-auto mt-5 max-w-xl text-base leading-relaxed text-zinc-500 dark:text-zinc-400">
            Video trending TikTok Shop dari {meta?.stats.countries ?? 13} negara, lengkap dengan link
            video &amp; produk. Data 100% real di-scrape langsung dari sumber, disinkron otomatis setiap jam.
          </p>

          {/* Garansi kualitas data */}
          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            <QualityBadge icon={<BadgeCheck className="h-3.5 w-3.5" aria-hidden />} label={`Min. ${minRules.minSales} penjualan`} />
            <QualityBadge icon={<Zap className="h-3.5 w-3.5" aria-hidden />} label={`Min. ${Math.round(minRules.minViews / 1000)}K views`} />
            <QualityBadge icon={<Play className="h-3.5 w-3.5" aria-hidden />} label="Putar video di sini" />
            <QualityBadge icon={<Globe className="h-3.5 w-3.5" aria-hidden />} label="Data real per jam" />
          </div>

          {/* Pill window waktu */}
          <div className="mt-8 flex justify-center">
            <WindowPills value={windowKey} counts={windowCounts} onChange={setWindowKey} />
          </div>
        </motion.div>
      </section>

      {/* Stats — max-w-7xl SEGARIS dengan grid/main/navbar (fix: tadinya 6xl → tepi tidak lurus).
          w-full WAJIB: anak flex-col dengan mx-auto tidak di-stretch (fit-content centered). */}
      <section className="mx-auto mt-10 w-full max-w-7xl px-4 sm:px-6 lg:px-8">
        <StatsStrip
          videos={meta?.stats.videos ?? 0}
          views={meta?.stats.views ?? 0}
          sales={meta?.stats.sales ?? 0}
          gmv={meta?.stats.gmv ?? 0}
          countries={meta?.stats.countries ?? 0}
          loading={metaQuery.isLoading}
        />
      </section>

      <section className="mx-auto mt-10 w-full max-w-7xl [contain:inline-size] px-4 sm:px-6 lg:px-8">
        <CountryChips
          countries={meta?.countries ?? []}
          selected={filters.country}
          onSelect={handleCountrySelect}
          freshness={freshnessMap}
          scopeJobs={scopeJobs}
        />
      </section>

      {/* Filter + Grid */}
      <main id="trending" className="mx-auto mt-6 w-full max-w-7xl scroll-mt-20 px-4 sm:px-6 lg:px-8" aria-label="Video trending">
        <FilterBar
          filters={filters}
          onChange={setFilters}
          onReset={resetAll}
          categories={meta?.categories ?? []}
          dayValue={dayValue}
          onDayChange={handleDayChange}
          dayCounts={dayCounts}
        />

        <p className="mt-4 text-ui text-zinc-500 dark:text-zinc-400" aria-live="polite">
          {loadingVideos
            ? "Memuat…"
            : `${total.toLocaleString("id-ID")} video ditemukan`}{" "}
          · {activeWindowLabel} · diurutkan berdasarkan {SORT_LABELS[filters.sort] ?? "penjualan"}
          {filters.shopOnly ? " · dengan produk TikTok Shop" : ""}
        </p>

        {loadingVideos ? (
          <GridSkeleton />
        ) : flatVideos.length === 0 ? (
          <EmptyState onReset={resetAll} onSync={handleSync} syncing={syncing} />
        ) : (
          <>
            <div className={VIDEO_GRID}>
              {flatVideos.map(({ v, rank }, i) => (
                <VideoCard key={v.id} video={v} rank={rank} index={i} onOpen={openDetail} />
              ))}
            </div>
            {videosQuery.hasNextPage && (
              <div className="mt-10 flex justify-center">
                <Button
                  onClick={() => videosQuery.fetchNextPage()}
                  onMouseEnter={prefetchNext}
                  onFocus={prefetchNext}
                  disabled={loadingMore || videosQuery.isFetching}
                  className={`${pill.base} ${pill.outline} px-7`}
                  aria-label="Muat lebih banyak video"
                >
                  {loadingMore ? "Memuat…" : "Muat lebih banyak"}
                </Button>
              </div>
            )}
          </>
        )}
      </main>

      <VideoDetailDialog
        // Key mencakup autoPlay: buka-ulang video sama dgn mode play berbeda
        // → remount → useState(autoPlay) berjalan lagi (fix tombol Play mati).
        key={selected ? `${selected.id}:${playOnOpen ? "play" : "open"}` : "none"}
        video={selected}
        open={detailOpen}
        onOpenChange={closeDetail}
        autoPlay={playOnOpen}
      />

      <OpsPanel open={opsOpen} onOpenChange={setOpsOpen} meta={meta} />
    </>
  );
}

function QualityBadge({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <span className="flex h-8 items-center gap-1.5 rounded-full bg-white/70 px-3 text-xs font-medium text-zinc-600 ring-1 ring-zinc-200/80 backdrop-blur dark:bg-zinc-900/70 dark:text-zinc-300 dark:ring-zinc-800">
      <span className="text-emerald-600 dark:text-emerald-400">{icon}</span>
      {label}
    </span>
  );
}

function GridSkeleton() {
  return (
    <div className={VIDEO_GRID} aria-hidden>
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i}>
          <Skeleton className="aspect-[9/16] w-full rounded-2xl" />
          <Skeleton className="mt-2.5 h-3.5 w-4/5 rounded-full" />
          <Skeleton className="mt-1.5 h-3 w-2/5 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ onReset, onSync, syncing }: { onReset: () => void; onSync: () => void; syncing: boolean }) {
  return (
    <div className="mt-10 flex flex-col items-center justify-center rounded-3xl bg-zinc-50 py-16 text-center ring-1 ring-zinc-100 dark:bg-zinc-900 dark:ring-zinc-800 sm:py-20">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-zinc-100 ring-1 ring-zinc-200 dark:bg-zinc-800 dark:ring-zinc-700" aria-hidden>
        <SearchX className="h-7 w-7 text-zinc-400" />
      </span>
      <p className="mt-4 text-lg font-semibold text-zinc-900 dark:text-zinc-100">Tidak ada video ditemukan</p>
      <p className="mt-1 max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        Coba ubah filter atau kata kunci pencarian — atau sinkronkan untuk menemukan konten trending terbaru.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-center gap-2.5">
        <Button onClick={onReset} className={`${pill.base} ${pill.dark} px-5`}>
          Reset filter
        </Button>
        <Button onClick={onSync} disabled={syncing} className={`${pill.base} ${pill.outline} px-5`}>
          {syncing ? "Menyinkron…" : "Sync now"}
        </Button>
      </div>
    </div>
  );
}

/** Hook debounce sederhana. */
function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
