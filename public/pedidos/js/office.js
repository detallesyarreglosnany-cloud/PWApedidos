/* =========================================================================
 * office.js — Módulo de oficina (PC / tablet)
 *
 *   Cargas      → hojas de carga automáticas (900 bultos / 32 clientes),
 *                 edición de cantidades, clientes en espera, aprobación,
 *                 impresión de hoja de carga (sin precios) y notas de entrega.
 *   Pedidos     → consolidado del día por vendedor (con montos) y exportación.
 *   Archivo     → cargas aprobadas con fecha, vendedor, ruta, despachador y totales.
 *   Inventario  → edición completa del catálogo, fotos, importación Excel/CSV.
 *   Clientes    → cartera por vendedor, reasignación, importación Excel.
 *   Vendedores  → nombres y rutas.
 *   Ajustes     → empresa, rutas, despachadores, rubros, límites, tasa, sync.
 * ========================================================================= */
(function () {
  'use strict';
  const PV = window.PV;
  const { S, $, esc, nf2, nf0, usd, int, dec, norm, slug, today, fmtDate, fmtStock, hasStock, toast, openSheet,
    copyText, saveFile, pickFile, saveDocs, saveOrder, productById, sellerById, orderById, clientById, rubros } = PV;
  const U = () => S.ui.office;

  const TABS = [['cargas', '🚚 Cargas'], ['pedidos', '🧾 Pedidos'], ['archivo', '🗄 Archivo'], ['envases', '♻ Envases'], ['reportes', '📈 Reportes'], ['inventario', '📦 Inventario'],
    ['clientes', '👥 Clientes'], ['vendedores', '🧑‍💼 Vendedores'], ['historial', '🕘 Historial'], ['ajustes', '⚙ Ajustes']];
  const log = (type, text, extra) => PV.logEvent(type, text, extra);

  const productRank = () => Object.fromEntries(S.products.map((p) => [p.id, +p.sort || 9999]));
  const byIdMap = (arr) => new Map(arr.map((x) => [x.id, x]));

  /* ============================== Shell ============================== */
  /* ------------------------- PIN de oficina ------------------------- */
  const LOCK_MIN = 15; // bloqueo automático por inactividad (minutos)
  async function pinHash(pin) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('pv-oficina:' + pin));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const unlockedAt = () => { try { return +sessionStorage.getItem('pvUnlock') || 0; } catch (e) { return 0; } };
  const touchUnlock = () => { try { sessionStorage.setItem('pvUnlock', String(Date.now())); } catch (e) { /* noop */ } };
  const lockOffice = () => { try { sessionStorage.removeItem('pvUnlock'); } catch (e) { /* noop */ } };
  const isLocked = () => !!S.officePin && Date.now() - unlockedAt() > LOCK_MIN * 60000;
  ['click', 'keydown'].forEach((ev) => document.addEventListener(ev, () => { if (location.hash.startsWith('#/oficina') && !isLocked()) touchUnlock(); }, true));
  setInterval(() => { if (location.hash.startsWith('#/oficina') && isLocked() && !document.getElementById('pinForm')) PV.render(); }, 30000);

  function renderLock() {
    document.getElementById('app').innerHTML = `
      <section class="login"><img class="login-logo" src="./icons/logo-white.png" alt="Puerto Venado">
        <form class="card login-card" id="pinForm" autocomplete="off">
          <h2 style="margin:0 0 10px">🔒 Oficina bloqueada</h2>
          <label class="field"><span>PIN de oficina</span><input id="pinIn" class="input" type="password" inputmode="numeric" maxlength="12" autofocus></label>
          <button class="btn btn-primary btn-block" style="margin-top:12px">Entrar</button>
          <a class="btn btn-block" href="#/" style="margin-top:10px">← Volver</a>
        </form>${PV.creditFooter()}</section>`;
    let fails = 0;
    $('#pinForm').onsubmit = async (e) => {
      e.preventDefault();
      if (fails >= 5) { toast('Demasiados intentos. Espera un minuto.', 'err'); return; }
      if (await pinHash($('#pinIn').value) === S.officePin) { touchUnlock(); PV.render(); }
      else { fails++; if (fails >= 5) setTimeout(() => { fails = 0; }, 60000); toast('PIN incorrecto', 'err'); $('#pinIn').value = ''; }
    };
  }

  PV.renderOffice = function (tab) {
    if (isLocked()) return renderLock();
    touchUnlock();
    if (!TABS.some(([k]) => k === tab)) tab = 'cargas';
    Object.assign(S.ui.office, { date: U().date || today(), mode: U().mode || 'bultos' });
    autoPack();
    applyReturnableTemplate();
    upperClients();
    const app = document.getElementById('app');
    const waiting = S.loads.filter((l) => !l.deleted && !Loads.isClosed(l)).length;
    const toVerify = S.clients.filter((c) => !c.deleted && !Clientes.isVerified(c)).length;
    app.innerHTML = `
      ${PV.brandHeader('Hola, ' + (S.config.adminName || 'administrador'), 'Oficina · Puerto Venado',
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/" id="offOut">Salir</a>`)}
      <nav class="tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/oficina/${k}">${l}${k === 'cargas' && waiting ? ` <span class="count">${waiting}</span>` : ''}${k === 'clientes' && toVerify ? ` <span class="count" title="Clientes por verificar">${toVerify}</span>` : ''}</a>`).join('')}</nav>
      <div class="container" id="officeBody"></div>
      ${PV.creditFooter()}`;
    $('#syncPill').onclick = () => PV.runSync(true);
    $('#offOut').onclick = () => lockOffice();
    $('#bell').onclick = PV.notifSheet;
    PV.updateSyncPill(); PV.updateBell();
    const body = $('#officeBody');
    if (!S.products.length && tab !== 'ajustes') body.insertAdjacentHTML('beforebegin', setupBanner());
    ({ cargas: renderLoads, pedidos: renderOrders, archivo: renderArchive, envases: renderEnvases, reportes: (root) => { upgradeLiquidations(root); Reportes.render(root, U().rep || (U().rep = {})); }, inventario: renderInventory,
      clientes: renderClients, vendedores: renderSellers, historial: renderHistory, ajustes: renderSettings })[tab](body);
    const sb = $('#setupImport');
    if (sb) sb.onclick = importStarter;
  };

  /**
   * Plantilla inicial de envases retornables (Fase 2): marca una sola vez los
   * productos de la lista que nunca se configuraron. Después todo se edita en
   * Inventario → producto → «Envase retornable».
   */
  // Nombres de clientes en MAYÚSCULAS (obligatorio): los que vinieron en minúsculas
  // se corrigen una vez, junto con sus pedidos que aún se pueden editar.
  let upping = false;
  async function upperClients() {
    if (upping || !S.settings.adminKey) return;
    const bad = S.clients.filter((c) => !c.deleted && c.name && c.name !== c.name.toUpperCase());
    if (!bad.length) return;
    upping = true;
    try {
      const fixed = bad.map((c) => ({ ...c, name: c.name.replace(/\s+/g, ' ').trim().toUpperCase() }));
      await saveDocs('clients', fixed);
      const byId = new Map(fixed.map((c) => [c.id, c]));
      const os = S.orders.filter((o) => !o.deleted && byId.has(o.clientId) && Loads.editable(o) && o.clientName !== byId.get(o.clientId).name);
      if (os.length) await saveDocs('orders', os.map((o) => ({ ...o, clientName: byId.get(o.clientId).name, clientKey: norm(byId.get(o.clientId).name) })));
    } finally { upping = false; }
  }
  let retApplying = false;
  async function applyReturnableTemplate() {
    if (retApplying || !S.config || S.config.retTemplate || !S.products.length) return;
    retApplying = true;
    try {
      const r = Envases.applyTemplate(S.products);
      if (r.docs.length) await saveDocs('products', r.docs);
      await saveDocs('config', { ...S.config, retTemplate: today(), retMissing: r.missing });
      await log('retornables', `Plantilla de retornables: ${r.docs.length} productos marcados${r.missing.length ? ' · no están en el catálogo: ' + r.missing.join(', ') : ''}`);
      if (r.docs.length) toast(`♻ ${r.docs.length} productos marcados como retornables`, 'ok');
    } finally { retApplying = false; }
  }

  /** Pedidos del mismo cliente el mismo día (mismo u otro vendedor): alerta, no bloquea. */
  function dupIndex() {
    // Mismo cliente o nombre parecido con ±4 días, en cualquier hoja y estado: dedup.js
    return Dedup.pairs(S.orders.filter((o) => !o.deleted && Matrix.orderTotals(o).items));
  }
  /** Dónde está el otro pedido: hoja (código y estado) o estado del pedido, fecha y vendedor. */
  function dupWhere(x) {
    const l = x.loadId ? S.loads.find((y) => y.id === x.loadId) : null, o = orderById(x.id);
    const hoja = l ? `hoja ${Loads.labelOf(l)}${l.number ? ' (' + Loads.loadCode(l) + ')' : ''} · ${Loads.statusOf(l, S.config).name}` : (o ? Loads.orderLabel(o) + ' · sin hoja' : 'sin hoja');
    return `${hoja} · pedido del ${fmtDate(x.routeDate)} · ${x.sellerName}`;
  }
  const dupBadge = (o, idx) => {
    const d = idx.get(o.id); if (!d) return '';
    const same = d.filter((x) => !x.extra && x.kind === 'same'), sim = d.filter((x) => !x.extra && x.kind === 'similar');
    const tip = d.map((x) => `${x.kind === 'same' ? 'Mismo cliente' : 'Parecido: ' + x.clientName} · ${dupWhere(x)}${x.extra ? ' (adicional)' : ''}`).join('\n');
    const [cls, txt] = same.length ? ['over', '⚠ duplicado'] : sim.length ? ['en_espera', '≈ nombre parecido'] : ['abierto', '➕ adicional'];
    return ` <button type="button" class="status ${cls} dup-btn" data-dup="${esc(o.id)}" title="${esc(tip)}">${txt}</button>`;
  };
  /** Líneas visibles bajo el cliente: con qué pedido coincide y en qué hoja está. */
  const dupLines = (o, idx) => (idx.get(o.id) || []).map((x) => `<div class="dup-line ${x.extra ? 'extra' : x.kind}">${x.extra ? '➕ Adicional confirmado' : x.kind === 'same' ? '⚠ Mismo cliente' : `≈ Nombre parecido: <b>${esc(x.clientName)}</b>`} · ${esc(dupWhere(x))}</div>`).join('');
  /** Revisión detallada: los pedidos que coinciden, con su hoja, nota, monto y productos. */
  function dupSheet(oid) {
    const o = orderById(oid); if (!o) return;
    const hits = dupIndex().get(oid) || [];
    const card = (x, kind) => {
      const l = x.loadId ? S.loads.find((y) => y.id === x.loadId) : null, t = Matrix.orderTotals(x);
      const lines = Object.values(x.lines || {}).map((ln) => `${ln.cajas ? ln.cajas + ' cj' : ''}${ln.cajas && ln.unidades ? ' + ' : ''}${ln.unidades ? ln.unidades + ' un' : ''} ${ln.name}`).join(' · ');
      return `<div class="card card-pad" style="margin-bottom:8px">
        <div class="row"><b class="grow">${esc(x.clientName)}</b>${kind}</div>
        <div class="muted">${esc(x.sellerName)} · pedido del ${esc(fmtDate(x.routeDate))} · ${esc(Loads.orderLabel(x))}${x.valeryNote ? ' · Nota ' + esc(x.valeryNote) : ''}${x.extraOk ? ' · ➕ adicional confirmado' : ''}${x.createdBy === 'oficina' ? ' · 🏢 oficina' : ''}</div>
        <div>${l ? `Hoja <b>${esc(Loads.labelOf(l))}</b>${l.number ? ' ' + esc(Loads.loadCode(l)) : ''} · <span class="status ${Loads.statusOf(l, S.config).locked ? 'en_carga' : 'enviado'}">${esc(Loads.statusOf(l, S.config).name)}</span>` : '<span class="muted">Sin hoja</span>'} · <b>${usd(t.monto)}</b> · ${t.bultos} bultos</div>
        <div class="muted" style="font-size:13px;margin-top:4px">${esc(lines)}</div>
        <div class="row" style="gap:6px;margin-top:8px">${l ? `<button class="btn btn-sm" type="button" data-goload="${esc(l.id)}">Ir a la hoja</button>` : ''}<button class="btn btn-sm" type="button" data-seeo="${esc(x.id)}">Ver / editar pedido</button></div></div>`;
    };
    const sh = openSheet(`
      <div class="row"><h2 class="grow">Revisar posible duplicado</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted" style="margin-top:0">Pedidos del mismo cliente o de nombre parecido en ${Dedup.WINDOW_DAYS} días. Pregunta al vendedor si es el mismo pedido antes de aprobar o despachar.</p>
      ${card(o, '<span class="tag">este pedido</span>')}
      ${hits.map((x) => { const ox = orderById(x.id); return ox ? card(ox, x.extra ? '<span class="status abierto">➕ adicional</span>' : x.kind === 'same' ? '<span class="status over">⚠ mismo cliente</span>' : '<span class="status en_espera">≈ nombre parecido</span>') : ''; }).join('')}
      <div class="actions"><button class="btn btn-primary" data-close>Listo</button></div>`, { wide: true });
    sh.el.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goload]');
      if (g) {
        const l = S.loads.find((y) => y.id === g.dataset.goload); sh.close(); if (!l) return;
        // Al cambiar de pestaña la oficina limpia la hoja abierta: se abre después del cambio
        const closed = Loads.isClosed(l), target = closed ? '#/oficina/archivo' : '#/oficina/cargas';
        const go = () => { U().liqId = null; U().loadId = closed ? null : l.id; U().archiveId = closed ? l.id : null; PV.render(); };
        if (location.hash !== target) { window.addEventListener('hashchange', go, { once: true }); location.hash = target; } else go();
        return;
      }
      const v = e.target.closest('[data-seeo]'); if (v) { sh.close(); orderEditor(orderById(v.dataset.seeo), () => PV.render()); }
    });
  }
  // La etiqueta de duplicado abre la revisión desde cualquier pantalla de la oficina
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dup]'); if (!b || !location.hash.startsWith('#/oficina')) return;
    e.stopPropagation(); dupSheet(b.dataset.dup);
  }, true);

  function setupBanner() {
    return `<div class="container"><div class="hint warn setup">
      ${S.settings.syncKey ? '<b>Bajando los datos del servidor…</b> Si este equipo ya trabajaba con la app, no subas nada: todo baja solo al sincronizar. Usa el botón solo en una instalación nueva.'
        : '<b>Primer paso:</b> carga el <b>paquete de arranque</b> (catálogo con precios, cartera de clientes por vendedor, rutas y despachadores).'}
      <button class="btn btn-primary" id="setupImport">⇩ Cargar paquete de arranque</button></div></div>`;
  }

  async function importStarter() {
    const f = await pickFile('.json,application/json'); if (!f) return;
    try {
      const n = await Sync.importBundle(JSON.parse(await f.text()), true);
      await PV.loadAll(); PV.render();
      toast(n + ' registros cargados. Sincroniza para enviarlos a los teléfonos.', 'ok');
      PV.runSync(false);
    } catch (e) { toast(e.message || 'Archivo inválido', 'err'); }
  }

  /**
   * Arma hojas de carga con los pedidos enviados (solo en la oficina). Primero
   * repara duplicados entre equipos. El candado evita que un segundo repintado
   * de la pantalla arme otra vez los mismos pedidos mientras se guarda el primero.
   */
  let packing = false;
  async function autoPack() {
    // Una hoja en vista reducida (bajada como vendedor en este mismo equipo) no
    // trae sus pedidos: no se arma nada hasta que llegue la versión completa
    if (packing || S.loads.some((l) => l.partial)) return;
    packing = true;
    try {
      const fix = Loads.repair({ orders: S.orders, loads: S.loads, config: S.config });
      if (fix.loads.length) await saveDocs('loads', fix.loads);
      if (fix.orders.length) await saveDocs('orders', fix.orders);
      const r = Loads.autoPack({ orders: S.orders, loads: S.loads, sellers: S.sellers, config: S.config });
      if (r.loads.length) await saveDocs('loads', r.loads);
      if (r.orders.length) await saveDocs('orders', r.orders);
      if (fix.loads.length || fix.orders.length || r.orders.length) PV.refreshAfterRemote();
    } finally { packing = false; }
  }

  /* ============================== CARGAS ============================== */
  function bar(pct, over, label) {
    return `<div class="bar ${over ? 'over' : pct >= 100 ? 'full' : ''}"><i style="width:${Math.min(100, pct)}%"></i><span>${label}</span></div>`;
  }
  const stName = (l) => Loads.statusOf(l, S.config).name;
  const sellerTags = (l) => Loads.sellerIdsOf(l).map((id) => { const s = sellerById(id); return s ? `<span class="tag" title="${esc(s.name)}">${esc(Loads.initials(s.name))}</span>` : ''; }).join('');
  const openLoads = () => S.loads.filter((l) => Loads.isOpen(l, S.config) && !Loads.isClosed(l));

  function renderLoads(root) {
    if (U().liqId) { const l = S.loads.find((x) => x.id === U().liqId); if (l) return renderLiquidation(root, l); U().liqId = null; }
    if (U().loadId) { const l = S.loads.find((x) => x.id === U().loadId); if (l) return renderLoadDetail(root, l); U().loadId = null; }
    const ordersById = byIdMap(S.orders);
    const sid = U().loadSeller || '';
    const mine = (l) => !sid || Loads.sellerIdsOf(l).includes(sid);
    // En curso = todo lo que aún no se cerró (editables y aprobadas para carga)
    const active = S.loads.filter((l) => !Loads.isClosed(l) && mine(l)).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const held = S.orders.filter((o) => o.status === 'en_espera' && (!sid || o.sellerId === sid));
    const open = S.orders.filter((o) => o.status === 'abierto' && o.routeDate === today() && Matrix.orderTotals(o).items && (!sid || o.sellerId === sid));
    const L = Loads.limits(S.config);
    const groups = Loads.statuses(S.config).filter((st) => !st.closing).map((st) => ({ st, list: active.filter((l) => Loads.statusOf(l, S.config).id === st.id) }));
    const card = (l) => {
      const u = Loads.usage(l, ordersById, S.config);
      const st = Loads.statusOf(l, S.config);
      return `<button class="load-card ${u.over ? 'over' : u.full ? 'full' : ''} ${st.locked ? 'locked' : ''}" data-lid="${esc(l.id)}">
        <div class="row"><b class="grow">${esc(Loads.labelOf(l))} ${l.number ? `<span class="muted mono">${esc(Loads.loadCode(l))}</span>` : ''}</b>${sellerTags(l)}</div>
        <div class="muted">${esc(l.sellerName)} · Ruta ${esc(l.route || '—')}</div>
        ${bar(u.pct, u.used > u.limit, `${nf0.format(u.used)} / ${nf0.format(u.limit)} ${u.measure}`)}
        ${bar(u.pctClients, u.clients > u.maxClients, `${u.clients} / ${u.maxClients} clientes`)}
        <div class="row"><span class="status ${st.locked ? 'locked' : 'espera'}">${st.locked ? '🔒 ' : ''}${esc(st.name)}</span>
          ${u.over ? '<span class="status over">EXCEDIDA</span>' : u.full ? '<span class="status full">CARGA COMPLETA</span>' : ''}
          <span class="grow"></span><span class="muted">${esc(l.dispatcherName || 'sin despachador')}</span></div>
      </button>`;
    };
    root.innerHTML = `
      <div class="toolbar">
        <label class="field"><span>Vendedor</span><select id="lSeller" class="select">
          <option value="">Todos</option>${S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <div class="grow kpis big">
          <span><b>${active.length}</b> hojas en curso</span>
          <span><b>${held.length}</b> clientes en espera</span>
          <span><b>${open.length}</b> pedidos abiertos (vendedores en ruta)</span>
        </div>
        <button class="btn btn-primary" id="lOrder">➕ Nuevo pedido</button>
        <button class="btn" id="lNew">＋ Nueva hoja</button>
        <button class="btn" id="lSync">⟳ Actualizar</button>
      </div>
      ${S.sellers.filter(pausedUntil).map((x) => `<div class="hint warn">⏸ <b>${esc(x.name)}</b> en pausa de pedidos hasta ${esc(fmtPause(pausedUntil(x)))} · ${pendingOf(x.id).clients} clientes / ${nf0.format(pendingOf(x.id).cajas)} cajas por despachar <button type="button" class="btn btn-sm btn-ok" data-resume="${esc(x.id)}">▶ Reactivar</button></div>`).join('')}
      ${sid && !pausedUntil(sellerById(sid)) ? `<div class="row" style="justify-content:flex-end"><button type="button" class="btn btn-sm" data-pause="${esc(sid)}">⏸ Suspender pedidos de ${esc((sellerById(sid) || {}).name || '')}</button></div>` : ''}
      <p class="muted">Tope por hoja: <b>${nf0.format(L.limit)} ${L.measure}</b> o <b>${L.maxClients} clientes</b>. Los pedidos se pueden editar (vendedor y oficina) mientras la hoja esté en un estado sin 🔒.</p>
      ${groups.map(({ st, list }) => `
        <div class="section-title">${st.locked ? '🔒 ' : ''}${esc(st.name)} · ${list.length}</div>
        ${list.length ? `<div class="load-grid">${list.map(card).join('')}</div>` : '<p class="muted">Ninguna.</p>'}`).join('')}
      <div class="section-title">⏸ Clientes en espera (no se pierde el pedido)</div>
      ${held.length ? `<div class="card"><table class="inv">${((dupIdx0) => held.map((o) => {
        const t = Matrix.orderTotals(o);
        return `<tr><td><b>${esc(o.clientName)}</b>${dupBadge(o, dupIdx0)}<div class="muted">${esc(o.sellerName)} · ${esc(o.route || '')} · ${esc(fmtDate(o.routeDate))}</div>${dupLines(o, dupIdx0)}</td>
          <td class="n">${t.bultos} bultos</td><td class="n">${usd(t.monto)}</td>
          <td style="white-space:nowrap"><button class="btn btn-sm" data-edit="${esc(o.id)}">Editar</button>
            <button class="btn btn-sm" data-move="${esc(o.id)}">⇄ A una hoja</button>
            <button class="btn btn-sm btn-primary" data-release="${esc(o.id)}">↩ Reincorporar</button></td></tr>`;
      }).join(''))(dupIndex())}</table></div>` : '<p class="muted">Ninguno.</p>'}`;

    $('#lSeller').onchange = (e) => { U().loadSeller = e.target.value; renderLoads(root); };
    $('#lSync').onclick = () => PV.runSync(true);
    $('#lNew').onclick = () => newLoadDialog(root);
    $('#lOrder').onclick = () => officeOrderDialog(() => renderLoads(root));
    root.onclick = async (e) => {
      const pz = e.target.closest('[data-pause]'); if (pz) { pauseDialog(sellerById(pz.dataset.pause), () => renderLoads(root)); return; }
      const rs = e.target.closest('[data-resume]');
      if (rs) { const x = sellerById(rs.dataset.resume); await saveDocs('sellers', { ...x, suspendedUntil: '', suspendNote: '' }); await log('vendedor_pausa', `Reactivó la subida de pedidos de ${x.name}`, { sellerId: x.id }); toast(`${x.name} puede volver a subir pedidos`, 'ok'); PV.runSync(false); renderLoads(root); return; }
      const c = e.target.closest('[data-lid]');
      if (c) { U().loadId = c.dataset.lid; renderLoads(root); return; }
      const ed = e.target.closest('[data-edit]');
      if (ed) { orderEditor(orderById(ed.dataset.edit), () => renderLoads(root)); return; }
      const mv = e.target.closest('[data-move]');
      if (mv) { moveDialog(orderById(mv.dataset.move), null, () => renderLoads(root)); return; }
      const rl = e.target.closest('[data-release]');
      if (rl) {
        const ro = orderById(rl.dataset.release);
        await saveOrder(Loads.release(ro));
        await log('reincorporado', `Reincorporó a ${ro.clientName} (${ro.sellerName}) a la cola de carga`, { orderId: ro.id, clientName: ro.clientName });
        autoPack(); renderLoads(root); toast('Cliente reincorporado a la cola de carga', 'ok');
      }
    };
  }

  function newLoadDialog(root) {
    const sh = openSheet(`<div class="row"><h2 class="grow">Nueva hoja de carga</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Crea una hoja vacía y luego mueve clientes a ella (⇄ Mover) o fusiona otra hoja.</p>
      <div class="grid2"><label class="field"><span>Vendedor</span><select id="nlS" class="select">${S.sellers.filter((s) => s.active).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
      <label class="field"><span>Ruta</span><select id="nlR" class="select">${(S.config.routes || []).map((r) => `<option>${esc(r)}</option>`).join('')}</select></label></div>
      <div class="actions"><button class="btn btn-primary" id="nlOk">Crear hoja</button></div>`);
    $('#nlOk', sh.el).onclick = async () => {
      const s = sellerById($('#nlS', sh.el).value);
      const r = Loads.moveOrder({ id: '__tmp', sellerId: s.id, sellerName: s.name, route: $('#nlR', sh.el).value }, null, null, { sellers: S.sellers, config: S.config });
      const l = { ...r.loads[0], orderIds: [], route: $('#nlR', sh.el).value };
      await saveDocs('loads', l);
      sh.close(); U().loadId = l.id; renderLoads(root); toast('Hoja creada', 'ok');
    };
  }

  /** Mover un cliente a otra hoja abierta (o a una nueva). */
  function moveDialog(order, fromLoad, onDone) {
    if ((order.delivery && order.delivery.at) || (fromLoad && fromLoad.liq)) { toast('Este pedido está en una hoja con liquidación: no se mueve. Ajusta la liquidación de esa hoja.', 'err'); return; }
    const targets = openLoads().filter((l) => !fromLoad || l.id !== fromLoad.id);
    const ordersById = byIdMap(S.orders);
    const sh = openSheet(`<div class="row"><h2 class="grow">Mover a ${esc(order.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="results">${targets.map((l) => { const u = Loads.usage(l, ordersById, S.config);
        return `<button class="result" data-to="${esc(l.id)}"><b>${esc(Loads.labelOf(l))}</b> · ${esc(l.sellerName)} · ${esc(l.route || '')} <span class="muted">(${nf0.format(u.used)}/${nf0.format(u.limit)} · ${u.clients} clientes)</span></button>`; }).join('')}
        <button class="result" data-to="__new"><b>＋ Hoja nueva</b> <span class="muted">(${esc(order.sellerName)} · ${esc(order.route || (fromLoad && fromLoad.route) || '')})</span></button></div>`);
    sh.el.onclick = async (e) => {
      const b = e.target.closest('[data-to]'); if (!b) return;
      const target = b.dataset.to === '__new' ? null : S.loads.find((l) => l.id === b.dataset.to);
      const r = Loads.moveOrder(order, fromLoad, target, { sellers: S.sellers, config: S.config });
      // La hoja de origen se elimina solo si ya no le queda ningún pedido (según cada pedido)
      const left = fromLoad ? Loads.loadOrders(fromLoad, byIdMap(S.orders)).filter((o) => o.id !== order.id).length : 1;
      await saveDocs('loads', r.loads.map((l) => (left || !fromLoad || l.id !== fromLoad.id ? l : { ...l, deleted: true })));
      await saveOrder(r.order);
      const to = r.loads[r.loads.length - 1];
      await log('movido', `Movió a ${order.clientName} (${order.sellerName}) a la hoja ${Loads.labelOf(to)}`, { orderId: order.id, clientName: order.clientName });
      sh.close(); toast(order.clientName + ' movido', 'ok'); onDone && onDone();
    };
  }

  function mergeDialog(load, onDone) {
    const ordersById = byIdMap(S.orders);
    const others = openLoads().filter((l) => l.id !== load.id);
    const sh = openSheet(`<div class="row"><h2 class="grow">Fusionar con otra hoja</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Los clientes de la hoja elegida pasan a esta (ej. Luis R. + Fanny A. en BARRIOS). Sobre cada cliente se verá la inicial de su vendedor.</p>
      ${others.length ? `<div class="results">${others.map((l) => { const u = Loads.usage(l, ordersById, S.config);
        return `<button class="result" data-src="${esc(l.id)}"><b>${esc(Loads.labelOf(l))}</b> · ${esc(l.sellerName)} · ${esc(l.route || '')} <span class="muted">(${nf0.format(u.used)} ${u.measure}, ${u.clients} clientes)</span></button>`; }).join('')}</div>`
      : '<p>No hay otras hojas abiertas.</p>'}`);
    sh.el.onclick = async (e) => {
      const b = e.target.closest('[data-src]'); if (!b) return;
      const src = S.loads.find((l) => l.id === b.dataset.src);
      const u1 = Loads.usage(load, ordersById, S.config), u2 = Loads.usage(src, ordersById, S.config);
      if (u1.used + u2.used > u1.limit || u1.clients + u2.clients > u1.maxClients) {
        if (!confirm(`La hoja fusionada quedaría con ${nf0.format(u1.used + u2.used)} ${u1.measure} y ${u1.clients + u2.clients} clientes (tope ${u1.limit} / ${u1.maxClients}). ¿Fusionar igual?`)) return;
      }
      const r = Loads.merge(load, src, { orders: S.orders, sellers: S.sellers, config: S.config });
      await saveDocs('loads', [r.target, r.source]);
      await saveDocs('orders', r.orders);
      sh.close(); toast('Hojas fusionadas', 'ok'); onDone && onDone();
    };
  }

  function renderLoadDetail(root, load) {
    const ordersById = byIdMap(S.orders);
    const os = Loads.loadOrders(load, ordersById);
    const u = Loads.usage(load, ordersById, S.config);
    const st = Loads.statusOf(load, S.config);
    const closed = Loads.isClosed(load);
    const editableLoad = !st.locked && !closed;
    const edit = editableLoad && U().editQty;
    const m = Matrix.build(os, 'bultos', { keepOrder: true, money: false, rubros: rubros(), productRank: productRank() });
    const short = closed ? [] : Loads.shortages(os, S.products);
    const shortIds = new Set(short.map((x) => x.product.id));
    const routes = [...new Set((S.config.routes || []).concat(load.route ? [load.route] : []))];
    let lastCat = null;
    const colspan = m.cols.length + 2;
    const body = m.rows.map((r) => {
      let head = '';
      if (r.category !== lastCat) { lastCat = r.category; head = `<tr class="cat-row"><td class="sticky-col">${esc(r.category)}</td><td colspan="${colspan - 2}"></td><td class="tot"></td></tr>`; }
      const kind = r.um === 'CJ' ? 'cajas' : 'unidades';
      return head + `<tr class="${shortIds.has(r.productId) ? 'short' : ''}">
        <td class="sticky-col" title="${esc(r.code + ' · ' + r.name + ' ' + r.presentation)}"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b> <span class="um ${r.um}">${r.um}</span></td>
        ${r.cells.map((v, i) => edit
          ? `<td class="n"><input class="cell-in" inputmode="numeric" value="${v || ''}" data-oid="${esc(m.cols[i].id)}" data-pid="${esc(r.productId)}" data-kind="${kind}" aria-label="${esc(m.cols[i].client)} ${esc(r.name)}"></td>`
          : `<td class="n ${v ? '' : 'zero'}">${v ? nf0.format(v) : '·'}</td>`).join('')}
        <td class="n tot">${nf0.format(r.total)}</td></tr>`;
    }).join('');
    const pById = byIdMap(S.products);
    const vacRows = m.rows.some((r) => r.um === 'CJ' && Envases.isReturnable(pById.get(r.productId))) ? Envases.sheetRows(m.cols.map((c) => c.order), pById) : [];
    const vacFoot = vacRows.map((v) => `<tr class="vac-row"><td class="sticky-col">♻ ${esc(v.label)}</td>${v.cells.map((x, i) => {
      const ord = m.cols[i].order;
      if (v.assign && x !== undefined && editableLoad && Loads.editable(ord)) {
        // Una casilla por producto del grupo que lleva el cliente (102 y COLIC van en la misma fila)
        const items = v.group.items.filter((it) => (ord.lines || {})[it.pid] && (+ord.lines[it.pid].cajas || 0) > 0);
        return `<td class="n">${items.map((it) => { const a = Envases.assignedOf(ord, it.pid); return `${items.length > 1 ? `<small class="asg-code">${esc(it.code)}</small>` : ''}<input class="cell-in asg-in" inputmode="numeric" value="${a === null ? '' : a}" placeholder="—" data-oid="${esc(m.cols[i].id)}" data-pid="${esc(it.pid)}" title="En blanco = sin decidir · 0 = no se asigna" aria-label="Asignados ${esc(it.code)} ${esc(m.cols[i].client)}">`; }).join('')}</td>`;
      }
      return `<td class="n ${x ? '' : 'zero'}">${x === undefined ? '' : x === null ? '·' : nf0.format(x)}</td>`;
    }).join('')}<td class="n tot">${nf0.format(v.total)}</td></tr>`).join('');
    // Solo «Total bultos» queda fija abajo (lo que lleva cada cliente); el resto del pie se ve al final
    const stickKey = m.footer.some((f) => f.key === 'TOTAL_BULTOS') ? 'TOTAL_BULTOS' : (m.footer[0] || {}).key;
    const foot = m.footer.map((f) => `<tr class="${f.key === stickKey ? 'stick' : ''}"><td class="sticky-col">${esc(f.label)}</td>${f.cells.map((v) => `<td class="n">${nf0.format(v)}</td>`).join('')}<td class="n tot">${nf0.format(f.total)}</td></tr>`).join('') + vacFoot;
    const totalUSD = os.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0);
    const dups = dupIndex();
    const initialsRow = `<tr class="ini-row"><th class="sticky-col">Vendedor →</th>${m.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}<th class="tot"></th></tr>`;

    root.innerHTML = `
      <div class="toolbar no-print">
        <button class="btn" id="dBack">← ${closed ? 'Archivo' : 'Hojas de carga'}</button>
        <div class="grow"><h2 style="margin:0">${esc(Loads.labelOf(load))} ${load.number ? `<span class="muted mono">${esc(Loads.loadCode(load))}</span>` : ''} ${sellerTags(load)}</h2>
          <div class="muted">${esc(load.sellerName)} · pedidos del ${esc(Loads.orderDateRange(os) || '—')}${load.closedAt ? ' · cerrada ' + esc(new Date(load.closedAt).toLocaleString('es-VE')) : ''}</div></div>
        <label class="field"><span>Estado de la carga</span><select id="dStatus" class="select status-sel ${st.locked ? 'locked' : ''}">
          ${Loads.statuses(S.config).map((x) => `<option value="${esc(x.id)}" ${x.id === st.id ? 'selected' : ''}>${x.locked ? '🔒 ' : ''}${esc(x.name)}</option>`).join('')}</select></label>
      </div>
      <div class="toolbar">
        <label class="field"><span>Código</span><input id="dLabel" class="input mono" maxlength="24" value="${esc(load.label || '')}" placeholder="${esc(Loads.autoLabel(load))}"></label>
        <label class="field"><span>Fecha de la carga</span><input id="dDate" type="date" class="input" value="${esc(load.date || '')}" title="Si la dejas vacía, se toma la fecha del cierre"></label>
        <label class="field"><span>Ruta</span><select id="dRoute" class="select">${routes.map((r) => `<option ${r === load.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
        <label class="field"><span>Despachador</span><select id="dDisp" class="select">
          <option value="">— Seleccionar —</option>
          ${(S.config.dispatchers || []).map((d) => `<option value="${esc(d.id)}" ${d.id === load.dispatcherId ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}</select></label>
        <div class="grow" style="min-width:240px">
          ${bar(u.pct, u.used > u.limit, `${nf0.format(u.used)} / ${nf0.format(u.limit)} ${u.measure}`)}
          ${bar(u.pctClients, u.clients > u.maxClients, `${u.clients} / ${u.maxClients} clientes`)}
        </div>
      </div>
      ${st.locked && !closed ? `<div class="hint">🔒 <b>${esc(st.name)}</b>: los pedidos ya no se pueden editar. Para modificarlos, vuelve la hoja a un estado sin 🔒.</div>` : ''}
      ${short.length ? `<div class="hint warn">⚠ Inventario insuficiente: ${short.map((x) => `<b>${esc(x.product.name)}</b> (pedido ${fmtStock(x.need, x.product.unitsPerBox, x.product.sellBy)}, hay ${fmtStock(x.stock, x.product.unitsPerBox, x.product.sellBy)})`).join(' · ')}. Ajusta con ✎.</div>` : ''}
      <div class="toolbar no-print">
        ${editableLoad ? `<button class="btn ${edit ? 'btn-accent' : ''}" id="dEdit">${edit ? '✓ Terminar edición' : '✎ Editar cantidades'}</button>
          <button class="btn" id="dMerge">⇄ Fusionar con otra hoja</button>` : ''}
        ${closed ? `<button class="btn btn-primary" id="dLiq">🧾 ${Liq.isDone(load) ? 'Ver liquidación' : 'Liquidar'}</button>` : ''}
        <button class="btn" id="dPrint" title="En la ventana de impresión elige tu impresora o «Guardar como PDF»">🖨 Imprimir / PDF hoja</button>
        <button class="btn" id="dTicket" ${os.length ? '' : 'disabled'} title="Un ticket por cliente en la impresora térmica (POS-80)">🧾 Notas de despacho (ticket)</button>
        <button class="btn" id="dCsv">⇩ Descargar Excel</button>
        <button class="btn" id="dCopy">📋 Copiar para Excel</button>
        ${editableLoad && !os.length ? '<button class="btn btn-danger" id="dDel">Eliminar hoja vacía</button>' : ''}
      </div>
      ${os.length ? `<div class="table-wrap"><table class="grid sheet-grid">
        <thead>${initialsRow}<tr><th class="sticky-col">Producto</th>
          ${m.cols.map((c, i) => `<th class="client" title="${esc(c.client)}"><div>${i + 1}. ${esc(c.client)}</div></th>`).join('')}<th class="tot">TOTAL</th></tr></thead>
        <tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>` : '<div class="empty card"><strong>Hoja vacía</strong>Mueve clientes aquí con ⇄ desde otra hoja o desde "Clientes en espera".</div>'}
      <div class="section-title">Clientes de la hoja (el orden es el de las columnas) · total ${usd(totalUSD)}</div>
      <div class="card"><table class="inv">
        <thead><tr><th>#</th><th>Orden</th><th>Cliente</th><th>Vend.</th><th>Bultos</th><th>Unid.</th><th>Monto</th><th>Nota Valery</th><th></th></tr></thead>
        <tbody>${os.map((o, i) => { const t = Matrix.orderTotals(o); return `<tr>
          <td>${i + 1}</td>
          <td style="white-space:nowrap">${editableLoad ? `<button class="btn btn-sm" data-left="${i}" ${i ? '' : 'disabled'} aria-label="Mover a la izquierda">←</button><button class="btn btn-sm" data-right="${i}" ${i < os.length - 1 ? '' : 'disabled'} aria-label="Mover a la derecha">→</button>` : ''}</td>
          <td><b>${esc(o.clientName)}</b> <span class="muted">${esc(fmtDate(o.routeDate))}</span>${dupBadge(o, dups)}${dupLines(o, dups)}
            ${o.officeEdited ? ' <span class="status abierto">editado oficina</span>' : ''}${o.sellerEdited ? ' <span class="status en_espera">modificado por vendedor</span>' : ''}
            ${o.notes ? `<div class="muted">📝 ${esc(o.notes)}</div>` : ''}${(o.officeMsgs || []).length ? `<div class="muted">💬 ${o.officeMsgs.length} mensaje${o.officeMsgs.length > 1 ? 's' : ''} de oficina</div>` : ''}</td>
          <td><span class="tag">${esc(Loads.initials(o.sellerName))}</span></td>
          <td class="n" data-l="Bultos">${t.bultos}</td><td class="n" data-l="Unid.">${t.totalUnidades}</td><td class="n" data-l="Monto">${usd(t.monto)}</td>
          <td data-l="Nota Valery"><input class="input sm mono valery-in" inputmode="numeric" maxlength="20" data-oid="${esc(o.id)}" value="${esc(o.valeryNote || '')}" placeholder="N°" aria-label="Nota Valery de ${esc(o.clientName)}"></td>
          <td style="white-space:nowrap"><button class="btn btn-sm" data-ticket="${esc(o.id)}" title="Nota de despacho (ticket)" aria-label="Ticket de ${esc(o.clientName)}">🧾</button> <button class="btn btn-sm" data-edit="${esc(o.id)}">${editableLoad ? 'Editar' : 'Ver'}</button>
            ${editableLoad ? `<button class="btn btn-sm" data-move="${esc(o.id)}">⇄ Mover</button>
            <button class="btn btn-sm" data-hold="${esc(o.id)}" title="Dejar para otra carga">⏸ Espera</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;

    const cur = () => S.loads.find((x) => x.id === load.id) || load;
    const refresh = () => renderLoadDetail(root, cur());
    const saveLoad = async (patch) => { await saveDocs('loads', { ...cur(), ...patch }); refresh(); };
    $('#dBack').onclick = () => {
      U().loadId = null; U().archiveId = null; U().editQty = false;
      if (closed && !location.hash.includes('archivo')) location.hash = '#/oficina/archivo'; else PV.render();
    };
    const ctx = () => ({ config: S.config, products: S.products, usage: Loads.usage(cur(), byIdMap(S.orders), S.config), draft: !cur().number, clientsById: byIdMap(S.clients),
      load: cur(), productRank: productRank(), statusName: stName(cur()) });
    $('#dPrint').onclick = () => Print.printLoadSheet(cur(), Loads.loadOrders(cur(), byIdMap(S.orders)), ctx());
    const tctx = () => ({ config: S.config, clientsById: byIdMap(S.clients), productsById: byIdMap(S.products), load: cur() });
    $('#dTicket').onclick = () => Print.printTickets(Loads.loadOrders(cur(), byIdMap(S.orders)), tctx(), S.settings.ticket);
    const dl = $('#dLiq'); if (dl) dl.onclick = () => { U().liqId = load.id; renderLiquidation(root, cur()); };
    $('#dCsv').onclick = async () => {
      const L = cur(), os2 = Loads.loadOrders(L, byIdMap(S.orders)), pById = byIdMap(S.products);
      const vacRows = Envases.sheetRows(m.cols.map((c) => c.order), pById);
      const extra = vacRows.some((v) => v.total) ? vacRows.map((v) => ({ label: v.label, cells: v.cells, total: v.total })) : [];
      const sheet = Exporta.matrix(m, { sheet: 'Hoja de carga', title: `HOJA DE CARGA · ${Loads.labelOf(L)}${L.number ? ' · ' + Loads.loadCode(L) : ''}`,
        info: [`Fecha de la carga: ${L.date || today()}`, `Pedidos del: ${Loads.orderDateRange(os2) || '—'}`, `Ruta: ${L.route || '—'}`, `Despachador: ${L.dispatcherName || '—'}`, `Vendedor(es): ${L.sellerName || '—'}`], extra });
      await Exporta.save(`hoja_${Loads.labelOf(L)}_${L.date || today()}.xlsx`, [sheet]);
    };
    $('#dCopy').onclick = async () => {
      const ok = await copyText(Matrix.toDelimited(m, { sep: '\t', decimal: S.settings.csvDecimal }));
      toast(ok ? 'Hoja copiada: pégala en Excel' : 'No se pudo copiar', ok ? 'ok' : 'err');
    };
    $('#dStatus').onchange = (e) => changeStatus(cur(), e.target.value, root);
    $('#dLabel').onchange = (e) => saveLoad({ label: e.target.value.trim().toUpperCase() });
    $('#dDate').onchange = (e) => saveLoad({ date: e.target.value });
    $('#dRoute').onchange = (e) => saveLoad({ route: e.target.value });
    $('#dDisp').onchange = (e) => {
      const d = (S.config.dispatchers || []).find((x) => x.id === e.target.value);
      saveLoad({ dispatcherId: d ? d.id : '', dispatcherName: d ? d.name : '' });
    };
    const de = $('#dEdit'); if (de) de.onclick = () => { U().editQty = !U().editQty; refresh(); };
    const dm = $('#dMerge'); if (dm) dm.onclick = () => mergeDialog(cur(), refresh);
    const dd = $('#dDel'); if (dd) dd.onclick = async () => { await saveDocs('loads', { ...cur(), deleted: true }); U().loadId = null; PV.render(); };
    root.onclick = async (e) => {
      const tk = e.target.closest('[data-ticket]'); if (tk) { Print.printTickets([orderById(tk.dataset.ticket)].filter(Boolean), tctx(), S.settings.ticket); return; }
      const ed = e.target.closest('[data-edit]'); if (ed) { orderEditor(orderById(ed.dataset.edit), refresh); return; }
      const mv = e.target.closest('[data-move]'); if (mv) { moveDialog(orderById(mv.dataset.move), cur(), () => { if (!S.loads.find((x) => x.id === load.id)) { U().loadId = null; PV.render(); } else refresh(); }); return; }
      const lr = e.target.closest('[data-left],[data-right]');
      if (lr) {
        const ids = Loads.loadOrders(cur(), byIdMap(S.orders)).map((o) => o.id);
        const i = +(lr.dataset.left || lr.dataset.right), j = lr.dataset.left ? i - 1 : i + 1;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await saveLoad({ orderIds: ids }); return;
      }
      const h = e.target.closest('[data-hold]');
      if (h) {
        const o = orderById(h.dataset.hold);
        if (!confirm(`¿Dejar a ${o.clientName} para otra carga? Su pedido queda en "Clientes en espera".`)) return;
        const r = Loads.hold(cur(), o);
        await saveOrder(r.order);
        await saveDocs('loads', r.load);
        await log('espera', `Puso en espera a ${o.clientName} (${o.sellerName}), sacándolo de la hoja ${Loads.labelOf(r.load)}`, { orderId: o.id, clientName: o.clientName });
        refresh(); toast(o.clientName + ' pasó a espera', 'ok');
      }
    };
    root.onchange = async (e) => {
      const vi = e.target.closest('.valery-in');
      if (vi) {
        const o = orderById(vi.dataset.oid), v = vi.value.replace(/\s+/g, '').toUpperCase();
        if (!o || (o.valeryNote || '') === v) return;
        await saveOrder({ ...o, valeryNote: v });
        const dup = v && S.orders.find((x) => x.id !== o.id && !x.deleted && x.valeryNote === v);
        toast(dup ? `Ojo: la nota ${v} también está en ${dup.clientName}` : (v ? `Nota ${v} guardada · ${o.clientName}` : 'Nota borrada'), dup ? 'err' : 'ok');
        PV.logEvent('nota_valery', `Nota Valery ${v || '(borrada)'} para ${o.clientName} (${o.sellerName})`, { orderId: o.id, clientName: o.clientName }, { onceKey: 'val:' + o.id, everyMin: 1 });
        return;
      }
      const ai = e.target.closest('.asg-in');
      if (ai) {
        const o = orderById(ai.dataset.oid), pid = ai.dataset.pid; if (!o || !Loads.editable(o)) return;
        const max = +((o.lines || {})[pid] || {}).cajas || 0, raw = ai.value.trim();
        const qty = { ...((o.envAssign && o.envAssign.qty) || {}) };
        if (raw === '') delete qty[pid]; else qty[pid] = Math.min(max, Math.max(0, int(raw)));
        await saveOrder({ ...o, envAssign: { ...(o.envAssign || {}), qty }, officeEdited: DB.now() });
        refresh(); return;
      }
      const inp = e.target.closest('.cell-in'); if (!inp) return;
      const key = [inp.dataset.oid, inp.dataset.pid, inp.dataset.kind].join('|');
      await setLineQty(orderById(inp.dataset.oid), inp.dataset.pid, inp.dataset.kind, int(inp.value));
      refresh();
      const next = [...root.querySelectorAll('.cell-in')].find((x) => [x.dataset.oid, x.dataset.pid, x.dataset.kind].join('|') === key);
      if (next) next.focus();
    };
  }

  /** Cambia la cantidad de una línea desde la oficina (queda marcado como editado). */
  async function setLineQty(o, pid, kind, value) {
    if (!Loads.editable(o)) { toast('Pedido bloqueado: la carga ya fue aprobada', 'err'); return; }
    const p = productById(pid);
    const line = o.lines[pid] || (p ? {
      code: p.code, name: p.name, presentation: p.presentation, category: p.category,
      unitsPerBox: p.unitsPerBox, unitPrice: p.unitPrice, boxPrice: p.boxPrice, cajas: 0, unidades: 0,
    } : null);
    if (!line) return;
    const lines = { ...o.lines };
    lines[pid] = { ...line, [kind]: Math.max(0, Math.min(99999, value)) };
    if (!lines[pid].cajas && !lines[pid].unidades) delete lines[pid];
    await saveOrder({ ...o, lines, officeEdited: DB.now() });
    PV.logEvent('pedido_editado_oficina', `Ajustó cantidades del pedido de ${o.clientName} (${o.sellerName})`, { orderId: o.id, clientName: o.clientName }, { onceKey: 'ofed:' + o.id });
  }

  /** Cambio de estado con las confirmaciones y efectos que correspondan. */
  async function changeStatus(load, statusId, root) {
    const cur = Loads.statusOf(load, S.config);
    const st = Loads.statuses(S.config).find((x) => x.id === statusId);
    if (!st || st.id === cur.id) return;
    const ordersById = byIdMap(S.orders);
    const os = Loads.loadOrders(load, ordersById);
    const u = Loads.usage(load, ordersById, S.config);
    const back = () => renderLoadDetail(root, S.loads.find((x) => x.id === load.id) || load);
    const closing = st.closing && !Loads.isClosed(load);
    if ((st.locked || st.closing) && !os.length) { toast('La hoja está vacía', 'err'); return back(); }
    if (closing) {
      if (!load.dispatcherId) { toast('Selecciona el despachador antes de cerrar la carga', 'err'); return back(); }
      const fecha = load.date || today();
      if (!confirm(`${st.name}: se descuenta el inventario y la hoja pasa al Archivo.\n\nFecha de la carga: ${fecha}${u.over ? `\n\n⚠ Supera el tope (${u.used}/${u.limit} ${u.measure}, ${u.clients}/${u.maxClients} clientes).` : ''}\n\n¿Continuar?`)) return back();
    } else if (!st.closing && Loads.isClosed(load)) {
      if (!confirm(`Reabrir la carga como "${st.name}": el inventario descontado se devuelve y los pedidos ${st.locked ? 'siguen bloqueados' : 'se podrán editar de nuevo'}. Los números de carga y notas se conservan. ¿Continuar?`)) return back();
    }
    // Antes de aprobar o cerrar: pedidos que parecen duplicados (mismo cliente con ±1 día)
    if ((st.locked && !cur.locked) || closing) {
      const idx = dupIndex(), dl = os.filter((o) => (idx.get(o.id) || []).some((x) => !x.extra));
      const txt = (o) => `• ${o.clientName} (${o.sellerName})\n${idx.get(o.id).filter((x) => !x.extra).map((x) => `   ${x.kind === 'same' ? '⚠ mismo cliente' : '≈ nombre parecido «' + x.clientName + '»'} en ${dupWhere(x)}`).join('\n')}`;
      if (dl.length && !confirm(`⚠ Posibles pedidos DUPLICADOS en esta hoja:\n\n${dl.slice(0, 10).map(txt).join('\n')}${dl.length > 10 ? `\n… y ${dl.length - 10} más` : ''}\n\nPregunta al vendedor antes de despachar (se entregaría dos veces). ¿${st.name} igual?`)) return back();
    }
    if ((st.locked && !cur.locked) || closing) {
      const nv = [...new Set(os.map((o) => clientById(o.clientId)).filter((c) => c && !Clientes.isVerified(c)))];
      if (nv.length && !confirm(`🕓 ${nv.length} cliente(s) de esta hoja aún NO están verificados por la oficina:\n\n${nv.slice(0, 10).map((c) => `• ${c.name}${c.rif ? ' (' + c.rif + ')' : ' (sin RIF)'} · registró ${c.createdByName || 'vendedor'}`).join('\n')}\n\nPuedes verificarlos en Clientes. ¿${st.name} igual?`)) return back();
    }
    if (st.locked && !cur.locked && !closing && !Loads.isClosed(load)) {
      if (!confirm(`${st.name}: vendedores y oficina ya no podrán modificar estos ${os.length} pedidos. ¿Continuar?`)) return back();
    }
    // Los números de carga y de nota los entrega el servidor: nunca se repiten entre PCs
    const need = Loads.numbersNeeded(load, statusId, { orders: S.orders, config: S.config });
    let numbers = { load: null, notes: [] };
    if (need.load || need.note) {
      const res = await Sync.reserveNumbers(need, (S.config && S.config.counters) || {});
      if (!res.ok) { toast(res.error + ' · Se necesita internet para numerar cargas y notas.', 'err'); return back(); }
      numbers = res;
    }
    const r = Loads.setStatus(load, statusId, { orders: S.orders, products: S.products, config: S.config }, { today: today(), numbers });
    if (r.config) await saveDocs('config', r.config);
    await saveDocs('orders', r.orders);
    await saveDocs('products', r.products);
    await saveDocs('loads', r.load);
    U().editQty = false;
    await log('carga_estado', `Hoja ${Loads.labelOf(r.load)} (${r.load.sellerName}) → ${st.name}${r.load.number ? ' · ' + Loads.loadCode(r.load) : ''}`, { loadId: r.load.id });
    toast(`Estado: ${st.name}`, 'ok');
    if (closing) {
      back();
      const sh = openSheet(`<h2>✓ ${esc(Loads.labelOf(r.load))} · ${esc(Loads.loadCode(r.load))}</h2>
        <p>${esc(st.name)} · fecha ${esc(r.load.date)}. Anota el número de nota Valery de cada cliente en la lista de la hoja.</p>
        <div class="actions" style="flex-direction:column">
          <button class="btn btn-primary" id="pSheet">🖨 Imprimir hoja de carga</button>
          <button class="btn" data-close>Listo</button></div>`);
      const ctx = { config: S.config, products: S.products, usage: Loads.usage(r.load, byIdMap(S.orders), S.config), clientsById: byIdMap(S.clients), load: r.load, productRank: productRank(), statusName: st.name };
      $('#pSheet', sh.el).onclick = () => Print.printLoadSheet(r.load, r.orders, ctx);
    } else back();
    PV.runSync(false);
  }

  /* ------------------------ Editor de pedido (oficina) ------------------------ */
  function orderEditor(o, onDone) {
    if (!o) return;
    const locked = !Loads.editable(o);
    const draw = (sh) => {
      const cur = orderById(o.id) || o;
      const lines = Object.entries(cur.lines).map(([pid, l]) => ({ pid, l, t: Matrix.lineTotals(l), p: productById(pid) }));
      const tot = Matrix.orderTotals(cur);
      sh.el.querySelector('#oeBody').innerHTML = `
        <table class="lines">${PV.groupedRows(lines, 3, ({ pid, l, t, p }) => {
          const sb = p ? p.sellBy : (l.boxPrice ? (l.unitPrice ? 'ambos' : 'caja') : 'unidad');
          return `<tr><td><b>${esc(l.name)} ${esc(l.presentation)}</b><div class="muted mono" style="font-size:12px">${esc(l.code)}</div></td>
            <td style="white-space:nowrap">
              ${sb !== 'unidad' ? `<label class="mini">CJ <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="cajas" value="${t.cajas || ''}" ${locked ? 'disabled' : ''}></label>` : ''}
              ${sb !== 'caja' ? `<label class="mini">UN <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="unidades" value="${t.unidades || ''}" ${locked ? 'disabled' : ''}></label>` : ''}
            </td><td class="num">${usd(t.monto)}</td></tr>`;
        })}
        <tr class="total-row"><td><b>TOTAL</b> · ${tot.cajas} cj + ${tot.unidades} un · ${tot.bultos} bultos</td><td></td><td class="num">${usd(tot.monto)}</td></tr></table>`;
    };
    const sh = openSheet(`
      <div class="row"><div class="grow"><h2>${esc(o.clientName)} <button type="button" class="btn btn-sm" id="oeClient" title="Elegir el cliente correcto, unir un cliente repetido o corregir el nombre">✎ Cliente</button></h2><div class="muted">${esc(o.sellerName)} · Ruta ${esc(o.route || '—')} · ${esc(fmtDate(o.routeDate))} · ${esc(Loads.orderLabel(o))}</div></div>
        <button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${locked ? '<div class="hint warn">🔒 La carga de este pedido ya fue aprobada: no se puede modificar.</div>' : ''}
      <div id="oeBody"></div>
      <div class="msg-box"><div class="section-title" style="margin:14px 0 6px">💬 Mensajes con ${esc(o.sellerName)}</div>
        <div id="oeMsgs"></div>
        <div class="row" style="gap:8px;align-items:flex-end"><label class="field grow"><span>Responder o pasar una novedad (le llega al teléfono)</span>
          <textarea id="oeMsg" class="input" rows="2" maxlength="300" placeholder="Ej: el cliente pidió entregar después de las 2 pm"></textarea></label>
          <button class="btn btn-primary" type="button" id="oeSend">Enviar</button></div></div>
      ${locked ? '' : `<label class="field" style="margin-top:12px"><span>Agregar producto</span>
        <input id="oeSearch" class="input" placeholder="Buscar por nombre o código…" autocomplete="off"></label><div id="oeResults" class="results"></div>
        <label class="field" style="margin-top:12px"><span>Nota para despacho</span><input id="oeNotes" class="input" maxlength="300" value="${esc(o.notes || '')}"></label>`}
      <div class="actions">${o.status !== 'despachado' ? '<button class="btn btn-danger" id="oeDel">🗑 Eliminar pedido</button>' : ''}<button class="btn btn-primary" data-close>Listo</button></div>`, { wide: true });
    draw(sh);
    $('#oeClient', sh.el).onclick = () => { sh.close(); PV.clientFixSheet(orderById(o.id) || o, { office: true, onDone: () => { if (onDone) onDone(); orderEditor(orderById(o.id), onDone); } }); };
    const drawMsgs = () => { $('#oeMsgs', sh.el).innerHTML = PV.msgThreadHTML(orderById(o.id) || o); };
    drawMsgs();
    $('#oeSend', sh.el).onclick = async () => {
      const ta = $('#oeMsg', sh.el), text = ta.value.trim().slice(0, 300);
      if (!text) { ta.focus(); return; }
      const cur = orderById(o.id) || o;
      const msg = { id: DB.uid('m'), at: DB.now(), text, by: (S.config && S.config.adminName) || 'Oficina' };
      await saveOrder({ ...cur, officeMsgs: (cur.officeMsgs || []).concat(msg).slice(-30) });
      await log('mensaje', `Mensaje a ${cur.sellerName} sobre ${cur.clientName}: ${text}`, { orderId: cur.id, clientName: cur.clientName });
      ta.value = ''; drawMsgs(); if (onDone) onDone(); toast('Mensaje enviado a ' + cur.sellerName, 'ok');
      PV.runSync(false);
    };
    // Eliminar desde la oficina (p. ej. el vendedor se equivocó): sale de su hoja,
    // queda en el Historial y el vendedor recibe el aviso. Un pedido despachado no se elimina.
    const del = $('#oeDel', sh.el);
    if (del) del.onclick = async () => {
      const cur = orderById(o.id) || o;
      if (cur.status === 'despachado') { toast('Un pedido despachado no se puede eliminar', 'err'); return; }
      const lq = cur.loadId ? S.loads.find((l) => l.id === cur.loadId) : null;
      if ((cur.delivery && cur.delivery.at) || (lq && lq.liq)) { toast('Este pedido está en una hoja con liquidación: reabre/ajusta la liquidación (⊘ No facturado o ✕ Anulada) en vez de eliminarlo', 'err'); return; }
      const t = Matrix.orderTotals(cur);
      if (!confirm(`¿Eliminar el pedido de ${cur.clientName} (${cur.sellerName}) por ${usd(t.monto)}?${cur.locked ? '\n\nOjo: su hoja de carga ya está aprobada.' : ''}\n\nSale de su hoja de carga y ${cur.sellerName} recibe el aviso.`)) return;
      const load = cur.loadId ? S.loads.find((l) => l.id === cur.loadId) : null;
      await saveOrder({ ...cur, deleted: true, deletedBy: 'oficina', deletedAt: DB.now() });
      let loadGone = false;
      if (load) {
        // La hoja queda sin él; si ya no le quedan pedidos y no tiene número, se elimina
        loadGone = !Loads.loadOrders(load, byIdMap(S.orders)).length && !load.number && !Loads.statusOf(load, S.config).locked;
        await saveDocs('loads', { ...load, orderIds: (load.orderIds || []).filter((id) => id !== cur.id), ...(loadGone ? { deleted: true } : {}) });
      }
      await log('pedido_eliminado', `Oficina eliminó el pedido de ${cur.clientName} (${cur.sellerName}) · ${usd(t.monto)}`, { orderId: cur.id, clientName: cur.clientName });
      sh.close(); toast('Pedido eliminado', 'ok');
      if (loadGone && U().loadId === load.id) { U().loadId = null; PV.render(); } else if (onDone) onDone();
      PV.runSync(false);
    };
    // La vista de fondo se actualiza en cada cambio (la hoja queda abierta encima)
    const changed = () => { draw(sh); if (onDone) onDone(); };
    sh.el.addEventListener('change', async (e) => {
      const inp = e.target.closest('.mini-in');
      if (inp) { await setLineQty(orderById(o.id), inp.dataset.pid, inp.dataset.kind, int(inp.value)); changed(); return; }
      if (e.target.id === 'oeNotes') { await saveOrder({ ...orderById(o.id), notes: e.target.value.slice(0, 300), officeEdited: DB.now() }); changed(); }
    });
    const s = $('#oeSearch', sh.el);
    if (s) s.oninput = () => {
      const tokens = norm(s.value).split(' ').filter(Boolean);
      const res = tokens.length ? S.products.filter((p) => p.active && tokens.every((t) => norm(p.code + ' ' + p.name + ' ' + p.presentation).includes(t))).slice(0, 8) : [];
      $('#oeResults', sh.el).innerHTML = res.map((p) => `<button class="result" data-add="${esc(p.id)}"><b>${esc(p.name)}</b> ${esc(p.presentation)} <span class="muted mono">${esc(p.code)}</span></button>`).join('');
    };
    sh.el.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-add]'); if (!a) return;
      const p = productById(a.dataset.add);
      await setLineQty(orderById(o.id), p.id, p.sellBy === 'unidad' ? 'unidades' : 'cajas', 1);
      s.value = ''; $('#oeResults', sh.el).innerHTML = ''; changed();
    });
  }

  /* ------------------ Pedido cargado por la oficina ------------------ */
  // La oficina carga un pedido de CUALQUIER cliente, vendedor y ruta. Sale como
  // «enviado» a nombre del vendedor: entra solo a su hoja de carga y sigue el flujo
  // normal (aprobación, despacho, liquidación, reportes) y el vendedor lo ve en
  // sus pedidos con la marca 🏢.
  function officeOrderDialog(onDone) {
    const d = { client: null, newName: '', sellerId: '', route: '', date: today(), lines: {}, notes: '' };
    const sellers = S.sellers.filter((x) => x.active !== false);
    const routes = [...new Set([...(S.config.routes || []), ...S.clients.map((c) => c.route).filter(Boolean)])].sort((a, b) => a.localeCompare(b, 'es'));
    const sh = openSheet(`
      <div class="row"><h2 class="grow">➕ Nuevo pedido (oficina)</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted" style="margin-top:0">Cualquier cliente, vendedor y ruta. Sale como enviado a nombre del vendedor: entra a su hoja de carga y sigue el flujo normal (carga, despacho, liquidación). El vendedor lo ve en sus pedidos.</p>
      <label class="field"><span>Cliente (de todos los vendedores)</span><input id="noCli" class="input" placeholder="Buscar por nombre o RIF…" autocomplete="off" maxlength="80"></label>
      <div id="noCliRes" class="results"></div><div id="noCliSel"></div>
      <div class="grid2" style="margin-top:8px">
        <label class="field"><span>Vendedor (a su nombre)</span><select id="noSeller" class="select"><option value="">— Elige —</option>${sellers.map((x) => `<option value="${esc(x.id)}">${esc(x.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Ruta</span><select id="noRoute" class="select"><option value="">— Elige —</option>${routes.map((r) => `<option>${esc(r)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Fecha del pedido</span><input type="date" id="noDate" class="input" value="${esc(d.date)}"></label>
      <label class="field" style="margin-top:8px"><span>Agregar producto</span><input id="noSearch" class="input" placeholder="Buscar por nombre o código…" autocomplete="off"></label>
      <div id="noResults" class="results"></div>
      <div id="noLines"></div>
      <label class="field" style="margin-top:12px"><span>Nota para despacho</span><input id="noNotes" class="input" maxlength="300"></label>
      <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn btn-ok" id="noSend" disabled>✓ Enviar pedido</button></div>`, { wide: true });
    const el = sh.el, q = (sel) => $(sel, el);
    const clientName = () => (d.client ? d.client.name : d.newName);
    const ready = () => !!(clientName() && d.sellerId && d.route && d.date && Object.keys(d.lines).length);
    const drawClient = () => {
      const c = d.client;
      q('#noCliSel').innerHTML = clientName() ? `<div class="hint">Cliente: <b>${esc(clientName())}</b>${c ? ` <span class="muted">${esc([c.rif, c.address].filter(Boolean).join(' · '))}${c.sellerId ? ' · cartera de ' + esc((sellerById(c.sellerId) || {}).name || '—') : ''}</span>` : ' <span class="tag">cliente nuevo</span>'}
        <button class="btn btn-sm" type="button" data-clear style="margin-left:8px">Cambiar</button></div>` : '';
      q('#noCli').style.display = clientName() ? 'none' : '';
      // Pedidos recientes de este cliente (o de nombre parecido) en cualquier vendedor y hoja
      if (clientName()) {
        const fk = Dedup.key(clientName()), d0 = Date.parse(d.date + 'T12:00:00Z');
        const rec = S.orders.filter((o) => Dedup.live(o) && Matrix.orderTotals(o).items && Math.abs(Date.parse(o.routeDate + 'T12:00:00Z') - d0) <= Dedup.WINDOW_DAYS * 86400000 &&
          ((c && o.clientId === c.id) || Dedup.key(o.clientName || o.clientKey) === fk));
        if (rec.length) q('#noCliSel').insertAdjacentHTML('beforeend', `<div class="hint warn">⚠ Este cliente ya tiene ${rec.length === 1 ? 'un pedido' : rec.length + ' pedidos'} en ${Dedup.WINDOW_DAYS} días:${rec.slice(0, 4).map((o) => `<div class="dup-line same">${esc(o.clientName)} · ${esc(dupWhere({ id: o.id, loadId: o.loadId, routeDate: o.routeDate, sellerName: o.sellerName }))} · ${usd(Matrix.orderTotals(o).monto)}</div>`).join('')}</div>`);
      }
    };
    const drawLines = () => {
      const lines = Object.entries(d.lines).map(([pid, l]) => ({ pid, l, t: Matrix.lineTotals(l), p: productById(pid) }));
      const tot = Matrix.orderTotals({ lines: d.lines });
      q('#noLines').innerHTML = lines.length ? `<table class="lines">${PV.groupedRows(lines, 3, ({ pid, l, t, p }) => {
        const sb = p ? p.sellBy : 'ambos';
        return `<tr><td><b>${esc(l.name)} ${esc(l.presentation)}</b><div class="muted mono" style="font-size:12px">${esc(l.code)}</div></td>
          <td style="white-space:nowrap">${sb !== 'unidad' ? `<label class="mini">CJ <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="cajas" value="${t.cajas || ''}"></label>` : ''}
            ${sb !== 'caja' ? `<label class="mini">UN <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="unidades" value="${t.unidades || ''}"></label>` : ''}</td>
          <td class="num">${usd(t.monto)}</td></tr>`; })}
        <tr class="total-row"><td><b>TOTAL</b> · ${tot.cajas} cj + ${tot.unidades} un · ${tot.bultos} bultos</td><td></td><td class="num">${usd(tot.monto)}</td></tr></table>`
        : '<div class="empty"><strong>Pedido vacío</strong>Busca y agrega productos.</div>';
      q('#noSend').disabled = !ready();
    };
    const setLine = (pid, kind, value) => {
      const p = productById(pid); if (!p) return;
      const line = d.lines[pid] || { code: p.code, name: p.name, presentation: p.presentation, category: p.category,
        unitsPerBox: p.unitsPerBox, unitPrice: p.unitPrice, boxPrice: p.boxPrice, cajas: 0, unidades: 0 };
      d.lines[pid] = { ...line, [kind]: Math.max(0, Math.min(99999, value)) };
      if (!d.lines[pid].cajas && !d.lines[pid].unidades) delete d.lines[pid];
    };
    const pickClient = (c, newName) => {
      d.client = c || null; d.newName = c ? '' : newName;
      if (c && c.sellerId && sellers.some((x) => x.id === c.sellerId)) { d.sellerId = c.sellerId; q('#noSeller').value = c.sellerId; }
      if (c && c.route) { if (![...q('#noRoute').options].some((o) => o.value === c.route)) q('#noRoute').insertAdjacentHTML('beforeend', `<option>${esc(c.route)}</option>`); d.route = c.route; q('#noRoute').value = c.route; }
      q('#noCli').value = ''; q('#noCliRes').innerHTML = '';
      drawClient(); drawLines();
      if (!d.sellerId) q('#noSeller').focus(); else q('#noSearch').focus();
    };
    q('#noCli').oninput = () => {
      const raw = q('#noCli').value.replace(/\s+/g, ' ').trim(), tokens = norm(raw).split(' ').filter(Boolean);
      const res = tokens.length ? S.clients.filter((c) => c.active !== false && tokens.every((t) => norm(c.name + ' ' + (c.rif || '')).includes(t))).slice(0, 10) : [];
      const exact = res.some((c) => norm(c.name) === norm(raw));
      q('#noCliRes').innerHTML = res.map((c) => `<button class="result" type="button" data-cid="${esc(c.id)}"><b>${esc(c.name)}</b> <span class="muted">${esc([c.rif, (sellerById(c.sellerId) || {}).name, c.route].filter(Boolean).join(' · '))}</span></button>`).join('')
        + (raw && !exact ? `<button class="result" type="button" data-newc="1">➕ No está: registrar cliente nuevo <b>${esc(raw.toUpperCase())}</b> con sus datos</button>` : '');
    };
    q('#noSeller').onchange = (e) => { d.sellerId = e.target.value; drawLines(); };
    q('#noRoute').onchange = (e) => { d.route = e.target.value; drawLines(); };
    q('#noDate').onchange = (e) => { d.date = e.target.value || today(); drawLines(); };
    q('#noNotes').onchange = (e) => { d.notes = e.target.value.slice(0, 300); };
    q('#noSearch').oninput = () => {
      const tokens = norm(q('#noSearch').value).split(' ').filter(Boolean);
      const res = tokens.length ? S.products.filter((p) => p.active && tokens.every((t) => norm(p.code + ' ' + p.name + ' ' + p.presentation + ' ' + (p.brand || '')).includes(t))).slice(0, 8) : [];
      q('#noResults').innerHTML = res.map((p) => `<button class="result" type="button" data-add="${esc(p.id)}"><b>${esc(p.name)}</b> ${esc(p.presentation)} <span class="muted mono">${esc(p.code)}</span></button>`).join('');
    };
    el.addEventListener('click', (e) => {
      const c = e.target.closest('[data-cid]'); if (c) { pickClient(S.clients.find((x) => x.id === c.dataset.cid)); return; }
      if (e.target.closest('[data-newc]')) {
        // Cliente nuevo: se registra con su ficha completa ANTES de cargarle el pedido
        const nm = q('#noCli').value.replace(/\s+/g, ' ').trim().slice(0, 80);
        Clientes.formSheet(null, { mode: 'office', prefillName: nm, defaults: { sellerId: d.sellerId || '', route: d.route || '' },
          onSave: async (prev, next) => { await saveClient(prev, next); await log('cliente_nuevo', `Registró el cliente ${next.name}${next.rif ? ' (' + next.rif + ')' : ''}`, { clientId: next.id, clientName: next.name }); },
          onSaved: (c) => pickClient(clientById(c.id) || c) });
        return;
      }
      if (e.target.closest('[data-clear]')) { d.client = null; d.newName = ''; drawClient(); drawLines(); q('#noCli').focus(); return; }
      const a = e.target.closest('[data-add]');
      if (a) {
        const p = productById(a.dataset.add), kind = p.sellBy === 'unidad' ? 'unidades' : 'cajas';
        if (!d.lines[p.id]) setLine(p.id, kind, 1);
        q('#noSearch').value = ''; q('#noResults').innerHTML = ''; drawLines();
        const inp = el.querySelector(`.mini-in[data-pid="${CSS.escape(p.id)}"][data-kind="${kind}"]`); if (inp) { inp.focus(); inp.select(); }
      }
    });
    el.addEventListener('change', (e) => { const i = e.target.closest('.mini-in'); if (i) { setLine(i.dataset.pid, i.dataset.kind, int(i.value)); drawLines(); } });
    q('#noSend').onclick = async () => {
      if (!ready()) return;
      const btn = q('#noSend'); btn.disabled = true;
      const seller = sellerById(d.sellerId);
      let client = d.client;
      const key = norm(clientName());
      const tot = Matrix.orderTotals({ lines: d.lines });
      const dup = S.orders.find((o) => !o.deleted && o.clientKey === key && o.routeDate === d.date && o.sellerId === seller.id && Loads.editable(o));
      if (dup && !confirm(`${clientName()} ya tiene un pedido de ${seller.name} para el ${fmtDate(d.date)} (${usd(Matrix.orderTotals(dup).monto)}).\n\n¿Crear otro pedido aparte?`)) { btn.disabled = false; return; }
      if (!client) { toast('Registra el cliente con su ficha antes de cargarle el pedido', 'err'); btn.disabled = false; return; }
      // Cliente recién registrado sin vendedor: pasa a la cartera del vendedor del pedido
      if (!client.sellerId) { const prevC = client; client = { ...client, sellerId: seller.id, route: client.route || d.route }; await saveClient(prevC, client); }
      const at = DB.now();
      const o = { id: DB.uid('o'), sellerId: seller.id, sellerName: seller.name,
        clientId: client.id, clientRif: client.rif || '', clientName: client.name, clientKey: norm(client.name),
        route: d.route, routeDate: d.date, status: 'enviado', lines: d.lines, sentLines: JSON.parse(JSON.stringify(d.lines)),
        notes: d.notes, loadId: null, createdAt: at, sentAt: at, createdBy: 'oficina', createdByName: (S.config && S.config.adminName) || 'Oficina',
        deviceId: await Sync.deviceId(), deleted: false };
      await saveOrder(o);
      await log('pedido_oficina', `Oficina cargó el pedido de ${o.clientName} a nombre de ${seller.name} · ${tot.cajas} cj + ${tot.unidades} un · ${usd(tot.monto)}`, { orderId: o.id, clientName: o.clientName, amount: tot.monto });
      sh.close();
      await autoPack();
      const placed = orderById(o.id), load = placed && placed.loadId ? S.loads.find((l) => l.id === placed.loadId) : null;
      toast(`Pedido de ${o.clientName} enviado a nombre de ${seller.name}${load ? ' · hoja ' + Loads.labelOf(load) : ''}`, 'ok');
      PV.runSync(false);
      if (onDone) onDone();
    };
    drawClient(); drawLines();
    setTimeout(() => q('#noCli').focus(), 50);
  }

  /* ============================== PEDIDOS ============================== */
  function renderOrders(root) {
    const date = U().date, mode = U().mode, sid = U().ordSeller || '';
    const day = S.orders.filter((o) => o.routeDate === date && Matrix.orderTotals(o).items);
    const stats = (id) => {
      const os = day.filter((o) => !id || o.sellerId === id);
      return { n: os.length, monto: os.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0), abiertos: os.filter((o) => o.status === 'abierto').length };
    };
    const card = (id, name) => { const st = stats(id); return `<button class="seller-card ${sid === id ? 'active' : ''}" data-sid="${esc(id)}">
      <h3>${esc(name)}</h3><div class="big num">${usd(st.monto)}</div>
      <div class="kpis"><span>${st.n} clientes</span>${st.abiertos ? `<span class="status abierto">${st.abiertos} abiertos</span>` : ''}</div></button>`; };
    const source = day.filter((o) => !sid || o.sellerId === sid);
    const dupIdx = dupIndex();
    const m = Matrix.build(source, mode, { rubros: rubros(), productRank: productRank() });
    const money = mode === 'monto';
    root.innerHTML = `
      <div class="toolbar">
        <label class="field"><span>Fecha</span><input type="date" id="oDate" class="input" value="${esc(date)}"></label>
        <div class="field"><span>Mostrar</span><div class="seg" id="oMode">
          ${[['bultos', 'Cajas / Unid.'], ['unidades', 'Unid. totales'], ['monto', 'Monto $']].map(([k, l]) => `<button data-m="${k}" class="${mode === k ? 'active' : ''}">${l}</button>`).join('')}</div></div>
        <div class="grow"></div>
        <button class="btn btn-primary" id="oNew">➕ Nuevo pedido</button>
        <button class="btn" id="oCopy" ${m.cols.length ? '' : 'disabled'}>📋 Copiar para Excel</button>
        <button class="btn" id="oCsv" ${m.cols.length ? '' : 'disabled'}>⇩ Excel</button>
        <button class="btn" id="oFlat" ${m.cols.length ? '' : 'disabled'}>⇩ Excel plano</button>
      </div>
      <div class="seller-cards" id="oSellers">${card('', 'Todos')}${S.sellers.map((s) => card(s.id, s.name)).join('')}</div>
      ${m.cols.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th class="sticky-col">Producto</th><th>UM</th>
        ${m.cols.map((c) => `<th class="client" title="${esc(c.client)}">${esc(c.client)}</th>`).join('')}<th class="tot">TOTAL</th></tr></thead>
        <tbody>${m.rows.map((r) => `<tr><td class="sticky-col"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b></td><td><span class="um ${r.um}">${r.um}</span></td>
          ${r.cells.map((v) => `<td class="n ${v ? '' : 'zero'}">${v ? (money ? nf2.format(v) : nf0.format(v)) : '·'}</td>`).join('')}<td class="n tot">${money ? nf2.format(r.total) : nf0.format(r.total)}</td></tr>`).join('')}</tbody>
        <tfoot>${m.footer.map((f, i, all) => `<tr class="${f.key === (all.some((x) => x.key === 'TOTAL_BULTOS') ? 'TOTAL_BULTOS' : all[0].key) ? 'stick' : ''}"><td class="sticky-col">${esc(f.label)}</td><td></td>${f.cells.map((v) => `<td class="n">${f.money ? nf2.format(v) : nf0.format(v)}</td>`).join('')}<td class="n tot">${f.money ? nf2.format(f.total) : nf0.format(f.total)}</td></tr>`).join('')}</tfoot></table></div>
        <div class="section-title">Detalle por cliente</div>
        <div class="card"><table class="inv">${source.map((o) => `<tr><td><b>${esc(o.clientName)}</b>${dupBadge(o, dupIdx)}${o.createdBy === 'oficina' ? ' <span class="tag" title="Cargado por la oficina">🏢 oficina</span>' : ''}<div class="muted">${esc(o.sellerName)} · ${esc(o.route || '')}</div>${dupLines(o, dupIdx)}</td>
          <td><span class="status ${o.status}">${esc(Loads.orderLabel(o))}</span></td><td class="n">${usd(Matrix.orderTotals(o).monto)}</td>
          <td><button class="btn btn-sm" data-edit="${esc(o.id)}">Ver / editar</button></td></tr>`).join('')}</table></div>`
      : `<div class="empty card"><strong>Sin pedidos</strong>No hay pedidos para ${esc(fmtDate(date))}.</div>`}`;
    $('#oNew').onclick = () => officeOrderDialog(() => renderOrders(root));
    $('#oDate').onchange = (e) => { U().date = e.target.value || today(); renderOrders(root); };
    $('#oMode').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { U().mode = b.dataset.m; renderOrders(root); } };
    $('#oSellers').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (b) { U().ordSeller = b.dataset.sid; renderOrders(root); } };
    root.onclick = (e) => { const ed = e.target.closest('[data-edit]'); if (ed) orderEditor(orderById(ed.dataset.edit), () => renderOrders(root)); };
    if (!m.cols.length) return;
    const who = sid ? slug(sellerById(sid).name) : 'todos';
    const opts = { sep: S.settings.csvSep, decimal: S.settings.csvDecimal };
    $('#oCopy').onclick = async () => { const ok = await copyText(Matrix.toDelimited(m, { sep: '\t', decimal: opts.decimal })); toast(ok ? 'Copiado: pégalo en Excel' : 'No se pudo copiar', ok ? 'ok' : 'err'); };
    $('#oCsv').onclick = () => Exporta.save(`pedidos_${who}_${date}_${mode}.xlsx`, [Exporta.matrix(m, { sheet: 'Pedidos', title: `PEDIDOS · ${sid ? sellerById(sid).name : 'Todos los vendedores'} · ${fmtDate(date)}`, info: [`Vista: ${mode === 'monto' ? 'Monto $' : mode === 'unidades' ? 'Unidades totales' : 'Cajas / Unidades'}`] })]);
    $('#oFlat').onclick = () => Exporta.save(`pedidos_${who}_${date}_plano.xlsx`, [Exporta.flat(source, { title: `PEDIDOS · ${sid ? sellerById(sid).name : 'Todos'} · ${fmtDate(date)} (una fila por línea)` })]);
  }

  /* ============================== ARCHIVO ============================== */
  /** Sobrante en los camiones: lo que quedó para otra carga y ninguna hoja ha tomado todavía, por despachador. */
  const carryName = (k) => { const [pid, um] = k.split('|'), p = productById(pid) || {}; return `${p.code || pid} ${p.name || ''} ${p.presentation || ''} ${um}`.replace(/\s+/g, ' ').trim(); };
  function truckStock() {
    const by = new Map();
    Liq.pendingCarries(S.loads).forEach((x) => {
      const id = x.load.liq.carry.dispatcherId || x.load.dispatcherId || '—';
      const d = by.get(id) || { id, name: x.load.dispatcherName || '—', items: [], total: {} };
      x.keys.forEach((k) => { const q = +x.load.liq.carry.rows[k] || 0; d.items.push({ load: x.load, key: k, qty: q, to: x.to[k] }); d.total[k] = (d.total[k] || 0) + q; });
      by.set(id, d);
    });
    return [...by.values()];
  }
  function carriesHTML() {
    const st = truckStock();
    if (!st.length) return '';
    const days = (l) => Math.max(0, Math.floor((Date.now() - Date.parse(l.liq.closedAt)) / 86400000));
    return `<div class="section-title">🚚 Sobrante en camiones <span class="muted">(quedó para otra carga y ninguna liquidación lo ha tomado)</span></div>
      ${st.map((d) => `<div class="card card-pad" style="margin-bottom:8px"><div class="row" style="align-items:center;gap:8px"><h3 class="grow" style="margin:0">${esc(d.name)}</h3>
        <button class="btn btn-sm" data-carry-cut="${esc(d.id)}">✂ Corte · vaciar camión</button></div>
        <div style="overflow:auto"><table class="inv"><thead><tr><th>Producto</th><th class="n">Cantidad</th><th>Viene de</th><th>Va para</th><th class="n">Días</th></tr></thead>
        <tbody>${d.items.map((x) => `<tr class="${days(x.load) > 3 ? 'liq-bad' : ''}"><td>${esc(carryName(x.key))}</td><td class="n"><b>${nf0.format(x.qty)}</b></td>
          <td>${esc(Loads.labelOf(x.load))} ${x.load.number ? `<span class="muted mono">${esc(Loads.loadCode(x.load))}</span>` : ''}</td>
          <td>${x.to ? esc(Loads.labelOf(x.to)) : '<span class="muted">la próxima que se liquide</span>'}</td><td class="n">${days(x.load)}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}
      <p class="muted">Pasa solo a la siguiente liquidación de ese despachador (o a la hoja elegida). En el corte de quincena, «Vaciar camión» registra lo que llegó al almacén; lo que falte queda como faltante a cobrar al despachador.</p>`;
  }
  /** Corte (fin de quincena o cuando se descarga el camión): lo que llegó al almacén; lo que falta, a cobrar. */
  function cutDialog(dispId, root) {
    const d = truckStock().find((x) => x.id === dispId); if (!d) return;
    const keys = Object.keys(d.total);
    const sh = openSheet(`
      <div class="row"><h2 class="grow">✂ Corte · vaciar camión de ${esc(d.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Cuenta lo que se bajó del camión al almacén. Si llega menos, la diferencia queda registrada como <b>faltante a cobrar</b> al despachador.</p>
      <table class="inv"><thead><tr><th>Producto</th><th class="n">Debe haber</th><th class="n">Llegó al almacén</th></tr></thead>
      <tbody>${keys.map((k) => `<tr><td>${esc(carryName(k))}</td><td class="n"><b>${nf0.format(d.total[k])}</b></td><td class="n"><input class="input qin small cut-in" inputmode="numeric" data-k="${esc(k)}" value="${d.total[k]}"></td></tr>`).join('')}</tbody></table>
      <label class="field"><span>Motivo / nota (obligatorio)</span><input class="input" id="cutMot" maxlength="160" value="Corte de quincena"></label>
      <div class="actions"><button class="btn btn-primary" id="cutOk">Registrar corte</button></div>`);
    $('#cutOk', sh.el).onclick = async () => {
      const motivo = $('#cutMot', sh.el).value.trim(); if (!motivo) { toast('Escribe el motivo', 'err'); return; }
      const got = {}; sh.el.querySelectorAll('.cut-in').forEach((i) => { got[i.dataset.k] = Math.max(0, int(i.value)); });
      const falt = keys.filter((k) => got[k] < d.total[k]).map((k) => `${d.total[k] - got[k]} ${carryName(k)}`);
      if (falt.length && !confirm(`Faltante a cobrar a ${d.name}:\n\n${falt.join('\n')}\n\n¿Registrar el corte?`)) return;
      // Lo recibido se reparte del origen más viejo al más nuevo; cada hoja guarda su parte
      const at = DB.now(), by = (S.config && S.config.adminName) || 'Oficina', left = { ...got }, saves = [];
      const loadsBy = new Map();
      d.items.forEach((x) => { (loadsBy.get(x.load.id) || loadsBy.set(x.load.id, { load: x.load, items: [] }).get(x.load.id)).items.push(x); });
      [...loadsBy.values()].forEach(({ load: l, items }) => {
        const rows = {};
        items.forEach((x) => { const r = Math.min(x.qty, left[x.key] || 0); left[x.key] = (left[x.key] || 0) - r; rows[x.key] = { tenia: x.qty, recibido: r }; });
        const upd = Liq.markUsed(l, items.map((x) => x.key), 'almacen');
        upd.liq.carryCuts = [...(l.liq.carryCuts || []), { at, by, motivo, rows }];
        saves.push(upd);
      });
      sh.close();
      await saveDocs('loads', saves);
      await log('liquidacion', `Corte · vació el camión de ${d.name}: ${keys.map((k) => `${got[k]}/${d.total[k]} ${carryName(k)}`).join(', ')}${falt.length ? ` · FALTANTE A COBRAR: ${falt.join(', ')}` : ' · completo'} · ${motivo}`, {});
      toast(falt.length ? 'Corte registrado con faltante a cobrar' : 'Corte registrado: todo llegó al almacén', falt.length ? 'err' : 'ok');
      renderArchive(root);
    };
  }

  /* ============================== PAPELERA ============================== */
  // Nada se borra de verdad: hojas y pedidos eliminados quedan marcados y se pueden recuperar.
  function renderTrash(root) {
    const st = U().trash;
    // Lo eliminado no está en memoria (S.*): se lee de la base del equipo
    if (!st.data) {
      root.innerHTML = '<p class="muted">Abriendo la papelera…</p>';
      Promise.all([DB.getAll('loads'), DB.getAll('orders')]).then(([ls, os]) => { st.data = { loads: ls, orders: os.filter((o) => o.deleted) }; if (root.isConnected && U().trash === st) renderTrash(root); });
      return;
    }
    const q = norm(st.q || ''), allLoads = st.data.loads;
    const when = (d) => String(d.deletedAt || d.updatedAt || '').slice(0, 16).replace('T', ' ');
    const loadOf = (o) => allLoads.find((l) => l.id === o.loadId);
    const ordersOfLoad = (l) => S.orders.concat(st.data.orders).filter((o) => o.loadId === l.id);
    const loads = allLoads.filter((l) => l.deleted).filter((l) => !q || norm([Loads.labelOf(l), l.sellerName, l.dispatcherName, Loads.loadCode(l), ...ordersOfLoad(l).map((o) => o.clientName)].join(' ')).includes(q))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    const orders = st.data.orders.filter((o) => !q || norm([o.clientName, o.sellerName, o.valeryNote, (loadOf(o) && Loads.labelOf(loadOf(o))) || ''].join(' ')).includes(q))
      .sort((a, b) => String(b.deletedAt || b.updatedAt).localeCompare(String(a.deletedAt || a.updatedAt)));
    const bult = (o) => Matrix.orderTotals(o).bultos;
    root.innerHTML = `
      <div class="toolbar"><button class="btn" id="tBack">← Archivo</button><h2 class="grow" style="margin:0">🗑 Papelera</h2>
        <label class="field grow"><span>Buscar (cliente, hoja, vendedor, nota)</span><input class="input" id="tQ" value="${esc(st.q || '')}" placeholder="Ej.: gran ellas"></label></div>
      <p class="muted">Lo eliminado no se pierde: se puede recuperar con todo lo que tenía (cantidades, liquidación y vacíos).</p>
      <div class="section-title">Hojas de carga eliminadas (${loads.length})</div>
      ${loads.length ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Hoja</th><th>Fecha</th><th>Despachador</th><th>Clientes</th><th class="n">Bultos</th><th>Liquidación</th><th>Eliminada</th><th></th></tr></thead>
        <tbody>${loads.map((l) => { const os = ordersOfLoad(l); const t = l.totals || {}; return `<tr><td><b>${esc(Loads.labelOf(l))}</b> <span class="muted mono">${l.number ? esc(Loads.loadCode(l)) : ''}</span><div class="muted">${esc(l.sellerName || '')}</div></td>
          <td>${esc(l.date || '')}</td><td>${esc(l.dispatcherName || '—')}</td><td>${esc(os.map((o) => o.clientName).slice(0, 4).join(', '))}${os.length > 4 ? '…' : ''}</td><td class="n">${nf0.format(t.bultos || os.reduce((a, o) => a + bult(o), 0))}</td>
          <td>${Liq.isDone(l) ? '✓ Liquidada' : l.liq ? 'Borrador' : '—'}</td><td class="muted">${esc(when(l))}</td><td><button class="btn btn-sm btn-primary" data-rl="${esc(l.id)}">↺ Recuperar</button></td></tr>`; }).join('')}</tbody></table></div>`
        : '<p class="muted">Ninguna.</p>'}
      <div class="section-title">Pedidos eliminados (${orders.length})</div>
      ${orders.length ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Cliente</th><th>Vendedor</th><th>Fecha</th><th>Hoja</th><th class="n">Bultos</th><th class="n">Monto</th><th>Eliminado</th><th></th></tr></thead>
        <tbody>${orders.slice(0, 200).map((o) => { const l = loadOf(o); return `<tr><td><b>${esc(o.clientName)}</b>${o.delivery && o.delivery.at ? ' <span class="tag">liquidado</span>' : ''}<div class="muted mono">${esc(o.valeryNote ? 'Nota ' + o.valeryNote : '')}</div></td>
          <td>${esc(o.sellerName || '')}</td><td>${esc(o.routeDate || '')}</td><td>${l ? esc(Loads.labelOf(l)) + (l.deleted ? ' <span class="warn-txt">(eliminada)</span>' : '') : '—'}</td>
          <td class="n">${nf0.format(bult(o))}</td><td class="n">${usd(Matrix.orderTotals(o).monto)}</td><td class="muted">${esc(when(o))}${o.deletedBy ? ' · ' + esc(o.deletedBy) : ''}</td>
          <td><button class="btn btn-sm btn-primary" data-ro="${esc(o.id)}">↺ Recuperar</button></td></tr>`; }).join('')}</tbody></table></div>`
        : '<p class="muted">Ninguno.</p>'}`;
    $('#tBack').onclick = () => { U().trash = null; renderArchive(root); };
    let tm; $('#tQ').oninput = (e) => { clearTimeout(tm); tm = setTimeout(() => { st.q = e.target.value; renderTrash(root); const i = $('#tQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); };
    root.onclick = async (e) => {
      const bl = e.target.closest('[data-rl]'), bo = e.target.closest('[data-ro]');
      if (!bl && !bo) return;
      const at = DB.now(), undel = (o) => { const x = { ...o, deleted: false, restoredAt: at }; delete x.deletedBy; delete x.deletedAt;
        // Con liquidación: el servidor vuelve a escribir sus renglones del kardex de vacíos
        if (x.delivery && x.delivery.at) x.kxRev = (+x.kxRev || 0) + 1; return x; };
      if (bl) {
        const l = allLoads.find((x) => x.id === bl.dataset.rl); if (!l) return;
        const os = st.data.orders.filter((o) => o.loadId === l.id);
        if (!confirm(`Recuperar la hoja ${Loads.labelOf(l)}${os.length ? ` y ${os.length} pedido(s) eliminados que estaban en ella` : ''}?`)) return;
        await saveDocs('loads', [{ ...l, deleted: false, restoredAt: at, orderIds: [...new Set([...(l.orderIds || []), ...os.map((o) => o.id)])] }]);
        if (os.length) await saveDocs('orders', os.map(undel));
        await log('recuperado', `Recuperó de la papelera la hoja ${Loads.labelOf(l)}${os.length ? ` con ${os.length} pedido(s)` : ''}`, { loadId: l.id });
        toast('Hoja recuperada', 'ok');
      } else {
        const o = st.data.orders.find((x) => x.id === bo.dataset.ro); if (!o) return;
        const l = loadOf(o);
        if (!confirm(`Recuperar el pedido de ${o.clientName} (${nf0.format(bult(o))} bultos)${l ? ` en su hoja ${Loads.labelOf(l)}${l.deleted ? ' (también se recupera la hoja)' : ''}` : ''}?`)) return;
        await saveDocs('orders', [undel(o)]);
        if (l) await saveDocs('loads', [{ ...l, deleted: false, ...(l.deleted ? { restoredAt: at } : {}), orderIds: [...new Set([...(l.orderIds || []), o.id])] }]);
        await log('recuperado', `Recuperó de la papelera el pedido de ${o.clientName}${l ? ' en la hoja ' + Loads.labelOf(l) : ''}`, { orderId: o.id, clientName: o.clientName });
        toast('Pedido recuperado', 'ok');
      }
      PV.runSync(false);
      st.data = null; renderTrash(root);
    };
  }

  function renderArchive(root) {
    if (U().trash) return renderTrash(root);
    if (U().liqId) { const l = S.loads.find((x) => x.id === U().liqId); if (l) return renderLiquidation(root, l); U().liqId = null; }
    if (U().archiveId) { const l = S.loads.find((x) => x.id === U().archiveId); if (l) return renderLoadDetail(root, l); U().archiveId = null; }
    const f = U().arch || (U().arch = { from: '', to: '', seller: '', route: '', disp: '', status: '' });
    repairLiquidations(root);
    const dateOf = (l) => String(l.date || l.closedAt || l.approvedAt || '').slice(0, 10);
    const list = S.loads.filter((l) => Loads.isClosed(l) &&
      (!f.from || dateOf(l) >= f.from) && (!f.to || dateOf(l) <= f.to) &&
      (!f.seller || Loads.sellerIdsOf(l).includes(f.seller)) && (!f.route || l.route === f.route) &&
      (!f.disp || l.dispatcherId === f.disp) && (!f.status || Loads.statusOf(l, S.config).id === f.status))
      .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || (b.number || 0) - (a.number || 0));
    // Lo liquidado cuenta lo ENTREGADO; las hojas sin liquidar se suman aparte (lo despachado)
    const ent = (l) => { const t = (l.liq && l.liq.totals) || {}; return { clients: t.clients || 0, bultos: t.bultos != null ? t.bultos : null, monto: t.monto || 0 }; };
    const sum = list.reduce((a, l) => {
      const t = l.totals || {};
      if (Liq.isDone(l)) { const e = ent(l); a.c += e.clients; a.b += e.bultos != null ? e.bultos : t.bultos || 0; a.m += e.monto; a.n++; }
      else { a.pm += t.monto || 0; a.pn++; }
      return a; }, { c: 0, b: 0, m: 0, n: 0, pm: 0, pn: 0 });
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    root.innerHTML = `
      <div class="toolbar" id="aFilters">
        <label class="field"><span>Desde</span><input type="date" class="input" data-f="from" value="${esc(f.from)}"></label>
        <label class="field"><span>Hasta</span><input type="date" class="input" data-f="to" value="${esc(f.to)}"></label>
        <label class="field"><span>Vendedor</span><select class="select" data-f="seller"><option value="">Todos</option>${opt(S.sellers.map((s) => [s.id, s.name]), f.seller)}</select></label>
        <label class="field"><span>Ruta</span><select class="select" data-f="route"><option value="">Todas</option>${opt((S.config.routes || []).map((r) => [r, r]), f.route)}</select></label>
        <label class="field"><span>Despachador</span><select class="select" data-f="disp"><option value="">Todos</option>${opt((S.config.dispatchers || []).map((d) => [d.id, d.name]), f.disp)}</select></label>
        <label class="field"><span>Estado</span><select class="select" data-f="status"><option value="">Todos</option>${opt(Loads.statuses(S.config).filter((x) => x.closing).map((x) => [x.id, x.name]), f.status)}</select></label>
        <button class="btn" id="aCsv" ${list.length ? '' : 'disabled'}>⇩ Exportar a Excel</button>
        <button class="btn" id="aTrash">🗑 Papelera</button>
      </div>
      <div class="kpi-row">
        <div class="kpi"><small>Cargas</small><b>${list.length}</b><small>${sum.n} liquidadas</small></div>
        <div class="kpi"><small>Clientes atendidos</small><b>${nf0.format(sum.c)}</b><small>en hojas liquidadas</small></div>
        <div class="kpi"><small>Bultos liquidados</small><b>${nf0.format(sum.b)}</b><small>en hojas liquidadas</small></div>
        <div class="kpi"><small>Venta liquidada</small><b>${usd(sum.m)}</b><small>en hojas liquidadas · lo que paga el cliente</small></div>
        <div class="kpi"><small>Venta en proceso</small><b>${usd(sum.pm)}</b><small>${sum.pn} hojas por liquidar · aún no cuenta</small></div>
      </div>
      ${carriesHTML()}
      ${list.length ? `<div class="card" style="overflow:auto"><table class="inv">
        <thead><tr><th>Código</th><th>Fecha</th><th>Estado</th><th>Vendedor(es)</th><th>Ruta</th><th>Despachador</th><th>Clientes</th><th>Bultos</th><th>Unid.</th><th>Venta</th><th>Liquidación</th><th></th></tr></thead>
        <tbody>${list.map((l) => { const t = l.totals || {}; return `<tr>
          <td><b class="mono">${esc(Loads.labelOf(l))}</b><div class="muted mono">${esc(Loads.loadCode(l))}</div></td><td data-l="Fecha">${esc(dateOf(l))}</td>
          <td data-l="Estado"><span class="status aprobada">${esc(stName(l))}</span></td>
          <td data-l="Vendedor">${esc(l.sellerName)}</td><td data-l="Ruta">${esc(l.route || '')}</td><td data-l="Despachador">${esc(l.dispatcherName || '')}</td>
          <td class="n" data-l="Clientes">${Liq.isDone(l) ? ent(l).clients : t.clients || 0}</td><td class="n" data-l="Bultos">${nf0.format(Liq.isDone(l) && ent(l).bultos != null ? ent(l).bultos : t.bultos || 0)}</td><td class="n" data-l="Unid.">${nf0.format(t.totalUnidades || 0)}</td>
          <td class="n" data-l="Monto">${Liq.isDone(l) ? `<b>${usd(ent(l).monto)}</b><div class="muted">liquidada · de ${usd(t.monto)}</div>` : `<span class="muted">${usd(t.monto)}<div>en proceso</div></span>`}</td>
          <td data-l="Liquidación">${Liq.isDone(l) ? '<span class="status aprobada">✓ Liquidada</span>' : (l.liq ? '<span class="status en_espera">Borrador</span>' : '<span class="status abierto">Por liquidar</span>')}</td>
          <td style="white-space:nowrap"><button class="btn btn-sm" data-view="${esc(l.id)}">Ver</button> <button class="btn btn-sm btn-primary" data-liq="${esc(l.id)}">🧾 Liquidar</button></td></tr>`; }).join('')}</tbody></table></div>`
      : '<div class="empty card"><strong>Sin cargas cerradas</strong>con esos filtros.</div>'}`;
    $('#aTrash').onclick = () => { U().trash = { q: '' }; renderArchive(root); };
    $('#aFilters').onchange = (e) => { const k = e.target.dataset.f; if (k) { f[k] = e.target.value; renderArchive(root); } };
    root.onclick = (e) => {
      const cut = e.target.closest('[data-carry-cut]'); if (cut) { cutDialog(cut.dataset.carryCut, root); return; }
      const q = e.target.closest('[data-liq]'); if (q) { U().liqId = q.dataset.liq; renderArchive(root); return; }
      const v = e.target.closest('[data-view]'); if (v) { U().archiveId = v.dataset.view; renderArchive(root); }
    };
    $('#aCsv').onclick = () => Exporta.save('archivo_cargas_' + today() + '.xlsx', [Exporta.table({ name: 'Archivo', title: 'ARCHIVO DE CARGAS', subtitle: `Exportado el ${fmtDate(today())} · «Venta liquidada» = lo entregado de verdad (hojas liquidadas); «Venta en proceso» = hojas despachadas sin liquidar`,
      cols: [{ h: 'CÓDIGO', w: 14 }, { h: 'CARGA', w: 12 }, { h: 'FECHA', w: 12, k: 'date' }, { h: 'ESTADO', w: 22 }, { h: 'VENDEDORES', w: 26 }, { h: 'RUTA', w: 14 }, { h: 'DESPACHADOR', w: 18 },
        { h: 'CLIENTES', k: 'int', total: true }, { h: 'CAJAS', k: 'int', total: true }, { h: 'UNID. SUELTAS', k: 'int', total: true }, { h: 'BULTOS', k: 'int', total: true }, { h: 'TOTAL UNIDADES', k: 'int', total: true },
        { h: 'VENTA EN PROCESO $', k: 'money', w: 16, total: true }, { h: 'LIQUIDADA', w: 11, align: 'center' }, { h: 'VENTA LIQUIDADA $', k: 'money', w: 16, total: true }],
      rows: list.map((l) => { const t = l.totals || {}; return [Loads.labelOf(l), Loads.loadCode(l), dateOf(l), stName(l), l.sellerName, l.route || '', l.dispatcherName || '', t.clients || 0, t.cajas || 0, t.unidades || 0, t.bultos || 0, t.totalUnidades || 0, t.monto || 0, Liq.isDone(l) ? 'SÍ' : 'NO', Liq.isDone(l) ? ent(l).monto : null]; }) })]);
  }

  /**
   * Liquidaciones cerradas antes de la E5: se completan una sola vez con la foto
   * del camión y los totales ENTREGADOS (clientes con entrega, bultos, monto),
   * tomados de lo que guardó cada pedido al cerrar. No cambia lo liquidado.
   */
  /** Liquidaciones cerradas con versiones anteriores → formato nuevo del sobrante (una vez, sin cambiar cantidades). */
  async function upgradeLiquidations(root) {
    if (U().liqUpgrading || !S.settings.adminKey) return;
    const docs = Liq.upgradeOld(S.loads);
    if (!docs.length) return;
    U().liqUpgrading = true;
    try {
      await saveDocs('loads', docs);
      const n = docs.filter((l) => l.liq.snapshot && l.liq.snapshot.upgradedAt).length;
      if (n) await log('liquidacion', `Se pasaron ${n} liquidación(es) anteriores al formato nuevo del sobrante (sin cambiar cantidades)`, {});
      if (root && root.isConnected) PV.render();
    } finally { U().liqUpgrading = false; }
  }
  async function repairLiquidations(root) {
    if (U().liqFixing) return;
    await upgradeLiquidations(root);
    const todo = S.loads.filter((l) => !l.deleted && Liq.isDone(l) && (!l.liq.snapshot || !l.liq.totals || l.liq.totals.bultos == null || !l.liq.totals.v2));
    if (!todo.length) return;
    U().liqFixing = true;
    const docs = [];
    todo.forEach((l) => {
      const os = Loads.loadOrders(l, byIdMap(S.orders));
      if (!os.length || os.some((o) => !o.delivery || o.delivery.at !== l.liq.closedAt)) return; // falta algún pedido en este equipo
      const t = { cajas: 0, unidades: 0, bultos: 0, totalUnidades: 0, monto: 0, clients: 0 };
      os.forEach((o) => { const x = Matrix.orderTotals({ lines: o.delivery.lines || {} }); if (x.items) t.clients++; t.cajas += x.cajas; t.unidades += x.unidades; t.bultos += x.bultos; t.totalUnidades += x.totalUnidades; t.monto = Matrix.r2(t.monto + x.monto); });
      const n = (r) => os.filter((o) => o.delivery.result === r).length;
      const snap = l.liq.snapshot || { rows: liqState(l).rows.map((r) => ({ key: r.key, code: r.code, name: r.name, presentation: r.presentation, um: r.um, pedido: r.pedido, entregado: r.entregado,
        traia: r.traia, queda: r.queda, carga: r.carga, anterior: r.anterior, total: r.total, debe: r.debe, dev: r.dev, dif: r.dif, motivo: r.motivo, dest: r.dest })) };
      docs.push({ ...l, liq: { ...l.liq, snapshot: snap, totals: { ...(l.liq.totals || {}), ...t, parcial: n('parcial'), pendiente: n('pendiente'), anulada: n('anulada'), v2: true } } });
    });
    if (docs.length) { await saveDocs('loads', docs); if (root.isConnected) renderArchive(root); }
    U().liqFixing = false;
  }

  /* ============================ LIQUIDACIÓN ============================ */
  // Fase 2 · E3. Se abre desde el Archivo o desde una hoja cerrada. Todo viene
  // prellenado como «entregado»: la oficina solo marca las novedades.
  const liqOpts = () => ({ rubros: rubros(), productRank: productRank(), productsById: byIdMap(S.products) });
  const blankLiq = () => ({ status: 'borrador', startedAt: DB.now(), orders: {}, truck: {} });
  const RESULT_TXT = Object.fromEntries(Liq.RESULTS);

  function liqState(load) {
    const os = Loads.loadOrders(load, byIdMap(S.orders));
    const liq = load.liq || blankLiq();
    const carry = Liq.carryFor(load, S.loads);
    const rows = Liq.truckRows(os, liq, carry, liqOpts());
    const vac = Liq.vacRows(os, liq, byIdMap(S.products));
    // Sobrante de esta hoja que ya tomó otra hoja liquidada (o un corte): queda fijo al corregir
    const locked = Liq.lockedCarry(load);
    rows.forEach((r) => { if (locked[r.key]) { const u = S.loads.find((l) => l.id === locked[r.key].by); r.locked = { ...locked[r.key], label: u ? Loads.labelOf(u) : '' }; } });
    const probs = Liq.problems(os, liq, rows, vac);
    // Todo lo que se vende lo reparte un despachador: sin él no cuadra vendedor ↔ despachador
    if (!load.dispatcherId) probs.unshift('La hoja no tiene despachador: asígnalo en la hoja de carga (todo lo vendido lo reparte un despachador)');
    return { os, liq, carry, rows, vac, probs };
  }

  function renderLiquidation(root, load) {
    const { os, liq, carry, rows, vac, probs } = liqState(load);
    const done = Liq.isDone(load);
    const dis = done ? 'disabled' : '';
    const pedido$ = (o) => Matrix.orderTotals(o).monto, entregado$ = (o) => Matrix.orderTotals(Liq.delivered(o, liq)).monto;
    const totPed = os.reduce((a, o) => a + pedido$(o), 0), totEnt = os.reduce((a, o) => a + entregado$(o), 0);
    const carrySrcs = carry ? carry.fromIds.map((id) => S.loads.find((l) => l.id === id)).filter(Boolean) : [];
    const older = done ? [] : Liq.olderUnliquidated(load, S.loads, Loads.isClosed);
    const pret = Liq.prevRetRows(liq), hasAnt = rows.some((r) => r.anterior);
    const dLoads = Liq.destLoads(load, S.loads);
    const lname = (l) => `${Loads.labelOf(l)}${l.number ? ' ' + Loads.loadCode(l) : ''}${l.date ? ' · ' + l.date : ''}`;
    const destVal = (r) => (r.dest === 'siguiente' && r.destLoad ? 'L:' + r.destLoad : r.dest || '');
    const destSel = (r) => `<select class="select sm ${r.dev > 0 && !r.dest ? 'need' : ''}" data-t="dest" ${dis}>${r.dest ? '' : '<option value="">— Elegir —</option>'}${opt([['almacen', 'Volvió a almacén'], ['siguiente', 'Siguiente carga (la próxima que se liquide)'],
      ...dLoads.map((l) => ['L:' + l.id, '→ ' + lname(l)]), ...(r.destLoad && !dLoads.some((l) => l.id === r.destLoad) ? [['L:' + r.destLoad, '→ ' + ((S.loads.find((l) => l.id === r.destLoad) && lname(S.loads.find((l) => l.id === r.destLoad))) || 'hoja eliminada')]] : [])], destVal(r))}</select>`;
    const fromTxt = (r) => (r.desde || []).map((id) => { const l = S.loads.find((x) => x.id === id); return l ? Loads.labelOf(l) : id; }).join(' + ');
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const motivoSel = (cur, attr) => `<select class="select sm" ${attr} ${dis}><option value="">— Motivo —</option>${Liq.MOTIVOS.map((m) => `<option ${m === cur ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>`;
    const sh = Liq.sheet(os, liq, rows, vac), rate = +S.config.exchangeRate || 0;
    const prev = Liq.prevRows(os, liq);
    // Lo que sale (despachados) contra lo que entra (recibidos + devueltos de entregas anteriores), por tipo
    const vacIO = [...new Set(sh.vac.map((v) => v.type))].map((type) => {
      const tot = (key) => (sh.vac.find((v) => v.type === type && v.key === key) || { total: 0 }).total;
      return { type, salen: tot('DESPACHADOS'), recibidos: tot('RECIBIDOS'), anteriores: tot('PREV'), entran: tot('RECIBIDOS') + tot('PREV') };
    });
    const counts = { parcial: 0, nofact: 0, pendiente: 0, anulada: 0 };
    os.forEach((o) => { const r = Liq.entry(liq, o.id).result; if (counts[r] !== undefined) counts[r]++; });

    root.innerHTML = `
      <div class="toolbar no-print">
        <button class="btn" id="qBack">← Volver</button>
        <div class="grow"><h2 style="margin:0">🧾 Liquidación · ${esc(Loads.labelOf(load))} ${load.number ? `<span class="muted mono">${esc(Loads.loadCode(load))}</span>` : ''}</h2>
          <div class="muted">${esc(load.sellerName)} · Despachador: <b>${esc(load.dispatcherName || '—')}</b> · Fecha de la carga ${esc(load.date || '—')} · pedidos del ${esc(Loads.orderDateRange(os) || '—')}</div></div>
        <span class="status ${done ? 'aprobada' : 'en_espera'}">${done ? '✓ Liquidada' : 'Borrador'}</span>
        <button class="btn" id="qPrint">🖨 Imprimir liquidación</button>
        <button class="btn" id="qXlsx">⇩ Excel</button>
        ${done ? '<button class="btn" id="qReopen">↺ Reabrir</button>' : `<button class="btn btn-ok" id="qClose" ${probs.length ? 'title="Revisa la lista de pendientes"' : ''}>✓ Cerrar liquidación</button>`}
      </div>
      <div class="kpi-row">
        <div class="kpi"><small>Clientes</small><b>${os.length}</b></div>
        <div class="kpi"><small>Devolución parcial</small><b>${counts.parcial}</b>${counts.nofact ? `<small>+ ${counts.nofact} no facturado (misma nota)</small>` : ''}</div>
        <div class="kpi"><small>Se entregan después</small><b>${counts.pendiente}</b></div>
        <div class="kpi"><small>Notas anuladas</small><b>${counts.anulada}</b></div>
        <div class="kpi"><small>Entregado</small><b>${usd(totEnt)}</b><small>de ${usd(totPed)}</small></div>
      </div>
      ${done ? `<div class="hint">✓ Liquidada el ${esc(new Date(liq.closedAt).toLocaleString('es-VE'))} por ${esc(liq.closedBy || 'oficina')}. Para corregir, usa «Reabrir».</div>` : ''}

      <div class="section-title">1 · Notas de los clientes <span class="muted">(todas vienen como entregadas: marca solo las novedades)</span></div>
      <div class="card" style="overflow:auto"><table class="inv liq-notes">
        <thead><tr><th>#</th><th>Cliente</th><th>Nota Valery</th><th>Resultado</th><th>Nota nueva</th><th>Motivo</th><th>Entregado</th><th></th></tr></thead>
        <tbody>${os.map((o, i) => {
          const e = Liq.entry(liq, o.id), nret = Object.values(e.ret || {}).reduce((a, r) => a + (+r.cajas || 0) + (+r.unidades || 0), 0);
          const nnf = Object.values(e.nf || {}).reduce((a, r) => a + (+r.cajas || 0) + (+r.unidades || 0), 0);
          return `<tr data-oid="${esc(o.id)}" class="${e.result !== 'entregada' ? 'liq-mark' : ''}">
            <td>${i + 1}</td>
            <td><b>${esc(o.clientName)}</b> <span class="tag">${esc(Loads.initials(o.sellerName))}</span></td>
            <td data-l="Nota Valery"><input class="input sm mono valery-in" inputmode="numeric" maxlength="20" data-oid="${esc(o.id)}" value="${esc(o.valeryNote || '')}" placeholder="N°" ${dis}></td>
            <td data-l="Resultado"><select class="select sm" data-q="result" ${dis}>${opt(Liq.RESULTS, e.result)}</select></td>
            <td data-l="Nota nueva">${e.result === 'parcial' ? `<input class="input sm mono" data-q="newValery" inputmode="numeric" maxlength="20" value="${esc(e.newValery || '')}" placeholder="N° nueva" ${dis}>` : (e.result === 'anulada' ? '<span class="muted">anulada</span>' : '')}</td>
            <td data-l="Motivo">${e.result !== 'entregada' ? motivoSel(e.motivo || '', 'data-q="motivo"') : ''}</td>
            <td class="n" data-l="Entregado">${usd(entregado$(o))}${entregado$(o) !== pedido$(o) ? `<div class="muted">de ${usd(pedido$(o))}</div>` : ''}</td>
            <td>${e.result === 'parcial' ? `<button class="btn btn-sm" data-ret="${esc(o.id)}">↩ Devolución${nret ? ' (' + nret + ')' : ''}</button>` : ''}${e.result === 'nofact' ? `<button class="btn btn-sm" data-nf="${esc(o.id)}">⊘ No facturado${nnf ? ' (' + nnf + ')' : ''}</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>
      <p class="muted">Anulada = la nota se anula en Valery en este momento. Devolución parcial = se anula la nota y se escribe la nueva de Valery que la reemplaza. «Se entrega después» deja la misma nota y el pedido vuelve a la cola para la próxima hoja.</p>

      <div class="section-title">2 · Vacíos <span class="muted">(prellenado: recibió los que le tocaban · Despachados − Recibidos − Asignados = Quedan debiendo · al cerrar va al kardex)</span></div>
      ${vac.length ? `
      <div class="card" style="overflow:auto"><table class="inv liq-vac">
        <thead><tr><th>Cliente</th><th>Envase</th><th class="n">Despachados</th><th class="n">Vacíos recibidos</th><th class="n">Asignados</th><th class="n">Quedan debiendo</th><th>Motivo</th></tr></thead>
        <tbody>${vac.map((v) => `<tr data-oid="${esc(v.orderId)}" data-pid="${esc(v.pid)}">
          <td><b>${esc(v.client)}</b></td><td>${esc(v.code)} ${esc(v.name)} <span class="muted">${v.regime === 'contraentrega' ? '· contraentrega' : '· préstamo'}</span></td>
          <td class="n">${v.boxes}</td>
          <td class="n"><input class="input qin small" inputmode="numeric" data-v="recv" value="${v.recv}" ${dis}></td>
          <td class="n">${v.assign ? `<input class="input qin small" inputmode="numeric" data-v="asg" value="${v.asg === null ? '' : v.asg}" placeholder="—" ${dis}>` : '—'}</td>
          <td class="n ${v.pending ? 'warn-txt' : ''}">${v.pending}</td>
          <td>${v.pending ? `<select class="select sm" data-v="motivo" ${dis}><option value="">${v.regime === 'prestamo' ? 'Préstamo' : '— Motivo —'}</option>${Liq.VAC_MOTIVOS.map((m) => `<option ${m === v.motivo ? 'selected' : ''}>${esc(m)}</option>`).join('')}</select>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Ningún cliente de esta hoja llevó retornables.</p>'}
      <div class="row" style="align-items:center;gap:8px;margin-top:10px"><h3 class="grow" style="margin:0">↩ Vacíos de entregas anteriores <span class="muted" style="font-weight:400;font-size:13px">(los que un cliente de esta hoja devolvió de pedidos viejos y trajo este despachador · al cerrar van al kardex del cliente)</span></h3>
        ${done ? '' : '<button class="btn btn-sm" id="qPrevAdd">+ Agregar</button>'}</div>
      ${prev.length ? `<div class="card" style="overflow:auto"><table class="inv liq-prev">
        <thead><tr><th>Cliente</th><th>Envase</th><th>Son de</th><th class="n">Vacíos devueltos</th><th>Nota</th><th></th></tr></thead>
        <tbody>${prev.map((p) => `<tr data-oid="${esc(p.orderId)}" data-prev="${esc(p.key)}"><td><b>${esc(p.client)}</b></td><td>${esc(p.type)}</td><td>${p.from === 'dev_asignado' ? 'Sus asignados' : 'Lo que debía'}</td>
          <td class="n"><b>${nf0.format(p.qty)}</b></td><td>${esc(p.motivo)}</td><td>${done ? '' : `<button class="btn btn-sm" data-prev-del="${esc(p.key)}" data-oid="${esc(p.orderId)}" aria-label="Quitar">✕</button>`}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Ninguno. Usa «+ Agregar» si el despachador trajo vacíos que un cliente debía de antes.</p>'}
      ${vacIO.length ? `<div class="kpi-row">${vacIO.map((t) => `<div class="kpi"><small>Vacíos ${esc(t.type)} · salen / entran</small><b>${nf0.format(t.salen)} / ${nf0.format(t.entran)}</b><small>entran = ${nf0.format(t.recibidos)} recibidos + ${nf0.format(t.anteriores)} de entregas anteriores</small></div>`).join('')}</div>` : ''}

      <div class="section-title">3 · Cuadre del camión <span class="muted">(escribe a mano lo que quedó, lo que se cargó de verdad y lo que volvió · las celdas amarillas son tuyas)</span></div>
      ${!load.dispatcherId ? '<div class="hint warn">⚠ La hoja no tiene despachador: no se puede saber qué mercancía traía el camión de cargas anteriores.</div>'
        : carry ? `<div class="hint">🚚 <b>QUEDAN</b> = lo que el camión de <b>${esc(load.dispatcherName || '')}</b> traía de: ${carrySrcs.map((l) => `<b>${esc(Loads.labelOf(l))}</b>${l.number ? ' ' + esc(Loads.loadCode(l)) : ''} (${esc(l.date || '')})`).join(' + ')} · ${Object.keys(carry.rows).length} producto(s). Si lo cambias, escribe el motivo.</div>`
        : `<div class="hint">🚚 El camión de <b>${esc(load.dispatcherName || '')}</b> no traía mercancía de cargas anteriores.</div>`}
      ${older.length ? `<div class="hint warn">⚠ Antes de esta hoja, el despachador tiene ${older.length === 1 ? 'otra hoja' : older.length + ' hojas'} sin liquidar: ${older.map((l) => `<b>${esc(Loads.labelOf(l))}</b>${l.number ? ' ' + esc(Loads.loadCode(l)) : ''} (${esc(l.date || '—')})`).join(', ')}. Liquídala primero para que lo que sobró pase a esta en orden.</div>` : ''}
      <div class="row" style="align-items:center;gap:8px;margin-top:6px"><h3 class="grow" style="margin:0">↩ Mercancía devuelta de entregas anteriores <span class="muted" style="font-weight:400;font-size:13px">(un cliente de otra hoja devolvió productos y los trajo este camión · entran al cuadre)</span></h3>
        ${done ? '' : '<button class="btn btn-sm" id="qRetAdd">+ Agregar</button>'}</div>
      ${pret.length ? `<div class="card" style="overflow:auto"><table class="inv liq-pret">
        <thead><tr><th>Cliente</th><th>Viene de</th><th>Producto</th><th>UM</th><th class="n">Cantidad</th><th>Nota / motivo</th><th></th></tr></thead>
        <tbody>${pret.map((x) => `<tr><td><b>${esc(x.clientName)}</b></td><td>${esc(x.label || '—')}</td><td>${esc(x.code || '')} ${esc(x.name || '')}</td><td><span class="um ${x.um}">${x.um}</span></td>
          <td class="n"><b>${nf0.format(x.qty)}</b></td><td>${esc([x.nota ? 'Nota ' + x.nota : '', x.motivo].filter(Boolean).join(' · '))}</td>
          <td>${done ? '' : `<button class="btn btn-sm" data-pret-del="${esc(x.id)}" aria-label="Quitar">✕</button>`}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Ninguna. Usa «+ Agregar» si el camión trajo mercancía que un cliente de otra hoja devolvió.</p>'}
      <div class="toolbar no-print"><button class="btn btn-sm" id="qAllStore" ${dis}>Todo lo que sobra → volvió a almacén</button><button class="btn btn-sm" id="qAllNext" ${dis}>Todo lo que sobra → siguiente carga</button></div>
      <div class="card" style="overflow:auto"><table class="inv liq-truck">
        <thead><tr><th>Producto</th><th>UM</th><th class="n">Según hoja</th><th class="n">Entregado</th><th class="n in">Quedan</th><th class="n in">Carga</th>${hasAnt ? '<th class="n">Dev. anteriores</th>' : ''}<th class="n">Total</th><th class="n">Debe quedar</th><th class="n in">Devolución</th><th class="n">Diferencia</th><th class="in">Motivo si no cuadra</th><th>Lo que sobra</th></tr></thead>
        <tbody>${rows.map((r) => `<tr data-key="${esc(r.key)}" class="${r.dev === null ? 'liq-count' : r.dif !== 0 ? 'liq-bad' : ''}">
          <td data-l="Producto"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b></td><td><span class="um ${r.um}">${r.um}</span></td>
          <td class="n" data-l="Según hoja">${r.pedido}${r.noSalio ? `<div class="muted" style="font-size:11px">−${r.noSalio} no salió</div>` : ''}</td><td class="n" data-l="Entregado"><b>${r.entregado}</b></td>
          <td class="n in" data-l="Quedan"><input class="input qin small" inputmode="numeric" data-t="queda" value="${r.quedaMan || r.queda ? r.queda : ''}" placeholder="0" aria-label="Quedan ${esc(r.code)}" ${dis}>${r.traia || r.quedaMan ? `<div class="muted" style="font-size:11px">${r.queda !== r.traia ? `<span class="warn-txt">traía ${r.traia}</span>` : 'traía ' + r.traia}${r.traia ? ' · de ' + esc(fromTxt(r)) : ''}</div>` : ''}</td>
          <td class="n in" data-l="Carga"><input class="input qin small" inputmode="numeric" data-t="carga" value="${r.carga}" aria-label="Carga ${esc(r.code)}" ${dis}></td>
          ${hasAnt ? `<td class="n" data-l="Dev. anteriores">${r.anterior || ''}</td>` : ''}<td class="n" data-l="Total">${r.total}</td><td class="n" data-l="Debe quedar"><b>${r.debe}</b></td>
          <td class="n in" data-l="Devolución"><input class="input qin small" inputmode="numeric" data-t="dev" value="${r.dev === null ? '' : r.dev}" placeholder="contar" aria-label="Devolución ${esc(r.code)}" ${dis}></td>
          <td class="n ${r.dif ? 'warn-txt' : ''}" data-l="Diferencia"><b>${r.dif === null ? '' : r.dif}</b></td>
          <td class="in" data-l="Motivo"><input class="input sm" data-t="motivo" maxlength="80" list="liqMot" value="${esc(r.motivo)}" placeholder="${r.dif ? 'motivo' : '—'}" aria-label="Motivo ${esc(r.code)}" ${dis}></td>
          <td data-l="Lo que sobra">${r.debe > 0 || r.dev > 0 ? destSel(r) : ''}${r.locked ? `<div class="muted" style="font-size:11px">🔒 ${r.locked.qty} ya ${r.locked.by === 'almacen' ? 'se descargó en un corte' : 'lo tomó ' + esc(r.locked.label || 'otra hoja')}</div>` : ''}</td></tr>`).join('')}</tbody>
        <tfoot><tr><td colspan="2"><b>TOTAL</b></td>${['pedido', 'entregado', 'queda', 'carga', ...(hasAnt ? ['anterior'] : []), 'total', 'debe', 'dev', 'dif'].map((k) => `<td class="n"><b>${nf0.format(rows.reduce((a, r) => a + (+r[k] || 0), 0))}</b></td>`).join('')}<td colspan="2"></td></tr></tfoot></table></div>
      <p class="muted">Total = Quedan + Carga${hasAnt ? ' + Dev. anteriores' : ''} · Debe quedar = Total − Entregado · Diferencia = Debe quedar − Devolución. Si la diferencia no es 0, escribe el motivo. Lo que sobra SIEMPRE se decide: vuelve a almacén o sigue en el camión a la siguiente carga del mismo despachador (nunca se pierde).</p>

      <div class="section-title">4 · Hoja de liquidación <span class="muted">(lo entregado a cada cliente; a la derecha el mismo cuadre del camión)</span></div>
      <div class="table-wrap"><table class="grid sheet-grid liq-grid">
        <thead>
          <tr class="ini-row"><th class="sticky-col">Vendedor →</th>${sh.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}<th colspan="10"></th></tr>
          <tr class="ini-row liq-nota"><th class="sticky-col">Nota Valery →</th>${sh.cols.map((c) => `<th>${esc(c.order.valeryNote || '—')}${c.entry.result === 'parcial' && c.entry.newValery ? `<br>→ ${esc(c.entry.newValery)}` : ''}</th>`).join('')}<th colspan="10"></th></tr>
          <tr class="ini-row liq-nov"><th class="sticky-col">Novedad →</th>${sh.cols.map((c) => `<th class="${c.entry.result}">${esc(Liq.shortResult(c.entry)) || '✓'}</th>`).join('')}<th colspan="10"></th></tr>
          <tr><th class="sticky-col">Producto</th>${sh.cols.map((c, i) => `<th class="client" title="${esc(c.order.clientName)}"><div>${i + 1}. ${esc(c.order.clientName)}</div></th>`).join('')}
            <th class="lq">Entregado</th><th class="lq">Quedan</th><th class="lq">Carga</th><th class="lq">Total</th><th class="lq">Debe quedar</th><th class="lq">Devolución</th><th class="lq">Diferencia</th><th class="lq">Motivo</th><th class="lq">Lo que sobra</th><th class="lq usd">Total $</th></tr>
        </thead>
        <tbody>${sh.rows.map((r) => `<tr data-key="${esc(r.key)}" class="${r.dev === null ? 'liq-count' : r.dif !== 0 ? 'liq-bad' : ''}">
          <td class="sticky-col"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b> <span class="um ${r.um}">${r.um}</span></td>
          ${r.cells.map((c) => `<td class="n ${c.del || c.ret ? '' : 'zero'}">${c.del ? nf0.format(c.del) : ''}${c.ret ? (c.nf ? `<small class="ret" title="No facturado (misma nota)">⊘${c.ret}</small>` : `<small class="ret" title="Devuelto">↩${c.ret}</small>`) : ''}</td>`).join('')}
          <td class="n lq-tot">${r.entregado}</td><td class="n"><input class="cell-in" inputmode="numeric" data-t="queda" value="${r.quedaMan || r.queda ? r.queda : ''}" aria-label="Quedan ${esc(r.code)}" ${dis}></td>
          <td class="n"><input class="cell-in" inputmode="numeric" data-t="carga" value="${r.carga}" aria-label="Carga ${esc(r.code)}" ${dis}></td>
          <td class="n">${r.total}${r.anterior ? `<small class="ret" title="Incluye devoluciones de entregas anteriores">+${r.anterior}↩ant</small>` : ''}</td><td class="n"><b>${r.debe}</b></td>
          <td class="n"><input class="cell-in" inputmode="numeric" data-t="dev" value="${r.dev === null ? '' : r.dev}" placeholder="contar" aria-label="Devolución ${esc(r.code)}" ${dis}></td>
          <td class="n"><b>${r.dif === null ? '' : r.dif}</b></td>
          <td><input class="cell-in wide" data-t="motivo" maxlength="80" list="liqMot" value="${esc(r.motivo)}" ${r.dif ? '' : 'placeholder="—"'} aria-label="Motivo ${esc(r.code)}" ${dis}></td>
          <td>${r.debe > 0 || r.dev > 0 ? destSel(r) : ''}</td>
          <td class="n lq-usd">${usd(r.usd)}</td></tr>`).join('')}</tbody>
        <tfoot>
          <tr class="stick"><td class="sticky-col">TOTAL (cajas + unidades)</td>${sh.totals.bultos.map((v) => `<td class="n">${nf0.format(v)}</td>`).join('')}<td class="n lq-tot">${nf0.format(sh.totals.bultos.reduce((x, y) => x + y, 0))}</td><td colspan="8"></td><td></td></tr>
          <tr class="liq-money"><td class="sticky-col">TOTAL $ POR CLIENTE</td>${sh.totals.monto.map((v) => `<td class="n">${usd(v)}</td>`).join('')}<td colspan="9"></td><td class="n lq-usd">${usd(sh.totals.usd)}</td></tr>
          ${rate ? `<tr><td class="sticky-col">TOTAL Bs (tasa ${nf2.format(rate)})</td>${sh.totals.monto.map((v) => `<td class="n">${nf2.format(v * rate)}</td>`).join('')}<td colspan="9"></td><td class="n lq-usd">${nf2.format(sh.totals.usd * rate)}</td></tr>` : ''}
          ${sh.vac.map((v) => `<tr class="vac-row k-${v.key}"><td class="sticky-col">${esc(v.label)}</td>${v.cells.map((x) => `<td class="n">${x === null ? '' : nf0.format(x)}</td>`).join('')}<td class="n lq-tot">${nf0.format(v.total)}</td><td colspan="9"></td></tr>`).join('')}
        </tfoot></table></div>
      ${(() => { const c = Liq.cuadre(sh, byIdMap(S.products)), t = Liq.cuadreLines(c, usd); return `<div class="card card-pad liq-cuadre ${c.ok ? 'ok' : 'bad'}" style="margin-top:10px">
        <div class="section-title" style="margin:0 0 6px">💲 Cuadre en dólares <span class="muted">(el camión valorado al precio de las notas)</span></div>
        ${t.lines.map((x) => `<div class="mono">${esc(x)}</div>`).join('')}
        <div style="margin-top:6px"><b class="${c.ok ? '' : 'warn-txt'}">${esc(t.verdict)}</b></div>
        ${t.extra.map((x) => `<div class="muted">${esc(x)}</div>`).join('')}</div>`; })()}
      <datalist id="liqMot">${Liq.MOTIVOS.map((m) => `<option value="${esc(m)}">`).join('')}</datalist>
      <p class="muted">Total = Quedan + Carga · Debe quedar = Total − Entregado · Diferencia = Debe quedar − Devolución. «Siguiente carga» solo pasa a la próxima hoja del mismo despachador.</p>

      ${!done ? (probs.length ? `<div class="hint warn"><b>Antes de cerrar:</b><ul style="margin:6px 0 0">${probs.slice(0, 25).map((p) => `<li>${esc(p)}</li>`).join('')}${probs.length > 25 ? `<li>… y ${probs.length - 25} más</li>` : ''}</ul></div>`
        : '<div class="hint">✓ Todo cuadra. Puedes cerrar la liquidación.</div>') : ''}`;

    const cur = () => S.loads.find((x) => x.id === load.id) || load;
    const refresh = (focusSel) => { renderLiquidation(root, cur()); if (focusSel) { const el = root.querySelector(focusSel); if (el) el.focus(); } };
    const saveLiq = async (fn, focusSel) => {
      if (Liq.isDone(cur())) { toast('La liquidación está cerrada: reábrela para corregir', 'err'); return; }
      const l = cur(); const liq2 = JSON.parse(JSON.stringify(l.liq || blankLiq()));
      liq2.orders = liq2.orders || {}; liq2.truck = liq2.truck || {};
      fn(liq2);
      await saveDocs('loads', { ...l, liq: liq2 });
      refresh(focusSel);
    };
    $('#qBack').onclick = () => { U().liqId = null; PV.render(); };
    $('#qXlsx').onclick = () => { const l = cur(), st = liqState(l), sh2 = Liq.sheet(st.os, st.liq, st.rows, st.vac);
      Exporta.save(`liquidacion_${slug(Loads.labelOf(l))}_${l.date || today()}.xlsx`, [Exporta.liquidation(l, sh2, { rate: +S.config.exchangeRate || 0, productsById: byIdMap(S.products), loadName: (id) => { const x = S.loads.find((y) => y.id === id); return x ? Loads.labelOf(x) : 'otra hoja'; },
        info: [`Fecha de la carga: ${l.date || '—'}`, `Pedidos del: ${Loads.orderDateRange(st.os) || '—'}`, `Ruta: ${l.route || '—'}`, `Despachador: ${l.dispatcherName || '—'}`, `Vendedor(es): ${l.sellerName || ''}`, Liq.isDone(l) ? 'LIQUIDADA' : 'BORRADOR'] })]); };
    $('#qPrint').onclick = () => { const st = liqState(cur()); Print.printLiquidation(cur(), st, { config: S.config, products: S.products, productRank: productRank(), loads: S.loads }); };
    const qc = $('#qClose'); if (qc) qc.onclick = () => closeLiquidation(cur(), root);
    const qr = $('#qReopen'); if (qr) qr.onclick = () => reopenLiquidation(cur(), root);
    const setAll = (dest) => saveLiq((q) => rows.forEach((r) => { if (r.debe > 0 || r.dev > 0) { const x = { ...(q.truck[r.key] || {}), dest }; delete x.destLoad; q.truck[r.key] = x; } }));
    const sa = $('#qAllStore'); if (sa) sa.onclick = () => setAll('almacen');
    const sn = $('#qAllNext'); if (sn) sn.onclick = () => setAll('siguiente');

    const pa = $('#qPrevAdd'); if (pa) pa.onclick = () => prevVacDialog(cur(), saveLiq);
    const ra = $('#qRetAdd'); if (ra) ra.onclick = () => prevRetDialog(cur(), saveLiq);
    root.onclick = (e) => {
      const b = e.target.closest('[data-ret]'); if (b) returnsDialog(orderById(b.dataset.ret), saveLiq);
      const nf = e.target.closest('[data-nf]'); if (nf) notBilledDialog(orderById(nf.dataset.nf), saveLiq);
      const rd = e.target.closest('[data-pret-del]');
      if (rd) saveLiq((q) => { q.prevRet = { ...(q.prevRet || {}) }; delete q.prevRet[rd.dataset.pretDel]; });
      const d = e.target.closest('[data-prev-del]');
      if (d) saveLiq((q) => { const en = { result: 'entregada', ...(q.orders[d.dataset.oid] || {}) }; en.prev = { ...(en.prev || {}) }; delete en.prev[d.dataset.prevDel]; q.orders[d.dataset.oid] = en; });
    };
    root.onchange = async (e) => {
      const t = e.target;
      const vi = t.closest('.valery-in');
      if (vi) {
        const o = orderById(vi.dataset.oid), v = vi.value.replace(/\s+/g, '').toUpperCase();
        if (o && (o.valeryNote || '') !== v) { await saveOrder({ ...o, valeryNote: v }); toast(v ? `Nota ${v} guardada · ${o.clientName}` : 'Nota borrada', 'ok'); }
        return;
      }
      const tr = t.closest('tr');
      if (t.dataset.q && tr && tr.dataset.oid) {
        const oid = tr.dataset.oid, k = t.dataset.q, val = t.value.trim();
        await saveLiq((q) => {
          const en = { result: 'entregada', ...(q.orders[oid] || {}) };
          en[k] = k === 'newValery' ? val.replace(/\s+/g, '').toUpperCase() : val;
          if (k === 'result' && val === 'entregada') { delete en.ret; delete en.nf; delete en.newValery; delete en.motivo; }
          if (k === 'result' && val !== 'nofact') delete en.nf;
          if (k === 'result' && val === 'nofact') { delete en.ret; delete en.newValery; }
          if (k === 'result' && val === 'anulada') delete en.newValery;
          if (k === 'result' && (val === 'pendiente' || val === 'anulada')) delete en.ret;
          q.orders[oid] = en;
        }, k === 'newValery' ? null : `tr[data-oid="${oid}"] [data-q="${k === 'result' ? (val === 'parcial' ? 'newValery' : 'result') : k}"]`);
        if (k === 'result' && val === 'parcial') returnsDialog(orderById(oid), saveLiq);
        if (k === 'result' && val === 'nofact') notBilledDialog(orderById(oid), saveLiq);
        return;
      }
      if (t.dataset.v && tr && tr.dataset.pid) {
        const oid = tr.dataset.oid, pid = tr.dataset.pid, raw = t.value.trim();
        await saveLiq((q) => {
          const en = { result: 'entregada', ...(q.orders[oid] || {}) };
          en.vac = { ...(en.vac || {}) }; en.vac[pid] = { ...(en.vac[pid] || {}) };
          if (raw === '') delete en.vac[pid][t.dataset.v]; else en.vac[pid][t.dataset.v] = t.dataset.v === 'motivo' ? raw : int(raw);
          q.orders[oid] = en;
        });
        return;
      }
      if (t.dataset.t && tr && tr.dataset.key) {
        const key = tr.dataset.key, f = t.dataset.t, raw = t.value.trim();
        await saveLiq((q) => {
          const x = { ...(q.truck[key] || {}) };
          if (f === 'queda' || f === 'carga' || f === 'dev') { if (raw === '') delete x[f]; else x[f] = int(raw); }
          else if (f === 'dest') { if (raw.startsWith('L:')) { x.dest = 'siguiente'; x.destLoad = raw.slice(2); } else { x.dest = raw; delete x.destLoad; } }
          else x[f] = raw;
          q.truck[key] = x;
        }, f === 'motivo' ? null : `tr[data-key="${key}"] [data-t="${f}"]`);
      }
    };
  }

  /**
   * Vacíos de entregas anteriores: un cliente de ESTA hoja devolvió vacíos que debía de
   * pedidos viejos y los trajo este despachador. Solo avisa si devuelve más de lo que debe.
   */
  function prevVacDialog(load, saveLiq) {
    const os = Loads.loadOrders(load, byIdMap(S.orders));
    const liq = load.liq || blankLiq();
    const kid = (o) => String(o.clientId || o.clientKey || o.clientName || '');
    const clients = []; // un renglón por cliente (su primer pedido de la hoja)
    os.forEach((o) => { if (!clients.some((c) => c.kid === kid(o))) clients.push({ kid: kid(o), order: o }); });
    if (!clients.length) { toast('La hoja no tiene clientes', 'err'); return; }
    const types = [...new Set(vacTypes().concat(Liq.vacRows(os, liq, byIdMap(S.products)).map((v) => v.type)))];
    if (!types.length) { toast('No hay productos retornables en el catálogo', 'err'); return; }
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const sh = openSheet(`
      <div class="row"><h2 class="grow">↩ Vacíos de entregas anteriores</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Solo clientes de esta hoja. Se registran en el kardex del cliente con este despachador y su vendedor al cerrar la liquidación.</p>
      <label class="field"><span>Cliente</span><select class="select" id="pvCl">${opt(clients.map((c) => [c.order.id, c.order.clientName]), clients[0].order.id)}</select></label>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="field"><span>Tipo de envase</span><select class="select" id="pvType">${opt(types.map((t) => [t, t]), types[0])}</select></label>
        <label class="field"><span>Vacíos que devolvió</span><input class="input" id="pvQty" inputmode="numeric" placeholder="0"></label>
        <label class="field"><span>Son de</span><select class="select" id="pvFrom">${opt([['devolucion', 'Lo que debía'], ['dev_asignado', 'Sus asignados']], 'devolucion')}</select></label></div>
      <p id="pvBal" class="muted"></p>
      <label class="field"><span>Nota (opcional)</span><input class="input" id="pvNote" maxlength="120" placeholder="Ej.: vacíos de la nota 1234"></label>
      <div class="actions"><button class="btn btn-primary" id="pvOk">Guardar</button></div>`);
    const k = kxState();
    const val = (id) => $(id, sh.el).value;
    const keyOf = () => val('#pvType') + '|' + val('#pvFrom');
    const balOf = () => {
      if (!k.movs) return null;
      const o = orderById(val('#pvCl')); if (!o) return null;
      return Kardex.balances(k.movs).find((b) => b.clientId === kid(o) && b.type === val('#pvType')) || { debe: 0, asignados: 0 };
    };
    const show = () => {
      const o = orderById(val('#pvCl')), cur = (Liq.entry(liq, val('#pvCl')).prev || {})[keyOf()];
      $('#pvQty', sh.el).value = cur ? cur.qty : ''; $('#pvNote', sh.el).value = cur ? cur.motivo || '' : '';
      const b = balOf();
      $('#pvBal', sh.el).innerHTML = b ? `Según el kardex, <b>${esc(o ? o.clientName : '')}</b> debe <b>${nf0.format(b.debe)}</b> vacíos ${esc(val('#pvType'))} y tiene <b>${nf0.format(b.asignados)}</b> asignados.`
        : (k.err ? `<span class="warn-txt">No se pudo leer el kardex (${esc(k.err)}): se guarda igual.</span>` : 'Leyendo el kardex…');
    };
    ['#pvCl', '#pvType', '#pvFrom'].forEach((id) => { $(id, sh.el).onchange = show; });
    show();
    if (!k.movs || Date.now() - k.at > 60000) {
      Sync.readerCall('envases', { action: 'list' }).then((r) => {
        if (r.ok) { k.movs = r.data.movs || []; k.at = Date.now(); k.canWrite = !!r.data.canWrite; k.err = ''; } else k.err = r.error || 'sin conexión';
        if (sh.el.isConnected) { const q = val('#pvQty'), n = val('#pvNote'); show(); if (q) { $('#pvQty', sh.el).value = q; $('#pvNote', sh.el).value = n; } }
      });
    }
    $('#pvOk', sh.el).onclick = async () => {
      const oid = val('#pvCl'), type = val('#pvType'), from = val('#pvFrom'), qty = int(val('#pvQty')), motivo = val('#pvNote').trim();
      if (qty < 0) { toast('Cantidad inválida', 'err'); return; }
      const b = balOf();
      if (b && qty > 0) {
        const tiene = from === 'dev_asignado' ? b.asignados : b.debe;
        if (qty > tiene && !confirm(`Ojo: según el kardex ${orderById(oid).clientName} ${from === 'dev_asignado' ? 'tiene' : 'debe'} ${tiene} vacíos ${type}${from === 'dev_asignado' ? ' asignados' : ''} y estás registrando ${qty}.\n\n¿Guardar de todos modos?`)) return;
      }
      sh.close();
      await saveLiq((q) => {
        const en = { result: 'entregada', ...(q.orders[oid] || {}) };
        en.prev = { ...(en.prev || {}) };
        if (qty > 0) en.prev[type + '|' + from] = { type, from, qty, motivo }; else delete en.prev[type + '|' + from];
        q.orders[oid] = en;
      });
      toast(qty > 0 ? `${qty} vacíos ${type} de entregas anteriores · ${orderById(oid).clientName}` : 'Quitado', 'ok');
    };
  }

  /**
   * Mercancía devuelta de entregas anteriores: un cliente de OTRA hoja devolvió productos
   * y los trajo este camión. Entran al cuadre (Total = Quedan + Carga + Dev. anteriores) y,
   * como cualquier sobrante, vuelven a almacén o siguen a la siguiente carga.
   */
  function prevRetDialog(load, saveLiq) {
    let pick = null, orders = [];
    const sh = openSheet(`
      <div class="row"><h2 class="grow">↩ Mercancía devuelta de entregas anteriores</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Un cliente de otra hoja devolvió productos y los trajo el camión de <b>${esc(load.dispatcherName || 'esta hoja')}</b>.</p>
      <label class="field"><span>Cliente</span><input class="input" id="prQ" placeholder="Buscar cliente…" autocomplete="off"></label><div class="suggest" id="prSug"></div>
      <p id="prCl" class="muted">Ningún cliente elegido</p>
      <label class="field"><span>Viene de (entrega anterior)</span><select class="select" id="prOrd"><option value="">— Elige el cliente —</option></select></label>
      <label class="field"><span>Producto</span><select class="select" id="prProd"></select></label>
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="field"><span>UM</span><select class="select" id="prUm"><option value="CJ">Cajas</option><option value="UN">Unidades</option></select></label>
        <label class="field"><span>Cantidad devuelta</span><input class="input" id="prQty" inputmode="numeric" placeholder="0"></label>
        <label class="field"><span>Nota Valery (anulada / nueva)</span><input class="input mono" id="prNota" maxlength="20" placeholder="N°"></label></div>
      <label class="field"><span>Motivo</span><select class="select" id="prMot"><option value="">— Motivo —</option>${Liq.MOTIVOS.map((m) => `<option>${esc(m)}</option>`).join('')}</select></label>
      <div class="actions"><button class="btn btn-primary" id="prOk">Agregar</button></div>`);
    const prodSel = $('#prProd', sh.el), ordSel = $('#prOrd', sh.el);
    const fillProducts = () => {
      const o = orders.find((x) => x.id === ordSel.value);
      const lines = o ? Object.entries((o.delivery && o.delivery.lines) || o.lines || {}) : [];
      const list = lines.length ? lines.map(([pid, l]) => [pid, `${l.code} ${l.name} ${l.presentation || ''} · entregó ${l.cajas ? l.cajas + ' cj' : ''}${l.cajas && l.unidades ? ' + ' : ''}${l.unidades ? l.unidades + ' un' : ''}`])
        : S.products.filter((p) => !p.deleted).sort(PV.productSort()).map((p) => [p.id, `${p.code} ${p.name} ${p.presentation || ''}`]);
      prodSel.innerHTML = '<option value="">— Producto —</option>' + list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join('');
    };
    fillProducts();
    ordSel.onchange = fillProducts;
    const qIn = $('#prQ', sh.el);
    qIn.oninput = () => {
      const t = norm(qIn.value).split(' ').filter(Boolean);
      const hits = t.length ? S.clients.filter((c) => !c.deleted && t.every((x) => norm(c.name + ' ' + (c.rif || '')).includes(x))).slice(0, 12) : [];
      $('#prSug', sh.el).innerHTML = hits.map((c) => `<button type="button" class="sug-item" data-cid="${esc(c.id)}"><b>${esc(c.name)}</b><span class="muted">${esc((sellerById(c.sellerId) || {}).name || '')}</span></button>`).join('');
    };
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cid]'); if (!b) return;
      const c = clientById(b.dataset.cid); if (!c) return;
      pick = c; qIn.value = ''; $('#prSug', sh.el).innerHTML = '';
      $('#prCl', sh.el).innerHTML = `Cliente: <b>${esc(c.name)}</b>`;
      // Sus entregas de hojas ya liquidadas (las más recientes primero)
      orders = S.orders.filter((o) => !o.deleted && o.clientId === c.id && o.delivery && o.delivery.at && o.loadId !== load.id)
        .sort((a, b) => String(b.delivery.at).localeCompare(String(a.delivery.at))).slice(0, 30);
      ordSel.innerHTML = '<option value="">— No sé / otra —</option>' + orders.map((o) => { const l = S.loads.find((x) => x.id === o.loadId);
        return `<option value="${esc(o.id)}">${esc((l ? Loads.labelOf(l) + (l.number ? ' ' + Loads.loadCode(l) : '') : 'Sin hoja') + ' · ' + (o.delivery.date || o.routeDate || '') + ' · nota ' + (o.delivery.newValery || o.valeryNote || '—'))}</option>`; }).join('');
      if (orders.length) ordSel.value = orders[0].id;
      fillProducts();
    });
    $('#prOk', sh.el).onclick = async () => {
      const pid = prodSel.value, qty = int($('#prQty', sh.el).value), um = $('#prUm', sh.el).value, motivo = $('#prMot', sh.el).value;
      if (!pick) { toast('Elige el cliente', 'err'); return; }
      if (!pid) { toast('Elige el producto', 'err'); return; }
      if (qty <= 0) { toast('Escribe la cantidad', 'err'); return; }
      if (!motivo) { toast('Elige el motivo', 'err'); return; }
      const o = orders.find((x) => x.id === ordSel.value) || null, l = o ? S.loads.find((x) => x.id === o.loadId) : null;
      const line = o ? ((o.delivery && o.delivery.lines) || o.lines || {})[pid] : null;
      const got = line ? (um === 'CJ' ? +line.cajas || 0 : +line.unidades || 0) : null;
      if (got !== null && qty > got && !confirm(`Ojo: en esa entrega llevó ${got} ${um === 'CJ' ? 'cajas' : 'unidades'} y estás registrando ${qty} devueltas.\n\n¿Agregar de todos modos?`)) return;
      const p = productById(pid) || {};
      sh.close();
      await saveLiq((q) => {
        q.prevRet = { ...(q.prevRet || {}) };
        q.prevRet[DB.uid('pr')] = { clientId: pick.id, clientName: pick.name, orderId: o ? o.id : '', loadId: o ? o.loadId || '' : '', label: l ? Loads.labelOf(l) + (l.number ? ' ' + Loads.loadCode(l) : '') : '',
          pid, code: p.code || (line && line.code) || '', name: p.name || (line && line.name) || '', um, qty, nota: $('#prNota', sh.el).value.replace(/\s+/g, '').toUpperCase(), motivo, at: DB.now() };
      });
      toast(`${qty} ${um} de ${p.name || pid} · ${pick.name}`, 'ok');
    };
  }

  /**
   * No se facturó todo (misma nota Valery): por producto, lo que SÍ salió en la nota y
   * por qué no salió lo demás — «no había» (nunca salió del almacén: no cuenta como carga)
   * o «va en el camión» (se cargó pero no se facturó: vuelve como sobrante).
   * El pedido original no se toca (queda en el historial).
   */
  function notBilledDialog(o, saveLiq) {
    if (!o) return;
    const l0 = (S.loads.find((l) => l.id === o.loadId) || {}).liq || {};
    const e = Liq.entry(l0, o.id);
    const lines = Object.entries(o.lines || {}).filter(([, l]) => (+l.cajas || 0) || (+l.unidades || 0));
    const whySel = (pid, cur) => `<select class="select sm nf-why" data-pid="${esc(pid)}"><option value="nohabia" ${cur !== 'camion' ? 'selected' : ''}>No había · no salió del almacén</option><option value="camion" ${cur === 'camion' ? 'selected' : ''}>Error de facturación · va en el camión</option></select>`;
    const sh = openSheet(`
      <div class="row"><h2 class="grow">⊘ No se facturó todo · ${esc(o.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Misma nota Valery <b>${esc(o.valeryNote || '—')}</b>. Escribe lo que <b>sí salió en la nota</b>; lo demás no se le entrega al cliente.</p>
      <table class="lines">${lines.map(([pid, l]) => { const r = (e.nf || {})[pid] || {}; return `<tr><td><b>${esc(l.name)} ${esc(l.presentation || '')}</b><div class="muted mono" style="font-size:12px">${esc(l.code)} · pedido ${l.cajas ? l.cajas + ' cj' : ''}${l.cajas && l.unidades ? ' + ' : ''}${l.unidades ? l.unidades + ' un' : ''}</div></td>
        <td style="white-space:nowrap">${l.cajas ? `<label class="mini">CJ <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-k="cajas" data-max="${l.cajas}" value="${l.cajas - (+r.cajas || 0)}"></label>` : ''}
          ${l.unidades ? `<label class="mini">UN <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-k="unidades" data-max="${l.unidades}" value="${l.unidades - (+r.unidades || 0)}"></label>` : ''}
          <div style="margin-top:4px">${whySel(pid, r.why)}</div></td></tr>`; }).join('')}</table>
      <div class="actions"><button class="btn btn-primary" id="nfOk">Guardar</button></div>`, { wide: true });
    $('#nfOk', sh.el).onclick = async () => {
      const nf = {}, why = {};
      sh.el.querySelectorAll('.nf-why').forEach((s2) => { why[s2.dataset.pid] = s2.value; });
      sh.el.querySelectorAll('.mini-in').forEach((i) => {
        const max = +i.dataset.max || 0, salio = Math.min(max, Math.max(0, int(i.value))), falta = max - salio;
        if (falta) { nf[i.dataset.pid] = nf[i.dataset.pid] || { why: why[i.dataset.pid] || 'nohabia' }; nf[i.dataset.pid][i.dataset.k] = falta; }
      });
      sh.close();
      const anyHabia = Object.values(nf).some((x) => x.why === 'nohabia');
      await saveLiq((q) => { const en = { ...(q.orders[o.id] || {}), result: 'nofact', nf }; delete en.ret; delete en.newValery;
        if (!en.motivo) en.motivo = anyHabia ? 'NO HABÍA (NO SALIÓ DEL ALMACÉN)' : 'ERROR FACTURACIÓN'; q.orders[o.id] = en; });
    };
  }

  /** Qué devolvió el cliente (devolución parcial): cajas y unidades por producto. */
  function returnsDialog(o, saveLiq) {
    if (!o) return;
    const l0 = (S.loads.find((l) => l.id === o.loadId) || {}).liq || {};
    const e = Liq.entry(l0, o.id);
    const lines = Object.entries(o.lines || {}).filter(([, l]) => (+l.cajas || 0) || (+l.unidades || 0));
    const sh = openSheet(`
      <div class="row"><h2 class="grow">↩ Devolución · ${esc(o.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Escribe solo lo que el cliente devolvió. Lo demás cuenta como entregado.</p>
      <table class="lines">${lines.map(([pid, l]) => { const r = (e.ret || {})[pid] || {}; return `<tr><td><b>${esc(l.name)} ${esc(l.presentation || '')}</b><div class="muted mono" style="font-size:12px">${esc(l.code)} · pidió ${l.cajas ? l.cajas + ' cj' : ''}${l.cajas && l.unidades ? ' + ' : ''}${l.unidades ? l.unidades + ' un' : ''}</div></td>
        <td style="white-space:nowrap">${l.cajas ? `<label class="mini">CJ <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-k="cajas" data-max="${l.cajas}" value="${r.cajas || ''}"></label>` : ''}
          ${l.unidades ? `<label class="mini">UN <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-k="unidades" data-max="${l.unidades}" value="${r.unidades || ''}"></label>` : ''}</td></tr>`; }).join('')}</table>
      <div class="actions"><button class="btn btn-primary" id="rtOk">Guardar devolución</button></div>`, { wide: true });
    $('#rtOk', sh.el).onclick = async () => {
      const ret = {};
      sh.el.querySelectorAll('.mini-in').forEach((i) => {
        const v = Math.min(+i.dataset.max || 0, Math.max(0, int(i.value)));
        if (v) { ret[i.dataset.pid] = ret[i.dataset.pid] || {}; ret[i.dataset.pid][i.dataset.k] = v; }
      });
      sh.close();
      await saveLiq((q) => { q.orders[o.id] = { result: 'parcial', ...(q.orders[o.id] || {}), ret }; });
    };
  }

  /** Cierra la liquidación: guarda lo entregado en cada pedido, reprograma pendientes y deja la carga del camión. */
  async function closeLiquidation(load, root) {
    const { os, liq, carry, rows, vac, probs } = liqState(load);
    if (probs.length) { toast('Revisa la lista «Antes de cerrar» al final de la pantalla', 'err'); return; }
    const pend = os.filter((o) => Liq.entry(liq, o.id).result === 'pendiente');
    const nextRows = rows.filter((r) => r.dest === 'siguiente' && r.dev > 0);
    const older = Liq.olderUnliquidated(load, S.loads, Loads.isClosed);
    if (older.length && !confirm(`⚠ ${load.dispatcherName || 'El despachador'} tiene ${older.length} hoja(s) ANTERIOR(es) sin liquidar: ${older.map((l) => Loads.labelOf(l)).join(', ')}.\n\nLo que sobró en ellas no pasará a esta hoja. ¿Cerrar esta de todos modos?`)) return;
    if (!confirm(`Cerrar la liquidación de ${Loads.labelOf(load)}:\n\n• ${os.length} clientes · entregado ${usd(os.reduce((a, o) => a + Matrix.orderTotals(Liq.delivered(o, liq)).monto, 0))}${pend.length ? `\n• ${pend.length} pedido(s) vuelven a la cola para la próxima hoja` : ''}${nextRows.length ? `\n• ${nextRows.length} producto(s) quedan en el camión para la siguiente carga de ${load.dispatcherName}` : ''}\n\n¿Continuar?`)) return;
    const at = DB.now(), by = (S.config && S.config.adminName) || 'Oficina';
    const vacBy = {};
    vac.forEach((v) => { (vacBy[v.orderId] = vacBy[v.orderId] || {})[v.pid] = { code: v.code, type: v.type, regime: v.regime, boxes: v.boxes, recv: v.recv, asg: v.asg, pending: v.pending, motivo: v.motivo || (v.pending && v.regime === 'prestamo' ? 'PRÉSTAMO' : '') }; });
    const updOrders = [], clones = [];
    os.forEach((o) => {
      const e = Liq.entry(liq, o.id), lines = Liq.deliveredLines(o, e);
      updOrders.push({ ...o, delivery: {
        loadId: load.id, result: e.result, lines, monto: Matrix.orderTotals({ lines }).monto, motivo: e.motivo || '',
        voidedNote: e.result === 'parcial' || e.result === 'anulada' ? (o.valeryNote || '') : '',
        newValery: e.result === 'parcial' ? String(e.newValery || '').trim() : '',
        vac: vacBy[o.id] || {}, prevVac: Liq.prevRows([o], liq).map((p) => ({ type: p.type, from: p.from, qty: p.qty, motivo: p.motivo })),
        date: load.date || at.slice(0, 10), at, by,
        dispatcherId: load.dispatcherId || '', dispatcherName: load.dispatcherName || '',
      } });
      if (e.result === 'pendiente') {
        const id = 'o_pend_' + o.id;
        const prev = S.orders.find((x) => x.id === id);
        if (prev && !prev.deleted) return; // ya se reprogramó (liquidación reabierta y cerrada de nuevo)
        const c = { ...o, id, status: 'enviado', loadId: null, locked: false, loadStatusName: '', sentAt: at, createdAt: at, routeDate: today(),
          pendingFrom: o.id, deleted: false, notes: [o.notes, `Pendiente de ${Loads.labelOf(load)}`].filter(Boolean).join(' · ').slice(0, 300) };
        ['noteNumber', 'loadNumber', 'dispatchedAt', 'heldAt', 'delivery', 'fv', 'dupWith', 'sentLines', 'officeEdited', 'sellerEdited'].forEach((k) => delete c[k]);
        clones.push(c);
      }
    });
    const carryRows = Object.fromEntries(nextRows.map((r) => [r.key, r.dev]));
    const newLiq = { ...liq, status: 'cerrada', closedAt: at, closedBy: by, carryFrom: carry ? carry.fromIds : null,
      // Lo que ya tomó otra hoja sigue marcado como tomado (no se vuelve a pasar)
      carry: nextRows.length ? { dispatcherId: load.dispatcherId || '', rows: carryRows, to: Object.fromEntries(nextRows.filter((r) => r.destLoad).map((r) => [r.key, r.destLoad])),
        used: Object.fromEntries(Object.entries(Liq.lockedCarry(load)).filter(([k]) => carryRows[k]).map(([k, x]) => [k, x.by])) } : null, carryUsedBy: null,
      // Foto del camión al cierre (reportes de despachos y diferencias)
      snapshot: { rows: rows.map((r) => ({ key: r.key, code: r.code, name: r.name, presentation: r.presentation, um: r.um, pedido: r.pedido, entregado: r.entregado,
        traia: r.traia, queda: r.queda, carga: r.carga, anterior: r.anterior, noSalio: r.noSalio, total: r.total, debe: r.debe, dev: r.dev, dif: r.dif, motivo: r.motivo, dest: r.dest, destLoad: r.destLoad || '' })) },
      totals: { clients: updOrders.filter((o) => Matrix.orderTotals({ lines: o.delivery.lines }).items > 0).length, monto: updOrders.reduce((a, o) => a + o.delivery.monto, 0),
        v2: true, ...(() => { const t = { cajas: 0, unidades: 0, bultos: 0, totalUnidades: 0 }; updOrders.forEach((o) => { const x = Matrix.orderTotals({ lines: o.delivery.lines }); t.cajas += x.cajas; t.unidades += x.unidades; t.bultos += x.bultos; t.totalUnidades += x.totalUnidades; }); return t; })(),
        parcial: os.filter((o) => Liq.entry(liq, o.id).result === 'parcial').length, nofact: os.filter((o) => Liq.entry(liq, o.id).result === 'nofact').length, pendiente: pend.length,
        anulada: os.filter((o) => Liq.entry(liq, o.id).result === 'anulada').length } };
    await saveDocs('orders', updOrders.concat(clones));
    const loadsToSave = [{ ...load, liq: newLiq }];
    // TODO el sobrante pendiente del despachador queda tomado por esta hoja (nada se queda olvidado)
    if (carry) carry.sources.forEach((x) => { const src = S.loads.find((l) => l.id === x.id); if (src && src.liq) loadsToSave.push(Liq.markUsed(src, Object.keys(x.rows), load.id)); });
    await saveDocs('loads', loadsToSave);
    await log('liquidacion', `Liquidó ${Loads.labelOf(load)} (${load.dispatcherName || 'sin despachador'}) · ${os.length} clientes · ${usd(newLiq.totals.monto)}${newLiq.totals.parcial ? ` · ${newLiq.totals.parcial} devoluciones` : ''}${pend.length ? ` · ${pend.length} reprogramados` : ''}${newLiq.totals.anulada ? ` · ${newLiq.totals.anulada} anuladas` : ''}`, { loadId: load.id });
    if (U().kx) U().kx.at = 0; // el kardex se vuelve a leer al abrir Envases
    toast('Liquidación cerrada', 'ok');
    renderLiquidation(root, S.loads.find((l) => l.id === load.id) || load);
    PV.runSync(false);
  }

  /** Reabre una liquidación cerrada (con motivo). Quita lo entregado y los pedidos reprogramados que aún no salieron. */
  async function reopenLiquidation(load, root) {
    const os = Loads.loadOrders(load, byIdMap(S.orders));
    const clones = S.orders.filter((o) => !o.deleted && o.pendingFrom && os.some((x) => x.id === o.pendingFrom));
    const stuck = clones.filter((c) => !Loads.editable(c));
    if (stuck.length) { toast(`No se puede reabrir: ${stuck.map((c) => c.clientName).join(', ')} ya salió en otra hoja aprobada`, 'err'); return; }
    // Lo que sobró aquí ya lo tomó otra hoja liquidada (o se descargó en almacén): reabrir lo descuadraría
    // Lo que sobró y ya tomó otra hoja (o se descargó en un corte) queda FIJO: se puede corregir todo lo demás
    const lk = Liq.lockedCarry(load);
    const lkTxt = Object.entries(lk).map(([k, x]) => { const [pid, um] = k.split('|'), u = S.loads.find((l) => l.id === x.by); return `• ${x.qty} ${(productById(pid) || {}).name || pid} ${um} → ${x.by === 'almacen' ? 'corte (almacén)' : u ? Loads.labelOf(u) : 'otra hoja'}`; });
    if (lkTxt.length && !confirm(`Parte de lo que sobró en esta hoja ya lo tomó otra:\n\n${lkTxt.join('\n')}\n\nEso queda FIJO (🔒). Puedes corregir todo lo demás y agregar vacíos o mercancía de entregas anteriores.\n\n¿Reabrir?`)) return;
    const motivo = (prompt('Motivo para reabrir la liquidación:') || '').trim();
    if (!motivo) return;
    await saveDocs('orders', os.filter((o) => o.delivery).map((o) => ({ ...o, delivery: null }))
      .concat(clones.map((c) => ({ ...c, deleted: true, deletedBy: 'oficina', deletedAt: DB.now() }))));
    const loadsToSave = [{ ...load, liq: { ...load.liq, status: 'borrador', closedAt: null, reopenedAt: DB.now(), reopenReason: motivo } }];
    // El sobrante que tomó vuelve a quedar pendiente en sus hojas de origen
    const from = load.liq ? (Array.isArray(load.liq.carryFrom) ? load.liq.carryFrom : load.liq.carryFrom ? [load.liq.carryFrom] : []) : [];
    from.forEach((id) => {
      const src = S.loads.find((l) => l.id === id); if (!src || !src.liq || !src.liq.carry) return;
      const mine = Object.keys(src.liq.carry.rows || {}).filter((k) => (src.liq.carryUsedBy || (src.liq.carry.used || {})[k]) === load.id);
      if (mine.length) loadsToSave.push(Liq.markUsed(src, mine, null));
    });
    await saveDocs('loads', loadsToSave);
    await log('liquidacion', `Reabrió la liquidación de ${Loads.labelOf(load)} · motivo: ${motivo}`, { loadId: load.id });
    if (U().kx) U().kx.at = 0;
    toast('Liquidación reabierta', 'ok');
    renderLiquidation(root, S.loads.find((l) => l.id === load.id) || load);
  }

  // Al cambiar de pestaña se sale de cualquier detalle abierto
  window.addEventListener('hashchange', () => { U().archiveId = null; U().loadId = null; U().liqId = null; U().editQty = false; U().kxClient = null; });

  /* ====================== Diagnóstico de sincronización ====================== */
  const DG_LABEL = { orders: 'Pedidos', clients: 'Clientes', loads: 'Hojas de carga', products: 'Productos', sellers: 'Vendedores', config: 'Configuración' };
  const dgName = (k, id) => {
    const d = k === 'orders' ? orderById(id) : k === 'clients' ? clientById(id) : k === 'loads' ? S.loads.find((l) => l.id === id) : k === 'products' ? productById(id) : k === 'sellers' ? sellerById(id) : null;
    if (!d) return id;
    return k === 'orders' ? `${d.clientName || ''} · ${d.routeDate || ''}` : k === 'loads' ? Loads.labelOf(d) : (d.name || id);
  };
  // El estado vive en U().dg: la pantalla de Ajustes se redibuja al sincronizar
  const dgEl = () => document.getElementById('dgOut');
  async function runDiagnosis(upload) {
    const el0 = dgEl(); if (el0) el0.innerHTML = '<p class="muted">Revisando…</p>';
    await PV.runSync(true).catch(() => {});
    const d = await Sync.diagnose();
    if (upload) d.upload = upload;
    U().dg = d;
    drawDiagnosis();
  }
  function drawDiagnosis() {
    const out = dgEl(), d = U().dg; if (!out || !d) return;
    if (!d.ok) { out.innerHTML = `<div class="hint warn">✗ ${esc(d.error)}</div>`; return; }
    const last = (PV.syncInfo() || {}).last || {};
    const ks = Object.keys(d.kinds), sum = (f) => ks.reduce((a, k) => a + d.kinds[k][f].length, 0);
    const up = sum('up'), down = sum('down');
    const notes = [];
    if (!d.keys.admin) notes.push(d.keys.supervisor ? 'Esta PC es de supervisor: puede ver, pero no sube nada.' : '⚠ Falta la clave admin: lo que hace esta PC no se sube al servidor.');
    if (d.url !== Sync.DEFAULT_SYNC_URL) notes.push(`⚠ Esta PC usa otro servidor: ${d.url}`);
    if (d.epochLocal !== d.epochServer) notes.push('⚠ Los datos del servidor se reiniciaron y esta PC aún no se puso al día: sincroniza.');
    if (last && last.ok === false && last.error) notes.push('⚠ La última sincronización falló: ' + last.error);
    if (!up && !down) notes.push('✅ Esta PC y el servidor tienen exactamente lo mismo.');
    const u = d.upload;
    const report = () => [
      `DIAGNÓSTICO ${new Date().toLocaleString('es-VE')} · ${location.host}`,
      `Claves: sync ${d.keys.sync ? 'sí' : 'NO'} · admin ${d.keys.admin ? 'sí' : 'NO'} · supervisor ${d.keys.supervisor ? 'sí' : 'no'} · servidor ${d.url}`,
      `Época local ${d.epochLocal || '—'} · servidor ${d.epochServer || '—'} · último sync ${d.lastSyncAt || '—'} · último resultado ${last.ok === false ? 'ERROR ' + (last.error || '') : 'ok'}`,
      ...ks.map((k) => { const x = d.kinds[k]; return `${DG_LABEL[k]}: PC ${x.local} · servidor ${x.server} · pendientes ${x.pending} · faltan en servidor ${x.up.length}${x.up.length ? ' [' + x.up.slice(0, 8).map((id) => dgName(k, id)).join(' | ') + ']' : ''} · faltan en PC ${x.down.length}`; }),
      ...(u ? [`Subida: ${u.accepted}/${u.total} aceptados · rechazados ${u.rejected.length}${u.rejected.length ? ' [' + u.rejected.slice(0, 10).map((r) => r.kind + ' ' + dgName(r.kind, r.id) + ': ' + r.reason).join(' | ') + ']' : ''} · fallidos ${u.failed.length}${u.failed.length ? ' [' + u.failed.slice(0, 10).map((f) => f.kind + ' ' + dgName(f.kind, f.id) + ': ' + f.error).join(' | ') + ']' : ''}${u.error ? ' · ' + u.error : ''}`] : []),
    ].join('\n');
    const bad = u ? u.rejected.filter((r) => r.reason !== 'stale') : [];
    out.innerHTML = `${notes.map((n) => `<div class="hint ${n.startsWith('✅') ? '' : 'warn'}">${esc(n)}</div>`).join('')}
      ${u ? `<div class="hint ${u.failed.length || bad.length || !u.ok ? 'warn' : ''}">Subida: <b>${u.accepted} de ${u.total}</b> aceptados${u.rejected.length - bad.length ? ` · ${u.rejected.length - bad.length} con otra versión en el servidor (se fusionan al sincronizar)` : ''}${bad.length ? ` · <b>${bad.length} rechazados</b>: ${esc(bad.slice(0, 5).map((r) => dgName(r.kind, r.id) + ' (' + r.reason + ')').join('; '))}` : ''}${u.failed.length ? ` · <b>${u.failed.length} no se pudieron subir</b>: ${esc(u.failed.slice(0, 5).map((f) => dgName(f.kind, f.id) + ' (' + f.error + ')').join('; '))}` : ''}${u.error ? ' · ' + esc(u.error) : ''}</div>` : ''}
      <div style="overflow:auto"><table class="inv"><thead><tr><th>Tipo</th><th class="n">En esta PC</th><th class="n">En el servidor</th><th class="n">Pendientes de subir</th><th class="n">Faltan en el servidor</th><th class="n">Faltan en esta PC</th></tr></thead>
      <tbody>${ks.map((k) => { const x = d.kinds[k]; return `<tr><td>${esc(DG_LABEL[k])}</td><td class="n">${nf0.format(x.local)}</td><td class="n">${nf0.format(x.server)}</td><td class="n">${x.pending || ''}</td>
        <td class="n ${x.up.length ? 'warn-txt' : ''}" title="${esc(x.up.slice(0, 15).map((id) => dgName(k, id)).join('\n'))}"><b>${x.up.length || ''}</b></td><td class="n ${x.down.length ? 'warn-txt' : ''}"><b>${x.down.length || ''}</b></td></tr>`; }).join('')}</tbody></table></div>
      <div class="row wrap" style="margin-top:8px;gap:8px">
        ${up && d.keys.admin ? `<button class="btn btn-primary" id="dgUp">⬆ Subir al servidor lo que falta (${nf0.format(up)})</button>` : ''}
        ${down ? `<button class="btn" id="dgDown">⬇ Bajar a esta PC lo que falta (${nf0.format(down)})</button>` : ''}
        <button class="btn" id="dgCopy">📋 Copiar informe</button></div>`;
    $('#dgCopy', out).onclick = () => copyText(report());
    const bu = $('#dgUp', out);
    if (bu) bu.onclick = async () => {
      bu.disabled = true;
      const res = await Sync.forceUpload(Object.fromEntries(ks.map((k) => [k, d.kinds[k].up])), (n, t) => { const b = dgEl() && $('#dgUp', dgEl()); if (b) b.textContent = `Subiendo… ${n} de ${t}`; });
      await log('sync', `Diagnóstico: subió ${res.accepted} de ${res.total} documentos${res.failed.length ? ` · ${res.failed.length} con error` : ''}`).catch(() => {});
      await runDiagnosis(res);
    };
    const bd = $('#dgDown', out);
    if (bd) bd.onclick = async () => {
      bd.disabled = true; bd.textContent = 'Bajando…';
      await Sync.redownload();
      await runDiagnosis();
    };
  }

  /* ============================== ENVASES ============================== */
  // Fase 2 · E4: kardex de vacíos. Vive en el servidor (no se edita ni se borra):
  // esta pantalla necesita internet. Los despachos los escribe la liquidación.
  const vacTypes = () => [...new Set(S.products.map((p) => (Envases.info(p) || {}).type).filter(Boolean))]
    .sort((a, b) => parseFloat(String(a).replace(',', '.')) - parseFloat(String(b).replace(',', '.')) || String(a).localeCompare(String(b)));
  const kxState = () => U().kx || (U().kx = { movs: null, loading: false, err: '', at: 0, canWrite: false });

  async function kxLoad(root, force) {
    const k = kxState();
    if (k.loading || (!force && k.movs && Date.now() - k.at < 60000)) return;
    k.loading = true; k.err = '';
    const r = await Sync.readerCall('envases', { action: 'list' });
    k.loading = false;
    if (r.ok) { k.movs = r.data.movs || []; k.at = Date.now(); k.canWrite = !!r.data.canWrite; } else k.err = r.error || 'No se pudo leer el kardex';
    if (root.isConnected) renderEnvases(root);
  }

  function renderEnvases(root) {
    const k = kxState();
    if (!k.movs) {
      root.innerHTML = `<div class="empty card"><strong>♻ Kardex de vacíos</strong>${k.err ? `<span class="warn-txt">${esc(k.err)}</span><br>El kardex vive en el servidor: se necesita internet.` : 'Cargando…'}
        ${k.err ? '<div class="row" style="justify-content:center;margin-top:10px"><button class="btn" id="kxRetry">⟳ Reintentar</button></div>' : ''}</div>`;
      const b = $('#kxRetry'); if (b) b.onclick = () => kxLoad(root, true);
      if (!k.loading && !k.err) kxLoad(root, true);
      return;
    }
    kxLoad(root, false);
    if (U().kxClient) return renderKxClient(root, U().kxClient);
    const types = [...new Set(vacTypes().concat(Kardex.balances(k.movs).map((b) => b.type)))];
    const tot = Kardex.totalsByType(k.movs);
    const q = norm(U().kxQ || ''), only = U().kxOnly !== '0';
    const list = Kardex.byClient(k.movs).filter((c) => (!q || norm(c.clientName + ' ' + (c.sellerName || '')).includes(q)) && (!only || c.debe || c.asignados))
      .sort((a, b) => b.debe - a.debe || b.asignados - a.asignados || a.clientName.localeCompare(b.clientName, 'es'));
    const cell = (c, t) => { const b = c.types[t]; if (!b || (!b.debe && !b.asignados)) return '<td class="n zero">·</td>'; return `<td class="n"><b class="${b.debe > 0 ? 'warn-txt' : ''}">${nf0.format(b.debe)}</b>${b.asignados ? `<div class="muted" title="Asignados">+${nf0.format(b.asignados)} asig.</div>` : ''}</td>`; };
    root.innerHTML = `
      <div class="toolbar">
        <div class="grow"><h2 style="margin:0">♻ Kardex de vacíos</h2><div class="muted">Debe = despachados − recibidos − asignados − devoluciones · se actualiza solo al cerrar cada liquidación</div></div>
        <button class="btn" id="kxRef">⟳ Actualizar</button>
        ${k.canWrite ? '<button class="btn" id="kxOpen">+ Saldo de apertura</button>' : ''}
        <button class="btn" id="kxPrint">🖨 Imprimir saldos</button>
        <button class="btn" id="kxCsv">⇩ Excel</button>
      </div>
      <div class="kpi-row">${tot.length ? tot.map((t) => `<div class="kpi"><small>Vacíos ${esc(t.type)} · deben</small><b>${nf0.format(t.debe)}</b><small>${t.clientes} clientes · ${nf0.format(t.asignados)} asignados · despachados ${nf0.format(t.despacho)}</small></div>`).join('')
        : '<div class="kpi"><small>Vacíos</small><b>0</b><small>Aún no hay liquidaciones cerradas con retornables</small></div>'}</div>
      <div class="toolbar">
        <label class="field grow"><span>Buscar cliente o vendedor</span><input class="input" id="kxQ" value="${esc(U().kxQ || '')}" placeholder="Nombre…"></label>
        <label class="row"><input type="checkbox" id="kxOnly" ${only ? 'checked' : ''} style="width:22px;height:22px"> Solo con saldo</label>
      </div>
      <div class="card" style="overflow:auto"><table class="inv kx-list">
        <thead><tr><th>Cliente</th><th>Vendedor</th>${types.map((t) => `<th class="n">${esc(t)}</th>`).join('')}<th>Último mov.</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr><td><b>${esc(c.clientName)}</b></td><td>${esc(c.sellerName || '—')}</td>${types.map((t) => cell(c, t)).join('')}
          <td>${esc(fmtDate(c.last))}</td><td><button class="btn btn-sm" data-kc="${esc(c.clientId)}">Ver kardex</button></td></tr>`).join('')
          || `<tr><td colspan="${types.length + 4}" class="muted">Sin clientes${only ? ' con saldo' : ''}.</td></tr>`}</tbody></table></div>
      <p class="muted">Los números grandes son lo que el cliente <b>debe</b>; debajo, los vacíos que tiene <b>asignados</b>. Un error se corrige con una anulación o reabriendo la liquidación: nada se borra.</p>`;
    $('#kxRef').onclick = () => kxLoad(root, true);
    const op = $('#kxOpen'); if (op) op.onclick = () => kxDialog(root, 'apertura', null);
    $('#kxQ').oninput = (e) => { U().kxQ = e.target.value; clearTimeout(U().kxT); U().kxT = setTimeout(() => { renderEnvases(root); const i = $('#kxQ'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }, 250); };
    $('#kxOnly').onchange = (e) => { U().kxOnly = e.target.checked ? '1' : '0'; renderEnvases(root); };
    $('#kxPrint').onclick = () => Print.printKardex(list, types, { config: S.config });
    $('#kxCsv').onclick = () => {
      const bal = Kardex.balances(k.movs).sort((a, b) => a.clientName.localeCompare(b.clientName, 'es') || String(a.type).localeCompare(String(b.type)));
      // DEBE = apertura + despachados − recibidos − asignados − devoluciones (fórmula: al editar una cifra se recalcula)
      const saldos = Exporta.table({ name: 'Saldos', title: 'KARDEX DE VACÍOS · SALDOS', subtitle: `Al ${fmtDate(today())} · DEBE = apertura + despachados − recibidos − asignados − devoluciones`,
        cols: [{ h: 'CLIENTE', w: 36 }, { h: 'VENDEDOR', w: 18 }, { h: 'TIPO', w: 8, align: 'center' }, { h: 'APERTURA', k: 'int', total: true, blank0: true }, { h: 'DESPACHADOS', k: 'int', total: true, blank0: true }, { h: 'RECIBIDOS', k: 'int', total: true, blank0: true },
          { h: 'ASIGNADOS', k: 'int', total: true, blank0: true }, { h: 'DEVOLUCIONES', k: 'int', total: true, blank0: true }, { h: 'DEBE', k: 'int', total: true }, { h: 'ASIGNADOS (EN SU PODER)', k: 'int', total: true, w: 16 }, { h: 'ÚLTIMO MOV.', k: 'date', w: 12 }],
        rows: bal.map((b, i) => { const xr = 5 + i; return [b.clientName, b.sellerName, b.type, b.apertura, b.despacho, b.recibido, b.asignado, b.devolucion, { v: b.debe, f: `D${xr}+E${xr}-F${xr}-G${xr}-H${xr}` }, b.asignados, b.last]; }) });
      const movs = Exporta.table({ name: 'Movimientos', title: 'KARDEX DE VACÍOS · MOVIMIENTOS', subtitle: 'Cada renglón del kardex (los anulados y revertidos aparecen marcados)',
        cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'CLIENTE', w: 36 }, { h: 'VENDEDOR', w: 18 }, { h: 'MOVIMIENTO', w: 28 }, { h: 'TIPO', w: 8, align: 'center' }, { h: 'CÓDIGO', w: 10 }, { h: 'CANTIDAD', k: 'int' }, { h: 'ESTADO', w: 12 }, { h: 'MOTIVO', w: 30 }, { h: 'POR', w: 14 }],
        rows: (() => { const { cancelledBy } = Kardex.effective(k.movs); return k.movs.slice().sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.at || '').localeCompare(String(b.at || ''))).map((m) => [m.date, m.clientName, m.sellerName, Kardex.KIND_LABEL[m.kind] || m.kind, m.type, m.code, m.qty, cancelledBy.has(m.id) ? (cancelledBy.get(m.id).kind === 'reverso' ? 'revertido' : 'anulado') : '', m.motivo || '', m.by || '']); })() });
      Exporta.save('kardex_vacios_' + today() + '.xlsx', [saldos, movs]);
    };
    root.onclick = (e) => { const b = e.target.closest('[data-kc]'); if (b) { U().kxClient = b.dataset.kc; renderEnvases(root); } };
  }

  function renderKxClient(root, clientId) {
    const k = kxState();
    const h = Kardex.history(k.movs, clientId);
    const bal = Kardex.balances(k.movs).filter((b) => b.clientId === clientId);
    const cl = clientById(clientId);
    const name = (h[h.length - 1] || {}).clientName || (cl && cl.name) || clientId;
    const types = [...new Set(bal.map((b) => b.type))];
    const parse = (m) => { try { return JSON.parse(m.data || '{}'); } catch (e) { return {}; } };
    root.innerHTML = `
      <div class="toolbar">
        <button class="btn" id="kcBack">← Kardex</button>
        <div class="grow"><h2 style="margin:0">♻ ${esc(name)}</h2><div class="muted">${esc((bal[0] || {}).sellerName || '')}</div></div>
        ${k.canWrite ? '<button class="btn btn-primary" id="kcDev">↩ Registrar devolución</button><button class="btn" id="kcOpen">+ Saldo de apertura</button>' : ''}
      </div>
      <div class="kpi-row">${bal.map((b) => `<div class="kpi"><small>Vacíos ${esc(b.type)} · debe</small><b class="${b.debe > 0 ? 'warn-txt' : ''}">${nf0.format(b.debe)}</b><small>${nf0.format(b.asignados)} asignados · en su poder ${nf0.format(b.enPoder)}</small></div>`).join('') || '<div class="kpi"><small>Sin movimientos</small><b>0</b></div>'}</div>
      ${types.map((t) => { const f = Kardex.fifo(k.movs, clientId, t); return f.rows.length ? `
        <div class="section-title">Lo que debe de ${esc(t)}, por despacho <span class="muted">(las devoluciones cubren primero lo más antiguo)</span></div>
        <div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Fecha</th><th>Despacho</th><th class="n">Debía</th><th class="n">Devuelto</th><th class="n">Queda</th></tr></thead>
        <tbody>${f.rows.map((r) => `<tr class="${r.left ? '' : 'inactive'}"><td>${esc(fmtDate(r.date))}</td><td>${esc(r.label)}</td><td class="n">${r.owed}</td><td class="n">${r.paid}</td><td class="n"><b class="${r.left ? 'warn-txt' : ''}">${r.left}</b></td></tr>`).join('')}</tbody></table></div>
        ${f.extra ? `<p class="muted">Devolvió ${f.extra} vacíos de ${esc(t)} de más (quedan a su favor).</p>` : ''}` : ''; }).join('')}
      <div class="section-title">Historial</div>
      <div class="card" style="overflow:auto"><table class="inv kx-hist">
        <thead><tr><th>Fecha</th><th>Movimiento</th><th>Tipo</th><th>Código</th><th class="n">Cant.</th><th>Detalle</th><th class="n">Debe</th><th class="n">Asignados</th><th></th></tr></thead>
        <tbody>${h.map((m) => { const d = parse(m); const cancel = m.kind === 'anulacion' || m.kind === 'reverso'; return `<tr class="${m.cancelled ? 'kx-void' : ''} ${cancel ? 'kx-cancel' : ''}">
          <td>${esc(fmtDate(m.date))}</td><td>${esc(m.label)}${m.cancelled ? ` <span class="status over">${m.cancelled.kind === 'reverso' ? 'revertido' : 'anulado'}</span>` : ''}</td><td>${esc(m.type)}</td><td class="mono">${esc(m.code)}</td>
          <td class="n">${cancel ? '' : (Kardex.EFFECT[m.kind] && Kardex.EFFECT[m.kind][0] < 0 ? '−' : Kardex.EFFECT[m.kind] && Kardex.EFFECT[m.kind][1] < 0 ? '−' : '+') + m.qty}</td>
          <td class="muted">${esc([d.valeryNote && 'Nota ' + d.valeryNote, d.dispatcherName, m.motivo, m.by && m.by !== 'Oficina' ? m.by : ''].filter(Boolean).join(' · '))}</td>
          <td class="n">${cancel ? '' : `<b>${m.debe}</b>`}</td><td class="n">${cancel ? '' : m.asignados}</td>
          <td>${k.canWrite && Kardex.MANUAL.includes(m.kind) && !m.cancelled ? `<button class="btn btn-sm" data-anu="${esc(m.id)}">Anular</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>
      <p class="muted">Los despachos, vacíos recibidos y asignados vienen de las liquidaciones: para corregirlos, reabre la liquidación. Las devoluciones y aperturas se anulan aquí, con motivo.</p>`;
    $('#kcBack').onclick = () => { U().kxClient = null; renderEnvases(root); };
    const dv = $('#kcDev'); if (dv) dv.onclick = () => kxDialog(root, 'devolucion', { clientId, name, seller: bal[0] || {}, types });
    const ao = $('#kcOpen'); if (ao) ao.onclick = () => kxDialog(root, 'apertura', { clientId, name, seller: bal[0] || {}, types });
    root.onclick = async (e) => {
      const b = e.target.closest('[data-anu]'); if (!b) return;
      const m = k.movs.find((x) => x.id === b.dataset.anu); if (!m) return;
      const motivo = (prompt(`Anular «${Kardex.KIND_LABEL[m.kind]}» de ${m.qty} (${m.type}) del ${fmtDate(m.date)}.\nMotivo:`) || '').trim();
      if (!motivo) return;
      const r = await Sync.adminCall('envases', { action: 'anular', id: m.id, motivo, by: S.config.adminName || 'Oficina' });
      if (!r.ok) { toast(r.error, 'err'); return; }
      k.movs.push(r.data.mov);
      await log('vacios', `Anuló ${Kardex.KIND_LABEL[m.kind].toLowerCase()} de ${m.qty} vacíos ${m.type} · ${name} · ${motivo}`);
      toast('Movimiento anulado', 'ok'); renderEnvases(root);
    };
  }

  /** Devolución posterior (cliente conocido) o saldo de apertura (elige el cliente). */
  function kxDialog(root, mode, who) {
    const k = kxState(), types = vacTypes();
    const isDev = mode === 'devolucion';
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    const typeOpts = [...new Set((who && who.types || []).concat(types))];
    const sh = openSheet(`
      <div class="row"><h2 class="grow">${isDev ? '↩ Devolución de vacíos' : '+ Saldo de apertura'}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${who ? `<p><b>${esc(who.name)}</b></p>` : `<label class="field"><span>Cliente</span><input class="input" id="kdQ" placeholder="Buscar cliente…" autocomplete="off"></label><div class="suggest" id="kdSug"></div><p id="kdCl" class="muted">Ningún cliente elegido</p>`}
      ${isDev ? '' : '<p class="muted">Para clientes que ya tenían vacíos antes de usar la app. Se registra una sola vez por cliente y tipo.</p>'}
      <div class="row" style="gap:10px;flex-wrap:wrap">
        <label class="field"><span>Tipo de envase</span><select class="select" id="kdType">${opt(typeOpts.map((t) => [t, t]), typeOpts[0])}</select></label>
        <label class="field"><span>Fecha</span><input type="date" class="input" id="kdDate" value="${today()}"></label>
      </div>
      ${isDev ? `<div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="field"><span>Vacíos que devolvió</span><input class="input" id="kdQty" inputmode="numeric" placeholder="0"></label>
          <label class="field"><span>Son de</span><select class="select" id="kdFrom">${opt([['devolucion', 'Lo que debe'], ['dev_asignado', 'Sus asignados']], 'devolucion')}</select></label>
          <label class="field grow"><span>Se aplica a</span><select class="select" id="kdRef"></select></label></div>`
        : `<div class="row" style="gap:10px;flex-wrap:wrap">
          <label class="field"><span>Debe (vacíos)</span><input class="input" id="kdQty" inputmode="numeric" placeholder="0"></label>
          <label class="field"><span>Asignados</span><input class="input" id="kdAsg" inputmode="numeric" placeholder="0"></label></div>`}
      <label class="field"><span>Nota (opcional)</span><input class="input" id="kdNote" maxlength="200" placeholder="${isDev ? 'Ej.: los trajo a la oficina' : 'Ej.: saldo del cuaderno al 30/09'}"></label>
      <div class="actions"><button class="btn btn-primary" id="kdOk">Guardar</button></div>`);
    let pick = who ? { clientId: who.clientId, name: who.name, sellerId: who.seller.sellerId || '', sellerName: who.seller.sellerName || '' } : null;
    const refSel = $('#kdRef', sh.el);
    const fillRef = () => {
      if (!refSel || !pick) return;
      const f = Kardex.fifo(k.movs, pick.clientId, $('#kdType', sh.el).value);
      refSel.innerHTML = '<option value="">Lo más antiguo (automático)</option>' + f.rows.filter((r) => r.left > 0 && r.id && r.orderId).map((r) => `<option value="${esc(r.id)}">${esc(fmtDate(r.date) + ' · ' + r.label + ' · queda ' + r.left)}</option>`).join('');
      refSel.disabled = $('#kdFrom', sh.el).value !== 'devolucion';
    };
    fillRef();
    $('#kdType', sh.el).onchange = fillRef;
    const fr = $('#kdFrom', sh.el); if (fr) fr.onchange = fillRef;
    const qIn = $('#kdQ', sh.el);
    if (qIn) qIn.oninput = () => {
      const t = norm(qIn.value).split(' ').filter(Boolean);
      const hits = t.length ? S.clients.filter((c) => !c.deleted && t.every((x) => norm(c.name + ' ' + (c.rif || '')).includes(x))).slice(0, 12) : [];
      $('#kdSug', sh.el).innerHTML = hits.map((c) => `<button type="button" class="sug-item" data-cid="${esc(c.id)}"><b>${esc(c.name)}</b><span class="muted">${esc((sellerById(c.sellerId) || {}).name || '')}</span></button>`).join('');
    };
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-cid]'); if (!b) return;
      const c = clientById(b.dataset.cid); if (!c) return;
      pick = { clientId: c.id, name: c.name, sellerId: c.sellerId || '', sellerName: (sellerById(c.sellerId) || {}).name || '' };
      $('#kdCl', sh.el).innerHTML = `Cliente: <b>${esc(c.name)}</b>`; $('#kdSug', sh.el).innerHTML = ''; qIn.value = '';
    });
    $('#kdOk', sh.el).onclick = async () => {
      if (!pick) { toast('Elige el cliente', 'err'); return; }
      const type = $('#kdType', sh.el).value, date = $('#kdDate', sh.el).value || today(), note = $('#kdNote', sh.el).value.trim();
      const qty = int($('#kdQty', sh.el).value), asg = isDev ? 0 : int(($('#kdAsg', sh.el) || {}).value);
      if (!type) { toast('Elige el tipo de envase', 'err'); return; }
      if (qty <= 0 && asg <= 0) { toast('Escribe la cantidad', 'err'); return; }
      const base = { clientId: pick.clientId, clientName: pick.name, sellerId: pick.sellerId, sellerName: pick.sellerName, type, date, motivo: note, by: S.config.adminName || 'Oficina' };
      const movs = isDev ? [{ ...base, kind: $('#kdFrom', sh.el).value, qty, refId: $('#kdFrom', sh.el).value === 'devolucion' ? (refSel.value || null) : null }]
        : [qty > 0 && { ...base, kind: 'apertura', qty }, asg > 0 && { ...base, kind: 'apertura_asig', qty: asg }].filter(Boolean);
      $('#kdOk', sh.el).disabled = true;
      for (const mov of movs) {
        const r = await Sync.adminCall('envases', { action: 'add', mov });
        if (!r.ok) { toast(r.error, 'err'); $('#kdOk', sh.el).disabled = false; return; }
        k.movs.push(r.data.mov);
      }
      await log('vacios', isDev ? `Devolución de ${qty} vacíos ${type} · ${pick.name}${note ? ' · ' + note : ''}` : `Saldo de apertura ${type} · ${pick.name}: debe ${qty}${asg ? ', asignados ' + asg : ''}`);
      sh.close(); toast(isDev ? 'Devolución registrada' : 'Saldo de apertura registrado', 'ok');
      if (!isDev) U().kxClient = pick.clientId;
      renderEnvases(root);
    };
  }

  /* ============================= INVENTARIO ============================= */
  function renderInventory(root) {
    const q = U().invQ || '', cat = U().invCat || '', onlyRet = U().invRet === '1';
    const tokens = norm(q).split(' ').filter(Boolean);
    const retCount = S.products.filter((p) => Envases.isReturnable(p)).length;
    const missing = (S.config.retMissing || []).filter((c) => !S.products.some((p) => Envases.isReturnable(p) && (Envases.normCode(p.code) === c || Envases.normCode(p.unitCode) === c)));
    const rows = S.products.filter((p) => (!cat || p.category === cat) && (!onlyRet || Envases.isReturnable(p)) &&
      tokens.every((t) => norm(p.code + ' ' + (p.unitCode || '') + ' ' + p.name + ' ' + p.presentation + ' ' + (p.brand || '')).includes(t)))
      .sort(PV.productSort());
    const noPhoto = S.products.filter((p) => !PV.hasPhoto(p)).length;
    root.innerHTML = `
      <div class="toolbar">
        <label class="field grow"><span>Buscar</span><input id="iq" class="input" type="search" value="${esc(q)}" placeholder="Código, nombre, marca o gramaje"></label>
        <label class="field"><span>Rubro</span><select id="icat" class="select"><option value="">Todos</option>
          ${rubros().map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="field"><span>Envase</span><select id="iret" class="select"><option value="">Todos</option><option value="1" ${onlyRet ? 'selected' : ''}>♻ Solo retornables (${retCount})</option></select></label>
        <button class="btn btn-primary" id="iNew">＋ Nuevo</button>
        <button class="btn" id="iImp">⇧ Importar Excel/CSV</button>
        <button class="btn" id="iExp">⇩ Exportar</button>
        <button class="btn" id="iPhotos">📷 Fotos en lote</button>
        <button class="btn" id="iOrder">↕ Ordenar catálogo</button>
      </div>
      ${onlyRet && missing.length ? `<div class="hint warn">Códigos de la lista de retornables que no están en el catálogo: <b>${esc(missing.join(', '))}</b>. Corrige el código del producto y márcalo en «Envase retornable».</div>` : ''}
      <p class="muted">${S.products.length} productos · ${rows.length} mostrados · ${noPhoto} sin foto${S.config.priceListDate ? ' · lista de precios del ' + esc(S.config.priceListDate) : ''}. Los cambios de precio, stock u orden se guardan al salir de la casilla y llegan a los teléfonos al sincronizar.</p>
      <div class="card" style="overflow:auto"><table class="inv inv-edit">
        <thead><tr><th></th><th>Código</th><th>Producto</th><th>Rubro</th><th>Venta</th><th>$ Caja</th><th>$ Unidad</th><th>Stock</th><th>Orden</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr class="${p.active ? '' : 'inactive'}" data-row="${esc(p.id)}">
            <td class="thumb">${PV.hasPhoto(p) ? `<img src="${esc(PV.imgSrc(p))}" alt="" loading="lazy">` : `<span>${PV.rubroIcon(p.category)}</span>`}</td>
            <td class="mono" data-l="Código">${esc(p.code)}${p.unitCode ? `<div class="muted">UN: ${esc(p.unitCode)}</div>` : ''}${Envases.isReturnable(p) ? `<div class="ret-tag">${esc(Envases.label(p))}</div>` : ''}</td>
            <td><b>${esc(p.name)}</b><div class="muted">${esc(p.presentation)}${p.brand ? ' · ' + esc(p.brand) : ''}${p.unitsPerBox > 1 ? ' · caja x' + p.unitsPerBox : ''}</div></td>
            <td data-l="Rubro">${esc(p.category)}${p.subgroup ? `<div class="muted">${esc(p.subgroup)}</div>` : ''}</td>
            <td data-l="Venta"><span class="sell ${p.sellBy}">${{ caja: 'Caja', unidad: 'Unidad', ambos: 'Caja + Unid.' }[p.sellBy]}</span></td>
            <td data-l="$ Caja">${p.sellBy !== 'unidad' ? `<input class="input qin" inputmode="decimal" data-f="boxPrice" value="${nf2.format(p.boxPrice || 0)}">` : '—'}</td>
            <td data-l="$ Unidad">${p.sellBy !== 'caja' ? `<input class="input qin" inputmode="decimal" data-f="unitPrice" value="${nf2.format(p.unitPrice || 0)}">` : '—'}</td>
            <td data-l="Stock" title="${hasStock(p) ? esc(fmtStock(p.stock, p.unitsPerBox, p.sellBy)) : 'Sin control de inventario'}"><input class="input qin" inputmode="numeric" data-f="stock" placeholder="—" value="${hasStock(p) ? p.stock : ''}"><div class="muted">${hasStock(p) ? esc(fmtStock(p.stock, p.unitsPerBox, p.sellBy)) : 'sin control'}</div></td>
            <td data-l="Orden"><input class="input qin small" inputmode="numeric" data-f="sort" value="${p.sort || ''}"></td>
            <td><button class="btn btn-sm" data-edit="${esc(p.id)}">Editar</button></td>
          </tr>`).join('')}</tbody></table></div>`;
    let t;
    $('#iq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { U().invQ = e.target.value; renderInventory(root); const i = $('#iq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#icat').onchange = (e) => { U().invCat = e.target.value; renderInventory(root); };
    $('#iret').onchange = (e) => { U().invRet = e.target.value; renderInventory(root); };
    $('#iNew').onclick = () => productForm(null, root);
    $('#iExp').onclick = () => saveFile('catalogo_' + today() + '.csv', '\uFEFF' + catalogCSV(), 'text/csv;charset=utf-8');
    $('#iImp').onclick = () => importDialog('products', root);
    $('#iPhotos').onclick = () => bulkPhotos(root);
    $('#iOrder').onclick = () => catalogOrderEditor(root);
    root.onclick = (e) => { const b = e.target.closest('[data-edit]'); if (b) productForm(productById(b.dataset.edit), root); };
    root.onchange = async (e) => {
      const inp = e.target.closest('.qin'); if (!inp) return;
      const p = productById(inp.closest('[data-row]').dataset.row); if (!p) return;
      const f = inp.dataset.f, v = inp.value.trim();
      const val = f === 'stock' ? (v === '' ? null : int(v)) : f === 'sort' ? int(v) : Matrix.r2(dec(v));
      const doc = { ...p, [f]: val };
      const shifted = f === 'sort' && val !== (+p.sort || 0) ? shiftSort(doc) : [];
      await saveDocs('products', [doc].concat(shifted));
      toast('Guardado: ' + p.name, 'ok');
      if (shifted.length) renderInventory(root);
    };
  }

  /** Si el orden elegido ya está ocupado en la categoría, corre +1 ese producto y los que siguen. */
  function shiftSort(doc) {
    const n = +doc.sort || 0;
    if (!n) return [];
    const same = S.products.filter((x) => x.id !== doc.id && !x.deleted && x.category === doc.category && +x.sort > 0);
    if (!same.some((x) => +x.sort === n)) return [];
    return same.filter((x) => +x.sort >= n).map((x) => ({ ...x, sort: +x.sort + 1 }));
  }

  /**
   * Orden del catálogo (lo que ven los vendedores y el orden de la hoja de carga):
   * primero el orden de las categorías, luego el de los productos dentro de cada una.
   */
  function catalogOrderEditor(root) {
    let cat = rubros()[0] || '';
    const sh = openSheet(`<div class="row"><h2 class="grow">↕ Orden del catálogo</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Así lo ven los vendedores en el teléfono y así sale en la hoja de carga. Se guarda al instante.</p>
      <div class="order-grid"><div><div class="section-title">Categorías</div><div id="ordCats"></div></div>
      <div><div class="section-title" id="ordTitle"></div><div id="ordProds"></div></div></div>`, { wide: true });
    const draw = () => {
      const cats = (S.config.rubros || []).filter((c) => S.products.some((p) => p.category === c));
      const extra = rubros().filter((c) => !cats.includes(c));
      const all = cats.concat(extra);
      $('#ordCats', sh.el).innerHTML = all.map((c, i) => `<div class="ord-item ${c === cat ? 'active' : ''}" data-cat="${esc(c)}">
        <span class="grow">${PV.rubroIcon(c)} ${esc(c)} <small class="muted">${S.products.filter((p) => p.category === c).length}</small></span>
        <button class="btn btn-sm" data-cup="${i}" ${i ? '' : 'disabled'} aria-label="Subir">↑</button><button class="btn btn-sm" data-cdown="${i}" ${i < all.length - 1 ? '' : 'disabled'} aria-label="Bajar">↓</button></div>`).join('');
      const prods = S.products.filter((p) => p.category === cat).sort(PV.productSort());
      $('#ordTitle', sh.el).textContent = cat + ' · productos';
      $('#ordProds', sh.el).innerHTML = prods.map((p, i) => `<div class="ord-item">
        <span class="grow"><b>${i + 1}.</b> ${esc(p.name)} <small class="muted">${esc(p.presentation)}${p.subgroup && p.subgroup !== p.presentation ? ' · ' + esc(p.subgroup) : ''}</small></span>
        <button class="btn btn-sm" data-pup="${i}" ${i ? '' : 'disabled'} aria-label="Subir">↑</button><button class="btn btn-sm" data-pdown="${i}" ${i < prods.length - 1 ? '' : 'disabled'} aria-label="Bajar">↓</button></div>`).join('');
      return { all, prods };
    };
    let st = draw();
    sh.el.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); const item = e.target.closest('[data-cat]');
      if (!b && item) { cat = item.dataset.cat; st = draw(); return; }
      if (!b) return;
      const swap = (arr, i, j) => { const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a; };
      if (b.dataset.cup || b.dataset.cdown) {
        const i = +(b.dataset.cup || b.dataset.cdown), j = b.dataset.cup ? i - 1 : i + 1;
        await saveDocs('config', { ...S.config, rubros: swap(st.all, i, j) });
      } else if (b.dataset.pup || b.dataset.pdown) {
        const i = +(b.dataset.pup || b.dataset.pdown), j = b.dataset.pup ? i - 1 : i + 1;
        // Renumera la categoría 1..n y guarda solo los productos que cambiaron
        const ordered = swap(st.prods, i, j);
        await saveDocs('products', ordered.map((p, k) => (p.sort === k + 1 ? null : { ...p, sort: k + 1 })).filter(Boolean));
      } else return;
      st = draw();
    });
    const close = () => renderInventory(root);
    sh.el.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) close(); });
  }

  /** Redimensiona una foto a JPEG liviano (viaja por el sync y queda offline). */
  function resizeImage(file, max) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext('2d');
        g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/jpeg', 0.74));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagen no válida')); };
      img.src = url;
    });
  }

  function productForm(p, root) {
    const isNew = !p;
    p = p || { code: '', unitCode: '', name: '', presentation: '', category: rubros()[0] || '', subgroup: '', brand: '',
      unitsPerBox: 1, unitPrice: 0, boxPrice: 0, sellBy: 'caja', stock: null, sort: 0, active: true, image: '' };
    // La foto solo se envía si cambió (foto nueva o quitada): si no, el producto viaja liviano
    const image0 = PV.imgSrc(p);
    let image = image0;
    const ret = Envases.info(p);
    const upb = +p.unitsPerBox || 1;
    const stockCj = hasStock(p) ? (p.sellBy === 'unidad' ? 0 : Math.floor(Math.max(0, p.stock) / upb)) : '';
    const stockUn = hasStock(p) ? (p.sellBy === 'unidad' ? p.stock : (p.stock < 0 ? p.stock : p.stock % upb)) : '';
    const sh = openSheet(`
      <div class="row"><h2 class="grow">${isNew ? 'Nuevo producto' : 'Editar ' + esc(p.code)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <form id="pf" class="form-grid" autocomplete="off">
        <div class="photo-edit"><div class="pimg big" id="pfImg">${image ? `<img src="${esc(image)}" alt="">` : PV.rubroIcon(p.category)}</div>
          <div class="row wrap"><button type="button" class="btn btn-sm" id="pfPhoto">📷 Foto</button><button type="button" class="btn btn-sm" id="pfNoPhoto">Quitar</button></div></div>
        <div class="grid2">
          <label class="field"><span>Código (caja) *</span><input name="code" class="input mono" required maxlength="30" value="${esc(p.code)}"></label>
          <label class="field"><span>Código unidad (si aplica)</span><input name="unitCode" class="input mono" maxlength="30" value="${esc(p.unitCode || '')}"></label>
        </div>
        <label class="field"><span>Nombre *</span><input name="name" class="input" required maxlength="80" value="${esc(p.name)}"></label>
        <div class="grid3">
          <label class="field"><span>Presentación / gramaje</span><input name="presentation" class="input" maxlength="30" value="${esc(p.presentation)}" placeholder="340 g, 2 L…"></label>
          <label class="field"><span>Marca</span><input name="brand" class="input" maxlength="30" value="${esc(p.brand || '')}"></label>
          <label class="field"><span>Orden en el rubro</span><input name="sort" class="input" inputmode="numeric" value="${p.sort || ''}"></label>
        </div>
        <div class="grid2">
          <label class="field"><span>Rubro *</span><input name="category" class="input" required list="catDl" maxlength="40" value="${esc(p.category)}"></label>
          <label class="field"><span>Subgrupo (ej. 2 L, Kaito)</span><input name="subgroup" class="input" maxlength="30" value="${esc(p.subgroup || '')}"></label>
        </div>
        <datalist id="catDl">${rubros().map((c) => `<option value="${esc(c)}">`).join('')}</datalist>
        <div class="grid3">
          <label class="field"><span>Se vende por</span><select name="sellBy" class="select">
            ${[['caja', 'Solo caja'], ['unidad', 'Solo unidad'], ['ambos', 'Caja y unidad']].map(([v, l]) => `<option value="${v}" ${p.sellBy === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          <label class="field"><span>Unidades por caja</span><input name="unitsPerBox" class="input" inputmode="numeric" value="${upb}"></label>
          <label class="field"><span>Precio caja $</span><input name="boxPrice" class="input" inputmode="decimal" value="${nf2.format(p.boxPrice || 0)}"></label>
        </div>
        <div class="grid3">
          <label class="field"><span>Precio unidad $</span><input name="unitPrice" class="input" inputmode="decimal" value="${nf2.format(p.unitPrice || 0)}"></label>
          <label class="field"><span>Stock cajas</span><input name="stockCj" class="input" inputmode="numeric" value="${stockCj}" placeholder="—"></label>
          <label class="field"><span>+ Stock unidades</span><input name="stockUn" class="input" inputmode="numeric" value="${stockUn}" placeholder="—"></label>
        </div>
        <p class="muted" style="margin:0">Deja el stock vacío si no quieres controlar inventario de este producto.</p>
        <label class="row"><input type="checkbox" name="active" ${p.active ? 'checked' : ''} style="width:24px;height:24px"> Activo (visible para los vendedores)</label>
        <fieldset class="ret-box">
          <legend>♻ Envase retornable</legend>
          <label class="row"><input type="checkbox" name="retOn" ${ret ? 'checked' : ''} style="width:24px;height:24px"> Es de envase retornable: entra en el control de vacíos (hoja de carga, kardex y reportes)</label>
          <div class="grid3" id="retFields">
            <label class="field"><span>Tipo de envase</span><input name="retType" class="input" list="retTypes" maxlength="20" value="${esc(ret ? ret.type : '')}" placeholder="350, 1,25… (vacío = va aparte)"></label>
            <label class="field"><span>Régimen</span><select name="retRegime" class="select">
              <option value="prestamo" ${!ret || ret.regime !== 'contraentrega' ? 'selected' : ''}>Préstamo: puede devolverlo después</option>
              <option value="contraentrega" ${ret && ret.regime === 'contraentrega' ? 'selected' : ''}>Contraentrega: vacío obligatorio al entregar</option></select></label>
            <label class="field"><span>Vacíos asignados</span><select name="retAssign" class="select">
              <option value="0" ${ret && ret.assign ? '' : 'selected'}>No admite</option>
              <option value="1" ${ret && ret.assign ? 'selected' : ''}>Admite asignados</option></select></label>
          </div>
          <datalist id="retTypes">${[...new Set(S.products.filter((x) => Envases.isReturnable(x) && x.ret.type).map((x) => x.ret.type))].map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
          <p class="muted" style="margin:6px 0 0">Los productos con el mismo tipo se suman en un subtotal en los reportes de vacíos; cada código conserva su propio saldo.</p>
        </fieldset>
        <div class="actions">
          <button class="btn btn-primary" type="submit">Guardar</button>
          ${isNew ? '' : '<button class="btn btn-danger" type="button" id="pDel">Eliminar</button>'}
        </div>
      </form>`, { wide: true });
    const form = $('#pf', sh.el);
    const syncRet = () => { $('#retFields', sh.el).style.opacity = form.retOn.checked ? '1' : '.45'; [form.retType, form.retRegime, form.retAssign].forEach((el) => { el.disabled = !form.retOn.checked; }); };
    form.retOn.onchange = syncRet; syncRet();
    const setImg = (src) => { image = src; $('#pfImg', sh.el).innerHTML = src ? `<img src="${esc(src)}" alt="">` : PV.rubroIcon(form.category.value); };
    $('#pfPhoto', sh.el).onclick = async () => {
      const f = await pickFile('image/*'); if (!f) return;
      try { setImg(await resizeImage(f, 420)); } catch (e) { toast(e.message, 'err'); }
    };
    $('#pfNoPhoto', sh.el).onclick = () => setImg('');
    form.onsubmit = async (e) => {
      e.preventDefault();
      const code = form.code.value.trim().toUpperCase();
      if (S.products.some((x) => x.code.toUpperCase() === code && x.id !== p.id)) { toast('Ya existe un producto con el código ' + code, 'err'); return; }
      const sellBy = form.sellBy.value;
      const u = sellBy === 'unidad' ? 1 : Math.max(1, int(form.unitsPerBox.value));
      const cj = form.stockCj.value.trim(), un = form.stockUn.value.trim();
      const doc = {
        ...p, id: p.id || 'p_' + slug(code), code, unitCode: form.unitCode.value.trim().toUpperCase(),
        name: form.name.value.trim(), presentation: form.presentation.value.trim(), brand: form.brand.value.trim(),
        category: form.category.value.trim().toUpperCase(), subgroup: form.subgroup.value.trim(), sort: int(form.sort.value),
        sellBy, unitsPerBox: u,
        boxPrice: sellBy === 'unidad' ? 0 : Matrix.r2(dec(form.boxPrice.value)),
        unitPrice: sellBy === 'caja' ? 0 : Matrix.r2(dec(form.unitPrice.value)),
        stock: cj === '' && un === '' ? null : int(cj) * u + int(un),
        active: form.active.checked, deleted: false,
        ret: form.retOn.checked ? { type: form.retType.value.trim().toUpperCase(), regime: form.retRegime.value, assign: form.retAssign.value === '1' } : false,
      };
      if (image !== image0) { doc.image = image; if (!image) doc.imageV = ''; } else if (!/^data:/.test(String(doc.image || ''))) delete doc.image;
      if (doc.boxPrice < 0 || doc.unitPrice < 0) { toast('Los precios no pueden ser negativos', 'err'); return; }
      if (S.products.some((x) => x.id === doc.id && x.id !== p.id)) doc.id = DB.uid('p');
      const moved = isNew || doc.sort !== (+p.sort || 0) || doc.category !== p.category;
      await saveDocs('products', [doc].concat(moved ? shiftSort(doc) : []));
      if (doc.category && !(S.config.rubros || []).includes(doc.category)) await saveDocs('config', { ...S.config, rubros: (S.config.rubros || []).concat(doc.category) });
      sh.close(); renderInventory(root); toast('Producto guardado', 'ok');
    };
    const del = $('#pDel', sh.el);
    if (del) del.onclick = async () => {
      if (!confirm('¿Eliminar ' + p.name + '? Los pedidos existentes conservan su copia.')) return;
      await saveDocs('products', { ...p, deleted: true, active: false }); sh.close(); renderInventory(root); toast('Producto eliminado');
    };
  }

  /** Fotos en lote: el nombre del archivo debe ser el código (ej. 222.jpg, G17.png). */
  async function bulkPhotos(root) {
    const files = await new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = 'image/*'; inp.multiple = true;
      inp.onchange = () => resolve([...inp.files]); inp.click();
    });
    if (!files.length) return;
    const byCode = new Map();
    S.products.forEach((p) => { byCode.set(norm(p.code).replace(/\s+/g, ''), p); if (p.unitCode) byCode.set(norm(p.unitCode).replace(/\s+/g, ''), p); });
    const docs = [], miss = [];
    for (const f of files) {
      const stem = norm(f.name.replace(/\.[^.]+$/, '')).replace(/\s+/g, '');
      const p = byCode.get(stem);
      if (!p) { miss.push(f.name); continue; }
      try { docs.push({ ...p, image: await resizeImage(f, 420) }); } catch (e) { miss.push(f.name); }
    }
    await saveDocs('products', docs);
    renderInventory(root);
    toast(`${docs.length} fotos asignadas${miss.length ? ' · sin código reconocido: ' + miss.slice(0, 5).join(', ') + (miss.length > 5 ? '…' : '') : ''}`, miss.length ? 'err' : 'ok');
  }

  const CAT_HEAD = ['CODIGO', 'CODIGO_UNIDAD', 'NOMBRE', 'PRESENTACION', 'RUBRO', 'SUBGRUPO', 'MARCA', 'VENTA', 'UND_X_CAJA', 'PRECIO_CAJA', 'PRECIO_UNIDAD', 'STOCK_UNIDADES', 'ORDEN', 'ACTIVO'];
  function catalogCSV() {
    const sep = S.settings.csvSep, d = S.settings.csvDecimal;
    const n = (v) => { const s = Number(v || 0).toFixed(2); return d === ',' ? s.replace('.', ',') : s; };
    const q = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return (s.includes(sep) || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const rows = [CAT_HEAD.join(sep)];
    S.products.slice().sort(PV.productSort()).forEach((p) => {
      rows.push([q(p.code), q(p.unitCode || ''), q(p.name), q(p.presentation), q(p.category), q(p.subgroup || ''), q(p.brand || ''), p.sellBy, p.unitsPerBox,
        n(p.boxPrice), n(p.unitPrice), hasStock(p) ? p.stock : '', p.sort || '', p.active ? 'SI' : 'NO'].join(sep));
    });
    return rows.join('\r\n');
  }

  /* ------------------------- Importación con mapeo ------------------------- */
  async function importDialog(kind, root) {
    const f = await pickFile('.xls,.xlsx,.csv,.txt'); if (!f) return;
    let table;
    try { table = await Importer.readFile(f); } catch (e) { toast(e.message || 'No se pudo leer el archivo', 'err'); return; }
    if (!table.rows.length) { toast('El archivo no tiene filas', 'err'); return; }
    const fields = Importer.FIELDS[kind];
    const guess = Importer.guess(kind, table.headers);
    const colOpts = (sel) => `<option value="-1">— No usar —</option>` + table.headers.map((h, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(h || 'Columna ' + (i + 1))}</option>`).join('');
    // Clientes: mapear los nombres de vendedor del archivo a los vendedores de la app
    let sellerMap = {};
    const sellerCol = guess.seller;
    const distinct = kind === 'clients' && sellerCol >= 0 ? [...new Set(table.rows.map((r) => (r[sellerCol] || '').trim()).filter(Boolean))] : [];
    distinct.forEach((v) => {
      const s = S.sellers.find((x) => (x.aliases || []).some((a) => Importer.norm(a) === Importer.norm(v)) || Importer.norm(x.name) === Importer.norm(v));
      sellerMap[v] = s ? s.id : '';
    });
    const sh = openSheet(`
      <div class="row"><h2 class="grow">Importar ${kind === 'products' ? 'productos' : 'clientes'}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">${esc(f.name)} · ${table.rows.length} filas. Revisa qué columna corresponde a cada dato.</p>
      <div class="grid2" id="mapGrid">${fields.map(([k, label]) => `<label class="field"><span>${esc(label)}</span><select class="select" data-map="${k}">${colOpts(guess[k])}</select></label>`).join('')}</div>
      ${kind === 'products' ? `
        <label class="row" style="margin-top:10px"><input type="checkbox" id="impAuto" checked style="width:22px;height:22px"> Clasificar rubro automáticamente si viene vacío</label>
        <label class="row"><input type="checkbox" id="impReplace" style="width:22px;height:22px"> Reemplazar catálogo (desactiva los productos que no estén en el archivo)</label>`
      : `<div class="section-title">Vendedor del archivo → vendedor de la app</div>
        <p class="muted">Los clientes de vendedores marcados "No importar" (GENÉRICO, CAJA CONTADO…) se omiten.</p>
        <div class="grid2">${distinct.slice(0, 40).map((v) => `<label class="field"><span>${esc(v)}</span><select class="select" data-seller="${esc(v)}">
          <option value="">No importar</option>${S.sellers.map((s) => `<option value="${esc(s.id)}" ${sellerMap[v] === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>`).join('')}</div>`}
      <div class="actions"><button class="btn btn-primary" id="impGo">Importar</button><button class="btn" data-close>Cancelar</button></div>`, { wide: true });
    sh.el.addEventListener('change', (e) => { const s = e.target.closest('[data-seller]'); if (s) sellerMap[s.dataset.seller] = s.value; });
    $('#impGo', sh.el).onclick = async () => {
      const map = {};
      sh.el.querySelectorAll('[data-map]').forEach((s) => { map[s.dataset.map] = +s.value; });
      const get = (r, k) => (map[k] >= 0 ? String(r[map[k]] || '').trim().replace(/^'/, '') : '');
      const n = kind === 'products'
        ? await importProducts(table.rows, get, { auto: $('#impAuto', sh.el).checked, replace: $('#impReplace', sh.el).checked, hasCol: (k) => map[k] >= 0 })
        : await importClients(table.rows, get, sellerMap);
      sh.close(); PV.render(); toast(n, 'ok');
    };
    void root;
  }

  async function importProducts(rows, get, opt) {
    const byCode = new Map(S.products.map((p) => [p.code.toUpperCase(), p]));
    const seen = new Set(); const docs = []; let created = 0, updated = 0;
    rows.forEach((r) => {
      const code = get(r, 'code').toUpperCase(); if (!code) return;
      const prev = byCode.get(code);
      const name = get(r, 'name') || (prev && prev.name) || code; // se respeta el nombre de facturación
      let presentation = get(r, 'presentation');
      if (!presentation && !prev) presentation = Importer.splitPresentation(name).presentation;
      // La categoría la manda el archivo (columna REF/categoría); solo si viene vacía se deduce
      const fromRef = Importer.categoryFromRef(get(r, 'category'));
      let category = fromRef.category;
      if (!category) category = prev ? prev.category : (opt.auto ? Importer.classifyRubro(name) : 'OTROS');
      const sellBy = Importer.parseSellBy(get(r, 'sellBy')) || (prev ? prev.sellBy : 'caja');
      const upb = Importer.parseUPB(get(r, 'unitsPerBox')) || (prev ? prev.unitsPerBox : 1);
      const has = (k) => opt.hasCol(k) && get(r, k) !== '';
      const doc = {
        ...(prev || { id: 'p_' + slug(code), active: true, image: '', sort: 0, deleted: false }),
        code, name, presentation: presentation || (prev ? prev.presentation : ''), category,
        subgroup: fromRef.subgroup || (prev ? prev.subgroup || '' : ''),
        brand: get(r, 'brand') || (prev ? prev.brand || '' : ''),
        sellBy, unitsPerBox: sellBy === 'unidad' ? 1 : upb,
        boxPrice: has('boxPrice') ? Matrix.r2(dec(get(r, 'boxPrice'))) : (prev ? prev.boxPrice : 0),
        unitPrice: has('unitPrice') ? Matrix.r2(dec(get(r, 'unitPrice'))) : (prev ? prev.unitPrice : 0),
        stock: has('stock') ? int(get(r, 'stock')) : (prev ? prev.stock : null),
        active: has('active') ? Importer.norm(get(r, 'active')) !== 'NO' : (prev ? prev.active : true),
        deleted: false,
      };
      // Precio único: se asigna según la forma de venta
      if (!opt.hasCol('boxPrice') && opt.hasCol('unitPrice') && sellBy === 'caja' && !prev) { doc.boxPrice = doc.unitPrice; doc.unitPrice = 0; }
      seen.add(code); docs.push(doc); byCode.set(code, doc);
      prev ? updated++ : created++;
    });
    let off = 0;
    if (opt.replace) S.products.forEach((p) => { if (!seen.has(p.code.toUpperCase()) && p.active) { docs.push({ ...p, active: false }); off++; } });
    await saveDocs('products', docs);
    const newCats = [...new Set(docs.map((d) => d.category))].filter((c) => !(S.config.rubros || []).includes(c));
    if (newCats.length) await saveDocs('config', { ...S.config, rubros: (S.config.rubros || []).concat(newCats) });
    return `Productos: ${created} nuevos, ${updated} actualizados${off ? ', ' + off + ' desactivados' : ''}`;
  }

  async function importClients(rows, get, sellerMap) {
    const byKey = new Map(S.clients.map((c) => [norm(c.rif) || norm(c.name), c]));
    const docs = []; let created = 0, updated = 0, skipped = 0;
    rows.forEach((r) => {
      const name = get(r, 'name'); const rif = get(r, 'rif');
      if (!name || /ANULADO/i.test(name)) { skipped++; return; }
      const sellerRaw = get(r, 'seller');
      const sellerId = sellerRaw ? sellerMap[sellerRaw] : '';
      if (!sellerId) { skipped++; return; }
      const seller = sellerById(sellerId);
      const key = norm(rif) || norm(name);
      const prev = byKey.get(key);
      const group = get(r, 'group');
      const doc = {
        ...(prev || { id: 'c_' + (slug(rif) || slug(name)) + (byKey.has(key) ? '' : ''), active: true, deleted: false, source: 'import' }),
        rif, name: name.replace(/\s+/g, ' ').trim().toUpperCase(), phone: get(r, 'phone'), address: get(r, 'address'),
        group: /^error$/i.test(group) ? '' : group, creditDays: int(get(r, 'creditDays')),
        sellerId, route: get(r, 'route') || (prev && prev.route) || (seller && seller.routes && seller.routes.length === 1 ? seller.routes[0] : ''),
      };
      if (!prev && S.clients.some((c) => c.id === doc.id)) doc.id = DB.uid('c');
      docs.push(doc); byKey.set(key, doc);
      prev ? updated++ : created++;
    });
    await saveDocs('clients', docs);
    return `Clientes: ${created} nuevos, ${updated} actualizados, ${skipped} omitidos`;
  }

  /* ============================== CLIENTES ============================== */
  function renderClients(root) {
    const q = U().cliQ || '', sid = U().cliSeller || '';
    const tokens = norm(q).split(' ').filter(Boolean);
    const pend = !!U().cliPend, toVerify = S.clients.filter((c) => !Clientes.isVerified(c)).length;
    const all = S.clients.filter((c) => (!pend || !Clientes.isVerified(c)) && (!sid || (sid === '__none' ? !sellerById(c.sellerId) : c.sellerId === sid)) && tokens.every((t) => norm(c.name + ' ' + (c.tradeName || '') + ' ' + c.rif + ' ' + c.address + ' ' + c.phone).includes(t)))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const list = all.slice(0, 300);
    const count = (id) => S.clients.filter((c) => c.sellerId === id).length;
    root.innerHTML = `
      <div class="toolbar">
        <label class="field grow"><span>Buscar</span><input id="cq" class="input" type="search" value="${esc(q)}" placeholder="Nombre, RIF, dirección o teléfono"></label>
        <label class="field"><span>Vendedor</span><select id="cs" class="select"><option value="">Todos (${S.clients.length})</option>
          ${S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)} (${count(s.id)})</option>`).join('')}
          <option value="__none" ${sid === '__none' ? 'selected' : ''}>— Sin vendedor — (${S.clients.filter((c) => !sellerById(c.sellerId)).length})</option></select></label>
        <button class="btn btn-primary" id="cNew">＋ Nuevo</button>
        <button class="btn" id="cMerge" title="Pasar los pedidos de clientes repetidos al cliente real">🔗 Fusionar clientes</button>
        <button class="btn" id="cImp">⇧ Importar Excel</button>
      </div>
      <div class="chips" id="cPend"><button class="chip ${pend ? '' : 'active'}" data-p="0">Todos</button><button class="chip ${pend ? 'active' : ''}" data-p="1">🕓 Por verificar (${toVerify})</button></div>
      <p class="muted">${all.length} clientes${all.length > list.length ? ' · mostrando 300, usa la búsqueda' : ''}. Los <span class="status abierto">🕓 por verificar</span> los registró un vendedor: ábrelos, revisa los datos y pulsa «Guardar y verificar».</p>
      <div class="card" style="overflow:auto"><table class="inv">
        <thead><tr><th>Cliente</th><th>RIF / C.I.</th><th>Teléfono</th><th>Vendedor</th><th>Ruta</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr data-cid="${esc(c.id)}" class="${c.active === false ? 'inactive' : ''}">
          <td><b>${esc(c.name)}</b>${c.tradeName ? ` <span class="muted">· ${esc(c.tradeName)}</span>` : ''}${Clientes.isVerified(c) ? '' : ` <span class="status abierto" title="${esc(c.verifyReason || '')}">🕓 por verificar</span>`}<div class="muted">${esc(c.address || '')}${c.createdByName && !Clientes.isVerified(c) ? ' · registró ' + esc(c.createdByName) : ''}</div></td>
          <td class="mono" data-l="RIF">${esc(c.rif || '')}</td><td data-l="Tel.">${esc(c.phone || '')}</td>
          <td data-l="Vendedor"><select class="select sm" data-cf="sellerId">${sellerOptions(c.sellerId)}</select></td>
          <td data-l="Ruta"><select class="select sm" data-cf="route"><option value="">—</option>${(S.config.routes || []).map((r) => `<option ${r === c.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
          <td style="white-space:nowrap"><button class="btn btn-sm ${Clientes.isVerified(c) ? '' : 'btn-primary'}" data-cedit="${esc(c.id)}">${Clientes.isVerified(c) ? 'Editar' : 'Revisar'}</button> <button class="btn btn-sm" data-cmerge="${esc(c.id)}" title="Fusionar repetidos en este cliente">🔗</button></td></tr>`).join('')}</tbody></table></div>`;
    let t;
    $('#cq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { U().cliQ = e.target.value; renderClients(root); const i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#cs').onchange = (e) => { U().cliSeller = e.target.value; renderClients(root); };
    $('#cPend').onclick = (e) => { const b = e.target.closest('[data-p]'); if (b) { U().cliPend = b.dataset.p === '1'; renderClients(root); } };
    $('#cNew').onclick = () => clientForm(null, root);
    $('#cMerge').onclick = () => mergeDialog(null, root);
    $('#cImp').onclick = () => importDialog('clients', root);
    root.onchange = async (e) => {
      const s = e.target.closest('[data-cf]'); if (!s) return;
      const c = clientById(s.closest('[data-cid]').dataset.cid);
      const upd = { ...c, [s.dataset.cf]: s.value };
      await saveClient(c, upd); toast('Cliente actualizado', 'ok');
      if (s.dataset.cf === 'sellerId') renderClients(root);
    };
    root.onclick = (e) => {
      const b = e.target.closest('[data-cedit]'); if (b) { clientForm(clientById(b.dataset.cedit), root); return; }
      const m = e.target.closest('[data-cmerge]'); if (m) mergeDialog(clientById(m.dataset.cmerge), root);
    };
  }

  /* ---------------- Fusionar clientes repetidos en el cliente real ---------------- */
  function mergeDialog(pre, root) {
    let real = pre || null; const pick = new Set();
    const stats = (c) => { const os = S.orders.filter((o) => !o.deleted && o.clientId === c.id); return { n: os.length, liq: os.filter((o) => o.delivery && o.delivery.at).length }; };
    const info = (c) => { const st = stats(c), miss = Clientes.missing(c); return `${esc([c.rif || 'sin RIF', c.sellerId ? 'cartera de ' + ((sellerById(c.sellerId) || {}).name || '—') : 'sin vendedor'].join(' · '))} · ${st.n} pedido(s)${st.liq ? ` (${st.liq} liquidado(s))` : ''}${miss.length >= 3 ? ' · <b>solo nombre</b>' : ''}${Clientes.isVerified(c) ? '' : ' · 🕓'}`; };
    const sh = openSheet(`
      <div class="row"><h2 class="grow">🔗 Fusionar clientes</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted" style="margin-top:0">Elige el cliente <b>real</b> (el que queda) y marca los repetidos. Todos sus pedidos —también los liquidados, con su kardex de vacíos— pasan al real, el real completa los datos que le falten y los repetidos se eliminan. No quedan pedidos ni vacíos sueltos ni duplicados.</p>
      <div id="mgBody"></div>`, { wide: true });
    const body = sh.el.querySelector('#mgBody');
    const search = (q, excl) => { const t = norm(q).split(' ').filter(Boolean); return t.length ? S.clients.filter((c) => !excl.has(c.id) && t.every((w) => norm([c.name, c.tradeName, c.rif, c.phone].join(' ')).includes(w))).slice(0, 12) : []; };
    const draw = (q) => {
      if (!real) {
        body.innerHTML = `<label class="field"><span>1 · Cliente real (el correcto)</span><input id="mgQ" class="input" placeholder="Buscar por nombre, RIF o teléfono…" value="${esc(q || '')}" autocomplete="off"></label>
          <div class="pick-list" style="margin-top:8px">${search(q || '', new Set()).map((c) => `<button type="button" class="sug-item" data-real="${esc(c.id)}"><b>${esc(c.name)}</b><small>${info(c)}</small></button>`).join('') || '<p class="muted">Escribe para buscar.</p>'}</div>`;
      } else {
        const others = S.clients.filter((c) => c.id !== real.id);
        const cands = [...new Map([...Dedup.similar(real.name, others, 0.34), ...search(q || '', new Set([real.id])), ...others.filter((c) => pick.has(c.id))].map((c) => [c.id, c])).values()];
        const tot = [...pick].map((id) => stats(clientById(id) || { id })).reduce((a, x) => ({ n: a.n + x.n, liq: a.liq + x.liq }), { n: 0, liq: 0 });
        body.innerHTML = `<div class="hint">✓ Queda: <b>${esc(real.name)}</b> <span class="muted">${info(real)}</span> <button type="button" class="btn btn-sm" id="mgChange">Cambiar</button></div>
          <div class="section-title" style="margin:12px 0 6px">2 · Marca los repetidos</div>
          <input id="mgQ" class="input" placeholder="Buscar otro cliente para agregar…" value="${esc(q || '')}" autocomplete="off">
          <div class="pick-list" style="margin-top:8px">${cands.map((c) => `<label class="sug-item" style="grid-template-columns:auto 1fr;gap:10px;align-items:center"><input type="checkbox" data-dup="${esc(c.id)}" ${pick.has(c.id) ? 'checked' : ''} style="width:22px;height:22px"><span><b>${esc(c.name)}</b><small style="display:block">${info(c)}</small></span></label>`).join('') || '<p class="muted">No hay clientes parecidos. Búscalo por nombre.</p>'}</div>
          <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="mgGo" ${pick.size ? '' : 'disabled'}>🔗 Fusionar ${pick.size || ''} en «${esc(real.name)}»${pick.size ? ` · ${tot.n} pedido(s)` : ''}</button></div>`;
      }
      const qi = body.querySelector('#mgQ'); if (qi) { qi.oninput = () => { const v = qi.value, pos = qi.selectionStart; draw(v); const n = body.querySelector('#mgQ'); n.focus(); n.setSelectionRange(pos, pos); }; }
    };
    body.addEventListener('click', async (e) => {
      const r = e.target.closest('[data-real]'); if (r) { real = clientById(r.dataset.real); pick.clear(); draw(''); return; }
      if (e.target.closest('#mgChange')) { real = null; pick.clear(); draw(''); return; }
      const go = e.target.closest('#mgGo');
      if (go) {
        const dups = [...pick].map((id) => clientById(id)).filter(Boolean);
        if (!confirm(`Fusionar en «${real.name}»:\n\n${dups.map((d) => `• ${d.name} (${stats(d).n} pedido(s))`).join('\n')}\n\nSus pedidos y vacíos pasan a «${real.name}» y estos clientes se eliminan. ¿Continuar?`)) return;
        go.disabled = true; go.textContent = 'Fusionando…';
        try {
          const res = await Clientes.merge(real, dups);
          sh.close(); toast(`Listo: ${res.orders} pedido(s) pasados a ${real.name}${res.kardex ? ' · ' + res.kardex + ' movimiento(s) de vacíos' : ''}`, 'ok');
          if (root) renderClients(root);
        } catch (err) { toast(err.message, 'err'); go.disabled = false; draw(''); }
      }
    });
    body.addEventListener('change', (e) => { const c = e.target.closest('[data-dup]'); if (c) { if (c.checked) pick.add(c.dataset.dup); else pick.delete(c.dataset.dup); draw(body.querySelector('#mgQ') ? body.querySelector('#mgQ').value : ''); } });
    draw('');
  }

  /** Opciones de vendedor para un cliente, con "Sin vendedor" (nunca se muestra uno que no tiene). */
  function sellerOptions(cur) {
    const known = sellerById(cur);
    return `<option value="" ${known ? '' : 'selected'}>— Sin vendedor —</option>` +
      S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}${s.active === false ? ' (inactivo)' : ''}</option>`).join('');
  }
  /**
   * Guarda un cliente. Si cambia de vendedor, recuerda el anterior
   * (formerSellerIds): así su teléfono también se entera y deja de mostrarlo.
   */
  async function saveClient(prev, next) {
    const from = prev && prev.sellerId, to = next.sellerId;
    if (prev && from && from !== to) next.formerSellerIds = [...new Set([...(prev.formerSellerIds || []), from])].filter((x) => x !== to);
    await saveDocs('clients', next);
    if (prev && from !== to) {
      const name = (id) => (sellerById(id) || {}).name || 'sin vendedor';
      await log('cliente_reasignado', `Cliente ${next.name}: ${name(from)} → ${name(to)}`, { clientId: next.id, clientName: next.name });
    }
  }

  /* ============================== HISTORIAL ============================== */
  const EVENT_LABEL = {
    apertura: 'Abrió la app', regreso: 'Volvió', entrada: 'Entró a su ruta', salida: 'Salió', cliente_nuevo: 'Cliente nuevo',
    pedido_nuevo: 'Abrió pedido', pedido_enviado: 'Envió pedido', pedido_reabierto: 'Reabrió pedido', pedido_modificado: 'Modificó pedido',
    pedido_eliminado: 'Eliminó pedido', cliente_editado: 'Actualizó cliente', cliente_corregido: 'Corrigió cliente', clientes_fusionados: 'Fusionó clientes', cliente_eliminado: 'Eliminó cliente', vendedor_pausa: 'Pausa de pedidos', espera: 'Puso en espera', reincorporado: 'Reincorporó', movido: 'Movió de hoja',
    pedido_editado_oficina: 'Ajuste de oficina', carga_estado: 'Estado de hoja', cliente_reasignado: 'Reasignó cliente', respaldo: 'Respaldo',
    datos_borrados: 'Datos borrados por el navegador', nota_valery: 'Nota Valery', retornables: 'Retornables', mensaje: 'Mensaje a vendedor', liquidacion: 'Liquidación', vacios: 'Kardex de vacíos',
  };
  async function renderHistory(root) {
    const f = U().hist || (U().hist = { day: today(), who: '', type: '' });
    const dayEvents = (await DB.getAll('events')).filter((e) => e.day === f.day).sort((a, b) => String(a.at).localeCompare(String(b.at)));
    const list = dayEvents.filter((e) => (!f.who || e.sellerId === f.who) && (!f.type || e.type === f.type));
    const hhmm = (iso) => new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
    const whoOpts = [['', 'Todos'], ...S.sellers.map((s) => [s.id, s.name]), ['oficina', 'Oficina']];
    // Resumen del día por persona
    const people = new Map();
    dayEvents.forEach((e) => {
      const p = people.get(e.sellerId) || { name: e.sellerName, first: e.at, last: e.at, sent: 0, del: 0, amount: 0, n: 0 };
      p.last = e.at; p.n++;
      if (e.type === 'pedido_enviado') { p.sent++; p.amount += +e.amount || 0; }
      if (e.type === 'pedido_eliminado') p.del++;
      people.set(e.sellerId, p);
    });
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    root.innerHTML = `
      <div class="toolbar" id="hFilters">
        <label class="field"><span>Día</span><input type="date" class="input" data-h="day" value="${esc(f.day)}"></label>
        <label class="field"><span>Quién</span><select class="select" data-h="who">${opt(whoOpts, f.who)}</select></label>
        <label class="field"><span>Acción</span><select class="select" data-h="type"><option value="">Todas</option>${opt(Object.entries(EVENT_LABEL), f.type)}</select></label>
        <button class="btn" id="hCsv" ${list.length ? '' : 'disabled'}>⇩ Exportar a Excel</button>
      </div>
      <p class="muted">Lo registra cada teléfono y PC con su hora; llega al sincronizar (si un vendedor estuvo sin señal, aparece cuando la recupere). Nadie puede editarlo ni borrarlo.</p>
      ${people.size ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Quién</th><th>Primera actividad</th><th>Última</th><th>Pedidos enviados</th><th>Eliminados</th><th>Monto enviado</th></tr></thead><tbody>
        ${[...people.values()].sort((a, b) => a.first.localeCompare(b.first)).map((p) => `<tr><td><b>${esc(p.name)}</b></td><td data-l="Primera actividad">${hhmm(p.first)}</td><td data-l="Última">${hhmm(p.last)}</td><td class="n" data-l="Pedidos enviados">${p.sent}</td><td class="n" data-l="Eliminados">${p.del}</td><td class="n" data-l="Monto enviado">${usd(p.amount)}</td></tr>`).join('')}
        </tbody></table></div>` : ''}
      ${list.length ? `<div class="card" style="overflow:auto;margin-top:12px"><table class="inv"><thead><tr><th>Hora · Quién</th><th>Acción</th><th>Detalle</th></tr></thead><tbody>
        ${list.map((e) => `<tr><td class="mono"><b>${hhmm(e.at)}</b> · ${esc(e.sellerName)}</td><td data-l="Acción">${esc(EVENT_LABEL[e.type] || e.type)}</td><td>${esc(e.text)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="empty card"><strong>Sin actividad</strong>ese día con esos filtros.</div>'}`;
    $('#hFilters').onchange = (e) => { const k = e.target.dataset.h; if (k) { f[k] = e.target.value; renderHistory(root); } };
    $('#hCsv').onclick = () => Exporta.save('historial_' + f.day + '.xlsx', [Exporta.table({ name: 'Historial', title: 'HISTORIAL DE ACTIVIDAD', subtitle: fmtDate(f.day),
      cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'HORA', w: 8, align: 'center' }, { h: 'QUIÉN', w: 20 }, { h: 'ACCIÓN', w: 26 }, { h: 'DETALLE', w: 80 }, { h: 'EQUIPO', w: 22 }],
      rows: list.map((e) => [e.day, hhmm(e.at), e.sellerName, EVENT_LABEL[e.type] || e.type, e.text, e.deviceId || '']) })]);
  }

  // Ficha completa (la misma del vendedor, con vendedor, crédito y estado): clientes.js
  function clientForm(c, root) {
    Clientes.formSheet(c || null, { mode: 'office', defaults: { sellerId: U().cliSeller && U().cliSeller !== '__none' ? U().cliSeller : '' },
      onSave: async (prev, next) => { await saveClient(prev, next); if (!prev) await log('cliente_nuevo', `Registró el cliente ${next.name}${next.rif ? ' (' + next.rif + ')' : ''}`, { clientId: next.id, clientName: next.name }); },
      onSaved: () => renderClients(root) });
  }

  /* ============================= VENDEDORES ============================= */
  function renderSellers(root) {
    const routes = S.config.routes || [];
    root.innerHTML = `
      <div class="card card-pad" style="max-width:820px">
        <p class="muted" style="margin-top:0">Los vendedores activos aparecen en el menú de inicio (sin contraseña). Marca las rutas que atiende cada uno.</p>
        <form id="sNew" class="row" style="margin-bottom:14px"><input class="input grow" name="n" placeholder="Nombre (ej: María P.)" maxlength="30" required><button class="btn btn-primary">＋ Agregar</button></form>
        ${S.sellers.slice().sort((a, b) => a.name.localeCompare(b.name, 'es')).map((s) => `
          <div class="seller-row" data-sid="${esc(s.id)}">
            <div class="row"><input class="input grow" data-rename value="${esc(s.name)}" maxlength="30" aria-label="Nombre">
              <label class="row" style="white-space:nowrap"><input type="checkbox" data-active ${s.active ? 'checked' : ''} style="width:22px;height:22px"> Activo</label></div>
            <div class="row wrap">${routes.map((r) => `<label class="chip-check"><input type="checkbox" data-route="${esc(r)}" ${(s.routes || []).includes(r) ? 'checked' : ''}> ${esc(r)}</label>`).join('')}</div>
            <div class="row wrap" style="gap:8px;align-items:center"><span class="muted grow" style="font-size:13px">${S.clients.filter((c) => c.sellerId === s.id).length} clientes en cartera · ${pendingOf(s.id).clients} clientes / ${nf0.format(pendingOf(s.id).cajas)} cajas por despachar</span>
              ${pausedUntil(s) ? `<span class="status over">⏸ En pausa hasta ${esc(fmtPause(pausedUntil(s)))}</span><button type="button" class="btn btn-sm btn-ok" data-resume="${esc(s.id)}">▶ Reactivar</button>`
                : `<button type="button" class="btn btn-sm" data-pause="${esc(s.id)}">⏸ Suspender pedidos</button>`}</div>
          </div>`).join('')}
      </div>`;
    $('#sNew').onsubmit = async (e) => {
      e.preventDefault(); const name = e.target.n.value.trim(); if (!name) return;
      await saveDocs('sellers', { id: DB.uid('s'), name, routes: [], aliases: [], active: true, deleted: false });
      renderSellers(root); toast('Vendedor agregado', 'ok');
    };
    root.onclick = async (e) => {
      const p = e.target.closest('[data-pause]'); if (p) { pauseDialog(sellerById(p.dataset.pause), () => renderSellers(root)); return; }
      const r = e.target.closest('[data-resume]');
      if (r) {
        const s = sellerById(r.dataset.resume);
        await saveDocs('sellers', { ...s, suspendedUntil: '', suspendNote: '' });
        await log('vendedor_pausa', `Reactivó la subida de pedidos de ${s.name}`, { sellerId: s.id });
        toast(`${s.name} puede volver a subir pedidos (se le avisa al teléfono)`, 'ok'); PV.runSync(false); renderSellers(root);
      }
    };
    root.onchange = async (e) => {
      const row = e.target.closest('[data-sid]'); if (!row) return;
      const s = { ...sellerById(row.dataset.sid) };
      if (e.target.matches('[data-rename]')) { const v = e.target.value.trim(); if (!v) return; s.name = v; }
      if (e.target.matches('[data-active]')) s.active = e.target.checked;
      if (e.target.matches('[data-route]')) s.routes = [...row.querySelectorAll('[data-route]:checked')].map((x) => x.dataset.route);
      await saveDocs('sellers', s); toast('Guardado', 'ok');
    };
  }

  /* ---------------- Pausa de pedidos de un vendedor ---------------- */
  // Pedidos enviados del vendedor que aún no se despachan (en hojas o en espera)
  function pendingOf(sid) {
    const os = S.orders.filter((o) => o.sellerId === sid && !o.deleted && ['enviado', 'en_carga', 'en_espera'].includes(o.status) && Matrix.orderTotals(o).items);
    const loads = new Set(os.map((o) => o.loadId).filter(Boolean));
    return { clients: new Set(os.map((o) => o.clientId || o.clientKey)).size, cajas: os.reduce((a, o) => a + Matrix.orderTotals(o).cajas, 0), loads: loads.size };
  }
  const pausedUntil = (s) => (s && s.suspendedUntil && Date.parse(s.suspendedUntil) > Date.now() ? s.suspendedUntil : '');
  const fmtPause = (iso) => { const d = new Date(iso), far = d - Date.now() > 20 * 86400000; return far ? 'que la reactives' : (d.toDateString() !== new Date().toDateString() ? d.toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric' }) + ' ' : '') + d.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }); };
  function pauseDialog(s, onDone) {
    if (!s) return;
    const p = pendingOf(s.id);
    const sh = openSheet(`
      <div class="row"><h2 class="grow">⏸ Suspender pedidos · ${esc(s.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="hint">Tiene <b>${p.clients} cliente(s)</b> y <b>${nf0.format(p.cajas)} cajas</b> por despachar en ${p.loads} hoja(s). Mientras dure la pausa no puede subir pedidos nuevos (lo que tenga sin enviar queda guardado) y ve este mensaje con sus cifras reales.</div>
      <div class="field"><span>¿Por cuánto tiempo?</span><div class="chips" id="paDur">
        ${[[1, '1 hora'], [2, '2 horas'], [3, '3 horas'], [4, '4 horas'], [6, '6 horas'], ['manana', 'Hasta mañana 7:00'], ['manual', 'Hasta que lo reactive']].map(([v, l], i) => `<button type="button" class="chip ${i === 1 ? 'active' : ''}" data-h="${v}">${l}</button>`).join('')}</div></div>
      <label class="field"><span>Nota para el vendedor (opcional)</span><input id="paNote" class="input" maxlength="120" placeholder="Ej: hasta despachar las hojas del martes"></label>
      <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn btn-danger" id="paGo">⏸ Suspender</button></div>`);
    let h = '2';
    sh.el.querySelector('#paDur').onclick = (e) => { const b = e.target.closest('[data-h]'); if (!b) return; h = b.dataset.h; sh.el.querySelectorAll('#paDur .chip').forEach((x) => x.classList.toggle('active', x === b)); };
    sh.el.querySelector('#paGo').onclick = async () => {
      const d = new Date();
      if (h === 'manana') { d.setDate(d.getDate() + 1); d.setHours(7, 0, 0, 0); } else if (h === 'manual') d.setDate(d.getDate() + 60); else d.setTime(d.getTime() + +h * 3600000);
      const note = sh.el.querySelector('#paNote').value.trim();
      await saveDocs('sellers', { ...s, suspendedUntil: d.toISOString(), suspendNote: note, suspendedAt: DB.now(), suspendedBy: (S.config && S.config.adminName) || 'Oficina' });
      await log('vendedor_pausa', `Suspendió la subida de pedidos de ${s.name} hasta ${fmtPause(d.toISOString())} · ${p.clients} clientes / ${p.cajas} cajas por despachar${note ? ' · ' + note : ''}`, { sellerId: s.id });
      sh.close(); toast(`${s.name} en pausa hasta ${fmtPause(d.toISOString())} (se le avisa al teléfono)`, 'ok'); PV.runSync(false);
      if (onDone) onDone();
    };
  }

  /* =============================== AJUSTES =============================== */
  function listEditor(id, items, placeholder) {
    return `<div class="list-edit" id="${id}">${items.map((it, i) => `<div class="row"><input class="input grow" data-i="${i}" value="${esc(it)}">
      <button type="button" class="btn btn-sm" data-up="${i}" ${i ? '' : 'disabled'}>↑</button><button type="button" class="btn btn-sm btn-danger" data-rm="${i}">✕</button></div>`).join('')}
      <div class="row"><input class="input grow" data-new placeholder="${esc(placeholder)}"><button type="button" class="btn btn-sm" data-add>＋</button></div></div>`;
  }
  function bindList(el, get, set) {
    el.addEventListener('click', async (e) => {
      const arr = get().slice();
      const up = e.target.closest('[data-up]'), rm = e.target.closest('[data-rm]'), add = e.target.closest('[data-add]');
      if (up) { const i = +up.dataset.up; [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; }
      else if (rm) { if (!confirm('¿Quitar "' + arr[+rm.dataset.rm] + '"?')) return; arr.splice(+rm.dataset.rm, 1); }
      else if (add) { const v = el.querySelector('[data-new]').value.trim(); if (!v) return; arr.push(v); }
      else return;
      await set(arr);
    });
    el.addEventListener('change', async (e) => {
      const inp = e.target.closest('[data-i]'); if (!inp || !inp.value.trim()) return;
      const arr = get().slice(); arr[+inp.dataset.i] = inp.value.trim(); await set(arr);
    });
  }

  function renderSettings(root) {
    const c = S.config, st = S.settings, L = Loads.limits(c);
    root.innerHTML = `
      <div class="settings">
        <section class="card card-pad"><h3>Paquete de arranque / respaldo</h3>
          <p class="muted">Carga el catálogo, la cartera de clientes, las rutas y los despachadores de una sola vez, o importa los pedidos que un vendedor envió por WhatsApp.</p>
          <div class="row wrap"><button class="btn btn-primary" id="bImp">⇩ Importar paquete (.json)</button>
            <button class="btn" id="bAll">⇪ Respaldo de este equipo</button><button class="btn" id="bCat">⇪ Paquete para teléfonos</button></div></section>

        <section class="card card-pad"><h3>🛡 Servidor y respaldo</h3>
          <p class="muted">Comprueba que la base de datos (Supabase) responde y tiene todo guardado, y descarga un <b>respaldo completo del servidor</b>: todos los pedidos, clientes, cargas, catálogo e historial de todos los equipos. Guárdalo al menos una vez por semana fuera de la PC (Drive, correo, USB). Se restaura con «Importar paquete».</p>
          <div class="row wrap"><button class="btn" id="hCheck">🔎 Revisar estado del servidor</button>
            <button class="btn btn-primary" id="hBackup">⇩ Descargar respaldo del servidor</button></div>
          <div id="hOut" class="muted" style="margin-top:10px"></div></section>

        <section class="card card-pad" id="dgCard"><h3>🩺 Diagnóstico de sincronización</h3>
          <p class="muted">Compara lo que tiene esta PC con lo que tiene el servidor. Úsalo cuando dos PCs no muestran lo mismo: en la PC que tiene los datos completos, «Subir»; en la que le faltan, «Bajar».</p>
          <div class="row wrap"><button class="btn btn-primary" id="dgRun">🩺 Revisar esta PC</button></div>
          <div id="dgOut" style="margin-top:10px"></div></section>

        <section class="card card-pad"><h3>⚠ Reiniciar datos (empezar de cero)</h3>
          <p class="muted">Para borrar los datos de prueba antes de empezar a trabajar en serio. Se borra en el servidor y en <b>todos</b> los equipos (oficina, vendedores y supervisor) en su próxima sincronización, incluido lo que tenían sin enviar de antes del reinicio (lo que un vendedor sin señal haga después se conserva). No se puede deshacer: descarga antes el respaldo.</p>
          <label style="display:flex;gap:8px;align-items:flex-start;margin-top:6px"><input type="radio" name="rsMode" value="pedidos" checked> Pedidos, hojas de carga, historial, kardex de vacíos y numeración (se conservan catálogo, clientes, vendedores y ajustes)</label>
          <label style="display:flex;gap:8px;align-items:flex-start;margin-top:6px"><input type="radio" name="rsMode" value="todo"> Todo (después cargas de nuevo el paquete de arranque)</label>
          <div class="row" style="margin-top:10px"><button class="btn btn-danger" id="rsGo">Reiniciar datos…</button></div>
          <div id="rsOut" class="muted" style="margin-top:10px"></div></section>

        <section class="card card-pad"><h3>Hoja de carga</h3>
          <div class="grid3">
            <label class="field"><span>Tope por hoja</span><input id="lLimit" class="input" inputmode="numeric" value="${L.limit}"></label>
            <label class="field"><span>Medida</span><select id="lMeasure" class="select">
              <option value="bultos" ${L.measure === 'bultos' ? 'selected' : ''}>Bultos (cajas + unid. sueltas)</option>
              <option value="unidades" ${L.measure === 'unidades' ? 'selected' : ''}>Unidades totales</option></select></label>
            <label class="field"><span>Máx. clientes por hoja</span><input id="lMax" class="input" inputmode="numeric" value="${L.maxClients}"></label>
          </div>
          <label class="field" style="margin-top:10px"><span>Columnas en blanco al final de la hoja impresa (separadas por coma)</span>
            <input id="lExtra" class="input" value="${esc((c.sheetExtraCols || ['VACÍOS', 'DEVOLUCIÓN']).join(', '))}" placeholder="VACÍOS, DEVOLUCIÓN"></label></section>

        <section class="card card-pad"><h3>Estados de la carga</h3>
          <p class="muted">Tú defines los estados y su orden. <b>🔒 Bloquea</b>: desde ese estado vendedores y oficina ya no pueden editar los pedidos.
            <b>Cierra la carga</b>: descuenta el inventario, fija la fecha de la carga y la pasa al Archivo.</p>
          <div class="list-edit" id="stEd">${Loads.statuses(c).map((x, i, arr) => `<div class="row wrap st-row" data-i="${i}">
            <input class="input grow" data-st="name" value="${esc(x.name)}" maxlength="40">
            <label class="chip-check"><input type="checkbox" data-st="locked" ${x.locked ? 'checked' : ''}> 🔒 Bloquea</label>
            <label class="chip-check"><input type="checkbox" data-st="closing" ${x.closing ? 'checked' : ''}> Cierra la carga</label>
            <button type="button" class="btn btn-sm" data-stup="${i}" ${i ? '' : 'disabled'}>↑</button>
            <button type="button" class="btn btn-sm btn-danger" data-strm="${i}" ${arr.length > 2 ? '' : 'disabled'}>✕</button></div>`).join('')}
            <div class="row"><input class="input grow" id="stNew" placeholder="Nuevo estado (ej. En ruta, Entregada, Liquidada)"><button type="button" class="btn btn-sm" id="stAdd">＋</button></div>
          </div></section>

        <section class="card card-pad"><h3>Rutas</h3>${listEditor('routesEd', c.routes || [], 'Nueva ruta')}</section>
        <section class="card card-pad"><h3>Despachadores</h3>${listEditor('dispEd', (c.dispatchers || []).map((d) => d.name), 'Nuevo despachador')}</section>
        <section class="card card-pad"><h3>Categorías (orden del catálogo y de la hoja de carga)</h3>
          <p class="muted">Para ordenar también los productos dentro de cada categoría usa Inventario → ↕ Ordenar catálogo.</p>
          ${listEditor('rubEd', c.rubros || [], 'Nueva categoría')}</section>

        <section class="card card-pad"><h3>Mi perfil de administrador</h3>
          <div class="grid2">
            <label class="field"><span>Nombre para el saludo</span><input id="adName" class="input" maxlength="30" value="${esc(c.adminName || '')}" placeholder="Daniela"></label>
            <label class="field"><span>Pie de página (créditos)</span><input id="adFooter" class="input" maxlength="140" value="${esc(c.footer || '')}"></label>
          </div>
          <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="adSave">Guardar</button></div></section>

        <section class="card card-pad"><h3>🔒 Seguridad de la oficina</h3>
          <p class="muted">Con PIN, la oficina se bloquea al salir y tras ${LOCK_MIN} minutos sin uso. Es por equipo: configúralo en cada PC de oficina.</p>
          <div class="grid3">
            ${S.officePin ? '<label class="field"><span>PIN actual</span><input id="pinCur" class="input" type="password" inputmode="numeric" maxlength="12"></label>' : ''}
            <label class="field"><span>${S.officePin ? 'PIN nuevo' : 'Crear PIN (4 a 12 dígitos)'}</span><input id="pinNew" class="input" type="password" inputmode="numeric" maxlength="12"></label>
            <label class="field"><span>Repetir PIN</span><input id="pinNew2" class="input" type="password" inputmode="numeric" maxlength="12"></label>
          </div>
          <div class="row wrap" style="margin-top:12px"><button class="btn btn-primary" id="pinSave">${S.officePin ? 'Cambiar PIN' : 'Activar PIN'}</button>
            ${S.officePin ? '<button class="btn btn-danger" id="pinDel">Quitar PIN</button><button class="btn" id="pinLock">🔒 Bloquear ahora</button>' : ''}</div></section>

        <section class="card card-pad"><h3>Empresa (aparece en hojas y notas)</h3>
          <div class="grid2">
            <label class="field"><span>Razón social</span><input id="coName" class="input" value="${esc(c.company.name)}"></label>
            <label class="field"><span>RIF</span><input id="coRif" class="input" value="${esc(c.company.rif)}"></label>
            <label class="field"><span>Teléfono</span><input id="coPhone" class="input" value="${esc(c.company.phone)}"></label>
            <label class="field"><span>Dirección</span><input id="coAddr" class="input" value="${esc(c.company.address)}"></label>
          </div>
          <div class="grid3" style="margin-top:10px">
            <label class="field"><span>Tasa Bs por USD</span><input id="cRate" class="input" inputmode="decimal" value="${c.exchangeRate ? nf2.format(c.exchangeRate) : ''}" placeholder="BCV del día"></label>
            <label class="field"><span>Fecha lista de precios</span><input id="cPl" type="date" class="input" value="${esc(c.priceListDate || '')}"></label>
          </div>
          <div class="row" style="margin-top:12px"><button class="btn btn-primary" id="coSave">Guardar</button></div></section>

        <section class="card card-pad"><h3>🧾 Impresora de tickets · notas de despacho</h3>
          <p class="muted">Impresora térmica de 80 mm (POS-80 / Roccia RC-8002). Sale un ticket por cliente y la impresora corta entre uno y otro. Esta configuración es de este equipo.</p>
          <div class="grid2">
            <label class="field"><span>Ancho del papel</span><select id="tWidth" class="select"><option value="80" ${(st.ticket || {}).width !== 58 ? 'selected' : ''}>80 mm (área de impresión 72 mm)</option><option value="58" ${(st.ticket || {}).width === 58 ? 'selected' : ''}>58 mm</option></select></label>
            <label class="field"><span>Precios en la nota</span><select id="tPrices" class="select"><option value="1" ${(st.ticket || {}).prices !== false ? 'selected' : ''}>Con precios y total $ / Bs</option><option value="0" ${(st.ticket || {}).prices === false ? 'selected' : ''}>Sin precios (solo cantidades)</option></select></label>
            <label class="field"><span>Copias por cliente</span><select id="tCopies" class="select"><option value="1" ${(st.ticket || {}).copies !== 2 ? 'selected' : ''}>1 (cliente)</option><option value="2" ${(st.ticket || {}).copies === 2 ? 'selected' : ''}>2 (original cliente + copia empresa)</option></select></label>
          </div>
          <div class="row wrap" style="margin-top:12px"><button class="btn" id="tTest">🖨 Imprimir ticket de prueba</button></div>
          <details style="margin-top:10px"><summary><b>Cómo dejarla lista (una sola vez)</b></summary>
            <ol class="muted" style="margin:8px 0 0;padding-left:18px">
              <li>En la ventana de impresión de Chrome elige <b>POS-80</b>, papel <b>80(72) x 3276 mm</b>, márgenes <b>Ninguno</b>, escala <b>100</b> o <b>Predeterminada</b> y desmarca <b>Encabezados y pies de página</b>. Chrome lo recuerda.</li>
              <li>En Windows → Impresoras → POS-80 → Propiedades → <b>Configuración del dispositivo</b>: <b>Cash Drawer</b> = no abrir, <b>Paper Cutting</b> = After one page (corta entre clientes), <b>Blank space at page's end</b> = Do not print, <b>Feed distance after print</b> = feed 5–10 mm para ahorrar papel.</li>
              <li>Para imprimir <b>sin la ventana de impresión</b> en la PC de despacho: pon POS-80 como impresora predeterminada y abre la app con un acceso directo de Chrome que tenga <code>--kiosk-printing</code> (la hoja de carga en carta imprímela desde el Chrome normal).</li>
            </ol></details></section>
        <section class="card card-pad"><h3>Sincronización</h3>
          <p class="muted">La clave admin permite a este equipo publicar catálogo, clientes, precios, rutas y cargas hacia los teléfonos.</p>
          ${st.syncKey && !st.adminKey ? '<div class="hint warn">⚠ <b>Falta la clave admin.</b> Sin ella, lo que hace esta PC (hojas de carga, pedidos movidos, liquidaciones, clientes) <b>se queda solo aquí</b>: no se sube al servidor ni lo ven las otras PCs. Escríbela y pulsa Guardar: todo lo pendiente se sube solo.</div>' : ''}
          ${st.syncUrl && st.syncUrl.trim() !== Sync.DEFAULT_SYNC_URL ? `<div class="hint warn">⚠ Esta PC usa otro servidor: <code>${esc(st.syncUrl)}</code>. Para ver los mismos datos que las demás, deja la URL en blanco.</div>` : ''}
          <div class="grid2">
            <label class="field"><span>Clave de sync (todos)</span><input id="sKey" class="input" type="password" autocomplete="off" value="${esc(st.syncKey)}"></label>
            <label class="field"><span>Clave admin (oficina)</span><input id="sAdmin" class="input" type="password" autocomplete="off" value="${esc(st.adminKey)}"></label>
            <label class="field"><span>URL del servidor</span><input id="sUrl" class="input" placeholder="${esc(Sync.DEFAULT_SYNC_URL)}" value="${esc(st.syncUrl)}"></label>
            <label class="field"><span>Excel</span><select id="sSep" class="select">
              <option value=";|," ${st.csvSep === ';' ? 'selected' : ''}>Excel en español ( ; y coma decimal)</option>
              <option value=",|." ${st.csvSep === ',' ? 'selected' : ''}>Excel en inglés ( , y punto decimal)</option></select></label>
          </div>
          <div class="row wrap" style="margin-top:12px"><button class="btn btn-primary" id="sSave">Guardar y sincronizar</button><span class="muted" id="sLast"></span></div></section>
        <p class="muted" style="font-size:13px">Almacenamiento: ${DB.isFallback ? 'localStorage (limitado)' : 'IndexedDB'} · ${S.persisted ? '🛡 protegido contra borrado' : 'sin protección contra borrado'} · ${S.products.length} productos · ${S.clients.length} clientes · ${S.orders.length} pedidos</p>
        ${S.persisted === false ? `<div class="hint warn">${PV.PERSIST_HINT}</div>` : ''}
      </div>`;

    const saveCfg = async (patch) => { await saveDocs('config', { ...S.config, ...patch }); renderSettings(root); toast('Guardado', 'ok'); };
    const tSave = async () => { await PV.saveSettings({ ticket: { width: +$('#tWidth').value === 58 ? 58 : 80, prices: $('#tPrices').value === '1', copies: +$('#tCopies').value === 2 ? 2 : 1 } }); toast('Impresora de tickets guardada', 'ok'); };
    ['#tWidth', '#tPrices', '#tCopies'].forEach((x) => { $(x).onchange = tSave; });
    $('#tTest').onclick = () => Print.printTestTicket({ config: S.config, clientsById: byIdMap(S.clients), productsById: byIdMap(S.products) }, S.settings.ticket);
    const lSave = () => saveCfg({ load: { limit: Math.max(1, int($('#lLimit').value)), maxClients: Math.max(1, int($('#lMax').value)), measure: $('#lMeasure').value } });
    ['#lLimit', '#lMax', '#lMeasure'].forEach((s) => { $(s).onchange = lSave; });
    $('#lExtra').onchange = (e) => saveCfg({ sheetExtraCols: e.target.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean).slice(0, 6) });
    // ---- Estados de la carga ----
    const stSave = async (list) => {
      list = list.map((x) => ({ ...x, locked: x.locked || x.closing })); // cerrar implica bloquear
      if (!list.some((x) => !x.locked)) { toast('Debe existir al menos un estado editable (sin 🔒)', 'err'); return renderSettings(root); }
      if (!list.some((x) => x.closing)) { toast('Debe existir al menos un estado que cierre la carga', 'err'); return renderSettings(root); }
      await saveCfg({ loadStatuses: list });
    };
    const stList = () => Loads.statuses(S.config).map((x) => ({ ...x }));
    $('#stEd').onchange = (e) => {
      const row = e.target.closest('[data-i]'); if (!row) return;
      const list = stList(); const x = list[+row.dataset.i]; const k = e.target.dataset.st;
      if (k === 'name') { if (!e.target.value.trim()) return; x.name = e.target.value.trim(); } else x[k] = e.target.checked;
      stSave(list);
    };
    $('#stEd').onclick = (e) => {
      const up = e.target.closest('[data-stup]'), rm = e.target.closest('[data-strm]');
      const list = stList();
      if (up) { const i = +up.dataset.stup; [list[i - 1], list[i]] = [list[i], list[i - 1]]; stSave(list); }
      if (rm) {
        const x = list[+rm.dataset.strm];
        if (S.loads.some((l) => !l.deleted && l.status === x.id)) { toast('Hay hojas en "' + x.name + '": cámbialas de estado antes de borrarlo', 'err'); return; }
        if (!confirm('¿Eliminar el estado "' + x.name + '"?')) return;
        list.splice(+rm.dataset.strm, 1); stSave(list);
      }
    };
    $('#stAdd').onclick = () => {
      const v = $('#stNew').value.trim(); if (!v) return;
      const list = stList(); list.push({ id: DB.uid('st').slice(0, 14), name: v, locked: true, closing: false }); stSave(list);
    };
    bindList($('#routesEd'), () => S.config.routes || [], (arr) => saveCfg({ routes: arr }));
    bindList($('#rubEd'), () => S.config.rubros || [], (arr) => saveCfg({ rubros: arr }));
    bindList($('#dispEd'), () => (S.config.dispatchers || []).map((d) => d.name), (names) => {
      const prev = S.config.dispatchers || [];
      return saveCfg({ dispatchers: names.map((n) => prev.find((d) => d.name === n) || { id: DB.uid('d'), name: n }) });
    });
    const pinOk = async () => !S.officePin || (await pinHash(($('#pinCur') || {}).value || '')) === S.officePin;
    $('#pinSave').onclick = async () => {
      const a = $('#pinNew').value, b = $('#pinNew2').value;
      if (!(await pinOk())) return toast('PIN actual incorrecto', 'err');
      if (!/^\d{4,12}$/.test(a)) return toast('El PIN debe tener de 4 a 12 dígitos', 'err');
      if (a !== b) return toast('Los PIN no coinciden', 'err');
      S.officePin = await pinHash(a); await DB.setMeta('officePin', S.officePin); touchUnlock();
      toast('PIN activado', 'ok'); renderSettings(root);
    };
    const pd = $('#pinDel'); if (pd) pd.onclick = async () => {
      if (!(await pinOk())) return toast('Escribe el PIN actual para quitarlo', 'err');
      S.officePin = ''; await DB.setMeta('officePin', ''); toast('PIN eliminado'); renderSettings(root);
    };
    const pl = $('#pinLock'); if (pl) pl.onclick = () => { lockOffice(); PV.render(); };
    $('#adSave').onclick = () => saveCfg({ adminName: $('#adName').value.trim(), footer: $('#adFooter').value.trim() });
    $('#coSave').onclick = () => saveCfg({
      company: { ...S.config.company, name: $('#coName').value.trim(), rif: $('#coRif').value.trim(), phone: $('#coPhone').value.trim(), address: $('#coAddr').value.trim() },
      exchangeRate: dec($('#cRate').value), priceListDate: $('#cPl').value,
    });
    DB.getMeta('lastSyncAt', null).then((t) => { const el = $('#sLast'); if (el && t) el.textContent = 'Último sync: ' + new Date(t).toLocaleString('es-VE'); });
    $('#sSave').onclick = async () => {
      const [sep, decimal] = $('#sSep').value.split('|');
      await PV.saveSettings({ syncKey: $('#sKey').value.trim(), adminKey: $('#sAdmin').value.trim(), syncUrl: $('#sUrl').value.trim(), csvSep: sep, csvDecimal: decimal });
      // Con clave admin, esta PC podrá recuperarla sola si el navegador borra sus datos
      if (S.settings.adminKey) PV.rememberOffice(true).catch(() => {}); else PV.forgetOffice().catch(() => {});
      await PV.runSync(true); renderSettings(root);
    };
    $('#bImp').onclick = importStarter;
    $('#dgRun').onclick = () => runDiagnosis();
    drawDiagnosis();
    const KIND_LABEL = { orders: 'Pedidos', clients: 'Clientes', products: 'Productos', sellers: 'Vendedores', loads: 'Hojas de carga', config: 'Configuración', events: 'Historial' };
    $('#hCheck').onclick = async () => {
      const out = $('#hOut'); out.textContent = 'Consultando…';
      const r = await Sync.adminCall('health');
      if (!r.ok) { out.innerHTML = `<b style="color:var(--danger,#e5484d)">✗ ${esc(r.error)}</b>`; return; }
      const d = r.data, tablesOk = ['DistCounter', 'DistDoc'].every((t) => d.tables.includes(t));
      out.innerHTML = `<div>${tablesOk ? '✅' : '❌'} Base de datos ${tablesOk ? 'con todas sus tablas' : 'SIN tablas: ' + esc(d.tables.join(', ') || 'ninguna')} · respuesta en ${d.latencyMs} ms</div>
        <table class="inv" style="margin-top:8px"><thead><tr><th>Tipo</th><th>Guardados</th><th>Eliminados</th><th>Último cambio</th></tr></thead><tbody>
        ${d.kinds.map((k) => `<tr><td>${esc(KIND_LABEL[k.kind] || k.kind)}</td><td class="n">${nf0.format(k.total)}</td><td class="n">${nf0.format(k.deleted)}</td><td>${k.last ? esc(new Date(k.last).toLocaleString('es-VE')) : ''}</td></tr>`).join('')}
        </tbody></table>
        <div style="margin-top:6px">Última carga numerada: <b>${d.counters.load ? esc(Loads.loadCode(d.counters.load)) : '—'}</b></div>`;
    };
    $('#hBackup').onclick = async () => {
      const out = $('#hOut'); out.textContent = 'Descargando respaldo…';
      const r = await Sync.serverBackup((n) => { out.textContent = `Descargando respaldo… ${nf0.format(n)} registros`; });
      if (!r.ok) { out.innerHTML = `<b style="color:var(--danger,#e5484d)">✗ ${esc(r.error)}</b>`; return; }
      await saveFile('respaldo_servidor_' + today() + '.json', JSON.stringify(r.bundle), 'application/json');
      await log('respaldo', `Descargó el respaldo completo del servidor (${r.count} registros)`);
      out.textContent = `✓ Respaldo descargado: ${nf0.format(r.count)} registros. Guárdalo fuera de esta PC.`;
    };
    $('#rsGo').onclick = async () => {
      const mode = ($('input[name="rsMode"]:checked') || {}).value || 'pedidos';
      const what = mode === 'todo' ? 'TODOS los datos (pedidos, hojas, historial, catálogo, clientes, vendedores y ajustes)' : 'todos los pedidos, hojas de carga, historial y la numeración';
      const typed = prompt(`Se borrarán ${what} del servidor y de todos los equipos. No se puede deshacer.\n\nEscribe REINICIAR para confirmar:`);
      if (typed === null) return;
      if (typed.trim().toUpperCase() !== 'REINICIAR') { toast('No se reinició: no escribiste REINICIAR', 'err'); return; }
      const out = $('#rsOut'); out.textContent = 'Reiniciando…';
      const r = await Sync.adminCall('reset', { mode, confirm: 'REINICIAR', day: today(), deviceId: await Sync.deviceId() });
      if (!r.ok) { out.innerHTML = `<b style="color:var(--danger,#e5484d)">✗ ${esc(r.error)}</b>`; return; }
      out.textContent = `✓ Datos reiniciados (${nf0.format(r.data.deleted)} registros borrados). Actualizando este equipo…`;
      PV.runSync(false); // borra la copia local, baja todo de nuevo y recarga la pantalla
    };
    $('#bAll').onclick = async () => saveFile('respaldo_' + today() + '.json', JSON.stringify(await Sync.exportBundle({ includeCatalog: true, includeLoads: true })), 'application/json');
    $('#bCat').onclick = async () => saveFile('catalogo_telefonos_' + today() + '.json', JSON.stringify(await Sync.exportBundle({ sellerId: '__none__', includeCatalog: true })), 'application/json');
  }
})();
