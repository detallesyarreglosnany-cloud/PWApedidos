import { NextRequest, NextResponse } from 'next/server';
import { db, TX_WAIT } from '@/lib/db';
import type { Prisma } from '@prisma/client';
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

type Tx = Prisma.TransactionClient;

const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

// Solo numera si los datos no se reiniciaron (época comprobada dentro de la
// misma transacción que el candado del reinicio: nunca revive la numeración vieja)
const takeSql = (tx: Tx, name: string, count: number, floor: number, epoch: string) => tx.$queryRaw<{ value: number }[]>`
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
    const { current, loadRow, noteRow } = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(${RESET_LOCK})`;
      const [cur] = await tx.$queryRaw<{ value: string }[]>`SELECT COALESCE((SELECT "value" FROM "DistSetting" WHERE "name" = 'epoch'), '') AS "value"`;
      const loadRow = loadCount ? (await takeSql(tx, 'load', 1, int(body.floor?.load), epoch))[0] : undefined;
      const noteRow = noteCount ? (await takeSql(tx, 'note', noteCount, int(body.floor?.note), epoch))[0] : undefined;
      return { current: cur.value, loadRow, noteRow };
    }, TX_WAIT);
    // Un equipo que aún no se enteró de un reinicio traería la numeración vieja (y no se tomó nada)
    if (current !== epoch) {
      return NextResponse.json({ error: 'Se reiniciaron los datos: espera unos segundos a que el equipo se actualice' }, { status: 409 });
    }
    const load = loadRow ? range(loadRow, 1)[0] : null;
    const notes = noteRow ? range(noteRow, noteCount) : [];
    return NextResponse.json({ load, notes });
  } catch (error) {
    console.error('[pedidos/numbers]', error);
    return NextResponse.json({ error: 'No se pudo reservar la numeración' }, { status: 500 });
  }
}
