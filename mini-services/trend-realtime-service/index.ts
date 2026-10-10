/**
 * TrendPulse Realtime Service v6 — jembatan WebSocket antara bot scraper (:4020),
 * database SQLite, dan frontend (socket.io).
 *
 * PORT: 4030. Frontend connect: io("/?XTransformPort=4030") — path '/' (Caddy gateway).
 *
 * EVENT CONTRACT (emit):
 *  - bot:status   {running, session, circuit, metrics, totalVideos, nextRunAtMs, uptimeMs,
 *                  reachable, slices, unresolvedAlerts, queueLen}
 *      → tiap 2 dtk (heartbeat) atau saat berubah.
 *  - job:update   {id, scopeType, scopeValue, status, trigger, priority, progress:{total,done,failed},
 *                  requests, fetched, upserted, newVideos, productsUpdated, startedAt, finishedAt}
 *      → saat job aktif milik v7 berjalan (tiap 2 dtk) & saat selesai.
 *  - queue:update {jobs:[{id,scopeType,scopeValue,status,trigger,priority,pausedReason,
 *                  progress?,createdAt,owner,mine?}]}  → antrian penuh (v7), tiap 2 dtk on-change.
 *  - data:update  {newVideos, totalVideos}  → saat ada video baru masuk (frontend invalidate query).
 *  - alert:new    {alert}                   → saat alert unresolved baru muncul.
 *  - slices:update{perCountry:[...]}        → ringkasan freshness per negara (tiap 5 dtk / berubah).
 *
 * Sumber data: GET http://127.0.0.1:4020/snapshot (bot) + baca SQLite readonly
 * untuk agregasi yang butuh SQL (progress job, per-country).
 */
import { createServer } from "http";
import { readFileSync } from "node:fs";
import { Server } from "socket.io";
import { Database } from "bun:sqlite";

const PORT = 4030;
const BOT = "http://127.0.0.1:4020";
const DB_PATH = process.env.SCRAPER_DB_PATH || "/home/z/my-project/db/custom.db";
/** KEEP-ALIVE L2: ditulis supervisor saat bot mati cepat berulang (alasan nyata). */
const BOT_DOWN_FILE = "/home/z/my-project/mini-services/trend-scraper-python/down.json";

interface BotDown {
  down: boolean;
  reason: string;
  lastExitCode: number | null;
  restarts?: number;
  sinceMs?: number;
}

function readBotDown(): BotDown | null {
  try {
    const raw = readFileSync(BOT_DOWN_FILE, "utf8");
    const j = JSON.parse(raw) as BotDown;
    return j && j.down ? j : null;
  } catch {
    return null;
  }
}

const httpServer = createServer();
const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: "/",
  cors: { origin: "*", methods: ["GET", "POST"] },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── SQLite readonly (WAL-safe: koneksi terpisah dari bot & Prisma) ──────
let db: Database | null = null;
function openDb(): Database | null {
  if (db) return db;
  try {
    db = new Database(DB_PATH, { readonly: true });
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  } catch (e) {
    console.error("[realtime] gagal buka db:", e);
    return null;
  }
}

function jobProgress(jobId: string): { total: number; done: number; failed: number } {
  const d = openDb();
  if (!d) return { total: 0, done: 0, failed: 0 };
  try {
    const row = d
      .query(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status='done' THEN 1 ELSE 0 END),0) AS done,
                COALESCE(SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END),0) AS failed
         FROM ScrapeSlice WHERE lastJobId=?`
      )
      .get(jobId) as any;
    return { total: row?.total ?? 0, done: row?.done ?? 0, failed: row?.failed ?? 0 };
  } catch {
    return { total: 0, done: 0, failed: 0 };
  }
}

function perCountry(): Array<Record<string, unknown>> {
  const d = openDb();
  if (!d) return [];
  try {
    return d
      .query(
        `SELECT country,
                SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) AS done,
                SUM(CASE WHEN status IN ('failed','dead') THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS pending,
                SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
                MAX(lastSuccessAt) AS lastSuccessAt
         FROM ScrapeSlice GROUP BY country ORDER BY country`
      )
      .all() as any;
  } catch {
    return [];
  }
}

function totalVideos(): number {
  const d = openDb();
  if (!d) return 0;
  try {
    return (d.query("SELECT COUNT(*) AS n FROM TrendVideo").get() as any)?.n ?? 0;
  } catch {
    return 0;
  }
}

function latestAlerts(limit = 30): Array<Record<string, unknown>> {
  const d = openDb();
  if (!d) return [];
  try {
    return d
      .query(
        `SELECT id, severity, type, message, meta, createdAt, resolvedAt
         FROM Alert ORDER BY createdAt DESC LIMIT ?`
      )
      .all(limit) as any;
  } catch {
    return [];
  }
}

// ── Polling bot + diff emit ─────────────────────────────────────────────
interface State {
  lastSnapshot: any | null;
  lastTotalVideos: number;
  lastAlertId: string | null;
  lastJobKey: string;
  lastPerCountryJson: string;
  lastQueueJson: string;
  botReachable: boolean;
  lastSliceEmit: number;
}
const S: State = {
  lastSnapshot: null,
  lastTotalVideos: -1,
  lastAlertId: null,
  lastJobKey: "",
  lastPerCountryJson: "",
  lastQueueJson: "",
  botReachable: false,
  lastSliceEmit: 0,
};

async function fetchSnapshot(): Promise<any | null> {
  try {
    const res = await fetch(`${BOT}/snapshot`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) throw new Error(String(res.status));
    S.botReachable = true;
    return await res.json();
  } catch {
    S.botReachable = false;
    return null;
  }
}

async function poll(): Promise<void> {
  const snap = await fetchSnapshot();
  const total = totalVideos();
  // KEEP-ALIVE L2: alasan down hanya relevan saat bot TIDAK terjangkau.
  const botDown = S.botReachable ? null : readBotDown();

  // bot:status — selalu emit (2 dtk) agar UI tahu liveness
  io.emit("bot:status", {
    reachable: S.botReachable,
    running: snap?.running ?? false,
    session: snap?.session ?? { state: S.botReachable ? "unknown" : "unreachable" },
    circuit: snap?.circuit ?? null,
    metrics: snap?.metrics ?? null,
    slices: snap?.slices ?? null,
    unresolvedAlerts: snap?.unresolvedAlerts ?? 0,
    nextRunAtMs: snap?.nextRunAtMs ?? null,
    uptimeMs: snap?.uptimeMs ?? null,
    queueLen: Array.isArray(snap?.queue) ? snap.queue.length : 0,
    totalVideos: total,
    down: botDown
      ? { reason: botDown.reason, lastExitCode: botDown.lastExitCode, sinceMs: botDown.sinceMs ?? null }
      : null,
    atMs: Date.now(),
  });

  // job:update — hanya job milik instance v7 (activeJob dari state proses bot)
  const activeJob = snap?.activeJob ?? null;
  const lastResult = snap?.lastResult ?? null;
  if (activeJob) {
    const prog = jobProgress(activeJob.id);
    io.emit("job:update", {
      ...activeJob,
      progress: prog,
      live: true,
    });
    S.lastJobKey = `${activeJob.id}:${activeJob.status}:${prog.done}:${prog.failed}`;
  } else if (lastResult) {
    const key = `${lastResult.jobId}:finished`;
    if (key !== S.lastJobKey) {
      io.emit("job:update", { ...lastResult, progress: jobProgress(lastResult.jobId), live: false });
      S.lastJobKey = key;
    }
  }

  // queue:update (v7) — antrian lengkap, hanya saat berubah
  if (Array.isArray(snap?.queue)) {
    const qJson = JSON.stringify(snap.queue);
    if (qJson !== S.lastQueueJson) {
      S.lastQueueJson = qJson;
      io.emit("queue:update", { jobs: snap.queue });
    }
  }

  // data:update — hanya saat total naik
  if (S.lastTotalVideos >= 0 && total > S.lastTotalVideos) {
    io.emit("data:update", { totalVideos: total, delta: total - S.lastTotalVideos });
  }
  S.lastTotalVideos = total;

  // alert:new — alert teratas belum pernah diumumkan
  const alerts = latestAlerts(1);
  const top = alerts[0] as { id: string } | undefined;
  if (top && top.id !== S.lastAlertId) {
    S.lastAlertId = top.id;
    io.emit("alert:new", { alert: top });
  }

  // slices:update — throttle 5 dtk + hanya saat berubah
  if (!S.lastSnapshot || Date.now() - S.lastSliceEmit > 5000) {
    const pc = perCountry();
    const json = JSON.stringify(pc);
    if (json !== S.lastPerCountryJson) {
      S.lastPerCountryJson = json;
      io.emit("slices:update", { perCountry: pc });
    }
    S.lastSliceEmit = Date.now();
  }

  S.lastSnapshot = snap;
}

// ── Socket handlers ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log(`[realtime] client connected: ${socket.id}`);
  // kirim snapshot penuh saat pertama connect agar UI langsung terisi
  socket.emit("hello", {
    perCountry: perCountry(),
    alerts: latestAlerts(30),
    totalVideos: totalVideos(),
  });
  socket.on("ping", (cb) => typeof cb === "function" && cb({ t: Date.now() }));
  socket.on("disconnect", () => console.log(`[realtime] client disconnected: ${socket.id}`));
  socket.on("error", (e) => console.error(`[realtime] socket error (${socket.id}):`, e));
});

// poll loop 2 dtk
setInterval(() => void poll(), 2000);
void poll();

httpServer.listen(PORT, () => {
  console.log(`[realtime] WebSocket service listening on port ${PORT} (path '/')`);
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[realtime] SIGTERM — shutdown");
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000);
});
process.on("SIGINT", () => process.exit(0));
