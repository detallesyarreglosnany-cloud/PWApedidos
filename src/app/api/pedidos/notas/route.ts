import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireReader } from '@/lib/keys';

// Notas Valery: son secuenciales y ningún número se repite.
// POST /api/pedidos/notas  (oficina o supervisor)
//   { action: 'check', note, orderId, pendingFrom? } → { conflicts: [...] }  ¿ya la tiene otro pedido? (en todo el servidor)
//   { action: 'review', from?, to? }                 → { dups: [...], gaps: [...], min, max, total }
// Se compara solo el número, sin ceros a la izquierda (012345 = 12345). Cuentan la nota del pedido, la nota nueva de
// una devolución parcial y la del retiro por oficina. Excepción: «se entrega después» puede llevar la MISMA nota del
// pedido que la originó (la copia apunta a él con pendingFrom).

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type Delivery = { newValery?: string; retiroNote?: string; loadId?: string };
type OrderDoc = { id: string; deleted?: boolean; clientName?: string; sellerName?: string; routeDate?: string; loadId?: string | null; valeryNote?: string; pendingFrom?: string; delivery?: Delivery | null };
type LoadDoc = { id: string; label?: string; number?: number; date?: string; closedAt?: string; liq?: { status?: string } | null; deleted?: boolean };

const normNote = (v: unknown) => String(v ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function notesOf(o: OrderDoc) {
  const out: { note: string; field: string }[] = [];
  const add = (v: unknown, field: string) => { const n = normNote(v); if (n && !out.some((x) => x.note === n)) out.push({ note: n, field }); };
  add(o.valeryNote, 'nota');
  if (o.delivery) { add(o.delivery.newValery, 'nota nueva'); add(o.delivery.retiroNote, 'retiro'); }
  return out;
}

export async function POST(req: NextRequest) {
  const denied = requireReader(req);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  try {
    const loadRows = await db.distDoc.findMany({ where: { kind: 'loads', deleted: false }, select: { data: true } });
    const loadById = new Map(loadRows.map((r) => JSON.parse(r.data) as LoadDoc).map((l) => [l.id, l]));
    const loadInfo = (o: OrderDoc) => {
      const lid = (o.delivery && o.delivery.loadId) || o.loadId || '';
      const l = lid ? loadById.get(lid) : null;
      return { loadId: l ? l.id : '', loadLabel: l ? `${l.label || ''}${l.number ? ' C-' + String(l.number).padStart(5, '0') : ''}`.trim() : '' };
    };
    const card = (o: OrderDoc, field: string) => ({ orderId: o.id, clientName: o.clientName || '', sellerName: o.sellerName || '', routeDate: o.routeDate || '', field, ...loadInfo(o) });

    if (body.action === 'check') {
      const note = normNote(body.note), orderId = String(body.orderId || ''), pendingFrom = String(body.pendingFrom || '');
      if (!note) return NextResponse.json({ conflicts: [] });
      // Filtro grueso en la base (el número aparece en el texto) y luego la comparación exacta
      const rows = await db.distDoc.findMany({ where: { kind: 'orders', deleted: false, data: { contains: note } }, select: { data: true } });
      const conflicts: ReturnType<typeof card>[] = [];
      for (const r of rows) {
        const o = JSON.parse(r.data) as OrderDoc;
        if (o.deleted || o.id === orderId) continue;
        // Misma cadena de «se entrega después»: puede llevar la misma nota
        if ((pendingFrom && (o.id === pendingFrom || o.pendingFrom === pendingFrom)) || o.pendingFrom === orderId) continue;
        const hit = notesOf(o).find((x) => x.note === note);
        if (hit) conflicts.push(card(o, hit.field));
      }
      return NextResponse.json({ conflicts }, { headers: { 'Cache-Control': 'no-store' } });
    }

    if (body.action === 'review') {
      const from = isDay(body.from) ? body.from : '', to = isDay(body.to) ? body.to : '';
      const where = from || to ? { kind: 'orders', deleted: false, routeDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : { kind: 'orders', deleted: false };
      const rows = await db.distDoc.findMany({ where, select: { data: true } });
      const byNote = new Map<string, { o: OrderDoc; field: string }[]>();
      for (const r of rows) {
        const o = JSON.parse(r.data) as OrderDoc;
        if (o.deleted) continue;
        for (const x of notesOf(o)) byNote.set(x.note, (byNote.get(x.note) || []).concat({ o, field: x.field }));
      }
      const dups = [...byNote.entries()].map(([note, list]) => {
        // La copia de «se entrega después» con la misma nota no es repetición
        const roots = new Set(list.map((x) => x.o.pendingFrom || x.o.id));
        return roots.size > 1 ? { note, orders: list.map((x) => card(x.o, x.field)) } : null;
      }).filter(Boolean).sort((a, b) => Number(a!.note) - Number(b!.note));
      const nums = [...byNote.keys()].map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
      const gaps: { from: number; to: number; count: number }[] = [];
      for (let i = 1; i < nums.length; i++) if (nums[i] - nums[i - 1] > 1) gaps.push({ from: nums[i - 1] + 1, to: nums[i] - 1, count: nums[i] - nums[i - 1] - 1 });
      return NextResponse.json({ dups, gaps: gaps.slice(0, 300), gapsTotal: gaps.length, missing: gaps.reduce((a, g) => a + g.count, 0), min: nums[0] ?? null, max: nums[nums.length - 1] ?? null, total: nums.length }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/notas]', error);
    return NextResponse.json({ error: 'No se pudo revisar las notas' }, { status: 500 });
  }
}
