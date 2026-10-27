import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isAdminReq, isSupervisorReq, requireAdmin, syncOk } from '@/lib/keys';
import { sellerAccessOk } from '@/lib/pin';
import { allocate, cleanPago, noteKey, notaNum, noteStatus, r2, type Pago } from '@/lib/pagos';

// Pagos de clientes (Fase 4 · cobranza).
// POST /api/pedidos/pagos
//   Vendedor (clave de sync; con PIN, desde su teléfono de confianza) u oficina:
//     { action: 'create', pago }                 → { pago }   la referencia no se puede repetir (409 si ya existe)
//     { action: 'mine', sellerId, from, to }      → { pagos }
//     { action: 'saldo', orderIds }               → { byOrder: { id: { pagado, aprobado } } }   lo abonado a cada nota
//     { action: 'anular', id, sellerId }          → { pago }   solo si cobranza aún no lo verificó; libera las referencias
//     { action: 'cuenta', clientId, sellerId }    → { notas, deuda, enEspera }  estado de cuenta: cada nota del cliente con su estado de pago
//     { action: 'estado', notas: [{ nota, orderId, monto }] } → { byKey: { 'n:85643': { estado, texto, resta, ... } } }
//   Oficina / supervisor (lectura):
//     { action: 'list', from, to, sellerId?, status? } → { pagos }
//   Oficina (cobranza):
//     { action: 'review', id, status: 'aprobado' | 'rechazado', motivo? } → { pago }  (rechazado libera las referencias)
//     { action: 'reabrir', id }                   → { pago }   vuelve a «en espera de cobranza»
//     { action: 'import', pagos }                 → { added }  restaurar un respaldo

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const MAX_LIST = 5000;
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
const NO_STORE = { 'Cache-Control': 'no-store' };
const parse = (r: { data: string }) => JSON.parse(r.data) as Pago;
const LIVE = ['espera', 'aprobado'];

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
      if (!sellerId || !isDay(body.from) || !isDay(body.to)) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      if (!isReader && !(await sellerAccessOk(req, sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      const rows = await db.distPago.findMany({ where: { sellerId, date: { gte: body.from, lte: body.to } }, orderBy: [{ date: 'desc' }, { createdAt: 'desc' }], take: MAX_LIST });
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
      if (!isDay(body.from) || !isDay(body.to)) return NextResponse.json({ error: 'Rango de fechas inválido' }, { status: 400 });
      const sellerId = str(body.sellerId, 120), status = str(body.status, 20);
      const rows = await db.distPago.findMany({
        where: { date: { gte: body.from, lte: body.to }, ...(sellerId ? { sellerId } : {}), ...(status ? { status } : {}) },
        orderBy: [{ date: 'asc' }, { createdAt: 'asc' }], take: MAX_LIST,
      });
      return NextResponse.json({ pagos: rows.map(parse) }, { headers: NO_STORE });
    }

    if (action === 'review' || action === 'reabrir' || action === 'import') {
      const denied = requireAdmin(req);
      if (denied) return denied;
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
