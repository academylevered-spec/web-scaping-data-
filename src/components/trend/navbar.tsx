"use client";

import { useSyncExternalStore } from "react";
import { useTheme } from "next-themes";
import { Moon, Sun, RefreshCw, Activity } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FOCUS_RING } from "@/lib/ui";

const emptySubscribe = () => () => {};

export function Navbar({
  onSync,
  syncing,
  onOpenOps,
  alertCount = 0,
  jobRunning = false,
}: {
  onSync: () => void;
  syncing: boolean;
  /** v6: buka panel operasional sistem. */
  onOpenOps?: () => void;
  /** v6: jumlah alert unresolved (badge). */
  alertCount?: number;
  /** v6: job scraping sedang berjalan (indikator). */
  jobRunning?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  // Cek hydration standar: false di server/render pertama, true di client
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );

  return (
    // Safe-area top: aman untuk standalone PWA / browser dengan notch
    <header className="sticky top-0 z-40 border-b border-zinc-200/60 bg-white/70 pt-[env(safe-area-inset-top)] backdrop-blur-2xl backdrop-saturate-150 dark:border-zinc-800/60 dark:bg-zinc-950/70">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-4 sm:px-6 lg:h-16 lg:px-8">
        <a href="#" className="flex items-center gap-2" aria-label="Beranda TrendPulse">
          <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-zinc-900 dark:bg-white" aria-hidden>
            <span className="block h-2.5 w-2.5 rounded-full bg-gradient-to-br from-emerald-400 to-emerald-600" />
          </span>
          <span className="text-base font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
            TrendPulse
          </span>
        </a>

        <nav className="hidden items-center gap-7 md:flex" aria-label="Navigasi utama">
          <a
            href="#trending"
            className="text-ui font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Trending
          </a>
          <a
            href="#countries"
            className="text-ui font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Negara
          </a>
          <a
            href="#trending"
            className="text-ui font-medium text-zinc-600 transition-colors hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
          >
            Kategori
          </a>
        </nav>

        <div className="flex items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={onOpenOps}
            className={`relative h-10 gap-1.5 rounded-full px-3 text-ui font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100 ${FOCUS_RING}`}
            aria-label="Buka panel sistem scraping"
          >
            <Activity
              className={`h-3.5 w-3.5 ${jobRunning ? "animate-pulse text-amber-500" : ""}`}
              aria-hidden
            />
            <span className="hidden sm:inline">Sistem</span>
            {alertCount > 0 && (
              <span
                className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white"
                aria-label={`${alertCount} alert aktif`}
              >
                {alertCount > 9 ? "9+" : alertCount}
              </span>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onSync}
            disabled={syncing}
            className="h-10 gap-1.5 rounded-full px-3 text-ui font-medium text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label="Sinkronkan data trending sekarang"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${syncing ? "animate-spin" : ""}`} aria-hidden />
            <span className="hidden sm:inline">{syncing ? "Menyinkron…" : "Sync"}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            className="h-10 w-10 rounded-full text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-100"
            aria-label={mounted && theme === "dark" ? "Beralih ke mode terang" : "Beralih ke mode gelap"}
          >
            {mounted && theme === "dark" ? <Sun className="h-4 w-4" aria-hidden /> : <Moon className="h-4 w-4" aria-hidden />}
          </Button>
        </div>
      </div>
    </header>
  );
}
