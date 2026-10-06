/* =========================================================================
 * dedup.js — Cliente repetido / pedido duplicado.
 *
 * Los vendedores a veces escriben el nombre a mano («Bodega Sofía» en vez de
 * «VARIEDADES SOFIA») o vuelven a cargar un cliente que ya pidieron. Aquí:
 *   Dedup.core(nombre)      palabras que identifican al cliente (sin «bodega»,
 *                           «abasto», «C.A.», acentos ni signos)
 *   Dedup.key(nombre)       clave para comparar (mismo cliente aunque cambie el orden)
 *   Dedup.similar(n, list)  clientes parecidos (también con un error de tipeo)
 *   Dedup.pairs(orders)     pedidos del mismo cliente con ±1 día de diferencia
 * Espejo en el servidor: src/lib/dedup.ts (mismas reglas).
 * ========================================================================= */
(function (global) {
  'use strict';

  const STOP = new Set(['bodega', 'bodegon', 'abasto', 'abastos', 'variedades', 'inversiones', 'inv', 'comercial', 'comercializadora', 'comercio',
    'distribuidora', 'distribuciones', 'mini', 'market', 'minimarket', 'supermercado', 'super', 'mercado', 'licoreria', 'panaderia', 'charcuteria',
    'frigorifico', 'kiosko', 'kiosco', 'tienda', 'local', 'negocio', 'ca', 'sa', 'srl', 'cia', 'la', 'el', 'los', 'las', 'de', 'del', 'y', 'e',
    'sr', 'sra', 'don', 'dona', 'hijos', 'hijo', 'hnos', 'hermanos', 'y', 'f', 'p']);
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function core(name) {
    const all = norm(name).split(' ').filter(Boolean);
    const out = all.filter((w) => !STOP.has(w) && w.length > 1);
    return out.length ? out : all;
  }
  const key = (name) => core(name).slice().sort().join(' ');

  function lev1(a, b) { // ¿a y b difieren en a lo sumo una letra?
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0, j = 0, d = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) { i++; j++; continue; }
      if (++d > 1) return false;
      if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
    }
    return d + (a.length - i) + (b.length - j) <= 1;
  }
  const wordsMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a) || lev1(a, b)));
  /** 0..1: cuántas palabras clave coinciden. */
  function score(a, b) {
    const x = core(a), y = core(b);
    if (!x.length || !y.length) return 0;
    const used = new Set();
    let m = 0;
    x.forEach((w) => { const k = y.findIndex((v, i) => !used.has(i) && wordsMatch(w, v)); if (k >= 0) { used.add(k); m++; } });
    return m / Math.max(x.length, y.length);
  }
  /** Clientes parecidos al nombre escrito (máx. 6), del más parecido al menos. */
  function similar(name, clients, min) {
    const digits = String(name || '').replace(/\D/g, '');
    return clients.map((c) => {
      let s = score(name, c.name);
      if (digits.length >= 6 && (String(c.rif || '').replace(/\D/g, '').includes(digits) || String(c.phone || '').replace(/\D/g, '').includes(digits))) s = 1;
      return { c, s };
    }).filter((x) => x.s >= (min || 0.5)).sort((a, b) => b.s - a.s || a.c.name.localeCompare(b.c.name, 'es')).slice(0, 6).map((x) => x.c);
  }

  const dayN = (d) => Date.parse(String(d || '') + 'T12:00:00Z') / 86400000;
  /** ¿Cuenta para comparar? (no borrado, no anulado al liquidar). */
  const live = (o) => !o.deleted && !(o.delivery && o.delivery.result === 'anulada');
  /**
   * Pedidos del mismo cliente (mismo id de cartera, mismo nombre o nombre
   * equivalente) con 1 día o menos de diferencia. Un pedido «se entrega después»
   * y su reprogramación no cuentan como duplicado. extra = el vendedor confirmó
   * que era un pedido adicional (mismo vendedor).
   * Devuelve Map(orderId → [{ id, sellerName, routeDate, extra }]).
   */
  function pairs(orders, onlyFor) {
    const list = orders.filter(live);
    const groups = new Map();
    const add = (k, o) => { if (!k) return; const g = groups.get(k) || []; g.push(o); groups.set(k, g); };
    list.forEach((o) => { if (o.clientId) add('i|' + o.clientId, o); if (o.clientKey) add('k|' + o.clientKey, o); const f = key(o.clientName || o.clientKey); if (f) add('f|' + f, o); });
    const out = new Map();
    groups.forEach((g) => {
      if (g.length < 2) return;
      g.forEach((o) => {
        if (onlyFor && !onlyFor(o)) return;
        g.forEach((x) => {
          if (x.id === o.id || x.pendingFrom === o.id || o.pendingFrom === x.id) return;
          if (Math.abs(dayN(x.routeDate) - dayN(o.routeDate)) > 1) return;
          const cur = out.get(o.id) || [];
          if (cur.some((d) => d.id === x.id)) return;
          cur.push({ id: x.id, sellerName: x.sellerName || '', routeDate: x.routeDate || '', extra: !!(x.sellerId === o.sellerId && (x.extraOk || o.extraOk)) });
          out.set(o.id, cur);
        });
      });
    });
    return out;
  }

  global.Dedup = { norm, core, key, score, similar, pairs, live };
})(typeof window !== 'undefined' ? window : globalThis);
