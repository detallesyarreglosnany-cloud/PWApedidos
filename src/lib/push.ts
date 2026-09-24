import webpush from 'web-push';
import { db } from '@/lib/db';

// Notificaciones push (llegan con la app cerrada o la pantalla bloqueada).
// Las claves VAPID las genera el servidor la primera vez y las guarda en la
// base de datos: no hay que configurar nada en Vercel.

export type PushMsg = { title: string; body: string; tag: string };

let vapid: { publicKey: string; privateKey: string } | null = null;

export async function getVapid() {
  if (vapid) return vapid;
  const read = () => db.distSetting.findUnique({ where: { name: 'vapid' } });
  let row = await read();
  if (!row) {
    const keys = webpush.generateVAPIDKeys();
    // Si dos peticiones las generan a la vez, se queda la primera que se guardó
    await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES ('vapid', ${JSON.stringify(keys)}) ON CONFLICT ("name") DO NOTHING`;
    row = await read();
  }
  vapid = JSON.parse(row!.value);
  return vapid!;
}

/** Envía cada mensaje a todos los equipos suscritos a ese rol (y vendedor). Borra las suscripciones vencidas. */
export async function sendPush(role: 'office' | 'seller', sellerId: string | null, msgs: PushMsg[]) {
  if (!msgs.length) return;
  const subs = await db.distPush.findMany({ where: role === 'seller' ? { role, sellerId } : { role } });
  if (!subs.length) return;
  const keys = await getVapid();
  webpush.setVapidDetails('mailto:soporte@puertovenado.app', keys.publicKey, keys.privateKey);
  const dead: { endpoint: string; role: string }[] = [];
  await Promise.allSettled(subs.flatMap((s) => msgs.map(async (m) => {
    try {
      await webpush.sendNotification(JSON.parse(s.data), JSON.stringify(m), { TTL: 6 * 3600, urgency: 'high', timeout: 8000 });
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      // 404/410: suscripción vencida · 403: firmada con otras claves (inútil ya)
      if (code === 404 || code === 410 || code === 403) dead.push({ endpoint: s.endpoint, role: s.role });
      else console.warn('[push]', code, (e as Error).message);
    }
  })));
  for (const d of dead) await db.distPush.deleteMany({ where: d });
}
