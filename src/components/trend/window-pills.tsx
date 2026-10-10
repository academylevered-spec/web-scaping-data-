"use client";

import { motion } from "framer-motion";
import { FOCUS_RING } from "@/lib/ui";
import { WINDOW_OPTIONS, WindowKey } from "@/lib/trend-utils";

interface Props {
  value: WindowKey;
  counts: Record<string, number>;
  onChange: (w: WindowKey) => void;
}

/** Segmented control window waktu — menonjol, dengan badge jumlah video per window.
 *  Mobile: seluruh grup bisa di-scroll horizontal (centering otomatis saat muat). */
export function WindowPills({ value, counts, onChange }: Props) {
  return (
    <div className="scrollbar-hide flex max-w-full overflow-x-auto pb-1 sm:pb-0">
      <div
        role="tablist"
        aria-label="Pilih rentang waktu trending"
        className="mx-auto inline-flex items-center gap-1 rounded-full border border-zinc-200/80 bg-white/70 p-1 shadow-sm backdrop-blur-xl dark:border-zinc-800 dark:bg-zinc-900/70"
      >
      {WINDOW_OPTIONS.map((opt) => {
        const active = value === opt.key;
        const count = counts[opt.key] ?? 0;
        return (
          <button
            key={opt.key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(opt.key)}
            className={`relative flex h-11 min-w-[64px] items-center justify-center gap-1.5 rounded-full px-3 text-ui font-medium transition-colors duration-200 focus-visible:outline-none sm:px-4 ${FOCUS_RING} ${
              active
                ? "text-zinc-50 dark:text-zinc-900"
                : "text-zinc-600 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
            }`}
          >
            {active && (
              <motion.span
                layoutId="window-pill-active"
                transition={{ type: "spring", stiffness: 420, damping: 34 }}
                className="absolute inset-0 rounded-full bg-zinc-900 shadow-md dark:bg-zinc-50"
                aria-hidden
              />
            )}
            <span className="relative z-10 whitespace-nowrap">{opt.label}</span>
            <span
              className={`relative z-10 hidden rounded-full px-1.5 py-0.5 text-2xs font-semibold tabular-nums sm:inline ${
                active
                  ? "bg-white/20 text-zinc-50 dark:bg-zinc-900/10 dark:text-zinc-900"
                  : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400"
              }`}
            >
              {count > 999 ? `${Math.floor(count / 1000)}K+` : count}
            </span>
          </button>
        );
      })}
      </div>
    </div>
  );
}
