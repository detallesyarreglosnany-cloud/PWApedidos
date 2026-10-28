/* =========================================================================
 * matrix.js — Motor de la Matriz de Despacho (funciones puras, sin DOM)
 *
 *   Filas    = productos (en modo "bultos": producto + unidad de medida CJ/UN)
 *   Columnas = clientes (pedidos) del vendedor en la fecha de ruta
 *   Última columna = TOTAL por producto (armado de carga en almacén)
 *   Filas finales  = TOTALES por cliente (control contable)
 * ========================================================================= */
(function (global) {
  'use strict';

  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

  // Código según cómo se vende: lo vendido por unidad lleva el código de unidad del producto (si tiene uno).
  // Pedidos anteriores no guardaban el código de unidad en la línea: se toma del catálogo por el código al mayor.
  let ucSrc = null, ucLen = -1, ucMap = new Map();
  function unitCodeOf(l) {
    if (l && l.unitCode) return l.unitCode;
    const prods = global.PV && global.PV.S && global.PV.S.products;
    if (!prods || !l) return '';
    if (prods !== ucSrc || prods.length !== ucLen) { ucSrc = prods; ucLen = prods.length; ucMap = new Map(prods.filter((p) => p.unitCode && !p.deleted).map((p) => [String(p.code), p.unitCode])); }
    return ucMap.get(String(l.code)) || '';
  }
  /** um 'UN' → código de unidad · 'CJ' → código al mayor · sin um: según lo que lleva la línea (ambos: «mayor / unidad»). */
  function lineCode(l, um) {
    const u = unitCodeOf(l); if (!u || u === l.code) return l.code;
    if (um === 'UN') return u;
    if (um === 'CJ') return l.code;
    const t = lineTotals(l);
    return t.unidades && !t.cajas ? u : t.unidades && t.cajas ? `${l.code} / ${u}` : l.code;
  }

  /**
   * Tamaño de la presentación en ml o g (2 L → 2000, 1,25 L → 1250, 355 ml → 355, 500 g → 500, 1 kg → 1000).
   * La hoja de carga ordena cada categoría de mayor a menor: 2 L, 1,5 L, 1,25 L, 1 L, 355 ml…
   */
  function sizeOf(r) {
    const s = String(`${r.presentation || ''} ${r.name || ''}`).toLowerCase().replace(/(\d),(\d)/g, '$1.$2');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(kgs?|kilos?|grs?|gramos?|g|ml|cc|lts?|litros?|l)(?![a-z])/);
    if (!m) return 0;
    const n = +m[1], big = /^(kg|kilo|lt|litro|l)/.test(m[2]) && !/^ml/.test(m[2]);
    return big ? n * 1000 : n;
  }

  /** Totales de una línea de pedido (usa el precio congelado en la línea). */
  function lineTotals(line) {
    const cajas = +line.cajas || 0;
    const unidades = +line.unidades || 0;
    const upb = +line.unitsPerBox || 1;
    return {
      cajas,
      unidades,
      totalUnidades: cajas * upb + unidades,
      monto: r2(cajas * (+line.boxPrice || 0) + unidades * (+line.unitPrice || 0) - lineDesc(line)),
    };
  }
  /**
   * Descuento de combo de una línea (espejo de src/lib/money.ts): line.cmb = { cj, un, dcj, dun } dice cuántas cajas y
   * unidades van en combo y cuánto se descuenta por cada una. Solo hasta esas cantidades; lo demás se cobra completo.
   */
  function lineDesc(l) {
    const c = l && l.cmb; if (!c || typeof c !== 'object') return 0;
    const cj = Math.max(0, +l.cajas || 0), un = Math.max(0, +l.unidades || 0);
    const d = Math.min(cj, Math.max(0, +c.cj || 0)) * Math.max(0, +c.dcj || 0) + Math.min(un, Math.max(0, +c.un || 0)) * Math.max(0, +c.dun || 0);
    return Math.min(d, cj * (+l.boxPrice || 0) + un * (+l.unitPrice || 0));
  }

  function orderTotals(order) {
    const t = { cajas: 0, unidades: 0, totalUnidades: 0, bultos: 0, monto: 0, items: 0 };
    Object.values(order.lines || {}).forEach((l) => {
      const x = lineTotals(l);
      if (!x.cajas && !x.unidades) return;
      t.items++;
      t.cajas += x.cajas; t.unidades += x.unidades;
      t.totalUnidades += x.totalUnidades; t.monto = r2(t.monto + x.monto);
    });
    t.bultos = t.cajas + t.unidades; // lo que ocupa espacio en el camión
    return t;
  }

  /**
   * @param {Array} orders   pedidos (ya filtrados por vendedor + fecha)
   * @param {'bultos'|'unidades'|'monto'} mode
   * @param {{keepOrder?: boolean, money?: boolean}} [opts]
   *        keepOrder: respeta el orden recibido (orden de la hoja de carga)
   *        money:false → sin fila de USD (la hoja de carga no lleva precios)
   */
  function build(orders, mode, opts) {
    opts = opts || {};
    const withMoney = opts.money !== false;
    const cols = orders
      .filter((o) => !o.deleted && orderTotals(o).items > 0)
      .sort((a, b) => opts.keepOrder ? 0 : String(a.createdAt).localeCompare(String(b.createdAt)))
      .map((o) => ({ id: o.id, client: o.clientName, status: o.status, totals: orderTotals(o), order: o }));
    const colIndex = new Map(cols.map((c, i) => [c.id, i]));

    const rowsByKey = new Map();
    function row(key, line, um) {
      if (!rowsByKey.has(key)) {
        rowsByKey.set(key, {
          key, um,
          productId: line.productId,
          code: um === 'UN' && mode === 'bultos' ? lineCode(line, 'UN') : line.code, name: line.name, presentation: line.presentation,
          category: line.category || '', unitsPerBox: line.unitsPerBox,
          ...(opts.almacen ? (() => { const a = opts.almacen(line.productId, line.category); return { alm: a.id, almName: a.nombre, almOrd: a.orden }; })() : {}),
          cells: new Array(cols.length).fill(0), total: 0,
        });
      }
      return rowsByKey.get(key);
    }

    orders.forEach((o) => {
      const ci = colIndex.get(o.id);
      if (ci === undefined) return;
      Object.entries(o.lines || {}).forEach(([pid, l]) => {
        const line = { ...l, productId: pid };
        const t = lineTotals(line);
        if (!t.cajas && !t.unidades) return;
        if (mode === 'bultos') {
          if (t.cajas) { const r = row(pid + '|CJ', line, 'CJ'); r.cells[ci] += t.cajas; }
          if (t.unidades) { const r = row(pid + '|UN', line, 'UN'); r.cells[ci] += t.unidades; }
        } else if (mode === 'unidades') {
          const r = row(pid, line, 'UN'); r.cells[ci] += t.totalUnidades;
        } else {
          const r = row(pid, line, 'USD'); r.cells[ci] = r2(r.cells[ci] + t.monto);
        }
      });
    });

    const rows = [...rowsByKey.values()];
    rows.forEach((r) => { r.total = r2(r.cells.reduce((a, b) => a + b, 0)); });
    // Orden de almacén: almacén (si se separa) → rubro (orden configurado) → tamaño de mayor a menor (2 L, 1,5 L,
    // 1,25 L, 1 L, 355 ml…) → orden manual → nombre → código → CJ antes que UN
    const rank = (c) => { const i = (opts.rubros || []).indexOf(c); return i < 0 ? 999 : i; };
    const prank = opts.productRank || {}; // orden manual por producto (Inventario → Orden)
    rows.sort((a, b) =>
      ((a.almOrd ?? 0) - (b.almOrd ?? 0)) ||
      rank(a.category) - rank(b.category) ||
      a.category.localeCompare(b.category, 'es') ||
      sizeOf(b) - sizeOf(a) ||
      (prank[a.productId] || 9999) - (prank[b.productId] || 9999) ||
      a.name.localeCompare(b.name, 'es') ||
      String(a.code).localeCompare(String(b.code), 'es', { numeric: true }) ||
      a.um.localeCompare(b.um));

    const footer = [];
    if (mode === 'bultos') {
      footer.push({ key: 'TOTAL_CAJAS', label: 'Total cajas', cells: cols.map((c) => c.totals.cajas) });
      footer.push({ key: 'TOTAL_UNIDADES', label: 'Total unid. sueltas', cells: cols.map((c) => c.totals.unidades) });
      footer.push({ key: 'TOTAL_BULTOS', label: 'Total bultos', cells: cols.map((c) => c.totals.bultos) });
    } else if (mode === 'unidades') {
      footer.push({ key: 'TOTAL_UNIDADES', label: 'Total unidades', cells: cols.map((c) => c.totals.totalUnidades) });
    }
    if (withMoney) footer.push({ key: 'TOTAL_USD', label: 'Total USD', money: true, cells: cols.map((c) => c.totals.monto) });
    footer.forEach((f) => { f.total = r2(f.cells.reduce((a, b) => a + b, 0)); });

    return { mode, cols, rows, footer };
  }

  /* ------------------------- Exportación ------------------------- */

  // Protección contra inyección de fórmulas en Excel (CSV injection):
  // los nombres de cliente los escribe libremente el vendedor.
  function safeText(v) {
    const s = String(v == null ? '' : v);
    return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
  }

  function num(n, decimal, money) {
    const s = money ? (Math.round(n * 100) / 100).toFixed(2) : String(n);
    return decimal === ',' ? s.replace('.', ',') : s;
  }

  function encode(rows, sep) {
    return rows.map((cols) => cols.map((c) => {
      const s = String(c);
      return (s.includes(sep) || s.includes('"') || /[\r\n]/.test(s)) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(sep)).join('\r\n');
  }

  /**
   * Matriz → texto delimitado. Encabezado fijo y estable para VBA:
   * CODIGO | PRODUCTO | PRESENTACION | UM | <clientes...> | TOTAL
   * Las filas de totales llevan en CODIGO una clave (TOTAL_USD, ...) para
   * que la macro las identifique sin depender del texto visible.
   */
  function toDelimited(m, opts) {
    const sep = opts.sep, dec = opts.decimal;
    const money = m.mode === 'monto';
    const out = [];
    out.push(['CODIGO', 'PRODUCTO', 'PRESENTACION', 'UM', ...m.cols.map((c) => safeText(c.client)), 'TOTAL']);
    m.rows.forEach((r) => {
      out.push([safeText(r.code), safeText(r.name), safeText(r.presentation), r.um,
        ...r.cells.map((v) => (v ? num(v, dec, money) : '')), num(r.total, dec, money)]); // sin ceros: la celda sin cantidad queda vacía
    });
    m.footer.forEach((f) => {
      out.push([f.key, f.label, '', f.money ? 'USD' : '',
        ...f.cells.map((v) => num(v, dec, f.money)), num(f.total, dec, f.money)]);
    });
    return encode(out, sep);
  }

  /** Formato largo (1 fila = 1 línea de pedido): ideal para tablas dinámicas / VBA. */
  function toFlat(orders, sellerName, opts) {
    const sep = opts.sep, dec = opts.decimal;
    const out = [['FECHA', 'VENDEDOR', 'CLIENTE', 'CODIGO', 'PRODUCTO', 'PRESENTACION', 'CATEGORIA',
      'CAJAS', 'UNIDADES', 'UND_X_CAJA', 'TOTAL_UNIDADES', 'PRECIO_CAJA', 'PRECIO_UNIDAD', 'MONTO_USD', 'ESTADO', 'PEDIDO_ID']];
    orders.filter((o) => !o.deleted).forEach((o) => {
      Object.values(o.lines || {}).forEach((l) => {
        const t = lineTotals(l);
        if (!t.cajas && !t.unidades) return;
        out.push([o.routeDate, safeText(sellerName || o.sellerName), safeText(o.clientName),
          safeText(lineCode(l)), safeText(l.name), safeText(l.presentation), safeText(l.category),
          t.cajas, t.unidades, l.unitsPerBox, t.totalUnidades,
          num(+l.boxPrice || 0, dec, true), num(+l.unitPrice || 0, dec, true), num(t.monto, dec, true),
          o.status, o.id]);
      });
    });
    return encode(out, sep);
  }

  global.Matrix = { build, toDelimited, toFlat, lineTotals, orderTotals, lineDesc, lineCode, unitCodeOf, sizeOf, r2 };
})(window);
