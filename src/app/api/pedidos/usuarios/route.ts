// Usuarios con rol (Gerencia, Cobranzas) y su PIN.
//   Con la clave de sincronización:
//     { action: 'roster', role }                  → { users: [{ id, name, role }] }  nombres para elegir al entrar
//     { action: 'login', userId, pin, deviceId }  → { token, user }                  permiso de este teléfono
//     { action: 'me' } (+ cabeceras de usuario)    → { user }                         ¿sigue vigente?
//   Solo la oficina (clave admin):
//     { action: 'list' }                           → { users: [{ …, devices }] }
//     { action: 'create', name, role, pin }        → { user }
//     { action: 'update', id, name?, active? }     → { user }   (desactivar cierra la sesión en todos sus teléfonos)
//     { action: 'pin', id, pin }                   → { ok }     restablecer el PIN
//     { action: 'revoke', id }                     → { ok }     cerrar la sesión en todos sus teléfonos
import { NextRequest, NextResponse } from 'next/server';
import { isAdminReq, syncOk } from '@/lib/keys';
import { isPinFormat, pinInfo, verifyPin, weakPin } from '@/lib/pin';
import { ROLES, getUser, isRole, listUsers, newUserId, putUser, revokeUser, setUserPin, userOf, type Usuario } from '@/lib/roles';

export const dynamic = 'force-dynamic';
const NO_STORE = { 'Cache-Control': 'no-store' };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const pub = (u: Usuario) => ({ id: u.id, name: u.name, role: u.role });
const pinErr = (pin: unknown) => (!isPinFormat(pin) ? 'El PIN es de 4 a 6 números' : weakPin(pin) ? 'Ese PIN es muy fácil de adivinar (por ejemplo 1234 o 1111): elige otro' : '');

export async function POST(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400 }); }
  const action = body.action;
  try {
    if (action === 'roster') {
      const role = str(body.role, 20);
      return NextResponse.json({ users: (await listUsers()).filter((u) => u.active && (!role || u.role === role)).map(pub) }, { headers: NO_STORE });
    }
    if (action === 'login') {
      const id = str(body.userId, 80), pin = str(body.pin, 6), device = str(body.deviceId, 80);
      const u = await getUser(id);
      if (!u || !u.active) return NextResponse.json({ error: 'Ese usuario no existe o está desactivado' }, { status: 404 });
      if (!device) return NextResponse.json({ error: 'Falta el equipo' }, { status: 400 });
      const r = await verifyPin(id, pin, device);
      if ('error' in r) return NextResponse.json({ error: r.error }, { status: r.blocked ? 403 : 401 });
      return NextResponse.json({ token: r.token, user: pub(u) });
    }
    if (action === 'me') {
      const u = await userOf(req);
      return u ? NextResponse.json({ user: pub(u) }, { headers: NO_STORE }) : NextResponse.json({ error: 'Tu sesión venció: vuelve a entrar con tu PIN' }, { status: 401 });
    }

    if (!isAdminReq(req)) return NextResponse.json({ error: 'Solo la oficina administra los usuarios' }, { status: 401 });
    const by = str(body.by, 80) || 'Oficina';
    if (action === 'list') {
      const users = await listUsers();
      return NextResponse.json({ users: await Promise.all(users.map(async (u) => ({ ...u, devices: (await pinInfo(u.id)).devices }))), roles: ROLES }, { headers: NO_STORE });
    }
    if (action === 'create') {
      const name = str(body.name, 60), role = body.role, pin = str(body.pin, 6);
      if (name.length < 3) return NextResponse.json({ error: 'Escribe el nombre (mínimo 3 letras)' }, { status: 400 });
      if (!isRole(role)) return NextResponse.json({ error: 'Rol inválido' }, { status: 400 });
      const pe = pinErr(pin); if (pe) return NextResponse.json({ error: pe }, { status: 400 });
      if ((await listUsers()).some((u) => u.active && u.role === role && u.name.toUpperCase() === name.toUpperCase())) return NextResponse.json({ error: `Ya hay un usuario de ${ROLES[role]} con ese nombre` }, { status: 409 });
      const u: Usuario = { id: newUserId(), name, role, active: true, at: new Date().toISOString(), by };
      await putUser(u); await setUserPin(u.id, pin);
      return NextResponse.json({ user: u });
    }
    const id = str(body.id, 80), u = await getUser(id);
    if (!u) return NextResponse.json({ error: 'No existe ese usuario' }, { status: 404 });
    if (action === 'update') {
      const next = { ...u };
      if (typeof body.name === 'string') { const n = str(body.name, 60); if (n.length < 3) return NextResponse.json({ error: 'Nombre muy corto' }, { status: 400 }); next.name = n; }
      if (typeof body.active === 'boolean') next.active = body.active;
      await putUser(next);
      if (!next.active) await revokeUser(id);
      return NextResponse.json({ user: next });
    }
    if (action === 'pin') {
      const pin = str(body.pin, 6), pe = pinErr(pin); if (pe) return NextResponse.json({ error: pe }, { status: 400 });
      await setUserPin(id, pin);
      return NextResponse.json({ ok: true });
    }
    if (action === 'revoke') { await revokeUser(id); return NextResponse.json({ ok: true }); }
    return NextResponse.json({ error: 'Acción inválida' }, { status: 400 });
  } catch (e) {
    console.error('[pedidos/usuarios]', e);
    return NextResponse.json({ error: 'No se pudo completar' }, { status: 500 });
  }
}
