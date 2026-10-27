// Cuentas por cobrar (Fase 5): cada nota despachada vence según la categoría de lo que llevó.
// Por omisión: REFRESCOS 8 días y todo lo demás 15 días, contados desde el día en que la carga quedó DESPACHADA
// (hora de Venezuela). La oficina fija los días por categoría en Inventario. Lo pagado se aplica primero a lo que vence antes.
// Un cambio de plazo vale para lo despachado desde ese día: hist guarda cada versión con su fecha (las notas ya
// despachadas conservan el plazo con que salieron).
import { r2 } from '@/lib/pagos';

// desde: solo cuentan las notas despachadas desde ese día (lo anterior se cobró en FileMaker antes de la app).
// penal: % que el sistema sugiere bajar el límite por cada día de atraso. nuevas: compras de contado de un cliente nuevo
// (creado en la app desde nuevosDesde) antes de darle crédito; su límite sugerido es el promedio de esas compras.
type Plazos = { def: number; rules: { category: string; days: number }[] };
export type CreditRules = Plazos & { desde: string; penal: number; nuevas: number; nuevosDesde: string; hist: (Plazos & { from: string })[] };
export const DEFAULT_DESDE = '2026-10-15';
export const DEFAULT_RULES: CreditRules = { def: 15, rules: [{ category: 'REFRESCOS', days: 8 }], desde: DEFAULT_DESDE, penal: 2, nuevas: 3, nuevosDesde: '2026-10-27', hist: [] };
const up = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().trim();

export function rulesOf(config: Record<string, unknown> | null): CreditRules {
  const c = (config && config.creditRules) as Partial<CreditRules> | undefined;
  if (!c || typeof c !== 'object') return DEFAULT_RULES;
  const defOf = (v: unknown) => (Number(v) > 0 && Number(v) <= 120 ? Math.round(Number(v)) : DEFAULT_RULES.def);
  const rulesIn = (v: unknown) => (Array.isArray(v) ? v : []).map((r) => ({ category: String(r && r.category || ''), days: Math.round(Number(r && r.days)) })).filter((r) => r.category && r.days > 0 && r.days <= 120);
  const def = defOf(c.def), rules = rulesIn(c.rules);
  const day = (v: unknown, d: string) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : d);
  const hist = (Array.isArray(c.hist) ? c.hist : []).filter((h) => h && /^\d{4}-\d{2}-\d{2}$/.test(String(h.from || ''))).slice(-60)
    .map((h) => ({ from: String(h.from), def: defOf(h.def), rules: rulesIn(h.rules) })).sort((a, b) => a.from.localeCompare(b.from));
  const desde = day(c.desde, DEFAULT_DESDE), nuevosDesde = day(c.nuevosDesde, DEFAULT_RULES.nuevosDesde);
  const numIn = (v: unknown, min: number, max: number, d: number) => (v === null || v === undefined || v === '' || !(Number(v) >= min && Number(v) <= max) ? d : Number(v));
  const penal = numIn(c.penal, 0, 50, DEFAULT_RULES.penal), nuevas = Math.round(numIn(c.nuevas, 0, 10, DEFAULT_RULES.nuevas));
  return { def, rules, desde, penal, nuevas, nuevosDesde, hist };
}
/** Plazos vigentes para una nota despachada el día start (los de esa fecha según el historial; sin historial, los actuales). */
export function rulesAt(R: CreditRules, start: string): CreditRules {
  if (!R.hist.length) return R;
  let h = R.hist[0];
  for (const x of R.hist) if (x.from <= start) h = x;
  return { ...R, def: h.def, rules: h.rules };
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

/* ------------------------- Crédito (Fase 6) ------------------------- */
export type CredSetting = { modo: 'auto' | 'credito' | 'contado'; limite: number; nota: string; by: string; at: string; hist?: { modo: string; limite: number; nota: string; by: string; at: string }[] };
export type CredInfo = {
  modo: 'credito' | 'contado' | 'nuevo'; fijado: string; limite: number; base: string; sugerido: number; bajaPct: number;
  deuda: number; vencido: number; atrasoMax: number; promAtraso: number | null; pagadas: number; aTiempo: number;
  compras: number; nuevo: { n: number; need: number } | null; semaforo: 'verde' | 'amarillo' | 'rojo' | 'nuevo'; motivo: string; nota: string; by: string; at: string;
};
const round5 = (n: number) => Math.max(0, Math.round(n / 5) * 5);
/** Récord y crédito de un cliente. Lo fija cobranza (oficina); el sistema solo sugiere. */
export function credInfo(a: {
  R: CreditRules; set: CredSetting | null; nuevoCliente: boolean; compras: number[]; deuda: number; vencido: number; atrasoMax: number; atrasos: number[];
}): CredInfo {
  const { R, set } = a, fijado = set ? set.modo : 'auto';
  const nuevo = a.nuevoCliente && R.nuevas > 0 && a.compras.length < R.nuevas && fijado !== 'credito';
  const modo = fijado === 'contado' ? 'contado' : nuevo ? 'nuevo' : 'credito';
  let limite = 0, base = '';
  if (set && set.limite > 0) { limite = r2(set.limite); base = 'cobranza'; }
  else if (a.nuevoCliente && R.nuevas > 0 && a.compras.length >= R.nuevas) { const f = a.compras.slice(0, R.nuevas); limite = round5(f.reduce((x, y) => x + y, 0) / f.length); base = 'promedio'; }
  const bajaPct = Math.min(100, Math.round(R.penal * a.atrasoMax));
  const sugerido = limite > 0 ? round5(limite * (1 - bajaPct / 100)) : 0;
  const last = a.atrasos.slice(-10), promAtraso = last.length ? Math.round((last.reduce((x, y) => x + y, 0) / last.length) * 10) / 10 : null;
  const aTiempo = last.filter((d) => d <= 0).length;
  const semaforo = nuevo ? 'nuevo' : a.atrasoMax > 7 || (promAtraso ?? 0) > 7 ? 'rojo' : a.atrasoMax > 0 || (promAtraso ?? 0) > 2 ? 'amarillo' : 'verde';
  const motivo = nuevo ? `Cliente nuevo: compra ${a.compras.length + 1} de ${R.nuevas} de contado`
    : a.atrasoMax > 0 ? `${a.atrasoMax} día${a.atrasoMax === 1 ? '' : 's'} de atraso${limite > 0 && bajaPct > 0 ? `: el sistema sugiere bajar el límite ${bajaPct}% (a $${sugerido})` : ''}`
    : last.length ? `Pagó ${aTiempo} de ${last.length} notas a tiempo` : '';
  return { modo, fijado, limite, base, sugerido, bajaPct, deuda: r2(a.deuda), vencido: r2(a.vencido), atrasoMax: a.atrasoMax, promAtraso, pagadas: last.length, aTiempo,
    compras: a.compras.length, nuevo: nuevo ? { n: a.compras.length, need: R.nuevas } : null, semaforo, motivo, nota: set ? set.nota : '', by: set ? set.by : '', at: set ? set.at : '' };
}
