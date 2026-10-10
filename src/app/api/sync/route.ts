import { NextResponse } from "next/server";
import { ensureEngine, readScraperStatus } from "@/lib/trend-engine";

export const dynamic = "force-dynamic";

const SCRAPER = "http://127.0.0.1:4020";

/** Status bot scraper (proxy ke service Python + status DB). */
export async function GET() {
  await ensureEngine();
  try {
    const res = await fetch(`${SCRAPER}/status`, { cache: "no-store", signal: AbortSignal.timeout(5000) });
    const json = await res.json();
    return NextResponse.json({ ...json, scraperStatusFile: readScraperStatus() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e), scraperStatusFile: readScraperStatus() },
      { status: 502 },
    );
  }
}

/**
 * Trigger siklus scraping manual (berjalan background di service Python).
 *
 * v5.1 hardening — kontrak respons yang jelas untuk frontend:
 *   200 → siklus baru dimulai            { ok: true, started: true }
 *   409 → siklus sudah berjalan          { ok: false, alreadyRunning: true } (+ progres live bila ada)
 *   502 → service bot tidak aktif        { ok: false, error, retryAfterSec: 30 }
 */
export async function POST() {
  await ensureEngine();
  try {
    const res = await fetch(`${SCRAPER}/trigger`, { method: "POST", signal: AbortSignal.timeout(8000) });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 409) {
      const scraper = readScraperStatus();
      return NextResponse.json(
        { ...json, ok: false, alreadyRunning: true, cycle: scraper?.cycleProgress ?? null },
        { status: 409 },
      );
    }
    return NextResponse.json(json, { status: res.ok ? 200 : res.status });
  } catch (e) {
    // Bot mati/crash-loop (mis. dependency hilang saat boot deploy) → 502 eksplisit
    // + retryAfterSec agar frontend & user tahu kapan harus mencoba lagi.
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e), retryAfterSec: 30 },
      { status: 502 },
    );
  }
}
