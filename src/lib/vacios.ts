import { Prisma } from '@prisma/client';
import { randomBytes } from 'crypto';
import { db } from '@/lib/db';

// Kardex de vacíos (Fase 2 · E4).
//
// La fuente de los movimientos de despacho es la liquidación: al cerrarla, cada
// pedido guarda order.delivery.vac = { <pid>: { code, type, regime, boxes, recv,
// asg, pending, motivo } }. Cuando ese pedido llega al servidor, aquí se
// escriben sus renglones (despacho / recibido / asignado). Si la liquidación se
// reabre (delivery = null) o se cierra de nuevo con otros números, los renglones
// anteriores se cancelan con un «reverso» y se escriben los nuevos.
//
// Los ids son deterministas (liq:<pedido>:<cierre>:<producto>:<tipo>) y todo se
// inserta con ON CONFLICT DO NOTHING: repetirlo no duplica nada.

export const LIQ_KINDS = ['despacho', 'recibido', 'asignado'] as const;
export const MANUAL_KINDS = ['devolucion', 'dev_asignado', 'apertura', 'apertura_asig'] as const;
export const CANCEL_KINDS = ['anulacion', 'reverso'] as const;

export type VacMov = {
  id: string; date: string; kind: string; clientId: string; clientName: string; sellerId: string; sellerName: string;
  type: string; pid: string; code: string; qty: number; orderId: string | null; loadId: string | null;
  refId: string | null; motivo: string; by: string; data: string; at?: Date;
};

type VacLine = { code?: string; type?: string; regime?: string; boxes?: number; recv?: number; asg?: number | null; pending?: number; motivo?: string };
type Delivery = { at?: string; date?: string; loadId?: string; newValery?: string; dispatcherName?: string; by?: string; vac?: Record<string, VacLine> };
type OrderDoc = {
  id: string; clientId?: string; clientKey?: string; clientName?: string; sellerId?: string; sellerName?: string;
  route?: string; valeryNote?: string; deleted?: boolean; delivery?: Delivery | null;
};

const n0 = (v: unknown) => Math.max(0, Math.round(Number(v) || 0));
const day = (s: unknown) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : new Date().toISOString().slice(0, 10));

/** Renglones que corresponden al estado actual del pedido (vacío si no está liquidado). */
export function desiredMovs(o: OrderDoc): VacMov[] {
  const d = o.delivery;
  if (!d || o.deleted || !d.at || !d.vac) return [];
  const out: VacMov[] = [];
  for (const [pid, v] of Object.entries(d.vac)) {
    const base = {
      date: day(d.date), clientId: String(o.clientId || o.clientKey || o.clientName || ''), clientName: String(o.clientName || ''),
      sellerId: String(o.sellerId || ''), sellerName: String(o.sellerName || ''), type: String(v.type || v.code || pid),
      pid, code: String(v.code || ''), orderId: o.id, loadId: d.loadId || null, refId: null, by: String(d.by || 'Oficina'),
      data: JSON.stringify({ valeryNote: d.newValery || o.valeryNote || '', regime: v.regime || '', dispatcherName: d.dispatcherName || '', route: o.route || '' }),
    };
    const qty: Record<string, number> = { despacho: n0(v.boxes), recibido: n0(v.recv), asignado: n0(v.asg) };
    for (const k of LIQ_KINDS) {
      if (!qty[k]) continue;
      out.push({ ...base, id: `liq:${o.id}:${d.at}:${pid}:${k}`, kind: k, qty: qty[k], motivo: k === 'despacho' ? String(v.motivo || '') : '' });
    }
  }
  return out;
}

async function insertMovs(rows: VacMov[]) {
  if (!rows.length) return 0;
  let n = 0;
  for (let i = 0; i < rows.length; i += 200) {
    const part = rows.slice(i, i + 200);
    const values = part.map((m) => Prisma.sql`(${m.id}, ${m.date}, ${m.kind}, ${m.clientId}, ${m.clientName}, ${m.sellerId}, ${m.sellerName}, ${m.type}, ${m.pid}, ${m.code}, ${m.qty}, ${m.orderId}, ${m.loadId}, ${m.refId}, ${m.motivo}, ${m.by}, ${m.data})`);
    n += await db.$executeRaw`
      INSERT INTO "DistVacMov" ("id", "date", "kind", "clientId", "clientName", "sellerId", "sellerName", "type", "pid", "code", "qty", "orderId", "loadId", "refId", "motivo", "by", "data")
      VALUES ${Prisma.join(values)} ON CONFLICT ("id") DO NOTHING`;
  }
  return n;
}

let ensured: Promise<void> | null = null;
/** Disparador que impide editar o borrar renglones (una vez por proceso). */
export function ensureKardex() {
  if (!ensured) {
    ensured = (async () => {
      await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION "dist_vacmov_inmutable"() RETURNS trigger LANGUAGE plpgsql AS $f$
        BEGIN RAISE EXCEPTION 'El kardex de vacíos no se edita ni se borra: se registra una anulación'; END $f$`);
      await db.$executeRawUnsafe(`DO $d$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'DistVacMov_inmutable') THEN
          CREATE TRIGGER "DistVacMov_inmutable" BEFORE UPDATE OR DELETE ON "DistVacMov" FOR EACH ROW EXECUTE FUNCTION "dist_vacmov_inmutable"();
        END IF; END $d$`);
      await db.$executeRawUnsafe(`ALTER TABLE "DistVacMov" ENABLE ROW LEVEL SECURITY`);
    })().catch((e) => { ensured = null; throw e; });
  }
  return ensured;
}

/**
 * Pone el kardex de estos pedidos al día con su liquidación: agrega los
 * renglones que faltan y cancela (reverso) los que ya no corresponden.
 */
export async function syncKardexForOrders(orders: OrderDoc[]) {
  if (!orders.length) return { added: 0, reversed: 0 };
  await ensureKardex();
  const ids = orders.map((o) => o.id);
  const existing = await db.$queryRaw<VacMov[]>`SELECT * FROM "DistVacMov" WHERE "orderId" IN (${Prisma.join(ids)})`;
  const reversed = new Set(existing.filter((m) => m.kind === 'reverso' && m.refId).map((m) => m.refId as string));
  const have = new Set(existing.map((m) => m.id));
  const want = orders.flatMap(desiredMovs);
  const wantIds = new Set(want.map((m) => m.id));
  const toAdd = want.filter((m) => !have.has(m.id));
  const now = new Date().toISOString().slice(0, 10);
  const toReverse: VacMov[] = existing
    .filter((m) => (LIQ_KINDS as readonly string[]).includes(m.kind) && m.id.startsWith('liq:') && !reversed.has(m.id) && !wantIds.has(m.id))
    .map((m) => ({ ...m, id: 'rev:' + m.id, kind: 'reverso', refId: m.id, date: now, motivo: 'Liquidación reabierta o corregida', data: '{}' }));
  // Primero los reversos: si algo falla a la mitad, la próxima revisión lo completa
  await insertMovs(toReverse);
  await insertMovs(toAdd);
  return { added: toAdd.length, reversed: toReverse.length };
}

/** Revisa todos los pedidos liquidados (y los que alguna vez lo estuvieron). */
export async function reconcileAll() {
  await ensureKardex();
  const withDelivery = await db.$queryRaw<{ id: string; data: string }[]>`
    SELECT "id", "data" FROM "DistDoc" WHERE "kind" = 'orders' AND "data" LIKE '%"delivery":{%'`;
  const inKardex = await db.$queryRaw<{ orderId: string }[]>`
    SELECT DISTINCT "orderId" FROM "DistVacMov" WHERE "orderId" IS NOT NULL AND "kind" IN ('despacho', 'recibido', 'asignado')`;
  const known = new Set(withDelivery.map((r) => r.id));
  const extra = inKardex.map((r) => r.orderId).filter((id) => !known.has(id));
  const extraRows = extra.length ? await db.distDoc.findMany({ where: { kind: 'orders', id: { in: extra } }, select: { id: true, data: true } }) : [];
  const docs: OrderDoc[] = [...withDelivery, ...extraRows].map((r) => JSON.parse(r.data) as OrderDoc);
  // Pedido que ya no existe en el servidor: sus renglones activos se cancelan
  const gone = extra.filter((id) => !extraRows.some((r) => r.id === id)).map((id) => ({ id, delivery: null }) as OrderDoc);
  let added = 0, reversed = 0;
  const all = docs.concat(gone);
  for (let i = 0; i < all.length; i += 300) {
    const r = await syncKardexForOrders(all.slice(i, i + 300));
    added += r.added; reversed += r.reversed;
  }
  return { added, reversed };
}

export const newMovId = (prefix: string) => prefix + '_' + Date.now().toString(36) + randomBytes(4).toString('hex');
export { insertMovs };
