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

  /** Totales de una línea de pedido (usa el precio congelado en la línea). */
  function lineTotals(line) {
    const cajas = +line.cajas || 0;
    const unidades = +line.unidades || 0;
    const upb = +line.unitsPerBox || 1;
    return {
      cajas,
      unidades,
      totalUnidades: cajas * upb + unidades,
      monto: r2(cajas * (+line.boxPrice || 0) + unidades * (+line.unitPrice || 0)),
    };
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
          code: line.code, name: line.name, presentation: line.presentation,
          category: line.category || '', unitsPerBox: line.unitsPerBox,
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
    // Orden de almacén: rubro (orden configurado) → nombre → código → CJ antes que UN
    const rank = (c) => { const i = (opts.rubros || []).indexOf(c); return i < 0 ? 999 : i; };
    const prank = opts.productRank || {}; // orden manual por producto (Inventario → Orden)
    rows.sort((a, b) =>
      rank(a.category) - rank(b.category) ||
      a.category.localeCompare(b.category, 'es') ||
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
        ...r.cells.map((v) => num(v, dec, money)), num(r.total, dec, money)]);
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
          safeText(l.code), safeText(l.name), safeText(l.presentation), safeText(l.category),
          t.cajas, t.unidades, l.unitsPerBox, t.totalUnidades,
          num(+l.boxPrice || 0, dec, true), num(+l.unitPrice || 0, dec, true), num(t.monto, dec, true),
          o.status, o.id]);
      });
    });
    return encode(out, sep);
  }

  global.Matrix = { build, toDelimited, toFlat, lineTotals, orderTotals, r2 };
})(window);
