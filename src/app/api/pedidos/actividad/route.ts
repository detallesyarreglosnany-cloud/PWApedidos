import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { syncOk } from '@/lib/keys';

// Actividad de compra de los clientes de UN vendedor: fecha del último pedido y cuántos pedidos ha hecho.
// El teléfono solo guarda los pedidos de las últimas semanas, así que esto se pregunta al servidor.
// Solo lectura, con la clave de sincronización (igual que el kardex de vacíos del vendedor).
//
// POST /api/pedidos/actividad  body: { sellerId }
//   → { byClient: { <clientId>: { last: 'AAAA-MM-DD', n: <pedidos enviados> } }, asOf }
// Cuenta pedidos que el vendedor ya envió a la oficina (enviado, en carga, en espera o despachado) de cualquier vendedor
// (un cliente que cambió de vendedor conserva su historial). Un cliente sin pedidos no aparece.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: { sellerId?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const sellerId = typeof body.sellerId === 'string' ? body.sellerId.trim().slice(0, 120) : '';
  if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
  try {
    const ids = (await db.distDoc.findMany({ where: { kind: 'clients', sellerId, deleted: false }, select: { id: true } })).map((r) => r.id);
    if (!ids.length) return NextResponse.json({ byClient: {}, asOf: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
    const rows = await db.$queryRaw<{ cid: string; last: string; n: bigint }[]>`
      SELECT ("data"::jsonb ->> 'clientId') AS cid, MAX("routeDate") AS last, COUNT(*) AS n
      FROM "DistDoc"
      WHERE "kind" = 'orders' AND "deleted" = false AND "status" IN ('enviado', 'en_carga', 'en_espera', 'despachado')
        AND ("data"::jsonb ->> 'clientId') = ANY(${ids})
      GROUP BY 1`;
    const byClient: Record<string, { last: string; n: number }> = {};
    for (const r of rows) if (r.cid && r.last) byClient[r.cid] = { last: String(r.last), n: Number(r.n) };
    return NextResponse.json({ byClient, asOf: new Date().toISOString() }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[pedidos/actividad]', error);
    return NextResponse.json({ error: 'No se pudo consultar' }, { status: 500 });
  }
}
