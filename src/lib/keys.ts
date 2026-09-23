import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

const SYNC_KEY = process.env.PEDIDOS_SYNC_KEY || '';
const ADMIN_KEY = process.env.PEDIDOS_ADMIN_KEY || '';

function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Exige clave de sync + clave admin (rutas solo de oficina). Devuelve la respuesta de error, o null si pasa. */
export function requireAdmin(req: NextRequest) {
  if (SYNC_KEY && !safeEqual(req.headers.get('x-sync-key') || '', SYNC_KEY)) {
    return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  }
  if (!ADMIN_KEY || !safeEqual(req.headers.get('x-admin-key') || '', ADMIN_KEY)) {
    return NextResponse.json({ error: 'Solo la oficina (clave admin)' }, { status: 401 });
  }
  return null;
}
