import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, ACCESS_MAX_AGE, accessEnabled, checkCredentials, issueToken } from '@/lib/access';

// Pantalla de acceso a la PWA. Un solo usuario y clave para todo el equipo
// (PEDIDOS_BASIC_USER / PEDIDOS_BASIC_PASS). Al entrar, el teléfono o la PC
// guardan una cookie de un año: no se vuelve a pedir aunque se cierre la app.

export const dynamic = 'force-dynamic';

const HOME = '/pedidos/index.html';

function safeNext(v: string | null) {
  return v && v.startsWith('/pedidos/') && !v.includes('//') ? v : HOME;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

function page(next: string, error = '', status = 200) {
  const html = `<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<meta name="theme-color" content="#7a0a12">
<title>Puerto Venado · Acceso</title>
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0b0c;color:#f2f2f2;font:16px/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:16px}
form{width:100%;max-width:360px;background:#17171a;border:1px solid #2a2a2e;border-radius:18px;padding:28px 22px}
img{display:block;width:120px;margin:0 auto 18px}h1{font-size:20px;margin:0 0 4px;text-align:center}p{margin:0 0 20px;text-align:center;color:#a9a9b0;font-size:14px}
label{display:block;font-size:14px;color:#c9c9cf;margin:14px 0 6px}input{width:100%;font-size:18px;padding:13px 14px;border-radius:12px;border:1px solid #34343a;background:#0f0f11;color:#fff}
input:focus{outline:2px solid #c3121f;border-color:transparent}button{margin-top:22px;width:100%;font-size:18px;font-weight:700;padding:14px;border:0;border-radius:14px;background:#c3121f;color:#fff}
.err{background:#3a0d10;border:1px solid #7a1a20;color:#ffb4b4;border-radius:10px;padding:10px 12px;font-size:14px;margin-bottom:6px}
</style></head><body>
<form method="post" action="/acceso" autocomplete="on">
<img src="/pedidos/icons/logo-white.png" alt="Puerto Venado">
<h1>Acceso a Pedidos</h1><p>Escríbelo una sola vez: este equipo lo recuerda por un año.</p>
${error ? `<div class="err">${esc(error)}</div>` : ''}
<input type="hidden" name="next" value="${esc(next)}">
<label for="u">Usuario</label><input id="u" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" required>
<label for="p">Clave</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button type="submit">Entrar</button>
</form></body></html>`;
  return new NextResponse(html, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    },
  });
}

// Location relativa: así la redirección nunca depende del host que vea el servidor
const goTo = (path: string) => new NextResponse(null, { status: 303, headers: { Location: path, 'Cache-Control': 'no-store' } });

export async function GET(req: NextRequest) {
  const next = safeNext(req.nextUrl.searchParams.get('next'));
  if (!accessEnabled()) return goTo(next);
  return page(next);
}

export async function POST(req: NextRequest) {
  let form: FormData;
  try { form = await req.formData(); } catch { return page(HOME, 'Solicitud inválida', 400); }
  const next = safeNext(String(form.get('next') || ''));
  const user = String(form.get('username') || '');
  const pass = String(form.get('password') || '');
  if (!checkCredentials(user, pass)) {
    await new Promise((r) => setTimeout(r, 800)); // frena los intentos en serie
    return page(next, 'Usuario o clave incorrectos. Revisa mayúsculas y espacios.', 401);
  }
  const res = goTo(next);
  res.cookies.set(ACCESS_COOKIE, await issueToken(), {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: ACCESS_MAX_AGE,
  });
  return res;
}
