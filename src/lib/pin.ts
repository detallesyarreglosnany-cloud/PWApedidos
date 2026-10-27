import { NextRequest } from 'next/server';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { db } from '@/lib/db';

// PIN personal del vendedor (voluntario). Se guarda solo su huella (scrypt + sal) en la tabla de ajustes;
// al validarlo, el teléfono recibe un permiso propio (token) que queda recordado: «teléfono de confianza».
// Si el vendedor NO tiene PIN, nada cambia para él. Los pedidos nunca dependen del PIN.
//   pin:<vendedor>      { salt, hash, at }
//   pintok:<vendedor>   { tokens: [{ h, device, at }] }   (huellas sha256 de los permisos, máx. 10)
//   pinfail:<vendedor>  { n, until }                       (5 intentos fallidos → 10 minutos de espera)
//   pinblock:<vendedor> { devices: [id] }                  (teléfonos bloqueados por la oficina: p. ej. uno perdido)

type PinRow = { salt: string; hash: string; at: string };
type TokRow = { tokens: { h: string; device: string; at: string }[] };
type FailRow = { n: number; until?: string };

async function getSetting<T>(name: string): Promise<T | null> {
  const r = await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "DistSetting" WHERE "name" = ${name}`;
  if (!r[0]) return null;
  try { return JSON.parse(r[0].value) as T; } catch { return null; }
}
async function putSetting(name: string, value: unknown) {
  const v = JSON.stringify(value);
  await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${name}, ${v}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
}
async function delSetting(name: string) { await db.$executeRaw`DELETE FROM "DistSetting" WHERE "name" = ${name}`; }

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const hashPin = (pin: string, salt: string) => scryptSync(pin, salt, 32).toString('hex');

export const isPinFormat = (p: unknown): p is string => typeof p === 'string' && /^\d{4,6}$/.test(p);
/** 0000, 1111, 1234, 4321… son fáciles de adivinar. */
export function weakPin(p: string) {
  if (/^(\d)\1+$/.test(p)) return true;
  const up = '0123456789', down = '9876543210';
  return up.includes(p) || down.includes(p);
}

type BlockRow = { devices: string[] };
export async function blockedDevices(sellerId: string) { return ((await getSetting<BlockRow>(`pinblock:${sellerId}`)) || { devices: [] }).devices; }
export async function isBlocked(sellerId: string, device: string) { return (await blockedDevices(sellerId)).includes(device); }
/** La oficina bloquea un teléfono (perdido o robado): pierde su permiso y no puede usar ese vendedor. */
export async function blockDevice(sellerId: string, device: string) {
  const list = await blockedDevices(sellerId);
  if (!list.includes(device)) await putSetting(`pinblock:${sellerId}`, { devices: list.concat(device).slice(-50) });
  const t = await getSetting<TokRow>(`pintok:${sellerId}`);
  if (t) await putSetting(`pintok:${sellerId}`, { tokens: t.tokens.filter((x) => x.device !== device) });
}
export async function unblockDevice(sellerId: string, device: string) {
  const list = await blockedDevices(sellerId);
  await putSetting(`pinblock:${sellerId}`, { devices: list.filter((d) => d !== device) });
}

export async function hasPin(sellerId: string) { return !!(await getSetting<PinRow>(`pin:${sellerId}`)); }
export async function pinInfo(sellerId: string) {
  const p = await getSetting<PinRow>(`pin:${sellerId}`), t = await getSetting<TokRow>(`pintok:${sellerId}`);
  return { hasPin: !!p, since: p ? p.at : null, devices: t ? t.tokens.length : 0 };
}

async function issueToken(sellerId: string, device: string) {
  const token = randomBytes(24).toString('base64url');
  const cur = (await getSetting<TokRow>(`pintok:${sellerId}`)) || { tokens: [] };
  const tokens = cur.tokens.filter((x) => x.device !== device).concat({ h: sha(token), device: device.slice(0, 80), at: new Date().toISOString() }).slice(-10);
  await putSetting(`pintok:${sellerId}`, { tokens });
  return token;
}

/** Crea el PIN (solo si el vendedor no tiene uno). Devuelve el permiso de este teléfono. */
export async function createPin(sellerId: string, pin: string, device: string) {
  if (await isBlocked(sellerId, device)) return { error: 'La oficina desconectó este teléfono.', blocked: true };
  if (await hasPin(sellerId)) return { error: 'Ya tienes un PIN. Si lo olvidaste, pide a la oficina que lo restablezca.' };
  const salt = randomBytes(16).toString('hex');
  await putSetting(`pin:${sellerId}`, { salt, hash: hashPin(pin, salt), at: new Date().toISOString() });
  await delSetting(`pinfail:${sellerId}`);
  return { token: await issueToken(sellerId, device) };
}

/** Valida el PIN (con espera tras 5 intentos fallidos). */
export async function verifyPin(sellerId: string, pin: string, device: string) {
  if (await isBlocked(sellerId, device)) return { error: 'La oficina desconectó este teléfono.', blocked: true };
  const p = await getSetting<PinRow>(`pin:${sellerId}`);
  if (!p) return { error: 'Este vendedor no tiene PIN.', noPin: true };
  const f = (await getSetting<FailRow>(`pinfail:${sellerId}`)) || { n: 0 };
  if (f.until && Date.parse(f.until) > Date.now()) return { error: 'Demasiados intentos. Espera unos minutos o pide a la oficina que restablezca tu PIN.', locked: true };
  const a = Buffer.from(hashPin(pin, p.salt), 'hex'), b = Buffer.from(p.hash, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    const n = (f.until && Date.parse(f.until) <= Date.now() ? 0 : f.n) + 1;
    await putSetting(`pinfail:${sellerId}`, n >= 5 ? { n, until: new Date(Date.now() + 10 * 60000).toISOString() } : { n });
    return { error: n >= 5 ? 'PIN incorrecto. Demasiados intentos: espera 10 minutos.' : `PIN incorrecto (${n} de 5 intentos).` };
  }
  await delSetting(`pinfail:${sellerId}`);
  return { token: await issueToken(sellerId, device) };
}

export async function tokenOk(sellerId: string, token: string) {
  if (!token) return false;
  const t = await getSetting<TokRow>(`pintok:${sellerId}`);
  if (!t) return false;
  const h = Buffer.from(sha(token), 'hex');
  return t.tokens.some((x) => { const y = Buffer.from(x.h, 'hex'); return y.length === h.length && timingSafeEqual(y, h); });
}

/** La oficina borra el PIN (el vendedor lo olvidó): crea uno nuevo al entrar. Los teléfonos bloqueados siguen bloqueados. */
export async function resetPin(sellerId: string) {
  await delSetting(`pin:${sellerId}`); await delSetting(`pintok:${sellerId}`); await delSetting(`pinfail:${sellerId}`);
}

/**
 * Para las consultas privadas del vendedor (Mi quincena, metas, actividad de clientes):
 * si el vendedor tiene PIN, hace falta el permiso de un teléfono de confianza. Sin PIN, todo sigue como antes.
 */
export async function sellerAccessOk(req: NextRequest, sellerId: string) {
  if (!(await hasPin(sellerId))) return true;
  return tokenOk(sellerId, req.headers.get('x-seller-token') || '');
}

/** Último contacto de cada teléfono de vendedor con el servidor (para ver quién trabaja sin señal). */
export async function recordContact(sellerId: string, device: string, info: { pending: number; ua: string }) {
  await putSetting(`contacto:${sellerId}:${device.slice(0, 80)}`, { at: new Date().toISOString(), pending: info.pending, ua: info.ua });
}
export async function contacts() {
  const rows = await db.$queryRaw<{ name: string; value: string }[]>`SELECT "name", "value" FROM "DistSetting" WHERE "name" LIKE 'contacto:%'`;
  return rows.map((r) => {
    const [, sellerId, ...dev] = r.name.split(':');
    let v: { at?: string; pending?: number; ua?: string } = {};
    try { v = JSON.parse(r.value); } catch { /* noop */ }
    return { sellerId, device: dev.join(':'), at: v.at || '', pending: Number(v.pending) || 0, ua: v.ua || '' };
  });
}
