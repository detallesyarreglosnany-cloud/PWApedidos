// Cuentas por cobrar (Fase 5): cada nota despachada vence según la categoría de lo que llevó.
// Por omisión: REFRESCOS 8 días y todo lo demás 15 días, contados desde el día en que la carga quedó DESPACHADA
// (hora de Venezuela). La oficina cambia los días en Ajustes. Lo pagado se aplica primero a lo que vence antes.
import { r2 } from '@/lib/pagos';

// desde: solo cuentan las notas despachadas desde ese día (lo anterior se cobró en FileMaker antes de la app).
export type CreditRules = { def: number; rules: { category: string; days: number }[]; desde: string };
export const DEFAULT_DESDE = '2026-10-15';
export const DEFAULT_RULES: CreditRules = { def: 15, rules: [{ category: 'REFRESCOS', days: 8 }], desde: DEFAULT_DESDE };
const up = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

export function rulesOf(config: Record<string, unknown> | null): CreditRules {
  const c = (config && config.creditRules) as Partial<CreditRules> | undefined;
  if (!c || typeof c !== 'object') return DEFAULT_RULES;
  const def = Number(c.def) > 0 && Number(c.def) <= 120 ? Math.round(Number(c.def)) : DEFAULT_RULES.def;
  const rules = (Array.isArray(c.rules) ? c.rules : []).map((r) => ({ category: String(r && r.category || ''), days: Math.round(Number(r && r.days)) })).filter((r) => r.category && r.days > 0 && r.days <= 120);
  const desde = /^\d{4}-\d{2}-\d{2}$/.test(String(c.desde || '')) ? String(c.desde) : DEFAULT_DESDE;
  return { def, rules, desde };
}
export const daysFor = (category: string, R: CreditRules) => (R.rules.find((r) => up(r.category) === up(category)) || { days: R.def }).days;

// Días en hora de Venezuela (UTC−4)
export const vzDay = (iso: unknown) => { const t = Date.parse(String(iso || '')); return Number.isFinite(t) ? new Date(t - 4 * 3600000).toISOString().slice(0, 10) : ''; };
export const addDays = (day: string, n: number) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
export const diffDays = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);

export type Tramo = { days: number; monto: number; resta: number; vence: string };
/** Tramos de una nota por plazo (p. ej. refrescos a 8 días y el resto a 15) y lo pagado aplicado a lo que vence primero. */
export function tramos(lines: { category: string; monto: number }[], start: string, R: CreditRules, pagado: number): Tramo[] {
  const by = new Map<number, number>();
  for (const l of lines) { const d = daysFor(l.category, R); by.set(d, r2((by.get(d) || 0) + l.monto)); }
  let left = pagado;
  return [...by.entries()].sort((a, b) => a[0] - b[0]).map(([days, monto]) => {
    const take = Math.min(left, monto); left = r2(left - take);
    return { days, monto, resta: r2(monto - take), vence: addDays(start, days) };
  });
}

export const SEGUIMIENTO: Record<string, string> = {
  ya_pago: 'Ya pagó', no_paga: 'Aún no paga', datos_enviados: 'Se le enviaron los datos de pago',
  no_recibio: 'El cliente no ha recibido', sin_devolucion: 'No se le ha hecho la devolución', incompleto: 'No recibió completo',
};
