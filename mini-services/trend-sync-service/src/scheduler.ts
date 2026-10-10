/**
 * Scheduler drift-proof: setTimeout chain (bukan naive interval),
 * jalan saat boot bila belum ada data / sudah lewat nextSyncAt.
 */
import { PrismaClient } from "@prisma/client";
import { SYNC_INTERVAL_MS } from "./config";
import { runCycle, isRunning } from "./sync";

const db = new PrismaClient();
let timer: ReturnType<typeof setTimeout> | null = null;

async function scheduleNext() {
  if (timer) clearTimeout(timer);
  let nextAt = Date.now() + SYNC_INTERVAL_MS;
  try {
    const state = await db.syncState.findUnique({ where: { id: "singleton" } });
    if (state?.nextSyncAt) nextAt = state.nextSyncAt.getTime();
  } catch {
    /* pakai default */
  }
  const delay = Math.max(5000, nextAt - Date.now());
  timer = setTimeout(() => {
    tick().catch((e) => console.error("[scheduler] tick error:", e));
  }, delay);
  console.log(`[scheduler] next sync at ${new Date(nextAt).toISOString()} (in ${Math.round(delay / 60000)} min)`);
}

/** Re-align timer dengan SyncState (dipanggil setelah siklus manual). */
export async function reschedule() {
  await scheduleNext();
}

async function tick() {
  if (isRunning()) {
    await scheduleNext();
    return;
  }
  console.log(`[scheduler] sync cycle starting (${new Date().toISOString()})`);
  const res = await runCycle("scheduled");
  console.log(
    `[scheduler] cycle done ok=${res.ok} fetched=${res.fetched} upserted=${res.upserted} ` +
    `products=${res.products} errors=${res.errors.length} took=${Math.round(res.durationMs / 1000)}s`
  );
  if (res.errors.length) console.warn("[scheduler] sample errors:", res.errors.slice(0, 3));
  await scheduleNext();
}

/** Dipanggil saat boot: sync langsung bila perlu, lalu jadwalkan berikutnya. */
export async function bootScheduler() {
  // WAL mode agar aman dibaca bersamaan oleh Next.js
  await db.$queryRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});

  const state = await db.syncState.findUnique({ where: { id: "singleton" } });
  const count = await db.trendVideo.count();
  const needsSync =
    !state || count === 0 || !state.lastSyncAt || Date.now() >= state.nextSyncAt.getTime();

  if (needsSync) {
    console.log("[scheduler] boot: data missing/stale — running first cycle now");
    runCycle("boot")
      .then((res) => {
        console.log(
          `[scheduler] boot cycle done ok=${res.ok} upserted=${res.upserted} errors=${res.errors.length}`
        );
      })
      .catch((e) => console.error("[scheduler] boot cycle error:", e))
      .finally(() => scheduleNext());
  } else {
    console.log(`[scheduler] boot: data fresh (${count} videos) — scheduling only`);
    await scheduleNext();
  }
}
