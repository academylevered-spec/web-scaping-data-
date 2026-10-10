import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const J = (v: any) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x));
async function main() {
  const total = await prisma.trendVideo.count();
  console.log('total:', total);

  const buckets = await prisma.$queryRawUnsafe<{ windowBucket: number; c: number }[]>(
    'SELECT windowBucket, COUNT(*) c FROM TrendVideo GROUP BY windowBucket ORDER BY windowBucket'
  );
  console.log('buckets:', J(buckets));

  const cols = await prisma.$queryRawUnsafe<{ name: string }[]>("PRAGMA table_info(TrendVideo)");
  console.log('columns:', cols.map(c => c.name).join(','));

  const unenriched = await prisma.$queryRawUnsafe<{ c: number }[]>(
    "SELECT COUNT(*) c FROM TrendVideo WHERE productTitle IS NULL AND shopUrl IS NOT NULL AND shopUrl != ''"
  );
  console.log('unenriched:', J(unenriched));

  const dead = await prisma.trendVideo.count({ where: { productTitle: '' } });
  console.log('deadSentinel:', dead);

  const zombies = await prisma.$queryRawUnsafe<{ c: number }[]>(`SELECT COUNT(*) c FROM SyncLog WHERE status='running'`);
  console.log('zombieSyncLog:', J(zombies));

  const states = await prisma.syncState.findMany({ select: { id: true, status: true, lastSyncAt: true } });
  console.log('syncState:', J(states));

  const logs = await prisma.syncLog.findMany({ orderBy: { id: 'desc' }, take: 4, select: { id: true, status: true, trigger: true, videos: true, startedAt: true } });
  console.log('recentSyncLog:', J(logs));

  const range = await prisma.$queryRawUnsafe<{ mx: number; mn: number }[]>(`SELECT MAX(createTimeMax) mx, MIN(createTimeMin) mn FROM TrendVideo`);
  if (range[0]?.mx) {
    console.log('createTime range:', new Date(range[0].mx * 1000).toISOString(), '←→', new Date(range[0].mn * 1000).toISOString());
  }

  const ruleViolations = await prisma.trendVideo.count({ where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] } });
  console.log('ruleViolations (sales<10 OR views<=10K):', ruleViolations);

  const shopLinked = await prisma.trendVideo.count({ where: { shopUrl: { not: null } } });
  console.log('shopLinked:', shopLinked);
}

main().catch(console.error).finally(() => prisma.$disconnect());
