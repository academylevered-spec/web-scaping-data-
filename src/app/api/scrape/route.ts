import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { readFileSync } from "node:fs";

export const dynamic = "force-dynamic";

const SCRAPER = "http://127.0.0.1:4020";

/**
 * KEEP-ALIVE: bila bot tak terjangkau, sertakan ALASAN NYATA dari down.json
 * (ditulis supervisor saat bot mati cepat — mis. kredensial hilang).
 * Pesan validasi tidak memuat nilai rahasia — aman dipamerkan.
 */
function botDownReason(): string | null {
  try {
    const raw = readFileSync(
      path.join(process.cwd(), "mini-services", "trend-scraper-python", "down.json"),
      "utf8"
    );
    const j = JSON.parse(raw) as { down?: boolean; reason?: string };
    return j?.down && j.reason ? String(j.reason).slice(0, 300) : null;
  } catch {
    return null;
  }
}

/**
 * v6 Scope-driven scraping — POST /api/scrape
 * Body: {scope:'global'} | {scope:'country', country:'ID'}
 *
 * Kontrak respons (ke frontend):
 *   200 {ok:true, started:true, job}          → job baru diantrekan
 *   200 {ok:true, started:false, alreadyQueued:true, job} → job scope sama sudah ada
 *   400 {ok:false, error}                     → body tidak valid
 *   502 {ok:false, error, retryAfterSec:30}   → bot tidak terjangkau (boot/crash)
 *
 * GET /api/scrape → daftar job + ringkasan antrian.
 */
export async function POST(req: NextRequest) {
  let body: { scope?: string; country?: string; source?: string; action?: string; id?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // v7: cancel / promote job (pass-through ke bot)
  if (body.action === "cancel" || body.action === "promote") {
    const id = (body.id ?? "").trim();
    if (!id) {
      return NextResponse.json({ ok: false, error: "id wajib" }, { status: 400 });
    }
    try {
      const res = await fetch(`${SCRAPER}/jobs/${body.action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return NextResponse.json(json, { status: res.ok ? 200 : res.status });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: "scraper service unreachable", detail: String(e), reason: botDownReason() },
        { status: 502 },
      );
    }
  }

  // v6: retry slice dead → proxy bot /jobs/retry-failed
  if (body.action === "retry-failed") {
    try {
      const res = await fetch(`${SCRAPER}/jobs/retry-failed`, {
        method: "POST",
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return NextResponse.json(json, { status: res.ok ? 200 : res.status });
    } catch (e) {
      return NextResponse.json(
        { ok: false, error: "scraper service unreachable", detail: String(e), reason: botDownReason() },
        { status: 502 },
      );
    }
  }

  const scope = body.scope === "country" ? "country" : "global";
  const country = (body.country ?? "").toUpperCase().trim();

  if (scope === "country" && !/^[A-Z]{2}$/.test(country)) {
    return NextResponse.json(
      { ok: false, error: "scope country membutuhkan kode negara 2 huruf" },
      { status: 400 },
    );
  }

  try {
    const res = await fetch(`${SCRAPER}/jobs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scopeType: scope,
        scopeValue: scope === "global" ? "ALL" : country,
        trigger: body.source === "ui" ? "ui" : "manual",
        source: body.source,
      }),
      signal: AbortSignal.timeout(8000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: (json.error as string) ?? `bot HTTP ${res.status}` },
        { status: res.status },
      );
    }
    return NextResponse.json(json, { status: 200 });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e), retryAfterSec: 30, reason: botDownReason() },
      { status: 502 },
    );
  }
}

export async function GET() {
  try {
    const res = await fetch(`${SCRAPER}/snapshot`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json({
      ok: true,
      running: json.running,
      instance: json.instance,
      session: json.session,
      circuit: json.circuit,
      activeJob: json.activeJob,
      queue: json.queue,
      lastResult: json.lastResult,
      jobs: json.jobs,
      slices: json.slices,
      perCountry: json.perCountry,
      failedSample: json.failedSample,
      discovery: json.discovery,
      totalVideos: json.totalVideos,
      nextRunAtMs: json.nextRunAtMs,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}
