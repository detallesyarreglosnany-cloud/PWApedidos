import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';
import { isAdminReq, syncOk } from '@/lib/keys';
import { createPin, hasPin, isPinFormat, resetPin, tokenOk, verifyPin, weakPin } from '@/lib/pin';
import { MKT_PIN_ID } from '@/lib/mktpin';

// PIN de «Promoción y marketing»: solo quien tiene el PIN construye la sección (vitrinas, banners, mezclas, combos,
// campaña y lanzamiento). Usa el mismo resguardo que el PIN de los vendedores (huella scrypt, permiso por equipo,
// 5 intentos fallidos → espera). Gerencia sin PIN solo puede autorizar o rechazar combos.
//
// POST /api/pedidos/marketing
//   { action: 'estado' }                         → { hasPin, ok }   (ok: este equipo tiene permiso vigente)
//   { action: 'crear', pin, deviceId }           (clave admin; solo si aún no hay PIN) → { token }
//   { action: 'entrar', pin, deviceId }          → { token }
//   { action: 'cambiar', pin, deviceId }         (con permiso vigente: x-mkt-token) → { token }
//   { action: 'restablecer', key }               (clave del desarrollador: se olvidó el PIN)

export const dynamic = 'force-dynamic';
const safeEqual = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const device = typeof body.deviceId === 'string' ? body.deviceId.slice(0, 80) : 'equipo';
  const pin = body.pin;
  try {
    if (body.action === 'estado') {
      const has = await hasPin(MKT_PIN_ID);
      return NextResponse.json({ hasPin: has, ok: !has || (await tokenOk(MKT_PIN_ID, req.headers.get('x-mkt-token') || '')) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (body.action === 'crear') {
      if (!isAdminReq(req)) return NextResponse.json({ error: 'Se crea desde la oficina (clave admin)' }, { status: 401 });
      if (!isPinFormat(pin)) return NextResponse.json({ error: 'El PIN es de 4 a 6 números' }, { status: 400 });
      if (weakPin(pin)) return NextResponse.json({ error: 'PIN muy fácil (1234, 0000…): elige otro' }, { status: 400 });
      const r = await createPin(MKT_PIN_ID, pin, device);
      return 'error' in r ? NextResponse.json({ error: 'Ya hay un PIN para esta sección' }, { status: 409 }) : NextResponse.json(r);
    }
    if (body.action === 'entrar') {
      if (!isPinFormat(pin)) return NextResponse.json({ error: 'El PIN es de 4 a 6 números' }, { status: 400 });
      const r = await verifyPin(MKT_PIN_ID, pin, device);
      return 'error' in r ? NextResponse.json({ error: r.error }, { status: 'locked' in r && r.locked ? 429 : 401 }) : NextResponse.json(r);
    }
    if (body.action === 'cambiar') {
      if (!(await tokenOk(MKT_PIN_ID, req.headers.get('x-mkt-token') || ''))) return NextResponse.json({ error: 'Entra primero con el PIN actual' }, { status: 401 });
      if (!isPinFormat(pin) || weakPin(pin)) return NextResponse.json({ error: 'Elige un PIN de 4 a 6 números que no sea fácil' }, { status: 400 });
      await resetPin(MKT_PIN_ID);
      return NextResponse.json(await createPin(MKT_PIN_ID, pin, device));
    }
    if (body.action === 'restablecer') {
      const dev = process.env.PEDIDOS_DEV_KEY || '';
      if (!dev || typeof body.key !== 'string' || !safeEqual(body.key, dev)) return NextResponse.json({ error: 'Clave del desarrollador inválida' }, { status: 401 });
      await resetPin(MKT_PIN_ID);
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/marketing]', error);
    return NextResponse.json({ error: 'No se pudo procesar' }, { status: 500 });
  }
}
