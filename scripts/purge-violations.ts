import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  // Aturan wajib: sales >= 10 & views > 10.000 (strictly greater, aturan pemilik)
  const before = await prisma.trendVideo.count();
  const bad = await prisma.trendVideo.count({ where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] } });

  const del = await prisma.trendVideo.deleteMany({ where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] } });
  const after = await prisma.trendVideo.count();

  console.log(`total before=${before} violations=${bad} deleted=${del.count} total after=${after}`);

  const recheck = await prisma.trendVideo.count({ where: { OR: [{ sales: { lt: 10 } }, { views: { lte: 10000 } }] } });
  console.log(`recheck violations=${recheck} ${recheck === 0 ? '✓ 100% COMPLIANT' : '✗ STILL VIOLATIONS'}`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
