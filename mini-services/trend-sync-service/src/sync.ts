/**
 * Siklus sync: fetch trending real (13 region × 29 kategori, window 7 hari),
 * upsert ke DB, fetch detail produk, catat SyncLog.
 */
import { PrismaClient } from "@prisma/client";
import {
  REGIONS, SOURCE_CATEGORIES, WINDOW_DAYS, MAX_PAGES_PER_COMBO, PAGE_SIZE,
  PRODUCT_BATCH, MAX_PRODUCT_LOOKUPS,
} from "./config";
import { apiGet, ensureSession, getSessionInfo } from "./client";

const db = new PrismaClient();

interface TrendingItem {
  id: number | string;
  thumbnail: string;
  duration: string;
  caption: string;
  category: string;
  views: string;
  likes: string;
  video_url: string;
  salesFlag: number;
  uniqueId: string;
  salesCount: number;
  salesGmv: number;
  productIds: string[];
  avatar: string;
  isAd: boolean;
  contentType: string;
}

interface TrendingResponse {
  code: number;
  msg: string;
  data: TrendingItem[] | null;
}

interface ProductDetail {
  productId: string;
  cover: string;
  name: string;
  minPrice: number;
  maxPrice: number;
  totalSaleCnt: number;
}

interface ProductResponse {
  code: number;
  data: Record<string, ProductDetail>;
}

function parseCount(s: string | number | undefined | null): number {
  if (s == null) return 0;
  if (typeof s === "number") return Math.round(s);
  const m = s.trim().match(/^([\d.,]+)\s*([KMB])?$/i);
  if (!m) return 0;
  const num = parseFloat(m[1].replace(/,/g, ""));
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] ?? "").toLowerCase()] ?? 1;
  return Math.round(num * mult);
}

function durationToSec(d: string): number {
  const parts = (d ?? "00:00").split(":").map((p) => parseInt(p, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function extractHashtags(caption: string): string {
  const tags = caption.match(/#[\p{L}\p{N}_]+/gu) ?? [];
  return tags.map((t) => t.slice(1)).slice(0, 12).join(",");
}

function computeScore(v: { views: number; likes: number; sales: number; gmv: number; durationSec: number }): number {
  const lg = (n: number) => Math.log10(Math.max(n, 10));
  return +(
    lg(v.views) * 30 + lg(v.likes) * 25 + lg(v.sales) * 20 + lg(v.gmv) * 15 +
    (v.durationSec > 0 && v.durationSec <= 60 ? 10 : 4)
  ).toFixed(2);
}

async function upsertVideo(item: TrendingItem, region: string, sourceCategory: string) {
  const tiktokId = String(item.id);
  const views = parseCount(item.views);
  const likes = parseCount(item.likes);
  const sales = item.salesCount ?? 0;
  const gmv = item.salesGmv ?? 0;
  const durationSec = durationToSec(item.duration);
  const productId = item.productIds?.[0] ?? null;
  const isShopProduct = !!productId;

  const base = {
    tiktokId,
    videoUrl: item.video_url,
    authorHandle: item.uniqueId ?? "",
    authorAvatar: item.avatar ?? null,
    thumbnail: item.thumbnail ?? "",
    caption: item.caption ?? "",
    hashtags: extractHashtags(item.caption ?? ""),
    country: region,
    category: sourceCategory,
    sourceCategory,
    duration: item.duration ?? "00:00",
    durationSec,
    views,
    likes,
    trafficType: item.isAd ? "ads" : "organic",
    isShopProduct,
    shopUrl: productId ? `https://www.tiktok.com/shop/pdp/${productId}` : null,
    sales,
    gmv,
    trendingScore: computeScore({ views, likes, sales, gmv, durationSec }),
  };

  await db.trendVideo.upsert({
    where: { tiktokId },
    create: { ...base, postedAt: new Date() },
    update: {
      views: base.views,
      likes: base.likes,
      sales: base.sales,
      gmv: base.gmv,
      trafficType: base.trafficType,
      thumbnail: base.thumbnail,
      caption: base.caption,
      hashtags: base.hashtags,
      duration: base.duration,
      durationSec: base.durationSec,
      isShopProduct: base.isShopProduct,
      shopUrl: base.shopUrl,
      authorAvatar: base.authorAvatar,
      trendingScore: base.trendingScore,
    },
  });
}

/**
 * Enrichment produk: ambil detail (judul, harga, terjual, cover) untuk video
 * shoppable yang belum punya detail — di-backfill tiap siklus hingga lengkap.
 */
async function enrichProducts(): Promise<{ looked: number; updated: number; failed: number }> {
  const missing = await db.trendVideo.findMany({
    where: { isShopProduct: true, productTitle: null },
    select: { shopUrl: true },
    orderBy: { views: "desc" },
    take: 2500,
  });

  const ids = new Set<string>();
  for (const m of missing) {
    const match = m.shopUrl?.match(/pdp\/(\d+)/);
    if (match) ids.add(match[1]);
  }

  const arr = [...ids].slice(0, 2500);
  let updated = 0;
  let failed = 0;

  for (let i = 0; i < arr.length; i += PRODUCT_BATCH) {
    const batch = arr.slice(i, i + PRODUCT_BATCH);
    const res = await apiGet<ProductResponse>({
      path: `/app/api/product/batch-detail?product_ids=${batch.join(",")}`,
    });
    if (!res || res.code !== 0 || !res.data) {
      failed++;
      console.warn(`[products] batch ${Math.floor(i / PRODUCT_BATCH) + 1} failed`);
      continue;
    }
    const entries = Object.values(res.data);
    for (const p of entries) {
      if (!p?.productId) continue;
      const r = await db.trendVideo.updateMany({
        where: { shopUrl: { endsWith: p.productId } },
        data: {
          productTitle: p.name ?? null,
          productPriceMin: p.minPrice ?? null,
          productPriceMax: p.maxPrice ?? null,
          productSold: p.totalSaleCnt ?? null,
          productImage: p.cover ?? null,
        },
      });
      updated += r.count;
    }
  }
  return { looked: arr.length, updated, failed };
}

export interface CycleResult {
  ok: boolean;
  fetched: number;
  upserted: number;
  productsUpdated: number;
  productsLooked: number;
  productsFailed: number;
  combos: number;
  errors: string[];
  durationMs: number;
}

let running = false;
export function isRunning() {
  return running;
}

export async function runCycle(trigger: "scheduled" | "manual" | "boot"): Promise<CycleResult> {
  const startedAt = new Date();
  const result: CycleResult = {
    ok: false, fetched: 0, upserted: 0, productsUpdated: 0, productsLooked: 0, productsFailed: 0,
    combos: 0, errors: [], durationMs: 0,
  };

  if (running) {
    result.errors.push("cycle already running");
    return result;
  }
  running = true;

  const log = await db.syncLog.create({ data: { startedAt, trigger, status: "running" } });
  await db.syncState.upsert({
    where: { id: "singleton" },
    create: { id: "singleton", lastSyncAt: startedAt, nextSyncAt: new Date(startedAt.getTime() + 7200_000), syncCount: 0, status: "syncing" },
    update: { status: "syncing" },
  });

  try {
    if (!(await ensureSession(true))) {
      result.errors.push("login failed");
      throw new Error("login failed");
    }

    const minCreateTime = Math.floor((Date.now() - WINDOW_DAYS * 24 * 3600 * 1000) / 1000);
    const maxCreateTime = Math.floor(Date.now() / 1000);

    for (const region of REGIONS) {
      for (const cat of SOURCE_CATEGORIES) {
        for (let page = 1; page <= MAX_PAGES_PER_COMBO; page++) {
          const path =
            `/app/api/trending?pageNum=${page}&pageSize=${PAGE_SIZE}` +
            `&region=${region}&contentType=all&salesFlag=withSales&createdByAi=false` +
            `&product_category_id=${cat.id}&minCreateTime=${minCreateTime}&maxCreateTime=${maxCreateTime}`;
          const res = await apiGet<TrendingResponse>({ path });

          if (!res || res.code !== 0) {
            result.errors.push(`${region}/${cat.name}/p${page}: bad response`);
            break;
          }

          const items = res.data ?? [];
          result.fetched += items.length;
          result.combos++;

          for (const item of items) {
            try {
              await upsertVideo(item, region, cat.name);
              result.upserted++;
            } catch (e) {
              result.errors.push(`upsert ${item.id}: ${String(e).slice(0, 120)}`);
            }
          }

          if (items.length < PAGE_SIZE) break; // halaman terakhir
        }
      }
      console.log(`[sync] region ${region} done (total upserted: ${result.upserted})`);
    }

    const prod = await enrichProducts();
    result.productsUpdated = prod.updated;
    result.productsLooked = prod.looked;
    result.productsFailed = prod.failed;
    result.ok = result.upserted > 0;

    const finishedAt = new Date();
    await db.syncLog.update({
      where: { id: log.id },
      data: {
        finishedAt,
        status: result.ok ? "success" : "empty",
        fetched: result.fetched,
        upserted: result.upserted,
        errors: result.errors.slice(0, 20).join(" | ").slice(0, 4000),
      },
    });
    await db.syncState.update({
      where: { id: "singleton" },
      data: {
        lastSyncAt: finishedAt,
        nextSyncAt: new Date(finishedAt.getTime() + 7200_000),
        syncCount: { increment: 1 },
        status: "idle",
      },
    });
  } catch (e) {
    result.errors.push(String(e).slice(0, 300));
    await db.syncLog.update({
      where: { id: log.id },
      data: {
        finishedAt: new Date(),
        status: "error",
        fetched: result.fetched,
        upserted: result.upserted,
        errors: result.errors.join(" | ").slice(0, 4000),
      },
    });
    await db.syncState.update({ where: { id: "singleton" }, data: { status: "error" } }).catch(() => {});
  } finally {
    running = false;
    result.durationMs = Date.now() - startedAt.getTime();
  }

  return result;
}

export async function getStatus() {
  const [state, count, lastLogs] = await Promise.all([
    db.syncState.findUnique({ where: { id: "singleton" } }),
    db.trendVideo.count(),
    db.syncLog.findMany({ orderBy: { startedAt: "desc" }, take: 5 }),
  ]);
  return { state, videoCount: count, lastLogs, session: getSessionInfo(), running };
}
