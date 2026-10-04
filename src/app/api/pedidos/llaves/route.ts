import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, ACCESS_MAX_AGE, OFFICE_COOKIE, accessEnabled, issueOfficeToken, validOfficeToken, validToken } from '@/lib/access';
import { requireAdmin } from '@/lib/keys';

// Recuperación de claves de un equipo que ya estaba conectado.
//
// Si el navegador borra los datos guardados (poco espacio en el teléfono, PC
// limpiada), la cookie de acceso sobrevive: con ella el equipo vuelve a pedir
// sus claves sin que nadie tenga que escribirlas.
//
// POST /api/pedidos/llaves
//   { action: 'recover' }  cookie de acceso válida → { syncKey }, y además
//                          { adminKey } si el equipo tiene la cookie de oficina.
//   { action: 'remember' } (x-sync-key + x-admin-key) → deja la cookie de oficina.
//   { action: 'forget' }   borra la cookie de oficina (el equipo dejó de ser oficina).
//
// Quien tiene la cookie de acceso ya entró con el usuario y la clave del equipo,
// que son las mismas personas que reciben la clave de sincronización.

export const dynamic = 'force-dynamic';

const SYNC_KEY = process.env.PEDIDOS_SYNC_KEY || '';
const ADMIN_KEY = process.env.PEDIDOS_ADMIN_KEY || '';
const NO_STORE = { 'Cache-Control': 'no-store' };
// La cookie de oficina solo viaja a esta ruta
const OFFICE_PATH = '/api/pedidos/llaves';

export async function POST(req: NextRequest) {
  let body: { action?: unknown };
  try { body = await req.json(); } catch { return NextResponse.json({ error: 'JSON inválido' }, { status: 400, headers: NO_STORE }); }

  if (body.action === 'recover') {
    // Sin usuario y clave configurados no hay forma de saber quién pregunta
    if (!accessEnabled()) return NextResponse.json({ error: 'Recuperación no disponible' }, { status: 404, headers: NO_STORE });
    if (!(await validToken(req.cookies.get(ACCESS_COOKIE)?.value))) {
      return NextResponse.json({ error: 'Sesión vencida: recarga la página y vuelve a entrar' }, { status: 401, headers: NO_STORE });
    }
    const out: { syncKey: string; adminKey?: string } = { syncKey: SYNC_KEY };
    if (await validOfficeToken(req.cookies.get(OFFICE_COOKIE)?.value, ADMIN_KEY)) out.adminKey = ADMIN_KEY;
    return NextResponse.json(out, { headers: NO_STORE });
  }

  if (body.action === 'remember') {
    const denied = requireAdmin(req);
    if (denied) return denied;
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
    res.cookies.set(OFFICE_COOKIE, await issueOfficeToken(ADMIN_KEY), {
      httpOnly: true, secure: true, sameSite: 'strict', path: OFFICE_PATH, maxAge: ACCESS_MAX_AGE,
    });
    return res;
  }

  if (body.action === 'forget') {
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
    res.cookies.set(OFFICE_COOKIE, '', { httpOnly: true, secure: true, sameSite: 'strict', path: OFFICE_PATH, maxAge: 0 });
    return res;
  }

  return NextResponse.json({ error: 'Acción inválida' }, { status: 400, headers: NO_STORE });
}
