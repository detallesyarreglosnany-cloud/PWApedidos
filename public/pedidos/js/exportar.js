/* =========================================================================
 * exportar.js — Exportación a Excel (.xlsx) con formato y fórmulas.
 *
 * Las celdas sin cantidad quedan VACÍAS (no «0»), los números son números
 * (no texto), los totales son fórmulas (SUMA, SUMAR.SI, SUBTOTALES) y cada
 * libro sale con formato: encabezados, bordes, anchos, paneles fijos,
 * filtros y hoja horizontal ajustada al ancho de la página.
 *
 *   Exporta.matrix(m, meta)            matriz productos × clientes (hoja de carga / pedidos)
 *   Exporta.flat(orders, meta)         una fila por línea de pedido, con fórmulas
 *   Exporta.liquidation(load, sh, meta) hoja de liquidación con el cuadre del camión
 *   Exporta.table(def)                 tabla simple (una hoja)
 *   Exporta.blocks(name, blocks, opts) varias tablas apiladas en una hoja
 *   Exporta.save(filename, sheets)     arma el .xlsx y lo descarga / comparte
 * ========================================================================= */
(function (global) {
  'use strict';

  const X = () => global.XlsxOut;
  const NAVY = '#730101';
  const S = {
    title: { b: true, size: 15, color: NAVY },
    sub: { color: '#555555', size: 10 },
    hdr: { b: true, color: '#FFFFFF', fill: NAVY, border: true, align: 'center', valign: 'center', wrap: true },
    hdrL: { b: true, color: '#FFFFFF', fill: NAVY, border: true, align: 'left', valign: 'center', wrap: true },
    hdrV: { b: true, color: '#FFFFFF', fill: NAVY, border: true, align: 'left', rot: 90, wrap: true },
    ini: { b: true, size: 9, color: '#730101', align: 'center', fill: '#F3E3E3', border: true },
    block: { b: true, size: 12, color: NAVY },
    note: { i: true, color: '#555555', size: 10 },
    tot: { b: true, fill: '#F3E3E3', border: true },
    vac: { b: true, fill: '#E3F1E6', border: true },
  };
  const cell = (o) => ({ border: true, ...o });
  const kindStyle = (k, extra) => {
    const fmt = k === 'int' ? 'int' : k === 'money' ? 'money' : k === 'usd' ? 'usd' : k === 'pct' ? 'pct' : null;
    return cell({ ...(fmt ? { fmt, align: 'right' } : {}), ...(extra || {}) });
  };
  const col = (c) => X().colName(c);
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const blank0 = (v) => (v ? v : null);
  const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

  /* ---------------- Matriz productos × clientes ---------------- */
  /**
   * meta: { title, info:[texto], sellers:true (fila de iniciales), extra:[{label,cells,total}] (vacíos al pie) }
   * Las celdas con cantidad 0 quedan vacías; los totales son fórmulas.
   */
  function matrix(m, meta) {
    meta = meta || {};
    const money = m.mode === 'monto', kind = money ? 'money' : 'int';
    const nC = m.cols.length, first = 3, last = first + nC - 1, totC = first + nC;
    const rows = [], heights = {};
    rows.push([{ v: meta.title || 'Hoja', s: S.title }]);
    rows.push([{ v: (meta.info || []).filter(Boolean).join('   ·   '), s: S.sub }]);
    rows.push([]);
    const hasSellers = meta.sellers !== false && global.Loads && m.cols.some((c) => c.order && c.order.sellerName);
    let r = 3;
    if (hasSellers) {
      rows.push([null, { v: 'VENDEDOR →', s: { b: true, size: 9, align: 'right' } }, null, ...m.cols.map((c) => ({ v: global.Loads.initials(c.order.sellerName), s: S.ini }))]);
      r++;
    }
    const headRow = r;
    rows.push([{ v: 'CÓDIGO', s: S.hdr }, { v: 'PRODUCTO', s: S.hdrL }, { v: 'UM', s: S.hdr },
      ...m.cols.map((c, i) => ({ v: `${i + 1}. ${c.client}`, s: S.hdrV })), { v: money ? 'TOTAL $' : 'TOTAL', s: S.hdr }]);
    heights[headRow] = 135;
    const d0 = headRow + 1, dN = d0 + m.rows.length - 1;
    m.rows.forEach((row, i) => {
      const xr = d0 + i + 1; // fila de Excel (1 = primera)
      rows.push([cell({ v: row.code }), cell({ v: `${row.name}${row.presentation ? ' ' + row.presentation : ''}` }), cell({ v: row.um, align: 'center', b: true }),
        ...row.cells.map((v) => ({ v: blank0(v), s: kindStyle(kind) })),
        { v: row.total, f: nC ? `SUM(${col(first)}${xr}:${col(last)}${xr})` : undefined, s: kindStyle(kind, { b: true, fill: '#FFF7DD' }) }]);
    });
    const rng = (c) => `${col(c)}$${d0 + 1}:${col(c)}$${dN + 1}`, umRng = `$C$${d0 + 1}:$C$${dN + 1}`;
    m.footer.forEach((f) => {
      const r2 = rows.length + 1;
      const fx = (c) => {
        if (!m.rows.length) return undefined;
        if (m.mode === 'bultos' && f.key === 'TOTAL_CAJAS') return `SUMIF(${umRng},"CJ",${rng(c)})`;
        if (m.mode === 'bultos' && f.key === 'TOTAL_UNIDADES') return `SUMIF(${umRng},"UN",${rng(c)})`;
        return `SUM(${rng(c)})`;
      };
      rows.push([{ v: f.label.toUpperCase(), s: S.tot }, { v: null, s: S.tot }, { v: f.money ? 'USD' : null, s: S.tot },
        ...f.cells.map((v, i) => ({ v, f: fx(first + i), s: { ...S.tot, fmt: f.money ? 'money' : 'int', align: 'right' } })),
        { v: f.total, f: nC ? `SUM(${col(first)}${r2}:${col(last)}${r2})` : undefined, s: { ...S.tot, fmt: f.money ? 'money' : 'int', align: 'right' } }]);
    });
    (meta.extra || []).forEach((x) => {
      const r2 = rows.length + 1;
      rows.push([{ v: x.label, s: S.vac }, { v: null, s: S.vac }, { v: null, s: S.vac },
        ...x.cells.map((v) => ({ v: v === null || v === undefined || v === 0 ? null : v, s: { ...S.vac, fmt: 'int', align: 'right' } })),
        { v: x.total, f: nC ? `SUM(${col(first)}${r2}:${col(last)}${r2})` : undefined, s: { ...S.vac, fmt: 'int', align: 'right' } }]);
    });
    const widths = [10, 38, 6, ...m.cols.map(() => 6.5), 11];
    return { name: meta.sheet || 'Hoja', rows, widths, heights, freeze: { r: headRow + 1, c: 3 }, merges: [`A1:${col(Math.max(totC, 6))}1`], landscape: true, tab: '730101' };
  }

  /* ---------------- Plano: una fila por línea de pedido ---------------- */
  function flat(orders, meta) {
    meta = meta || {};
    const head = ['FECHA', 'VENDEDOR', 'CLIENTE', 'CODIGO', 'PRODUCTO', 'PRESENTACION', 'CATEGORIA', 'CAJAS', 'UNIDADES', 'UND_X_CAJA', 'TOTAL_UNIDADES', 'PRECIO_CAJA', 'PRECIO_UNIDAD', 'MONTO_USD', 'ESTADO', 'PEDIDO_ID'];
    const rows = [[{ v: meta.title || 'Pedidos (una fila por línea)', s: S.title }], [{ v: 'Total de monto y cantidades con SUBTOTALES: respetan el filtro que pongas.', s: S.sub }], [], head.map((h) => ({ v: h, s: S.hdr }))];
    let n = 0;
    orders.filter((o) => !o.deleted).forEach((o) => {
      Object.values(o.lines || {}).forEach((l) => {
        const t = global.Matrix.lineTotals(l);
        if (!t.cajas && !t.unidades) return;
        const xr = rows.length + 1; n++;
        rows.push([{ d: o.routeDate, s: cell({}) }, cell({ v: meta.seller || o.sellerName }), cell({ v: o.clientName }), cell({ v: l.code }), cell({ v: l.name }), cell({ v: l.presentation }), cell({ v: l.category }),
          { v: t.cajas || null, s: kindStyle('int') }, { v: t.unidades || null, s: kindStyle('int') }, { v: +l.unitsPerBox || 1, s: kindStyle('int') },
          { v: t.totalUnidades, f: `H${xr}*J${xr}+I${xr}`, s: kindStyle('int') },
          { v: +l.boxPrice || null, s: kindStyle('money') }, { v: +l.unitPrice || null, s: kindStyle('money') },
          { v: t.monto, f: `H${xr}*L${xr}+I${xr}*M${xr}`, s: kindStyle('money', { b: true }) }, cell({ v: o.status }), cell({ v: o.id })]);
      });
    });
    const hr = 4, d0 = hr + 1, dN = rows.length;
    const sum = (c, kind, k) => ({ v: rows.slice(hr).reduce((a, r) => a + num(r[k] && r[k].v), 0), f: n ? `SUBTOTAL(109,${c}${d0}:${c}${dN})` : undefined, s: { ...S.tot, fmt: kind, align: 'right' } });
    rows.push([{ v: 'TOTAL', s: S.tot }, ...new Array(6).fill({ v: null, s: S.tot }), sum('H', 'int', 7), sum('I', 'int', 8), { v: null, s: S.tot }, sum('K', 'int', 10), { v: null, s: S.tot }, { v: null, s: S.tot }, sum('N', 'money', 13), { v: null, s: S.tot }, { v: null, s: S.tot }]);
    return { name: meta.sheet || 'Pedidos', rows, widths: [11, 16, 34, 9, 34, 14, 14, 8, 9, 10, 12, 12, 12, 13, 12, 22], freeze: { r: hr, c: 0 }, filter: n ? `A${hr}:P${dN}` : undefined, merges: ['A1:H1'], landscape: true, tab: '730101' };
  }

  /* ---------------- Bloques apilados (varias tablas en una hoja) ---------------- */
  /**
   * block: { title, note, cols:[{h, w, k:'text|int|money|usd|date|pct', total:true, rowSum:[c1,c2], align}], rows:[[...]], totalLabel }
   * Una celda puede ser un valor o { v, f }. total:true agrega una fila TOTAL con =SUMA de la columna;
   * rowSum agrega a esa columna la fórmula =SUMA de las columnas c1..c2 de la misma fila.
   */
  function blocks(name, list, opts) {
    opts = opts || {};
    const rows = [], widths = [], merges = [];
    if (opts.title) { rows.push([{ v: opts.title, s: S.title }]); if (opts.subtitle) rows.push([{ v: opts.subtitle, s: S.sub }]); rows.push([]); }
    let firstHead = null;
    list.forEach((b) => {
      if (b.title) rows.push([{ v: b.title, s: S.block }]);
      if (b.note) rows.push([{ v: b.note, s: S.note }]);
      const hr = rows.length; if (firstHead === null) firstHead = hr;
      rows.push(b.cols.map((c) => ({ v: c.h, s: c.k && c.k !== 'text' ? S.hdr : S.hdrL })));
      b.cols.forEach((c, i) => { widths[i] = Math.max(widths[i] || 0, c.w || (c.k && c.k !== 'text' ? 12 : 22)); });
      const d0 = rows.length;
      b.rows.forEach((row) => {
        const xr = rows.length + 1;
        rows.push(b.cols.map((c, i) => {
          let v = row[i]; const k = c.k || 'text';
          const st = k === 'text' ? cell({ ...(c.align ? { align: c.align } : {}) }) : kindStyle(k, c.align ? { align: c.align } : {});
          if (c.rowSum) return { v: row.slice(c.rowSum[0], c.rowSum[1] + 1).reduce((x, y) => x + num(y && typeof y === 'object' ? y.v : y), 0), f: `SUM(${col(c.rowSum[0])}${xr}:${col(c.rowSum[1])}${xr})`, s: { ...st, b: true, fill: '#FFF7DD' } };
          if (v && typeof v === 'object' && !Array.isArray(v)) return v.d ? { d: v.d, s: st } : { v: v.v, f: v.f, s: v.s || st };
          if (k === 'date' && iso(v)) return { d: iso(v), s: st };
          if ((k === 'int' || k === 'money' || k === 'usd') && v === 0 && c.blank0) v = null;
          return { v, s: st };
        }));
      });
      const dN = rows.length;
      if (b.cols.some((c) => c.total) && b.rows.length) {
        const xr = rows.length + 1;
        rows.push(b.cols.map((c, i) => {
          if (i === 0) return { v: b.totalLabel || 'TOTAL', s: S.tot };
          if (!c.total && !c.rowSum) return { v: null, s: S.tot };
          const sumv = b.rows.reduce((a, r) => a + num(r[i] && typeof r[i] === 'object' ? r[i].v : r[i]), 0);
          const v = c.rowSum ? b.rows.reduce((a, r) => a + r.slice(c.rowSum[0], c.rowSum[1] + 1).reduce((x, y) => x + num(y && typeof y === 'object' ? y.v : y), 0), 0) : sumv;
          return { v, f: `SUM(${col(i)}${d0 + 1}:${col(i)}${dN})`, s: { ...S.tot, fmt: c.k === 'money' ? 'money' : c.k === 'usd' ? 'usd' : 'int', align: 'right' } };
        }));
      }
      rows.push([]);
    });
    const s = { name, rows, widths, landscape: true, tab: opts.tab || '730101', merges };
    if (opts.freezeHead && firstHead !== null) s.freeze = { r: firstHead + 1, c: opts.freezeCols || 0 };
    if (opts.filter && firstHead !== null && list[0].rows.length) s.filter = `A${firstHead + 1}:${col(list[0].cols.length - 1)}${firstHead + 1 + list[0].rows.length}`;
    if (opts.title) s.merges.push(`A1:${col(Math.max(5, (list[0] && list[0].cols.length - 1) || 5))}1`);
    return s;
  }

  /* ---------------- Liquidación (como el libro: matriz + cuadre del camión) ---------------- */
  /**
   * sh = Liq.sheet(...). A la izquierda lo entregado a cada cliente; a la derecha
   * ENTREGADO | QUEDAN | CARGA | TOTAL | DEBE QUEDAR | DEVOLUCIÓN | DIFERENCIA | MOTIVO.
   * Amarillo = se escribe a mano · azul = fórmula (se recalcula al editar).
   * meta: { info:[texto], rate, productsById }
   */
  function liquidation(load, sh, meta) {
    meta = meta || {};
    const IN = { fill: '#FFF2CC' }, CALC = { fill: '#DDEBF7' };
    const n = sh.cols.length, first = 3, last = first + n - 1;
    const E = first + n, Q = E + 1, C = E + 2, T = E + 3, DQ = E + 4, DV = E + 5, DF = E + 6, M = E + 7, LS = E + 8, P = E + 9, TU = E + 10;
    const L = global.Loads, rows = [], heights = {};
    const ttl = `LIQUIDACIÓN · ${L ? L.labelOf(load) : ''}${load.number && L ? ' · ' + L.loadCode(load) : ''}`;
    rows.push([{ v: ttl, s: S.title }]);
    rows.push([{ v: (meta.info || []).filter(Boolean).join('   ·   '), s: S.sub }]);
    rows.push([{ v: 'Amarillo = lo escribes tú · Azul = se calcula solo (Total = Quedan + Carga + devuelto de entregas anteriores · Debe quedar = Total − Entregado · Diferencia = Debe quedar − Devolución)', s: S.note }]);
    const blankR = (k) => new Array(k).fill(null);
    const lab = (t) => ({ v: t, s: { b: true, size: 9, align: 'right' } });
    rows.push([null, lab('VENDEDOR →'), null, ...sh.cols.map((c) => ({ v: L ? L.initials(c.order.sellerName) : '', s: S.ini }))]);
    rows.push([null, lab('NOTA VALERY →'), null, ...sh.cols.map((c) => ({ v: [c.order.valeryNote || '', c.entry.result === 'parcial' && c.entry.newValery ? '→ ' + c.entry.newValery : ''].filter(Boolean).join(' ') || null, s: S.ini }))]);
    rows.push([null, lab('NOVEDAD →'), null, ...sh.cols.map((c) => ({ v: (global.Liq && global.Liq.shortResult(c.entry)) || null, s: { ...S.ini, color: '#B00020', wrap: true } }))]);
    const hr = rows.length;
    const rh = (t, st) => ({ v: t, s: st || S.hdr });
    rows.push([rh('CÓDIGO'), rh('PRODUCTO', S.hdrL), rh('UM'), ...sh.cols.map((c, i) => ({ v: `${i + 1}. ${c.order.clientName}`, s: S.hdrV })),
      rh('ENTREGADO'), rh('QUEDAN'), rh('CARGA'), rh('TOTAL'), rh('DEBE QUEDAR'), rh('DEVOLUCIÓN'), rh('DIFERENCIA'), rh('MOTIVO SI NO CUADRA'), rh('LO QUE SOBRA'), rh('PRECIO $'), rh('TOTAL $')]);
    heights[hr] = 135;
    const d0 = rows.length;
    const priceOf = (r) => {
      const fromLine = sh.cols.map((c) => (c.order.lines || {})[r.productId]).find(Boolean);
      const src = fromLine || (meta.productsById && meta.productsById.get(r.productId)) || {};
      return r.um === 'CJ' ? +src.boxPrice || 0 : +src.unitPrice || 0;
    };
    sh.rows.forEach((r, i) => {
      const xr = d0 + i + 1, a = (c) => `${col(c)}${xr}`, price = priceOf(r);
      const bad = r.dif !== null && r.dif !== 0;
      rows.push([cell({ v: r.code }), cell({ v: `${r.name}${r.presentation ? ' ' + r.presentation : ''}` }), cell({ v: r.um, align: 'center', b: true }),
        ...r.cells.map((c) => ({ v: blank0(c.del), s: kindStyle('int') })),
        { v: r.entregado, f: n ? `SUM(${a(first)}:${a(last)})` : undefined, s: kindStyle('int', { b: true, ...CALC }) },
        { v: blank0(r.queda), s: kindStyle('int', IN) },
        { v: r.carga, s: kindStyle('int', IN) },
        { v: r.total, f: `${a(Q)}+${a(C)}${r.anterior ? '+' + r.anterior : ''}`, s: kindStyle('int', CALC) },
        { v: r.debe, f: `${a(T)}-${a(E)}`, s: kindStyle('int', { b: true, ...CALC }) },
        { v: r.dev, s: kindStyle('int', IN) },
        { v: r.dif === null ? '' : r.dif, f: `IF(${a(DV)}="","",${a(DQ)}-${a(DV)})`, s: kindStyle('int', { b: true, ...CALC, ...(bad ? { color: '#B00020' } : {}) }) },
        { v: r.motivo || null, s: cell(IN) },
        { v: r.debe > 0 || r.dev > 0 ? (r.dest === 'siguiente' ? (r.destLoad && meta.loadName ? '→ ' + meta.loadName(r.destLoad) : 'Siguiente carga') : r.dest === 'almacen' ? 'Volvió a almacén' : 'SIN DECIDIR') : null, s: cell({}) },
        { v: price || null, s: kindStyle('money') },
        { v: Math.round(r.entregado * price * 100) / 100, f: `${a(E)}*${a(P)}`, s: kindStyle('money', { b: true }) }]);
    });
    const dN = d0 + sh.rows.length, has = sh.rows.length > 0;
    const rng = (c) => `${col(c)}${d0 + 1}:${col(c)}${dN}`, fix = (c) => `$${col(c)}$${d0 + 1}:$${col(c)}$${dN}`;
    const sumv = (k) => sh.rows.reduce((x, r) => x + (+r[k] || 0), 0);
    const totStyle = (fmt) => ({ ...S.tot, fmt, align: 'right' });
    // TOTAL (cajas + unidades)
    rows.push([{ v: 'TOTAL (CAJAS + UNIDADES)', s: S.tot }, { v: null, s: S.tot }, { v: null, s: S.tot },
      ...sh.totals.bultos.map((v, i) => ({ v, f: has ? `SUM(${rng(first + i)})` : undefined, s: totStyle('int') })),
      ...[[E, 'entregado'], [Q, 'queda'], [C, 'carga'], [T, 'total'], [DQ, 'debe'], [DV, 'dev'], [DF, 'dif']].map(([c, k]) => ({ v: sumv(k), f: has ? `SUM(${rng(c)})` : undefined, s: totStyle('int') })),
      { v: null, s: S.tot }, { v: null, s: S.tot }, { v: null, s: S.tot }, { v: null, s: S.tot }]);
    // TOTAL $ POR CLIENTE = SUMAPRODUCTO(cantidades del cliente; precios)
    const usdRow = rows.length + 1;
    const usdCli = sh.cols.map((c, i) => Math.round(sh.rows.reduce((x, r) => x + (r.cells[i].del || 0) * priceOf(r), 0) * 100) / 100);
    rows.push([{ v: 'TOTAL $ POR CLIENTE', s: S.tot }, { v: null, s: S.tot }, { v: 'USD', s: S.tot },
      ...usdCli.map((v, i) => ({ v, f: has ? `SUMPRODUCT(${rng(first + i)},${fix(P)})` : undefined, s: totStyle('money') })),
      ...blankR(10).map(() => ({ v: null, s: S.tot })),
      { v: usdCli.reduce((x, y) => x + y, 0), f: has ? `SUM(${rng(TU)})` : undefined, s: totStyle('money') }]);
    if (meta.rate) {
      const br = rows.length + 1;
      rows.push([{ v: 'TOTAL Bs', s: S.tot }, { v: 'Tasa →', s: { ...S.tot, align: 'right' } }, { v: meta.rate, s: { ...S.tot, ...IN, fmt: 'money' } },
        ...usdCli.map((v, i) => ({ v: Math.round(v * meta.rate * 100) / 100, f: `${col(first + i)}${usdRow}*$C$${br}`, s: totStyle('money') })),
        ...blankR(10).map(() => ({ v: null, s: S.tot })),
        { v: Math.round(usdCli.reduce((x, y) => x + y, 0) * meta.rate * 100) / 100, f: `${col(TU)}${usdRow}*$C$${br}`, s: totStyle('money') }]);
    }
    (sh.vac || []).forEach((x) => {
      const r2 = rows.length + 1;
      rows.push([{ v: x.label, s: S.vac }, { v: null, s: S.vac }, { v: null, s: S.vac },
        ...x.cells.map((v) => ({ v: v === null || v === undefined || v === 0 ? null : v, s: { ...S.vac, fmt: 'int', align: 'right' } })),
        { v: x.total, f: n ? `SUM(${col(first)}${r2}:${col(last)}${r2})` : undefined, s: { ...S.vac, fmt: 'int', align: 'right' } }]);
    });
    rows.push([]);
    { const c = Liq.cuadre(sh, meta.productsById), t = Liq.cuadreLines(c, (v) => '$' + (Math.round(v * 100) / 100).toFixed(2));
      rows.push([null, { v: 'CUADRE EN DÓLARES', s: S.tot }]);
      t.lines.concat([t.verdict], t.extra).forEach((x) => rows.push([null, { v: x, s: S.sub }]));
      const pr = Liq.prevRetRows(load.liq);
      if (pr.length) {
        rows.push([null, { v: 'MERCANCÍA DEVUELTA DE ENTREGAS ANTERIORES (entra al TOTAL)', s: S.tot }]);
        pr.forEach((x) => rows.push([null, { v: `${x.clientName} — ${x.qty} ${x.um} ${x.code || ''} ${x.name || ''}${x.label ? ' · de ' + x.label : ''}${x.nota ? ' · nota ' + x.nota : ''} · ${x.motivo || ''}`, s: S.sub }]));
      } }
    rows.push([]);
    rows.push([null, { v: 'Despachador: ____________________     Almacén: ____________________     Liquidó (oficina): ____________________     Gerencia: ____________________', s: S.sub }]);
    const widths = [9, 34, 5, ...sh.cols.map(() => 6.5), 10, 9, 9, 9, 10, 10, 10, 22, 15, 9, 11];
    return { name: 'Liquidación', rows, widths, heights, freeze: { r: hr + 1, c: 3 }, merges: [`A1:${col(Math.max(TU, 8))}1`], landscape: true, tab: '730101' };
  }

  /** Tabla simple de una hoja (con filtro y paneles fijos). */
  function table(def) {
    const b = { title: '', cols: def.cols, rows: def.rows, totalLabel: def.totalLabel };
    return blocks(def.name || 'Datos', [b], { title: def.title, subtitle: def.subtitle, freezeHead: true, filter: def.filter !== false, freezeCols: def.freezeCols || 0 });
  }

  /** Arma el .xlsx y lo descarga (o lo comparte desde el teléfono). */
  async function save(filename, sheets) {
    const u8 = X().build(sheets);
    return global.PV.saveBinary(filename.replace(/\.csv$/i, '') + (/\.xlsx$/i.test(filename) ? '' : '.xlsx'), u8, X().MIME);
  }

  global.Exporta = { matrix, flat, liquidation, blocks, table, save, S };
})(window);
