export function formatCompact(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

export function formatGmv(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.00$/, "").replace(/(\.\d)0$/, "$1")}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${n.toFixed(0)}`;
}

export function formatPrice(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function timeAgo(iso: string | number | Date): string {
  const then = new Date(iso).getTime();
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "baru saja";
  if (mins < 60) return `${mins}m lalu`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}j lalu`;
  const days = Math.floor(hours / 24);
  return `${days}h lalu`;
}

export function countdown(iso: string | number | Date | null | undefined): string {
  if (iso === null || iso === undefined) return "segera";
  const diff = Math.max(0, new Date(iso).getTime() - Date.now());
  const totalMins = Math.floor(diff / 60_000);
  const hours = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hours <= 0) return `${mins}m`;
  return `${hours}j ${mins}m`;
}

/** Salin teks ke clipboard dengan fallback (untuk browser/non-secure context). */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* lanjut ke fallback */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export const COUNTRY_FLAGS: Record<string, string> = {
  US: "🇺🇸",
  ID: "🇮🇩",
  TH: "🇹🇭",
  PH: "🇵🇭",
  MY: "🇲🇾",
  VN: "🇻🇳",
  GB: "🇬🇧",
  MX: "🇲🇽",
  SG: "🇸🇬",
  BR: "🇧🇷",
  ES: "🇪🇸",
  DE: "🇩🇪",
  JP: "🇯🇵",
  // v6: negara baru hasil discovery
  SA: "🇸🇦",
  FR: "🇫🇷",
  IT: "🇮🇹",
};

/** Opsi window rolling (kontrak API lama: kemarin|7d|15d|30d). */
export type RollingWindowKey = "kemarin" | "7d" | "15d" | "30d";

/**
 * WindowKey lengkap (v3): rolling + atribusi harian "day:N" (H-2..H-7)
 * dari bucket disjoint bot v3 — presisi per hari, tanpa false-positive.
 */
export type WindowKey = RollingWindowKey | `day:${2 | 3 | 4 | 5 | 6 | 7}`;

export const WINDOW_KEY_DEFAULT: WindowKey = "7d";

/** Cek apakah window adalah atribusi harian day:N. */
export function isDayWindow(key: string): key is `day:${2 | 3 | 4 | 5 | 6 | 7}` {
  return /^day:[2-7]$/.test(key);
}

/** Opsi filter per-hari (H-2..H-7) — dipakai Select "Hari posting". */
export const DAY_WINDOW_OPTIONS: Array<{ key: WindowKey; label: string }> = [
  { key: "day:2", label: "2 hari lalu" },
  { key: "day:3", label: "3 hari lalu" },
  { key: "day:4", label: "4 hari lalu" },
  { key: "day:5", label: "5 hari lalu" },
  { key: "day:6", label: "6 hari lalu" },
  { key: "day:7", label: "7 hari lalu" },
];

export const WINDOW_OPTIONS: Array<{ key: WindowKey; label: string; short: string }> = [
  { key: "kemarin", label: "Kemarin", short: "24 jam" },
  { key: "7d", label: "7 Hari", short: "mingguan" },
  { key: "15d", label: "15 Hari", short: "dua minggu" },
  { key: "30d", label: "30 Hari", short: "bulanan" },
];

export const WINDOW_LABELS: Record<string, string> = {
  kemarin: "Kemarin",
  "7d": "7 hari terakhir",
  "15d": "15 hari terakhir",
  "30d": "30 hari terakhir",
  all: "semua waktu",
  "day:2": "2 hari lalu",
  "day:3": "3 hari lalu",
  "day:4": "4 hari lalu",
  "day:5": "5 hari lalu",
  "day:6": "6 hari lalu",
  "day:7": "7 hari lalu",
};

/** Label window apa pun (rolling / day:N / all) — aman untuk key tak dikenal. */
export function windowLabel(key: string): string {
  return WINDOW_LABELS[key] ?? key;
}

export interface TrendVideo {
  id: string;
  tiktokId: string;
  videoUrl: string;
  authorHandle: string;
  authorName: string | null;
  authorAvatar?: string | null;
  thumbnail: string;
  caption: string;
  hashtags: string;
  country: string;
  category: string;
  duration: string;
  durationSec: number;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  sales: number;
  gmv: number;
  trafficType: string;
  isShopProduct: boolean;
  shopUrl: string | null;
  productTitle: string | null;
  productPriceMin: number | null;
  productPriceMax: number | null;
  productSold: number | null;
  productImage: string | null;
  trendingScore: number;
  postedAt: string;
  firstSeenAt: string;
  updatedAt: string;
}

export interface VideosResponse {
  ok: boolean;
  items: TrendVideo[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
  window: string;
  minSales: number;
  minViews: number;
}

export interface ScraperLastCycle {
  ok?: boolean;
  phase?: string;
  trigger?: string;
  finishedAtMs?: number | null;
  durationMs?: number | null;
  requests?: number | null;
  fetched?: number | null;
  upserted?: number | null;
  newVideos?: number | null;
  productsUpdated?: number | null;
}

/** v5.1 — progres siklus yang sedang berjalan (heartbeat bot tiap 30 detik). */
export interface LiveCycleProgress {
  live: true;
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
}

/** v6: ringkasan sistem scraping (realtime via socket + meta). */
export interface ScrapeSystemStatus {
  sessionState: string; // healthy | authing | human_required | unknown
  sessionAgeDays: number | null;
  botReachable: boolean;
  circuit: { state: string; openCount: number; failRatio: number } | null;
  activeJob: {
    id: string;
    scopeType: string;
    scopeValue: string;
    status: string;
    trigger: string;
    progress: { total: number; done: number; failed: number };
  } | null;
  unresolvedAlerts: number;
  slices: Record<string, number> | null;
}

export interface AlertItem {
  id: string;
  severity: string; // info | warning | critical
  type: string; // session | source | system | data
  message: string;
  meta: string;
  createdAt: number;
  resolvedAt: number | null;
}

export interface MetaResponse {
  ok: boolean;
  source?: string;
  /** Lokasi penyimpanan data terpusat (z-ai-cloud-db). */
  storage?: string;
  minRules?: { minSales: number; minViews: number };
  countries: Array<{
    code: string;
    name: string;
    flag: string;
    count: number;
    /** v6: freshness per negara (dari ScrapeSlice) — ms epoch, null = belum pernah. */
    lastScrapedAt?: number | null;
    failedSlices?: number;
    pendingSlices?: number;
    runningSlices?: number;
  }>;
  categories: Array<{ name: string; count: number }>;
  windowCounts?: Array<{ key: string; count: number }>;
  /** Jumlah video per atribusi harian H-2..H-7 (bot v3). */
  perDay?: Array<{ day: number; count: number }>;
  stats: { videos: number; views: number; likes: number; sales: number; gmv: number; countries: number };
  /** v6: sistem scraping (session/circuit/job/alerts). */
  system?: ScrapeSystemStatus;
  /** v6: alert unresolved (maks 10). */
  alerts?: AlertItem[];
  sync: {
    lastSyncAt: string;
    /** v5.1: null saat siklus berjalan (UI tampil "Siklus berjalan") — bukan lagi tanggal palsu. */
    nextSyncAt: string | null;
    syncCount: number;
    status: string;
    lastError?: string | null;
    intervalMs: number;
    scraper?: {
      running: boolean;
      nextRunAtMs: number | null;
      sessionDays: number | null;
      /** Progres live siklus berjalan (ada bila bot ≥ v5.1 & heartbeat aktif). */
      cycle?: LiveCycleProgress | null;
      lastCycle: ScraperLastCycle | null;
    } | null;
  };
}

/** Job aktif dari socket (bentuk ringan — UI). */
export interface LiveJob {
  id: string;
  scopeType: string;
  scopeValue: string;
  status: string;
  trigger: string;
  live: boolean;
  progress: { total: number; done: number; failed: number };
  startedAt?: number | null;
  finishedAt?: number | null;
  newVideos?: number;
  upserted?: number;
  requests?: number;
}
