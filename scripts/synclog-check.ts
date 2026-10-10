import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const logs = await prisma.$queryRawUnsafe<{ id: string; startedAt: string; finishedAt: string | null; status: string; trigger: string; requests: number; upserted: number }[]>(
    'SELECT id, startedAt, finishedAt, status, trigger, requests, upserted FROM SyncLog ORDER BY startedAt DESC LIMIT 8'
  );
  console.log('=== SyncLog terakhir (8) ===');
  for (const l of logs) {
    console.log(`${l.id.slice(-6)} ${l.startedAt} → ${l.finishedAt ?? 'NULL'} ${l.status} trigger=${l.trigger} req=${l.requests} upserted=${l.upserted}`);
  }
  const states = await prisma.syncState.findMany();
  console.log('=== SyncState ===');
  console.log(JSON.stringify(states, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}

main().catch(console.error).finally(() => prisma.$disconnect());
