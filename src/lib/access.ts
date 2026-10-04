// Sesión de acceso a la PWA: cookie firmada (HMAC-SHA256) que dura un año.
// Reemplaza a HTTP Basic Auth: Chrome en Android guarda esa clave solo en
// memoria y la volvía a pedir cada vez que el sistema cerraba el navegador.
// La firma depende del usuario y la clave: si se cambian en Vercel, todas las
// sesiones abiertas caducan y cada equipo debe volver a entrar.

export const ACCESS_COOKIE = 'pv_access';
export const ACCESS_MAX_AGE = 365 * 24 * 3600;

const USER = process.env.PEDIDOS_BASIC_USER || '';
const PASS = process.env.PEDIDOS_BASIC_PASS || '';

export const accessEnabled = () => !!USER && !!PASS;

const enc = new TextEncoder();

async function hmac(message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode('pv-access|' + USER + '|' + PASS), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

// Comparación en tiempo constante
export function safeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export function checkCredentials(user: string, pass: string) {
  return accessEnabled() && safeEqual(user.trim(), USER) && safeEqual(pass, PASS);
}

export async function issueToken() {
  const exp = String(Math.floor(Date.now() / 1000) + ACCESS_MAX_AGE);
  return exp + '.' + (await hmac(exp));
}

export async function validToken(token: string | undefined) {
  if (!token) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await hmac(exp));
}

// ---- Recuperación de claves (ver /api/pedidos/llaves) ----
// La PC de la oficina guarda una segunda cookie firmada con la clave admin: si el
// navegador borra los datos del equipo, la app recupera sola su clave admin.
// Cambiar la clave admin (o usuario/clave de acceso) en Vercel la invalida.
export const OFFICE_COOKIE = 'pv_office';

async function officeHmac(adminKey: string, message: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode('pv-office|' + adminKey + '|' + USER + '|' + PASS), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function issueOfficeToken(adminKey: string) {
  const exp = String(Math.floor(Date.now() / 1000) + ACCESS_MAX_AGE);
  return exp + '.' + (await officeHmac(adminKey, exp));
}

export async function validOfficeToken(token: string | undefined, adminKey: string) {
  if (!token || !adminKey) return false;
  const [exp, sig] = token.split('.');
  if (!exp || !sig || !/^\d+$/.test(exp) || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(sig, await officeHmac(adminKey, exp));
}
