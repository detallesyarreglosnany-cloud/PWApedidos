import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isAdminReq, isSupervisorReq, requireAdmin, syncOk } from '@/lib/keys';
import { sellerAccessOk } from '@/lib/pin';
import { SEGUIMIENTO, credInfo, diffDays, rulesOf, tramos, vzDay, type CredInfo, type CredSetting } from '@/lib/cobranza';
import { sendPush } from '@/lib/push';
import { createHash } from 'crypto';
import { METHODS, allocate, cleanPago, normRef, noteKey, notaNum, noteStatus, r2, type Pago } from '@/lib/pagos';

// Pagos de clientes (Fase 4 · cobranza).
// POST /api/pedidos/pagos
//   Vendedor (clave de sync; con PIN, desde su teléfono de confianza) u oficina:
//     { action: 'create', pago }                 → { pago }   la referencia no se puede repetir (409 si ya existe)
//     { action: 'mine', sellerId, from, to }      → { pagos }
//     { action: 'saldo', orderIds }               → { byOrder: { id: { pagado, aprobado } } }   lo abonado a cada nota
//     { action: 'anular', id, sellerId }          → { pago }   solo si cobranza aún no lo verificó; libera las referencias
//     { action: 'cuenta', clientId, sellerId }    → { notas, deuda, enEspera }  estado de cuenta: cada nota del cliente con su estado de pago
//     { action: 'estado', notas: [{ nota, orderId, monto }] } → { byKey: { 'n:85643': { estado, texto, resta, ... } } }
//     { action: 'cartera', sellerId? }            → { notas, alDia, hoy }  cuentas por cobrar con vencimientos (sin sellerId: todos, solo oficina)
//     { action: 'creditos', sellerId? }           → { clientes }  récord y crédito de cada cliente (oficina o supervisor)
//     { action: 'credito', clientId, modo, limite, nota } → { ok }  cobranza fija contado/crédito y límite (solo oficina)
//     { action: 'importCobro', rows }             → { added }  restaurar crédito y seguimientos de un respaldo
//     { action: 'seguir', sellerId, clientId, key, nota, estado, comentario } → { ok }  seguimiento de cobro (le llega a la oficina)
//   Oficina / supervisor (lectura):
//     { action: 'list', from, to, sellerId?, status? } → { pagos }
//   Oficina (cobranza):
//     { action: 'review', id, status: 'aprobado' | 'rechazado', motivo? } → { pago }  (rechazado libera las referencias)
//     { action: 'reabrir', id }                   → { pago }   vuelve a «en espera de cobranza»
//     { action: 'import', pagos }                 → { added }  restaurar un respaldo
//     { action: 'importar', rows }                → { creados, repetidos, conciliados, errores }  pagos de FileMaker (Excel/CSV)
// Listas por fecha: by = 'subido' (día en que se subió, hora de Venezuela) o 'pago' (fecha del pago). status 'espera' + all: todos los pendientes.

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_LIST = 5000;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const NO_STORE = { 'Cache-Control': 'no-store' };
const parse = (r: { data: string; createdAt?: Date }) => { const p = JSON.parse(r.data) as Pago; if (r.createdAt && !p.createdAt) p.createdAt = r.createdAt.toISOString(); return p; };
const LIVE = ['espera', 'aprobado'];
// Día de Venezuela (UTC−4, sin horario de verano) → rango en UTC para createdAt
const vzRange = (from: string, to: string) => ({ gte: new Date(from + 'T04:00:00.000Z'), lt: new Date(Date.parse(to + 'T04:00:00.000Z') + 86400000) });
function dateWhere(body: Record<string, unknown>) {
  if (body.status === 'espera' && body.all === true) return {};
  if (!isDay(body.from) || !isDay(body.to)) return null;
  return body.by === 'subido' ? { createdAt: vzRange(body.from, body.to) } : { date: { gte: body.from, lte: body.to } };
}

async function setStatus(p: Pago, status: string, review: Pago['review'], tx: Prisma.TransactionClient) {
  const next = { ...p, status, review };
  await tx.distPago.update({ where: { id: p.id }, data: { status, data: JSON.stringify(next) } });
  return next;
}
async function conflictOf(ref: string) {
  const r = await db.distPagoRef.findUnique({ where: { ref } });
  const p = r ? await db.distPago.findUnique({ where: { id: r.pagoId } }) : null;
  const x = p ? parse(p) : null;
  return x ? { ref, pagoId: x.id, clientName: x.clientName, sellerName: x.sellerName, date: x.date, status: x.status } : { ref };
}

type Line = { category?: string; cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number };
type Ord = { id: string; deleted?: boolean; status?: string; clientId?: string; clientName?: string; sellerId?: string; sellerName?: string; routeDate?: string; valeryNote?: string; dispatchedAt?: string; loadId?: string | null;
  lines?: Record<string, Line>; delivery?: { at?: string; result?: string; monto?: number; newValery?: string; lines?: Record<string, Line>; dispatcherName?: string } | null };
type Cli = { id: string; name?: string; sellerId?: string; source?: string; createdAt?: string; deleted?: boolean };
type Nota = ReturnType<typeof noteStatus> & { clientId: string; clientName: string; sellerId: string; sellerName: string; orderId: string; nota: string; key: string; monto: number; resta: number;
  pagado: number; espera: number; despacho: string; vence: string; dias: number; tramos: ReturnType<typeof tramos>; liquidado: boolean; seg: unknown };
const money = (l: Line) => r2((Number(l.cajas) || 0) * (Number(l.boxPrice) || 0) + (Number(l.unidades) || 0) * (Number(l.unitPrice) || 0));
/** Cuentas por cobrar con vencimientos y el crédito de cada cliente (de un vendedor o de todos). */
async function cartera(sellerId: string) {
  const hoy = vzDay(new Date().toISOString()), since = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const cfgRow = await db.distDoc.findUnique({ where: { kind_id: { kind: 'config', id: 'main' } }, select: { data: true } });
  const R = rulesOf(cfgRow ? JSON.parse(cfgRow.data) : null);
  const prodRows = await db.distDoc.findMany({ where: { kind: 'products', deleted: false }, select: { data: true } });
  const catOf = new Map(prodRows.map((r) => { const x = JSON.parse(r.data) as { id: string; category?: string }; return [x.id, String(x.category || '')]; }));
  const crows = await db.distDoc.findMany({ where: { kind: 'clients', deleted: false, ...(sellerId ? { sellerId } : {}) }, select: { data: true } });
  const clients = new Map(crows.map((r) => { const c = JSON.parse(r.data) as Cli; return [c.id, c]; }));
  const orows = await db.distDoc.findMany({ where: { kind: 'orders', deleted: false, status: 'despachado', routeDate: { gte: since }, ...(sellerId ? { sellerId } : {}) }, select: { data: true } });
  const orders = orows.map((r) => JSON.parse(r.data) as Ord).filter((o) => !o.deleted && o.clientId && !(o.delivery && o.delivery.at && o.delivery.result === 'anulada'));
  const clientIds = [...new Set(orders.map((o) => String(o.clientId)))];
  const pagos = clientIds.length ? (await db.distPago.findMany({ where: { clientId: { in: clientIds }, status: { in: LIVE } } })).map(parse) : [];
  const ab = allocate(pagos);
  const segRows = await db.$queryRaw<{ name: string; value: string }[]>`SELECT "name", "value" FROM "DistSetting" WHERE "name" LIKE 'seg:%'`;
  const seg = new Map(segRows.map((r) => [r.name.slice(4), JSON.parse(r.value)]));
  const credRows = await db.$queryRaw<{ name: string; value: string }[]>`SELECT "name", "value" FROM "DistSetting" WHERE "name" LIKE 'cred:%'`;
  const sets = new Map(credRows.map((r) => [r.name.slice(5), JSON.parse(r.value) as CredSetting]));
  // Por cliente: compras (para clientes nuevos), deuda, atraso y cuándo terminó de pagar cada nota
  type Agg = { compras: { day: string; monto: number }[]; deuda: number; vencido: number; atrasoMax: number; atrasos: number[]; name: string; sellerId: string; sellerName: string };
  const agg = new Map<string, Agg>();
  const aggOf = (o: Ord) => { const k = String(o.clientId); let x = agg.get(k); if (!x) agg.set(k, (x = { compras: [], deuda: 0, vencido: 0, atrasoMax: 0, atrasos: [], name: String(o.clientName || ''), sellerId: String(o.sellerId || ''), sellerName: String(o.sellerName || '') })); return x; };
  const notas: Nota[] = []; const conDeuda = new Set<string>(), pagaron = new Set<string>(), cerradas: { key: string; monto: number; vence: string; x: Agg }[] = [];
  for (const o of orders) {
    const d = o.delivery && o.delivery.at ? o.delivery : null;
    const src = (d ? d.lines : o.lines) || {};
    const lines = Object.entries(src).map(([pid, l]) => ({ category: catOf.get(pid) || String(l.category || ''), monto: money(l) })).filter((l) => l.monto > 0);
    const monto = d ? r2(Number(d.monto) || 0) : r2(lines.reduce((a, l) => a + l.monto, 0));
    if (!(monto > 0)) continue;
    const start = vzDay(o.dispatchedAt || (d && d.at) || '') || String(o.routeDate || '');
    const x = aggOf(o); x.compras.push({ day: start, monto });
    if (start < R.desde) continue;
    // Si lo entregado no cuadra con las líneas (redondeos), manda el monto de la nota
    const sum = r2(lines.reduce((a, l) => a + l.monto, 0)); if (sum > 0 && Math.abs(sum - monto) > 0.01) lines.forEach((l) => { l.monto = r2((l.monto * monto) / sum); });
    const nota = notaNum((d && d.newValery) || o.valeryNote), key = noteKey({ nota, orderId: o.id }), a = ab.get(key);
    const tr = tramos(lines, start, R, a ? a.pagado : 0), resta = r2(tr.reduce((q, t) => q + t.resta, 0));
    if (resta <= 0.01) { pagaron.add(String(o.clientId)); cerradas.push({ key, monto, vence: tr[tr.length - 1].vence, x }); continue; }
    conDeuda.add(String(o.clientId));
    const next = tr.find((t) => t.resta > 0.01)!, dias = diffDays(hoy, next.vence);
    x.deuda += resta; if (dias < 0) { x.vencido += tr.filter((t) => t.vence < hoy).reduce((q, t) => q + t.resta, 0); x.atrasoMax = Math.max(x.atrasoMax, -dias); }
    notas.push({ ...noteStatus(monto, a), clientId: String(o.clientId), clientName: String(o.clientName || ''), sellerId: String(o.sellerId || ''), sellerName: String(o.sellerName || ''), orderId: o.id, nota, key, monto, resta,
      pagado: a ? a.pagado : 0, espera: a ? a.espera : 0, despacho: start, vence: next.vence, dias, tramos: tr, liquidado: !!d, seg: seg.get(`${o.clientId}:${key}`) || null });
  }
  notas.sort((x, y) => x.dias - y.dias);
  // Día en que cada nota quedó pagada completa (fecha real del pago) → días de atraso del récord
  if (cerradas.length) {
    const montoOf = new Map(cerradas.map((c) => [c.key, c.monto])), cum = new Map<string, number>(), done = new Map<string, string>();
    for (const p of pagos.slice().sort((a, b) => a.date.localeCompare(b.date) || String(a.createdAt).localeCompare(String(b.createdAt)))) {
      let left = r2(p.pagado + p.ajustes);
      p.notas.forEach((n, i) => {
        const take = r2(i === p.notas.length - 1 ? left : Math.min(left, n.monto)); left = r2(left - take);
        const k = noteKey(n), m = montoOf.get(k); if (m === undefined || done.has(k)) return;
        const c = r2((cum.get(k) || 0) + take); cum.set(k, c); if (c >= m - 0.01) done.set(k, p.date);
      });
    }
    for (const c of cerradas) { const d = done.get(c.key); if (d) c.x.atrasos.push(Math.max(0, diffDays(c.vence, d))); }
  }
  // Crédito por cliente: los que compraron, los que tienen algo fijado por cobranza y los nuevos
  const ids = new Set<string>([...agg.keys(), ...[...sets.keys()].filter((k) => !sellerId || clients.has(k)), ...[...clients.values()].filter((c) => isNuevo(c, R)).map((c) => c.id)]);
  const credito: Record<string, CredInfo> = {}, lista: (CredInfo & { clientId: string; clientName: string; sellerId: string; sellerName: string })[] = [];
  for (const id of ids) {
    const c = clients.get(id), x = agg.get(id);
    const info = credInfo({ R, set: sets.get(id) || null, nuevoCliente: !!c && isNuevo(c, R), compras: x ? x.compras.sort((a, b) => a.day.localeCompare(b.day)).map((q) => q.monto) : [],
      deuda: x ? x.deuda : 0, vencido: x ? x.vencido : 0, atrasoMax: x ? x.atrasoMax : 0, atrasos: x ? x.atrasos : [] });
    credito[id] = info;
    lista.push({ ...info, clientId: id, clientName: (c && c.name) || (x && x.name) || id, sellerId: (c && c.sellerId) || (x && x.sellerId) || '', sellerName: (x && x.sellerName) || '' });
  }
  return { hoy, R, notas, alDia: [...pagaron].filter((c) => !conDeuda.has(c)), credito, clientes: lista };
}
const isNuevo = (c: Cli, R: ReturnType<typeof rulesOf>) => (c.source === 'campo' || c.source === 'oficina') && vzDay(c.createdAt || '') >= R.nuevosDesde;

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const action = body.action, isAdmin = isAdminReq(req), isReader = isAdmin || isSupervisorReq(req);
  try {
    if (action === 'create') {
      const p = cleanPago((body.pago && typeof body.pago === 'object' ? body.pago : {}) as Record<string, unknown>);
      if (typeof p === 'string') return NextResponse.json({ error: p }, { status: 400 });
      if (!isAdmin && !(await sellerAccessOk(req, p.sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      if (isAdmin && !p.by) p.by = 'Oficina';
      // Pago anterior (ya está en FileMaker): si lo registra la oficina queda confirmado; si es el vendedor, la oficina lo confirma
      if (p.origen === 'anterior' && isAdmin) { p.status = 'aprobado'; p.review = { by: p.by || 'Oficina', at: new Date().toISOString(), motivo: 'Pago anterior registrado por la oficina' }; }
      const existing = await db.distPago.findUnique({ where: { id: p.id } });
      if (existing) return NextResponse.json({ pago: parse(existing) }); // reintento: ya estaba guardado
      const refs = p.lines.filter((l) => l.ref).map((l) => l.ref);
      try {
        await db.$transaction(async (tx) => {
          for (const ref of refs) await tx.distPagoRef.create({ data: { ref, pagoId: p.id } });
          await tx.distPago.create({ data: { id: p.id, date: p.date, sellerId: p.sellerId, clientId: p.clientId, status: p.status, data: JSON.stringify(p) } });
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          // El mismo pago llegó dos veces a la vez (reintento): ya quedó guardado, no es una referencia repetida
          const same = await db.distPago.findUnique({ where: { id: p.id } });
          if (same) return NextResponse.json({ pago: parse(same) });
          const used = (await db.distPagoRef.findMany({ where: { ref: { in: refs } } })).map((r) => r.ref);
          const c = used.length ? await conflictOf(used[0]) : null;
          return NextResponse.json({ error: `La referencia ${used[0] || ''} ya está registrada${c && 'clientName' in c ? ` (pago de ${c.clientName}, ${c.sellerName}, ${c.date})` : ''}. Un número de referencia no se repite.`, conflict: c }, { status: 409 });
        }
        throw e;
      }
      return NextResponse.json({ pago: p });
    }

    if (action === 'mine') {
      const sellerId = str(body.sellerId, 120);
      const dw = dateWhere(body);
      if (!sellerId || !dw) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      if (!isReader && !(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      const st = str(body.status, 20);
      const rows = await db.distPago.findMany({ where: { sellerId, ...dw, ...(st ? { status: st } : {}) }, orderBy: [{ createdAt: 'desc' }], take: MAX_LIST });
      return NextResponse.json({ pagos: rows.map(parse) }, { headers: NO_STORE });
    }

    if (action === 'saldo') {
      const ids = (Array.isArray(body.orderIds) ? body.orderIds : []).map((x) => str(x, 120)).filter(Boolean).slice(0, 500);
      if (!ids.length) return NextResponse.json({ byOrder: {} });
      const rows = await db.$queryRaw<{ data: string }[]>`
        SELECT "data" FROM "DistPago" WHERE "status" IN ('espera', 'aprobado')
          AND EXISTS (SELECT 1 FROM jsonb_array_elements("data"::jsonb -> 'notas') n WHERE n ->> 'orderId' = ANY(${ids}))`;
      const byOrder: Record<string, { pagado: number; aprobado: number }> = {};
      for (const r of rows) {
        const p = parse(r);
        // Lo pagado se reparte entre las notas del pago en orden (la más vieja primero)
        let left = p.pagado + p.ajustes;
        p.notas.forEach((n, i) => {
          const take = i === p.notas.length - 1 ? left : Math.min(left, n.monto);
          left -= take;
          const o = byOrder[n.orderId] || (byOrder[n.orderId] = { pagado: 0, aprobado: 0 });
          o.pagado = Math.round((o.pagado + take) * 100) / 100;
          if (p.status === 'aprobado') o.aprobado = Math.round((o.aprobado + take) * 100) / 100;
        });
      }
      return NextResponse.json({ byOrder: Object.fromEntries(Object.entries(byOrder).filter(([k]) => ids.includes(k))) }, { headers: NO_STORE });
    }

    if (action === 'cuenta') {
      const clientId = str(body.clientId, 120), sellerId = str(body.sellerId, 120);
      if (!clientId) return NextResponse.json({ error: 'Falta el cliente' }, { status: 400 });
      if (!isReader && !(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      type Line = { cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number };
      type Ord = { id: string; deleted?: boolean; status?: string; routeDate?: string; valeryNote?: string; loadId?: string | null; lines?: Record<string, Line>;
        delivery?: { at?: string; date?: string; result?: string; monto?: number; newValery?: string; loadId?: string } | null };
      const orows = await db.$queryRaw<{ data: string }[]>`
        SELECT "data" FROM "DistDoc" WHERE "kind" = 'orders' AND "deleted" = false AND ("data"::jsonb ->> 'clientId') = ${clientId}`;
      const lrows = await db.distDoc.findMany({ where: { kind: 'loads', deleted: false }, select: { id: true, data: true } });
      const loadLabel = new Map(lrows.map((r) => { const l = JSON.parse(r.data) as { label?: string; number?: number }; return [r.id, `${l.label || ''}${l.number ? ' C-' + String(l.number).padStart(5, '0') : ''}`.trim()]; }));
      const lineMoney = (l: Line) => r2((Number(l.cajas) || 0) * (Number(l.boxPrice) || 0) + (Number(l.unidades) || 0) * (Number(l.unitPrice) || 0));
      type Nota = { key: string; nota: string; orderId: string; date: string; monto: number; liquidado: boolean; hoja: string; manual: boolean };
      const notas = new Map<string, Nota>();
      for (const r of orows) {
        const o = JSON.parse(r.data) as Ord;
        if (o.deleted) continue;
        const d = o.delivery && o.delivery.at ? o.delivery : null;
        if (!d && o.status !== 'despachado') continue; // solo lo despachado o liquidado se cobra
        if (d && d.result === 'anulada') continue;
        const monto = d ? r2(Number(d.monto) || 0) : r2(Object.values(o.lines || {}).reduce((a, l) => a + lineMoney(l), 0));
        if (!(monto > 0)) continue;
        const nota = notaNum((d && d.newValery) || o.valeryNote);
        const n: Nota = { key: noteKey({ nota, orderId: o.id }), nota, orderId: o.id, date: String((d && d.date) || o.routeDate || ''), monto, liquidado: !!d, hoja: loadLabel.get(String((d && d.loadId) || o.loadId || '')) || '', manual: false };
        notas.set(n.key, n);
      }
      const prows = await db.distPago.findMany({ where: { clientId, status: { in: ['espera', 'aprobado'] } } });
      const pagos = prows.map(parse);
      // Notas agregadas a mano (de antes de la plataforma): quedan en la cuenta del cliente
      for (const p of pagos) for (const n of p.notas) {
        const k = noteKey(n);
        if (!notas.has(k)) notas.set(k, { key: k, nota: notaNum(n.nota), orderId: n.orderId, date: p.date, monto: n.monto, liquidado: false, hoja: '', manual: true });
      }
      // Lo que vale de una nota a mano es lo que se dijo la primera vez (el mayor monto registrado)
      for (const p of pagos) for (const n of p.notas) { const x = notas.get(noteKey(n)); if (x && x.manual && n.monto > x.monto) x.monto = n.monto; }
      const ab = allocate(pagos);
      const list = [...notas.values()].map((n) => { const a = ab.get(n.key); return { ...n, pagado: a ? a.pagado : 0, aprobado: a ? a.aprobado : 0, espera: a ? a.espera : 0, ...noteStatus(n.monto, a) }; })
        .sort((a, b) => (a.estado === 'pagada' ? 1 : 0) - (b.estado === 'pagada' ? 1 : 0) || String(b.date).localeCompare(String(a.date)));
      return NextResponse.json({ notas: list, deuda: r2(list.reduce((a, n) => a + n.resta, 0)), enEspera: r2(list.reduce((a, n) => a + n.espera, 0)) }, { headers: NO_STORE });
    }

    if (action === 'estado') {
      const want = (Array.isArray(body.notas) ? body.notas : []).slice(0, 300).map((x) => { const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>; return { nota: notaNum(o.nota), orderId: str(o.orderId, 120), monto: r2(Number(o.monto) || 0) }; });
      if (!want.length) return NextResponse.json({ byKey: {} });
      const nums = want.map((w) => w.nota).filter(Boolean), oids = want.map((w) => w.orderId).filter(Boolean);
      const rows = await db.$queryRaw<{ data: string }[]>`
        SELECT "data" FROM "DistPago" WHERE "status" IN ('espera', 'aprobado')
          AND EXISTS (SELECT 1 FROM jsonb_array_elements("data"::jsonb -> 'notas') n WHERE regexp_replace(regexp_replace(COALESCE(n ->> 'nota', ''), '\D', '', 'g'), '^0+(?=\d)', '') = ANY(${nums}) OR n ->> 'orderId' = ANY(${oids}))`;
      const ab = allocate(rows.map(parse));
      const byKey: Record<string, unknown> = {};
      for (const w of want) { const k = noteKey(w); const a = ab.get(k); byKey[k] = { pagado: a ? a.pagado : 0, aprobado: a ? a.aprobado : 0, ...noteStatus(w.monto, a) }; }
      return NextResponse.json({ byKey }, { headers: NO_STORE });
    }

    if (action === 'cartera') {
      const sellerId = str(body.sellerId, 120);
      if (!sellerId && !isReader) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
      if (sellerId && !isReader && !(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      const c = await cartera(sellerId);
      return NextResponse.json({ notas: c.notas, alDia: c.alDia, hoy: c.hoy, reglas: c.R, credito: c.credito }, { headers: NO_STORE });
    }

    if (action === 'creditos') {
      if (!isReader) return NextResponse.json({ error: 'Solo oficina o supervisor' }, { status: 401 });
      const c = await cartera(str(body.sellerId, 120));
      return NextResponse.json({ clientes: c.clientes, hoy: c.hoy, reglas: c.R }, { headers: NO_STORE });
    }

    if (action === 'importCobro') {
      if (!isAdmin) return NextResponse.json({ error: 'Solo oficina' }, { status: 401 });
      const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 20000) as { name?: unknown; value?: unknown }[];
      let added = 0;
      for (const r of rows) {
        const name = String(r && r.name || ''), value = String(r && r.value || '');
        if (!/^(cred|seg):/.test(name) || name.length > 300 || !value || value.length > 20000) continue;
        try { JSON.parse(value); } catch { continue; }
        added += await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${name}, ${value}) ON CONFLICT ("name") DO NOTHING`;
      }
      return NextResponse.json({ added });
    }

    if (action === 'credito') {
      if (!isAdmin) return NextResponse.json({ error: 'Solo la oficina (cobranza) ajusta el crédito' }, { status: 401 });
      const clientId = str(body.clientId, 120), modo = str(body.modo, 10), limite = r2(Number(body.limite) || 0);
      if (!clientId || !['auto', 'credito', 'contado'].includes(modo) || limite < 0 || limite > 1e6) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      const name = `cred:${clientId}`;
      const prevRow = await db.distSetting.findUnique({ where: { name } });
      const prev = prevRow ? (JSON.parse(prevRow.value) as CredSetting) : null;
      const v: CredSetting = { modo: modo as CredSetting['modo'], limite, nota: str(body.nota, 300), by: str(body.by, 80) || 'Cobranza', at: new Date().toISOString() };
      v.hist = [...(prev ? [{ modo: prev.modo, limite: prev.limite, nota: prev.nota, by: prev.by, at: prev.at }] : []), ...((prev && prev.hist) || [])].slice(0, 20);
      const value = JSON.stringify(v);
      await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${name}, ${value}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
      const cRow = await db.distDoc.findUnique({ where: { kind_id: { kind: 'clients', id: clientId } }, select: { data: true } });
      const cl = cRow ? (JSON.parse(cRow.data) as { name?: string; sellerId?: string }) : null;
      if (cl && cl.sellerId) {
        const txt = modo === 'contado' ? 'va de CONTADO' : modo === 'credito' ? `crédito${limite ? ' con límite $' + limite : ''}` : `según el sistema${limite ? ' · límite $' + limite : ''}`;
        try { await sendPush('seller', cl.sellerId, [{ title: '🚦 Crédito actualizado', body: `${cl.name || 'Cliente'}: ${txt}${v.nota ? ' — ' + v.nota : ''}`.slice(0, 300), tag: `cred-${clientId}` }]); } catch (e) { console.warn('[push credito]', e); }
      }
      return NextResponse.json({ ok: true, credito: v });
    }

    if (action === 'seguir') {
      const sellerId = str(body.sellerId, 120), clientId = str(body.clientId, 120), key = str(body.key, 140), estado = str(body.estado, 30);
      if (!clientId || !key || !SEGUIMIENTO[estado]) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      if (!isAdmin && !(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      const v = { estado, texto: SEGUIMIENTO[estado], comentario: str(body.comentario, 300), at: new Date().toISOString(), by: str(body.by, 80), nota: notaNum(body.nota), clientName: str(body.clientName, 120) };
      const name = `seg:${clientId}:${key}`, value = JSON.stringify(v);
      await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${name}, ${value}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
      if (!isAdmin) {
        try { await sendPush('office', null, [{ title: '📋 Seguimiento de cobro', body: `${v.by || 'Vendedor'} · ${v.clientName}${v.nota ? ' · nota ' + v.nota : ''}: ${v.texto}${v.comentario ? ' — ' + v.comentario : ''}`.slice(0, 300), tag: `seg-${clientId}-${key}` }]); } catch (e) { console.warn('[push seguimiento]', e); }
      }
      return NextResponse.json({ ok: true, seg: v });
    }

    if (action === 'anular') {
      const id = str(body.id, 80);
      const row = await db.distPago.findUnique({ where: { id } });
      if (!row) return NextResponse.json({ error: 'No existe ese pago' }, { status: 404 });
      const p = parse(row);
      if (!isAdmin && (p.sellerId !== str(body.sellerId, 120) || !(await sellerAccessOk(req, p.sellerId)))) return NextResponse.json({ error: 'Solo el vendedor del pago o la oficina' }, { status: 403 });
      if (p.status !== 'espera') return NextResponse.json({ error: 'Cobranza ya lo verificó: pide a la oficina que lo reabra' }, { status: 409 });
      const next = await db.$transaction(async (tx) => {
        await tx.distPagoRef.deleteMany({ where: { pagoId: id } });
        return setStatus(p, 'anulado', { by: isAdmin ? 'Oficina' : p.sellerName || 'Vendedor', at: new Date().toISOString(), motivo: str(body.motivo, 200) || 'Anulado' }, tx);
      });
      return NextResponse.json({ pago: next });
    }

    if (action === 'list') {
      if (!isReader) return NextResponse.json({ error: 'Solo oficina o supervisor' }, { status: 401 });
      const dw = dateWhere(body);
      if (!dw) return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 });
      const sellerId = str(body.sellerId, 120), status = str(body.status, 20);
      const rows = await db.distPago.findMany({
        where: { ...dw, ...(sellerId ? { sellerId } : {}), ...(status ? { status } : {}) },
        orderBy: [{ createdAt: 'asc' }], take: MAX_LIST,
      });
      return NextResponse.json({ pagos: rows.map(parse) }, { headers: NO_STORE });
    }

    if (action === 'review' || action === 'reabrir' || action === 'import' || action === 'importar') {
      const denied = requireAdmin(req);
      if (denied) return denied;
      if (action === 'importar') {
        // Pagos que ya cargó cobranza en FileMaker. Cada fila trae su llave (fecha|cliente|nota|monto|referencia): volver a
        // importar el mismo archivo no duplica. Si un pago subido por el vendedor tiene la misma referencia y sigue en espera,
        // queda aprobado (cobranza ya lo cargó en FileMaker) en vez de crear otro.
        const res = { creados: 0, repetidos: 0, conciliados: 0, errores: [] as string[] };
        const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 2000);
        for (const raw of rows) {
          const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const fila = String(x.fila || '');
          const date = str(x.date, 10), clientId = str(x.clientId, 120), clientName = str(x.clientName, 120), sellerId = str(x.sellerId, 120) || '—';
          const nota = notaNum(x.nota), usd = r2(Number(x.usd) || 0), montoNota = r2(Number(x.montoNota) || 0), ref = normRef(x.ref);
          if (!isDay(date) || !clientId || !(usd > 0)) { res.errores.push(`Fila ${fila}: falta fecha, cliente o monto`); continue; }
          const id = 'fm' + createHash('sha1').update([date, clientId, nota, usd.toFixed(2), ref, str(x.key, 200)].join('|')).digest('hex').slice(0, 24);
          if (await db.distPago.findUnique({ where: { id } })) { res.repetidos++; continue; }
          if (ref && ref.length >= 4) {
            const used = await db.distPagoRef.findUnique({ where: { ref } });
            if (used) {
              const other = await db.distPago.findUnique({ where: { id: used.pagoId } });
              const op = other ? parse(other) : null;
              if (op && op.status === 'espera' && op.origen !== 'filemaker') {
                await db.$transaction(async (tx) => { await setStatus(op, 'aprobado', { by: 'FileMaker', at: new Date().toISOString(), motivo: 'Conciliado con FileMaker (misma referencia)' }, tx); });
                res.conciliados++;
              } else res.repetidos++;
              continue;
            }
          }
          const method = METHODS[str(x.method, 30)] && str(x.method, 30) !== 'anterior' ? str(x.method, 30) : 'anterior';
          const amount = r2(Number(x.amount) || usd), currency = METHODS[method].currency;
          const p: Pago = {
            id, date, sellerId, sellerName: str(x.sellerName, 80), clientId, clientName, notas: [{ orderId: str(x.orderId, 120) || (nota ? 'manual:' + nota : 'fm:' + id), nota, monto: montoNota > 0 ? montoNota : usd }],
            rate: r2(Number(x.rate) || 0), copRate: 0, lines: [{ method, bank: str(x.bank, 80), ref: ref.length >= 4 ? ref : '', currency, amount: currency === 'USD' ? usd : amount, usd }], adjusts: [],
            debe: montoNota > 0 ? montoNota : usd, pagado: usd, ajustes: 0, diferencia: r2((montoNota > 0 ? montoNota : usd) - usd), comment: str(x.comment, 300), origen: 'filemaker', info: str(x.info, 200),
            status: 'aprobado', by: 'FileMaker', createdAt: new Date().toISOString(), review: { by: 'FileMaker', at: new Date().toISOString(), motivo: 'Importado de FileMaker' },
          };
          try {
            await db.$transaction(async (tx) => {
              if (p.lines[0].ref) await tx.distPagoRef.create({ data: { ref: p.lines[0].ref, pagoId: p.id } });
              await tx.distPago.create({ data: { id: p.id, date: p.date, sellerId: p.sellerId, clientId: p.clientId, status: p.status, data: JSON.stringify(p) } });
            });
            res.creados++;
          } catch (e) {
            if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') res.repetidos++;
            else { console.error('[pagos importar]', e); res.errores.push(`Fila ${fila}: no se pudo guardar`); }
          }
        }
        return NextResponse.json(res);
      }
      if (action === 'import') {
        let added = 0;
        for (const raw of (Array.isArray(body.pagos) ? body.pagos : []).slice(0, 20000)) {
          const p = raw as Pago;
          if (!p || typeof p.id !== 'string' || await db.distPago.findUnique({ where: { id: p.id } })) continue;
          await db.distPago.create({ data: { id: p.id, date: String(p.date), sellerId: String(p.sellerId), clientId: String(p.clientId), status: String(p.status), data: JSON.stringify(p) } });
          if (LIVE.includes(String(p.status))) for (const l of p.lines || []) if (l.ref) await db.distPagoRef.create({ data: { ref: l.ref, pagoId: p.id } }).catch(() => null);
          added++;
        }
        return NextResponse.json({ added });
      }
      const id = str(body.id, 80);
      const row = await db.distPago.findUnique({ where: { id } });
      if (!row) return NextResponse.json({ error: 'No existe ese pago' }, { status: 404 });
      const p = parse(row), review = { by: str(body.by, 80) || 'Cobranza', at: new Date().toISOString(), motivo: str(body.motivo, 200) };
      if (action === 'review') {
        const status = str(body.status, 20);
        if (status !== 'aprobado' && status !== 'rechazado') return NextResponse.json({ error: 'Estado inválido' }, { status: 400 });
        if (p.status !== 'espera') return NextResponse.json({ error: 'Este pago ya no está en espera de cobranza' }, { status: 409 });
        if (status === 'rechazado' && !review.motivo) return NextResponse.json({ error: 'Escribe el motivo del rechazo' }, { status: 400 });
        const next = await db.$transaction(async (tx) => {
          if (status === 'rechazado') await tx.distPagoRef.deleteMany({ where: { pagoId: id } });
          return setStatus(p, status, review, tx);
        });
        return NextResponse.json({ pago: next });
      }
      // reabrir: vuelve a «en espera»; si estaba rechazado o anulado, se vuelven a reservar sus referencias
      if (p.status === 'espera') return NextResponse.json({ pago: p });
      const refs = p.lines.filter((l) => l.ref).map((l) => l.ref);
      try {
        const next = await db.$transaction(async (tx) => {
          if (p.status === 'rechazado' || p.status === 'anulado') for (const ref of refs) await tx.distPagoRef.create({ data: { ref, pagoId: p.id } });
          return setStatus(p, 'espera', { ...review, motivo: 'Reabierto' }, tx);
        });
        return NextResponse.json({ pago: next });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') return NextResponse.json({ error: 'Una de sus referencias ya la usa otro pago: no se puede reabrir' }, { status: 409 });
        throw e;
      }
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/pagos]', error);
    return NextResponse.json({ error: 'No se pudo completar' }, { status: 500 });
  }
}
