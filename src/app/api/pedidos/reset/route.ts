import { randomBytes } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/keys';
import { RESET_LOCK } from '@/lib/epoch';

// Reiniciar datos (solo oficina): para empezar de cero después de las pruebas.
//
// POST /api/pedidos/reset
//   body: { mode: 'pedidos' | 'todo', confirm: 'REINICIAR', day, deviceId }
//   pedidos → borra pedidos, hojas de carga, historial y numeración.
//             Conserva catálogo, clientes, vendedores y ajustes.
//   todo    → borra todo; luego se vuelve a cargar el paquete de arranque.
//   resp:   { ok, epoch, deleted }
//
// Cambia la "época": cada equipo, en su próxima sincronización, borra su copia
// local (incluido lo que no había subido de antes del reinicio; lo que hizo
// después, sin señal, se conserva y se sube) y baja todo de nuevo. Mientras dura
// el borrado ninguna sincronización puede escribir (candado exclusivo).

export const dynamic = 'force-dynamic';

const OPS_KINDS = ['orders', 'loads', 'events'];
const ALL_KINDS = ['orders', 'loads', 'events', 'clients', 'products', 'sellers', 'config'];

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: { mode?: unknown; confirm?: unknown; day?: unknown; deviceId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  if (body.confirm !== 'REINICIAR') return NextResponse.json({ error: 'Falta la confirmación' }, { status: 400 });
  if (body.mode !== 'pedidos' && body.mode !== 'todo') return NextResponse.json({ error: 'Modo inválido' }, { status: 400 });
  const all = body.mode === 'todo';
  const epoch = 'e_' + Date.now().toString(36) + randomBytes(4).toString('hex');
  const now = new Date().toISOString();
  // Queda en el Historial (con el día local del equipo que reinició)
  const day = typeof body.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : now.slice(0, 10);
  const event = {
    id: 'ev_reset_' + epoch, at: now, day, type: 'reinicio',
    text: all ? 'Reinició TODOS los datos (se vuelve a cargar el paquete de arranque)' : 'Reinició los datos: pedidos, hojas de carga, historial y numeración',
    sellerId: 'oficina', sellerName: 'Oficina', deviceId: typeof body.deviceId === 'string' ? body.deviceId.slice(0, 120) : '', updatedAt: now,
  };
  try {
    const [, , , del] = await db.$transaction([
      db.$executeRaw`SELECT pg_advisory_xact_lock(${RESET_LOCK})`,
      db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES ('epoch', ${epoch}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`,
      db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES ('epochAt', ${now}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`,
      db.distDoc.deleteMany({ where: { kind: { in: all ? ALL_KINDS : OPS_KINDS } } }),
      db.distCounter.deleteMany({}),
      // Se conservan los ajustes, pero la numeración de cargas y notas vuelve a empezar
      db.$executeRaw`UPDATE "DistDoc" SET
        "data" = jsonb_set(jsonb_set("data"::jsonb, '{counters}', '{"load":0,"note":0}'::jsonb), '{updatedAt}', to_jsonb(${now}::text))::text,
        "updatedAt" = ${now}, "syncedAt" = now()
        WHERE "kind" = 'config'`,
      db.distDoc.create({ data: { kind: 'events', id: event.id, data: JSON.stringify(event), sellerId: 'oficina', routeDate: day, updatedAt: now } }),
    ]);
    return NextResponse.json({ ok: true, epoch, deleted: del.count });
  } catch (error) {
    console.error('[pedidos/reset]', error);
    return NextResponse.json({ error: 'No se pudo reiniciar' }, { status: 500 });
  }
}
