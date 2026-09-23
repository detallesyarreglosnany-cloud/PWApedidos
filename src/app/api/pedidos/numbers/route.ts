import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/keys';

// Reserva de números de carga y de notas de entrega (solo oficina).
//
// POST /api/pedidos/numbers
//   headers: x-sync-key, x-admin-key
//   body:    { load: 0|1, note: n, floor: { load, note } }
//   resp:    { load: number|null, notes: number[] }
//
// Un UPDATE … RETURNING atómico por contador: aunque dos PCs cierren cargas a
// la vez, cada número se entrega una sola vez. `floor` es el mayor número que
// ya conoce el equipo: el contador nunca queda por debajo (migración inicial).

export const dynamic = 'force-dynamic';

const MAX_NOTES = 500;

const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

async function take(name: string, count: number, floor: number) {
  const [row] = await db.$queryRaw<{ value: number }[]>`
    INSERT INTO "DistCounter" ("name", "value") VALUES (${name}, ${floor + count})
    ON CONFLICT ("name") DO UPDATE SET "value" = GREATEST("DistCounter"."value", ${floor}) + ${count}
    RETURNING "value"`;
  const last = Number(row.value);
  return Array.from({ length: count }, (_, i) => last - count + 1 + i);
}

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: { load?: unknown; note?: unknown; floor?: { load?: unknown; note?: unknown } };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const loadCount = Math.min(int(body.load), 1);
  const noteCount = int(body.note);
  if (noteCount > MAX_NOTES) return NextResponse.json({ error: 'Demasiadas notas' }, { status: 400 });
  try {
    const load = loadCount ? (await take('load', 1, int(body.floor?.load)))[0] : null;
    const notes = noteCount ? await take('note', noteCount, int(body.floor?.note)) : [];
    return NextResponse.json({ load, notes });
  } catch (error) {
    console.error('[pedidos/numbers]', error);
    return NextResponse.json({ error: 'No se pudo reservar la numeración' }, { status: 500 });
  }
}
