"use client";

/**
 * use-realtime v6 — hook WebSocket (socket.io) untuk status sistem scraping LIVE.
 *
 * Kontrak event (lihat mini-services/trend-scraper-python/CONTRACT.md):
 *  - bot:status  {reachable, running, session, circuit, metrics, slices, unresolvedAlerts, totalVideos}
 *  - job:update  {id, scopeType, scopeValue, status, progress:{total,done,failed}, live}
 *  - data:update {totalVideos, delta}            → pemicu invalidate query video
 *  - alert:new   {alert}
 *  - slices:update {perCountry:[...]}
 *
 * Koneksi via gateway: io("/?XTransformPort=4030") dengan path "/" — JANGAN diubah.
 * Fallback aman: bila socket gagal, UI tetap jalan (polling meta 30 dtk tetap ada).
 */
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { io, type Socket } from "socket.io-client";
import type { AlertItem, LiveJob } from "@/lib/trend-utils";

/** v7: satu job dalam antrian scraping (dari event queue:update). */
export interface QueueJob {
  id: string;
  scopeType: "global" | "country" | string;
  scopeValue: string;
  status: "ready" | "running" | "held" | string;
  trigger: string;
  priority: number;
  pausedReason?: string | null;
  createdAt?: number;
  owner?: string | null;
  /** true = job milik instance v7 (bukan legacy zombie). */
  mine?: boolean;
  progress?: { total: number; done: number; failed: number };
}

export interface BotStatus {
  reachable: boolean;
  running: boolean;
  session: { state: string; hasSession?: boolean; ageDays?: number | null; lastError?: string | null };
  circuit: { state: string; openCount: number } | null;
  slices: Record<string, number> | null;
  unresolvedAlerts: number;
  nextRunAtMs: number | null;
  totalVideos: number;
  queueLen?: number;
  /** KEEP-ALIVE: alasan nyata bot down (dari supervisor down.json) — null saat sehat. */
  down?: { reason: string; lastExitCode: number | null; sinceMs: number | null } | null;
  atMs: number;
}

export interface PerCountryFreshness {
  country: string;
  done: number;
  failed: number;
  pending: number;
  running: number;
  lastSuccessAt: number | null;
}

interface RealtimeState {
  connected: boolean;
  bot: BotStatus | null;
  job: LiveJob | null;
  /** v7: antrian job aktif (ready/running/held) — sumber status per scope. */
  queue: QueueJob[];
  alerts: AlertItem[];
  perCountry: PerCountryFreshness[];
  /** Naik setiap kali ada data baru → pemicu invalidate ( efek di pemanggil). */
  dataVersion: number;
  totalVideos: number;
}

const EMPTY: RealtimeState = {
  connected: false,
  bot: null,
  job: null,
  queue: [],
  alerts: [],
  perCountry: [],
  dataVersion: 0,
  totalVideos: 0,
};

// ── Singleton store (satu socket untuk seluruh app) ─────────────────────
let socket: Socket | null = null;
let state: RealtimeState = EMPTY;
const listeners = new Set<() => void>();
let lastJobKey = "";
let helloLoaded = false;

function setState(patch: Partial<RealtimeState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function ensureSocket(): Socket | null {
  if (typeof window === "undefined") return null;
  if (socket) return socket;
  try {
    // DO NOT change the path — dipakai Caddy gateway (pola examples/websocket)
    socket = io("/?XTransformPort=4030", {
      transports: ["websocket", "polling"],
      forceNew: false,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 2000,
      timeout: 8000,
    });

    socket.on("connect", () => setState({ connected: true }));
    socket.on("disconnect", () => setState({ connected: false }));
    socket.on("connect_error", () => setState({ connected: false }));

    socket.on("hello", (payload: { perCountry?: PerCountryFreshness[]; alerts?: AlertItem[]; totalVideos?: number }) => {
      helloLoaded = true;
      setState({
        perCountry: payload.perCountry ?? [],
        alerts: payload.alerts ?? [],
        totalVideos: payload.totalVideos ?? state.totalVideos,
      });
    });

    socket.on("bot:status", (payload: BotStatus) => {
      setState({ bot: payload, totalVideos: payload.totalVideos ?? state.totalVideos });
    });

    socket.on("job:update", (payload: LiveJob) => {
      const key = `${payload.id}:${payload.status}:${payload.progress?.done ?? 0}:${payload.live}`;
      if (key === lastJobKey && payload.live) return; // hindari re-render berlebihan
      lastJobKey = key;
      setState({ job: payload });
    });

    // v7: antrian lengkap (ready/running/held) — status per scope untuk chips/panel
    socket.on("queue:update", (payload: { jobs?: QueueJob[] }) => {
      setState({ queue: payload.jobs ?? [] });
    });

    socket.on("data:update", (payload: { totalVideos: number; delta: number }) => {
      setState({ dataVersion: state.dataVersion + 1, totalVideos: payload.totalVideos });
    });

    socket.on("alert:new", (payload: { alert: AlertItem }) => {
      const next = [payload.alert, ...state.alerts.filter((a) => a.id !== payload.alert.id)].slice(0, 60);
      setState({ alerts: next });
    });

    socket.on("slices:update", (payload: { perCountry: PerCountryFreshness[] }) => {
      setState({ perCountry: payload.perCountry ?? [] });
    });
  } catch {
    return null;
  }
  return socket;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  ensureSocket();
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): RealtimeState {
  return state;
}

/** Hook utama. Contoh:
 *   const rt = useRealtime();
 *   useEffect(() => { if (rt.dataVersion) queryClient.invalidateQueries(["videos"]) }, [rt.dataVersion]);
 */
const emptySubscribe = () => () => {};

export function useRealtime(): RealtimeState {
  const snap = useSyncExternalStore(subscribe, getSnapshot, () => EMPTY);
  // Hydration-safe: false saat SSR/render pertama, true setelahnya (tanpa setState-in-effect)
  const mounted = useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
  return useMemo(() => (mounted ? snap : EMPTY), [snap, mounted]);
}

export function isHelloLoaded(): boolean {
  return helloLoaded;
}

export function getSocket(): Socket | null {
  return ensureSocket();
}

/**
 * v7: status job per scope dari antrian realtime.
 * Return map: scopeKey ("ALL" utk global / kode negara) → {status, mine, job}.
 * Status prioritas: running > held > ready.
 */
export function scopeJobMap(queue: QueueJob[]): Map<string, { status: string; mine: boolean; job: QueueJob }> {
  const map = new Map<string, { status: string; mine: boolean; job: QueueJob }>();
  const RANK: Record<string, number> = { running: 3, held: 2, ready: 1 };
  for (const j of queue) {
    const key = j.scopeType === "global" ? "ALL" : j.scopeValue;
    const prev = map.get(key);
    if (!prev || (RANK[j.status] ?? 0) > (RANK[prev.status] ?? 0)) {
      map.set(key, { status: j.status, mine: Boolean(j.mine), job: j });
    }
  }
  return map;
}

/** Setelah alert di-resolve di server, perbarui daftar lokal (optimistik). */
export function markAlertsResolved(type?: string): void {
  setState({
    alerts: state.alerts.map((a) =>
      !a.resolvedAt && (!type || a.type === type)
        ? { ...a, resolvedAt: Date.now() }
        : a
    ),
  });
}
