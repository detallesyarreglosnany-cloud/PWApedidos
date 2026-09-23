/* =========================================================================
 * supervisor.js — Panel de solo consulta (vendedores, gerencia)
 *
 * Un rol distinto de Oficina: ve pedidos, clientes, historial y reportes de
 * TODOS los vendedores, pero nunca puede crear, editar ni eliminar nada. El
 * servidor lo hace cumplir aparte (clave de supervisor, sin permiso de
 * escritura en /api/pedidos/sync): esta pantalla simplemente no ofrece
 * ningún botón para cambiar datos.
 * ========================================================================= */
(function () {
  'use strict';
  const PV = window.PV;
  const { S, $, esc, nf0, usd, today, fmtDate, brandHeader, creditFooter, toast, openSheet, saveSettings, saveFile, runSync, updateSyncPill } = PV;

  const TABS = [['resumen', '📊 Resumen'], ['reportes', '📈 Reportes'], ['historial', '🕘 Historial']];
  const EVENT_LABEL = {
    apertura: 'Abrió la app', regreso: 'Volvió', entrada: 'Entró a su ruta', salida: 'Salió', cliente_nuevo: 'Cliente nuevo',
    pedido_nuevo: 'Abrió pedido', pedido_enviado: 'Envió pedido', pedido_reabierto: 'Reabrió pedido', pedido_modificado: 'Modificó pedido',
    pedido_eliminado: 'Eliminó pedido', espera: 'Puso en espera', reincorporado: 'Reincorporó', movido: 'Movió de hoja',
    pedido_editado_oficina: 'Ajuste de oficina', carga_estado: 'Estado de hoja', cliente_reasignado: 'Reasignó cliente', respaldo: 'Respaldo',
  };
  const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };

  function renderGate() {
    const app = document.getElementById('app');
    app.innerHTML = `
      <section class="login">
        <img class="login-logo" src="./icons/logo-white.png" alt="Distribuidora de Suministros Puerto Venado">
        <div class="card login-card">
          <h2 style="margin:0 0 8px">👁 Acceso de supervisor</h2>
          <p class="muted" style="margin:0 0 16px">Consulta pedidos, clientes, historial y reportes de todos los vendedores. Desde aquí no se puede crear, editar ni eliminar nada.</p>
          <label class="field"><span>Clave de sincronización</span><input id="gSync" class="input" type="password" autocomplete="off" value="${esc(S.settings.syncKey || '')}"></label>
          <label class="field"><span>Clave de supervisor</span><input id="gSup" class="input" type="password" autocomplete="off"></label>
          <button id="gGo" class="btn btn-primary btn-block" style="margin-top:14px">Entrar</button>
          <a class="btn btn-block" href="#/" style="margin-top:8px">← Volver</a>
        </div>
        ${creditFooter()}
      </section>`;
    $('#gGo').onclick = async () => {
      const syncKey = $('#gSync').value.trim(), supervisorKey = $('#gSup').value.trim();
      if (!supervisorKey) { toast('Escribe la clave de supervisor', 'err'); return; }
      await saveSettings({ syncKey, supervisorKey, adminKey: '' });
      const btn = $('#gGo'); btn.disabled = true; btn.textContent = 'Entrando…';
      const r = await runSync(false);
      if (!r.ok) {
        await saveSettings({ supervisorKey: '' });
        toast(r.error || 'No se pudo entrar. Revisa las claves.', 'err');
        btn.disabled = false; btn.textContent = 'Entrar';
        return;
      }
      await PV.loadAll();
      location.hash = '#/supervisor/resumen';
      PV.render();
    };
  }

  PV.renderSupervisor = function (tab) {
    if (!S.settings.supervisorKey) return renderGate();
    if (!TABS.some(([k]) => k === tab)) tab = 'resumen';
    const app = document.getElementById('app');
    app.innerHTML = `
      ${brandHeader('Supervisor', 'Solo consulta · Puerto Venado',
        `<button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/" id="supOut">Salir</a>`)}
      <nav class="tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/supervisor/${k}">${l}</a>`).join('')}</nav>
      <div class="container" id="supBody"></div>
      ${creditFooter()}`;
    $('#syncPill').onclick = () => runSync(true);
    $('#supOut').onclick = async () => { await saveSettings({ supervisorKey: '' }); };
    updateSyncPill();
    const body = $('#supBody');
    ({ resumen: renderResumen, reportes: renderReportes, historial: renderHistorial })[tab](body);
  };

  /* ============================== RESUMEN (hoy) ============================== */
  async function renderResumen(root) {
    root.innerHTML = '<p class="muted">Cargando…</p>';
    const r = await Sync.report(today(), today());
    if (!r.ok) { root.innerHTML = `<div class="empty card"><strong>No se pudo cargar</strong>${esc(r.error || '')}</div>`; return; }
    const d = r.data;
    root.innerHTML = `
      <p class="muted">Hoy, ${esc(fmtDate(today()))}. Para otros días o rangos, usa <b>📈 Reportes</b>.</p>
      <div class="kpi-row">
        <div class="kpi"><small>Clientes atendidos</small><b>${nf0.format(d.totals.clients)}</b></div>
        <div class="kpi"><small>Bultos</small><b>${nf0.format(d.totals.cajas + d.totals.unidades)}</b></div>
        <div class="kpi"><small>Venta del día</small><b>${usd(d.totals.monto)}</b></div>
      </div>
      <div class="card" style="overflow:auto"><h3 style="padding:12px 12px 0">Por vendedor</h3><table class="inv">
        <thead><tr><th>Vendedor</th><th>Clientes</th><th>Cajas</th><th>Unidades</th><th>Monto</th></tr></thead>
        <tbody>${d.bySeller.length ? d.bySeller.map((s) => `<tr><td data-l="Vendedor"><b>${esc(s.sellerName)}</b></td><td class="n" data-l="Clientes">${s.clients}</td><td class="n" data-l="Cajas">${nf0.format(s.cajas)}</td><td class="n" data-l="Unidades">${nf0.format(s.unidades)}</td><td class="n" data-l="Monto">${usd(s.monto)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin pedidos hoy todavía</td></tr>'}</tbody>
      </table></div>`;
  }

  /* ============================== REPORTES (rango) ============================== */
  async function renderReportes(root) {
    const f = S.ui.supRange || (S.ui.supRange = { from: today(), to: today() });
    root.innerHTML = `
      <div class="toolbar">
        <label class="field"><span>Desde</span><input type="date" class="input" id="rFrom" value="${esc(f.from)}"></label>
        <label class="field"><span>Hasta</span><input type="date" class="input" id="rTo" value="${esc(f.to)}"></label>
        <button class="btn btn-sm" id="rHoy">Hoy</button>
        <button class="btn btn-sm" id="r7">Últimos 7 días</button>
        <button class="btn btn-sm" id="r15">Últimos 15 días</button>
        <button class="btn btn-sm" id="r30">Últimos 30 días</button>
        <button class="btn btn-primary" id="rGo">Consultar</button>
      </div>
      <div id="rOut"><p class="muted">Elige el rango y pulsa <b>Consultar</b>.</p></div>`;
    const setRange = (from, to) => { $('#rFrom').value = from; $('#rTo').value = to; };
    $('#rHoy').onclick = () => setRange(today(), today());
    $('#r7').onclick = () => setRange(daysAgo(6), today());
    $('#r15').onclick = () => setRange(daysAgo(14), today());
    $('#r30').onclick = () => setRange(daysAgo(29), today());
    $('#rGo').onclick = async () => {
      const from = $('#rFrom').value, to = $('#rTo').value;
      if (!from || !to || from > to) { toast('Rango de fechas inválido', 'err'); return; }
      S.ui.supRange = { from, to };
      const out = $('#rOut'); out.innerHTML = '<p class="muted">Consultando…</p>';
      const r = await Sync.report(from, to);
      if (!r.ok) { out.innerHTML = `<div class="empty card"><strong>No se pudo cargar</strong>${esc(r.error || '')}</div>`; return; }
      renderReportOut(out, r.data, from, to);
    };
  }

  function renderReportOut(out, d, from, to) {
    const table = (title, rows, labelKey, labelTitle) => `
      <div class="card" style="overflow:auto;margin-top:12px"><h3 style="padding:12px 12px 0">${esc(title)}</h3><table class="inv">
        <thead><tr><th>${esc(labelTitle)}</th><th>Clientes</th><th>Cajas</th><th>Unidades</th><th>Monto</th></tr></thead>
        <tbody>${rows.length ? rows.map((r) => `<tr><td data-l="${esc(labelTitle)}"><b>${esc(r[labelKey])}</b></td><td class="n" data-l="Clientes">${r.clients ?? '—'}</td><td class="n" data-l="Cajas">${nf0.format(r.cajas)}</td><td class="n" data-l="Unidades">${nf0.format(r.unidades)}</td><td class="n" data-l="Monto">${usd(r.monto)}</td></tr>`).join('') : '<tr><td colspan="5" class="muted">Sin datos</td></tr>'}</tbody>
      </table></div>`;
    out.innerHTML = `
      ${d.truncated ? '<div class="hint warn">⚠ El rango tiene demasiados pedidos: se muestran los primeros. Acorta el período para ver todo.</div>' : ''}
      <div class="kpi-row">
        <div class="kpi"><small>Clientes atendidos</small><b>${nf0.format(d.totals.clients)}</b></div>
        <div class="kpi"><small>Cajas</small><b>${nf0.format(d.totals.cajas)}</b></div>
        <div class="kpi"><small>Unidades</small><b>${nf0.format(d.totals.unidades)}</b></div>
        <div class="kpi"><small>Venta total</small><b>${usd(d.totals.monto)}</b></div>
      </div>
      ${table('Por vendedor', d.bySeller, 'sellerName', 'Vendedor')}
      ${table('Por despachador / ruta', d.byDispatcher, 'dispatcherName', 'Despachador')}
      ${table('Por categoría', d.byCategory, 'category', 'Categoría')}
      <div class="card" style="overflow:auto;margin-top:12px"><div class="row" style="padding:12px 12px 0"><h3 class="grow" style="margin:0">Por día</h3></div><table class="inv">
        <thead><tr><th>Día</th><th>Clientes</th><th>Monto</th></tr></thead>
        <tbody>${d.byDay.map((r) => `<tr><td data-l="Día">${esc(fmtDate(r.day))}</td><td class="n" data-l="Clientes">${r.clients}</td><td class="n" data-l="Monto">${usd(r.monto)}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="row" style="margin-top:12px"><button class="btn" id="rDetail">📋 Ver desglose completo (${d.detail.length} pedidos)</button>
        <button class="btn" id="rCsv">⇩ Descargar CSV</button></div>`;
    $('#rDetail').onclick = () => detailSheet(d.detail, from, to);
    $('#rCsv').onclick = () => {
      const sep = ';';
      const q = (v) => { let x = String(v == null ? '' : v); if (/^[=+\-@]/.test(x)) x = "'" + x; return x.includes(sep) || x.includes('"') ? '"' + x.replace(/"/g, '""') + '"' : x; };
      const rows = [['DIA', 'CLIENTE', 'VENDEDOR', 'RUTA', 'DESPACHADOR', 'ESTADO', 'CAJAS', 'UNIDADES', 'MONTO_USD'].join(sep)]
        .concat(d.detail.map((r) => [r.day, q(r.clientName), q(r.sellerName), q(r.route), q(r.dispatcherName), q(r.status), r.cajas, r.unidades, String(r.monto).replace('.', ',')].join(sep)));
      saveFile(`reporte_${from}_a_${to}.csv`, '﻿' + rows.join('\r\n'), 'text/csv;charset=utf-8');
    };
  }

  function detailSheet(detail, from, to) {
    openSheet(`
      <div class="row"><h2 class="grow">Desglose · ${esc(fmtDate(from))} a ${esc(fmtDate(to))}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="card" style="overflow:auto"><table class="inv">
        <thead><tr><th>Día</th><th>Cliente</th><th>Vendedor</th><th>Ruta</th><th>Despachador</th><th>Estado</th><th>Cajas</th><th>Unid.</th><th>Monto</th></tr></thead>
        <tbody>${detail.map((r) => `<tr><td data-l="Día">${esc(fmtDate(r.day))}</td><td data-l="Cliente"><b>${esc(r.clientName)}</b></td><td data-l="Vendedor">${esc(r.sellerName)}</td><td data-l="Ruta">${esc(r.route || '')}</td><td data-l="Despachador">${esc(r.dispatcherName || '')}</td><td data-l="Estado">${esc(r.status)}</td><td class="n" data-l="Cajas">${nf0.format(r.cajas)}</td><td class="n" data-l="Unid.">${nf0.format(r.unidades)}</td><td class="n" data-l="Monto">${usd(r.monto)}</td></tr>`).join('')}</tbody>
      </table></div>`, { wide: true });
  }

  /* ============================== HISTORIAL (solo lectura) ============================== */
  async function renderHistorial(root) {
    const f = S.ui.supHist || (S.ui.supHist = { day: today(), who: '', type: '' });
    const dayEvents = (await DB.getAll('events')).filter((e) => e.day === f.day).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const list = dayEvents.filter((e) => (!f.who || e.sellerId === f.who) && (!f.type || e.type === f.type));
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    const whoOpts = [['', 'Todos'], ...S.sellers.map((s) => [s.id, s.name]), ['oficina', 'Oficina']];
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    root.innerHTML = `
      <div class="toolbar" id="hFilters">
        <label class="field"><span>Día</span><input type="date" class="input" data-h="day" value="${esc(f.day)}"></label>
        <label class="field"><span>Quién</span><select class="select" data-h="who">${opt(whoOpts, f.who)}</select></label>
        <label class="field"><span>Acción</span><select class="select" data-h="type"><option value="">Todas</option>${opt(Object.entries(EVENT_LABEL), f.type)}</select></label>
      </div>
      ${list.length ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Hora · Quién</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
        ${list.map((e) => `<tr><td class="mono"><b>${hhmm(e.at)}</b> · ${esc(e.sellerName)}</td><td data-l="Acción">${esc(EVENT_LABEL[e.type] || e.type)}</td><td>${esc(e.text)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty card"><strong>Sin actividad</strong>ese día con esos filtros.</div>'}`;
    $('#hFilters').onchange = (e) => { const k = e.target.dataset.h; if (k) { f[k] = e.target.value; renderHistorial(root); } };
  }
})();
