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

  function printHTML(title, css, body) {
    const old = document.getElementById('printFrame');
    if (old) old.remove();
    const f = document.createElement('iframe');
    f.id = 'printFrame';
    f.setAttribute('aria-hidden', 'true');
    f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
    document.body.appendChild(f);
    const d = f.contentDocument;
    d.open();
    d.write(`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${BASE_CSS}${css}</style></head><body>${body}</body></html>`);
    d.close();
    const go = () => { f.contentWindow.focus(); f.contentWindow.print(); };
    const imgs = [...d.images];
    Promise.all(imgs.map((i) => i.complete ? 0 : new Promise((r) => { i.onload = i.onerror = r; }))).then(() => setTimeout(go, 60));
  }

  /* --------------------------- Hoja de carga --------------------------- */
  function loadSheetHTML(load, orders, ctx) {
    const cfg = ctx.config;
    const m = Matrix.build(orders, 'bultos', { keepOrder: true, money: false, rubros: cfg.rubros, productRank: ctx.productRank });
    const u = ctx.usage;
    const extra = cfg.sheetExtraCols || ['VACÍOS', 'DEVOLUCIÓN'];
    const blanks = extra.map(() => '<td class="blank"></td>').join('');
    let lastCat = null;
    const colspan = m.cols.length + 2 + extra.length;
    const rows = m.rows.map((r) => {
      let head = '';
      if (r.category !== lastCat) { lastCat = r.category; head = `<tr class="cat"><td colspan="${colspan}">${esc(r.category || 'SIN RUBRO')}</td></tr>`; }
      return head + `<tr><td class="p"><span class="muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b> <span class="um">${r.um}</span></td>
        ${r.cells.map((v) => `<td class="num${v ? ' has' : ''}">${v ? nf0.format(v) : ''}</td>`).join('')}<td class="num tot">${nf0.format(r.total)}</td>${blanks}</tr>`;
    }).join('');
    const foot = m.footer.map((f) => `<tr class="tot"><td>${esc(f.label)}</td>${f.cells.map((v) => `<td class="num">${nf0.format(v)}</td>`).join('')}<td class="num tot">${nf0.format(f.total)}</td>${blanks}</tr>`).join('');
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
        <div><b>Notas de entrega</b>${load.firstNote ? esc(Loads.noteCode(load.firstNote) + ' a ' + Loads.noteCode(load.lastNote)) : '—'}</div>
      </div>
      <table class="load ${m.cols.length > 14 ? 'many' : ''}"><thead>
        <tr class="ini"><th style="text-align:right">VENDEDOR →</th>${m.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}<th></th>${extra.map(() => '<th></th>').join('')}</tr>
        <tr><th style="text-align:left">PRODUCTO</th>
        ${m.cols.map((c, i) => `<th class="cl"><div>${i + 1}. ${esc(c.client)}</div></th>`).join('')}<th class="cl tcol"><div>TOTAL</div></th>
        ${extra.map((x) => `<th class="cl"><div>${esc(x)}</div></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody><tfoot>${foot}</tfoot></table>
      <p class="muted" style="margin:6px 0 0">CJ = cajas · UN = unidades sueltas. Clientes: ${m.cols.map((c, i) => `${i + 1}. ${esc(c.client)} (${esc(Loads.initials(c.order.sellerName))})`).join(' · ')}</p>
      <div class="sign"><div>Despachador</div><div>Almacén</div><div>Vendedor</div><div>Control / Oficina</div></div>
      </section>`;
  }

  // Hoja de carga: SIN rellenos ni franjas (ahorra tinta), todo en negro, letra 12
  // y totales a 14. La tabla toma solo el ancho que necesita: con pocos clientes
  // las columnas quedan pegadas al producto. Los nombres de clientes se reparten
  // en 2-3 líneas en vez de estirarse hacia arriba.
  const LOAD_CSS = `@page{size:letter landscape;margin:8mm} .sheet{page-break-after:always}
    .sheet,.sheet *{color:#000 !important;background:transparent !important;-webkit-print-color-adjust:economy;print-color-adjust:economy}
    .sheet .head{border-bottom:2px solid #000} .sheet .doc{border-color:#000}
    table.load{width:auto} table.load.many{width:100%}
    table.load th,table.load td{font-size:12px;border:1px solid #000;padding:2px 5px}
    table.load th{font-weight:bold}
    th.cl{vertical-align:bottom;padding:3px 2px;min-width:22px}
    th.cl div{writing-mode:vertical-rl;transform:rotate(180deg);white-space:normal;height:110px;line-height:1.15;text-align:left;display:inline-block;overflow-wrap:anywhere}
    table.load.many th.cl div{white-space:nowrap;overflow:hidden}
    td.p{white-space:normal;max-width:280px}
    .um{font-size:10px;font-weight:bold;border:1px solid #000;border-radius:3px;padding:0 3px;margin-left:3px}
    tr.ini th{font-size:10px}
    .cat td{font-weight:bold;font-size:12px;border-top:2px solid #000}
    td.has{font-weight:bold}
    table.load td.tot,table.load th.tcol{font-size:14px;font-weight:900;border-left:2px solid #000;border-right:2px solid #000}
    table.load tfoot td{font-size:14px;font-weight:900;border-top:2px solid #000}
    td.blank{min-width:34px}`;

  function printLoadSheet(load, orders, ctx) {
    printHTML('Hoja de carga ' + Loads.loadCode(load), LOAD_CSS, loadSheetHTML(load, orders, ctx));
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

  global.Print = { printLoadSheet, printNotes };
})(window);
