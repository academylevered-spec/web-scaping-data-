import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureEngine } from "@/lib/trend-engine";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    await ensureEngine();
    const { id } = await ctx.params;
    // v6: tiktokId tidak lagi unique sendiri (unik per pasangan tiktokId+country) —
    // ambil baris terbaru untuk tiktokId tersebut (semantik sama: detail video).
    const video = await db.trendVideo.findFirst({
      where: { tiktokId: id },
      orderBy: { updatedAt: "desc" },
    });
    if (!video) {
      return NextResponse.json({ ok: false, error: "Video not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, video });
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e) }, { status: 500 });
  }
}
