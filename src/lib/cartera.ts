// Cuentas por cobrar y crédito por cliente (Fases 5 y 6). Lo usan /api/pedidos/pagos y el aviso diario (cron).
import { db } from '@/lib/db';
import { credInfo, diffDays, rulesOf, tramos, vzDay, type CredInfo, type CredSetting } from '@/lib/cobranza';
import { abonoKey, allocate, noteKey, notaNum, noteStatus, r2, type Pago } from '@/lib/pagos';

const LIVE = ['espera', 'aprobado'];

/**
 * Fichas de cliente unidas (repetidas): la eliminada guarda mergedInto. canon() da la ficha que quedó, y aliasesOf()
 * todas las fichas de ese cliente: sus pagos siguen contando aunque se hayan registrado en la ficha vieja.
 */
export async function clientAliases() {
  const rows = await db.$queryRaw<{ id: string; data: string }[]>`SELECT "id", "data" FROM "DistDoc" WHERE "kind" = 'clients' AND "data" LIKE '%"mergedInto"%'`;
  const to = new Map<string, string>();
  for (const r of rows) { const m = (JSON.parse(r.data) as { mergedInto?: string }).mergedInto; if (m && m !== r.id) to.set(r.id, String(m)); }
  const canon = (id: string) => { let x = String(id || ''), n = 0; while (to.has(x) && n++ < 10) x = to.get(x)!; return x; };
  const aliasesOf = (id: string) => { const c = canon(id); return [c, ...[...to.keys()].filter((k) => k !== c && canon(k) === c)]; };
  return { canon, aliasesOf };
}
const parse = (r: { data: string; createdAt?: Date }) => { const p = JSON.parse(r.data) as Pago; if (r.createdAt && !p.createdAt) p.createdAt = r.createdAt.toISOString(); return p; };
type Line = { category?: string; cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number };
type Ord = { id: string; deleted?: boolean; status?: string; clientId?: string; clientName?: string; sellerId?: string; sellerName?: string; routeDate?: string; valeryNote?: string; dispatchedAt?: string; loadId?: string | null;
  lines?: Record<string, Line>; delivery?: { at?: string; result?: string; monto?: number; newValery?: string; lines?: Record<string, Line>; dispatcherName?: string } | null };
type Cli = { id: string; name?: string; sellerId?: string; source?: string; createdAt?: string; deleted?: boolean };
type Nota = ReturnType<typeof noteStatus> & { clientId: string; clientName: string; sellerId: string; sellerName: string; orderId: string; nota: string; key: string; monto: number; resta: number;
  pagado: number; espera: number; despacho: string; vence: string; dias: number; tramos: ReturnType<typeof tramos>; liquidado: boolean; seg: unknown };
const money = (l: Line) => r2((Number(l.cajas) || 0) * (Number(l.boxPrice) || 0) + (Number(l.unidades) || 0) * (Number(l.unitPrice) || 0));
/** Cuentas por cobrar con vencimientos y el crédito de cada cliente (de un vendedor o de todos). */
export async function cartera(sellerId: string) {
  const hoy = vzDay(new Date().toISOString()), since = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
  const cfgRow = await db.distDoc.findUnique({ where: { kind_id: { kind: 'config', id: 'main' } }, select: { data: true } });
  const R = rulesOf(cfgRow ? JSON.parse(cfgRow.data) : null);
  const prodRows = await db.distDoc.findMany({ where: { kind: 'products', deleted: false }, select: { data: true } });
  const catOf = new Map(prodRows.map((r) => { const x = JSON.parse(r.data) as { id: string; category?: string }; return [x.id, String(x.category || '')]; }));
  const crows = await db.distDoc.findMany({ where: { kind: 'clients', deleted: false, ...(sellerId ? { sellerId } : {}) }, select: { data: true } });
  const clients = new Map(crows.map((r) => { const c = JSON.parse(r.data) as Cli; return [c.id, c]; }));
  const orows = await db.distDoc.findMany({ where: { kind: 'orders', deleted: false, status: 'despachado', routeDate: { gte: since }, ...(sellerId ? { sellerId } : {}) }, select: { data: true } });
  const orders = orows.map((r) => JSON.parse(r.data) as Ord).filter((o) => !o.deleted && o.clientId && !(o.delivery && o.delivery.at && o.delivery.result === 'anulada'));
  const { canon, aliasesOf } = await clientAliases();
  const clientIds = [...new Set(orders.map((o) => canon(String(o.clientId))).flatMap(aliasesOf))];
  const pagos = clientIds.length ? (await db.distPago.findMany({ where: { clientId: { in: clientIds }, status: { in: LIVE } } })).map(parse) : [];
  const ab = allocate(pagos, canon);
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
    const nota = notaNum((d && d.newValery) || o.valeryNote), key = noteKey({ nota, orderId: o.id }), ak = abonoKey(canon(String(o.clientId)), { nota, orderId: o.id }), a = ab.get(ak);
    const tr = tramos(lines, start, R, a ? a.pagado : 0), resta = r2(tr.reduce((q, t) => q + t.resta, 0));
    if (resta <= 0.01) { pagaron.add(String(o.clientId)); cerradas.push({ key: ak, monto, vence: tr[tr.length - 1].vence, x }); continue; }
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
        const k = abonoKey(canon(p.clientId), n), m = montoOf.get(k); if (m === undefined || done.has(k)) return;
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

