import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const bad = await prisma.trendVideo.findMany({
    where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] },
    select: { tiktokId: true, views: true, sales: true, country: true, windowBucket: true, updatedAt: true, firstSeenAt: true, productTitle: true },
    orderBy: { updatedAt: 'desc' },
    take: 20,
  });
  console.log('=== 20 contoh pelanggaran ===');
  for (const v of bad) {
    console.log(`${v.tiktokId} views=${v.views} sales=${v.sales} bucket=${v.windowBucket} ${v.country} seen=${v.firstSeenAt.toISOString().slice(5, 16)} upd=${v.updatedAt.toISOString().slice(5, 16)} prod=${v.productTitle?.slice(0, 20)}`);
  }

  const byBucket = await prisma.$queryRawUnsafe<{ windowBucket: number; c: number; badViews: number; badSales: number }[]>(
    "SELECT windowBucket, COUNT(*) c, SUM(CASE WHEN views<=10000 THEN 1 ELSE 0 END) badViews, SUM(CASE WHEN sales<10 THEN 1 ELSE 0 END) badSales FROM TrendVideo WHERE sales<10 OR views<=10000 GROUP BY windowBucket"
  );
  console.log('byBucket:', JSON.stringify(byBucket, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}

main().catch(console.error).finally(() => prisma.$disconnect());
