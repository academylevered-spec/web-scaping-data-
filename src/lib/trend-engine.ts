import fs from "fs";
import path from "path";
import { db } from "@/lib/db";

/**
 * Data engine — REAL MODE (v2).
 *
 * Data 100% real di-scrape langsung dari creatok.ai oleh bot Python
 * `mini-services/trend-scraper-python` (24/7, tiap 1 jam, port 4020).
 * Bot menulis ke database Z.ai (SQLite WAL) yang sama dengan aplikasi ini.
 * Modul ini read-only: state sinkronisasi + status bot + helper window waktu.
 */

export const SYNC_INTERVAL_MS = 1 * 60 * 60 * 1000; // per 1 jam

export interface CountryDef {
  code: string;
  name: string;
  flag: string;
}

export const COUNTRIES: CountryDef[] = [
  { code: "US", name: "United States", flag: "🇺🇸" },
  { code: "ID", name: "Indonesia", flag: "🇮🇩" },
  { code: "TH", name: "Thailand", flag: "🇹🇭" },
  { code: "PH", name: "Philippines", flag: "🇵🇭" },
  { code: "MY", name: "Malaysia", flag: "🇲🇾" },
  { code: "VN", name: "Vietnam", flag: "🇻🇳" },
  { code: "GB", name: "United Kingdom", flag: "🇬🇧" },
  { code: "SG", name: "Singapore", flag: "🇸🇬" },
  { code: "JP", name: "Japan", flag: "🇯🇵" },
];

// Blocklist negara (permintaan pemilik): data dihapus dari DB & bot berhenti
// men-scrape. Region ini juga disaring dari hasil discovery bot agar tidak
// pernah muncul lagi di UI. Sinkron dengan EXCLUDED_REGIONS di config.py bot.
export const EXCLUDED_COUNTRIES = new Set(["MX", "ES", "DE", "SA", "FR", "IT", "BR"]);

/** Gabungkan daftar negara statis dengan hasil discovery bot (region baru otomatis tampil). */
export function mergeDiscoveredCountries(
  discovered: Array<{ code: string; name?: string }> | undefined | null,
): CountryDef[] {
  const filtered = (discovered ?? []).filter((d) => !EXCLUDED_COUNTRIES.has(d.code));
  if (filtered.length === 0) return COUNTRIES;
  const known = new Map(COUNTRIES.map((c) => [c.code, c]));
  const out = COUNTRIES.slice();
  for (const d of filtered) {
    if (!known.has(d.code)) {
      out.push({ code: d.code, name: d.name ?? d.code, flag: "🏳️" });
      known.set(d.code, { code: d.code, name: d.name ?? d.code, flag: "🏳️" });
    }
  }
  return out;
}

/** Snapshot status bot dari HTTP service :4020 (null bila mati). */
export async function fetchScraperSnapshot(): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch("http://127.0.0.1:4020/snapshot", {
      cache: "no-store",
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Filter window waktu (rolling, berbasis batas createTime hasil scrape presisi). */
export interface WindowDef {
  key: string;
  label: string;
  sublabel: string;
  seconds: number;
}

export const WINDOWS: WindowDef[] = [
  { key: "kemarin", label: "Kemarin", sublabel: "video terbaru terindeks (±36 jam)", seconds: 36 * 3600 },
  { key: "7d", label: "7 Hari", sublabel: "7 hari terakhir", seconds: 7 * 86400 },
  { key: "15d", label: "15 Hari", sublabel: "15 hari terakhir", seconds: 15 * 86400 },
  { key: "30d", label: "30 Hari", sublabel: "30 hari terakhir", seconds: 30 * 86400 },
];

/** Kunci window valid → batas waktu (epoch detik) atau null utk "all". */
export function windowCutoffSec(key: string | null | undefined): number | null {
  const w = WINDOWS.find((x) => x.key === key);
  if (!w) return null;
  return Math.floor(Date.now() / 1000) - w.seconds;
}

/**
 * Atribusi HARIAN (v3) — "kemarin-kemarinnya".
 * Bot v3 men-sweep 6 bucket disjoint: [1.5-2d]=10, [2-3d]=9, … [6-7d]=5.
 * day:N (diposting ±N hari lalu) → windowBucket = 12 - N (equality, 0 false-positive).
 */
export function dayWindowBucket(key: string | null | undefined): number | null {
  const m = /^day:([2-7])$/.exec(key ?? "");
  if (!m) return null;
  return 12 - Number(m[1]);
}

/**
 * Where Prisma untuk window aktif:
 * - rolling (kemarin/7d/15d/30d) → createTimeMax >= cutoff (perilaku lama, identik)
 * - day:N → windowBucket = 12-N (presisi per hari, index [windowBucket, sales])
 * - all/invalid → {} (tanpa filter)
 */
export function windowWhereFor(key: string | null | undefined): Record<string, unknown> {
  const bucket = dayWindowBucket(key);
  if (bucket !== null) return { windowBucket: bucket };
  const cutoff = windowCutoffSec(key);
  return cutoff !== null ? { createTimeMax: { gte: cutoff } } : {};
}

/** Filter kualitas minimal (aturan bot): sales ≥ 10, views ≥ 10.000. */
export const MIN_SALES = 10;
export const MIN_VIEWS = 10_000;

export interface ScraperStatus {
  ok?: boolean;
  running?: boolean;
  nextRunAtMs?: number | null;
  intervalSeconds?: number;
  minSales?: number;
  minViews?: number;
  session?: { hasSession?: boolean; ageDays?: number | null };
  totalVideos?: number;
  /** v5.1: progres siklus berjalan (ditulis heartbeat bot tiap 30 detik). */
  cycleProgress?: {
    live: boolean;
    trigger: string;
    phase: string;
    startedAtMs: number;
    elapsedMs: number;
    requests: number;
    fetched: number;
    qualifying: number;
    upserted: number;
    newVideos: number;
    productsUpdated: number;
    errorCount: number;
  } | null;
  lastCycle?: {
    ok?: boolean;
    phase?: string;
    trigger?: string;
    startedAtMs?: number;
    finishedAtMs?: number;
    durationMs?: number;
    requests?: number;
    fetched?: number;
    qualifying?: number;
    upserted?: number;
    newVideos?: number;
    productsUpdated?: number;
    pruned?: number;
    errors?: string[];
  } | null;
}

/** Baca status.json yang ditulis bot Python (null bila belum ada). */
export function readScraperStatus(): ScraperStatus | null {
  try {
    const p = path.join(process.cwd(), "mini-services", "trend-scraper-python", "status.json");
    return JSON.parse(fs.readFileSync(p, "utf8")) as ScraperStatus;
  } catch {
    return null;
  }
}

/** Ambil/isi state sinkronisasi (read-only bootstrap). */
export async function getSyncState() {
  let state = await db.syncState.findUnique({ where: { id: "singleton" } });
  if (!state) {
    state = await db.syncState.create({
      data: {
        id: "singleton",
        lastSyncAt: new Date(0),
        nextSyncAt: new Date(Date.now() + SYNC_INTERVAL_MS),
        syncCount: 0,
        status: "idle",
      },
    });
  }
  return state;
}

export async function ensureEngine(): Promise<void> {
  await getSyncState();
}

// ── Gradient cover fallback (thumbnail CDN kedaluwarsa) ─────────────────
const GRADIENTS: Array<[string, string]> = [
  ["#0f172a", "#334155"],
  ["#1c1917", "#57534e"],
  ["#052e2b", "#0f766e"],
  ["#2d1b0e", "#b45309"],
  ["#1a2e05", "#4d7c0f"],
  ["#2e1065", "#7c3aed"],
  ["#500724", "#be185d"],
  ["#0c2d48", "#0369a1"],
  ["#3b0764", "#a21caf"],
  ["#431407", "#ea580c"],
  ["#022c22", "#059669"],
  ["#450a0a", "#dc2626"],
];

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function coverDataUri(seed: string, label: string): string {
  const h = hashStr(seed);
  const [c1, c2] = GRADIENTS[h % GRADIENTS.length];
  const angle = 100 + (h % 80);
  const short = label.length > 26 ? label.slice(0, 26) + "…" : label;
  const words = short.split(" ");
  const lines = words
    .reduce<string[][]>((acc, w, i) => {
      if (i % 3 === 0) acc.push([w]);
      else acc[acc.length - 1].push(w);
      return acc;
    }, [])
    .map((line) => line.join(" "))
    .slice(0, 3);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="640" viewBox="0 0 360 640"><defs><linearGradient id="g" gradientTransform="rotate(${angle} .5 .5)"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs><rect width="360" height="640" fill="url(#g)"/><circle cx="300" cy="90" r="140" fill="rgba(255,255,255,0.05)"/><circle cx="60" cy="560" r="110" fill="rgba(255,255,255,0.04)"/>${lines
    .map(
      (l, i) =>
        `<text x="32" y="${320 + i * 44}" font-family="-apple-system,'SF Pro Display',Helvetica,Arial,sans-serif" font-size="30" font-weight="700" fill="rgba(255,255,255,0.92)">${l.replace(
          /[<>&]/g,
          ""
        )}</text>`
    )
    .join("")}<text x="32" y="440" font-family="-apple-system,Helvetica,Arial,sans-serif" font-size="16" font-weight="500" fill="rgba(255,255,255,0.55)">${label
      .slice(0, 40)
      .replace(/[<>&]/g, "")}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}
