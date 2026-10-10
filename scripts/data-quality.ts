import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const ruleViolations = await prisma.trendVideo.count({ where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] } });
  console.log('ruleViolations (sales<10 OR views<=10K):', ruleViolations);

  const shopLinked = await prisma.trendVideo.count({ where: { shopUrl: { not: null } } });
  console.log('shopLinked:', shopLinked);

  const enrichedCount = await prisma.$queryRawUnsafe<{ c: number }[]>(
    "SELECT COUNT(*) c FROM TrendVideo WHERE productTitle IS NOT NULL AND productTitle != ''"
  );
  console.log('productEnriched:', enrichedCount[0]?.c);

  const countries = await prisma.trendVideo.groupBy({ by: ['country'], _count: true });
  console.log('countries:', countries.length);

  const categories = await prisma.trendVideo.groupBy({ by: ['sourceCategory'], _count: true });
  console.log('sourceCategories:', categories.length);

  const oldest = await prisma.$queryRawUnsafe<{ mn: number }[]>('SELECT MIN(createTimeMax) mn FROM TrendVideo');
  console.log('oldest video posted ~', oldest[0]?.mn ? new Date(Number(oldest[0].mn) * 1000).toISOString() : 'n/a');

  const dbSize = await prisma.$queryRawUnsafe<{ sz: number }[]>('SELECT page_count*page_size sz FROM pragma_page_count(), pragma_page_size()');
  console.log('dbSizeBytes:', dbSize[0]?.sz);
}

main().catch(console.error).finally(() => prisma.$disconnect());
