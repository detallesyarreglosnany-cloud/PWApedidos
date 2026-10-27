import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { syncOk } from '@/lib/keys';

// Resumen de ventas de UN vendedor (su pantalla «Mi quincena»): solo lectura, con la clave de sincronización
// (igual que el kardex de vacíos del vendedor). Cuenta lo ENTREGADO en hojas con la liquidación CERRADA
// (misma regla que el reporte quincenal de la oficina) y, aparte, lo que está en camino sin liquidar.
// Lo principal son cajas y unidades; el monto va solo como dato secundario.
//
// POST /api/pedidos/mis-ventas  body: { sellerId, from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_DAYS = 366;
type Line = { code?: string; name?: string; presentation?: string; category?: string; cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number };
type Delivery = { at?: string; loadId?: string; lines?: Record<string, Line> };
type OrderDoc = { id: string; deleted?: boolean; sellerId?: string; status?: string; routeDate?: string; loadId?: string | null; clientId?: string; lines?: Record<string, Line>; delivery?: Delivery | null };
type LoadDoc = { id: string; deleted?: boolean; date?: string; closedAt?: string; liq?: { status?: string; closedAt?: string } | null };
type ProdDoc = { id: string; category?: string };

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const num = (v: unknown) => Number(v) || 0;
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const lineMoney = (l: Line) => r2(num(l.cajas) * num(l.boxPrice) + num(l.unidades) * num(l.unitPrice));
const loadDay = (l: LoadDoc) => (isDay(l.date) ? l.date : String(l.closedAt || '').slice(0, 10));
const PROCESO = ['enviado', 'en_carga', 'en_espera', 'despachado'];

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: { sellerId?: unknown; from?: unknown; to?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const sellerId = typeof body.sellerId === 'string' ? body.sellerId.trim().slice(0, 120) : '';
  const { from, to } = body;
  if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
  if (!isDay(from) || !isDay(to) || from > to) return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) return NextResponse.json({ error: `Máximo ${MAX_DAYS} días por consulta` }, { status: 400 });

  try {
    const loadRows = await db.distDoc.findMany({ where: { kind: 'loads', deleted: false }, select: { data: true } });
    const loadById = new Map<string, LoadDoc>();
    for (const r of loadRows) { const l = JSON.parse(r.data) as LoadDoc; if (!l.deleted) loadById.set(l.id, l); }
    const liquidated = new Map<string, LoadDoc>();
    for (const l of loadById.values()) {
      if (l.liq && l.liq.status === 'cerrada' && l.liq.closedAt) { const d = loadDay(l); if (d >= from && d <= to) liquidated.set(l.id, l); }
    }
    const prodRows = await db.distDoc.findMany({ where: { kind: 'products', deleted: false }, select: { data: true } });
    const prodById = new Map(prodRows.map((r) => JSON.parse(r.data) as ProdDoc).map((p) => [p.id, p]));
    const catOf = (pid: string, l: Line) => String(prodById.get(pid)?.category || l.category || 'Sin categoría');

    // Pedidos del vendedor de esas fechas (una venta liquidada puede venir de un pedido de hasta ~2 meses antes)
    const since = new Date(Date.parse(from) - 60 * 86400000).toISOString().slice(0, 10);
    const orderRows = await db.distDoc.findMany({ where: { kind: 'orders', sellerId, deleted: false, routeDate: { gte: since, lte: to } }, select: { data: true } });

    type Acc = { cajas: number; unidades: number; monto: number };
    const byCat = new Map<string, Acc & { category: string }>();
    const byProd = new Map<string, Acc & { pid: string; code: string; name: string; presentation: string; category: string }>();
    const proc = new Map<string, { category: string; cajas: number; unidades: number }>();
    const clients = new Set<string>();
    let cajasT = 0, unidadesT = 0, montoT = 0;

    for (const r of orderRows) {
      const o = JSON.parse(r.data) as OrderDoc;
      if (o.deleted) continue;
      const d = o.delivery;
      const done = !!(d && d.loadId && liquidated.get(d.loadId)?.liq?.closedAt === d.at);
      if (done) {
        let any = false;
        for (const [pid, l] of Object.entries(d!.lines || {})) {
          const c = num(l.cajas), u = num(l.unidades);
          if (!c && !u) continue;
          any = true;
          const m = lineMoney(l), cat = catOf(pid, l);
          const a = byCat.get(cat) || { category: cat, cajas: 0, unidades: 0, monto: 0 }; a.cajas += c; a.unidades += u; a.monto += m; byCat.set(cat, a);
          const p = byProd.get(pid) || { pid, code: l.code || pid, name: l.name || '', presentation: l.presentation || '', category: cat, cajas: 0, unidades: 0, monto: 0 };
          p.cajas += c; p.unidades += u; p.monto += m; byProd.set(pid, p);
          cajasT += c; unidadesT += u; montoT += m;
        }
        if (any) clients.add(String(o.clientId || o.id));
        continue;
      }
      // En camino: enviado / aprobado / despachado y todavía sin liquidar, dentro del período
      if (!PROCESO.includes(String(o.status))) continue;
      if (d && d.loadId && loadById.get(d.loadId)?.liq?.status === 'cerrada' && loadById.get(d.loadId)?.liq?.closedAt === d.at) continue;
      const ld = o.loadId ? loadById.get(o.loadId) : null;
      const day = ld ? loadDay(ld) : String(o.routeDate || '');
      if (day < from || day > to) continue;
      for (const [pid, l] of Object.entries(o.lines || {})) {
        const c = num(l.cajas), u = num(l.unidades);
        if (!c && !u) continue;
        const cat = catOf(pid, l);
        const a = proc.get(cat) || { category: cat, cajas: 0, unidades: 0 }; a.cajas += c; a.unidades += u; proc.set(cat, a);
      }
    }
    const cm = <T extends { monto: number }>(arr: T[]) => arr.map((x) => ({ ...x, monto: r2(x.monto) }));
    return NextResponse.json({
      sellerId, from, to,
      totals: { cajas: cajasT, unidades: unidadesT, monto: r2(montoT), clients: clients.size, hojas: liquidated.size },
      byCategory: cm([...byCat.values()]).sort((a, b) => b.cajas - a.cajas || a.category.localeCompare(b.category, 'es')),
      byProduct: cm([...byProd.values()]).sort((a, b) => a.category.localeCompare(b.category, 'es') || a.name.localeCompare(b.name, 'es') || a.code.localeCompare(b.code, 'es', { numeric: true })),
      enProceso: [...proc.values()].sort((a, b) => b.cajas - a.cajas),
      asOf: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[pedidos/mis-ventas]', error);
    return NextResponse.json({ error: 'No se pudo generar el resumen' }, { status: 500 });
  }
}
