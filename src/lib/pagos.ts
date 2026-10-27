// Pagos de clientes (Fase 4 · cobranza): validación y cálculo, igual en el servidor y en el teléfono.
// Los montos se llevan a dólares: bolívares con la tasa del pago (Bs por $), pesos colombianos con su tasa (COP por $).

export const METHODS: Record<string, { label: string; currency: 'VES' | 'USD' | 'COP'; ref: boolean; bank: boolean }> = {
  transferencia: { label: 'Transferencia', currency: 'VES', ref: true, bank: true },
  pago_movil: { label: 'Pago móvil', currency: 'VES', ref: true, bank: true },
  efectivo_bs: { label: 'Efectivo Bs', currency: 'VES', ref: false, bank: false },
  efectivo_usd: { label: 'Efectivo $', currency: 'USD', ref: false, bank: false },
  zelle: { label: 'Zelle', currency: 'USD', ref: true, bank: false },
  binance: { label: 'Binance', currency: 'USD', ref: true, bank: false },
  efectivo_cop: { label: 'Pesos colombianos', currency: 'COP', ref: false, bank: false },
};
export const ADJUSTS: Record<string, string> = { colaboracion: 'Colaboración', autoconsumo: 'Autoconsumo', donativo: 'Donativo', descuento: 'Descuento' };
export const STATUSES = ['espera', 'aprobado', 'rechazado', 'anulado'] as const;

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const num = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };
const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
export const normRef = (v: unknown) => String(v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=[0-9])/, '');
const isDay = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

export type PagoLine = { method: string; bank: string; ref: string; currency: string; amount: number; usd: number };
export type PagoAdj = { type: string; pct: number; usd: number };
export type PagoNota = { orderId: string; nota: string; monto: number };
export type Pago = {
  id: string; date: string; sellerId: string; sellerName: string; clientId: string; clientName: string;
  notas: PagoNota[]; rate: number; copRate: number; lines: PagoLine[]; adjusts: PagoAdj[];
  debe: number; pagado: number; ajustes: number; diferencia: number; comment: string;
  status: string; by: string; createdAt: string; review?: { by: string; at: string; motivo: string } | null;
};

/** Limpia y calcula un pago recibido de un equipo. Devuelve el pago o un texto de error. */
export function cleanPago(raw: Record<string, unknown>): Pago | string {
  const id = str(raw.id, 80);
  if (!/^[A-Za-z0-9_\-]{6,80}$/.test(id)) return 'Identificador inválido';
  const date = raw.date;
  if (!isDay(date)) return 'Fecha del pago inválida';
  const sellerId = str(raw.sellerId, 120), clientId = str(raw.clientId, 120), clientName = str(raw.clientName, 120);
  if (!sellerId) return 'Falta el vendedor';
  if (!clientId || !clientName) return 'Falta el cliente';
  const rate = num(raw.rate) || 0, copRate = num(raw.copRate) || 0;
  const notas: PagoNota[] = (Array.isArray(raw.notas) ? raw.notas : []).slice(0, 20).map((n) => {
    const x = (n && typeof n === 'object' ? n : {}) as Record<string, unknown>;
    return { orderId: str(x.orderId, 120), nota: String(x.nota ?? '').replace(/\D/g, '').slice(0, 20), monto: r2(Math.max(0, num(x.monto) || 0)) };
  }).filter((n) => n.orderId);
  if (!notas.length) return 'Elige la nota (o notas) que paga';
  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  if (rawLines.length > 12) return 'Demasiadas formas de pago en un solo pago';
  const lines: PagoLine[] = [];
  for (const l of rawLines) {
    const x = (l && typeof l === 'object' ? l : {}) as Record<string, unknown>;
    const m = METHODS[str(x.method, 30)];
    if (!m) return 'Forma de pago inválida';
    const amount = r2(num(x.amount));
    if (!(amount > 0) || amount > 1e12) return `Monto inválido en ${m.label}`;
    const ref = m.ref ? normRef(x.ref) : '';
    if (m.ref && ref.length < 4) return `${m.label}: escribe el número de referencia (mínimo 4 caracteres)`;
    const bank = m.bank ? str(x.bank, 80) : '';
    if (m.bank && !bank) return `${m.label}: elige el banco`;
    if (m.currency === 'VES' && !(rate > 0)) return 'Escribe la tasa del día (Bs por $)';
    if (m.currency === 'COP' && !(copRate > 0)) return 'Escribe la tasa de los pesos (COP por $)';
    const usd = m.currency === 'USD' ? amount : m.currency === 'VES' ? r2(amount / rate) : r2(amount / copRate);
    lines.push({ method: str(x.method, 30), bank, ref, currency: m.currency, amount, usd });
  }
  const refs = lines.filter((l) => l.ref).map((l) => l.ref);
  if (new Set(refs).size !== refs.length) return 'La misma referencia está dos veces en este pago';
  const debe = r2(notas.reduce((a, n) => a + n.monto, 0));
  const adjusts: PagoAdj[] = [];
  for (const a of (Array.isArray(raw.adjusts) ? raw.adjusts : []).slice(0, 6)) {
    const x = (a && typeof a === 'object' ? a : {}) as Record<string, unknown>;
    const type = str(x.type, 20);
    if (!ADJUSTS[type]) return 'Ajuste inválido';
    const pct = type === 'descuento' ? r2(num(x.pct) || 0) : 0;
    if (type === 'descuento' && !(pct > 0 && pct <= 100)) return 'El descuento va de 0,01 % a 100 %';
    const usd = type === 'descuento' ? r2((debe * pct) / 100) : r2(num(x.usd));
    if (!(usd > 0)) return `Monto inválido en ${ADJUSTS[type]}`;
    adjusts.push({ type, pct, usd });
  }
  if (!lines.length && !adjusts.length) return 'Agrega al menos una forma de pago';
  const pagado = r2(lines.reduce((a, l) => a + l.usd, 0)), ajustes = r2(adjusts.reduce((a, x) => a + x.usd, 0));
  return {
    id, date, sellerId, sellerName: str(raw.sellerName, 80), clientId, clientName, notas, rate: Math.round(rate * 10000) / 10000, copRate: Math.round(copRate * 10000) / 10000, lines, adjusts,
    debe, pagado, ajustes, diferencia: r2(debe - pagado - ajustes), comment: str(raw.comment, 300),
    status: 'espera', by: str(raw.by, 80), createdAt: new Date().toISOString(), review: null,
  };
}
