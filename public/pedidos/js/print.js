/* =========================================================================
 * print.js — Documentos imprimibles (se generan en un iframe aislado)
 *
 *   Hoja de carga    → horizontal, SIN precios: productos × clientes, totales
 *                      por producto y por cliente, despachador y firmas.
 *   Nota de entrega  → vertical, CON precios, una por cliente, en ORIGINAL
 *                      (cliente) y COPIA (empresa).
 *   Nota de despacho → ticket de 80 mm (impresora térmica POS-80), una por
 *                      cliente, con corte automático entre cada una.
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
        ${r.cells.map((c) => `<td class="num${c.del ? ' has' : ''}">${c.del ? nf0.format(c.del) : ''}${c.ret ? `<span class="ret">${c.nf ? '⊘' : '↩'}${c.ret}</span>` : ''}</td>`).join('')}
        <td class="num tot">${nf0.format(r.entregado)}</td><td class="num">${r.queda ? nf0.format(r.queda) : ''}</td><td class="num">${nf0.format(r.carga)}</td><td class="num">${nf0.format(r.total)}${r.anterior ? `<span class="ret">+${r.anterior}↩ant</span>` : ''}</td>
        <td class="num tot">${nf0.format(r.debe)}</td><td class="num">${r.dev === null ? '' : nf0.format(r.dev)}</td><td class="num tot">${r.dif === null ? '' : nf0.format(r.dif)}</td>
        <td class="mot">${esc(r.motivo)}</td><td class="mot">${r.debe > 0 || r.dev > 0 ? (r.dest === 'siguiente' ? (r.destLoad ? '→ ' + esc(((ctx.loads || []).find((l) => l.id === r.destLoad) && Loads.labelOf((ctx.loads || []).find((l) => l.id === r.destLoad))) || 'otra hoja') : 'Sig. carga') : r.dest === 'almacen' ? 'Almacén' : '¿?') : ''}</td><td class="num usd">${nf2.format(r.usd)}</td></tr>`;
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
        <div><b>Quedan viene de</b>${(() => { const ids = Array.isArray(liq.carryFrom) ? liq.carryFrom : liq.carryFrom ? [liq.carryFrom] : (st.carry ? st.carry.fromIds : []); const ls = (ctx.loads || []).filter((l) => ids.includes(l.id)); return ls.length ? ls.map((l) => esc(Loads.labelOf(l) + (l.number ? ' ' + Loads.loadCode(l) : ''))).join(' + ') : (ids.length ? ids.length + ' hoja(s)' : 'nada (camión vacío)'); })()}</div>
      </div>
      <table class="load liq ${n > 14 ? 'many' : ''}"><thead>
        <tr class="ini"><th style="text-align:right">VENDEDOR →</th>${sh.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr class="ini nota"><th style="text-align:right">NOTA VALERY →</th>${sh.cols.map((c) => `<th>${esc(c.order.valeryNote || '')}${c.entry.result === 'parcial' && c.entry.newValery ? `<br>→${esc(c.entry.newValery)}` : ''}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr class="ini novd"><th style="text-align:right">NOVEDAD →</th>${sh.cols.map((c) => `<th>${esc(Liq.shortResult(c.entry))}</th>`).join('')}${blankR(R).replace(/td/g, 'th')}</tr>
        <tr><th style="text-align:left">PRODUCTO</th>${sh.cols.map((c, i) => `<th class="cl"><div>${i + 1}. ${esc(c.order.clientName)}</div></th>`).join('')}
          ${['ENTREGADO', 'QUEDAN', 'CARGA', 'TOTAL', 'DEBE QUEDAR', 'DEVOLUCIÓN', 'DIFERENCIA', 'MOTIVO', 'LO QUE SOBRA', 'TOTAL $'].map((x) => `<th class="cl rt"><div>${x}</div></th>`).join('')}</tr></thead>
        <tbody>${body}</tbody><tfoot>${foot}</tfoot></table>
      ${novs.length ? `<p class="novs"><b>Novedades:</b> ${novs.map(({ c, i }) => `${i + 1}. ${esc(c.order.clientName)} — ${esc(Liq.shortResult(c.entry).toLowerCase())}${c.entry.result === 'parcial' || c.entry.result === 'anulada' ? ` · nota ${esc(c.order.valeryNote || '—')} anulada` : ''}${c.entry.newValery && c.entry.result === 'parcial' ? ` → nueva ${esc(c.entry.newValery)}` : ''}${c.entry.result === 'nofact' ? ' · misma nota ' + esc(c.order.valeryNote || '—') + ': ' + Object.entries(c.entry.nf || {}).map(([pid, r]) => { const l = (c.order.lines || {})[pid] || {}; return `${[r.cajas ? r.cajas + ' cj' : '', r.unidades ? r.unidades + ' un' : ''].filter(Boolean).join('+')} ${esc(l.name || pid)} (${r.why === 'camion' ? 'en camión' : 'no salió'})`; }).join(', ') : ''}${c.entry.motivo ? ` · ${esc(c.entry.motivo)}` : ''}`).join(' &nbsp;|&nbsp; ')}</p>` : ''}
      ${(() => { const pr = Liq.prevRetRows(liq); return pr.length ? `<p class="novs"><b>Mercancía devuelta de entregas anteriores (entra al TOTAL):</b> ${pr.map((x) => `${esc(x.clientName)} — ${x.qty} ${esc(x.um)} ${esc(x.code || '')} ${esc(x.name || '')}${x.label ? ' · de ' + esc(x.label) : ''}${x.nota ? ' · nota ' + esc(x.nota) : ''} · ${esc(x.motivo || '')}`).join(' &nbsp;|&nbsp; ')}</p>` : ''; })()}
      ${(() => { const pv = Liq.prevRows(st.os, liq); return pv.length ? `<p class="novs"><b>Vacíos de entregas anteriores (trajo el despachador):</b> ${pv.map((p) => `${esc(p.client)} — ${p.qty} ${esc(p.type)}${p.from === 'dev_asignado' ? ' (asignados)' : ''}${p.motivo ? ' · ' + esc(p.motivo) : ''}`).join(' &nbsp;|&nbsp; ')}</p>` : ''; })()}
      ${st.vac.some((v) => v.pending) ? `<p class="novs"><b>Vacíos que quedan debiendo:</b> ${st.vac.filter((v) => v.pending).map((v) => `${esc(v.client)} — ${v.pending} ${esc(v.code)} (${esc(v.motivo || (v.regime === 'prestamo' ? 'PRÉSTAMO' : 'sin motivo'))})`).join(' &nbsp;|&nbsp; ')}</p>` : ''}
      ${(() => { const c = Liq.cuadre(sh, ctx.products ? new Map(ctx.products.map((p) => [p.id, p])) : null), t = Liq.cuadreLines(c, (v) => '$' + nf2.format(v)); return `<div class="cuadre ${c.ok ? '' : 'bad'}"><b>CUADRE EN DÓLARES</b>${t.lines.map((x) => `<div>${esc(x)}</div>`).join('')}<div class="verdict">${esc(t.verdict)}</div>${t.extra.map((x) => `<div>${esc(x)}</div>`).join('')}</div>`; })()}
      <p class="muted foot">↩ = devuelto por el cliente · ⊘ = no facturado (misma nota) · Total = Quedan + Carga (+ ↩ant = devuelto de entregas anteriores) · Debe quedar = Total − Entregado · Diferencia = Debe quedar − Devolución · Vacíos: Despachados − Recibidos − Asignados = Quedan debiendo · Vac. anteriores = devueltos de entregas anteriores · Que entran = Recibidos + Anteriores.</p>
      <div class="sign"><div>Despachador</div><div>Almacén</div><div>Liquidó (oficina)</div><div>Gerencia</div></div>
      </section>`;
  }
  const LIQ_CSS = LOAD_CSS + ` .cuadre{border:2px solid #000;padding:5px 8px;margin:6px 0;font-size:11px;font-family:monospace;page-break-inside:avoid}
    .cuadre b{font-family:sans-serif} .cuadre .verdict{font-weight:900;font-family:sans-serif;margin-top:3px} .cuadre.bad{border-style:dashed}
    td.nob,th.nob{border:0 !important} table.load.liq td.mot{font-size:10px;white-space:nowrap}
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
    const people = (arr) => arr.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.type)}</td>${n(v.despachados)}${n(v.recibidos)}${n(v.asignados)}${n(v.debe)}${n(v.anteriores || 0)}${n(v.recibidos + (v.anteriores || 0))}</tr>`).join('');
    const R = global.Reportes;
    const vt = d.vacios.byCode.reduce((a, v) => ({ d: a.d + v.despachados, r: a.r + v.recibidos, a: a.a + v.asignados, q: a.q + v.debe }), { d: 0, r: 0, a: 0, q: 0 });
    const sumT = (title, who, sm, disp) => tbl(title, [who, ...(disp ? ['Hojas'] : []), 'Clientes', 'Cajas', 'Venta liquidada $', 'Vacíos despachados', 'Vacíos recibidos', 'Vacíos asignados', 'Quedan debiendo', disp ? 'Diferencias' : 'Novedades', 'Venta en proceso $'],
      sm.rows.map((r) => `<tr><td>${esc(r.name)}</td>${disp ? n(r.hojas) : ''}${n(r.clients)}${n(r.cajas)}${m(r.monto)}${n(r.vacDesp)}${n(r.vacRecv)}${n(r.vacAsg)}${n(r.vacDebe)}${n(disp ? r.diferencias : r.novedades)}${m(r.procMonto)}</tr>`).join(''),
      `<tr class="tot"><td>TOTAL</td>${disp ? n(sm.tot.hojas) : ''}${n(sm.tot.clients)}${n(sm.tot.cajas)}${m(sm.tot.monto)}${n(sm.tot.vacDesp)}${n(sm.tot.vacRecv)}${n(sm.tot.vacAsg)}${n(sm.tot.vacDebe)}${n(disp ? sm.tot.diferencias : sm.tot.novedades)}${m(sm.tot.procMonto)}</tr>`);
    const cu = d.cuadre;
    const catT = (title, g) => { const f = (x) => (x.monto || x.cajas || x.unidades ? `<b>${nf0.format(x.cajas)} cj${x.unidades ? ' + ' + nf0.format(x.unidades) + ' un' : ''}</b><br><span class="muted">${nf2.format(x.monto)} $</span>` : ''); return tbl(title, ['Categoría', ...g.people.map((p) => p.name), 'TOTAL categoría'],
      g.rows.map((r) => `<tr><td>${esc(r.category)}</td>${r.cells.map((x) => `<td class="num">${f(x)}</td>`).join('')}<td class="num">${f(r.total)}</td></tr>`).join(''),
      `<tr class="tot"><td>TOTAL</td>${g.cols.map((x) => `<td class="num">${f(x)}</td>`).join('')}<td class="num">${f(g.total)}</td></tr>`); };
    const gridT = (title, g, money) => { const f = (v) => (v ? (money ? nf2.format(v) : nf0.format(v)) : ''); return tbl(title, ['Vendedor \\ Despachador', ...g.disps.map((x) => x.name), 'Total vendedor'],
      g.rows.map((r) => `<tr><td>${esc(r.name)}</td>${r.cells.map((v) => `<td class="num">${f(v)}</td>`).join('')}<td class="num"><b>${f(r.total)}</b></td></tr>`).join(''),
      `<tr class="tot"><td>TOTAL DESPACHADOR</td>${g.cols.map((v) => `<td class="num">${f(v)}</td>`).join('')}<td class="num">${f(g.total)}</td></tr>`); };
    const body = `<section>
      ${header(ctx.config, 'REPORTE · ' + (ctx.title || ''), fdate(d.from + 'T12:00:00') + ' al ' + fdate(d.to + 'T12:00:00'))}
      <p class="muted">Venta liquidada = lo que realmente se vendió (hojas con la liquidación cerrada, sin devoluciones ni notas anuladas), por fecha de entrega. ${d.pendingLoads.length ? `<b>${d.pendingLoads.length} hoja(s) del período sin liquidar (${nf2.format(d.pendingMonto)} $ en proceso) no se suman a la venta liquidada.</b>` : 'Todas las hojas del período están liquidadas.'}</p>
      <div class="meta">
        <div><b>VENTA LIQUIDADA $</b>${nf2.format(t.monto)}</div><div><b>Venta en proceso $</b>${nf2.format(d.enProceso.monto)}</div>
        <div><b>Hojas liquidadas</b>${t.hojas}</div><div><b>Clientes atendidos</b>${t.clients}</div>
        <div><b>Cajas</b>${nf0.format(t.cajas)}</div><div><b>Unidades sueltas</b>${nf0.format(t.unidades)}</div>
        <div><b>Vacíos despachados · recibidos</b>${nf0.format(vt.d)} · ${nf0.format(vt.r)}</div><div><b>Quedan debiendo (vacíos)</b>${nf0.format(vt.q)}</div>
      </div>
      ${sumT('Resumen de la quincena por vendedor', 'Vendedor', R.summaryRows(d, 'seller'), false)}
      ${sumT('Resumen de la quincena por despachador', 'Despachador', R.summaryRows(d, 'dispatcher'), true)}
      ${catT('Venta liquidada por categoría · por vendedor', R.catGrid(d, 'seller', ctx.config.rubros))}
      ${catT('Venta liquidada por categoría · por despachador', R.catGrid(d, 'dispatcher', ctx.config.rubros))}
      ${cu.ok ? `<p class="muted"><b>✓ Cuadra:</b> vendedores ${nf2.format(cu.sellerTotal)} $ = despachadores ${nf2.format(cu.dispatcherTotal)} $.</p>` : `<p><b>⚠ ${cu.diff ? 'NO CUADRA' : 'FALTA ASIGNAR DESPACHADOR'}:</b> vendedores ${nf2.format(cu.sellerTotal)} $ · despachadores ${nf2.format(cu.dispatcherTotal)} $${cu.sinDespachador.clients ? ` · ${cu.sinDespachador.clients} cliente(s) (${nf2.format(cu.sinDespachador.monto)} $) en hojas sin despachador` : ''}.</p>`}
      ${gridT('Cuadre · venta liquidada: qué despachador repartió lo de cada vendedor ($)', R.crossGrid(d, 'monto'), true)}
      ${gridT('Cuadre · vacíos despachados por vendedor y despachador', R.crossGrid(d, 'vacDesp'), false)}
      ${tbl('Venta en proceso (todavía puede cambiar, no suma a la venta liquidada)', ['Etapa', 'Pedidos', 'Monto $'], d.enProceso.stages.map((x) => `<tr><td>${esc(x.label)}</td>${n(x.clients)}${m(x.monto)}</tr>`).join(''), `<tr class="tot"><td>TOTAL EN PROCESO</td>${n(d.enProceso.clients)}${m(d.enProceso.monto)}</tr>`)}
      ${tbl('Ventas por categoría', ['Categoría', 'Cajas', 'Unidades', 'Monto $'], d.byCategory.map((c) => `<tr><td>${esc(c.category)}</td>${n(c.cajas)}${n(c.unidades)}${m(c.monto)}</tr>`).join(''), `<tr class="tot"><td>TOTAL</td>${n(t.cajas)}${n(t.unidades)}${m(t.monto)}</tr>`)}
      ${tbl('Ventas por producto', ['Código', 'Producto', 'Cajas', 'Unidades', 'Monto $'], prod, `<tr class="tot"><td colspan="2">TOTAL</td>${n(t.cajas)}${n(t.unidades)}${m(t.monto)}</tr>`)}
      ${tbl('Diferencias de camión', ['Fecha', 'Hoja', 'Despachador', 'Producto', 'Debe quedar', 'Devolución', 'Diferencia', 'Motivo'], d.diferencias.map((x) => `<tr><td>${esc(fdate(x.date + 'T12:00:00'))}</td><td>${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td>${esc(x.code)} ${esc(x.name)} ${esc(x.um)}</td>${n(x.debe)}${n(x.dev)}${n(x.dif)}<td>${esc(x.motivo)}</td></tr>`).join(''))}
      ${tbl('Novedades de las notas', ['Fecha', 'Cliente', 'Vendedor', 'Resultado', 'Nota', 'Nota nueva', 'Motivo', 'Pedido $', 'Entregado $'], d.novedades.map((x) => `<tr><td>${esc(fdate(x.date + 'T12:00:00'))}</td><td>${esc(x.clientName)}</td><td>${esc(x.sellerName)}</td><td>${esc(RES[x.result] || x.result)}</td><td>${esc(x.valeryNote)}</td><td>${esc(x.newValery)}</td><td>${esc(x.motivo)}</td>${m(x.pedido)}${m(x.entregado)}</tr>`).join(''))}
      ${tbl('Vacíos por código', ['Código', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo', 'Devoluciones posteriores'], vac, `<tr class="tot"><td colspan="2">TOTAL GENERAL</td>${n(vt.d)}${n(vt.r)}${n(vt.a)}${n(vt.q)}<td class="num">${Object.values(d.vacios.devoluciones || {}).reduce((a, x) => a + x, 0) || ''}</td></tr>`)}
      ${tbl('Vacíos por despachador', ['Despachador', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo', 'Devueltos entregas anteriores', 'Total que entran'], people(d.vacios.byDispatcher))}
      ${tbl('Vacíos por vendedor del cliente', ['Vendedor', 'Tipo', 'Despachados', 'Recibidos', 'Asignados', 'Quedan debiendo', 'Devueltos entregas anteriores', 'Total que entran'], people(d.vacios.bySeller))}
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

  /* ------------------- Notas de despacho en ticket (80 / 58 mm) ------------------- */
  // Impresora térmica (POS-80, ESC/POS). Un ticket por cliente: cada uno es una
  // «página», y el controlador corta el papel al final de cada página. Sin fondos
  // grises (la térmica los imprime como puntos): solo negro, letra grande.
  const ticketOpts = (o) => ({ width: o && +o.width === 58 ? 58 : 80, prices: !(o && o.prices === false), copies: o && +o.copies === 2 ? 2 : 1 });
  function ticketHTML(order, ctx, opts, copy) {
    const cfg = ctx.config || {}, co = cfg.company || {}, client = (ctx.clientsById && ctx.clientsById.get(order.clientId)) || {};
    const load = ctx.load || null, rate = +cfg.exchangeRate || 0, t = Matrix.orderTotals(order);
    const lines = Object.values(order.lines || {}).map((l) => ({ l, x: Matrix.lineTotals(l) })).filter(({ x }) => x.cajas || x.unidades)
      .sort((a, b) => String(a.l.category).localeCompare(String(b.l.category), 'es') || String(a.l.code).localeCompare(String(b.l.code), 'es', { numeric: true }));
    const vac = global.Envases && ctx.productsById ? global.Envases.orderVac(order, ctx.productsById) : null;
    const qty = (x) => [x.cajas ? `${x.cajas} CJ` : '', x.unidades ? `${x.unidades} UN` : ''].filter(Boolean).join(' + ');
    const row = (k, v) => (v ? `<div class="kv"><b>${esc(k)}</b> ${esc(v)}</div>` : '');
    return `<section class="t">
      ${copy ? `<div class="cp">${esc(copy)}</div>` : ''}
      <div class="c big">${esc(co.name || 'Distribuidora')}</div>
      <div class="c">${esc([co.rif && 'RIF ' + co.rif, co.phone && 'Tel. ' + co.phone].filter(Boolean).join(' · '))}</div>
      ${co.address ? `<div class="c sm">${esc(co.address)}</div>` : ''}
      <div class="title">NOTA DE DESPACHO</div>
      ${row('Hoja:', load ? [Loads.labelOf(load), load.number ? Loads.loadCode(load) : ''].filter(Boolean).join(' · ') : '')}
      ${row('Nota Valery:', order.valeryNote || '')}
      ${row('Fecha:', fdate((load && load.date ? load.date + 'T12:00:00' : '') || order.dispatchedAt || new Date().toISOString()))}
      <hr>
      <div class="cli">${esc(order.clientName)}</div>
      ${row('RIF/C.I.:', client.rif || order.clientRif || '')}
      ${row('Dir.:', client.address || '')}
      ${row('Tel.:', client.phone || '')}
      ${row('Vendedor:', order.sellerName)}
      ${row('Ruta:', order.route || '')}
      ${row('Despachador:', load ? load.dispatcherName || '' : '')}
      <hr>
      ${lines.map(({ l, x }) => `<div class="ln"><div class="q">${esc(qty(x))}</div><div class="d">${esc(l.code)} ${esc(l.name)} ${esc(l.presentation || '')}</div></div>
        ${opts.prices ? `<div class="pr">${[x.cajas ? `${x.cajas} × ${nf2.format(+l.boxPrice || 0)}` : '', x.unidades ? `${x.unidades} × ${nf2.format(+l.unitPrice || 0)}` : ''].filter(Boolean).join(' + ')} = <b>$ ${nf2.format(x.monto)}</b></div>` : ''}`).join('')}
      <hr>
      <div class="tot">${t.cajas} CJ + ${t.unidades} UN · ${t.bultos} bultos · ${t.items} renglones</div>
      ${opts.prices ? `<div class="tot big">TOTAL $ ${nf2.format(t.monto)}</div>${rate ? `<div class="tot">Bs ${nf2.format(t.monto * rate)} <span class="sm">(tasa ${nf2.format(rate)})</span></div>` : ''}` : ''}
      ${vac && vac.contra && vac.toReceive ? `<div class="kv"><b>♻ Vacíos a recibir:</b> ${nf0.format(vac.toReceive)}</div>` : ''}
      ${order.notes ? `<div class="kv"><b>Obs.:</b> ${esc(order.notes)}</div>` : ''}
      <div class="sig">Recibido conforme</div><div class="sig">C.I.</div>
      <div class="c sm" style="margin-top:6px">${esc(fdate(new Date().toISOString()))} ${esc(ftime(new Date().toISOString()))}</div>
    </section>`;
  }
  const ticketCSS = (w) => `@page{margin:0}
    html,body{margin:0;padding:0;background:#fff} body{width:${w === 58 ? 48 : 72}mm;font:${w === 58 ? 11 : 12.5}px/1.25 Arial,Helvetica,sans-serif;color:#000}
    .t{padding:1mm 1.5mm 2mm;page-break-after:always;break-after:page}
    .c{text-align:center} .big{font-size:1.3em;font-weight:900} .sm{font-size:.85em}
    .title{text-align:center;font-weight:900;font-size:1.25em;border:2px solid #000;margin:4px 0;padding:2px 0;letter-spacing:.04em}
    .cp{text-align:center;font-weight:900;font-size:.85em;letter-spacing:.08em}
    .cli{font-weight:900;font-size:1.2em;margin:2px 0} .kv{margin:1px 0} hr{border:0;border-top:1px dashed #000;margin:4px 0}
    .ln{display:flex;gap:4px;margin-top:3px} .ln .q{font-weight:900;white-space:nowrap;min-width:16mm} .ln .d{flex:1;overflow-wrap:anywhere}
    .pr{text-align:right;font-size:.95em} .tot{text-align:right;font-weight:900;margin:2px 0;background:none}
    .sig{border-top:1px solid #000;margin-top:9mm;padding-top:1px;text-align:center;font-size:.9em}`;
  /** Notas de despacho en ticket: una por cliente (y su copia si se pide). */
  function printTickets(orders, ctx, o) {
    const opts = ticketOpts(o);
    const body = orders.map((x) => opts.copies === 2 ? ticketHTML(x, ctx, opts, 'ORIGINAL · CLIENTE') + ticketHTML(x, ctx, opts, 'COPIA · EMPRESA') : ticketHTML(x, ctx, opts, '')).join('');
    printHTML('Notas de despacho', ticketCSS(opts.width), body);
  }
  /** Ticket de prueba para revisar ancho, margen y corte. */
  function printTestTicket(ctx, o) {
    const opts = ticketOpts(o);
    const demo = { clientName: 'CLIENTE DE PRUEBA', sellerName: 'Vendedor', route: 'RUTA', valeryNote: '0000', notes: 'Si este texto sale completo y centrado, la impresora está lista.',
      lines: { a: { code: '102', name: 'REFRESCO 1,25 L', presentation: '', category: 'PRUEBA', unitsPerBox: 6, boxPrice: 10, unitPrice: 2, cajas: 3, unidades: 2 },
        b: { code: '669', name: 'PRODUCTO CON UN NOMBRE MUY LARGO PARA VER CÓMO SE PARTE', presentation: '350 ML', category: 'PRUEBA', unitsPerBox: 24, boxPrice: 8.5, unitPrice: 0, cajas: 12, unidades: 0 } } };
    printHTML('Ticket de prueba', ticketCSS(opts.width), ticketHTML(demo, { ...ctx, load: null }, opts, `PRUEBA · ${opts.width} mm`));
  }

  /** Cuadre de despachos (camiones) de un período, por despachador. */
  function printTruckLedger(L, ctx) {
    const body = `<section class="sheet">${header(ctx.config, 'CUADRE DE DESPACHOS', ctx.from.split('-').reverse().join('/') + ' al ' + ctx.to.split('-').reverse().join('/'))}
      <p class="muted">Venía + Ajustes de QUEDAN + Cargado + Dev. anteriores − Entregado − Volvió a almacén − Diferencia − Corte = Queda en el camión · Faltante a cobrar = diferencias que faltan + lo que faltó en el corte.</p>
      ${L.map((d) => `<h3>${esc(d.name)} · ${d.ok ? '✓ CUADRA' : '⚠ NO CUADRA'}${d.faltantes.length ? ' · FALTANTE A COBRAR: ' + esc(d.faltantes.map((r) => r.faltante + ' ' + ctx.name(r.key)).join(', ')) : ''}</h3>
        <table class="load wide"><thead><tr><th style="text-align:left">PRODUCTO</th>${ctx.cols.map(([, t]) => `<th>${esc(t.toUpperCase())}</th>`).join('')}<th>FALTANTE A COBRAR</th><th>CUADRE</th></tr></thead>
        <tbody>${d.rows.map((r) => `<tr><td>${esc(ctx.name(r.key))}</td>${ctx.cols.map(([k]) => `<td class="num">${r[k] ? nf0.format(r[k]) : ''}</td>`).join('')}<td class="num tot">${r.faltante || ''}</td><td>${r.descuadre ? '⚠ ' + (r.descuadre > 0 ? 'faltan ' : 'sobran ') + Math.abs(r.descuadre) : '✓'}</td></tr>`).join('')}</tbody></table>`).join('')}
      <div class="sign"><div>Despachador</div><div>Almacén</div><div>Oficina</div><div>Gerencia</div></div></section>`;
    printHTML('Cuadre de despachos ' + ctx.from + ' a ' + ctx.to, LOAD_CSS + ' table.load.wide{width:100%} h3{font-size:12px;margin:10px 0 3px} @page{size:letter landscape;margin:8mm}', body);
  }

  global.Print = { printTruckLedger, printLoadSheet, printNotes, printLiquidation, printKardex, printQuincena, printTickets, printTestTicket };
})(window);
