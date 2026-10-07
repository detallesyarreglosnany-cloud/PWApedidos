import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireReader } from '@/lib/keys';
import { currentEpoch } from '@/lib/epoch';

// Diagnóstico de sincronización (oficina o supervisor).
//
// POST /api/pedidos/estado → { serverTime, epoch, docs: { <kind>: [[id, updatedAt, borrado 0|1], ...] } }
//   Solo ids y versiones (nada del contenido): el equipo compara con su copia y
//   ve qué le falta al servidor y qué le falta a él.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config'];

export async function POST(req: NextRequest) {
  const bad = requireReader(req);
  if (bad) return bad;
  try {
    const rows = await db.distDoc.findMany({ where: { kind: { in: KINDS } }, select: { kind: true, id: true, updatedAt: true, deleted: true } });
    const docs: Record<string, [string, string, number][]> = Object.fromEntries(KINDS.map((k) => [k, []]));
    for (const r of rows) docs[r.kind].push([r.id, r.updatedAt, r.deleted ? 1 : 0]);
    return NextResponse.json({ serverTime: new Date().toISOString(), epoch: await currentEpoch(), docs });
  } catch (error) {
    console.error('[pedidos/estado]', error);
    return NextResponse.json({ error: 'No se pudo leer el estado del servidor' }, { status: 500 });
  }
}
