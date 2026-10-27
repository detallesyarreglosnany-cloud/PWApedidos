import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { isAdminReq, isSupervisorReq, requireAdmin, syncOk } from '@/lib/keys';
import { sellerAccessOk } from '@/lib/pin';
import { SEGUIMIENTO, type CredSetting } from '@/lib/cobranza';
import { cartera, clientAliases } from '@/lib/cartera';
import { ROLES, userOf } from '@/lib/roles';
import { sendPush } from '@/lib/push';
import { createHash } from 'crypto';
import { METHODS, REF_MIN, abonoKey, allocate, cleanPago, normRef, noteKey, notaNum, noteStatus, r2, type Pago } from '@/lib/pagos';

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
//     { action: 'ref', refs, pagoId? }            → { usadas: { ref: { clientName, sellerName, date, status } } }  aviso al escribir
//     { action: 'integridad' }                    → { cruzados, ajenos, refs, sobre }  revisión de solo lectura (oficina o supervisor)
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

/** Otro usuario cambió el pago mientras tanto: no se aplica (gana el primero). */
class StalePago extends Error {}
/** Cambia el estado solo si el pago sigue como se leyó (aprobar y rechazar a la vez: gana el primero). */
async function setStatus(p: Pago, status: string, review: Pago['review'], tx: Prisma.TransactionClient) {
  const next = { ...p, status, review };
  const n = await tx.distPago.updateMany({ where: { id: p.id, status: p.status }, data: { status, data: JSON.stringify(next) } });
  if (n.count !== 1) throw new StalePago();
  return next;
}
async function conflictOf(ref: string) {
  const r = await db.distPagoRef.findUnique({ where: { ref } });
  const p = r ? await db.distPago.findUnique({ where: { id: r.pagoId } }) : null;
  const x = p ? parse(p) : null;
  return x ? { ref, pagoId: x.id, clientName: x.clientName, sellerName: x.sellerName, date: x.date, status: x.status } : { ref };
}

type OrdLite = { id: string; deleted?: boolean; clientId?: string; clientName?: string; sellerId?: string; sellerName?: string; valeryNote?: string; delivery?: { newValery?: string } | null };
const normName = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const isRealOrder = (id: string) => !!id && !id.startsWith('manual:') && !id.startsWith('fm:');
/** Pedidos de la plataforma con alguno de esos números de nota (Valery o la nota nueva de la liquidación). */
async function ordersByNota(nums: string[]) {
  if (!nums.length) return [] as OrdLite[];
  const rows = await db.$queryRaw<{ data: string }[]>`
    SELECT "data" FROM "DistDoc" WHERE "kind" = 'orders' AND "deleted" = false
      AND (regexp_replace(regexp_replace(COALESCE("data"::jsonb ->> 'valeryNote', ''), '\D', '', 'g'), '^0+(?=\d)', '') = ANY(${nums})
        OR regexp_replace(regexp_replace(COALESCE("data"::jsonb -> 'delivery' ->> 'newValery', ''), '\D', '', 'g'), '^0+(?=\d)', '') = ANY(${nums}))`;
  return rows.map((r) => JSON.parse(r.data) as OrdLite);
}
const notaOf = (o: OrdLite) => notaNum((o.delivery && o.delivery.newValery) || o.valeryNote);
const otherMsg = (nota: string, o: OrdLite, clientName: string) => normName(o.clientName) === normName(clientName)
  ? `La nota ${nota} está en otra ficha del mismo cliente (${o.clientName}${o.sellerName ? ', cartera de ' + o.sellerName : ''}). Registra el pago desde esa ficha o pide a la oficina que una las fichas.`
  : `La nota ${nota} es de ${o.clientName || 'otro cliente'}, no de ${clientName}. Revisa el número de nota.`;
/**
 * Integridad de un pago: cada nota es del cliente del pago (por pedido o por número) y, si lo registra un
 * vendedor, el cliente es de su cartera o las notas son de pedidos suyos. Devuelve el error o null.
 */
async function checkPago(p: { clientId: string; clientName: string; sellerId: string; notas: { orderId: string; nota: string }[] }, isAdmin: boolean) {
  const { canon } = await clientAliases(), me = canon(p.clientId), same = (o: OrdLite) => canon(String(o.clientId)) === me;
  const realIds = [...new Set(p.notas.map((n) => n.orderId).filter(isRealOrder))];
  const rows = realIds.length ? await db.distDoc.findMany({ where: { kind: 'orders', id: { in: realIds } }, select: { data: true } }) : [];
  const byId = new Map(rows.map((r) => { const o = JSON.parse(r.data) as OrdLite; return [o.id, o]; }));
  for (const n of p.notas) {
    if (!isRealOrder(n.orderId)) continue;
    const o = byId.get(n.orderId);
    if (!o || o.deleted) return `La nota ${n.nota || ''} ya no existe en la plataforma (pedido eliminado). Actualiza la app y vuelve a elegirla.`;
    if (!same(o)) return otherMsg(n.nota || notaOf(o), o, p.clientName);
  }
  const nums = [...new Set(p.notas.filter((n) => !isRealOrder(n.orderId)).map((n) => notaNum(n.nota)).filter(Boolean))];
  for (const o of await ordersByNota(nums)) if (!same(o)) return otherMsg(notaOf(o), o, p.clientName);
  if (!isAdmin) {
    const cRow = await db.distDoc.findUnique({ where: { kind_id: { kind: 'clients', id: p.clientId } }, select: { data: true } });
    const c = cRow ? (JSON.parse(cRow.data) as { sellerId?: string; name?: string }) : null;
    const suyos = realIds.length > 0 && realIds.every((id) => String((byId.get(id) || {}).sellerId || '') === p.sellerId);
    if (c && c.sellerId && c.sellerId !== p.sellerId && !suyos) return `${c.name || p.clientName} es cliente de otro vendedor: su pago lo registra su vendedor o la oficina.`;
  }
  return null;
}

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const user = await userOf(req);
  // Cobranzas (usuario con PIN) verifica pagos, importa de FileMaker y ajusta el crédito; Gerencia consulta
  const action = body.action, isAdmin = isAdminReq(req), isCob = isAdmin || (!!user && user.role === 'cobranzas'), isReader = isAdmin || isSupervisorReq(req) || !!user;
  // Quién lo hizo: el usuario con PIN queda con su nombre (no el texto que mande el equipo)
  const actor = user ? `${user.name} (${ROLES[user.role]})` : '';
  try {
    if (action === 'create') {
      const p = cleanPago((body.pago && typeof body.pago === 'object' ? body.pago : {}) as Record<string, unknown>);
      if (typeof p === 'string') return NextResponse.json({ error: p }, { status: 400 });
      if (!isCob && !(await sellerAccessOk(req, p.sellerId))) return NextResponse.json({ error: 'PIN', pin: true }, { status: 401 });
      if (isCob && !p.by) p.by = actor || 'Oficina';
      if (actor) p.by = actor;
      const existing0 = await db.distPago.findUnique({ where: { id: p.id } });
      if (existing0) return NextResponse.json({ pago: parse(existing0) }); // reintento: ya estaba guardado
      const bad = await checkPago(p, isCob);
      if (bad) return NextResponse.json({ error: bad }, { status: 422 });
      // Pago anterior (ya está en FileMaker): si lo registra la oficina queda confirmado; si es el vendedor, la oficina lo confirma
      if (p.origen === 'anterior' && isCob) { p.status = 'aprobado'; p.review = { by: p.by || 'Oficina', at: new Date().toISOString(), motivo: 'Pago anterior registrado por la oficina' }; }
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
      // LIKE (texto) descarta rápido; la comparación JSON exacta solo se hace en los que coinciden
      const orows = await db.$queryRaw<{ data: string }[]>`
        SELECT "data" FROM "DistDoc" WHERE "kind" = 'orders' AND "deleted" = false AND "data" LIKE ${'%' + clientId.replace(/[\\%_]/g, '\\$&') + '%'} AND ("data"::jsonb ->> 'clientId') = ${clientId}`;
      // Solo las hojas de esos pedidos (antes se leían todas las hojas de la historia)
      const loadIds = [...new Set(orows.flatMap((r) => { const o = JSON.parse(r.data) as { loadId?: string | null; delivery?: { loadId?: string } | null }; return [o.loadId, o.delivery && o.delivery.loadId].filter((x): x is string => !!x); }))];
      const lrows = loadIds.length ? await db.distDoc.findMany({ where: { kind: 'loads', id: { in: loadIds }, deleted: false }, select: { id: true, data: true } }) : [];
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
      // También los pagos registrados en fichas repetidas que ya se unieron a esta
      const { canon, aliasesOf } = await clientAliases();
      const prows = await db.distPago.findMany({ where: { clientId: { in: aliasesOf(clientId) }, status: { in: ['espera', 'aprobado'] } } });
      const pagos = prows.map(parse);
      // Notas agregadas a mano (de antes de la plataforma): quedan en la cuenta del cliente
      for (const p of pagos) for (const n of p.notas) {
        const k = noteKey(n);
        if (!notas.has(k)) notas.set(k, { key: k, nota: notaNum(n.nota), orderId: n.orderId, date: p.date, monto: n.monto, liquidado: false, hoja: '', manual: true });
      }
      // Lo que vale de una nota a mano es lo que se dijo la primera vez (el mayor monto registrado)
      for (const p of pagos) for (const n of p.notas) { const x = notas.get(noteKey(n)); if (x && x.manual && n.monto > x.monto) x.monto = n.monto; }
      const ab = allocate(pagos, canon);
      const list = [...notas.values()].map((n) => { const a = ab.get(`${canon(clientId)}|${n.key}`); return { ...n, pagado: a ? a.pagado : 0, aprobado: a ? a.aprobado : 0, espera: a ? a.espera : 0, ...noteStatus(n.monto, a) }; })
        .sort((a, b) => (a.estado === 'pagada' ? 1 : 0) - (b.estado === 'pagada' ? 1 : 0) || String(b.date).localeCompare(String(a.date)));
      return NextResponse.json({ notas: list, deuda: r2(list.reduce((a, n) => a + n.resta, 0)), enEspera: r2(list.reduce((a, n) => a + n.espera, 0)) }, { headers: NO_STORE });
    }

    if (action === 'estado') {
      const want = (Array.isArray(body.notas) ? body.notas : []).slice(0, 300).map((x) => { const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>; return { nota: notaNum(o.nota), orderId: str(o.orderId, 120), monto: r2(Number(o.monto) || 0), clientId: str(o.clientId, 120) }; });
      if (!want.length) return NextResponse.json({ byKey: {}, byIdx: [] });
      // Cada nota se mira en la cuenta de SU cliente (versiones viejas de la app no lo mandan: se toma del pedido)
      const noCli = [...new Set(want.filter((w) => !w.clientId && w.orderId).map((w) => w.orderId))];
      if (noCli.length) {
        const orows = await db.distDoc.findMany({ where: { kind: 'orders', id: { in: noCli } }, select: { id: true, data: true } });
        const cOf = new Map(orows.map((r) => [r.id, String((JSON.parse(r.data) as { clientId?: string }).clientId || '')]));
        want.forEach((w) => { if (!w.clientId) w.clientId = cOf.get(w.orderId) || ''; });
      }
      const { canon, aliasesOf } = await clientAliases();
      want.forEach((w) => { if (w.clientId) w.clientId = canon(w.clientId); });
      const nums = want.map((w) => w.nota).filter(Boolean), oids = want.map((w) => w.orderId).filter(Boolean), cids = [...new Set(want.map((w) => w.clientId).filter(Boolean).flatMap(aliasesOf))];
      const rows = cids.length ? await db.$queryRaw<{ data: string }[]>`
        SELECT "data" FROM "DistPago" WHERE "status" IN ('espera', 'aprobado') AND "clientId" = ANY(${cids})
          AND EXISTS (SELECT 1 FROM jsonb_array_elements("data"::jsonb -> 'notas') n WHERE regexp_replace(regexp_replace(COALESCE(n ->> 'nota', ''), '\D', '', 'g'), '^0+(?=\d)', '') = ANY(${nums}) OR n ->> 'orderId' = ANY(${oids}))` : [];
      const ab = allocate(rows.map(parse), canon);
      const byKey: Record<string, unknown> = {}, byIdx: unknown[] = [];
      for (const w of want) { const a = w.clientId ? ab.get(abonoKey(w.clientId, w)) : undefined; const x = { pagado: a ? a.pagado : 0, aprobado: a ? a.aprobado : 0, ...noteStatus(w.monto, a) }; byKey[noteKey(w)] = x; byIdx.push(x); }
      return NextResponse.json({ byKey, byIdx }, { headers: NO_STORE });
    }

    if (action === 'ref') {
      // Consulta al escribir: ¿esta referencia ya está en otro pago? (solo lectura)
      const refs = [...new Set((Array.isArray(body.refs) ? body.refs : []).slice(0, 12).map(normRef).filter((r) => r.length >= REF_MIN))];
      const usadas: Record<string, unknown> = {};
      for (const ref of refs) { const c = await conflictOf(ref); if ('pagoId' in c && c.pagoId !== str(body.pagoId, 80)) usadas[ref] = c; }
      return NextResponse.json({ usadas }, { headers: NO_STORE });
    }

    if (action === 'integridad') {
      // Revisión de solo lectura: pagos vivos (en espera o aprobados) que abonan notas de otro cliente, de clientes de otro
      // vendedor, referencias sin reservar o usadas por dos pagos, y notas con más abonado que su monto.
      if (!isReader) return NextResponse.json({ error: 'Solo oficina o supervisor' }, { status: 401 });
      const pagos = (await db.distPago.findMany({ where: { status: { in: LIVE } } })).map(parse), { canon } = await clientAliases();
      const orows = await db.distDoc.findMany({ where: { kind: 'orders', deleted: false, status: 'despachado' }, select: { data: true } });
      const orders = orows.map((r) => JSON.parse(r.data) as OrdLite & { delivery?: { newValery?: string; monto?: number; at?: string; result?: string } | null; lines?: Record<string, { cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number }> });
      const byId = new Map(orders.map((o) => [o.id, o])), byNota = new Map<string, OrdLite[]>();
      orders.forEach((o) => { const k = notaOf(o); if (k) byNota.set(k, (byNota.get(k) || []).concat(o)); });
      const crows = await db.distDoc.findMany({ where: { kind: 'clients', deleted: false }, select: { id: true, data: true } });
      const cliSeller = new Map(crows.map((r) => [r.id, String((JSON.parse(r.data) as { sellerId?: string }).sellerId || '')]));
      const refRows = await db.distPagoRef.findMany();
      const refOf = new Map(refRows.map((r) => [r.ref, r.pagoId]));
      type Item = { pagoId: string; date: string; status: string; clientName: string; sellerName: string; monto: number; detalle: string };
      const item = (p: Pago, detalle: string): Item => ({ pagoId: p.id, date: p.date, status: p.status, clientName: p.clientName, sellerName: p.sellerName, monto: r2(p.pagado + p.ajustes), detalle });
      const cruzados: Item[] = [], ajenos: Item[] = [], refs: Item[] = [];
      for (const p of pagos) {
        for (const n of p.notas) {
          const o = isRealOrder(n.orderId) ? byId.get(n.orderId) : null;
          const ajeno = o ? (canon(String(o.clientId)) !== canon(p.clientId) ? o : null) : (byNota.get(notaNum(n.nota)) || []).find((x) => canon(String(x.clientId)) !== canon(p.clientId)) || null;
          if (ajeno) cruzados.push(item(p, otherMsg(n.nota || notaOf(ajeno), ajeno, p.clientName)));
        }
        const cs = cliSeller.get(canon(p.clientId));
        const suyos = p.notas.some((n) => isRealOrder(n.orderId) && String((byId.get(n.orderId) || {}).sellerId || '') === p.sellerId);
        if (p.origen === 'app' && cs && cs !== p.sellerId && !suyos) ajenos.push(item(p, `Lo registró ${p.sellerName || 'otro vendedor'}, pero el cliente es de otra cartera`));
        for (const l of p.lines) if (l.ref) {
          const owner = refOf.get(l.ref);
          if (!owner) refs.push(item(p, `La referencia ${l.ref} (${l.bank || l.method}) no está reservada: otro pago podría repetirla`));
          else if (owner !== p.id) { const q = pagos.find((x) => x.id === owner); refs.push(item(p, `La referencia ${l.ref} también está en el pago de ${q ? q.clientName + ' (' + q.date + ')' : 'otro registro'}`)); }
        }
      }
      // Notas con más abonado que su monto (por cliente)
      const ab = allocate(pagos, canon), sobre: Item[] = [];
      for (const o of orders) {
        const d = o.delivery && o.delivery.at ? o.delivery : null; if (d && d.result === 'anulada') continue;
        const monto = d ? r2(Number(d.monto) || 0) : r2(Object.values(o.lines || {}).reduce((a, l) => a + (Number(l.cajas) || 0) * (Number(l.boxPrice) || 0) + (Number(l.unidades) || 0) * (Number(l.unitPrice) || 0), 0));
        const a = ab.get(abonoKey(canon(String(o.clientId)), { nota: notaOf(o), orderId: o.id }));
        if (a && monto > 0 && a.pagado > monto + 0.01) { const p = pagos.find((x) => x.id === a.pagos[a.pagos.length - 1]); if (p) sobre.push({ ...item(p, `Nota ${notaOf(o) || '—'} de $${monto.toFixed(2)} tiene abonado $${a.pagado.toFixed(2)} (sobran $${(a.pagado - monto).toFixed(2)})`), clientName: String(o.clientName || p.clientName) }); }
      }
      return NextResponse.json({ revisados: pagos.length, cruzados, ajenos, refs, sobre }, { headers: NO_STORE });
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
      if (!isCob) return NextResponse.json({ error: 'Solo la oficina o cobranzas ajustan el crédito' }, { status: 401 });
      const clientId = str(body.clientId, 120), modo = str(body.modo, 10), limite = r2(Number(body.limite) || 0);
      if (!clientId || !['auto', 'credito', 'contado'].includes(modo) || limite < 0 || limite > 1e6) return NextResponse.json({ error: 'Datos inválidos' }, { status: 400 });
      const name = `cred:${clientId}`;
      const prevRow = await db.distSetting.findUnique({ where: { name } });
      const prev = prevRow ? (JSON.parse(prevRow.value) as CredSetting) : null;
      const v: CredSetting = { modo: modo as CredSetting['modo'], limite, nota: str(body.nota, 300), by: actor || str(body.by, 80) || 'Cobranza', at: new Date().toISOString() };
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
      if (!isCob && (p.sellerId !== str(body.sellerId, 120) || !(await sellerAccessOk(req, p.sellerId)))) return NextResponse.json({ error: 'Solo el vendedor del pago o la oficina' }, { status: 403 });
      if (p.status !== 'espera') return NextResponse.json({ error: 'Cobranza ya lo verificó: pide a la oficina que lo reabra' }, { status: 409 });
      const next = await db.$transaction(async (tx) => {
        await tx.distPagoRef.deleteMany({ where: { pagoId: id } });
        return setStatus(p, 'anulado', { by: actor || (isAdmin ? 'Oficina' : p.sellerName || 'Vendedor'), at: new Date().toISOString(), motivo: str(body.motivo, 200) || 'Anulado' }, tx);
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
      // Verificar, reabrir e importar de FileMaker: oficina o cobranzas. Restaurar un respaldo: solo la oficina.
      const denied = action === 'import' || !isCob ? requireAdmin(req) : null;
      if (denied) return denied;
      if (action === 'importar') {
        // Pagos que ya cargó cobranza en FileMaker. Cada fila trae su llave (fecha|cliente|nota|monto|referencia): volver a
        // importar el mismo archivo no duplica. Si un pago subido por el vendedor tiene la misma referencia y sigue en espera,
        // queda aprobado (cobranza ya lo cargó en FileMaker) en vez de crear otro.
        const res = { creados: 0, repetidos: 0, conciliados: 0, errores: [] as string[], conflictos: [] as string[] };
        const rows = (Array.isArray(body.rows) ? body.rows : []).slice(0, 2000);
        // Dueño de cada número de nota (una sola consulta para todo el archivo)
        const owners = new Map<string, OrdLite[]>(), { canon } = await clientAliases();
        for (const o of await ordersByNota([...new Set(rows.map((x) => notaNum((x as Record<string, unknown> | null)?.nota)).filter(Boolean))])) {
          const k = notaOf(o); owners.set(k, (owners.get(k) || []).concat(o));
        }
        for (const raw of rows) {
          const x = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
          const fila = String(x.fila || '');
          const date = str(x.date, 10), clientId = str(x.clientId, 120), clientName = str(x.clientName, 120), sellerId = str(x.sellerId, 120) || '—';
          const nota = notaNum(x.nota), usd = r2(Number(x.usd) || 0), montoNota = r2(Number(x.montoNota) || 0), ref = normRef(x.ref);
          if (!isDay(date) || !clientId || !(usd > 0)) { res.errores.push(`Fila ${fila}: falta fecha, cliente o monto`); continue; }
          const id = 'fm' + createHash('sha1').update([date, clientId, nota, usd.toFixed(2), ref, str(x.key, 200)].join('|')).digest('hex').slice(0, 24);
          if (await db.distPago.findUnique({ where: { id } })) { res.repetidos++; continue; }
          // La nota tiene que ser de ese cliente (si existe en la plataforma)
          if (nota) { const ajeno = (owners.get(nota) || []).find((o) => canon(String(o.clientId)) !== canon(clientId)); if (ajeno) { res.errores.push(`Fila ${fila}: ${otherMsg(nota, ajeno, clientName)}`); continue; } }
          if (ref && ref.length >= REF_MIN) {
            const used = await db.distPagoRef.findUnique({ where: { ref } });
            if (used) {
              const other = await db.distPago.findUnique({ where: { id: used.pagoId } });
              const op = other ? parse(other) : null;
              if (op && op.origen === 'filemaker') { res.repetidos++; continue; }
              // Solo se concilia si es el mismo cliente y el mismo monto (±2 % o $1): si no, cobranza lo revisa
              const ln = op ? op.lines.find((l) => l.ref === ref) : null, tol = Math.max(1, usd * 0.02);
              const mismo = !!op && canon(op.clientId) === canon(clientId) && !!ln && Math.abs(ln.usd - usd) <= tol;
              if (!op || !mismo) {
                res.conflictos.push(`Fila ${fila}: la referencia ${ref} ya está en un pago de ${op ? `${op.clientName} (${op.sellerName || 'oficina'}, ${op.date}, $${ln ? ln.usd.toFixed(2) : (op.pagado + op.ajustes).toFixed(2)})` : 'otro registro'}${op && canon(op.clientId) !== canon(clientId) ? ', otro cliente' : op ? ', otro monto' : ''}. No se aprobó nada: revísalo.`);
                continue;
              }
              if (op.status === 'espera') {
                try { await db.$transaction(async (tx) => { await setStatus(op, 'aprobado', { by: 'FileMaker', at: new Date().toISOString(), motivo: 'Conciliado con FileMaker (misma referencia, cliente y monto)' }, tx); }); res.conciliados++; }
                catch (e) { if (e instanceof StalePago) res.repetidos++; else throw e; }
              } else res.repetidos++;
              continue;
            }
          }
          const method = METHODS[str(x.method, 30)] && str(x.method, 30) !== 'anterior' ? str(x.method, 30) : 'anterior';
          const amount = r2(Number(x.amount) || usd), currency = METHODS[method].currency;
          const p: Pago = {
            id, date, sellerId, sellerName: str(x.sellerName, 80), clientId, clientName, notas: [{ orderId: str(x.orderId, 120) || (nota ? 'manual:' + nota : 'fm:' + id), nota, monto: montoNota > 0 ? montoNota : usd }],
            rate: r2(Number(x.rate) || 0), copRate: 0, lines: [{ method, bank: str(x.bank, 80), ref: ref.length >= REF_MIN ? ref : '', currency, amount: currency === 'USD' ? usd : amount, usd }], adjusts: [],
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
        let added = 0; const refConflicts: string[] = [];
        for (const raw of (Array.isArray(body.pagos) ? body.pagos : []).slice(0, 20000)) {
          const p = raw as Pago;
          if (!p || typeof p.id !== 'string' || await db.distPago.findUnique({ where: { id: p.id } })) continue;
          await db.distPago.create({ data: { id: p.id, date: String(p.date), sellerId: String(p.sellerId), clientId: String(p.clientId), status: String(p.status), data: JSON.stringify(p) } });
          if (LIVE.includes(String(p.status))) for (const l of p.lines || []) if (l.ref) await db.distPagoRef.create({ data: { ref: l.ref, pagoId: p.id } }).catch(() => { refConflicts.push(l.ref); });
          added++;
        }
        if (refConflicts.length) console.warn('[pagos import] referencias en conflicto', refConflicts);
        return NextResponse.json({ added, refConflicts });
      }
      const id = str(body.id, 80);
      const row = await db.distPago.findUnique({ where: { id } });
      if (!row) return NextResponse.json({ error: 'No existe ese pago' }, { status: 404 });
      const p = parse(row), review = { by: actor || str(body.by, 80) || 'Cobranza', at: new Date().toISOString(), motivo: str(body.motivo, 200) };
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
    if (error instanceof StalePago) return NextResponse.json({ error: 'Otra persona acaba de cambiar este pago. Actualiza la lista para ver cómo quedó.' }, { status: 409 });
    console.error('[pedidos/pagos]', error);
    return NextResponse.json({ error: 'No se pudo completar' }, { status: 500 });
  }
}
