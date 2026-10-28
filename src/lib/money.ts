// Dinero de una línea de pedido y combos promocionales (espejo de public/pedidos/js/matrix.js y mkt.js).
//
// Un combo con precio especial no cambia los precios de la línea: guarda en line.cmb cuántas cajas/unidades van
// en combo y cuánto se descuenta por cada una. El descuento solo aplica hasta esas cantidades (si se entrega menos,
// se descuenta en proporción; lo que se pida aparte se cobra completo). Sin cmb, todo queda igual que antes.
import { r2 } from '@/lib/pagos';

export type Cmb = { cj?: number; un?: number; dcj?: number; dun?: number };
export type MoneyLine = { cajas?: number; unidades?: number; boxPrice?: number; unitPrice?: number; cmb?: Cmb | null };
const num = (v: unknown) => Number(v) || 0;

/** Descuento de combo de la línea (nunca más que su valor). */
export function lineDesc(l: MoneyLine) {
  const c = l.cmb; if (!c || typeof c !== 'object') return 0;
  const cj = Math.max(0, num(l.cajas)), un = Math.max(0, num(l.unidades));
  const d = Math.min(cj, Math.max(0, num(c.cj))) * Math.max(0, num(c.dcj)) + Math.min(un, Math.max(0, num(c.un))) * Math.max(0, num(c.dun));
  return Math.min(d, cj * num(l.boxPrice) + un * num(l.unitPrice));
}
export const lineMoney = (l: MoneyLine) => r2(num(l.cajas) * num(l.boxPrice) + num(l.unidades) * num(l.unitPrice) - lineDesc(l));

/* ---------------- Combos ---------------- */
export type ComboItem = { pid?: string; cajas?: number; unidades?: number; regalo?: boolean };
export type Combo = { id: string; items?: ComboItem[]; precio?: number; aprobado?: { v?: string; by?: string; at?: string } | null };

/** Huella del contenido que Gerencia autoriza (productos, cantidades, regalos y precio). */
export function comboV(c: Combo) {
  const s = JSON.stringify({ items: (c.items || []).map((it) => ({ pid: String(it.pid || ''), cajas: num(it.cajas), unidades: num(it.unidades), regalo: !!it.regalo })), precio: r2(num(c.precio)) });
  let h = 5381; for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
export const comboOk = (c: Combo | undefined | null) => !!(c && c.aprobado && c.aprobado.v === comboV(c));

type Prod = { boxPrice?: number; unitPrice?: number };
/**
 * Descuento de un combo repartido por producto: lo que vale normal (S) menos su precio, en proporción al valor de cada
 * producto. Devuelve, por producto, las cajas/unidades en combo y el descuento total de cada una.
 */
export function comboAlloc(c: Combo, prices: (pid: string) => Prod | null) {
  const parts: { pid: string; um: 'cj' | 'un'; q: number; v: number }[] = [];
  for (const it of c.items || []) {
    const p = prices(String(it.pid || '')); if (!p) return null;
    if (num(it.cajas) > 0) parts.push({ pid: String(it.pid), um: 'cj', q: num(it.cajas), v: r2(num(it.cajas) * num(p.boxPrice)) });
    if (num(it.unidades) > 0) parts.push({ pid: String(it.pid), um: 'un', q: num(it.unidades), v: r2(num(it.unidades) * num(p.unitPrice)) });
  }
  const S = r2(parts.reduce((a, x) => a + x.v, 0)), D = r2(S - num(c.precio));
  if (!parts.length || S <= 0 || D < 0) return null;
  const out: Record<string, { cj: number; un: number; dcj: number; dun: number }> = {};
  let used = 0;
  parts.forEach((x, i) => {
    const d = i === parts.length - 1 ? r2(D - used) : r2((D * x.v) / S); used = r2(used + d);
    const o = (out[x.pid] = out[x.pid] || { cj: 0, un: 0, dcj: 0, dun: 0 });
    if (x.um === 'cj') { o.cj += x.q; o.dcj += d; } else { o.un += x.q; o.dun += d; } // dcj/dun: descuento TOTAL por ahora
  });
  return { S, D, out };
}
