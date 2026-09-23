import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'crypto';

const SYNC_KEY = process.env.PEDIDOS_SYNC_KEY || '';
const ADMIN_KEY = process.env.PEDIDOS_ADMIN_KEY || '';
const SUPERVISOR_KEY = process.env.PEDIDOS_SUPERVISOR_KEY || '';

export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Clave de sincronización correcta (o sin exigir ninguna, si no está configurada). */
export function syncOk(req: NextRequest) {
  return !SYNC_KEY || safeEqual(req.headers.get('x-sync-key') || '', SYNC_KEY);
}

export function isAdminReq(req: NextRequest) {
  return !!ADMIN_KEY && safeEqual(req.headers.get('x-admin-key') || '', ADMIN_KEY);
}
export function isSupervisorReq(req: NextRequest) {
  return !!SUPERVISOR_KEY && safeEqual(req.headers.get('x-supervisor-key') || '', SUPERVISOR_KEY);
}

/** Exige clave de sync + clave admin (rutas que escriben: publicar catálogo, respaldo). */
export function requireAdmin(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  if (!isAdminReq(req)) return NextResponse.json({ error: 'Solo la oficina (clave admin)' }, { status: 401 });
  return null;
}

/**
 * Exige clave de sync + (clave admin O clave de supervisor). Para rutas de
 * solo lectura (reportes): el supervisor ve todo, pero nunca puede escribir
 * nada — eso lo exige cada ruta de escritura con `requireAdmin`.
 */
export function requireReader(req: NextRequest) {
  if (!syncOk(req)) return NextResponse.json({ error: 'Clave de sincronización inválida' }, { status: 401 });
  if (!isAdminReq(req) && !isSupervisorReq(req)) {
    return NextResponse.json({ error: 'Solo oficina o supervisor' }, { status: 401 });
  }
  return null;
}
