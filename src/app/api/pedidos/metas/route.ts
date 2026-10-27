import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { syncOk } from '@/lib/keys';
import { sellerAccessOk } from '@/lib/pin';

// Metas de cada vendedor para una quincena (las pone él mismo en su pantalla «Mi quincena»).
// Se guardan en la tabla de ajustes (DistSetting) con el nombre «metas:<vendedor>:<AAAA-MM-Q>»: no tocan pedidos ni catálogo.
//
// POST /api/pedidos/metas  (clave de sincronización)
//   { action: 'get', sellerId, period }                → { goals: [{ category, target }] }
//   { action: 'set', sellerId, period, goals: [...] }  → { goals }       (reemplaza las metas de esa quincena)
// period = AAAA-MM-1 (días 1-15) o AAAA-MM-2 (16-fin). target = cajas.

export const dynamic = 'force-dynamic';

const MAX_GOALS = 40;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isPeriod = (s: string) => /^\d{4}-(0[1-9]|1[0-2])-[12]$/.test(s);

type Goal = { category: string; target: number };

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const sellerId = str(body.sellerId, 120), period = str(body.period, 10);
  if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
  // Vendedor con PIN: solo desde un teléfono de confianza (sin PIN, todo sigue igual)
  if (!(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
  if (!isPeriod(period)) return NextResponse.json({ error: 'Quincena inválida' }, { status: 400 });
  const name = `metas:${sellerId}:${period}`;
  try {
    if (body.action === 'get') {
      const r = await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "DistSetting" WHERE "name" = ${name}`;
      const goals = r[0] ? ((JSON.parse(r[0].value) as { goals?: Goal[] }).goals || []) : [];
      return NextResponse.json({ goals }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body.action === 'set') {
      if (!Array.isArray(body.goals) || body.goals.length > MAX_GOALS) return NextResponse.json({ error: 'Metas inválidas' }, { status: 400 });
      const seen = new Set<string>(), goals: Goal[] = [];
      for (const g of body.goals as Record<string, unknown>[]) {
        const category = str(g && g.category, 60), target = Math.round(Number(g && g.target));
        if (!category || !Number.isFinite(target) || target < 1 || target > 1_000_000) return NextResponse.json({ error: 'Cada meta necesita categoría y una cantidad de cajas entre 1 y 1.000.000' }, { status: 400 });
        if (seen.has(category)) continue;
        seen.add(category); goals.push({ category, target });
      }
      const value = JSON.stringify({ goals, updatedAt: new Date().toISOString() });
      await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${name}, ${value}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
      return NextResponse.json({ goals });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/metas]', error);
    return NextResponse.json({ error: 'No se pudo guardar' }, { status: 500 });
  }
}
