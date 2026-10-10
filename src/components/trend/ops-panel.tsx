"use client";

/**
 * OpsPanel v6 — panel operasional sistem scraping (Sheet sisi kanan).
 * Isi LIVE via WebSocket (use-realtime): session, circuit breaker, job queue,
 * freshness per negara, alert feed (+resolve), dan tombol retry slice gagal.
 */
import { useCallback } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircuitBoard,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  ShieldAlert,
  Timer,
  XCircle,
} from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { FOCUS_RING, pill } from "@/lib/ui";
import { COUNTRY_FLAGS, timeAgo } from "@/lib/trend-utils";
import type { MetaResponse } from "@/lib/trend-utils";
import { useRealtime, markAlertsResolved, type PerCountryFreshness } from "@/hooks/use-realtime";
import { toast } from "sonner";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  meta: MetaResponse | null;
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-500",
  warning: "bg-amber-500",
  info: "bg-emerald-500",
};

const SESSION_LABEL: Record<string, { text: string; cls: string; icon: React.ReactNode }> = {
  healthy: {
    text: "Sesi sehat",
    cls: "text-emerald-600 dark:text-emerald-400",
    icon: <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />,
  },
  authing: {
    text: "Login ulang…",
    cls: "text-amber-600 dark:text-amber-400",
    icon: <Timer className="h-3.5 w-3.5" aria-hidden />,
  },
  human_required: {
    text: "Butuh manusia (captcha/2FA)",
    cls: "text-red-600 dark:text-red-400",
    icon: <ShieldAlert className="h-3.5 w-3.5" aria-hidden />,
  },
  unreachable: {
    text: "Bot tidak terjangkau",
    cls: "text-red-600 dark:text-red-400",
    icon: <XCircle className="h-3.5 w-3.5" aria-hidden />,
  },
  unknown: {
    text: "Status tidak diketahui",
    cls: "text-zinc-500 dark:text-zinc-400",
    icon: <Info className="h-3.5 w-3.5" aria-hidden />,
  },
};

export function OpsPanel({ open, onOpenChange, meta }: Props) {
  const rt = useRealtime();
  const job = rt.job;

  const resolveAlert = useCallback(
    async (type?: string) => {
      try {
        const res = await fetch("/api/alerts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "resolve", type }),
        });
        if (res.ok) {
          toast.success("Alert ditandai selesai");
          markAlertsResolved(type);
        }
      } catch {
        toast.error("Gagal menandai alert");
      }
    },
    []
  );

  const retryFailed = useCallback(async () => {
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry-failed" }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        toast.success("Slice gagal diantrekan ulang", {
          description: "Job prioritas tinggi dibuat — pantau progres di sini.",
        });
      } else {
        toast.error(json?.error ?? "Gagal retry");
      }
    } catch {
      toast.error("Gagal retry — service tidak terjangkau");
    }
  }, []);

  /** v7: batalkan job (ready/held langsung; running graceful). */
  const cancelJob = useCallback(async (id: string, scope: string) => {
    try {
      const res = await fetch("/api/scrape", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel", id }),
      });
      const json = await res.json().catch(() => null);
      if (res.ok && json?.ok) {
        toast.success(
          json.cancelling
            ? `Scrape ${scope} dibatalkan — menyelesaikan in-flight…`
            : `Scrape ${scope} dibatalkan`
        );
      } else {
        toast.error(json?.error ?? "Gagal membatalkan job");
      }
    } catch {
      toast.error("Gagal membatalkan — service tidak terjangkau");
    }
  }, []);

  const sessionKey = rt.bot?.reachable
    ? (rt.bot?.session?.state ?? "unknown")
    : rt.connected
      ? "unreachable"
      : "unknown";
  const session = SESSION_LABEL[sessionKey] ?? SESSION_LABEL.unknown;

  const pct = job?.progress?.total
    ? Math.round((job.progress.done / job.progress.total) * 100)
    : 0;
  const scopeName =
    job?.scopeType === "global" ? "Global (semua negara)" : job?.scopeValue ?? "";
  const fresh: PerCountryFreshness[] = rt.perCountry;
  const failedTotal = fresh.reduce((a, c) => a + (c.failed ?? 0), 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:max-w-md"
      >
        <SheetHeader className="border-b border-zinc-200/70 px-5 pb-4 pt-[calc(1rem+env(safe-area-inset-top))] dark:border-zinc-800">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
            Sistem Scraping
            <span
              className={`ml-auto flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-medium ring-1 ${
                rt.connected
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:ring-emerald-800"
                  : "bg-zinc-100 text-zinc-500 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:ring-zinc-800"
              }`}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${rt.connected ? "bg-emerald-500" : "bg-zinc-400"}`} aria-hidden />
              {rt.connected ? "LIVE" : "offline"}
            </span>
          </SheetTitle>
          <SheetDescription className="text-ui">
            Status bot, antrean job, dan kesehatan sesi — diperbarui real-time.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 px-5 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-5">
          {/* ── Sesi & bot ── */}
          <section aria-label="Kesehatan sesi dan bot">
            <SectionTitle>Sesi &amp; Bot</SectionTitle>
            <div className="mt-2 flex flex-wrap items-center gap-2 text-ui">
              <span className={`flex items-center gap-1.5 font-medium ${session.cls}`}>
                {session.icon}
                {session.text}
              </span>
              {rt.bot?.circuit && rt.bot.circuit.state !== "closed" && (
                <span className="flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-2xs font-medium text-amber-700 ring-1 ring-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:ring-amber-800">
                  <CircuitBoard className="h-3 w-3" aria-hidden />
                  Circuit {rt.bot.circuit.state}
                </span>
              )}
              <span className="text-zinc-500 dark:text-zinc-400">
                {rt.totalVideos.toLocaleString("id-ID")} video tersimpan
              </span>
            </div>
            {/* KEEP-ALIVE: alasan nyata bot down (dari supervisor down.json) */}
            {sessionKey === "unreachable" && rt.bot?.down?.reason && (
              <p
                role="status"
                className="mt-2 rounded-xl bg-red-50 px-3 py-2 text-2xs text-red-700 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-300 dark:ring-red-900"
              >
                Penyebab: {rt.bot.down.reason}
                <span className="mt-0.5 block text-red-600/80 dark:text-red-400/80">
                  Supervisor terus mencoba memulihkan otomatis — tidak perlu refresh.
                </span>
              </p>
            )}
          </section>

          {/* ── Job aktif ── */}
          <section aria-label="Antrean job scraping">
            <SectionTitle>Job Scraping</SectionTitle>
            {job && job.live ? (
              <div className="mt-2 rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200/70 dark:bg-zinc-900 dark:ring-zinc-800">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-ui font-medium text-zinc-900 dark:text-zinc-100">
                    {scopeName}
                  </p>
                  <span className="text-2xs tabular-nums text-zinc-500 dark:text-zinc-400">
                    {job.progress.done}/{job.progress.total} slice
                  </span>
                </div>
                <Progress value={pct} className="mt-2 h-1.5" aria-label={`Progres job ${pct}%`} />
                <p className="mt-2 text-2xs text-zinc-500 dark:text-zinc-400">
                  {pct}% selesai
                  {job.progress.failed > 0
                    ? ` · ${job.progress.failed} slice gagal (auto-retry)`
                    : ""}
                  {" · "}
                  trigger {job.trigger}
                </p>
              </div>
            ) : job && !job.live ? (
              <div className="mt-2 rounded-2xl bg-zinc-50 p-4 ring-1 ring-zinc-200/70 dark:bg-zinc-900 dark:ring-zinc-800">
                <p className="text-ui font-medium text-zinc-900 dark:text-zinc-100">
                  Job terakhir selesai — {scopeName}
                </p>
                <p className="mt-1 text-2xs text-zinc-500 dark:text-zinc-400">
                  {(job.newVideos ?? 0).toLocaleString("id-ID")} video baru ·{" "}
                  {timeAgo(job.finishedAt ?? Date.now())}
                </p>
              </div>
            ) : (
              <p className="mt-2 text-ui text-zinc-500 dark:text-zinc-400">
                Tidak ada job berjalan — jadwal otomatis per jam.
              </p>
            )}
            {failedTotal > 0 && (
              <Button
                onClick={retryFailed}
                className={`${pill.base} ${pill.outline} mt-2 px-4 text-xs`}
                aria-label="Antrekan ulang slice yang gagal"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
                Retry {failedTotal} slice gagal
              </Button>
            )}

            {/* ── v7: antrian job lengkap (ready/running/held) + cancel ── */}
            {rt.queue.length > 0 && (
              <ul className="mt-2 space-y-1.5" aria-label="Antrian job scraping">
                {rt.queue.map((q) => {
                  const qScope =
                    q.scopeType === "global" ? "Global" : COUNTRY_FLAGS[q.scopeValue]
                      ? `${COUNTRY_FLAGS[q.scopeValue]} ${q.scopeValue}`
                      : q.scopeValue;
                  const isRunning = q.status === "running";
                  const isHeld = q.status === "held";
                  const qPct = q.progress?.total
                    ? Math.round((q.progress.done / q.progress.total) * 100)
                    : null;
                  return (
                    <li
                      key={q.id}
                      className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-ui ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          isRunning
                            ? "animate-pulse bg-amber-500"
                            : isHeld
                              ? "bg-zinc-400"
                              : "bg-zinc-300 dark:bg-zinc-600"
                        }`}
                        aria-hidden
                      />
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {qScope}
                      </span>
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-2xs font-medium ${
                          isRunning
                            ? "bg-amber-100 text-amber-700 dark:bg-amber-950/70 dark:text-amber-300"
                            : isHeld
                              ? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300"
                              : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800/60 dark:text-zinc-400"
                        }`}
                      >
                        {isRunning ? "jalan" : isHeld ? "ditahan" : "antre"}
                      </span>
                      {qPct !== null && (
                        <span className="tabular-nums text-2xs text-zinc-500 dark:text-zinc-400">
                          {q.progress?.done}/{q.progress?.total}
                        </span>
                      )}
                      {q.pausedReason && (
                        <span
                          className="truncate text-2xs text-zinc-400 dark:text-zinc-500"
                          title={q.pausedReason}
                        >
                          · {q.pausedReason}
                        </span>
                      )}
                      {!q.mine && (
                        <span className="text-2xs text-zinc-400 dark:text-zinc-500" title="Job dari proses lama (legacy)">
                          legacy
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => void cancelJob(q.id, qScope)}
                        className={`ml-auto shrink-0 rounded-full p-1.5 text-zinc-400 transition-colors hover:bg-red-50 hover:text-red-600 focus-visible:outline-none dark:hover:bg-red-950/40 dark:hover:text-red-400 ${FOCUS_RING}`}
                        aria-label={`Batalkan scrape ${qScope}`}
                        title="Batalkan job ini"
                      >
                        <XCircle className="h-3.5 w-3.5" aria-hidden />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Freshness per negara ── */}
          <section aria-label="Kesegaran data per negara">
            <SectionTitle>Data per Negara</SectionTitle>
            {fresh.length === 0 ? (
              <div className="mt-2 space-y-1.5">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-8 w-full rounded-xl" />
                ))}
              </div>
            ) : (
              <ul className="mt-2 max-h-72 space-y-1 overflow-y-auto pr-1 custom-scrollbar">
                {fresh.map((c) => {
                  const flag = COUNTRY_FLAGS[c.country] ?? "🏳️";
                  const stale = !c.lastSuccessAt;
                  return (
                    <li
                      key={c.country}
                      className="flex items-center gap-2 rounded-xl bg-zinc-50 px-3 py-2 text-ui ring-1 ring-zinc-200/60 dark:bg-zinc-900 dark:ring-zinc-800"
                    >
                      <span aria-hidden className="text-base leading-none">{flag}</span>
                      <span className="font-medium text-zinc-900 dark:text-zinc-100">
                        {c.country}
                      </span>
                      <span className="tabular-nums text-2xs text-zinc-500 dark:text-zinc-400">
                        {c.done} slice
                      </span>
                      {c.failed > 0 && (
                        <span className="rounded-full bg-amber-100 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-amber-700 dark:bg-amber-950/70 dark:text-amber-300">
                          {c.failed} gagal
                        </span>
                      )}
                      {c.running > 0 && (
                        <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-2xs font-medium tabular-nums text-emerald-700 dark:bg-emerald-950/70 dark:text-emerald-300">
                          {c.running} jalan
                        </span>
                      )}
                      <span className="ml-auto shrink-0 text-2xs tabular-nums text-zinc-400 dark:text-zinc-500">
                        {stale ? "belum ada" : timeAgo(c.lastSuccessAt!)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>

          {/* ── Alerts ── */}
          <section aria-label="Alert sistem">
            <SectionTitle>
              Alert
              {rt.alerts.filter((a) => !a.resolvedAt).length > 0 && (
                <span className="ml-1.5 rounded-full bg-red-100 px-1.5 py-0.5 text-2xs font-semibold tabular-nums text-red-700 dark:bg-red-950/70 dark:text-red-300">
                  {rt.alerts.filter((a) => !a.resolvedAt).length}
                </span>
              )}
              {rt.alerts.length > 0 && (
                <button
                  type="button"
                  onClick={() => resolveAlert(undefined)}
                  className={`ml-auto text-2xs font-medium text-zinc-500 underline-offset-2 hover:underline dark:text-zinc-400 ${FOCUS_RING} rounded-sm`}
                >
                  Tandai semua selesai
                </button>
              )}
            </SectionTitle>
            {rt.alerts.length === 0 ? (
              <p className="mt-2 text-ui text-zinc-500 dark:text-zinc-400">
                Tidak ada alert — sistem berjalan normal.
              </p>
            ) : (
              <ul className="mt-2 max-h-64 space-y-1.5 overflow-y-auto pr-1 custom-scrollbar">
                {rt.alerts.slice(0, 25).map((a) => (
                  <li
                    key={a.id}
                    className={`flex gap-2 rounded-xl px-3 py-2 text-ui ring-1 ${
                      a.resolvedAt
                        ? "bg-zinc-50 text-zinc-400 ring-zinc-200/60 dark:bg-zinc-900 dark:text-zinc-500 dark:ring-zinc-800"
                        : "bg-white text-zinc-800 ring-zinc-200 dark:bg-zinc-900 dark:text-zinc-200 dark:ring-zinc-800"
                    }`}
                  >
                    <span
                      className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${
                        SEVERITY_STYLE[a.severity] ?? "bg-zinc-400"
                      } ${a.resolvedAt ? "opacity-40" : ""}`}
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="break-words text-xs leading-relaxed">{a.message}</p>
                      <p className="mt-0.5 text-2xs text-zinc-400 dark:text-zinc-500">
                        {a.type} · {timeAgo(a.createdAt)}{a.resolvedAt ? " · selesai" : ""}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Download kode proyek — ZIP bersih (source + db, tanpa dependencies/kredensial) */}
          <section aria-label="Unduh kode proyek" className="mt-1">
            <a
              href="/trendpulse-source.zip"
              download
              className="flex items-center gap-3 rounded-2xl bg-zinc-50 px-4 py-3 ring-1 ring-black/5 transition-colors hover:bg-zinc-100 dark:bg-zinc-900 dark:ring-white/10 dark:hover:bg-zinc-800"
            >
              <Download className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="block text-ui font-medium text-zinc-800 dark:text-zinc-100">
                  Download kode proyek (.zip)
                </span>
                <span className="block text-2xs text-zinc-500 dark:text-zinc-400">
                  Source lengkap + database — tanpa node_modules & kredensial
                </span>
              </span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-zinc-400" aria-hidden />
            </a>
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
      <AlertTriangle className="hidden h-3 w-3" aria-hidden />
      {children}
    </h3>
  );
}
