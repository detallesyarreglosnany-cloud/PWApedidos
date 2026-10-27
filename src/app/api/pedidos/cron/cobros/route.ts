// Aviso diario de cobros (Vercel Cron, una vez al día en la mañana de Venezuela).
// A cada vendedor le llega al teléfono, aunque no abra la app: lo que vence mañana, lo que vence hoy y lo atrasado.
// A la oficina, el resumen de la cartera. Solo se envía una vez por día (marca en DistSetting).
// Acceso: con CRON_SECRET configurado, Vercel manda «Authorization: Bearer <CRON_SECRET>»; sin él, solo el cron de Vercel.
import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { cartera } from '@/lib/cartera';
import { vzDay } from '@/lib/cobranza';
import { sendPush } from '@/lib/push';

export const dynamic = 'force-dynamic';

const names = (arr: { clientName: string }[], max = 6) => { const u = [...new Set(arr.map((n) => n.clientName))]; return u.slice(0, max).join(', ') + (u.length > max ? ` y ${u.length - max} más` : ''); };
const usd = (n: number) => '$' + (Math.round(n * 100) / 100).toFixed(2).replace('.', ',');

export async function GET(req: NextRequest) {
  const secret = process.env.CRON_SECRET || '';
  const okAuth = secret ? req.headers.get('authorization') === `Bearer ${secret}` : (req.headers.get('user-agent') || '').includes('vercel-cron');
  if (!okAuth) return NextResponse.json({ error: 'No autorizado' }, { status: 401 });
  const hoy = vzDay(new Date().toISOString()), mark = `cron:cobros:${hoy}`, now = new Date().toISOString();
  const first = await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${mark}, ${now}) ON CONFLICT ("name") DO NOTHING`;
  if (!first) return NextResponse.json({ ok: true, skipped: 'ya se envió hoy' });
  const srows = await db.distDoc.findMany({ where: { kind: 'sellers', deleted: false }, select: { data: true } });
  const sellers = srows.map((r) => JSON.parse(r.data) as { id: string; name?: string; active?: boolean }).filter((s) => s.id && s.active !== false);
  const sent: { seller: string; notas: number }[] = [];
  for (const s of sellers) {
    try {
      const c = await cartera(s.id);
      const man = c.notas.filter((n) => n.dias === 1), hoyN = c.notas.filter((n) => n.dias === 0), atr = c.notas.filter((n) => n.dias < 0);
      if (!man.length && !hoyN.length && !atr.length) continue;
      const parts = [hoyN.length ? `⏰ Vence HOY: ${names(hoyN)}` : '', man.length ? `📅 Vence mañana: ${names(man)}` : '', atr.length ? `🚩 Atrasados: ${names(atr, 4)}` : ''].filter(Boolean);
      await sendPush('seller', s.id, [{ title: '📅 Cobros de hoy', body: (parts.join(' · ') + '. Toca «Cobrar» para enviarles el detalle por WhatsApp.').slice(0, 300), tag: `cobros-${hoy}` }]);
      sent.push({ seller: s.name || s.id, notas: man.length + hoyN.length + atr.length });
    } catch (e) { console.warn('[cron cobros]', s.id, e); }
  }
  try {
    const all = await cartera('');
    const total = all.notas.reduce((a, n) => a + n.resta, 0), atr = all.notas.filter((n) => n.dias < 0);
    if (all.notas.length) await sendPush('office', null, [{ title: '📅 Cartera de hoy', body: `Por cobrar ${usd(total)} · vencido ${usd(atr.reduce((a, n) => a + n.resta, 0))} (${new Set(atr.map((n) => n.clientId)).size} clientes atrasados)`, tag: `cartera-${hoy}` }]);
  } catch (e) { console.warn('[cron cobros] oficina', e); }
  return NextResponse.json({ ok: true, hoy, sent });
}
