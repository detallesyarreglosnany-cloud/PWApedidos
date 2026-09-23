import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_COOKIE, accessEnabled, validToken } from '@/lib/access';

// Protección de la PWA de pedidos (public/pedidos) y su API.
//
// 1. Sin la cookie de acceso (se obtiene en /acceso con usuario y clave) no se
//    descarga NI el código de la app. La API de sincronización tiene su propia
//    clave (x-sync-key), así que no depende de la cookie.
// 2. Cabeceras de seguridad: no indexar, no embeber en otros sitios, CSP
//    estricta (solo recursos propios), sin sniffing de tipos.

export const config = { matcher: ['/', '/pedidos', '/pedidos/:path*', '/api/pedidos/:path*'] };

const SYNC_KEY = process.env.PEDIDOS_SYNC_KEY || '';

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

function wantsPage(req: NextRequest) {
  const p = req.nextUrl.pathname;
  return req.method === 'GET' && (p === '/' || p === '/pedidos' || p.endsWith('.html') ||
    (req.headers.get('accept') || '').includes('text/html'));
}

export async function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname;
  // Íconos y manifest no son sensibles: Android los pide sin cookie al instalar la app
  const isPublic = path.startsWith('/pedidos/icons/') || path === '/pedidos/manifest.webmanifest';
  const isSync = path === '/api/pedidos/sync' && !!SYNC_KEY;
  if (accessEnabled() && !isPublic && !isSync && !(await validToken(req.cookies.get(ACCESS_COOKIE)?.value))) {
    if (wantsPage(req)) {
      const url = new URL('/acceso', req.url);
      url.searchParams.set('next', path === '/' || path === '/pedidos' ? '/pedidos/index.html' : path);
      return NextResponse.redirect(url, 303);
    }
    return new NextResponse('Acceso restringido', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const res = NextResponse.next();
  res.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.headers.set('X-Frame-Options', 'DENY');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  if (!path.startsWith('/api/')) res.headers.set('Content-Security-Policy', CSP);
  return res;
}
