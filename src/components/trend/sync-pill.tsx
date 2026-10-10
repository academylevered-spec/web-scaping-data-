"use client";

import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Progress } from "@/components/ui/progress";
import { FOCUS_RING } from "@/lib/ui";
import { countdown, timeAgo, LiveCycleProgress, ScraperLastCycle } from "@/lib/trend-utils";
import type { LiveJob } from "@/lib/trend-utils";

interface Props {
  lastSyncAt: string;
  /** v5.1: null saat siklus berjalan — UI menampilkan status "Siklus berjalan". */
  nextSyncAt: string | null;
  scraper: {
    running: boolean;
    nextRunAtMs: number | null;
    cycle?: LiveCycleProgress | null;
    lastCycle: ScraperLastCycle | null;
  } | null;
  /** v6: job live dari WebSocket (sumber utama bila ada). */
  job?: LiveJob | null;
  onSync: () => void;
  syncing: boolean;
  /** v6: buka panel operasional (klik area status). */
  onOpenOps?: () => void;
}

const PHASE_LABELS: Record<string, string> = {
  scraping: "menarik data",
  products: "detail produk",
  discovery: "deteksi katalog",
  done: "finishing",
  error: "bermasalah",
};

function scopeLabel(job: LiveJob): string {
  return job.scopeType === "global" ? "Global" : job.scopeValue;
}

/** Pill status LIVE sinkronisasi: dot pulse, progres job realtime (v6), tombol sync. */
export function SyncPill({ lastSyncAt, nextSyncAt, scraper, job, onSync, syncing, onOpenOps }: Props) {
  const [, tick] = useState(0);

  // Re-render tiap 15 detik agar timeAgo/countdown selalu segar
  useEffect(() => {
    const id = setInterval(() => tick((t) => t + 1), 15_000);
    return () => clearInterval(id);
  }, []);

  const liveJob = job?.live ? job : null;
  const running = Boolean(liveJob) || (scraper?.running ?? false);
  const lastCycle = scraper?.lastCycle ?? null;

  const pct =
    liveJob && liveJob.progress?.total
      ? Math.round((liveJob.progress.done / liveJob.progress.total) * 100)
      : null;

  const statusText = running
    ? liveJob && pct !== null
      ? `Scrape ${scopeLabel(liveJob)} ${pct}%`
      : "Siklus berjalan"
    : `siklus berikut ${countdown(nextSyncAt)}`;

  const cycleTooltip = running
    ? liveJob
      ? `Progres live: ${liveJob.progress.done}/${liveJob.progress.total} slice` +
        (liveJob.progress.failed ? ` · ${liveJob.progress.failed} gagal (auto-retry)` : "") +
        ` · ${(liveJob.newVideos ?? 0).toLocaleString("id-ID")} video baru`
      : "Siklus scraping sedang berjalan — progres muncul real-time."
    : lastCycle
      ? `Siklus terakhir: ${lastCycle.newVideos ?? 0} video baru · ${lastCycle.requests ?? 0} request`
      : "Menunggu siklus pertama bot selesai…";

  return (
    <div className="inline-flex flex-wrap items-center justify-center gap-2.5 rounded-full bg-zinc-100/80 py-1.5 pl-4 pr-1.5 ring-1 ring-zinc-200/80 backdrop-blur-xl dark:bg-zinc-900/80 dark:ring-zinc-800">
      <button
        type="button"
        onClick={onOpenOps}
        className={`flex cursor-pointer items-center gap-2 rounded-full text-ui font-medium text-zinc-700 focus-visible:outline-none dark:text-zinc-300 ${FOCUS_RING}`}
        aria-label="Buka panel sistem scraping"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="flex cursor-default items-center gap-2">
              <span className="relative flex h-2 w-2" aria-hidden>
                <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 ${running ? "bg-amber-400" : "bg-emerald-400"}`} />
                <span className={`relative inline-flex h-2 w-2 rounded-full ${running ? "bg-amber-500" : "bg-emerald-500"}`} />
              </span>
              <span className={`font-semibold tracking-wide ${running ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                LIVE
              </span>
              <span className="hidden text-zinc-400 dark:text-zinc-600 sm:inline" aria-hidden>·</span>
              <span className="hidden tabular-nums sm:inline" aria-live="polite">
                Data sinkron {timeAgo(lastSyncAt)} · {statusText}
              </span>
              <span className="sr-only">
                Data sinkron {timeAgo(lastSyncAt)}, {running ? "scrape sedang berjalan" : `siklus berikutnya dalam ${countdown(nextSyncAt)}`}
              </span>
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            <p className="font-medium">Bot scraper 24/7 — sinkron otomatis tiap jam (klik untuk detail sistem)</p>
            <p className="mt-0.5 opacity-80">{cycleTooltip}</p>
            {liveJob && liveJob.progress?.total ? (
              <Progress value={pct ?? 0} className="mt-1.5 h-1" aria-hidden />
            ) : null}
          </TooltipContent>
        </Tooltip>
      </button>

      <button
        type="button"
        onClick={onSync}
        disabled={syncing || running}
        className={`flex h-9 items-center gap-1.5 rounded-full bg-white px-3.5 text-xs font-semibold text-zinc-900 shadow-sm ring-1 ring-zinc-200 transition-all hover:bg-zinc-50 focus-visible:outline-none disabled:opacity-50 dark:bg-zinc-800 dark:text-zinc-100 dark:ring-zinc-700 dark:hover:bg-zinc-700 ${FOCUS_RING}`}
        aria-label="Sinkronkan data trending sekarang"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${syncing || running ? "animate-spin" : ""}`} aria-hidden />
        {running ? "Berjalan…" : syncing ? "Menyinkron…" : "Sync now"}
      </button>
    </div>
  );
}
