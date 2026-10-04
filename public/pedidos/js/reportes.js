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
  const RES = { parcial: 'Devolución parcial', pendiente: 'Se entrega después', anulada: 'Anulada', entregada: 'Entregada' };
  const titleOf = (f) => (f.mode === 'q' ? `${f.half === 1 ? '1ª' : '2ª'} quincena de ${MONTHS[f.m - 1]} ${f.y}` : 'Rango libre');

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
      </div>
      <p class="muted">Del <b>${esc(fmtDate(range.from))}</b> al <b>${esc(fmtDate(range.to))}</b>, por fecha de entrega (fecha de la carga). Solo cuenta lo entregado en hojas <b>liquidadas</b>.</p>
      <div id="qzOut">${st.data && st.key === range.from + range.to ? '' : '<p class="muted">Pulsa <b>Consultar</b>.</p>'}</div>`;
    if (st.data && st.key === range.from + range.to) out($('#qzOut'), st.data, f);
    $('#qzF').onchange = (e) => {
      const k = e.target.dataset.q; if (!k) return;
      f[k] = ['y', 'm', 'half'].includes(k) ? +e.target.value : e.target.value;
      if (k === 'mode' && f.mode === 'r') { f.from = range.from; f.to = range.to; }
      render(root, st);
    };
    $('#qzGo').onclick = async () => {
      const r0 = f.mode === 'q' ? quincena(f.y, f.m, f.half) : { from: f.from, to: f.to };
      if (!r0.from || !r0.to || r0.from > r0.to) { toast('Rango de fechas inválido', 'err'); return; }
      const o = $('#qzOut'); o.innerHTML = '<p class="muted">Calculando…</p>';
      const r = await global.Sync.readerCall('quincena', r0);
      if (!r.ok) { o.innerHTML = `<div class="empty card"><strong>No se pudo cargar</strong>${esc(r.error || '')}<br>El reporte se calcula en el servidor: se necesita internet.</div>`; return; }
      st.data = r.data; st.key = r0.from + r0.to;
      out(o, r.data, f);
    };

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
      const vacPeople = (arr, who) => arr.map((v) => `<tr><td>${esc(v.name)}</td><td>${esc(v.type)}</td><td class="n">${v.despachados}</td><td class="n">${v.recibidos}</td><td class="n">${v.asignados}</td><td class="n">${v.debe}</td></tr>`).join('');
      o.innerHTML = `
        ${d.pendingLoads.length ? `<div class="hint warn">⚠ <b>${d.pendingLoads.length} hoja${d.pendingLoads.length > 1 ? 's' : ''} del período sin liquidar</b> (${usd(d.pendingMonto)} despachado): no se suman al reporte.
          <div class="muted" style="margin-top:4px">${d.pendingLoads.map((l) => `${esc(fmtDate(l.date))} · ${esc(l.label || l.code)} · ${esc(l.dispatcherName || 'sin despachador')} · ${usd(l.monto)} (${esc(l.liq)})`).join('<br>')}</div></div>` : '<div class="hint">✓ Todas las hojas del período están liquidadas.</div>'}
        ${d.sinFoto ? `<div class="hint">${d.sinFoto} hoja(s) se liquidaron antes de esta versión: no tienen el detalle de diferencias del camión.</div>` : ''}
        <div class="toolbar no-print"><button class="btn" id="qzPrint">🖨 Imprimir reporte</button><button class="btn" id="qzCsv">⇩ Excel (CSV)</button></div>
        <div class="kpi-row">
          <div class="kpi"><small>Venta entregada</small><b>${usd(t.monto)}</b><small>de ${usd(t.pedido)} pedido</small></div>
          <div class="kpi"><small>Hojas liquidadas</small><b>${t.hojas}</b><small>${d.pendingLoads.length} sin liquidar</small></div>
          <div class="kpi"><small>Clientes atendidos</small><b>${nf0.format(t.clients)}</b></div>
          <div class="kpi"><small>Cajas · Unidades</small><b>${nf0.format(t.cajas)}</b><small>${nf0.format(t.unidades)} unidades sueltas</small></div>
          <div class="kpi"><small>Novedades</small><b>${t.parcial + t.pendiente + t.anulada}</b><small>${t.parcial} dev. parcial · ${t.pendiente} después · ${t.anulada} anuladas</small></div>
        </div>
        ${tbl('Ventas por categoría', [{ t: 'Categoría' }, N('Cajas'), N('Unidades'), N('Monto')], d.byCategory.map((c) => `<tr><td><b>${esc(c.category)}</b></td><td class="n">${nf0.format(c.cajas)}</td><td class="n">${nf0.format(c.unidades)}</td><td class="n">${usd(c.monto)}</td></tr>`).join(''),
          `<tr><td>TOTAL</td><td class="n">${nf0.format(t.cajas)}</td><td class="n">${nf0.format(t.unidades)}</td><td class="n">${usd(t.monto)}</td></tr>`)}
        ${tbl('Ventas por producto', [{ t: 'Código' }, { t: 'Producto' }, { t: 'Categoría' }, N('Cajas'), N('Unidades'), N('Monto')], prodRows,
          `<tr><td colspan="3">TOTAL</td><td class="n">${nf0.format(t.cajas)}</td><td class="n">${nf0.format(t.unidades)}</td><td class="n">${usd(t.monto)}</td></tr>`)}
        ${tbl('Por vendedor', [{ t: 'Vendedor' }, N('Clientes'), N('Cajas'), N('Unidades'), N('Monto'), N('Novedades')], d.bySeller.map((s) => `<tr><td><b>${esc(s.sellerName)}</b></td><td class="n">${s.clients}</td><td class="n">${nf0.format(s.cajas)}</td><td class="n">${nf0.format(s.unidades)}</td><td class="n">${usd(s.monto)}</td><td class="n">${s.novedades || ''}</td></tr>`).join(''))}
        ${tbl('Despachos por despachador', [{ t: 'Despachador' }, N('Hojas'), N('Clientes'), N('Cajas'), N('Unidades'), N('Monto'), N('Diferencias')], d.byDispatcher.map((x) => `<tr><td><b>${esc(x.dispatcherName)}</b></td><td class="n">${x.hojas}</td><td class="n">${x.clients}</td><td class="n">${nf0.format(x.cajas)}</td><td class="n">${nf0.format(x.unidades)}</td><td class="n">${usd(x.monto)}</td><td class="n ${x.diferencias ? 'warn-txt' : ''}">${x.diferencias || ''}</td></tr>`).join(''))}
        ${tbl('Diferencias de camión', [{ t: 'Fecha' }, { t: 'Hoja' }, { t: 'Despachador' }, { t: 'Producto' }, N('Debe quedar'), N('Devolución'), N('Diferencia'), { t: 'Motivo' }],
          d.diferencias.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td><span class="mono muted">${esc(x.code)}</span> ${esc(x.name)} ${esc(x.presentation)} <span class="um ${esc(x.um)}">${esc(x.um)}</span></td><td class="n">${x.debe}</td><td class="n">${x.dev}</td><td class="n"><b>${x.dif}</b></td><td>${esc(x.motivo)}</td></tr>`).join(''))}
        ${d.siguiente.length ? tbl('Pasó a la siguiente carga (mismo despachador)', [{ t: 'Fecha' }, { t: 'Hoja' }, { t: 'Despachador' }, { t: 'Producto' }, N('Cantidad')],
          d.siguiente.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td class="mono">${esc(x.label || x.load)}</td><td>${esc(x.dispatcherName)}</td><td><span class="mono muted">${esc(x.code)}</span> ${esc(x.name)} <span class="um ${esc(x.um)}">${esc(x.um)}</span></td><td class="n">${x.qty}</td></tr>`).join('')) : ''}
        ${tbl('Novedades de las notas', [{ t: 'Fecha' }, { t: 'Cliente' }, { t: 'Vendedor' }, { t: 'Resultado' }, { t: 'Nota' }, { t: 'Nota nueva' }, { t: 'Motivo' }, N('Pedido'), N('Entregado')],
          d.novedades.map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td><b>${esc(x.clientName)}</b></td><td>${esc(x.sellerName)}</td><td>${esc(RES[x.result] || x.result)}</td><td class="mono">${esc(x.valeryNote)}</td><td class="mono">${esc(x.newValery)}</td><td>${esc(x.motivo)}</td><td class="n">${usd(x.pedido)}</td><td class="n">${usd(x.entregado)}</td></tr>`).join(''))}
        ${tbl('Vacíos por código <span class="muted">(de lo liquidado en el período)</span>', [{ t: 'Código' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo'), N('Devoluciones posteriores')], vacRows,
          `<tr><td colspan="2">TOTAL GENERAL</td><td class="n">${vt.d}</td><td class="n">${vt.r}</td><td class="n">${vt.a}</td><td class="n">${vt.q}</td><td class="n">${Object.values(d.vacios.devoluciones || {}).reduce((a, x) => a + x, 0) || ''}</td></tr>`)}
        ${tbl('Vacíos por despachador (los que trajo)', [{ t: 'Despachador' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo')], vacPeople(d.vacios.byDispatcher))}
        ${tbl('Vacíos por vendedor del cliente', [{ t: 'Vendedor' }, { t: 'Tipo' }, N('Despachados'), N('Recibidos'), N('Asignados'), N('Quedan debiendo')], vacPeople(d.vacios.bySeller))}
        <p class="muted">${d.detail.length} clientes entregados en el período. El detalle completo va en el Excel (CSV).</p>`;
      $('#qzPrint').onclick = () => global.Print.printQuincena(d, { config: S.config, title: titleOf(f2), RES });
      $('#qzCsv').onclick = () => {
        const sep = (S.settings && S.settings.csvSep) || ';', dec = (S.settings && S.settings.csvDecimal) || ',';
        const q = (v) => { let x = String(v == null ? '' : v); if (/^[=+\-@]/.test(x)) x = "'" + x; return x.includes(sep) || x.includes('"') ? '"' + x.replace(/"/g, '""') + '"' : x; };
        const m = (n) => { const x = Number(n || 0).toFixed(2); return dec === ',' ? x.replace('.', ',') : x; };
        const L = [];
        const sec = (name, head, rows) => { L.push(q(name)); L.push(head.join(sep)); rows.forEach((r) => L.push(r.map(q).join(sep))); L.push(''); };
        L.push(q(`REPORTE ${titleOf(f2).toUpperCase()} · ${d.from} a ${d.to} · solo hojas liquidadas`)); L.push('');
        sec('VENTAS POR PRODUCTO', ['CODIGO', 'PRODUCTO', 'CATEGORIA', 'CAJAS', 'UNIDADES', 'MONTO_USD'], d.byProduct.map((p) => [p.code, `${p.name} ${p.presentation}`.trim(), p.category, p.cajas, p.unidades, m(p.monto)]));
        sec('VENTAS POR CATEGORIA', ['CATEGORIA', 'CAJAS', 'UNIDADES', 'MONTO_USD'], d.byCategory.map((c) => [c.category, c.cajas, c.unidades, m(c.monto)]));
        sec('POR VENDEDOR', ['VENDEDOR', 'CLIENTES', 'CAJAS', 'UNIDADES', 'MONTO_USD', 'NOVEDADES'], d.bySeller.map((s) => [s.sellerName, s.clients, s.cajas, s.unidades, m(s.monto), s.novedades]));
        sec('POR DESPACHADOR', ['DESPACHADOR', 'HOJAS', 'CLIENTES', 'CAJAS', 'UNIDADES', 'MONTO_USD', 'DIFERENCIAS'], d.byDispatcher.map((x) => [x.dispatcherName, x.hojas, x.clients, x.cajas, x.unidades, m(x.monto), x.diferencias]));
        sec('DIFERENCIAS DE CAMION', ['FECHA', 'HOJA', 'DESPACHADOR', 'CODIGO', 'PRODUCTO', 'UM', 'DEBE_QUEDAR', 'DEVOLUCION', 'DIFERENCIA', 'MOTIVO'], d.diferencias.map((x) => [x.date, x.label || x.load, x.dispatcherName, x.code, x.name, x.um, x.debe, x.dev, x.dif, x.motivo]));
        sec('NOVEDADES', ['FECHA', 'CLIENTE', 'VENDEDOR', 'RESULTADO', 'NOTA', 'NOTA_NUEVA', 'MOTIVO', 'PEDIDO_USD', 'ENTREGADO_USD'], d.novedades.map((x) => [x.date, x.clientName, x.sellerName, RES[x.result] || x.result, x.valeryNote, x.newValery, x.motivo, m(x.pedido), m(x.entregado)]));
        sec('VACIOS POR CODIGO', ['CODIGO', 'TIPO', 'DESPACHADOS', 'RECIBIDOS', 'ASIGNADOS', 'QUEDAN_DEBIENDO'], d.vacios.byCode.map((v) => [v.code, v.type, v.despachados, v.recibidos, v.asignados, v.debe]));
        sec('VACIOS POR DESPACHADOR', ['DESPACHADOR', 'TIPO', 'DESPACHADOS', 'RECIBIDOS', 'ASIGNADOS', 'QUEDAN_DEBIENDO'], d.vacios.byDispatcher.map((v) => [v.name, v.type, v.despachados, v.recibidos, v.asignados, v.debe]));
        sec('VACIOS POR VENDEDOR', ['VENDEDOR', 'TIPO', 'DESPACHADOS', 'RECIBIDOS', 'ASIGNADOS', 'QUEDAN_DEBIENDO'], d.vacios.bySeller.map((v) => [v.name, v.type, v.despachados, v.recibidos, v.asignados, v.debe]));
        sec('DETALLE POR CLIENTE', ['FECHA', 'HOJA', 'CLIENTE', 'VENDEDOR', 'DESPACHADOR', 'NOTA', 'RESULTADO', 'CAJAS', 'UNIDADES', 'MONTO_USD'], d.detail.map((x) => [x.date, x.load, x.clientName, x.sellerName, x.dispatcherName, x.valeryNote, RES[x.result] || x.result, x.cajas, x.unidades, m(x.monto)]));
        global.PV.saveFile(`reporte_${d.from}_a_${d.to}.csv`, '﻿' + L.join('\r\n'), 'text/csv;charset=utf-8');
      };
    }
  }

  global.Reportes = { lastDay, quincena, quincenaOf, prevQuincena, render, titleOf };
})(window);
