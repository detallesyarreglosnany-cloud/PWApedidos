/* =========================================================================
 * print.js — Documentos imprimibles (se generan en un iframe aislado)
 *
 *   Hoja de carga    → horizontal, SIN precios: productos × clientes, totales
 *                      por producto y por cliente, despachador y firmas.
 *   Nota de entrega  → vertical, CON precios, una por cliente, en ORIGINAL
 *                      (cliente) y COPIA (empresa).
 * ========================================================================= */
(function (global) {
  'use strict';

  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
  const nf2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 0 });
  const fdate = (iso) => iso ? new Date(iso).toLocaleDateString('es-VE', { day: '2-digit', month: '2-digit', year: 'numeric' }) : '';
  const ftime = (iso) => iso ? new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) : '';
  const logoURL = () => new URL('./icons/logo-print.png', location.href).href;

  const BASE_CSS = `
    *{box-sizing:border-box} body{margin:0;font:11px/1.3 Arial,Helvetica,sans-serif;color:#111}
    h1,h2,h3{margin:0} .muted{color:#555} .num{text-align:right;font-variant-numeric:tabular-nums}
    .head{display:flex;gap:14px;align-items:center;border-bottom:3px solid #730101;padding-bottom:6px;margin-bottom:8px}
    .head img{height:62px} .head .co{flex:1} .head .co h1{font-size:15px;color:#730101;letter-spacing:.02em}
    .doc{border:2px solid #730101;border-radius:6px;padding:6px 10px;text-align:center;min-width:150px}
    .doc b{display:block;font-size:10px;color:#730101;letter-spacing:.08em} .doc span{font-size:17px;font-weight:900}
    .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:4px 12px;margin-bottom:8px}
    .meta div{border-bottom:1px solid #bbb;padding:2px 0} .meta b{font-size:9px;text-transform:uppercase;color:#555;display:block}
    table{border-collapse:collapse;width:100%} th,td{border:1px solid #444;padding:2px 4px}
    th{background:#730101;color:#fff;font-size:9px} .cat td{background:#eee;font-weight:bold;font-size:9px;letter-spacing:.05em}
    .tot{background:#f3e3e3;font-weight:bold} .sign{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:28px}
    .sign div{border-top:1px solid #000;text-align:center;padding-top:3px;font-size:10px}
    * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

  function header(cfg, title, code, extra) {
    const co = (cfg && cfg.company) || {};
    return `<div class="head"><img src="${esc(logoURL())}" alt="">
      <div class="co"><h1>${esc(co.name || 'Distribuidora')}</h1>
        <div class="muted">${esc([co.rif && 'RIF ' + co.rif, co.address, co.phone && 'Tel. ' + co.phone].filter(Boolean).join(' · '))}</div>
        ${extra || ''}</div>
      <div class="doc"><b>${esc(title)}</b><span>${esc(code)}</span></div></div>`;
  }

  function printHTML(title, css, body, fit) {
    const old = document.getElementById('printFrame');
    if (old) old.remove();
    const f = document.createElement('iframe');
    f.id = 'printFrame';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = `position:fixed;right:0;bottom:0;width:${fit ? fit.w + 'px' : 0};height:0;border:0;visibility:hidden`;
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`);
    d.close();
    const go = () => { if (fit) fitPages(d, fit); f.contentWindow.focus(); f.contentWindow.print(); };
    const imgs = [...d.images];
    Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))).then(() => setTimeout(go, 60));
  }

  // Área útil de carta horizontal con márgenes de 8 mm, en px CSS (96 por pulgada)
  const LETTER_LANDSCAPE = { w: Math.floor((279.4 - 16) / 25.4 * 96), h: Math.floor((215.9 - 16) / 25.4 * 96) };

  // Si la hoja no cabe en una página, se reduce lo justo para que quepa en UNA
  function fitPages(d, fit) {
    for (const el of d.querySelectorAll('.sheet')) {
      el.style.zoom = '';
      const w = Math.max(el.scrollWidth, ...[...el.querySelectorAll('table')].map((t) => t.scrollWidth));
      let k = Math.min(1, fit.w / w, fit.h / el.scrollHeight) * 0.98;
      if (k >= 0.98) continue;
      // Con escala chica las letras redondean hacia arriba: se mide de nuevo y se corrige
      for (let i = 0; i < 4; i++) {
        el.style.zoom = k.toFixed(3);
        const r = el.getBoundingClientRect();
        if (r.height <= fit.h && r.width <= fit.w) break;
        k *= Math.min(fit.h / r.height, fit.w / r.width) * 0.99;
      }
    }
  }

  /* --------------------------- Hoja de carga --------------------------- */
  function loadSheetHTML(load, orders, ctx) {
    const cfg = ctx.config;
    const m = Matrix.build(orders, 'bultos', { keepOrder: true, money: false, rubros: cfg.rubros, productRank: ctx.productRank });
    const u = ctx.usage;
    const extra = cfg.sheetExtraCols || ['VACÍOS', 'DEVOLUCIÓN'];
    const blanks = extra.map(() => '<td class="blank"></td>').join('');
    // VACÍOS: en las filas de cajas de productos retornables, la cantidad de esa fila
    const pById = new Map((ctx.products || []).map((p) => [p.id, p]));
    const extraCells = (r) => extra.map((x) => (Envases.isVacCol(x) && r.um === 'CJ' && Envases.isReturnable(pById.get(r.productId))
      ? `<td class="num vac">${nf0.format(r.total)}</td>` : '<td class="blank"></td>')).join('');
    let lastCat = null;
    const rows = m.rows.map((r) => {
      const first = lastCat !== null && r.category !== lastCat;
      lastCat = r.category;
      return `<tr${first ? ' class="grp"' : ''}><td class="p"><span class="muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b> <span class="um">${r.um}</span></td>
        ${r.cells.map((v) => `<td class="num${v ? ' has' : ''}">${v ? nf0.format(v) : ''}</td>`).join('')}<td class="num tot">${nf0.format(r.total)}</td>${extraCells(r)}</tr>`;
    }).join('');
    // Al pie, una sola fila: el total de todo (cajas + unidades sueltas)
    const vacTotal = m.rows.filter((r) => r.um === 'CJ' && Envases.isReturnable(pById.get(r.productId))).reduce((a, r) => a + r.total, 0);
    const extraTot = extra.map((x) => (Envases.isVacCol(x) ? `<td class="num tot">${nf0.format(vacTotal)}</td>` : '<td class="blank"></td>')).join('');
    const foot = m.footer.filter((f) => f.key === 'TOTAL_BULTOS').map((f) => `<tr class="tot"><td>TOTAL (cajas + unidades)</td>${f.cells.map((v) => `<td class="num">${nf0.format(v)}</td>`).join('')}<td class="num tot">${nf0.format(f.total)}</td>${extraTot}</tr>`).join('')
      // Vacíos al pie (solo si la hoja lleva retornables)
      + (vacTotal ? Envases.sheetRows(m.cols.map((c) => c.order), pById).map((v) => `<tr class="vacrow"><td>${esc(v.label)}</td>${v.cells.map((x) => `<td class="num">${x ? nf0.format(x) : ''}</td>`).join('')}<td class="num tot">${nf0.format(v.total)}</td>${blanks}</tr>`).join('') : '');
    const code = load.number ? Loads.loadCode(load) : 'BORRADOR';
    const fecha = load.date || String(load.closedAt || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
    const [yy, mm, dd] = fecha.split('-');
    return `
      <section class="sheet">
      ${header(cfg, 'HOJA DE CARGA · ' + code, Loads.labelOf(load))}
      <div class="meta">
        <div><b>Fecha de la carga</b>${esc(dd + '/' + mm + '/' + yy)}</div>
        <div><b>Pedidos del</b>${esc(Loads.orderDateRange(orders) || '—')}</div>
        <div><b>Ruta</b>${esc(load.route || '—')}</div>
        <div><b>Despachador</b>${esc(load.dispatcherName || '—')}</div>
        <div><b>Vendedor(es)</b>${esc(load.sellerName)}</div>
        <div><b>Estado</b>${esc(ctx.statusName || '')}</div>
        <div><b>Clientes · ${u.measure === 'unidades' ? 'Unidades' : 'Bultos'}</b>${m.cols.length} / ${u.maxClients} · ${nf0.format(u.used)} / ${nf0.format(u.limit)}</div>
      </div>
      <table class="load ${m.cols.length > 14 ? 'many' : ''}"><thead>
        <tr class="ini"><th style="text-align:right">VENDEDOR →</th>${m.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}<th></th>${extra.map(() => '<th></th>').join('')}</tr>
        <tr><th style="text-align:left">PRODUCTO</th>
        ${m.cols.map((c, i) => `<th class="cl"><div>${i + 1}. ${esc(c.client)}</div></th>`).join('')}<th class="cl tcol"><div>TOTAL</div></th>
        ${extra.map((x) => `<th class="cl"><div>${esc(x)}</div></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody><tfoot>${foot}</tfoot></table>
      <p class="muted foot">CJ = cajas · UN = unidades sueltas. Clientes: ${m.cols.map((c, i) => `${i + 1}. ${esc(c.client)} (${esc(Loads.initials(c.order.sellerName))})`).join(' · ')}</p>
      <div class="sign"><div>Despachador</div><div>Almacén</div><div>Vendedor</div><div>Control / Oficina</div></div>
      </section>`;
  }

  // Hoja de carga: SIN rellenos ni franjas (ahorra tinta), todo en negro, letra 12
  // y totales a 14. La tabla toma solo el ancho que necesita: con pocos clientes
  // las columnas quedan pegadas al producto. Los nombres de clientes se reparten
  // en 2-3 líneas en vez de estirarse hacia arriba.
  const LOAD_CSS = `@page{size:letter landscape;margin:8mm} .sheet+.sheet{page-break-before:always}
    .sheet,.sheet *{color:#000 !important;background:transparent !important;-webkit-print-color-adjust:economy;print-color-adjust:economy}
    .sheet .head{border-bottom:2px solid #000;padding-bottom:3px;margin-bottom:4px} .sheet .head img{height:40px} .sheet .doc{border-color:#000;padding:3px 8px}
    .sheet .meta{grid-template-columns:repeat(8,auto);gap:0 10px;margin-bottom:4px} .sheet .meta div{padding:1px 0}
    table.load{width:auto} table.load.many{width:100%}
    table.load th,table.load td{font-size:12px;line-height:1.2;border:1px solid #000;padding:1px 4px}
    table.load th{font-weight:bold}
    th.cl{vertical-align:bottom;padding:3px 2px;min-width:22px}
    th.cl div{writing-mode:vertical-rl;transform:rotate(180deg);white-space:normal;height:130px;line-height:1.1;text-align:left;display:inline-block;overflow-wrap:anywhere}
    td.p{white-space:nowrap}
    .um{font-size:9px;line-height:1;font-weight:bold;border:1px solid #000;border-radius:3px;padding:0 2px;margin-left:3px}
    table.load td.num{padding:1px 2px}
    tr.ini th{font-size:10px}
    tr.grp td{border-top:2px solid #000}
    td.has{font-weight:bold}
    table.load td.tot,table.load th.tcol{font-size:14px;font-weight:900;border-left:2px solid #000;border-right:2px solid #000}
    table.load tfoot td{font-size:14px;font-weight:900;border-top:2px solid #000}
    td.blank{min-width:34px} td.vac{font-weight:900} tr.vacrow td{font-weight:700;border-top:1px dashed #000}
    .sheet .foot{margin:3px 0 0;font-size:9px} .sheet .sign{margin-top:14px}`;

  function printLoadSheet(load, orders, ctx) {
    printHTML('Hoja de carga ' + Loads.loadCode(load), LOAD_CSS, loadSheetHTML(load, orders, ctx), LETTER_LANDSCAPE);
  }

  /* --------------------------- Liquidación --------------------------- */
  // Horizontal, UNA tabla como la hoja de carga: productos × clientes con lo
  // entregado (↩ devuelto), arriba la nota Valery y la novedad de cada cliente,
  // a la derecha el cuadre del camión y el $ por producto; al pie el $ por
  // cliente y los vacíos.
  function liquidationHTML(load, st, ctx) {
    const cfg = ctx.config, liq = st.liq, rate = +cfg.exchangeRate || 0;
    const sh = Liq.sheet(st.os, liq, st.rows, st.vac);
    const n = sh.cols.length, R = 10; // columnas del lado derecho
    const blankR = (k) => `<td colspan="${k}" class="nob"></td>`;
    let lastCat = null;
    const body = sh.rows.map((r) => {
      const first = lastCat !== null && r.category !== lastCat; lastCat = r.category;
      return `<tr class="${first ? 'grp ' : ''}${r.dif ? 'nov' : ''}"><td class="p"><span class="muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b> <span class="um">${r.um}</span></td>
        ${r.cells.map((c) => `<td class="num${c.del ? ' has' : ''}">${c.del ? nf0.format(c.del) : ''}${c.ret ? `<span class="ret">↩${c.ret}</span>` : ''}</td>`).join('')}
        <td class="num tot">${nf0.format(r.entregado)}</td><td class="num">${r.queda ? nf0.format(r.queda) : ''}</td><td class="num">${nf0.format(r.carga)}</td><td class="num">${nf0.format(r.total)}</td>
        <td class="num tot">${nf0.format(r.debe)}</td><td class="num">${r.dev === null ? '' : nf0.format(r.dev)}</td><td class="num tot">${r.dif === null ? '' : nf0.format(r.dif)}</td>
        <td class="mot">${esc(r.motivo)}</td><td class="mot">${r.debe > 0 || r.dev > 0 ? (r.dest === 'siguiente' ? 'Sig. carga' : 'Almacén') : ''}</td><td class="num usd">${nf2.format(r.usd)}</td></tr>`;
    }).join('');
    const foot = `<tr class="tot"><td>TOTAL (cajas + unidades)</td>${sh.totals.bultos.map((v) => `<td class="num">${nf0.format(v)}</td>`).join('')}<td class="num tot">${nf0.format(sh.totals.bultos.reduce((x, y) => x + y, 0))}</td>${blankR(R - 1)}</tr>
      <tr class="tot money"><td>TOTAL $ POR CLIENTE</td>${sh.totals.monto.map((v) => `<td class="num">${nf2.format(v)}</td>`).join('')}${blankR(R - 1)}<td class="num usd">${nf2.format(sh.totals.usd)}</td></tr>
      ${rate ? `<tr class="tot"><td>TOTAL Bs (tasa ${nf2.format(rate)})</td>${sh.totals.monto.map((v) => `<td class="num">${nf0.format(v * rate)}</td>`).join('')}${blankR(R - 1)}<td class="num usd">${nf0.format(sh.totals.usd * rate)}</td></tr>` : ''}
      ${sh.vac.map((v) => `<tr class="vacrow k-${v.key}"><td>${esc(v.label)}</td>${v.cells.map((x) => `<td class="num">${x === null ? '' : nf0.format(x)}</td>`).join('')}<td class="num tot">${nf0.format(v.total)}</td>${blankR(R - 1)}</tr>`).join('')}`;
    const novs = sh.cols.map((c, i) => ({ c, i })).filter(({ c }) => c.entry.result !== 'entregada');
    const done = Liq.isDone(load);
    return `<section class="sheet">
      ${header(cfg, 'LIQUIDACIÓN · ' + (load.number ? Loads.loadCode(load) : 'BORRADOR'), Loads.labelOf(load))}
      <div class="meta">
        <div><b>Fecha de la carga</b>${esc(load.date || '—')}</div>
        <div><b>Pedidos del</b>${esc(Loads.orderDateRange(st.os) || '—')}</div>
        <div><b>Ruta</b>${esc(load.route || '—')}</div>
        <div><b>Despachador</b>${esc(load.dispatcherName || '—')}</div>
        <div><b>Vendedor(es)</b>${esc(load.sellerName)}</div>
        <div><b>Estado</b>${done ? 'Liquidada ' + esc(fdate(liq.closedAt)) : 'BORRADOR'}</div>
        <div><b>Clientes</b>${n}</div>
        <div><b>Total entregado $</b>${nf2.format(sh.totals.usd)}</div>
      </div>
      <table class="load liq ${n > 14 ? 'many' : ''}"><thead>
        <tr class="ini"><th style="text-align:right">VENDEDOR →</th>${sh.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr class="ini nota"><th style="text-align:right">NOTA VALERY →</th>${sh.cols.map((c) => `<th>${esc(c.order.valeryNote || '')}${c.entry.result === 'parcial' && c.entry.newValery ? `<br>→${esc(c.entry.newValery)}` : ''}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr class="ini novd"><th style="text-align:right">NOVEDAD →</th>${sh.cols.map((c) => `<th>${esc(Liq.shortResult(c.entry))}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr><th style="text-align:left">PRODUCTO</th>${sh.cols.map((c, i) => `<th class="cl"><div>${i + 1}. ${esc(c.order.clientName)}</div></th>`).join('')}
          ${['ENTREGADO', 'QUEDAN', 'CARGA', 'TOTAL', 'DEBE QUEDAR', 'DEVOLUCIÓN', 'DIFERENCIA', 'MOTIVO', 'LO QUE SOBRA', 'TOTAL $'].map((x) => `<th class="cl rt"><div>${x}</div></th>`).join('')}</tr></thead>
        <tbody>${body}</tbody><tfoot>${foot}</tfoot></table>
      ${novs.length ? `<p class="novs"><b>Novedades:</b> ${novs.map(({ c, i }) => `${i + 1}. ${esc(c.order.clientName)} — ${esc(Liq.shortResult(c.entry).toLowerCase())}${c.entry.result === 'parcial' || c.entry.result === 'anulada' ? ` · nota ${esc(c.order.valeryNote || '—')} anulada` : ''}${c.entry.newValery && c.entry.result === 'parcial' ? ` → nueva ${esc(c.entry.newValery)}` : ''}${c.entry.motivo ? ` · ${esc(c.entry.motivo)}` : ''}`).join(' &nbsp;|&nbsp; ')}</p>` : ''}
      ${st.vac.some((v) => v.pending) ? `<p class="novs"><b>Vacíos que quedan debiendo:</b> ${st.vac.filter((v) => v.pending).map((v) => `${esc(v.client)} — ${v.pending} ${esc(v.code)} (${esc(v.motivo || (v.regime === 'prestamo' ? 'PRÉSTAMO' : 'sin motivo'))})`).join(' &nbsp;|&nbsp; ')}</p>` : ''}
      <p class="muted foot">↩ = devuelto por el cliente · Total = Quedan + Carga · Debe quedar = Total − Entregado · Diferencia = Debe quedar − Devolución · Vacíos: Despachados − Recibidos − Asignados = Quedan debiendo.</p>
      <div class="sign"><div>Despachador</div><div>Almacén</div><div>Liquidó (oficina)</div><div>Gerencia</div></div>
      </section>`;
  }
  const LIQ_CSS = LOAD_CSS + ` td.nob,th.nob{border:0 !important} table.load.liq td.mot{font-size:10px;white-space:nowrap}
    table.load.liq .ret{display:block;font-size:9px;font-weight:bold;line-height:1} tr.nov td{font-weight:bold}
    table.load.liq th.rt div{height:90px} table.load.liq td.usd{font-weight:900;border-left:2px solid #000}
    tr.nota th{font-size:9px;font-weight:bold;white-space:nowrap} tr.novd th{font-size:8px;line-height:1;white-space:normal;max-width:40px}
    tr.money td{font-weight:900} table.load.liq td.p{white-space:normal;min-width:120px;max-width:150px;line-height:1.05;overflow-wrap:anywhere;padding:1px 3px}
    table.load.liq td.p .um{white-space:nowrap} table.load.liq tfoot td:first-child{white-space:normal;max-width:150px;line-height:1.05}
    table.load.liq th.cl div{height:175px} table.load.liq th.rt div{height:90px} table.load.liq tr.money td{font-size:10px;padding:1px 1px} table.load.liq tr.money td.usd{font-size:13px} tr.vacrow.k-DESPACHADOS td{border-top:2px solid #000} tr.vacrow.k-DEBEN td{font-weight:900} .sheet .novs{margin:4px 0 0;font-size:10px}`;

  function printLiquidation(load, st, ctx) {
    printHTML('Liquidación ' + Loads.loadCode(load), LIQ_CSS, liquidationHTML(load, st, ctx), LETTER_LANDSCAPE);
  }

  /* ------------------------ Saldos de vacíos (E4) ------------------------ */
  function printKardex(list, types, ctx) {
    const body = `<section class="sheet">${header(ctx.config, 'SALDOS DE VACÍOS', fdate(new Date().toISOString()))}
      <table class="load wide"><thead><tr><th style="text-align:left">#</th><th style="text-align:left">CLIENTE</th><th style="text-align:left">VENDEDOR</th>
        ${types.map((t) => `<th>${esc(t)} DEBE</th><th>${esc(t)} ASIG.</th>`).join('')}</tr></thead>
      <tbody>${list.map((c, i) => `<tr><td>${i + 1}</td><td>${esc(c.clientName)}</td><td>${esc(c.sellerName || '')}</td>
        ${types.map((t) => { const b = c.types[t] || {}; return `<td class="num tot">${b.debe ? nf0.format(b.debe) : ''}</td><td class="num">${b.asignados ? nf0.format(b.asignados) : ''}</td>`; }).join('')}</tr>`).join('')}</tbody>
      <tfoot><tr class="tot"><td colspan="3">TOTAL</td>${types.map((t) => `<td class="num">${nf0.format(list.reduce((a, c) => a + ((c.types[t] || {}).debe || 0), 0))}</td><td class="num">${nf0.format(list.reduce((a, c) => a + ((c.types[t] || {}).asignados || 0), 0))}</td>`).join('')}</tr></tfoot></table>
      <p class="muted foot">Debe = despachados − recibidos − asignados − devoluciones (+ saldo de apertura). Asig. = vacíos asignados que tiene el cliente.</p></section>`;
    printHTML('Saldos de vacíos', LOAD_CSS + ' table.load.wide{width:100%} @page{size:letter portrait;margin:10mm}', body);
  }

  /* ------------------------ Reporte quincenal (E5) ------------------------ */
  function printQuincena(d, ctx) {
    const t = d.totals, RES = ctx.RES || {};
    const tbl = (title, head, rows, foot) => `<h3>${title}</h3><table class="rep"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="${head.length}">Sin datos</td></tr>`}</tbody>${foot ? `<tfoot>${foot}</tfoot>` : ''}</table>`;
    const n = (v) => `<td class="num">${nf0.format(v || 0)}</td>`, m = (v) => `<td class="num">${nf2.format(v || 0)}</td>`;
    let prod = '', cat = null, sub = null;
    const flush = () => { if (sub) prod += `<tr class="tot"><td colspan="2">Subtotal ${esc(cat)}</td>${n(sub.c)}${n(sub.u)}${m(sub.m)}</tr>`; };
    d.byProduct.forEach((p) => { if (p.category !== cat) { flush(); cat = p.category; sub = { c: 0, u: 0, m: 0 }; } sub.c += p.cajas; sub.u += p.unidades; sub.m += p.monto;
      prod += `<tr><td>${esc(p.code)}</td><td>${esc(p.name)} ${esc(p.presentation)}</td>${n(p.cajas)}${n(p.unidades)}${m(p.monto)}</tr>`; });
    flush();
    let vac = '', ty = null, vs = null;
    const vflush = () => { if (vs) vac += `<tr class="tot"><td colspan="2">Subtotal ${esc(ty)}</td>${n(vs.d)}${n(vs.r)}${n(vs.a)}${n(vs.q)}<td class="num">${(d.vacios.devoluciones || {})[ty] || ''}</td></tr>`; };
    d.vacios.byCode.forEach((v) => { if (v.type !== ty) { vflush(); ty = v.type; vs = { d: 0, r: 0, a: 0, q: 0 }; } vs.d += v.despachados; vs.r += v.recibidos; vs.a += v.asignados; vs.q += v.debe;
      vac += `<tr><td>${esc(v.code)}</td><td>${esc(v.type)}</td>${n(v.despachados)}${n(v.recibidos)}${n(v.asignados)}${n(v.debe)}<td></td></tr>`; });
    vflush();
    const vt = d.vacios.byCode.reduce((a, v) => ({ d: a.d + v.despachados, r: a.r + v.recibidos, a: a.a + v.asignados, q: a.q + v.debe }), { d: 0, r: 0, a: 0, q: 0 });
    const people = (arr) => arr.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.type)}</td>${n(v.despachados)}${n(v.recibidos)}${n(v.asignados)}${n(v.debe)}</tr>`).join('');
    const body = `<section>
      ${header(ctx.config, 'REPORTE · ' + (ctx.title || ''), fdate(d.from + 'T12:00:00') + ' al ' + fdate(d.to + 'T12:00:00'))}
      <p class="muted">Solo lo entregado en hojas liquidadas, por fecha de entrega. ${d.pendingLoads.length ? `<b>${d.pendingLoads.length} hoja(s) del período sin liquidar (${nf2.format(d.pendingMonto)} $) no se suman.</b>` : 'Todas las hojas del período están liquidadas.'}</p>
      <div class="meta">
        <div><b>Venta entregada $</b>${nf2.format(t.monto)}</div><div><b>Pedido $</b>${nf2.format(t.pedido)}</div>
        <div><b>Hojas liquidadas</b>${t.hojas}</div><div><b>Clientes atendidos</b>${t.clients}</div>
        <div><b>Cajas</b>${nf0.format(t.cajas)}</div><div><b>Unidades sueltas</b>${nf0.format(t.unidades)}</div>
        <div><b>Devoluciones parciales</b>${t.parcial}</div><div><b>Anuladas · después</b>${t.anulada} · ${t.pendiente}</div>
      </div>
      ${tbl('Ventas por categoría', ['Categoría', 'Cajas', 'Unidades', 'Monto $'], d.byCategory.map((c) => `<tr><td>${esc(c.category)}</td>${n(c.cajas)}${n(c.unidades)}${m(c.monto)}</tr>`).join(''), `<tr class="tot"><td>TOTAL</td>${n(t.cajas)}${n(t.unidades)}${m(t.monto)}</tr>`)}
      ${tbl('Ventas por producto', ['Código', 'Producto', 'Cajas', 'Unidades', 'Monto $'], prod, `<tr class="tot"><td colspan="2">TOTAL</td>${n(t.cajas)}${n(t.unidades)}${m(t.monto)}</tr>`)}
      ${tbl('Por vendedor', ['Vendedor', 'Clientes', 'Cajas', 'Unidades', 'Monto $', 'Novedades'], d.bySeller.map((s) => `<tr><td>${esc(s.sellerName)}</td>${n(s.clients)}${n(s.cajas)}${n(s.unidades)}${m(s.monto)}${n(s.novedades)}</tr>`).join(''))}
      ${tbl('Despachos por despachador', ['Despachador', 'Hojas', 'Clientes', 'Cajas', 'Unidades', 'Monto $', 'Diferencias'], d.byDispatcher.map((x) => `<tr><td>${esc(x.dispatcherName)}</td>${n(x.hojas)}${n(x.clients)}${n(x.cajas)}${n(x.unidades)}${m(x.monto)}${n(x.diferencias)}</tr>`).join(''))}
      ${tbl('Diferencias de camión', ['Fecha', 'Hoja', 'Despachador', 'Producto', 'Debe quedar', 'Devolución', 'Diferencia', 'Motivo'], d.diferencias.map((x) => `<tr><td>${esc(fdate(x.date + 'T12:00:00'))}</td><td>${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td>${esc(x.code)} ${esc(x.name)} ${esc(x.um)}</td>${n(x.debe)}${n(x.dev)}${n(x.dif)}<td>${esc(x.motivo)}</td></tr>`).join(''))}
      ${tbl('Novedades de las notas', ['Fecha', 'Cliente', 'Vendedor', 'Resultado', 'Nota', 'Nota nueva', 'Motivo', 'Pedido $', 'Entregado $'], d.novedades.map((x) => `<tr><td>${esc(fdate(x.date + 'T12:00:00'))}</td><td>${esc(x.clientName)}</td><td>${esc(x.sellerName)}</td><td>${esc(RES[x.result] || x.result)}</td><td>${esc(x.valeryNote)}</td><td>${esc(x.newValery)}</td><td>${esc(x.motivo)}</td>${m(x.pedido)}${m(x.entregado)}</tr>`).join(''))}
      ${tbl('Vacíos por código', ['Código', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo', 'Devoluciones posteriores'], vac, `<tr class="tot"><td colspan="2">TOTAL GENERAL</td>${n(vt.d)}${n(vt.r)}${n(vt.a)}${n(vt.q)}<td class="num">${Object.values(d.vacios.devoluciones || {}).reduce((a, x) => a + x, 0) || ''}</td></tr>`)}
      ${tbl('Vacíos por despachador', ['Despachador', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo'], people(d.vacios.byDispatcher))}
      ${tbl('Vacíos por vendedor del cliente', ['Vendedor', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo'], people(d.vacios.bySeller))}
      <div class="sign" style="grid-template-columns:repeat(3,1fr)"><div>Elaborado (oficina)</div><div>Revisado</div><div>Gerencia</div></div>
      </section>`;
    printHTML('Reporte ' + d.from + ' a ' + d.to, `@page{size:letter portrait;margin:10mm} h3{font-size:12px;margin:10px 0 3px;color:#730101}
      table.rep{margin-bottom:4px} table.rep th{font-size:9px} table.rep td{font-size:10px} table.rep tr.tot td{font-weight:bold;background:#f3e3e3} table.rep{page-break-inside:auto} table.rep tr{page-break-inside:avoid}`, body);
  }

  /* ------------------------- Notas de entrega ------------------------- */
  function noteHTML(order, ctx, copy) {
    const cfg = ctx.config, client = ctx.clientsById.get(order.clientId) || {};
    const rate = +cfg.exchangeRate || 0;
    const t = Matrix.orderTotals(order);
    const lines = Object.values(order.lines || {}).map((l) => ({ l, x: Matrix.lineTotals(l) })).filter(({ x }) => x.cajas || x.unidades)
      .sort((a, b) => a.l.code.localeCompare(b.l.code, 'es', { numeric: true }));
    const code = order.noteNumber ? Loads.noteCode(order.noteNumber) : 'BORRADOR';
    return `
      <section class="note">
        <div class="copy">${copy}</div>
        ${header(cfg, 'NOTA DE ENTREGA', code)}
        <div class="meta">
          <div style="grid-column:span 2"><b>Cliente</b>${esc(order.clientName)}</div>
          <div><b>RIF / C.I.</b>${esc(client.rif || order.clientRif || '—')}</div>
          <div><b>Teléfono</b>${esc(client.phone || '—')}</div>
          <div style="grid-column:span 2"><b>Dirección</b>${esc(client.address || '—')}</div>
          <div><b>Fecha</b>${esc(fdate(order.dispatchedAt || new Date().toISOString()))}</div>
          <div><b>Condición</b>${client.creditDays ? 'Crédito ' + esc(client.creditDays) + ' días' : 'Contado'}</div>
          <div><b>Vendedor</b>${esc(order.sellerName)}</div>
          <div><b>Ruta</b>${esc(order.route || '—')}</div>
          <div><b>Despachador</b>${esc(ctx.load ? ctx.load.dispatcherName : '—')}</div>
          <div><b>Hoja de carga</b>${esc(ctx.load ? Loads.loadCode(ctx.load) : '—')}</div>
        </div>
        <table><thead><tr><th>Código</th><th style="text-align:left">Descripción</th><th>Cajas</th><th>Unid.</th><th>P. caja $</th><th>P. unid. $</th><th>Subtotal $</th></tr></thead>
          <tbody>${lines.map(({ l, x }) => `<tr><td>${esc(l.code)}</td><td>${esc(l.name)} ${esc(l.presentation)}${l.unitsPerBox > 1 ? ` <span class="muted">(x${l.unitsPerBox})</span>` : ''}</td>
            <td class="num">${x.cajas || ''}</td><td class="num">${x.unidades || ''}</td>
            <td class="num">${l.boxPrice ? nf2.format(l.boxPrice) : '—'}</td><td class="num">${l.unitPrice ? nf2.format(l.unitPrice) : '—'}</td><td class="num">${nf2.format(x.monto)}</td></tr>`).join('')}</tbody>
          <tfoot><tr class="tot"><td colspan="2">TOTAL · ${t.items} renglones</td><td class="num">${t.cajas}</td><td class="num">${t.unidades}</td><td colspan="2" class="num">USD</td><td class="num">${nf2.format(t.monto)}</td></tr>
          ${rate ? `<tr class="tot"><td colspan="6" class="num">Equivalente Bs (tasa ${nf2.format(rate)})</td><td class="num">${nf2.format(t.monto * rate)}</td></tr>` : ''}</tfoot></table>
        ${order.notes ? `<p><b>Observación:</b> ${esc(order.notes)}</p>` : ''}
        <div class="sign" style="grid-template-columns:repeat(3,1fr)"><div>Entregado por</div><div>Recibido conforme (nombre, C.I. y firma)</div><div>Sello</div></div>
      </section>`;
  }

  const NOTE_CSS = `@page{size:letter portrait;margin:10mm}
    .note{position:relative;page-break-inside:avoid;padding-bottom:10px;margin-bottom:12px;border-bottom:1px dashed #999}
    .note:nth-of-type(2n){page-break-after:always;border-bottom:0}
    .copy{position:absolute;right:0;top:-2px;font-size:9px;font-weight:bold;letter-spacing:.1em;color:#730101}
    .meta{grid-template-columns:repeat(4,1fr)}`;

  /** Por cada pedido: ORIGINAL + COPIA (quedan en la misma hoja si caben). */
  function printNotes(orders, ctx) {
    const body = orders.map((o) => noteHTML(o, ctx, 'ORIGINAL · CLIENTE') + noteHTML(o, ctx, 'COPIA · EMPRESA')).join('');
    printHTML('Notas de entrega', NOTE_CSS, body);
  }

  global.Print = { printLoadSheet, printNotes, printLiquidation, printKardex, printQuincena };
})(window);
