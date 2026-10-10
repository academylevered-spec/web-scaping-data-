import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ensureEngine, windowWhereFor, MIN_SALES, MIN_VIEWS } from "@/lib/trend-engine";

export const dynamic = "force-dynamic";

const DURATION_FILTERS: Record<string, [number, number]> = {
  short: [0, 15],
  medium: [15, 30],
  long: [30, 100000],
};

const VIEW_FILTERS: Record<string, number> = {
  "10k": 10_000,
  "50k": 50_000,
  "100k": 100_000,
  "500k": 500_000,
  "1m": 1_000_000,
};

// v6: whitelist kolom sort untuk raw SQL (dedupe global)
const SORT_COLS: Record<string, string> = {
  sales: "sales",
  gmv: "gmv",
  views: "views",
  likes: "likes",
  trending: "trendingScore",
  newest: "firstSeenAt",
};

// v6: $queryRawUnsafe mengembalikan BigInt utk INTEGER SQLite → konversi sebelum JSON
function bigintToNumber(v: unknown): unknown {
  if (typeof v === "bigint") return Number(v);
  if (Array.isArray(v)) return v.map(bigintToNumber);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, bigintToNumber(val)])
    );
  }
  return v;
}

export async function GET(req: NextRequest) {
  try {
    await ensureEngine();
    const sp = req.nextUrl.searchParams;
    const country = sp.get("country") ?? "all";
    const category = sp.get("category") ?? "all";
    const duration = sp.get("duration") ?? "all";
    const views = sp.get("views") ?? "all";
    const traffic = sp.get("traffic") ?? "all";
    const sort = sp.get("sort") ?? "sales"; // default: penjualan terbanyak di atas
    const search = (sp.get("search") ?? "").trim().replace(/[%_]/g, "");
    const shopOnly = sp.get("shopOnly") === "1";
    const windowKey = sp.get("window") ?? "7d";
    const page = Math.max(1, parseInt(sp.get("page") ?? "1", 10) || 1);
    const pageSize = Math.min(60, Math.max(6, parseInt(sp.get("pageSize") ?? "24", 10) || 24));

    // Filter kualitas wajib: sales >= 10 & views > 10.000 (default, senada aturan bot v4.2)
    const minSales = Math.max(MIN_SALES, parseInt(sp.get("minSales") ?? `${MIN_SALES}`, 10) || MIN_SALES);
    const minViews = Math.max(MIN_VIEWS, parseInt(sp.get("minViews") ?? `${MIN_VIEWS}`, 10) || MIN_VIEWS);

    const where: any = {
      sales: { gte: minSales },
      views: { gt: minViews },
    };

    // Window waktu presisi: rolling (createTimeMax >= cutoff) atau day:N (windowBucket equality)
    const windowCond = windowWhereFor(windowKey);
    const hasWindow = Object.keys(windowCond).length > 0;
    Object.assign(where, windowCond);

    if (country !== "all") where.country = country;
    if (category !== "all") where.category = category;
    if (traffic !== "all") where.trafficType = traffic;
    if (shopOnly) where.isShopProduct = true;
    if (duration !== "all" && DURATION_FILTERS[duration]) {
      const [min, max] = DURATION_FILTERS[duration];
      where.durationSec = { gte: min, lt: max };
    }
    if (views !== "all" && VIEW_FILTERS[views]) {
      where.views = { ...where.views, gt: Math.max(minViews, VIEW_FILTERS[views]) };
    }
    if (search) {
      where.OR = [
        { caption: { contains: search } },
        { authorHandle: { contains: search } },
        { productTitle: { contains: search } },
        { hashtags: { contains: search } },
      ];
    }

    const orderBy: Record<string, "desc" | "asc"> =
      sort === "views"
        ? { views: "desc" }
        : sort === "likes"
          ? { likes: "desc" }
          : sort === "sales"
            ? { sales: "desc" }
            : sort === "gmv"
              ? { gmv: "desc" }
              : sort === "newest"
                ? { firstSeenAt: "desc" }
                : { trendingScore: "desc" };

    // ── v6: scope GLOBAL — dedupe per tiktokId (video yang trending di beberapa
    // negara kini 1 baris per negara; grid global menampilkan versi terbaik saja).
    // Scope negara — 1 baris per (tiktokId, country) → Prisma findMany biasa.
    let items;
    let total: number;
    if (country === "all") {
      const sortCol = SORT_COLS[sort] ?? "trendingScore";
      const conds: string[] = [`sales >= ${minSales}`, `views > ${minViews}`];
      if ("createTimeMax" in windowCond) {
        // windowWhereFor menyimpan cutoff epoch-detik di .gte (sudah dihitung saat request)
        conds.push(`createTimeMax >= ${(windowCond.createTimeMax as any).gte}`);
      } else if ("windowBucket" in windowCond) {
        conds.push(`windowBucket = ${windowCond.windowBucket as number}`);
      }
      if (category !== "all") conds.push(`category = '${category.replace(/'/g, "''")}'`);
      if (traffic !== "all") conds.push(`trafficType = '${traffic}'`);
      if (shopOnly) conds.push("isShopProduct = 1");
      if (duration !== "all" && DURATION_FILTERS[duration]) {
        const [min, max] = DURATION_FILTERS[duration];
        conds.push(`durationSec >= ${min} AND durationSec < ${max}`);
      }
      if (views !== "all" && VIEW_FILTERS[views]) {
        conds.push(`views > ${Math.max(minViews, VIEW_FILTERS[views])}`);
      }
      if (search) {
        const like = `'${search.replace(/'/g, "''")}'`;
        conds.push(
          `(caption LIKE ${like} OR authorHandle LIKE ${like} OR productTitle LIKE ${like} OR hashtags LIKE ${like})`
        );
      }
      const whereSql = conds.join(" AND ");
      const base = `FROM TrendVideo WHERE ${whereSql}`;
      const [rows, cntRows] = await Promise.all([
        db.$queryRawUnsafe<any[]>(
          `SELECT * FROM (
             SELECT *, ROW_NUMBER() OVER (
               PARTITION BY tiktokId
               ORDER BY ${sortCol} DESC, views DESC, id ASC
             ) AS _rn ${base}
           ) WHERE _rn = 1
           ORDER BY ${sortCol} DESC, views DESC
           LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`
        ),
        db.$queryRawUnsafe<Array<{ total: number }>>(
          `SELECT COUNT(DISTINCT tiktokId) AS total ${base}`
        ),
      ]);
      items = (rows as unknown[]).map(bigintToNumber) as typeof items;
      total = Number(cntRows[0]?.total ?? 0);
    } else {
      [items, total] = await Promise.all([
        db.trendVideo.findMany({
          where,
          orderBy: [orderBy, { views: "desc" }],
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
        db.trendVideo.count({ where }),
      ]);
    }

    const res = NextResponse.json({
      ok: true,
      items,
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
      window: hasWindow ? windowKey : "all",
      minSales,
      minViews,
    });
    // Data disegarkan bot tiap jam + UI polling — SWR memberi respons instan di edge/cache
    res.headers.set("Cache-Control", "public, s-maxage=10, stale-while-revalidate=30");
    return res;
  } catch (e) {
    return NextResponse.json({ ok: false, error: String(e), items: [], total: 0, page: 1, pageSize: 24, hasMore: false }, { status: 500 });
  }
}
