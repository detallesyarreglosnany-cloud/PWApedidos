import { NextRequest } from 'next/server';
import { tokenOk } from '@/lib/pin';

// PIN DE SEGURIDAD (rol Oficina · Administración). Mismo resguardo que el PIN de los vendedores
// (huella scrypt, 5 intentos fallidos → espera, permiso por equipo), con su propio identificador.
// Con él se ocultan/restauran registros del Historial y se activa el «cambio silencioso».
export const OWNER_PIN_ID = '__owner__';

/** ¿Esta petición trae el permiso vigente del PIN de seguridad? */
export async function ownerOk(req: NextRequest) {
  return tokenOk(OWNER_PIN_ID, req.headers.get('x-owner-token') || '');
}
