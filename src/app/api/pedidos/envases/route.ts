import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { Prisma } from '@prisma/client';
import { isAdminReq, requireAdmin, requireReader, syncOk } from '@/lib/keys';
import { CANCEL_KINDS, LIQ_KINDS, MANUAL_KINDS, ensureKardex, insertMovs, newMovId, reconcileAll, type VacMov } from '@/lib/vacios';

// Kardex de vacíos (Fase 2 · E4).
//
// POST /api/pedidos/envases
//   { action: 'list', clientId? }        → { movs }   (oficina o supervisor)
//       Antes de responder pone al día los renglones de las liquidaciones.
//   { action: 'add', mov }               → { mov }    (oficina) devolución, apertura…
//   { action: 'anular', id, motivo }     → { mov }    (oficina) cancela un renglón manual
//   { action: 'import', movs }           → { added }  (oficina) restaurar un respaldo
//   { action: 'mine', sellerId }         → { movs }   (teléfono del vendedor, clave de sync) kardex de SUS clientes
//
// Los renglones nunca se editan ni se borran (disparador en la base).

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const MAX_LIST = 50000;
const ALL_KINDS: readonly string[] = [...LIQ_KINDS, ...MANUAL_KINDS, ...CANCEL_KINDS];
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);

function cleanMov(raw: Record<string, unknown>, kinds: readonly string[]): VacMov | string {
  const kind = str(raw.kind, 30);
  if (!kinds.includes(kind)) return 'Tipo de movimiento inválido';
  const qty = Math.round(Number(raw.qty));
  if (!Number.isFinite(qty) || qty < 1 || qty > 100000) return 'Cantidad inválida';
  const clientId = str(raw.clientId, 120), type = str(raw.type, 40);
  if (!clientId) return 'Falta el cliente';
  if (!type) return 'Falta el tipo de envase';
  if (!isDay(raw.date)) return 'Fecha inválida';
  return {
    id: str(raw.id, 200), date: raw.date, kind, clientId, clientName: str(raw.clientName) || clientId,
    sellerId: str(raw.sellerId, 120), sellerName: str(raw.sellerName), type, pid: str(raw.pid, 120), code: str(raw.code, 40), qty,
    orderId: str(raw.orderId, 200) || null, loadId: str(raw.loadId, 200) || null, refId: str(raw.refId, 220) || null,
    motivo: str(raw.motivo, 300), by: str(raw.by, 80) || 'Oficina',
    data: typeof raw.data === 'string' ? raw.data.slice(0, 2000) : JSON.stringify(raw.data || {}).slice(0, 2000),
  };
}

const out = (m: VacMov) => ({ ...m, at: m.at instanceof Date ? m.at.toISOString() : m.at });

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const action = body.action;
  // 'mine': el teléfono de un vendedor lee el kardex de SUS clientes (solo lectura, con la clave de sincronización)
  if (action === 'mine') {
    if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
    const sellerId = str(body.sellerId, 120);
    if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
    try {
      await ensureKardex();
      const mine = await db.$queryRaw<{ clientId: string }[]>`SELECT DISTINCT "clientId" FROM "DistVacMov" WHERE "sellerId" = ${sellerId}`;
      if (!mine.length) return NextResponse.json({ movs: [], sellerId });
      const ids = mine.map((m) => m.clientId);
      // Un cliente que cambió de vendedor lo ve solo su vendedor actual (el del último movimiento)
      const last = await db.$queryRaw<{ clientId: string; sellerId: string }[]>`
        SELECT DISTINCT ON ("clientId") "clientId", "sellerId" FROM "DistVacMov" WHERE "clientId" IN (${Prisma.join(ids)})
        ORDER BY "clientId", "date" DESC, "at" DESC`;
      const keep = last.filter((l) => l.sellerId === sellerId).map((l) => l.clientId);
      const movs = keep.length ? await db.distVacMov.findMany({ where: { clientId: { in: keep } }, orderBy: [{ date: 'asc' }, { at: 'asc' }, { id: 'asc' }], take: MAX_LIST }) : [];
      return NextResponse.json({ movs: movs.map(out), sellerId });
    } catch (error) {
      console.error('[pedidos/envases mine]', error);
      return NextResponse.json({ error: 'Error del kardex de vacíos' }, { status: 500 });
    }
  }
  const denied = action === 'list' ? requireReader(req) : requireAdmin(req);
  if (denied) return denied;
  try {
    await ensureKardex();
    if (action === 'list') {
      const fix = await reconcileAll();
      const clientId = str(body.clientId, 120);
      const movs = await db.distVacMov.findMany({ where: clientId ? { clientId } : undefined, orderBy: [{ date: 'asc' }, { at: 'asc' }, { id: 'asc' }], take: MAX_LIST });
      return NextResponse.json({ movs: movs.map(out), fix, canWrite: isAdminReq(req) });
    }
    if (action === 'add') {
      const m = cleanMov((body.mov || {}) as Record<string, unknown>, MANUAL_KINDS);
      if (typeof m === 'string') return NextResponse.json({ error: m }, { status: 400 });
      if (m.refId) {
        const ref = await db.distVacMov.findUnique({ where: { id: m.refId } });
        if (!ref || ref.kind !== 'despacho' || ref.clientId !== m.clientId) return NextResponse.json({ error: 'El despacho elegido no es de este cliente' }, { status: 400 });
      }
      m.id = newMovId('m');
      await insertMovs([m]);
      const saved = await db.distVacMov.findUnique({ where: { id: m.id } });
      return NextResponse.json({ mov: saved ? out(saved) : m });
    }
    if (action === 'anular') {
      const id = str(body.id, 220), motivo = str(body.motivo, 300);
      if (!motivo) return NextResponse.json({ error: 'Falta el motivo' }, { status: 400 });
      const ref = await db.distVacMov.findUnique({ where: { id } });
      if (!ref) return NextResponse.json({ error: 'No existe ese movimiento' }, { status: 404 });
      if (!(MANUAL_KINDS as readonly string[]).includes(ref.kind)) {
        return NextResponse.json({ error: 'Los movimientos de una liquidación se corrigen reabriendo la liquidación' }, { status: 400 });
      }
      const m: VacMov = { ...ref, id: 'anu:' + id, kind: 'anulacion', refId: id, date: new Date().toISOString().slice(0, 10), motivo, by: str(body.by, 80) || 'Oficina', data: '{}' };
      const n = await insertMovs([m]);
      if (!n) return NextResponse.json({ error: 'Ese movimiento ya estaba anulado' }, { status: 409 });
      const saved = await db.distVacMov.findUnique({ where: { id: m.id } });
      return NextResponse.json({ mov: saved ? out(saved) : m });
    }
    if (action === 'import') {
      const list = Array.isArray(body.movs) ? body.movs.slice(0, MAX_LIST) : [];
      const ok: VacMov[] = [];
      for (const raw of list) {
        const m = cleanMov((raw || {}) as Record<string, unknown>, ALL_KINDS);
        if (typeof m !== 'string' && m.id) ok.push(m);
      }
      const added = await insertMovs(ok);
      return NextResponse.json({ added, skipped: list.length - added });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/envases]', error);
    return NextResponse.json({ error: 'Error del kardex de vacíos' }, { status: 500 });
  }
}
