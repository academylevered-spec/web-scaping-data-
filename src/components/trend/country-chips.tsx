"use client";

import { motion } from "framer-motion";
import { Globe2 } from "lucide-react";
import { FOCUS_RING } from "@/lib/ui";
import type { PerCountryFreshness, QueueJob } from "@/hooks/use-realtime";

interface Country {
  code: string;
  name: string;
  flag: string;
  count: number;
  /** v6: freshness slice (ms epoch) — null/undefined = belum pernah di-scrape. */
  lastScrapedAt?: number | null;
  failedSlices?: number;
  runningSlices?: number;
}

/** v7: status job scrape per scope ("ALL" = global) — menentukan ring chip. */
export type ScopeJobMap = Map<
  string,
  { status: string; mine: boolean; job: QueueJob }
>;

interface Props {
  countries: Country[];
  selected: string;
  onSelect: (code: string) => void;
  /** v6: freshness realtime per negara (dari socket). */
  freshness?: Map<string, PerCountryFreshness>;
  /** v7: status job per scope — chip diberi ring sesuai status (running/queued/held). */
  scopeJobs?: ScopeJobMap;
}

/** Dot kesegaran: hijau = fresh (<2 jam), amber = basi/gagal, abu = belum ada data. */
function freshDot(c: Country, freshness?: Map<string, PerCountryFreshness>): string {
  const f = freshness?.get(c.code);
  if (c.count === 0 && !f?.lastSuccessAt) return "bg-zinc-300 dark:bg-zinc-600";
  if ((f?.failed ?? 0) > 0) return "bg-amber-400";
  const last = f?.lastSuccessAt ?? c.lastScrapedAt;
  if (!last) return "bg-zinc-300 dark:bg-zinc-600";
  return Date.now() - last < 2 * 3600_000
    ? "bg-emerald-500"
    : "bg-amber-400";
}

const DOT_LABEL: Record<string, string> = {
  "bg-emerald-500": "data segar (<2 jam)",
  "bg-amber-400": "data basi / ada slice gagal",
  "bg-zinc-300 dark:bg-zinc-600": "belum ada data",
};

/** Chip filter negara — klik = perintah scrape scope itu + filter view (v7).
 *  Ring status: amber pulse = running, zinc = antre/held. Mobile rail, desktop wrap. */
export function CountryChips({ countries, selected, onSelect, freshness, scopeJobs }: Props) {
  const total = countries.reduce((a, c) => a + c.count, 0);
  const all = [{ code: "all", name: "Global", flag: "", count: total, lastScrapedAt: null }, ...countries];

  return (
    <div
      id="countries"
      className="scrollbar-hide -mx-4 flex scroll-mt-20 gap-2 overflow-x-auto px-4 pb-1 sm:mx-0 sm:flex-wrap sm:px-0"
      role="tablist"
      aria-label="Filter dan scrape berdasarkan negara"
    >
      {all.map((c) => {
        const active = selected === c.code;
        const scopeKey = c.code === "all" ? "ALL" : c.code;
        const sj = scopeJobs?.get(scopeKey);
        const status = sj?.status;
        const running = status === "running";
        const queued = status === "ready" || status === "held";
        const dot = c.code === "all" ? "bg-emerald-500" : freshDot(c, freshness);
        return (
          <motion.button
            key={c.code}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(c.code)}
            whileTap={{ scale: 0.96 }}
            title={
              c.code === "all"
                ? "Klik: scrape Global (semua negara) + tampilkan semua"
                : `Klik: scrape ${c.name} + tampilkan ${c.name}`
            }
            className={`flex h-11 shrink-0 items-center gap-2 rounded-full px-4 text-ui font-medium transition-colors duration-200 focus-visible:outline-none ${FOCUS_RING} ${
              running
                ? "ring-2 ring-amber-400 ring-offset-1 ring-offset-white dark:ring-offset-zinc-950"
                : queued
                  ? "ring-2 ring-zinc-300 ring-offset-1 ring-offset-white dark:ring-zinc-600 dark:ring-offset-zinc-950"
                  : ""
            } ${
              active
                ? "bg-zinc-900 text-white shadow-md dark:bg-zinc-50 dark:text-zinc-900"
                : "bg-white text-zinc-700 ring-1 ring-zinc-200 hover:bg-zinc-50 hover:ring-zinc-300 dark:bg-zinc-900 dark:text-zinc-300 dark:ring-zinc-800 dark:hover:bg-zinc-800"
            }`}
          >
            {c.code === "all" ? (
              <Globe2 className="h-4 w-4" aria-hidden />
            ) : (
              <span aria-hidden className="text-base leading-none">{c.flag}</span>
            )}
            {c.name}
            <span
              className={`rounded-full px-1.5 py-0.5 text-2xs tabular-nums ${
                active
                  ? "bg-white/20 text-white dark:bg-zinc-900/10 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {c.count > 999 ? `${Math.floor(c.count / 1000)}K+` : c.count}
            </span>
            <span
              className={`h-1.5 w-1.5 rounded-full ${dot}`}
              role="img"
              aria-label={DOT_LABEL[dot] ?? "status data"}
            />
          </motion.button>
        );
      })}
    </div>
  );
}
