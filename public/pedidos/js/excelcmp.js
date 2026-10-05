/* =========================================================================
 * excelcmp.js — Comparación de la quincena en paralelo con el libro Excel
 * (Fase 2 · E7). Lógica pura: lee las hojas de liquidación del libro
 * (NN_LIQ_X) y las compara con lo CARGADO en las hojas liquidadas de la app.
 *
 * Qué compara (todo por fecha de la hoja, solo hojas LIQUIDADAS):
 *   · Productos: cantidad y $ cargados (cada hoja del libro = lo que salió en el camión).
 *   · Clientes y despachadores: $ cargado.
 *   · Vacíos por tipo (350, 1,25…): cajas retornables cargadas.
 * El libro no descuenta devoluciones en las cantidades de la liquidación, por eso
 * se compara contra lo cargado; lo entregado (neto) va aparte, como referencia.
 * ========================================================================= */
(function (global) {
  'use strict';

  const TOL = 0.01;
  const norm = (s) => String(s == null ? '' : s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
  const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(String(v == null ? '' : v).replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const r2 = (n) => Math.round(n * 100) / 100;

  function toISO(v) {
    if (v instanceof Date && !Number.isNaN(v.getTime())) return new Date(v.getTime() + 12 * 3600e3).toISOString().slice(0, 10);
    if (typeof v === 'number' && v > 20000 && v < 80000) return new Date(Math.round((v - 25569) * 86400e3) + 12 * 3600e3).toISOString().slice(0, 10);
    const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})/) || String(v || '').match(/^(\d{2})\/(\d{2})\/(\d{4})/);
    if (!m) return '';
    return m[1].length === 4 ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}-${m[2]}-${m[1]}`;
  }

  /** Filas de una hoja como matriz (índice = fila − 1). */
  const rowsOf = (XLSX, ws) => {
    if (!ws || !ws['!ref']) return [];
    // La matriz arranca en la primera celda usada: se rellena para que el índice 0 sea siempre la columna A / fila 1
    const rg = XLSX.utils.decode_range(ws['!ref']);
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null, blankrows: true });
    const padded = rows.map((r) => (rg.s.c ? new Array(rg.s.c).fill(null).concat(r) : r));
    return rg.s.r ? new Array(rg.s.r).fill([]).concat(padded) : padded;
  };

  /**
   * Lee el libro: catálogo (03_PRODUCTOS) y cada hoja de liquidación.
   * Las filas de las hojas LIQ van alineadas por posición con 03_PRODUCTOS (fila 5 ↔ fila 3).
   */
  function parseWorkbook(XLSX, wb) {
    const names = wb.SheetNames || [];
    const prodName = names.find((n) => /PRODUCTOS/i.test(n));
    const prod = rowsOf(XLSX, prodName ? wb.Sheets[prodName] : null);
    const catalog = (i) => { const r = prod[i] || []; return { code: String(r[1] == null ? '' : r[1]).trim(), desc: String(r[2] == null ? '' : r[2]).trim(), ret: String(r[16] == null ? '' : r[16]).trim() }; };
    const sheets = [];
    names.filter((n) => /LIQ_/i.test(n)).forEach((name) => {
      const R = rowsOf(XLSX, wb.Sheets[name]);
      const meta = {};
      for (let i = 0; i < 3; i++) (R[i] || []).forEach((v, j, row) => { if (typeof v === 'string' && /:$/.test(v.trim())) { const nx = row[j + 1]; meta[v.trim().toLowerCase()] = typeof nx === 'string' && /:$/.test(nx.trim()) ? null : nx; } });
      const fecha = toISO(meta['fecha:']), estado = String(meta['estado:'] || '').trim(), repartidor = String(meta['repartidor:'] || '').trim();
      const head = R[3] || [];
      const clientCols = [];
      for (let c = 1; c <= 35; c++) if (head[c] !== null && head[c] !== undefined && String(head[c]).trim() !== '') clientCols.push({ c, name: String(head[c]).trim() });
      const rows = [], clients = new Map(clientCols.map((x) => [x.c, { name: x.name, monto: 0, qty: 0 }]));
      let totalIdx = -1;
      for (let i = 4; i < R.length; i++) {
        const a = R[i] && R[i][0];
        if (typeof a === 'string' && a.trim().toUpperCase() === 'TOTAL') { totalIdx = i; break; }
        const label = a == null ? '' : String(a).trim();
        if (!label) continue;
        const r = R[i], qty = num(r[36]), price = num(r[37]);
        if (!qty) continue;
        const cat = catalog(i - 2);
        rows.push({ code: cat.code, label, qty, price, monto: r2(qty * price), ret: cat.ret });
        clientCols.forEach((x) => { const q = num(r[x.c]); if (q) { const cl = clients.get(x.c); cl.qty += q; cl.monto += q * price; } });
      }
      // Vacíos: debajo del TOTAL, el bloque «VACIOS» / «TIPO DE VACIO» con una fila por tipo (total en la columna AK)
      const vac = {};
      const isMark = (v) => /^(VACIOS|TIPO DE VACIO)$/i.test(String(v == null ? '' : v).trim());
      let vi = -1;
      for (let i = Math.max(totalIdx, 0) + 1; i < R.length; i++) if (isMark((R[i] || [])[0])) { vi = i; break; }
      if (vi >= 0) {
        for (let k = vi + 1; k < R.length; k++) {
          const raw = (R[k] || [])[0];
          const lab = String(raw == null ? '' : raw).trim();
          if (isMark(lab)) continue;
          if (!lab || lab.toUpperCase() === 'TOTAL') break;
          const q = num(R[k][36]); if (q) vac[lab] = (vac[lab] || 0) + q;
        }
      }
      sheets.push({ name, fecha, estado, repartidor, pedido: String(meta['pedido:'] || ''), rows, clients: [...clients.values()].filter((x) => x.qty).map((x) => ({ ...x, monto: r2(x.monto) })), vac,
        total: r2(rows.reduce((a, x) => a + x.monto, 0)) });
    });
    return { sheets };
  }

  const inRange = (s, from, to) => !!s.fecha && s.fecha >= from && s.fecha <= to;
  const isLiq = (s) => /^LIQUIDAD/i.test(s.estado);

  /**
   * Compara el libro con lo que devolvió /api/pedidos/quincena (campo `compare`).
   * st: 'ok' | 'cantidad' | 'precio' | 'solo_excel' | 'solo_app'
   */
  function compare(parsed, d, from, to) {
    const used = parsed.sheets.filter((s) => isLiq(s) && inRange(s, from, to));
    const skipped = parsed.sheets.filter((s) => s.fecha || s.estado).filter((s) => !used.includes(s))
      .map((s) => ({ name: s.name, fecha: s.fecha, estado: s.estado, motivo: !isLiq(s) ? `estado «${s.estado || '—'}» (no es LIQUIDADO)` : 'fuera de las fechas de la quincena', total: s.total }));
    const cmp = d.compare;

    // ---- Productos (por código; si la fila del libro no tiene código, por nombre) ----
    const ex = new Map();
    used.forEach((s) => s.rows.forEach((r) => {
      const k = r.code ? 'c:' + r.code : 'n:' + norm(r.label);
      const x = ex.get(k) || { key: k, code: r.code, label: r.label, qty: 0, monto: 0, ret: r.ret };
      x.qty += r.qty; x.monto += r.monto; ex.set(k, x);
    }));
    const appBy = new Map();
    cmp.products.forEach((p) => { [p.code, p.unitCode].filter(Boolean).forEach((c) => { if (!appBy.has('c:' + c)) appBy.set('c:' + c, p); }); if (!appBy.has('n:' + norm(p.name))) appBy.set('n:' + norm(p.name), p); });
    const usedApp = new Set(), products = [];
    ex.forEach((x) => {
      const a = appBy.get(x.key) || (x.code ? null : null);
      if (a) usedApp.add(a.pid);
      const aq = a ? a.cajas + a.unidades : 0, am = a ? a.monto : 0;
      const dq = r2(x.qty - aq), dm = r2(x.monto - am);
      products.push({ code: x.code || (a && a.code) || '', name: x.label, excelQty: r2(x.qty), excelMonto: r2(x.monto), appQty: aq, appMonto: r2(am), difQty: dq, difMonto: dm,
        st: !a ? 'solo_excel' : Math.abs(dm) < TOL && Math.abs(dq) < TOL ? 'ok' : Math.abs(dq) < TOL ? 'precio' : 'cantidad' });
    });
    cmp.products.forEach((p) => { if (!usedApp.has(p.pid)) products.push({ code: p.code, name: `${p.name} ${p.presentation || ''}`.trim(), excelQty: 0, excelMonto: 0, appQty: p.cajas + p.unidades, appMonto: r2(p.monto), difQty: r2(-(p.cajas + p.unidades)), difMonto: r2(-p.monto), st: 'solo_app' }); });

    // ---- Clientes (por nombre) ----
    const exC = new Map();
    used.forEach((s) => s.clients.forEach((c) => { const k = norm(c.name); const x = exC.get(k) || { name: c.name, monto: 0 }; x.monto += c.monto; exC.set(k, x); }));
    const apC = new Map();
    cmp.clients.forEach((c) => { const k = norm(c.clientName); const x = apC.get(k) || { name: c.clientName, cargado: 0, entregado: 0 }; x.cargado += c.cargado; x.entregado += c.entregado; apC.set(k, x); });
    const clients = [];
    new Set([...exC.keys(), ...apC.keys()]).forEach((k) => {
      const e = exC.get(k), a = apC.get(k), dm = r2((e ? e.monto : 0) - (a ? a.cargado : 0));
      clients.push({ name: (e || a).name, excel: r2(e ? e.monto : 0), app: r2(a ? a.cargado : 0), entregado: r2(a ? a.entregado : 0), dif: dm, st: !e ? 'solo_app' : !a ? 'solo_excel' : Math.abs(dm) < TOL ? 'ok' : 'precio' });
    });

    // ---- Despachadores (el nombre del libro puede escribirse distinto: se une por nombre contenido) ----
    const exD = new Map();
    used.forEach((s) => { const k = s.repartidor || '(sin repartidor)'; exD.set(k, r2((exD.get(k) || 0) + s.total)); });
    const dispatchers = [], usedD = new Set();
    exD.forEach((monto, name) => {
      const a = cmp.dispatchers.find((x) => norm(x.name) === norm(name) || (norm(name).length > 3 && (norm(x.name).includes(norm(name)) || norm(name).includes(norm(x.name)))));
      if (a) usedD.add(a.name);
      const dm = r2(monto - (a ? a.cargado : 0));
      dispatchers.push({ excelName: name, appName: a ? a.name : '', excel: monto, app: a ? a.cargado : 0, entregado: a ? a.entregado : 0, dif: dm, st: !a ? 'solo_excel' : Math.abs(dm) < TOL ? 'ok' : 'precio' });
    });
    cmp.dispatchers.forEach((a) => { if (!usedD.has(a.name)) dispatchers.push({ excelName: '', appName: a.name, excel: 0, app: a.cargado, entregado: a.entregado, dif: r2(-a.cargado), st: 'solo_app' }); });

    // ---- Vacíos por tipo ----
    const exV = {};
    used.forEach((s) => Object.entries(s.vac).forEach(([t, q]) => { exV[t] = (exV[t] || 0) + q; }));
    const vacios = [];
    new Set([...Object.keys(exV), ...Object.keys(cmp.vacCargado || {})]).forEach((t) => {
      const e = exV[t] || 0, a = (cmp.vacCargado || {})[t] || 0;
      if (!e && !a) return;
      vacios.push({ type: t, excel: e, app: a, dif: e - a, st: e - a === 0 ? 'ok' : !a ? 'solo_excel' : !e ? 'solo_app' : 'cantidad' });
    });

    const excelTotal = r2(used.reduce((a, s) => a + s.total, 0)), appCargado = r2(cmp.clients.reduce((a, c) => a + c.cargado, 0)), appEntregado = r2(cmp.clients.reduce((a, c) => a + c.entregado, 0));
    const bad = (arr) => arr.filter((x) => x.st !== 'ok').length;
    return {
      from, to, used: used.map((s) => ({ name: s.name, fecha: s.fecha, repartidor: s.repartidor, total: s.total, clients: s.clients.length })), skipped,
      totals: { excel: excelTotal, app: appCargado, entregado: appEntregado, dif: r2(excelTotal - appCargado) },
      products, clients, dispatchers, vacios,
      issues: { products: bad(products), clients: bad(clients), dispatchers: bad(dispatchers), vacios: bad(vacios) },
      clean: Math.abs(excelTotal - appCargado) < TOL && !bad(products) && !bad(clients) && !bad(dispatchers) && !bad(vacios),
    };
  }

  global.ExcelCmp = { parseWorkbook, compare, norm, toISO };
})(typeof window !== 'undefined' ? window : globalThis);
