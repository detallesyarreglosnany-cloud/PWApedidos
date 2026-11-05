import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin, safeEqual } from '@/lib/keys';
import { db } from '@/lib/db';
import { createPin, hasPin, isPinFormat, resetPin, tokenOk, verifyPin, weakPin } from '@/lib/pin';
import { OWNER_PIN_ID } from '@/lib/owner';

// PIN de seguridad y registros ocultos del Historial (solo la oficina: clave admin).
// Un registro oculto NO se borra: queda en la base marcado (deleted + hidden) y deja de verse en
// todas las PCs; solo con el PIN se ve en la «Papelera del historial» y se puede restaurar.
//
// POST /api/pedidos/historial
//   { action: 'estado' }                        → { hasPin, ok }    (ok: este equipo tiene permiso vigente)
//   { action: 'crear', pin, deviceId }          → { token }         (solo si aún no hay PIN)
//   { action: 'entrar', pin, deviceId }         → { token }
//   { action: 'cambiar', pin, deviceId }        (x-owner-token) → { token }
//   { action: 'ocultar' | 'restaurar', ids[] }  (x-owner-token) → { ok, ids }
//   { action: 'restablecer', key }              (clave PEDIDOS_OWNER_KEY de Vercel: se olvidó el PIN)

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };
const MAX_IDS = 200;

export async function POST(req: NextRequest) {
  const denied = requireAdmin(req);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const device = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : 'equipo';
  const pin = body.pin, action = body.action;
  const tok = req.headers.get('x-owner-token') || '';
  try {
    if (action === 'estado') {
      return NextResponse.json({ hasPin: await hasPin(OWNER_PIN_ID), ok: await tokenOk(OWNER_PIN_ID, tok) }, { headers: NO_STORE });
    }
    if (action === 'crear') {
      if (!isPinFormat(pin)) return NextResponse.json({ error: 'El PIN es de 4 a 6 números' }, { status: 400 });
      if (weakPin(pin)) return NextResponse.json({ error: 'PIN muy fácil (1234, 0000…): elige otro' }, { status: 400 });
      const r = await createPin(OWNER_PIN_ID, pin, device);
      return 'error' in r ? NextResponse.json({ error: 'Ya existe el PIN de seguridad' }, { status: 409 }) : NextResponse.json(r, { headers: NO_STORE });
    }
    if (action === 'entrar') {
      if (!isPinFormat(pin)) return NextResponse.json({ error: 'El PIN es de 4 a 6 números' }, { status: 400 });
      const r = await verifyPin(OWNER_PIN_ID, pin, device);
      return 'error' in r ? NextResponse.json({ error: r.error }, { status: 'locked' in r && r.locked ? 429 : 401 }) : NextResponse.json(r, { headers: NO_STORE });
    }
    if (action === 'cambiar') {
      if (!(await tokenOk(OWNER_PIN_ID, tok))) return NextResponse.json({ error: 'Entra primero con el PIN actual' }, { status: 401 });
      if (!isPinFormat(pin) || weakPin(pin)) return NextResponse.json({ error: 'Elige un PIN de 4 a 6 números que no sea fácil' }, { status: 400 });
      await resetPin(OWNER_PIN_ID);
      return NextResponse.json(await createPin(OWNER_PIN_ID, pin, device), { headers: NO_STORE });
    }
    if (action === 'restablecer') {
      const k = process.env.PEDIDOS_OWNER_KEY || '';
      if (!k || typeof body.key !== 'string' || !safeEqual(body.key, k)) return NextResponse.json({ error: 'Clave de restablecimiento inválida' }, { status: 401 });
      await resetPin(OWNER_PIN_ID);
      return NextResponse.json({ ok: true });
    }
    if (action === 'ocultar' || action === 'restaurar') {
      if (!(await tokenOk(OWNER_PIN_ID, tok))) return NextResponse.json({ error: 'PIN de seguridad requerido', pin: true }, { status: 401 });
      const ids = (Array.isArray(body.ids) ? body.ids : []).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 120).slice(0, MAX_IDS);
      if (!ids.length) return NextResponse.json({ error: 'Faltan los registros' }, { status: 400 });
      const hide = action === 'ocultar', at = new Date().toISOString(), done: string[] = [];
      const rows = await db.distDoc.findMany({ where: { kind: 'events', id: { in: ids } } });
      for (const r of rows) {
        let d: Record<string, unknown>;
        try { d = JSON.parse(r.data) as Record<string, unknown>; } catch { continue; }
        if (hide) { d.hidden = true; d.hiddenAt = at; d.deleted = true; }
        else { delete d.hidden; delete d.hiddenAt; delete d.deleted; d.restoredAt = at; }
        d.updatedAt = at;
        // syncedAt (@updatedAt) avanza solo: las demás PCs de oficina bajan el cambio en su próxima sincronización
        await db.distDoc.update({ where: { kind_id: { kind: 'events', id: r.id } }, data: { data: JSON.stringify(d), deleted: hide, updatedAt: at } });
        done.push(r.id);
      }
      return NextResponse.json({ ok: true, ids: done, at });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/historial]', error);
    return NextResponse.json({ error: 'No se pudo procesar' }, { status: 500 });
  }
}
