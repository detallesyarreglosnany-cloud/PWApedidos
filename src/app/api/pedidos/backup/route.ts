import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin } from '@/lib/keys';

// Respaldo completo del servidor (solo oficina), por páginas para no pasar el
// límite de 4,5 MB de Vercel. El equipo arma un archivo con el mismo formato
// que el paquete de arranque, así que se puede restaurar con "Cargar paquete".
//
// POST /api/pedidos/backup  body: { after?: { kind, id } }
// resp: { docs: [{kind, doc}], next: {kind, id} | null, counters }

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const BUDGET = 3 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: { after?: { kind?: string; id?: string } | null };
  try { body = await req.json(); } catch { body = {}; }
  const afterKind = String(body.after?.kind || '');
  const afterId = String(body.after?.id || '');
  try {
    const out: { kind: string; doc: unknown }[] = [];
    let size = 0;
    let cursor = { kind: afterKind, id: afterId };
    for (;;) {
      const rows = await db.distDoc.findMany({
        where: { OR: [{ kind: { gt: cursor.kind } }, { kind: cursor.kind, id: { gt: cursor.id } }] },
        orderBy: [{ kind: 'asc' }, { id: 'asc' }],
        take: 300,
      });
      for (const r of rows) {
        if (size && size + r.data.length > BUDGET) {
          return NextResponse.json({ docs: out, next: cursor });
        }
        out.push({ kind: r.kind, doc: JSON.parse(r.data) });
        size += r.data.length;
        cursor = { kind: r.kind, id: r.id };
      }
      if (rows.length < 300) break;
    }
    const counters = await db.distCounter.findMany();
    return NextResponse.json({ docs: out, next: null, counters: Object.fromEntries(counters.map((c) => [c.name, c.value])) });
  } catch (error) {
    console.error('[pedidos/backup]', error);
    return NextResponse.json({ error: 'No se pudo leer el respaldo' }, { status: 500 });
  }
}
