import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireReader } from '@/lib/keys';

// Reporte quincenal (Fase 2 · E5): solo cuenta lo ENTREGADO en hojas LIQUIDADAS
// (liquidación cerrada; cada pedido trae lo entregado en ese cierre). Las hojas
// del período que aún no se liquidan se listan aparte, sin sumarse.
//
// POST /api/pedidos/quincena  body: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
// El día de cada hoja es su fecha de carga/entrega (no el día en que se liquidó):
// una venta del 15 liquidada el 16 cae en la primera quincena.

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_DAYS = 366;

type Line = { code?: string; name?: string; presentation?: string; category?: string; cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number; unitsPerBox?: number };
type VacLine = { code?: string; type?: string; regime?: string; boxes?: number; recv?: number; asg?: number | null; pending?: number; motivo?: string };
type Delivery = { at?: string; date?: string; loadId?: string; result?: string; lines?: Record<string, Line>; monto?: number; motivo?: string; voidedNote?: string; newValery?: string; vac?: Record<string, VacLine> };
type OrderDoc = { id: string; deleted?: boolean; sellerId?: string; sellerName?: string; clientId?: string; clientName?: string; valeryNote?: string; lines?: Record<string, Line>; delivery?: Delivery | null };
type SnapRow = { key?: string; code?: string; name?: string; presentation?: string; um?: string; pedido?: number; entregado?: number; queda?: number; carga?: number; total?: number; debe?: number; dev?: number | null; dif?: number | null; motivo?: string; dest?: string };
type LoadDoc = {
  id: string; deleted?: boolean; number?: number; label?: string; date?: string; closedAt?: string; status?: string; route?: string;
  sellerName?: string; dispatcherId?: string; dispatcherName?: string; totals?: { clients?: number; monto?: number; bultos?: number };
  liq?: { status?: string; closedAt?: string; totals?: { monto?: number }; snapshot?: { rows?: SnapRow[] } } | null;
};

const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => Number(v) || 0;
const lineMoney = (l: Line) => num(l.cajas) * num(l.boxPrice) + num(l.unidades) * num(l.unitPrice);
const loadDay = (l: LoadDoc) => (isDay(l.date) ? l.date : String(l.closedAt || '').slice(0, 10));
const loadCode = (l: LoadDoc) => (l.number ? 'C-' + String(l.number).padStart(5, '0') : '');

function bump<T extends Record<string, unknown>>(m: Map<string, T>, k: string, init: () => T) {
  let x = m.get(k);
  if (!x) { x = init(); m.set(k, x); }
  return x;
}

export async function POST(req: NextRequest) {
  const denied = requireReader(req);
  if (denied) return denied;
  let body: { from?: unknown; to?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const { from, to } = body;
  if (!isDay(from) || !isDay(to) || from > to) return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > MAX_DAYS) return NextResponse.json({ error: `Máximo ${MAX_DAYS} días por consulta` }, { status: 400 });

  try {
    // ---- Hojas del período ----
    const loadRows = await db.distDoc.findMany({ where: { kind: 'loads', deleted: false }, select: { data: true } });
    const allLoads = loadRows.map((r) => JSON.parse(r.data) as LoadDoc).filter((l) => !l.deleted);
    const loadById = new Map(allLoads.map((l) => [l.id, l]));
    const loads = allLoads.filter((l) => l.closedAt || l.liq);
    const inRange = loads.filter((l) => { const d = loadDay(l); return d >= from && d <= to; });
    const liquidated = new Map(inRange.filter((l) => l.liq && l.liq.status === 'cerrada' && l.liq.closedAt).map((l) => [l.id, l]));
    const pendingLoads = inRange.filter((l) => !liquidated.has(l.id)).map((l) => ({
      id: l.id, code: loadCode(l), label: l.label || '', date: loadDay(l), sellerName: l.sellerName || '', dispatcherName: l.dispatcherName || '',
      clients: num(l.totals?.clients), monto: r2(num(l.totals?.monto)), liq: l.liq ? 'borrador' : 'por liquidar',
    })).sort((a, b) => a.date.localeCompare(b.date));

    // ---- Pedidos entregados en esas hojas ----
    const orderRows = liquidated.size
      ? await db.$queryRaw<{ data: string }[]>`SELECT "data" FROM "DistDoc" WHERE "kind" = 'orders' AND "data" LIKE '%"delivery":{%'`
      : [];
    const orders = orderRows.map((r) => JSON.parse(r.data) as OrderDoc).filter((o) => {
      const d = o.delivery, l = d && d.loadId ? liquidated.get(d.loadId) : null;
      return !o.deleted && !!d && !!l && d.at === l.liq!.closedAt;
    });

    // ---- Ventas ----
    const totals = { hojas: liquidated.size, clients: 0, cajas: 0, unidades: 0, monto: 0, pedido: 0, parcial: 0, pendiente: 0, anulada: 0 };
    const byProduct = new Map<string, { pid: string; code: string; name: string; presentation: string; category: string; cajas: number; unidades: number; monto: number }>();
    const byCategory = new Map<string, { category: string; cajas: number; unidades: number; monto: number }>();
    const bySeller = new Map<string, { sellerId: string; sellerName: string; clients: number; cajas: number; unidades: number; monto: number; novedades: number; vacDesp: number; vacRecv: number; vacAsg: number; vacDebe: number }>();
    const byDispatcher = new Map<string, { dispatcherId: string; dispatcherName: string; hojas: number; clients: number; cajas: number; unidades: number; monto: number; diferencias: number; vacDesp: number; vacRecv: number; vacAsg: number; vacDebe: number }>();
    const novedades: unknown[] = [];
    const detail: unknown[] = [];

    for (const l of liquidated.values()) {
      const did = l.dispatcherId || '—';
      bump(byDispatcher, did, () => ({ dispatcherId: did, dispatcherName: l.dispatcherName || 'Sin despachador', hojas: 0, clients: 0, cajas: 0, unidades: 0, monto: 0, diferencias: 0, vacDesp: 0, vacRecv: 0, vacAsg: 0, vacDebe: 0 })).hojas++;
    }

    for (const o of orders) {
      const d = o.delivery!, load = liquidated.get(d.loadId!)!;
      const pedido = Object.values(o.lines || {}).reduce((a, l) => a + lineMoney(l), 0);
      const res = d.result || 'entregada';
      // «Se entrega después» no cuenta aquí: se cuenta cuando se entregue (su copia va en otra hoja)
      if (res !== 'pendiente') totals.pedido += pedido;
      if (res === 'parcial' || res === 'pendiente' || res === 'anulada') {
        totals[res]++;
        novedades.push({ date: loadDay(load), load: loadCode(load), dispatcherName: load.dispatcherName || '', clientName: o.clientName, sellerName: o.sellerName,
          result: res, valeryNote: d.voidedNote || o.valeryNote || '', newValery: d.newValery || '', motivo: d.motivo || '', pedido: r2(pedido), entregado: r2(num(d.monto)) });
      }
      let cajas = 0, unidades = 0, monto = 0;
      for (const [pid, l] of Object.entries(d.lines || {})) {
        const c = num(l.cajas), u = num(l.unidades), m = lineMoney(l);
        if (!c && !u) continue;
        cajas += c; unidades += u; monto += m;
        const p = bump(byProduct, pid, () => ({ pid, code: l.code || pid, name: l.name || '', presentation: l.presentation || '', category: l.category || 'Sin categoría', cajas: 0, unidades: 0, monto: 0 }));
        p.cajas += c; p.unidades += u; p.monto += m;
        const cat = bump(byCategory, l.category || 'Sin categoría', () => ({ category: l.category || 'Sin categoría', cajas: 0, unidades: 0, monto: 0 }));
        cat.cajas += c; cat.unidades += u; cat.monto += m;
      }
      const sid = o.sellerId || '—';
      const s = bump(bySeller, sid, () => ({ sellerId: sid, sellerName: o.sellerName || sid, clients: 0, cajas: 0, unidades: 0, monto: 0, novedades: 0, vacDesp: 0, vacRecv: 0, vacAsg: 0, vacDebe: 0 }));
      if (res !== 'entregada') s.novedades++;
      if (!cajas && !unidades) continue;
      totals.clients++; totals.cajas += cajas; totals.unidades += unidades; totals.monto += monto;
      s.clients++; s.cajas += cajas; s.unidades += unidades; s.monto += monto;
      const dd = byDispatcher.get(load.dispatcherId || '—')!;
      dd.clients++; dd.cajas += cajas; dd.unidades += unidades; dd.monto += monto;
      detail.push({ date: loadDay(load), load: loadCode(load), clientName: o.clientName, sellerName: o.sellerName, dispatcherName: load.dispatcherName || '',
        valeryNote: d.newValery || o.valeryNote || '', result: res, cajas, unidades, monto: r2(monto) });
    }

    // ---- Diferencias de camión y lo que pasó a la siguiente carga ----
    const diferencias: unknown[] = [], siguiente: unknown[] = [];
    let sinFoto = 0;
    for (const l of liquidated.values()) {
      const rows = l.liq?.snapshot?.rows;
      if (!rows) { sinFoto++; continue; }
      for (const r of rows) {
        const base = { date: loadDay(l), load: loadCode(l), label: l.label || '', dispatcherName: l.dispatcherName || '', code: r.code, name: r.name, presentation: r.presentation || '', um: r.um };
        if (r.dif) { diferencias.push({ ...base, debe: r.debe, dev: r.dev, dif: r.dif, motivo: r.motivo || '' }); byDispatcher.get(l.dispatcherId || '—')!.diferencias++; }
        if (r.dest === 'siguiente' && num(r.dev) > 0) siguiente.push({ ...base, qty: r.dev });
      }
    }

    // ---- Vacíos (de lo liquidado) ----
    const vacByCode = new Map<string, { pid: string; code: string; type: string; despachados: number; recibidos: number; asignados: number; debe: number }>();
    const vacByDispatcher = new Map<string, { name: string; type: string; despachados: number; recibidos: number; asignados: number; debe: number }>();
    const vacBySeller = new Map<string, { name: string; type: string; despachados: number; recibidos: number; asignados: number; debe: number }>();
    const add = (x: { despachados: number; recibidos: number; asignados: number; debe: number }, v: VacLine) => {
      x.despachados += num(v.boxes); x.recibidos += num(v.recv); x.asignados += num(v.asg);
      x.debe += Math.max(0, num(v.boxes) - num(v.recv) - num(v.asg));
    };
    for (const o of orders) {
      const d = o.delivery!, load = liquidated.get(d.loadId!)!;
      const sid2 = o.sellerId || '—';
      const sEnt = bump(bySeller, sid2, () => ({ sellerId: sid2, sellerName: o.sellerName || sid2, clients: 0, cajas: 0, unidades: 0, monto: 0, novedades: 0, vacDesp: 0, vacRecv: 0, vacAsg: 0, vacDebe: 0 }));
      const dEnt = byDispatcher.get(load.dispatcherId || '—')!;
      for (const [pid, v] of Object.entries(d.vac || {})) {
        const debe = Math.max(0, num(v.boxes) - num(v.recv) - num(v.asg));
        for (const e of [sEnt, dEnt]) { e.vacDesp += num(v.boxes); e.vacRecv += num(v.recv); e.vacAsg += num(v.asg); e.vacDebe += debe; }
        const type = String(v.type || v.code || pid);
        add(bump(vacByCode, pid, () => ({ pid, code: String(v.code || pid), type, despachados: 0, recibidos: 0, asignados: 0, debe: 0 })), v);
        const dn = load.dispatcherName || 'Sin despachador';
        add(bump(vacByDispatcher, dn + '\u0001' + type, () => ({ name: dn, type, despachados: 0, recibidos: 0, asignados: 0, debe: 0 })), v);
        const sn = o.sellerName || '—';
        add(bump(vacBySeller, sn + '\u0001' + type, () => ({ name: sn, type, despachados: 0, recibidos: 0, asignados: 0, debe: 0 })), v);
      }
    }
    // Devoluciones posteriores registradas en el kardex dentro del período
    const devoluciones: Record<string, number> = {};
    try {
      const movs = await db.distVacMov.findMany({ where: { date: { gte: from, lte: to } } });
      const cancelled = new Set((await db.distVacMov.findMany({ where: { kind: { in: ['anulacion', 'reverso'] } }, select: { refId: true } })).map((m) => m.refId));
      for (const m of movs) if ((m.kind === 'devolucion' || m.kind === 'dev_asignado') && !cancelled.has(m.id)) devoluciones[m.type] = (devoluciones[m.type] || 0) + m.qty;
    } catch (e) { console.warn('[quincena] kardex', e); }

    const money = <T extends { monto: number }>(arr: T[]) => arr.map((x) => ({ ...x, monto: r2(x.monto) }));
    // ---- VENTA EN PROCESO: pedidos del período que todavía no están liquidados ----
    // (enviados, aprobados para carga, en espera y despachados sin liquidar). No suma a nada de lo anterior.
    const STAGES: { key: string; label: string }[] = [
      { key: 'enviado', label: 'Enviados (esperando aprobación)' }, { key: 'en_carga', label: 'Aprobados para carga' },
      { key: 'en_espera', label: 'En espera' }, { key: 'despachado', label: 'Despachados sin liquidar' },
    ];
    const since = new Date(Date.parse(from) - 45 * 86400000).toISOString().slice(0, 10);
    const procRows = await db.distDoc.findMany({
      where: { kind: 'orders', deleted: false, status: { in: STAGES.map((x) => x.key) }, routeDate: { gte: since, lte: to } }, select: { data: true },
    });
    const stage = new Map(STAGES.map((x) => [x.key, { ...x, clients: 0, monto: 0 }]));
    const procSeller = new Map<string, { sellerId: string; sellerName: string; clients: number; monto: number }>();
    const procDisp = new Map<string, { dispatcherId: string; dispatcherName: string; clients: number; monto: number }>();
    for (const r of procRows) {
      const o = JSON.parse(r.data) as OrderDoc & { status?: string; loadId?: string | null; routeDate?: string };
      if (o.deleted) continue;
      const dl = o.delivery, ld = o.loadId ? loadById.get(o.loadId) : null;
      if (dl && dl.loadId && liquidated.get(dl.loadId)?.liq?.closedAt === dl.at) continue; // ya está liquidado
      const day = ld ? loadDay(ld) : String(o.routeDate || '');
      if (day < from || day > to) continue;
      const m = Object.values(o.lines || {}).reduce((a, l) => a + lineMoney(l), 0);
      if (!m) continue;
      const stg = stage.get(String(o.status));
      if (!stg) continue;
      stg.clients++; stg.monto += m;
      const sid = o.sellerId || '—';
      const ps = bump(procSeller, sid, () => ({ sellerId: sid, sellerName: o.sellerName || sid, clients: 0, monto: 0 }));
      ps.clients++; ps.monto += m;
      const did = (ld && ld.dispatcherId) || '—';
      const pd = bump(procDisp, did, () => ({ dispatcherId: did, dispatcherName: (ld && ld.dispatcherName) || 'Sin despachador aún', clients: 0, monto: 0 }));
      pd.clients++; pd.monto += m;
    }
    const enProceso = {
      stages: [...stage.values()].map((x) => ({ ...x, monto: r2(x.monto) })),
      clients: [...stage.values()].reduce((a, x) => a + x.clients, 0),
      monto: r2([...stage.values()].reduce((a, x) => a + x.monto, 0)),
      bySeller: money([...procSeller.values()]), byDispatcher: money([...procDisp.values()]),
    };

    const byType = (arr: { type: string }[]) => [...arr].sort((a, b) => parseFloat(a.type.replace(',', '.')) - parseFloat(b.type.replace(',', '.')) || a.type.localeCompare(b.type));
    return NextResponse.json({
      from, to,
      totals: { ...totals, monto: r2(totals.monto), pedido: r2(totals.pedido) },
      pendingLoads,
      pendingMonto: r2(pendingLoads.reduce((a, l) => a + l.monto, 0)),
      byProduct: money([...byProduct.values()]).sort((a, b) => a.category.localeCompare(b.category, 'es') || a.name.localeCompare(b.name, 'es') || a.code.localeCompare(b.code, 'es', { numeric: true })),
      byCategory: money([...byCategory.values()]).sort((a, b) => b.monto - a.monto),
      bySeller: money([...bySeller.values()]).sort((a, b) => b.monto - a.monto),
      byDispatcher: money([...byDispatcher.values()]).sort((a, b) => b.monto - a.monto),
      enProceso, novedades, diferencias, siguiente, sinFoto,
      vacios: { byCode: byType([...vacByCode.values()]), byDispatcher: byType([...vacByDispatcher.values()]), bySeller: byType([...vacBySeller.values()]), devoluciones },
      detail: detail.sort((a, b) => String((a as { date: string }).date).localeCompare(String((b as { date: string }).date))),
    });
  } catch (error) {
    console.error('[pedidos/quincena]', error);
    return NextResponse.json({ error: 'No se pudo generar el reporte' }, { status: 500 });
  }
}
