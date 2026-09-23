import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/keys';

// Estado del servidor (solo oficina): confirma que la base de datos responde,
// que las tablas existen y cuántos registros hay de cada tipo.

export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  const t0 = Date.now();
  try {
    const tables = await db.$queryRaw<{ name: string }[]>`
      SELECT table_name AS name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('DistDoc', 'DistCounter')`;
    const byKind = await db.$queryRaw<{ kind: string; total: bigint; deleted: bigint; last: Date | null }[]>`
      SELECT "kind", COUNT(*) AS total, COUNT(*) FILTER (WHERE "deleted") AS deleted, MAX("syncedAt") AS last
      FROM "DistDoc" GROUP BY "kind" ORDER BY "kind"`;
    const counters = await db.distCounter.findMany();
    return NextResponse.json({
      ok: true,
      serverTime: new Date().toISOString(),
      latencyMs: Date.now() - t0,
      tables: tables.map((t) => t.name).sort(),
      kinds: byKind.map((r) => ({ kind: r.kind, total: Number(r.total), deleted: Number(r.deleted), last: r.last })),
      counters: Object.fromEntries(counters.map((c) => [c.name, c.value])),
    });
  } catch (error) {
    console.error('[pedidos/health]', error);
    return NextResponse.json({ ok: false, error: 'La base de datos no responde o faltan tablas' }, { status: 500 });
  }
}
