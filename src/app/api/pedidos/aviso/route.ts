import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { safeEqual } from '@/lib/keys';

// Aviso de suscripción / prueba gratuita (cinta que se desplaza en todas las pantallas).
//
// GET  /api/pedidos/aviso → { active, endsAt, message, contact, today }   (sin claves: solo la fecha y un texto)
// POST /api/pedidos/aviso  body: { key, off?, endsAt?, message?, contact?, reset? }
//      Solo con la clave del DESARROLLADOR (PEDIDOS_DEV_KEY), distinta de la clave de la oficina:
//      así quien usa la app no puede apagar el aviso. Se guarda en la base: no hace falta volver a publicar.
//
// Valores por omisión (si no se configuró nada): variables PEDIDOS_TRIAL_END (AAAA-MM-DD), PEDIDOS_TRIAL_MESSAGE,
// PEDIDOS_TRIAL_CONTACT y PEDIDOS_TRIAL_OFF=1; si tampoco existen, el fin de la prueba por omisión de abajo.

export const dynamic = 'force-dynamic';

const DEFAULT_END = '2026-10-06';
const DEFAULT_CONTACT = 'Daniela Silva';
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const clean = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

type Cfg = { off: boolean; endsAt: string; message: string; contact: string };

function envCfg(): Cfg {
  const end = process.env.PEDIDOS_TRIAL_END || '';
  return {
    off: process.env.PEDIDOS_TRIAL_OFF === '1',
    endsAt: isDay(end) ? end : DEFAULT_END,
    message: clean(process.env.PEDIDOS_TRIAL_MESSAGE, 400),
    contact: clean(process.env.PEDIDOS_TRIAL_CONTACT, 80) || DEFAULT_CONTACT,
  };
}

async function stored(): Promise<Partial<Cfg>> {
  try {
    const r = await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "DistSetting" WHERE "name" = 'trial'`;
    return r[0] ? (JSON.parse(r[0].value) as Partial<Cfg>) : {};
  } catch { return {}; }
}

const caracasDay = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

async function current(): Promise<Cfg> {
  const e = envCfg(), s = await stored();
  return {
    off: typeof s.off === 'boolean' ? s.off : e.off,
    endsAt: isDay(s.endsAt) ? s.endsAt : e.endsAt,
    message: typeof s.message === 'string' ? s.message : e.message,
    contact: typeof s.contact === 'string' && s.contact ? s.contact : e.contact,
  };
}

export async function GET() {
  const c = await current();
  return NextResponse.json({ active: !c.off, endsAt: c.endsAt, message: c.message, contact: c.contact, today: caracasDay() }, { headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const devKey = process.env.PEDIDOS_DEV_KEY || '';
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  if (!devKey || typeof body.key !== 'string' || !safeEqual(body.key, devKey)) return NextResponse.json({ error: 'Clave del desarrollador inválida' }, { status: 401 });
  try {
    let next: Partial<Cfg> = body.reset ? {} : await stored();
    if (typeof body.off === 'boolean') next = { ...next, off: body.off };
    if (body.endsAt !== undefined) { if (!isDay(body.endsAt)) return NextResponse.json({ error: 'endsAt debe ser AAAA-MM-DD' }, { status: 400 }); next = { ...next, endsAt: body.endsAt }; }
    if (body.message !== undefined) next = { ...next, message: clean(body.message, 400) };
    if (body.contact !== undefined) next = { ...next, contact: clean(body.contact, 80) };
    await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES ('trial', ${JSON.stringify(next)}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
    const c = await current();
    return NextResponse.json({ ok: true, active: !c.off, endsAt: c.endsAt, message: c.message, contact: c.contact });
  } catch (error) {
    console.error('[pedidos/aviso]', error);
    return NextResponse.json({ error: 'No se pudo guardar' }, { status: 500 });
  }
}
