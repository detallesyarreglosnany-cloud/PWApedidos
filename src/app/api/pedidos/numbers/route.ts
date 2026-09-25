import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/keys';
import { RESET_LOCK } from '@/lib/epoch';

// Reserva de números de carga y de notas de entrega (solo oficina).
//
// POST /api/pedidos/numbers
//   headers: x-sync-key, x-admin-key
//   body:    { load: 0|1, note: n, floor: { load, note }, epoch }
//   resp:    { load: number|null, notes: number[] }
//
// Un UPDATE … RETURNING atómico por contador: aunque dos PCs cierren cargas a
// la vez, cada número se entrega una sola vez. `floor` es el mayor número que
// ya conoce el equipo: el contador nunca queda por debajo (migración inicial).

export const dynamic = 'force-dynamic';

const MAX_NOTES = 500;

const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

// Solo numera si los datos no se reiniciaron (época comprobada dentro de la
// misma transacción que el candado del reinicio: nunca revive la numeración vieja)
const takeSql = (name: string, count: number, floor: number, epoch: string) => db.$queryRaw<{ value: number }[]>`
    INSERT INTO "DistCounter" ("name", "value")
    SELECT ${name}, ${floor + count}
    WHERE COALESCE((SELECT "value" FROM "DistSetting" WHERE "name" = 'epoch'), '') = ${epoch}
    ON CONFLICT ("name") DO UPDATE SET "value" = GREATEST("DistCounter"."value", ${floor}) + ${count}
    RETURNING "value"`;
const range = (row: { value: number }, count: number) => Array.from({ length: count }, (_, i) => Number(row.value) - count + 1 + i);

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: { load?: unknown; note?: unknown; floor?: { load?: unknown; note?: unknown }; epoch?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const loadCount = Math.min(int(body.load), 1);
  const noteCount = int(body.note);
  if (noteCount > MAX_NOTES) return NextResponse.json({ error: 'Demasiadas notas' }, { status: 400 });
  try {
    const epoch = typeof body.epoch === 'string' ? body.epoch : '';
    const [, current, ...taken] = await db.$transaction([
      db.$executeRaw`SELECT pg_advisory_xact_lock_shared(${RESET_LOCK})`,
      db.$queryRaw<{ value: string }[]>`SELECT COALESCE((SELECT "value" FROM "DistSetting" WHERE "name" = 'epoch'), '') AS "value"`,
      ...(loadCount ? [takeSql('load', 1, int(body.floor?.load), epoch)] : []),
      ...(noteCount ? [takeSql('note', noteCount, int(body.floor?.note), epoch)] : []),
    ]);
    // Un equipo que aún no se enteró de un reinicio traería la numeración vieja (y no se tomó nada)
    if (current[0].value !== epoch) {
      return NextResponse.json({ error: 'Se reiniciaron los datos: espera unos segundos a que el equipo se actualice' }, { status: 409 });
    }
    const rows = taken as { value: number }[][];
    const load = loadCount ? range(rows[0][0], 1)[0] : null;
    const notes = noteCount ? range(rows[loadCount ? 1 : 0][0], noteCount) : [];
    return NextResponse.json({ load, notes });
  } catch (error) {
    console.error('[pedidos/numbers]', error);
    return NextResponse.json({ error: 'No se pudo reservar la numeración' }, { status: 500 });
  }
}
