import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireReader } from '@/lib/keys';

// Reporte de ventas por rango de fechas (oficina o supervisor, sin límite de
// los 14 días que guarda cada teléfono): totales y desglose por vendedor,
// por despachador/ruta y por categoría, más el detalle de cada pedido.
//
// POST /api/pedidos/report  body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_DAYS = 366;
const MAX_ORDERS = 6000;

type Line = { category?: string; cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number };
type OrderDoc = {
  id: string; sellerId?: string; sellerName?: string; clientId?: string; clientName?: string; route?: string;
  routeDate?: string; status?: string; loadId?: string | null; lines?: Record<string, Line>; deleted?: boolean;
};
type LoadDoc = { id: string; dispatcherId?: string; dispatcherName?: string; route?: string };

function isValidDay(s: unknown): s is string {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function orderTotals(o: OrderDoc) {
  let cajas = 0, unidades = 0, monto = 0, items = 0;
  for (const l of Object.values(o.lines || {})) {
    cajas += +(l.cajas || 0);
    unidades += +(l.unidades || 0);
    monto += +(l.cajas || 0) * +(l.boxPrice || 0) + +(l.unidades || 0) * +(l.unitPrice || 0);
    if (l.cajas || l.unidades) items++;
  }
  return { cajas, unidades, monto: Math.round(monto * 100) / 100, items };
}

export async function POST(req: NextRequest) {
  const denied = requireReader(req);
  if (denied) return denied;
  let body: { from?: unknown; to?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const from = body.from, to = body.to;
  if (!isValidDay(from) || !isValidDay(to) || from > to) {
    return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 });
  }
  const days = (Date.parse(to) - Date.parse(from)) / 86400000;
  if (days > MAX_DAYS) return NextResponse.json({ error: `Máximo ${MAX_DAYS} días por consulta` }, { status: 400 });

  try {
    const rows = await db.distDoc.findMany({
      where: { kind: 'orders', deleted: false, status: { in: ['enviado', 'en_carga', 'en_espera', 'despachado'] }, routeDate: { gte: from, lte: to } },
      take: MAX_ORDERS,
    });
    const orders = rows.map((r) => JSON.parse(r.data) as OrderDoc).filter((o) => !o.deleted);
    const loadIds = [...new Set(orders.map((o) => o.loadId).filter(Boolean))] as string[];
    const loadRows = loadIds.length ? await db.distDoc.findMany({ where: { kind: 'loads', id: { in: loadIds } } }) : [];
    const loadsById = new Map(loadRows.map((r) => [r.id, JSON.parse(r.data) as LoadDoc]));

    const totals = { clients: 0, cajas: 0, unidades: 0, monto: 0 };
    const bySeller = new Map<string, { sellerId: string; sellerName: string; clients: number; cajas: number; unidades: number; monto: number }>();
    const byDispatcher = new Map<string, { dispatcherId: string; dispatcherName: string; clients: number; cajas: number; unidades: number; monto: number }>();
    const byCategory = new Map<string, { category: string; cajas: number; unidades: number; monto: number }>();
    const byDay = new Map<string, { day: string; clients: number; monto: number }>();
    const detail: unknown[] = [];

    for (const o of orders) {
      const t = orderTotals(o);
      if (!t.items) continue;
      totals.clients++; totals.cajas += t.cajas; totals.unidades += t.unidades; totals.monto += t.monto;

      const sid = o.sellerId || '—';
      const s = bySeller.get(sid) || { sellerId: sid, sellerName: o.sellerName || sid, clients: 0, cajas: 0, unidades: 0, monto: 0 };
      s.clients++; s.cajas += t.cajas; s.unidades += t.unidades; s.monto += t.monto; bySeller.set(sid, s);

      const load = o.loadId ? loadsById.get(o.loadId) : null;
      const did = (load && load.dispatcherId) || '—';
      const dname = (load && load.dispatcherName) || 'Sin despachador aún';
      const d = byDispatcher.get(did) || { dispatcherId: did, dispatcherName: dname, clients: 0, cajas: 0, unidades: 0, monto: 0 };
      d.clients++; d.cajas += t.cajas; d.unidades += t.unidades; d.monto += t.monto; byDispatcher.set(did, d);

      const day = byDay.get(o.routeDate || '') || { day: o.routeDate || '', clients: 0, monto: 0 };
      day.clients++; day.monto += t.monto; byDay.set(o.routeDate || '', day);

      for (const l of Object.values(o.lines || {})) {
        if (!l.cajas && !l.unidades) continue;
        const cat = l.category || 'Sin categoría';
        const c = byCategory.get(cat) || { category: cat, cajas: 0, unidades: 0, monto: 0 };
        c.cajas += +(l.cajas || 0); c.unidades += +(l.unidades || 0);
        c.monto += +(l.cajas || 0) * +(l.boxPrice || 0) + +(l.unidades || 0) * +(l.unitPrice || 0);
        byCategory.set(cat, c);
      }

      detail.push({
        day: o.routeDate, clientName: o.clientName, sellerId: sid, sellerName: o.sellerName,
        route: o.route, dispatcherName: dname, status: o.status,
        cajas: t.cajas, unidades: t.unidades, monto: t.monto,
      });
    }

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const finish = (m: Map<string, Record<string, number | string>>) =>
      [...m.values()].map((x) => ({ ...x, monto: round2(Number(x.monto)) })).sort((a, b) => Number(b.monto) - Number(a.monto));

    return NextResponse.json({
      from, to,
      totals: { ...totals, monto: round2(totals.monto) },
      bySeller: finish(bySeller as unknown as Map<string, Record<string, number | string>>),
      byDispatcher: finish(byDispatcher as unknown as Map<string, Record<string, number | string>>),
      byCategory: finish(byCategory as unknown as Map<string, Record<string, number | string>>),
      byDay: [...byDay.values()].map((x) => ({ ...x, monto: round2(x.monto) })).sort((a, b) => a.day.localeCompare(b.day)),
      detail: detail.sort((a, b) => String((a as { day?: string }).day).localeCompare(String((b as { day?: string }).day))),
      truncated: rows.length >= MAX_ORDERS,
    });
  } catch (error) {
    console.error('[pedidos/report]', error);
    return NextResponse.json({ error: 'No se pudo generar el reporte' }, { status: 500 });
  }
}
