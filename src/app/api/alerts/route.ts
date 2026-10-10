import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const SCRAPER = "http://127.0.0.1:4020";

/** GET /api/alerts — daftar alert operasional (unresolved dulu, terbaru dulu). */
export async function GET() {
  try {
    const res = await fetch(`${SCRAPER}/snapshot`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    const alerts: Array<Record<string, unknown>> = json.alerts ?? [];
    const unresolved = alerts.filter((a) => !a.resolvedAt);
    const resolved = alerts.filter((a) => a.resolvedAt);
    return NextResponse.json({
      ok: true,
      alerts: [...unresolved, ...resolved],
      unresolvedCount: unresolved.length,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e), alerts: [] },
      { status: 502 },
    );
  }
}

/** POST /api/alerts {action:'resolve', id?, type?} — tandai alert resolved. */
export async function POST(req: NextRequest) {
  let body: { action?: string; type?: string } = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }
  if (body.action !== "resolve") {
    return NextResponse.json({ ok: false, error: "action harus 'resolve'" }, { status: 400 });
  }
  try {
    const res = await fetch(`${SCRAPER}/alerts/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: body.type }),
      signal: AbortSignal.timeout(5000),
    });
    const json = await res.json();
    return NextResponse.json(json, { status: res.status });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "scraper service unreachable", detail: String(e) },
      { status: 502 },
    );
  }
}
