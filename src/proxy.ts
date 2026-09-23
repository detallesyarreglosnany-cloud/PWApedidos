import { NextRequest, NextResponse } from 'next/server';

// Protección de la PWA de pedidos (public/pedidos) y su API.
//
// 1. Acceso con usuario y clave (HTTP Basic Auth) si PEDIDOS_BASIC_USER y
//    PEDIDOS_BASIC_PASS están definidas: sin la clave no se descarga NI el
//    código de la app. El navegador la recuerda en cada equipo.
// 2. Cabeceras de seguridad: no indexar, no embeber en otros sitios, CSP
//    estricta (solo recursos propios), sin sniffing de tipos.

export const config = { matcher: ['/', '/pedidos', '/pedidos/:path*', '/api/pedidos/:path*'] };

const USER = process.env.PEDIDOS_BASIC_USER || '';
const PASS = process.env.PEDIDOS_BASIC_PASS || '';

// Comparación en tiempo constante (Edge runtime no tiene crypto.timingSafeEqual)
function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

function authorized(req: NextRequest) {
  if (!USER || !PASS) return true;
  const h = req.headers.get('authorization') || '';
  if (!h.startsWith('Basic ')) return false;
  let decoded = '';
  try { decoded = atob(h.slice(6)); } catch { return false; }
  const i = decoded.indexOf(':');
  return i > 0 && safeEqual(decoded.slice(0, i), USER) && safeEqual(decoded.slice(i + 1), PASS);
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function proxy(req: NextRequest) {
  if (!authorized(req)) {
    return new NextResponse('Acceso restringido', {
      status: 401,
      headers: { 'WWW-Authenticate': 'Basic realm="Puerto Venado", charset="UTF-8"', 'Cache-Control': 'no-store' },
    });
  }
  const res = NextResponse.next();
  res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (!req.nextUrl.pathname.startsWith('/api/')) res.headers.set('Content-Security-Policy', CSP);
  return res;
}
