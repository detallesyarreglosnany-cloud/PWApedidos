// Pedido duplicado (mismo cliente con ±1 día). Espejo de public/pedidos/js/dedup.js:
// mismas palabras genéricas, misma clave y mismas reglas de pares.
const STOP = new Set(['bodega', 'bodegon', 'abasto', 'abastos', 'variedades', 'inversiones', 'inv', 'comercial', 'comercializadora', 'comercio',
  'distribuidora', 'distribuciones', 'mini', 'market', 'minimarket', 'supermercado', 'super', 'mercado', 'licoreria', 'panaderia', 'charcuteria',
  'frigorifico', 'kiosko', 'kiosco', 'tienda', 'local', 'negocio', 'ca', 'sa', 'srl', 'cia', 'la', 'el', 'los', 'las', 'de', 'del', 'y', 'e',
  'sr', 'sra', 'don', 'dona', 'hijos', 'hijo', 'hnos', 'hermanos', 'f', 'p']);
const norm = (s: unknown) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
export function clientKeyOf(name: unknown) {
  const all = norm(name).split(' ').filter(Boolean);
  const out = all.filter((w) => !STOP.has(w) && w.length > 1);
  return (out.length ? out : all).sort().join(' ');
}

export type DupOrder = { id: string; sellerId: string | null; sellerName: string | null; routeDate: string | null; clientId: string | null;
  clientKey: string | null; clientName: string | null; pendingFrom: string | null; extraOk: string | null; result: string | null;
  loadId: string | null; status: string | null };
export type DupHit = { id: string; kind: 'same' | 'similar'; clientName: string; sellerName: string; routeDate: string; loadId: string; status: string; extra: boolean };
export const DUP_WINDOW_DAYS = 4;

const dayN = (d: string | null) => Date.parse(String(d || '') + 'T12:00:00Z') / 86400000;

/** Pedidos del mismo cliente ('same': id o nombre) o de nombre parecido ('similar') con 4 días o menos de diferencia. */
export function dupPairs(orders: DupOrder[], onlyFor?: (o: DupOrder) => boolean) {
  const list = orders.filter((o) => o.result !== 'anulada');
  const groups = new Map<string, DupOrder[]>();
  const add = (k: string, o: DupOrder) => { const g = groups.get(k) || []; g.push(o); groups.set(k, g); };
  for (const o of list) {
    if (o.clientId) add('i|' + o.clientId, o);
    if (o.clientKey) add('k|' + o.clientKey, o);
    const f = clientKeyOf(o.clientName || o.clientKey);
    if (f) add('f|' + f, o);
  }
  const out = new Map<string, DupHit[]>();
  for (const [gk, g] of groups) {
    if (g.length < 2) continue;
    const kind: DupHit['kind'] = gk.startsWith('f|') ? 'similar' : 'same';
    for (const o of g) {
      if (onlyFor && !onlyFor(o)) continue;
      for (const x of g) {
        if (x.id === o.id || x.pendingFrom === o.id || o.pendingFrom === x.id) continue;
        if (Math.abs(dayN(x.routeDate) - dayN(o.routeDate)) > DUP_WINDOW_DAYS) continue;
        const cur = out.get(o.id) || [];
        const had = cur.find((d) => d.id === x.id);
        if (had) { if (kind === 'same') had.kind = 'same'; continue; }
        cur.push({ id: x.id, kind, clientName: x.clientName || '', sellerName: x.sellerName || '', routeDate: x.routeDate || '', loadId: x.loadId || '',
          status: x.status || '', extra: x.sellerId === o.sellerId && (x.extraOk === 'true' || o.extraOk === 'true') });
        out.set(o.id, cur);
      }
    }
  }
  for (const arr of out.values()) arr.sort((a, b) => (a.kind === b.kind ? b.routeDate.localeCompare(a.routeDate) : a.kind === 'same' ? -1 : 1));
  return out;
}
