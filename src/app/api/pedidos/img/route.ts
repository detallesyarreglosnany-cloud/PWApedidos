import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { ACCESS_COOKIE, accessEnabled, validToken } from '@/lib/access';

// Foto de un producto: GET /api/pedidos/img?id=<producto>&v=<huella>
// Una <img> no manda las claves de la API: se exige la cookie de acceso de la PWA.
// Caché PRIVADA de un año (cada versión tiene su propia dirección): el teléfono
// la baja una sola vez y la guarda; la CDN pública no la guarda.

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  if (accessEnabled() && !(await validToken(req.cookies.get(ACCESS_COOKIE)?.value))) {
    return new NextResponse('Acceso restringido', { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const id = req.nextUrl.searchParams.get('id') || '';
  if (!id || id.length > 120) return new NextResponse('Falta id', { status: 400 });
  try {
    const row = await db.distDoc.findUnique({ where: { kind_id: { kind: 'images', id } }, select: { data: true } });
    if (!row) return new NextResponse('Sin foto', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const d = JSON.parse(row.data) as { image?: string; v?: string };
    const m = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/i.exec(String(d.image || ''));
    if (!m) return new NextResponse('Foto inválida', { status: 404, headers: { 'Cache-Control': 'no-store' } });
    const body = Buffer.from(m[2], 'base64');
    return new NextResponse(body, {
      headers: { 'Content-Type': m[1], 'Content-Length': String(body.length), 'Cache-Control': 'private, max-age=31536000, immutable', ETag: `"${d.v || ''}"` },
    });
  } catch (error) {
    console.error('[pedidos/img]', error);
    return new NextResponse('Error', { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
}
