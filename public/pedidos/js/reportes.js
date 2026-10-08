/* =========================================================================
 * reportes.js — Reporte quincenal (Fase 2 · E5). Lo usan la oficina y el
 * supervisor. Solo cuenta lo ENTREGADO en hojas LIQUIDADAS; las hojas del
 * período sin liquidar se avisan aparte. El cálculo lo hace el servidor
 * (/api/pedidos/quincena).
 * ========================================================================= */
(function (global) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  /** Último día del mes (28, 29, 30 o 31). month: 1-12 */
  const lastDay = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  /** Quincena: half 1 → del 1 al 15 · half 2 → del 16 al fin de mes. */
  function quincena(y, m, half) {
    return half === 1 ? { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-15` } : { from: `${y}-${pad(m)}-16`, to: `${y}-${pad(m)}-${pad(lastDay(y, m))}` };
  }
  /** Quincena que contiene el día (YYYY-MM-DD). */
  function quincenaOf(day) {
    const [y, m, d] = day.split('-').map(Number);
    return { y, m, half: d <= 15 ? 1 : 2, ...quincena(y, m, d <= 15 ? 1 : 2) };
  }
  /** La quincena anterior a la del día dado. */
  function prevQuincena(day) {
    const q = quincenaOf(day);
    if (q.half === 2) return { y: q.y, m: q.m, half: 1, ...quincena(q.y, q.m, 1) };
    const y = q.m === 1 ? q.y - 1 : q.y, m = q.m === 1 ? 12 : q.m - 1;
    return { y, m, half: 2, ...quincena(y, m, 2) };
  }

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const RES = { parcial: 'Devolución parcial', nofact: 'No facturado (misma nota)', pendiente: 'Se entrega después', anulada: 'Anulada', entregada: 'Entregada' };
  const titleOf = (f) => (f.mode === 'q' ? `${f.half === 1 ? '1ª' : '2ª'} quincena de ${MONTHS[f.m - 1]} ${f.y}` : 'Rango libre');

  /**
   * Resumen por vendedor o por despachador: venta liquidada + vacíos (de lo liquidado) y,
   * al lado, la venta en proceso (aún sin liquidar). who: 'seller' | 'dispatcher'.
   */
  function summaryRows(d, who) {
    const liq = who === 'seller' ? d.bySeller : d.byDispatcher, proc = who === 'seller' ? d.enProceso.bySeller : d.enProceso.byDispatcher;
    const idOf = (x) => (who === 'seller' ? x.sellerId : x.dispatcherId), nameOf = (x) => (who === 'seller' ? x.sellerName : x.dispatcherName);
    const map = new Map();
    liq.forEach((x) => map.set(idOf(x), { name: nameOf(x), hojas: x.hojas || 0, clients: x.clients, cajas: x.cajas, unidades: x.unidades, monto: x.monto, vacDesp: x.vacDesp, vacRecv: x.vacRecv, vacAsg: x.vacAsg, vacDebe: x.vacDebe, novedades: x.novedades || 0, diferencias: x.diferencias || 0, procMonto: 0, procClients: 0 }));
    proc.forEach((x) => { const k = idOf(x); const r = map.get(k) || { name: nameOf(x), hojas: 0, clients: 0, cajas: 0, unidades: 0, monto: 0, vacDesp: 0, vacRecv: 0, vacAsg: 0, vacDebe: 0, novedades: 0, diferencias: 0, procMonto: 0, procClients: 0 }; r.procMonto += x.monto; r.procClients += x.clients; map.set(k, r); });
    const rows = [...map.values()].sort((a, b) => b.monto - a.monto || b.procMonto - a.procMonto || a.name.localeCompare(b.name, 'es'));
    const tot = rows.reduce((a, r) => { Object.keys(a).forEach((k) => { a[k] += +r[k] || 0; }); return a; }, { hojas: 0, clients: 0, cajas: 0, unidades: 0, monto: 0, vacDesp: 0, vacRecv: 0, vacAsg: 0, vacDebe: 0, novedades: 0, diferencias: 0, procMonto: 0, procClients: 0 });
    return { rows, tot };
  }

  /**
   * Cuadre vendedor ↔ despachador: filas = vendedores, columnas = despachadores, celda = lo que
   * ese despachador repartió de lo que vendió ese vendedor. field: 'monto' | 'vacDesp'.
   * Las sumas por fila y por columna tienen que dar el mismo total.
   */
  function crossGrid(d, field) {
    const m = d.cuadre.matrix, sellers = [], disps = [], val = new Map();
    m.forEach((x) => {
      if (!sellers.some((y) => y.id === x.sellerId)) sellers.push({ id: x.sellerId, name: x.sellerName });
      if (!disps.some((y) => y.id === x.dispatcherId)) disps.push({ id: x.dispatcherId, name: x.dispatcherName });
      val.set(x.sellerId + '|' + x.dispatcherId, (val.get(x.sellerId + '|' + x.dispatcherId) || 0) + (+x[field] || 0));
    });
    sellers.sort((a, b) => a.name.localeCompare(b.name, 'es')); disps.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const cell = (s2, d2) => val.get(s2.id + '|' + d2.id) || 0;
    const rows = sellers.map((s2) => ({ name: s2.name, cells: disps.map((d2) => cell(s2, d2)), total: disps.reduce((a, d2) => a + cell(s2, d2), 0) }));
    const cols = disps.map((d2) => sellers.reduce((a, s2) => a + cell(s2, d2), 0));
    return { disps, rows, cols, total: rows.reduce((a, r) => a + r.total, 0) };
  }

  /**
   * Venta liquidada por categoría de producto: filas = categorías (en el orden de la app),
   * columnas = vendedores o despachadores, celda = {monto, cajas, unidades}; totales por fila y columna.
   * Cada categoría se paga distinto, así que se ve el total de TODOS los refrescos, TODAS las aguas, etc.
   */
  function catGrid(d, who, rubros) {
    const arr = who === 'seller' ? d.byCategorySeller : d.byCategoryDispatcher;
    const people = [], cats = [], cell = new Map();
    arr.forEach((x) => {
      if (!people.some((p) => p.id === x.id)) people.push({ id: x.id, name: x.name });
      if (!cats.includes(x.category)) cats.push(x.category);
      cell.set(x.id + '|' + x.category, x);
    });
    people.sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const rank = (c) => { const i = (rubros || []).indexOf(c); return i < 0 ? 999 : i; };
    cats.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b, 'es'));
    const zero = () => ({ monto: 0, cajas: 0, unidades: 0 });
    const add = (t, x) => { t.monto += x.monto; t.cajas += x.cajas; t.unidades += x.unidades; return t; };
    const rows = cats.map((c) => { const cells = people.map((p) => cell.get(p.id + '|' + c) || zero()); return { category: c, cells, total: cells.reduce(add, zero()) }; });
    const cols = people.map((p, i) => rows.reduce((t, r) => add(t, r.cells[i]), zero()));
    return { people, rows, cols, total: cols.reduce(add, zero()) };
  }

  /* ---------- E7 · Comparar con el libro Excel (quincena en paralelo) ---------- */
  const ST_TXT = { ok: '✓ Coincide', cantidad: 'Cantidad distinta', precio: 'Monto/precio distinto', solo_excel: 'Solo en el Excel', solo_app: 'Solo en la app' };
  function renderCompare(box, d, st) {
    if (!box) return;
    const { esc, nf0, usd, toast, fmtDate, saveFile, S } = global.PV;
    const x = st.xc;
    const res = x ? global.ExcelCmp.compare(x.parsed, d, d.from, d.to) : null;
    const only = st.xcOnly !== false;
    const head = `<div class="row" style="gap:10px;align-items:center;flex-wrap:wrap"><h3 class="grow" style="margin:0">📊 Comparar con el Excel <span class="muted">(quincena en paralelo)</span></h3>
      <button class="btn" id="xcLoad">${x ? '↻ Cargar otro libro' : 'Cargar libro Excel'}</button></div>`;
    if (!res) { box.innerHTML = head + '<p class="muted" style="margin:8px 0 0">Carga el libro Excel de la quincena (.xlsm / .xlsx): se leen sus hojas de liquidación <b>LIQUIDADAS</b> con fecha de esta quincena y se comparan con lo cargado en las hojas liquidadas de la app: productos, clientes, despachadores y vacíos. Toda diferencia se explica antes de dejar el Excel.</p>'; bind(); return; }
    const t = res.totals, c = res.issues;
    const rowsOf = (arr) => arr.filter((r) => !only || r.st !== 'ok');
    const badge = (stt) => `<span class="status ${stt === 'ok' ? 'aprobada' : stt === 'solo_excel' || stt === 'solo_app' ? 'over' : 'en_espera'}">${esc(ST_TXT[stt])}</span>`;
    const tbl = (title, n, headRow, rowsHtml, extra) => `<div class="card" style="overflow:auto;margin-top:10px"><h4 style="margin:10px 12px 0">${title} <span class="muted">${n ? `· ${n} con diferencia` : '· ✓ todo coincide'}</span></h4>
      <table class="inv"><thead><tr>${headRow}</tr></thead><tbody>${rowsHtml || '<tr><td class="muted" colspan="9">Sin diferencias</td></tr>'}</tbody>${extra || ''}</table></div>`;
    const N = (v, money) => `<td class="n">${money ? usd(v) : nf0.format(v)}</td>`;
    const D = (v, money) => `<td class="n ${Math.abs(v) >= 0.01 ? 'warn-txt' : ''}"><b>${v ? (money ? usd(v) : nf0.format(v)) : '·'}</b></td>`;
    box.innerHTML = `${head}
      <p class="muted" style="margin:6px 0">Libro: <b>${esc(x.name)}</b> · ${res.used.length} hoja(s) de liquidación usadas: ${res.used.map((s) => `${esc(s.name)} (${esc(fmtDate(s.fecha))}, ${esc(s.repartidor || '—')}, ${usd(s.total)})`).join(' · ') || '<b>ninguna</b>'}.</p>
      ${res.skipped.length ? `<div class="hint">No se usaron: ${res.skipped.map((s) => `${esc(s.name)} (${esc(s.motivo)}${s.fecha ? ', ' + esc(fmtDate(s.fecha)) : ''})`).join(' · ')}.</div>` : ''}
      <div class="kpi-row">
        <div class="kpi"><small>Excel · cargado</small><b>${usd(t.excel)}</b><small>${res.used.length} hojas</small></div>
        <div class="kpi"><small>App · cargado (hojas liquidadas)</small><b>${usd(t.app)}</b><small>antes de devoluciones y anulaciones</small></div>
        <div class="kpi"><small>Diferencia</small><b class="${Math.abs(t.dif) >= 0.01 ? 'warn-txt' : ''}">${usd(t.dif)}</b><small>Excel − app</small></div>
        <div class="kpi"><small>App · Venta liquidada</small><b>${usd(t.entregado)}</b><small>lo entregado de verdad (referencia)</small></div>
      </div>
      ${res.clean ? '<div class="hint">✓ <b>Comparación limpia:</b> el Excel y la app coinciden en productos, clientes, despachadores y vacíos de esta quincena.</div>'
        : `<div class="hint warn">⚠ <b>Hay diferencias que explicar:</b> ${c.products} producto(s) · ${c.clients} cliente(s) · ${c.dispatchers} despachador(es) · ${c.vacios} tipo(s) de vacío. El libro suma las cantidades <i>cargadas</i> (no resta devoluciones), por eso se compara contra lo cargado en la app.</div>`}
      <div class="row" style="gap:10px;margin:6px 0"><label class="row"><input type="checkbox" id="xcOnly" ${only ? 'checked' : ''} style="width:20px;height:20px"> Mostrar solo diferencias</label><span class="grow"></span><button class="btn btn-sm" id="xcCsv">⇩ Comparación (Excel)</button></div>
      ${tbl('Productos', c.products, '<th>Código</th><th>Producto</th><th class="n">Excel cant.</th><th class="n">App cant.</th><th class="n">Dif.</th><th class="n">Excel $</th><th class="n">App $</th><th class="n">Dif. $</th><th>Estado</th>',
        rowsOf(res.products).map((r) => `<tr><td class="mono">${esc(r.code)}</td><td>${esc(r.name)}</td>${N(r.excelQty)}${N(r.appQty)}${D(r.difQty)}${N(r.excelMonto, true)}${N(r.appMonto, true)}${D(r.difMonto, true)}<td>${badge(r.st)}</td></tr>`).join(''))}
      ${tbl('Clientes (monto cargado)', c.clients, '<th>Cliente</th><th class="n">Excel $</th><th class="n">App $</th><th class="n">Dif. $</th><th class="n">App · liquidado $</th><th>Estado</th>',
        rowsOf(res.clients).map((r) => `<tr><td><b>${esc(r.name)}</b></td>${N(r.excel, true)}${N(r.app, true)}${D(r.dif, true)}${N(r.entregado, true)}<td>${badge(r.st)}</td></tr>`).join(''))}
      ${tbl('Despachadores (monto cargado)', c.dispatchers, '<th>Excel (repartidor)</th><th>App (despachador)</th><th class="n">Excel $</th><th class="n">App $</th><th class="n">Dif. $</th><th>Estado</th>',
        rowsOf(res.dispatchers).map((r) => `<tr><td>${esc(r.excelName || '—')}</td><td>${esc(r.appName || '—')}</td>${N(r.excel, true)}${N(r.app, true)}${D(r.dif, true)}<td>${badge(r.st)}</td></tr>`).join(''))}
      ${tbl('Vacíos por tipo (cajas cargadas)', c.vacios, '<th>Tipo</th><th class="n">Excel</th><th class="n">App</th><th class="n">Dif.</th><th>Estado</th>',
        rowsOf(res.vacios).map((r) => `<tr><td><b>${esc(r.type)}</b></td>${N(r.excel)}${N(r.app)}${D(r.dif)}<td>${badge(r.st)}</td></tr>`).join(''))}`;
    $2('#xcOnly').onchange = (e) => { st.xcOnly = e.target.checked; renderCompare(box, d, st); };
    $2('#xcCsv').onclick = () => {
      const E = global.Exporta, st2 = (r) => ST_TXT[r.st];
      const sheets = [
        E.table({ name: 'Productos', title: `COMPARACIÓN EXCEL vs APP · ${d.from} a ${d.to}`, subtitle: `Libro ${x.name} · la diferencia es una fórmula (Excel − App); filtra la columna ESTADO para ver solo lo que no coincide`,
          cols: [{ h: 'CÓDIGO', w: 12 }, { h: 'PRODUCTO', w: 40 }, { h: 'EXCEL CANT.', k: 'int' }, { h: 'APP CANT.', k: 'int' }, { h: 'DIF. CANT.', k: 'int', total: true }, { h: 'EXCEL $', k: 'money', total: true }, { h: 'APP $', k: 'money', total: true }, { h: 'DIF. $', k: 'money', total: true }, { h: 'ESTADO', w: 22 }],
          rows: res.products.map((r, i) => { const xr = 5 + i; return [r.code, r.name, r.excelQty, r.appQty, { v: r.difQty, f: `C${xr}-D${xr}` }, r.excelMonto, r.appMonto, { v: r.difMonto, f: `F${xr}-G${xr}` }, st2(r)]; }) }),
        E.table({ name: 'Clientes', title: 'CLIENTES · monto cargado', cols: [{ h: 'CLIENTE', w: 46 }, { h: 'EXCEL $', k: 'money', total: true }, { h: 'APP $', k: 'money', total: true }, { h: 'DIF. $', k: 'money', total: true }, { h: 'APP · LIQUIDADO $', k: 'money', w: 18, total: true }, { h: 'ESTADO', w: 22 }],
          rows: res.clients.map((r, i) => { const xr = 5 + i; return [r.name, r.excel, r.app, { v: r.dif, f: `B${xr}-C${xr}` }, r.entregado, st2(r)]; }) }),
        E.table({ name: 'Despachadores', title: 'DESPACHADORES · monto cargado', cols: [{ h: 'EXCEL (REPARTIDOR)', w: 24 }, { h: 'APP (DESPACHADOR)', w: 24 }, { h: 'EXCEL $', k: 'money', total: true }, { h: 'APP $', k: 'money', total: true }, { h: 'DIF. $', k: 'money', total: true }, { h: 'ESTADO', w: 22 }],
          rows: res.dispatchers.map((r, i) => { const xr = 5 + i; return [r.excelName, r.appName, r.excel, r.app, { v: r.dif, f: `C${xr}-D${xr}` }, st2(r)]; }) }),
        E.table({ name: 'Vacíos', title: 'VACÍOS POR TIPO · cajas cargadas', cols: [{ h: 'TIPO', w: 12 }, { h: 'EXCEL', k: 'int', total: true }, { h: 'APP', k: 'int', total: true }, { h: 'DIF.', k: 'int', total: true }, { h: 'ESTADO', w: 22 }],
          rows: res.vacios.map((r, i) => { const xr = 5 + i; return [r.type, r.excel, r.app, { v: r.dif, f: `B${xr}-C${xr}` }, st2(r)]; }) }),
      ];
      E.save(`comparacion_excel_${d.from}_a_${d.to}.xlsx`, sheets);
    };
    bind();
    function $2(sel) { return box.querySelector(sel); }
    function bind() {
      const b = box.querySelector('#xcLoad'); if (!b) return;
      b.onclick = async () => {
        const file = await global.PV.pickFile('.xlsm,.xlsx,.xls');
        if (!file) return;
        b.disabled = true; b.textContent = 'Leyendo el libro…';
        try {
          const { XLSX, wb } = await global.Importer.readWorkbook(file);
          const parsed = global.ExcelCmp.parseWorkbook(XLSX, wb);
          if (!parsed.sheets.length) throw new Error('No encontré hojas de liquidación (NN_LIQ_X) en ese libro');
          st.xc = { name: file.name, parsed };
          renderCompare(box, d, st);
        } catch (e) { toast(e.message || 'No se pudo leer el libro', 'err'); renderCompare(box, d, st); }
      };
    }
  }

  /** Libro de Excel del reporte quincenal: una hoja por tema, con fórmulas en los totales. */
  function reportSheets(d, title, rubros) {
    const E = global.Exporta, t = d.totals, sub = `${title} · del ${d.from} al ${d.to} · Venta liquidada = lo entregado de verdad (hojas con la liquidación cerrada, sin devoluciones ni notas anuladas)`;
    const money = { border: true, fmt: 'money', align: 'right' }, int = { border: true, fmt: 'int', align: 'right' };
    const sv = summaryRows(d, 'seller'), sd = summaryRows(d, 'dispatcher');
    const sumCols = (who, disp) => [{ h: who, w: 26 }, ...(disp ? [{ h: 'HOJAS', k: 'int', total: true }] : []), { h: 'CLIENTES', k: 'int', total: true }, { h: 'CAJAS', k: 'int', total: true }, { h: 'VENTA LIQUIDADA $', k: 'money', w: 17, total: true },
      { h: 'VACÍOS DESPACHADOS', k: 'int', w: 14, total: true }, { h: 'VACÍOS RECIBIDOS', k: 'int', w: 14, total: true }, { h: 'VACÍOS ASIGNADOS', k: 'int', w: 14, total: true }, { h: 'QUEDAN DEBIENDO', k: 'int', w: 14, total: true },
      { h: disp ? 'DIFERENCIAS' : 'NOVEDADES', k: 'int', total: true }, { h: 'VENTA EN PROCESO $', k: 'money', w: 17, total: true }];
    const sumRow = (r, disp) => [r.name, ...(disp ? [r.hojas] : []), r.clients, r.cajas, r.monto, r.vacDesp, r.vacRecv, r.vacAsg, r.vacDebe, disp ? r.diferencias : r.novedades, r.procMonto];
    const resumen = E.blocks('Resumen', [
      { title: 'Venta liquidada y venta en proceso', cols: [{ h: 'CONCEPTO', w: 34 }, { h: 'VALOR', w: 18 }], rows: [
        ['VENTA LIQUIDADA $ (lo que paga el cliente)', { v: t.monto, s: { ...money, b: true } }], ['Venta en proceso $ (todavía puede cambiar)', { v: d.enProceso.monto, s: money }], ['Pedido original de lo liquidado $', { v: t.pedido, s: money }],
        ['Hojas liquidadas', { v: t.hojas, s: int }], ['Clientes atendidos', { v: t.clients, s: int }], ['Cajas liquidadas', { v: t.cajas, s: int }], ['Unidades sueltas', { v: t.unidades, s: int }],
        ['Hojas del período sin liquidar', { v: d.pendingLoads.length, s: int }]] },
      { title: 'Resumen de la quincena por vendedor', cols: sumCols('VENDEDOR', false), rows: sv.rows.map((r) => sumRow(r, false)) },
      { title: 'Resumen de la quincena por despachador', cols: sumCols('DESPACHADOR', true), rows: sd.rows.map((r) => sumRow(r, true)) },
      { title: 'Venta en proceso por etapa (no suma a la venta liquidada)', cols: [{ h: 'ETAPA', w: 34 }, { h: 'PEDIDOS', k: 'int', total: true }, { h: 'MONTO $', k: 'money', total: true }], rows: d.enProceso.stages.map((x) => [x.label, x.clients, x.monto]) },
    ], { title: 'REPORTE QUINCENAL', subtitle: sub });
    // Venta por categoría (cajas, unidades y monto) para vendedores y despachadores
    const catBlocks = [];
    [['seller', 'VENDEDOR'], ['dispatcher', 'DESPACHADOR']].forEach(([who, nm]) => {
      const g = catGrid(d, who, rubros), n = g.people.length;
      [['CAJAS', 'cajas', 'int'], ['UNIDADES SUELTAS', 'unidades', 'int'], ['MONTO $', 'monto', 'money']].forEach(([lab, f, k]) => {
        catBlocks.push({ title: `${lab} por categoría · por ${nm.toLowerCase()}`, cols: [{ h: 'CATEGORÍA', w: 26 }, ...g.people.map((p) => ({ h: p.name, k, w: 15, total: true })), { h: 'TOTAL CATEGORÍA', k, w: 16, rowSum: [1, n] }],
          rows: g.rows.map((r) => [r.category, ...r.cells.map((x) => x[f]), 0]) });
      });
    });
    const categorias = E.blocks('Por categoría', catBlocks, { title: 'VENTA LIQUIDADA POR CATEGORÍA', subtitle: 'Cada categoría se paga distinto: cajas y unidades por vendedor y por despachador (el total por categoría es una fórmula)' });
    const gridBlock = (ttl, g, k) => ({ title: ttl, cols: [{ h: 'VENDEDOR ↓ · DESPACHADOR →', w: 28 }, ...g.disps.map((x) => ({ h: x.name, k, w: 16, total: true })), { h: 'TOTAL VENDEDOR', k, w: 16, rowSum: [1, g.disps.length] }], rows: g.rows.map((r) => [r.name, ...r.cells, 0]) });
    const cuadre = E.blocks('Cuadre', [
      { ...gridBlock('Venta liquidada $: qué despachador repartió lo de cada vendedor', crossGrid(d, 'monto'), 'money'),
        note: d.cuadre.ok ? `✓ Cuadra: vendedores ${d.cuadre.sellerTotal} = despachadores ${d.cuadre.dispatcherTotal}` : `⚠ ${d.cuadre.diff ? 'No cuadra' : 'Falta asignar despachador'}: vendedores ${d.cuadre.sellerTotal} · despachadores ${d.cuadre.dispatcherTotal}` }, gridBlock('Vacíos despachados por vendedor y despachador', crossGrid(d, 'vacDesp'), 'int'),
    ], { title: 'CUADRE VENDEDOR ↔ DESPACHADOR', subtitle: 'Lo que vendió cada vendedor es lo que repartió algún despachador: las filas y las columnas deben sumar lo mismo' });
    const productos = E.table({ name: 'Productos', title: 'VENTAS POR PRODUCTO', subtitle: sub, cols: [{ h: 'CÓDIGO', w: 12 }, { h: 'PRODUCTO', w: 44 }, { h: 'CATEGORÍA', w: 18 }, { h: 'CAJAS', k: 'int', total: true }, { h: 'UNIDADES', k: 'int', total: true }, { h: 'MONTO $', k: 'money', total: true, w: 15 }],
      rows: d.byProduct.map((p) => [p.code, `${p.name} ${p.presentation || ''}`.trim(), p.category, p.cajas, p.unidades, p.monto]) });
    const camion = E.blocks('Camión', [
      { title: 'Diferencias de camión', cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'HOJA', w: 12 }, { h: 'DESPACHADOR', w: 18 }, { h: 'CÓDIGO', w: 10 }, { h: 'PRODUCTO', w: 36 }, { h: 'UM', w: 6, align: 'center' }, { h: 'DEBE QUEDAR', k: 'int' }, { h: 'DEVOLUCIÓN', k: 'int' }, { h: 'DIFERENCIA', k: 'int', total: true }, { h: 'MOTIVO', w: 30 }],
        rows: d.diferencias.map((x, i) => { const xr = 0; void xr; return [x.date, x.label || x.load, x.dispatcherName, x.code, x.name, x.um, x.debe, x.dev, x.dif, x.motivo]; }) },
      { title: 'Pasó a la siguiente carga (mismo despachador)', cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'HOJA', w: 12 }, { h: 'DESPACHADOR', w: 18 }, { h: 'CÓDIGO', w: 10 }, { h: 'PRODUCTO', w: 36 }, { h: 'UM', w: 6, align: 'center' }, { h: 'CANTIDAD', k: 'int', total: true }],
        rows: d.siguiente.map((x) => [x.date, x.label || x.load, x.dispatcherName, x.code, x.name, x.um, x.qty]) },
    ], { title: 'DIFERENCIAS DE CAMIÓN', subtitle: sub });
    const novedades = E.table({ name: 'Novedades', title: 'NOVEDADES DE LAS NOTAS', subtitle: sub, cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'CLIENTE', w: 36 }, { h: 'VENDEDOR', w: 18 }, { h: 'RESULTADO', w: 22 }, { h: 'NOTA', w: 10 }, { h: 'NOTA NUEVA', w: 12 }, { h: 'MOTIVO', w: 24 }, { h: 'PEDIDO $', k: 'money', total: true }, { h: 'ENTREGADO $', k: 'money', total: true }],
      rows: d.novedades.map((x) => [x.date, x.clientName, x.sellerName, RES[x.result] || x.result, x.valeryNote, x.newValery, x.motivo, x.pedido, x.entregado]) });
    const vc = [{ h: 'DESPACHADOS', k: 'int', total: true }, { h: 'RECIBIDOS', k: 'int', total: true }, { h: 'ASIGNADOS', k: 'int', total: true }, { h: 'QUEDAN DEBIENDO', k: 'int', total: true }];
    const va = [{ h: 'DEVUELTOS ENTREGAS ANTERIORES', k: 'int', total: true, w: 16 }, { h: 'TOTAL QUE ENTRAN', k: 'int', total: true, w: 12 }];
    const vacios = E.blocks('Vacíos', [
      { title: 'Vacíos por código (devoluciones posteriores = del kardex)', cols: [{ h: 'CÓDIGO', w: 14 }, { h: 'TIPO', w: 10, align: 'center' }, ...vc], rows: d.vacios.byCode.map((v) => [v.code, v.type, v.despachados, v.recibidos, v.asignados, v.debe]) },
      { title: 'Vacíos por despachador (los que trajo)', cols: [{ h: 'DESPACHADOR', w: 26 }, { h: 'TIPO', align: 'center' }, ...vc, ...va], rows: d.vacios.byDispatcher.map((v) => [v.name, v.type, v.despachados, v.recibidos, v.asignados, v.debe, v.anteriores || 0, v.recibidos + (v.anteriores || 0)]) },
      { title: 'Vacíos por vendedor del cliente', cols: [{ h: 'VENDEDOR', w: 26 }, { h: 'TIPO', align: 'center' }, ...vc, ...va], rows: d.vacios.bySeller.map((v) => [v.name, v.type, v.despachados, v.recibidos, v.asignados, v.debe, v.anteriores || 0, v.recibidos + (v.anteriores || 0)]) },
    ], { title: 'VACÍOS DE LO LIQUIDADO', subtitle: sub });
    const detalle = E.table({ name: 'Detalle', title: 'DETALLE POR CLIENTE', subtitle: sub, cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'HOJA', w: 12 }, { h: 'CLIENTE', w: 38 }, { h: 'VENDEDOR', w: 18 }, { h: 'DESPACHADOR', w: 18 }, { h: 'NOTA', w: 10 }, { h: 'RESULTADO', w: 20 }, { h: 'CAJAS', k: 'int', total: true }, { h: 'UNIDADES', k: 'int', total: true }, { h: 'MONTO $', k: 'money', total: true }],
      rows: d.detail.map((x) => [x.date, x.load, x.clientName, x.sellerName, x.dispatcherName, x.valeryNote, RES[x.result] || x.result, x.cajas, x.unidades, x.monto]) });
    return [resumen, categorias, cuadre, productos, camion, novedades, vacios, detalle];
  }

  /** Pantalla del reporte. Usa PV (helpers de la app). */
  function render(root, st) {
    const { S, $, esc, nf0, usd, toast, today, fmtDate } = global.PV;
    const f = st.f || (st.f = { mode: 'q', ...quincenaOf(today()) });
    const years = []; for (let y = +today().slice(0, 4); y >= 2025; y--) years.push(y);
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const range = f.mode === 'q' ? quincena(f.y, f.m, f.half) : { from: f.from || today(), to: f.to || today() };
    root.innerHTML = `
      <div class="toolbar" id="qzF">
        <label class="field"><span>Período</span><select class="select" data-q="mode">${opt([['q', 'Quincena'], ['r', 'Rango libre']], f.mode)}</select></label>
        ${f.mode === 'q' ? `
          <label class="field"><span>Quincena</span><select class="select" data-q="half">${opt([[1, '1ª (del 1 al 15)'], [2, '2ª (del 16 a fin de mes)']], f.half)}</select></label>
          <label class="field"><span>Mes</span><select class="select" data-q="m">${opt(MONTHS.map((x, i) => [i + 1, x]), f.m)}</select></label>
          <label class="field"><span>Año</span><select class="select" data-q="y">${opt(years.map((y) => [y, y]), f.y)}</select></label>`
        : `<label class="field"><span>Desde</span><input type="date" class="input" data-q="from" value="${esc(range.from)}"></label>
          <label class="field"><span>Hasta</span><input type="date" class="input" data-q="to" value="${esc(range.to)}"></label>`}
        <button class="btn btn-primary" id="qzGo">Consultar</button>
        ${f.mode === 'q' ? '<button class="btn btn-sm" id="qzCur">Quincena actual</button><button class="btn btn-sm" id="qzPrev">Quincena anterior</button>' : ''}
      </div>
      <p class="muted">Del <b>${esc(fmtDate(range.from))}</b> al <b>${esc(fmtDate(range.to))}</b>, por fecha de entrega (fecha de la carga). La <b>Venta liquidada</b> es lo que realmente se vendió (hojas con la liquidación cerrada, sin devoluciones ni notas anuladas). La <b>Venta en proceso</b> todavía puede cambiar y no suma a nadie.</p>
      <div id="qzOut">${st.data && st.key === range.from + range.to ? '' : '<p class="muted">Pulsa <b>Consultar</b>.</p>'}</div>`;
    if (st.data && st.key === range.from + range.to) out($('#qzOut'), st.data, f);
    $('#qzF').onchange = (e) => {
      const k = e.target.dataset.q; if (!k) return;
      f[k] = ['y', 'm', 'half'].includes(k) ? +e.target.value : e.target.value;
      if (k === 'mode' && f.mode === 'r') { f.from = range.from; f.to = range.to; }
      render(root, st);
    };
    const goQ = (q) => { Object.assign(f, { mode: 'q', y: q.y, m: q.m, half: q.half }); st.auto = true; render(root, st); };
    const bc = $('#qzCur'); if (bc) bc.onclick = () => goQ(quincenaOf(today()));
    const bp = $('#qzPrev'); if (bp) bp.onclick = () => goQ(prevQuincena(today()));
    $('#qzGo').onclick = async () => {
      const r0 = f.mode === 'q' ? quincena(f.y, f.m, f.half) : { from: f.from, to: f.to };
      if (!r0.from || !r0.to || r0.from > r0.to) { toast('Rango de fechas inválido', 'err'); return; }
      const o = $('#qzOut'); o.innerHTML = '<p class="muted">Calculando…</p>';
      const r = await global.Sync.readerCall('quincena', r0);
      if (!r.ok) { o.innerHTML = `<div class="empty card"><strong>No se pudo cargar</strong>${esc(r.error || '')}<br>El reporte se calcula en el servidor: se necesita internet.</div>`; return; }
      st.data = r.data; st.key = r0.from + r0.to;
      out(o, r.data, f);
    };

    if (st.auto || !st.data) { st.auto = false; $('#qzGo').click(); }

    function out(o, d, f2) {
      const t = d.totals;
      const tbl = (title, head, rows, foot) => `<div class="card" style="overflow:auto;margin-top:12px"><h3 style="padding:12px 12px 0;margin:0">${title}</h3><table class="inv">
        <thead><tr>${head.map((h) => `<th${h.n ? ' class="n"' : ''}>${esc(h.t)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}" class="muted">Sin datos</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table></div>`;
      const N = (t2) => ({ t: t2, n: true });
      // Ventas por producto agrupadas por categoría con subtotal
      let prodRows = '', cat = null, sub = null;
      const flush = () => { if (sub) prodRows += `<tr class="kx-sub"><td colspan="3"><b>Subtotal ${esc(cat)}</b></td><td class="n"><b>${nf0.format(sub.c)}</b></td><td class="n"><b>${nf0.format(sub.u)}</b></td><td class="n"><b>${usd(sub.m)}</b></td></tr>`; };
      d.byProduct.forEach((p) => {
        if (p.category !== cat) { flush(); cat = p.category; sub = { c: 0, u: 0, m: 0 }; }
        sub.c += p.cajas; sub.u += p.unidades; sub.m += p.monto;
        prodRows += `<tr><td class="mono">${esc(p.code)}</td><td>${esc(p.name)} <b>${esc(p.presentation)}</b></td><td>${esc(p.category)}</td><td class="n">${nf0.format(p.cajas)}</td><td class="n">${nf0.format(p.unidades)}</td><td class="n">${usd(p.monto)}</td></tr>`;
      });
      flush();
      // Vacíos por código con subtotal por tipo
      let vacRows = '', ty = null, vs = null;
      const vflush = () => { if (vs) vacRows += `<tr class="kx-sub"><td colspan="2"><b>Subtotal ${esc(ty)}</b></td><td class="n"><b>${vs.d}</b></td><td class="n"><b>${vs.r}</b></td><td class="n"><b>${vs.a}</b></td><td class="n"><b>${vs.q}</b></td><td class="n">${(d.vacios.devoluciones || {})[ty] || ''}</td></tr>`; };
      d.vacios.byCode.forEach((v) => {
        if (v.type !== ty) { vflush(); ty = v.type; vs = { d: 0, r: 0, a: 0, q: 0 }; }
        vs.d += v.despachados; vs.r += v.recibidos; vs.a += v.asignados; vs.q += v.debe;
        vacRows += `<tr><td class="mono">${esc(v.code)}</td><td>${esc(v.type)}</td><td class="n">${v.despachados}</td><td class="n">${v.recibidos}</td><td class="n">${v.asignados}</td><td class="n">${v.debe}</td><td></td></tr>`;
      });
      vflush();
      const vt = d.vacios.byCode.reduce((a, v) => ({ d: a.d + v.despachados, r: a.r + v.recibidos, a: a.a + v.asignados, q: a.q + v.debe }), { d: 0, r: 0, a: 0, q: 0 });
      const vacPeople = (arr, who) => arr.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.type)}</td><td class="n">${v.despachados}</td><td class="n">${v.recibidos}</td><td class="n">${v.asignados}</td><td class="n">${v.debe}</td><td class="n">${v.anteriores || ''}</td><td class="n">${v.recibidos + (v.anteriores || 0)}</td></tr>`).join('');
      const catTbl = (title, g) => {
        // Lo principal: cajas y unidades sueltas (de ahí sale la comisión); debajo, el monto
        const c = (x) => (x.monto || x.cajas || x.unidades ? `<b>${nf0.format(x.cajas)} cj${x.unidades ? ' + ' + nf0.format(x.unidades) + ' un' : ''}</b><div class="muted">${usd(x.monto)}</div>` : '<span class="muted">·</span>');
        return tbl(title, [{ t: 'Categoría' }, ...g.people.map((p) => N(p.name)), N('TOTAL categoría')],
          g.rows.map((r) => `<tr><td><b>${esc(r.category)}</b></td>${r.cells.map((x) => `<td class="n">${c(x)}</td>`).join('')}<td class="n">${c(r.total)}</td></tr>`).join(''),
          `<tr><td>TOTAL</td>${g.cols.map((x) => `<td class="n">${c(x)}</td>`).join('')}<td class="n">${c(g.total)}</td></tr>`);
      };
      const gridTbl = (title, g, money) => {
        const f = (v) => (v ? (money ? usd(v) : nf0.format(v)) : '<span class="muted">·</span>');
        return tbl(title, [{ t: 'Vendedor ↓ · Despachador →' }, ...g.disps.map((x) => N(x.name)), N('Total vendedor')],
          g.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td>${r.cells.map((v) => `<td class="n">${f(v)}</td>`).join('')}<td class="n"><b>${f(r.total)}</b></td></tr>`).join(''),
          `<tr><td>TOTAL DESPACHADOR</td>${g.cols.map((v) => `<td class="n">${f(v)}</td>`).join('')}<td class="n">${f(g.total)}</td></tr>`);
      };
      const cuadreHTML = (dd) => {
        const c = dd.cuadre;
        const banner = c.ok ? `<div class="hint">✓ <b>Cuadra:</b> lo que vendieron los vendedores (${usd(c.sellerTotal)}) es igual a lo que repartieron los despachadores (${usd(c.dispatcherTotal)}).</div>`
          : `<div class="hint warn">⚠ <b>${c.diff ? 'No cuadra' : 'Falta asignar despachador'}:</b> vendedores ${usd(c.sellerTotal)} · despachadores ${usd(c.dispatcherTotal)}${c.diff ? ` (diferencia ${usd(c.diff)})` : ' (los montos son iguales, pero una parte aparece como «Sin despachador»)'}.
            ${c.sinDespachador.clients ? `<br><b>${c.sinDespachador.clients} cliente(s) · ${usd(c.sinDespachador.monto)} liquidados en hojas SIN despachador</b>: ${c.sinDespachador.loads.map((l) => esc((l.label || l.code) + ' (' + fmtDate(l.date) + ')')).join(', ')}. Asígnalo en la hoja de carga.` : ''}</div>`;
        return banner + gridTbl('Cuadre · venta liquidada: qué despachador repartió lo de cada vendedor', crossGrid(dd, 'monto'), true) + gridTbl('Cuadre · vacíos despachados por vendedor y despachador', crossGrid(dd, 'vacDesp'), false);
      };
      const sumTable = (title, who, sm, disp) => tbl(title, [{ t: who }, ...(disp ? [N('Hojas')] : []), N('Clientes'), N('Cajas'), N('Venta liquidada'), N('Vacíos despachados'), N('Vacíos recibidos'), N('Vacíos asignados'), N('Quedan debiendo'), N(disp ? 'Diferencias' : 'Novedades'), N('Venta en proceso')],
        sm.rows.map((r) => `<tr><td><b>${esc(r.name)}</b></td>${disp ? `<td class="n">${r.hojas}</td>` : ''}<td class="n">${r.clients}</td><td class="n">${nf0.format(r.cajas)}</td><td class="n"><b>${usd(r.monto)}</b></td><td class="n">${r.vacDesp}</td><td class="n">${r.vacRecv}</td><td class="n">${r.vacAsg}</td><td class="n ${r.vacDebe ? 'warn-txt' : ''}">${r.vacDebe}</td><td class="n">${(disp ? r.diferencias : r.novedades) || ''}</td><td class="n muted">${r.procMonto ? usd(r.procMonto) : ''}</td></tr>`).join(''),
        `<tr><td>TOTAL</td>${disp ? `<td class="n">${sm.tot.hojas}</td>` : ''}<td class="n">${sm.tot.clients}</td><td class="n">${nf0.format(sm.tot.cajas)}</td><td class="n">${usd(sm.tot.monto)}</td><td class="n">${sm.tot.vacDesp}</td><td class="n">${sm.tot.vacRecv}</td><td class="n">${sm.tot.vacAsg}</td><td class="n">${sm.tot.vacDebe}</td><td class="n">${(disp ? sm.tot.diferencias : sm.tot.novedades) || ''}</td><td class="n">${usd(sm.tot.procMonto)}</td></tr>`);
      o.innerHTML = `
        ${d.pendingLoads.length ? `<div class="hint warn">⚠ <b>${d.pendingLoads.length} hoja${d.pendingLoads.length > 1 ? 's' : ''} del período sin liquidar</b> (${usd(d.pendingMonto)} en proceso): no se suman a la venta liquidada.
          <div class="muted" style="margin-top:4px">${d.pendingLoads.map((l) => `${esc(fmtDate(l.date))} · ${esc(l.label || l.code)} · ${esc(l.dispatcherName || 'sin despachador')} · ${usd(l.monto)} (${esc(l.liq)})`).join('<br>')}</div></div>` : '<div class="hint">✓ Todas las hojas del período están liquidadas.</div>'}
        ${d.sinFoto ? `<div class="hint">${d.sinFoto} hoja(s) se liquidaron antes de esta versión: no tienen el detalle de diferencias del camión.</div>` : ''}
        <div class="card card-pad no-print" id="xcBox" style="margin-bottom:12px"></div>
        <div id="tlBox"></div>
        <div class="toolbar no-print"><button class="btn" id="qzPrint">🖨 Imprimir reporte</button><button class="btn" id="qzCsv">⇩ Excel</button></div>
        <div class="kpi-row">
          <div class="kpi"><small>Venta liquidada</small><b>${usd(t.monto)}</b><small>${nf0.format(t.clients)} clientes · ${t.hojas} hojas · lo que paga el cliente</small></div>
          <div class="kpi"><small>Venta en proceso</small><b>${usd(d.enProceso.monto)}</b><small>${nf0.format(d.enProceso.clients)} pedidos · aún no cuenta</small></div>
          <div class="kpi"><small>Cajas · Unidades liquidadas</small><b>${nf0.format(t.cajas)}</b><small>${nf0.format(t.unidades)} unidades sueltas</small></div>
          <div class="kpi"><small>Vacíos despachados</small><b>${nf0.format(vt.d)}</b><small>${nf0.format(vt.r)} recibidos · ${nf0.format(vt.a)} asignados · ${nf0.format(vt.q)} quedan debiendo</small></div>
          <div class="kpi"><small>Novedades</small><b>${t.parcial + t.pendiente + t.anulada}</b><small>${t.parcial} dev. parcial · ${t.pendiente} después · ${t.anulada} anuladas</small></div>
        </div>
        ${tbl('Venta en proceso <span class="muted">(todavía puede cambiar)</span>', [{ t: 'Etapa' }, N('Pedidos'), N('Monto')], d.enProceso.stages.map((x) => `<tr><td>${esc(x.label)}</td><td class="n">${x.clients}</td><td class="n">${usd(x.monto)}</td></tr>`).join(''),
          `<tr><td>TOTAL EN PROCESO</td><td class="n">${d.enProceso.clients}</td><td class="n">${usd(d.enProceso.monto)}</td></tr>`)}
        ${sumTable('Resumen de la quincena por vendedor', 'Vendedor', summaryRows(d, 'seller'), false)}
        ${sumTable('Resumen de la quincena por despachador', 'Despachador', summaryRows(d, 'dispatcher'), true)}
        ${catTbl('Venta liquidada por categoría · por vendedor', catGrid(d, 'seller', S.config.rubros))}
        ${catTbl('Venta liquidada por categoría · por despachador', catGrid(d, 'dispatcher', S.config.rubros))}
        ${cuadreHTML(d)}
        ${tbl('Ventas por categoría', [{ t: 'Categoría' }, N('Cajas'), N('Unidades'), N('Monto')], d.byCategory.map((c) => `<tr><td><b>${esc(c.category)}</b></td><td class="n">${nf0.format(c.cajas)}</td><td class="n">${nf0.format(c.unidades)}</td><td class="n">${usd(c.monto)}</td></tr>`).join(''),
          `<tr><td>TOTAL</td><td class="n">${nf0.format(t.cajas)}</td><td class="n">${nf0.format(t.unidades)}</td><td class="n">${usd(t.monto)}</td></tr>`)}
        ${tbl('Ventas por producto', [{ t: 'Código' }, { t: 'Producto' }, { t: 'Categoría' }, N('Cajas'), N('Unidades'), N('Monto')], prodRows,
          `<tr><td colspan="3">TOTAL</td><td class="n">${nf0.format(t.cajas)}</td><td class="n">${nf0.format(t.unidades)}</td><td class="n">${usd(t.monto)}</td></tr>`)}
        ${tbl('Diferencias de camión', [{ t: 'Fecha' }, { t: 'Hoja' }, { t: 'Despachador' }, { t: 'Producto' }, N('Debe quedar'), N('Devolución'), N('Diferencia'), { t: 'Motivo' }],
          d.diferencias.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td><span class="mono muted">${esc(x.code)}</span> ${esc(x.name)} ${esc(x.presentation)} <span class="um ${esc(x.um)}">${esc(x.um)}</span></td><td class="n">${x.debe}</td><td class="n">${x.dev}</td><td class="n"><b>${x.dif}</b></td><td>${esc(x.motivo)}</td></tr>`).join(''))}
        ${d.siguiente.length ? tbl('Pasó a la siguiente carga (mismo despachador)', [{ t: 'Fecha' }, { t: 'Hoja' }, { t: 'Despachador' }, { t: 'Producto' }, N('Cantidad')],
          d.siguiente.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td><span class="mono muted">${esc(x.code)}</span> ${esc(x.name)} <span class="um ${esc(x.um)}">${esc(x.um)}</span></td><td class="n">${x.qty}</td></tr>`).join('')) : ''}
        ${tbl('Novedades de las notas', [{ t: 'Fecha' }, { t: 'Cliente' }, { t: 'Vendedor' }, { t: 'Resultado' }, { t: 'Nota' }, { t: 'Nota nueva' }, { t: 'Motivo' }, N('Pedido'), N('Entregado')],
          d.novedades.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td><b>${esc(x.clientName)}</b></td><td>${esc(x.sellerName)}</td><td>${esc(RES[x.result] || x.result)}</td><td class="mono">${esc(x.valeryNote)}</td><td class="mono">${esc(x.newValery)}</td><td>${esc(x.motivo)}</td><td class="n">${usd(x.pedido)}</td><td class="n">${usd(x.entregado)}</td></tr>`).join(''))}
        ${tbl('Vacíos por código <span class="muted">(de lo liquidado en el período)</span>', [{ t: 'Código' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo'), N('Devoluciones posteriores')], vacRows,
          `<tr><td colspan="2">TOTAL GENERAL</td><td class="n">${vt.d}</td><td class="n">${vt.r}</td><td class="n">${vt.a}</td><td class="n">${vt.q}</td><td class="n">${Object.values(d.vacios.devoluciones || {}).reduce((a, x) => a + x, 0) || ''}</td></tr>`)}
        ${tbl('Vacíos por despachador (los que trajo)', [{ t: 'Despachador' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo'), N('Devueltos entregas anteriores'), N('Total que entran')], vacPeople(d.vacios.byDispatcher))}
        ${tbl('Vacíos por vendedor del cliente', [{ t: 'Vendedor' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo'), N('Devueltos entregas anteriores'), N('Total que entran')], vacPeople(d.vacios.bySeller))}
        <p class="muted">${d.detail.length} clientes entregados en el período. El detalle completo va en el Excel.</p>`;
      renderCompare($('#xcBox'), d, st);
      renderLedger($('#tlBox'), d.from, d.to);
      $('#qzPrint').onclick = () => global.Print.printQuincena(d, { config: S.config, title: titleOf(f2), RES });
      $('#qzCsv').onclick = () => global.Exporta.save(`reporte_${d.from}_a_${d.to}.xlsx`, reportSheets(d, titleOf(f2), S.config.rubros));
    }
  }

  /* -------- Cuadre de despachos (camiones) y kardex del camión, por despachador -------- */
  const LCOLS = [['inicio', 'Venía de antes'], ['ajuste', 'Ajustes de QUEDAN'], ['cargado', 'Cargado'], ['anterior', 'Dev. entregas anteriores'], ['entregado', 'Entregado'],
    ['almacen', 'Volvió a almacén'], ['dif', 'Diferencia'], ['corteRec', 'Corte: llegó al almacén'], ['corteFalt', 'Corte: faltó'], ['final', 'Queda en el camión']];
  function ledgerName(k) { const [pid, um] = k.split('|'), p = global.PV.productById(pid) || {}; return `${p.code || pid} ${p.name || ''} ${p.presentation || ''} ${um}`.replace(/\s+/g, ' ').trim(); }
  function renderLedger(box, from, to) {
    const { S, esc, nf0, fmtDate } = global.PV;
    if (!box) return;
    const L = global.Liq.truckLedger(S.loads, from, to);
    const loadName = (id) => { const l = S.loads.find((x) => x.id === id); return l ? global.Loads.labelOf(l) : 'otra hoja'; };
    box.innerHTML = `<div class="card" style="overflow:auto;margin-top:12px"><h3 style="padding:12px 12px 0;margin:0">🚚 Cuadre de despachos <span class="muted" style="font-weight:400;font-size:13px">(por despachador · hojas liquidadas del período)</span></h3>
      <p class="muted" style="padding:0 12px">Venía + Ajustes + Cargado + Dev. anteriores − Entregado − Volvió a almacén − Diferencia − Corte = Queda en el camión. Faltante a cobrar = diferencias que faltan + lo que faltó en el corte.</p>
      ${L.length ? L.map((d) => `<div style="padding:0 12px 12px"><div class="row" style="align-items:center;gap:8px"><h3 class="grow" style="margin:6px 0">${esc(d.name)}</h3>
        <b class="${d.ok ? '' : 'warn-txt'}">${d.ok ? '✓ Cuadra' : '⚠ NO CUADRA'}</b>${d.faltantes.length ? ` · <b class="warn-txt">Faltante a cobrar: ${esc(d.faltantes.map((r) => r.faltante + ' ' + ledgerName(r.key)).join(', '))}</b>` : ''}</div>
        <table class="inv"><thead><tr><th>Producto</th>${LCOLS.map(([, t]) => `<th class="n">${esc(t)}</th>`).join('')}<th class="n">Faltante a cobrar</th><th>Cuadre</th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr class="${r.descuadre ? 'liq-bad' : ''}"><td>${esc(ledgerName(r.key))}</td>${LCOLS.map(([k]) => `<td class="n">${r[k] ? nf0.format(r[k]) : ''}</td>`).join('')}
          <td class="n ${r.faltante ? 'warn-txt' : ''}"><b>${r.faltante || ''}</b></td><td>${r.descuadre ? `<b class="warn-txt">⚠ ${r.descuadre > 0 ? 'faltan' : 'sobran'} ${Math.abs(r.descuadre)}</b>` : '✓'}</td></tr>`).join('')}</tbody></table>
        <details class="sr" style="margin-top:6px"><summary>📒 Kardex del camión de ${esc(d.name)} (${d.hojas.length} hojas)</summary>
          <table class="inv"><thead><tr><th>Hoja</th><th>Producto</th><th class="n">Traía</th><th class="n">Quedan</th><th class="n">Cargó</th><th class="n">Dev. ant.</th><th class="n">Entregó</th><th class="n">Almacén</th><th class="n">Pasó a otra carga</th><th class="n">Diferencia</th><th>Motivo</th></tr></thead>
          <tbody>${d.hojas.map((h) => h.rows.map((r, i) => `<tr>${i === 0 ? `<td rowspan="${h.rows.length}"><b>${esc(global.Loads.labelOf(h.load))}</b><div class="muted">${esc(fmtDate(h.load.date || ''))}</div></td>` : ''}<td>${esc(ledgerName(r.key))}</td>
            <td class="n">${r.traia || ''}</td><td class="n">${r.queda || ''}</td><td class="n">${r.carga || ''}</td><td class="n">${r.anterior || ''}</td><td class="n">${r.entregado || ''}</td><td class="n">${r.almacen || ''}</td>
            <td class="n">${r.sigue ? r.sigue + (r.destLoad ? ' → ' + esc(loadName(r.destLoad)) : '') : ''}</td><td class="n ${r.dif ? 'warn-txt' : ''}">${r.dif || ''}</td><td>${esc(r.motivo || '')}</td></tr>`).join('')).join('')}</tbody></table></details></div>`).join('')
        : '<p class="muted" style="padding:0 12px 12px">Sin hojas liquidadas con despachador en el período.</p>'}
      ${L.length ? '<div class="toolbar no-print" style="padding:0 12px 12px"><button class="btn" id="tlPrint">🖨 Imprimir cuadre de despachos</button><button class="btn" id="tlXlsx">⇩ Excel cuadre de despachos</button></div>' : ''}</div>`;
    const bp = box.querySelector('#tlPrint'); if (bp) bp.onclick = () => global.Print.printTruckLedger(L, { config: S.config, from, to, name: ledgerName, cols: LCOLS, loadName });
    const bx = box.querySelector('#tlXlsx'); if (bx) bx.onclick = () => global.Exporta.save(`cuadre_despachos_${from}_a_${to}.xlsx`, [global.Exporta.table({ name: 'Cuadre despachos',
      title: `CUADRE DE DESPACHOS · ${fmtDate(from)} al ${fmtDate(to)}`, subtitle: 'Venía + Ajustes + Cargado + Dev. anteriores − Entregado − Almacén − Diferencia − Corte = Queda en el camión',
      cols: [{ h: 'DESPACHADOR', w: 18 }, { h: 'PRODUCTO', w: 34 }, ...LCOLS.map(([, t]) => ({ h: t.toUpperCase(), k: 'int', total: true })), { h: 'FALTANTE A COBRAR', k: 'int', total: true }, { h: 'CUADRE', w: 14 }],
      rows: L.flatMap((d) => d.rows.map((r) => [d.name, ledgerName(r.key), ...LCOLS.map(([k]) => r[k]), r.faltante, r.descuadre ? `NO CUADRA (${r.descuadre})` : 'OK'])) }),
      global.Exporta.table({ name: 'Kardex camión', title: `KARDEX DEL CAMIÓN · ${fmtDate(from)} al ${fmtDate(to)}`,
        cols: [{ h: 'DESPACHADOR', w: 18 }, { h: 'HOJA', w: 16 }, { h: 'FECHA', w: 12, k: 'date' }, { h: 'PRODUCTO', w: 34 }, ...['TRAÍA', 'QUEDAN', 'CARGÓ', 'DEV. ANT.', 'ENTREGÓ', 'ALMACÉN', 'PASÓ A OTRA CARGA'].map((h) => ({ h, k: 'int', total: true })), { h: 'VA PARA', w: 16 }, { h: 'DIFERENCIA', k: 'int', total: true }, { h: 'MOTIVO', w: 20 }],
        rows: L.flatMap((d) => d.hojas.flatMap((h) => h.rows.map((r) => [d.name, global.Loads.labelOf(h.load), h.load.date || '', ledgerName(r.key), r.traia, r.queda, r.carga, r.anterior || 0, r.entregado, r.almacen, r.sigue, r.sigue ? (r.destLoad ? loadName(r.destLoad) : 'la próxima') : '', +r.dif || 0, r.motivo || '']))) })]);
  }

  global.Reportes = { lastDay, quincena, quincenaOf, prevQuincena, render, titleOf, summaryRows, crossGrid, catGrid };
})(window);
