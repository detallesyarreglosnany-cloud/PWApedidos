import { NextRequest } from 'next/server';
import { hasPin, tokenOk } from '@/lib/pin';

// PIN de «Promoción y marketing» (mismo resguardo que el PIN de los vendedores, con su propio identificador).
export const MKT_PIN_ID = '__mkt__';

/** ¿Esta petición puede construir Promoción y marketing? Sin PIN creado, como antes (todos los de la oficina). */
export async function mktWriteOk(req: NextRequest) {
  if (!(await hasPin(MKT_PIN_ID))) return true;
  return tokenOk(MKT_PIN_ID, req.headers.get('x-mkt-token') || '');
}
