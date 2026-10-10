"use client";

import { TrendExplorer } from "@/components/trend/trend-explorer";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col bg-white text-zinc-900 dark:bg-zinc-950 dark:text-zinc-50">
      <TrendExplorer />
      <footer className="mt-auto border-t border-zinc-200/70 dark:border-zinc-800/70">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-3 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center sm:flex-row sm:px-6 sm:text-left lg:px-8">
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            TrendPulse — pelacak video trending TikTok Shop global. Video bisa diputar di sini; tautan dibuka di TikTok &amp; TikTok Shop.
          </p>
          <p className="text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            Data real · tersimpan di database cloud Z.ai · auto-sync tiap jam · © {new Date().getFullYear()} TrendPulse
          </p>
        </div>
      </footer>
    </div>
  );
}
