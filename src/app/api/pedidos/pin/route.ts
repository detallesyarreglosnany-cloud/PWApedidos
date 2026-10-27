import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdmin, syncOk } from '@/lib/keys';
import { blockDevice, blockedDevices, contacts, createPin, isBlocked, isPinFormat, pinInfo, resetPin, tokenOk, unblockDevice, verifyPin, weakPin } from '@/lib/pin';

// PIN personal del vendedor (voluntario).
// POST /api/pedidos/pin
//   Teléfono (clave de sync):
//     { action: 'status', sellerId, token? }        → { hasPin, tokenOk }
//     { action: 'create', sellerId, pin, deviceId } → { token }   (solo si aún no tiene PIN)
//     { action: 'verify', sellerId, pin, deviceId } → { token }
//   Oficina (clave admin):
//     { action: 'list' }                             → { sellers: [{ sellerId, hasPin, since, devices }], contacts: [...] }
//     { action: 'reset', sellerId }                  → { ok }     (olvidó el PIN: se borra y crea uno nuevo)
//     { action: 'block' | 'unblock', sellerId, device } → { ok }   (teléfono perdido: no puede usar ese vendedor)

export const dynamic = 'force-dynamic';
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const NO_STORE = { 'Cache-Control': 'no-store' };

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const action = body.action, sellerId = str(body.sellerId, 120), device = str(body.deviceId, 80) || 'equipo';
  try {
    if (action === 'list' || action === 'reset' || action === 'block' || action === 'unblock') {
      const denied = requireAdmin(req);
      if (denied) return denied;
      if (action === 'block' || action === 'unblock') {
        const dev = str(body.device, 80);
        if (!sellerId || !dev) return NextResponse.json({ error: 'Falta el vendedor o el equipo' }, { status: 400 });
        if (action === 'block') await blockDevice(sellerId, dev); else await unblockDevice(sellerId, dev);
        return NextResponse.json({ ok: true });
      }
      if (action === 'reset') {
        if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
        await resetPin(sellerId);
        return NextResponse.json({ ok: true });
      }
      const ids = (await db.distDoc.findMany({ where: { kind: 'sellers', deleted: false }, select: { id: true } })).map((r) => r.id);
      const sellers = await Promise.all(ids.map(async (id) => ({ sellerId: id, ...(await pinInfo(id)), blocked: await blockedDevices(id) })));
      return NextResponse.json({ sellers, contacts: await contacts() }, { headers: NO_STORE });
    }
    if (!sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
    if (action === 'status') {
      const info = await pinInfo(sellerId);
      if (await isBlocked(sellerId, device)) return NextResponse.json({ hasPin: info.hasPin, tokenOk: false, blocked: true }, { headers: NO_STORE });
      return NextResponse.json({ hasPin: info.hasPin, tokenOk: info.hasPin ? await tokenOk(sellerId, str(body.token, 200)) : false }, { headers: NO_STORE });
    }
    if (action === 'create' || action === 'verify') {
      const pin = body.pin;
      if (!isPinFormat(pin)) return NextResponse.json({ error: 'El PIN son 4 a 6 números' }, { status: 400 });
      if (action === 'create' && weakPin(pin)) return NextResponse.json({ error: 'Ese PIN es muy fácil de adivinar (ej. 1234 o 0000). Elige otro.' }, { status: 400 });
      const r = action === 'create' ? await createPin(sellerId, pin, device) : await verifyPin(sellerId, pin, device);
      if ('error' in r) return NextResponse.json(r, { status: 'blocked' in r || action === 'verify' ? 403 : 409 });
      return NextResponse.json(r, { headers: NO_STORE });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/pin]', error);
    return NextResponse.json({ error: 'No se pudo completar' }, { status: 500 });
  }
}
