import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getVapid } from '@/lib/push';
import { isAdminReq, syncOk } from '@/lib/keys';

// Suscripción de un equipo a las notificaciones push.
//
// POST /api/pedidos/push
//   { action: 'key' }                                   → { publicKey }
//   { action: 'subscribe', role, sellerId, subscription } (oficina: clave admin)
//   { action: 'unsubscribe', role, endpoint }

export const dynamic = 'force-dynamic';

type Sub = { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };

// Solo servicios push reales de los navegadores: el servidor nunca hace
// peticiones a una URL arbitraria que alguien registre.
const PUSH_HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', 'updates.push.services.mozilla.com', 'push.services.mozilla.com',
  'notify.windows.com', 'push.apple.com']
  .concat((process.env.PEDIDOS_PUSH_EXTRA_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean));
const MAX_PER_SELLER = 10;

function allowedHost(url: string) {
  try {
    const h = new URL(url).hostname;
    return PUSH_HOSTS.some((a) => h === a || h.endsWith('.' + a));
  } catch { return false; }
}

function validSub(s: Sub | undefined): s is { endpoint: string; keys: { p256dh: string; auth: string } } {
  return !!s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 && allowedHost(s.endpoint) &&
    !!s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string' &&
    s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
}

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: { action?: string; role?: string; sellerId?: unknown; subscription?: Sub; endpoint?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const role = body.role === 'office' ? 'office' : 'seller';
  try {
    if (body.action === 'key') return NextResponse.json({ publicKey: (await getVapid()).publicKey });

    if (body.action === 'subscribe') {
      if (role === 'office' && !isAdminReq(req)) return NextResponse.json({ error: 'Solo la oficina (clave admin)' }, { status: 401 });
      const sellerId = typeof body.sellerId === 'string' && body.sellerId.length < 120 ? body.sellerId : null;
      if (role === 'seller' && !sellerId) return NextResponse.json({ error: 'Falta el vendedor' }, { status: 400 });
      if (!validSub(body.subscription)) return NextResponse.json({ error: 'Suscripción inválida' }, { status: 400 });
      const sub = body.subscription;
      const data = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
      await db.distPush.upsert({
        where: { endpoint_role: { endpoint: sub.endpoint, role } },
        create: { endpoint: sub.endpoint, role, sellerId: role === 'seller' ? sellerId : null, data },
        update: { sellerId: role === 'seller' ? sellerId : null, data },
      });
      // Tope por vendedor: se quedan los equipos más recientes
      const same = await db.distPush.findMany({ where: role === 'seller' ? { role, sellerId } : { role }, orderBy: { updatedAt: 'desc' }, skip: MAX_PER_SELLER * (role === 'office' ? 3 : 1) });
      for (const x of same) await db.distPush.deleteMany({ where: { endpoint: x.endpoint, role: x.role } });
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'unsubscribe' && typeof body.endpoint === 'string') {
      if (role === 'office' && !isAdminReq(req)) return NextResponse.json({ error: 'Solo la oficina (clave admin)' }, { status: 401 });
      await db.distPush.deleteMany({ where: { endpoint: body.endpoint, role } });
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (error) {
    console.error('[pedidos/push]', error);
    return NextResponse.json({ error: 'No se pudo registrar el aviso' }, { status: 500 });
  }
}
