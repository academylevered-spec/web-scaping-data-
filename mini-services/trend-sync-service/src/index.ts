/**
 * trend-sync-service — HTTP endpoints + scheduler boot.
 * Port 4010 (akses dari frontend via /?XTransformPort=4010).
 */
import { SERVICE_PORT } from "./config";
import { bootScheduler, reschedule } from "./scheduler";
import { runCycle, isRunning, getStatus } from "./sync";

const startedAt = Date.now();

const server = Bun.serve({
  port: SERVICE_PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/health") {
      return Response.json({ ok: true, uptimeMs: Date.now() - startedAt, running: isRunning() });
    }

    if (path === "/status") {
      try {
        const status = await getStatus();
        return Response.json({ ok: true, uptimeMs: Date.now() - startedAt, ...status });
      } catch (e) {
        return Response.json({ ok: false, error: String(e) }, { status: 500 });
      }
    }

    if (path === "/sync" && req.method === "POST") {
      if (isRunning()) {
        return Response.json({ ok: false, error: "Sync already running" }, { status: 409 });
      }
      // Jalankan di background agar response cepat; cek progres via /status
      runCycle("manual")
        .then((res) => {
          console.log(`[manual] done ok=${res.ok} upserted=${res.upserted} products=${res.productsUpdated}`);
          reschedule().catch(() => {});
        })
        .catch((e) => console.error("[manual] error:", e));
      return Response.json({ ok: true, started: true });
    }

    return Response.json({ ok: false, error: "Not found" }, { status: 404 });
  },
});

console.log(`[trend-sync] service listening on port ${server.port}`);
bootScheduler().catch((e) => console.error("[trend-sync] boot error:", e));
