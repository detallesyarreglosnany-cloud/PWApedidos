// Usuarios con rol y PIN (Gerencia y Cobranzas). Los crea la oficina; cada persona entra con su PIN y el servidor le da
// SOLO los permisos de su rol (no basta con ocultar botones). El PIN usa lo mismo que el de los vendedores (lib/pin):
// huella scrypt, 5 intentos y espera, permiso por teléfono, teléfonos bloqueados.
//   usuario:<id>  { id, name, role, active, at, by }      id empieza con «usr_»
import { NextRequest } from 'next/server';
import { randomBytes, scryptSync } from 'crypto';
import { db } from '@/lib/db';
import { isBlocked, tokenOk } from '@/lib/pin';

export type Role = 'gerencia' | 'cobranzas';
export const ROLES: Record<Role, string> = { gerencia: 'Gerencia', cobranzas: 'Cobranzas' };
export type Usuario = { id: string; name: string; role: Role; active: boolean; at: string; by: string };
export const isRole = (r: unknown): r is Role => r === 'gerencia' || r === 'cobranzas';

export async function getUser(id: string): Promise<Usuario | null> {
  if (!/^usr_[A-Za-z0-9_-]{6,60}$/.test(id)) return null;
  const r = await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "DistSetting" WHERE "name" = ${'usuario:' + id}`;
  try { return r[0] ? (JSON.parse(r[0].value) as Usuario) : null; } catch { return null; }
}
export async function listUsers(): Promise<Usuario[]> {
  const rows = await db.$queryRaw<{ value: string }[]>`SELECT "value" FROM "DistSetting" WHERE "name" LIKE 'usuario:%'`;
  return rows.map((r) => { try { return JSON.parse(r.value) as Usuario; } catch { return null; } }).filter((u): u is Usuario => !!u)
    .sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name, 'es'));
}
export async function putUser(u: Usuario) {
  const v = JSON.stringify(u);
  await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${'usuario:' + u.id}, ${v}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
}
export const newUserId = () => 'usr_' + randomBytes(9).toString('base64url');

/** La oficina pone el PIN de un usuario (al crearlo o al restablecerlo): los teléfonos con permiso deben volver a entrar. */
export async function setUserPin(id: string, pin: string) {
  const salt = randomBytes(16).toString('hex'), hash = scryptSync(pin, salt, 32).toString('hex');
  const v = JSON.stringify({ salt, hash, at: new Date().toISOString() });
  await db.$executeRaw`INSERT INTO "DistSetting" ("name", "value") VALUES (${'pin:' + id}, ${v}) ON CONFLICT ("name") DO UPDATE SET "value" = EXCLUDED."value"`;
  await db.$executeRaw`DELETE FROM "DistSetting" WHERE "name" IN (${'pintok:' + id}, ${'pinfail:' + id})`;
}
/** Cierra la sesión en todos los teléfonos del usuario. */
export async function revokeUser(id: string) { await db.$executeRaw`DELETE FROM "DistSetting" WHERE "name" = ${'pintok:' + id}`; }

/**
 * Usuario de la petición (cabeceras x-user-id + x-user-token), activo y con permiso vigente en ese teléfono.
 * Se calcula una vez por petición.
 */
const memo = new WeakMap<NextRequest, Promise<Usuario | null>>();
export function userOf(req: NextRequest): Promise<Usuario | null> {
  let p = memo.get(req);
  if (!p) {
    p = (async () => {
      const id = req.headers.get('x-user-id') || '', tok = req.headers.get('x-user-token') || '', dev = req.headers.get('x-device-id') || '';
      if (!id || !tok) return null;
      const u = await getUser(id);
      if (!u || !u.active) return null;
      if (dev && (await isBlocked(id, dev))) return null;
      return (await tokenOk(id, tok)) ? u : null;
    })();
    memo.set(req, p);
  }
  return p;
}
/** Mandó cabeceras de usuario pero no son válidas (PIN cambiado, usuario desactivado, teléfono bloqueado). */
export async function userHeaderInvalid(req: NextRequest) { return !!req.headers.get('x-user-token') && !(await userOf(req)); }
/** ¿La petición es de un usuario de Gerencia con permiso vigente? */
export async function isGerencia(req: NextRequest) { const u = await userOf(req); return !!u && u.role === 'gerencia'; }
