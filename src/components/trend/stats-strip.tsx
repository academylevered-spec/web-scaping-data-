"use client";

import { motion } from "framer-motion";
import { Eye, Globe2, PlayCircle, ShoppingCart, DollarSign } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCompact, formatGmv } from "@/lib/trend-utils";

interface Props {
  videos: number;
  views: number;
  sales: number;
  gmv: number;
  countries: number;
  /** Saat meta belum termuat: nilai ditampilkan sebagai skeleton (bukan "pop" dari 0). */
  loading?: boolean;
}

const ICONS = [PlayCircle, Eye, ShoppingCart, DollarSign, Globe2];

/** Strip statistik global: Videos / Views / Sales / GMV + Countries. */
export function StatsStrip({ videos, views, sales, gmv, countries, loading = false }: Props) {
  const items = [
    { label: "Videos", value: formatCompact(videos) },
    { label: "Total Views", value: formatCompact(views) },
    { label: "Total Sales", value: formatCompact(sales) },
    { label: "Total GMV", value: formatGmv(gmv) },
    { label: "Countries", value: String(countries) },
  ];

  return (
    <section
      aria-label="Statistik global"
      className="grid grid-cols-2 gap-px overflow-hidden rounded-3xl bg-zinc-200/70 ring-1 ring-zinc-200/70 dark:bg-zinc-800 dark:ring-zinc-800 sm:grid-cols-3 lg:grid-cols-5"
    >
      {items.map((it, i) => {
        const Icon = ICONS[i % ICONS.length];
        return (
          <motion.div
            key={it.label}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: loading ? 0 : 0.05 * i, duration: 0.4, ease: "easeOut" }}
            className={cn(
              "bg-white/90 px-5 py-4 backdrop-blur dark:bg-zinc-950/90 sm:px-6 sm:py-5",
              // Mobile 2 kolom & tablet 3 kolom: item ke-5 span penuh agar baris terakhir
              // tidak menyisakan slot kosong; kembali 1 kolom di desktop (grid 5).
              i === items.length - 1 && "col-span-2 sm:col-span-2 lg:col-span-1"
            )}
          >
            <div className="flex items-center gap-1.5">
              <Icon className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <p className="text-2xs font-medium uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                {it.label}
              </p>
            </div>
            {loading ? (
              <Skeleton className="mt-1.5 h-7 w-20 rounded-full sm:h-8" />
            ) : (
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-900 dark:text-zinc-50 sm:text-3xl">
                {it.value}
              </p>
            )}
          </motion.div>
        );
      })}
    </section>
  );
}
