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

  const TABS = [['cargas', '🚚 Cargas'], ['pedidos', '🧾 Pedidos'], ['archivo', '🗄 Archivo'], ['inventario', '📦 Inventario'],
    ['clientes', '👥 Clientes'], ['vendedores', '🧑‍💼 Vendedores'], ['ajustes', '⚙ Ajustes']];

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
    const app = document.getElementById('app');
    const waiting = S.loads.filter((l) => !l.deleted && !Loads.isClosed(l)).length;
    app.innerHTML = `
      ${PV.brandHeader('Hola, ' + (S.config.adminName || 'administrador'), 'Oficina · Puerto Venado',
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/" id="offOut">Salir</a>`)}
      <nav class="tabs">${TABS.map(([k, l]) => `<a class="tab ${k === tab ? 'active' : ''}" href="#/oficina/${k}">${l}${k === 'cargas' && waiting ? ` <span class="count">${waiting}</span>` : ''}</a>`).join('')}</nav>
      <div class="container" id="officeBody"></div>
      ${PV.creditFooter()}`;
    $('#syncPill').onclick = () => PV.runSync(true);
    $('#offOut').onclick = () => lockOffice();
    $('#bell').onclick = notifSheet;
    PV.updateSyncPill(); PV.updateBell();
    const body = $('#officeBody');
    if (!S.products.length && tab !== 'ajustes') body.insertAdjacentHTML('beforebegin', setupBanner());
    ({ cargas: renderLoads, pedidos: renderOrders, archivo: renderArchive, inventario: renderInventory,
      clientes: renderClients, vendedores: renderSellers, ajustes: renderSettings })[tab](body);
    const sb = $('#setupImport');
    if (sb) sb.onclick = importStarter;
  };

  function notifSheet() {
    const list = S.notifs || [];
    const sh = openSheet(`<div class="row"><h2 class="grow">🔔 Notificaciones</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${'Notification' in window && Notification.permission !== 'granted' ? '<button class="btn btn-sm" id="nPerm">Activar avisos del sistema (aunque la pestaña esté en segundo plano)</button>' : ''}
      ${list.length ? `<div class="notif-list">${list.map((n) => `<div class="notif ${n.read ? '' : 'unread'} ${n.warn ? 'warn' : ''}"><span>${n.icon}</span><div class="grow">${esc(n.msg)}<small>${esc(new Date(n.at).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }))}</small></div></div>`).join('')}</div>
        <div class="actions"><button class="btn" id="nClear">Borrar todo</button></div>` : '<p class="muted">Sin notificaciones. Aquí verás pedidos nuevos, pedidos modificados por los vendedores y clientes duplicados.</p>'}`);
    PV.beep(); // habilita el audio del navegador tras un clic
    S.notifs = list.map((n) => ({ ...n, read: true })); DB.setMeta('notifs', S.notifs); PV.updateBell();
    const np = $('#nPerm', sh.el); if (np) np.onclick = () => Notification.requestPermission().then(() => sh.close());
    const nc = $('#nClear', sh.el); if (nc) nc.onclick = () => { S.notifs = []; DB.setMeta('notifs', []); sh.close(); PV.updateBell(); };
  }

  /** Pedidos del mismo cliente el mismo día (mismo u otro vendedor): alerta, no bloquea. */
  function dupIndex() {
    // Mismo cliente = mismo ID de cartera o mismo nombre normalizado (cliente creado "nuevo" por error)
    const g = new Map();
    const add = (k, o) => { if (k) g.set(k, (g.get(k) || []).concat(o)); };
    S.orders.filter((o) => !o.deleted && Matrix.orderTotals(o).items).forEach((o) => {
      add(o.routeDate + '|id|' + (o.clientId || ''), o);
      add(o.routeDate + '|nm|' + (o.clientKey || ''), o);
    });
    const out = new Map();
    g.forEach((arr, k) => {
      if (arr.length < 2 || /\|(id|nm)\|$/.test(k)) return;
      arr.forEach((o) => { const cur = out.get(o.id) || []; arr.forEach((x) => { if (x.id !== o.id && !cur.includes(x)) cur.push(x); }); out.set(o.id, cur); });
    });
    return out;
  }
  const dupBadge = (o, idx) => { const d = idx.get(o.id); return d ? ` <span class="status over" title="También con: ${esc(d.map((x) => x.sellerName).join(', '))}">⚠ duplicado · ${esc(d.map((x) => Loads.initials(x.sellerName)).join(' '))}</span>` : ''; };

  function setupBanner() {
    return `<div class="container"><div class="hint warn setup">
      <b>Primer paso:</b> carga el <b>paquete de arranque</b> (catálogo con precios, cartera de clientes por vendedor, rutas y despachadores).
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

  /** Arma hojas de carga con los pedidos enviados (solo en la oficina). */
  function autoPack() {
    const r = Loads.autoPack({ orders: S.orders, loads: S.loads, sellers: S.sellers, config: S.config });
    if (!r.orders.length) return;
    saveDocs('loads', r.loads);
    saveDocs('orders', r.orders);
  }

  /* ============================== CARGAS ============================== */
  function bar(pct, over, label) {
    return `<div class="bar ${over ? 'over' : pct >= 100 ? 'full' : ''}"><i style="width:${Math.min(100, pct)}%"></i><span>${label}</span></div>`;
  }
  const stName = (l) => Loads.statusOf(l, S.config).name;
  const sellerTags = (l) => Loads.sellerIdsOf(l).map((id) => { const s = sellerById(id); return s ? `<span class="tag" title="${esc(s.name)}">${esc(Loads.initials(s.name))}</span>` : ''; }).join('');
  const openLoads = () => S.loads.filter((l) => Loads.isOpen(l, S.config) && !Loads.isClosed(l));

  function renderLoads(root) {
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
        <button class="btn" id="lNew">＋ Nueva hoja</button>
        <button class="btn" id="lSync">⟳ Actualizar</button>
      </div>
      <p class="muted">Tope por hoja: <b>${nf0.format(L.limit)} ${L.measure}</b> o <b>${L.maxClients} clientes</b>. Los pedidos se pueden editar (vendedor y oficina) mientras la hoja esté en un estado sin 🔒.</p>
      ${groups.map(({ st, list }) => `
        <div class="section-title">${st.locked ? '🔒 ' : ''}${esc(st.name)} · ${list.length}</div>
        ${list.length ? `<div class="load-grid">${list.map(card).join('')}</div>` : '<p class="muted">Ninguna.</p>'}`).join('')}
      <div class="section-title">⏸ Clientes en espera (no se pierde el pedido)</div>
      ${held.length ? `<div class="card"><table class="inv">${held.map((o) => {
        const t = Matrix.orderTotals(o);
        return `<tr><td><b>${esc(o.clientName)}</b>${dupBadge(o, dupIndex())}<div class="muted">${esc(o.sellerName)} · ${esc(o.route || '')} · ${esc(fmtDate(o.routeDate))}</div></td>
          <td class="n">${t.bultos} bultos</td><td class="n">${usd(t.monto)}</td>
          <td style="white-space:nowrap"><button class="btn btn-sm" data-edit="${esc(o.id)}">Editar</button>
            <button class="btn btn-sm" data-move="${esc(o.id)}">⇄ A una hoja</button>
            <button class="btn btn-sm btn-primary" data-release="${esc(o.id)}">↩ Reincorporar</button></td></tr>`;
      }).join('')}</table></div>` : '<p class="muted">Ninguno.</p>'}`;

    $('#lSeller').onchange = (e) => { U().loadSeller = e.target.value; renderLoads(root); };
    $('#lSync').onclick = () => PV.runSync(true);
    $('#lNew').onclick = () => newLoadDialog(root);
    root.onclick = async (e) => {
      const c = e.target.closest('[data-lid]');
      if (c) { U().loadId = c.dataset.lid; renderLoads(root); return; }
      const ed = e.target.closest('[data-edit]');
      if (ed) { orderEditor(orderById(ed.dataset.edit), () => renderLoads(root)); return; }
      const mv = e.target.closest('[data-move]');
      if (mv) { moveDialog(orderById(mv.dataset.move), null, () => renderLoads(root)); return; }
      const rl = e.target.closest('[data-release]');
      if (rl) {
        await saveOrder(Loads.release(orderById(rl.dataset.release)));
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
      await saveDocs('loads', r.loads.map((l) => (l.orderIds.length || !fromLoad || l.id !== fromLoad.id ? l : { ...l, deleted: true })));
      await saveOrder(r.order);
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
    const colspan = m.cols.length + 3;
    const body = m.rows.map((r) => {
      let head = '';
      if (r.category !== lastCat) { lastCat = r.category; head = `<tr class="cat-row"><td class="sticky-col">${esc(r.category)}</td><td colspan="${colspan - 2}"></td><td class="tot"></td></tr>`; }
      const kind = r.um === 'CJ' ? 'cajas' : 'unidades';
      return head + `<tr class="${shortIds.has(r.productId) ? 'short' : ''}">
        <td class="sticky-col" title="${esc(r.code + ' · ' + r.name + ' ' + r.presentation)}"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b></td>
        <td><span class="um ${r.um}">${r.um}</span></td>
        ${r.cells.map((v, i) => edit
          ? `<td class="n"><input class="cell-in" inputmode="numeric" value="${v || ''}" data-oid="${esc(m.cols[i].id)}" data-pid="${esc(r.productId)}" data-kind="${kind}" aria-label="${esc(m.cols[i].client)} ${esc(r.name)}"></td>`
          : `<td class="n ${v ? '' : 'zero'}">${v ? nf0.format(v) : '·'}</td>`).join('')}
        <td class="n tot">${nf0.format(r.total)}</td></tr>`;
    }).join('');
    const foot = m.footer.map((f) => `<tr><td class="sticky-col">${esc(f.label)}</td><td></td>${f.cells.map((v) => `<td class="n">${nf0.format(v)}</td>`).join('')}<td class="n tot">${nf0.format(f.total)}</td></tr>`).join('');
    const totalUSD = os.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0);
    const dups = dupIndex();
    const initialsRow = `<tr class="ini-row"><th class="sticky-col">Vendedor →</th><th></th>${m.cols.map((c) => `<th>${esc(Loads.initials(c.order.sellerName))}</th>`).join('')}<th class="tot"></th></tr>`;

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
        <button class="btn" id="dPrint" title="En la ventana de impresión elige tu impresora o «Guardar como PDF»">🖨 Imprimir / PDF hoja</button>
        <button class="btn" id="dNotes" title="Original + copia por cliente">🧾 Notas: imprimir / PDF</button>
        <button class="btn" id="dCsv">⇩ Descargar Excel</button>
        <button class="btn" id="dCopy">📋 Copiar para Excel</button>
        ${editableLoad && !os.length ? '<button class="btn btn-danger" id="dDel">Eliminar hoja vacía</button>' : ''}
      </div>
      ${os.length ? `<div class="table-wrap"><table class="grid">
        <thead>${initialsRow}<tr><th class="sticky-col">Producto</th><th>UM</th>
          ${m.cols.map((c, i) => `<th class="client" title="${esc(c.client)}">${i + 1}. ${esc(c.client)}</th>`).join('')}<th class="tot">TOTAL</th></tr></thead>
        <tbody>${body}</tbody><tfoot>${foot}</tfoot></table></div>` : '<div class="empty card"><strong>Hoja vacía</strong>Mueve clientes aquí con ⇄ desde otra hoja o desde "Clientes en espera".</div>'}
      <div class="section-title">Clientes de la hoja (el orden es el de las columnas) · total ${usd(totalUSD)}</div>
      <div class="card"><table class="inv">
        <thead><tr><th>#</th><th>Orden</th><th>Cliente</th><th>Vend.</th><th>Bultos</th><th>Unid.</th><th>Monto</th><th>${closed ? 'Nota' : ''}</th><th></th></tr></thead>
        <tbody>${os.map((o, i) => { const t = Matrix.orderTotals(o); return `<tr>
          <td>${i + 1}</td>
          <td style="white-space:nowrap">${editableLoad ? `<button class="btn btn-sm" data-left="${i}" ${i ? '' : 'disabled'} aria-label="Mover a la izquierda">←</button><button class="btn btn-sm" data-right="${i}" ${i < os.length - 1 ? '' : 'disabled'} aria-label="Mover a la derecha">→</button>` : ''}</td>
          <td><b>${esc(o.clientName)}</b> <span class="muted">${esc(fmtDate(o.routeDate))}</span>${dupBadge(o, dups)}
            ${o.officeEdited ? ' <span class="status abierto">editado oficina</span>' : ''}${o.sellerEdited ? ' <span class="status en_espera">modificado por vendedor</span>' : ''}
            ${o.notes ? `<div class="muted">📝 ${esc(o.notes)}</div>` : ''}</td>
          <td><span class="tag">${esc(Loads.initials(o.sellerName))}</span></td>
          <td class="n" data-l="Bultos">${t.bultos}</td><td class="n" data-l="Unid.">${t.totalUnidades}</td><td class="n" data-l="Monto">${usd(t.monto)}</td>
          <td class="mono">${o.noteNumber ? esc(Loads.noteCode(o.noteNumber)) : ''}</td>
          <td style="white-space:nowrap">${closed ? `<button class="btn btn-sm" data-note="${esc(o.id)}">🧾</button>` : `<button class="btn btn-sm" data-edit="${esc(o.id)}">${editableLoad ? 'Editar' : 'Ver'}</button>`}
            ${editableLoad ? `<button class="btn btn-sm" data-move="${esc(o.id)}">⇄ Mover</button>
            <button class="btn btn-sm" data-hold="${esc(o.id)}" title="Dejar para otra carga">⏸ Espera</button>` : ''}</td></tr>`; }).join('')}</tbody></table></div>`;

    const cur = () => S.loads.find((x) => x.id === load.id) || load;
    const refresh = () => renderLoadDetail(root, cur());
    const saveLoad = async (patch) => { await saveDocs('loads', { ...cur(), ...patch }); refresh(); };
    $('#dBack').onclick = () => {
      U().loadId = null; U().archiveId = null; U().editQty = false;
      if (closed && !location.hash.includes('archivo')) location.hash = '#/oficina/archivo'; else PV.render();
    };
    const ctx = () => ({ config: S.config, usage: Loads.usage(cur(), byIdMap(S.orders), S.config), draft: !cur().number, clientsById: byIdMap(S.clients),
      load: cur(), productRank: productRank(), statusName: stName(cur()) });
    $('#dPrint').onclick = () => Print.printLoadSheet(cur(), Loads.loadOrders(cur(), byIdMap(S.orders)), ctx());
    $('#dNotes').onclick = () => Print.printNotes(Loads.loadOrders(cur(), byIdMap(S.orders)), ctx());
    $('#dCsv').onclick = () => saveFile(`hoja_${Loads.labelOf(cur())}_${cur().date || today()}.csv`, '\uFEFF' + Matrix.toDelimited(m, { sep: S.settings.csvSep, decimal: S.settings.csvDecimal }), 'text/csv;charset=utf-8');
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
      const n = e.target.closest('[data-note]'); if (n) { Print.printNotes([orderById(n.dataset.note)], ctx()); return; }
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
        refresh(); toast(o.clientName + ' pasó a espera', 'ok');
      }
    };
    root.onchange = async (e) => {
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
      if (!confirm(`${st.name}: se numeran las notas de entrega, se descuenta el inventario y la hoja pasa al Archivo.\n\nFecha de la carga: ${fecha}${u.over ? `\n\n⚠ Supera el tope (${u.used}/${u.limit} ${u.measure}, ${u.clients}/${u.maxClients} clientes).` : ''}\n\n¿Continuar?`)) return back();
    } else if (!st.closing && Loads.isClosed(load)) {
      if (!confirm(`Reabrir la carga como "${st.name}": el inventario descontado se devuelve y los pedidos ${st.locked ? 'siguen bloqueados' : 'se podrán editar de nuevo'}. Los números de carga y notas se conservan. ¿Continuar?`)) return back();
    } else if (st.locked && !cur.locked) {
      if (!confirm(`${st.name}: vendedores y oficina ya no podrán modificar estos ${os.length} pedidos. ¿Continuar?`)) return back();
    }
    const r = Loads.setStatus(load, statusId, { orders: S.orders, products: S.products, config: S.config }, { today: today() });
    if (r.config) await saveDocs('config', r.config);
    await saveDocs('orders', r.orders);
    await saveDocs('products', r.products);
    await saveDocs('loads', r.load);
    U().editQty = false;
    toast(`Estado: ${st.name}`, 'ok');
    if (closing) {
      back();
      const sh = openSheet(`<h2>✓ ${esc(Loads.labelOf(r.load))} · ${esc(Loads.loadCode(r.load))}</h2>
        <p>${esc(st.name)} · fecha ${esc(r.load.date)} · notas ${esc(Loads.noteCode(r.load.firstNote))} a ${esc(Loads.noteCode(r.load.lastNote))}.</p>
        <div class="actions" style="flex-direction:column">
          <button class="btn btn-primary" id="pSheet">🖨 Imprimir hoja de carga</button>
          <button class="btn" id="pNotes">🧾 Imprimir notas de entrega (original + copia)</button>
          <button class="btn" data-close>Listo</button></div>`);
      const ctx = { config: S.config, usage: Loads.usage(r.load, byIdMap(S.orders), S.config), clientsById: byIdMap(S.clients), load: r.load, productRank: productRank(), statusName: st.name };
      $('#pSheet', sh.el).onclick = () => Print.printLoadSheet(r.load, r.orders, ctx);
      $('#pNotes', sh.el).onclick = () => Print.printNotes(r.orders, ctx);
    } else back();
    PV.runSync(false);
  }

  /* ------------------------ Editor de pedido (oficina) ------------------------ */
  function orderEditor(o, onDone) {
    if (!o) return;
    const locked = !Loads.editable(o);
    const draw = (sh) => {
      const cur = orderById(o.id) || o;
      const lines = Object.entries(cur.lines).map(([pid, l]) => ({ pid, l, t: Matrix.lineTotals(l), p: productById(pid) }))
        .sort((a, b) => a.l.category.localeCompare(b.l.category, 'es') || a.l.name.localeCompare(b.l.name, 'es'));
      const tot = Matrix.orderTotals(cur);
      sh.el.querySelector('#oeBody').innerHTML = `
        <table class="lines">${lines.map(({ pid, l, t, p }) => {
          const sb = p ? p.sellBy : (l.boxPrice ? (l.unitPrice ? 'ambos' : 'caja') : 'unidad');
          return `<tr><td><b>${esc(l.name)} ${esc(l.presentation)}</b><div class="muted mono" style="font-size:12px">${esc(l.code)}</div></td>
            <td style="white-space:nowrap">
              ${sb !== 'unidad' ? `<label class="mini">CJ <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="cajas" value="${t.cajas || ''}" ${locked ? 'disabled' : ''}></label>` : ''}
              ${sb !== 'caja' ? `<label class="mini">UN <input class="input mini-in" inputmode="numeric" data-pid="${esc(pid)}" data-kind="unidades" value="${t.unidades || ''}" ${locked ? 'disabled' : ''}></label>` : ''}
            </td><td class="num">${usd(t.monto)}</td></tr>`;
        }).join('')}
        <tr class="total-row"><td><b>TOTAL</b> · ${tot.cajas} cj + ${tot.unidades} un · ${tot.bultos} bultos</td><td></td><td class="num">${usd(tot.monto)}</td></tr></table>`;
    };
    const sh = openSheet(`
      <div class="row"><div class="grow"><h2>${esc(o.clientName)}</h2><div class="muted">${esc(o.sellerName)} · Ruta ${esc(o.route || '—')} · ${esc(fmtDate(o.routeDate))} · ${esc(Loads.orderLabel(o))}</div></div>
        <button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${locked ? '<div class="hint warn">🔒 La carga de este pedido ya fue aprobada: no se puede modificar.</div>' : ''}
      <div id="oeBody"></div>
      ${locked ? '' : `<label class="field" style="margin-top:12px"><span>Agregar producto</span>
        <input id="oeSearch" class="input" placeholder="Buscar por nombre o código…" autocomplete="off"></label><div id="oeResults" class="results"></div>
        <label class="field" style="margin-top:12px"><span>Nota para despacho</span><input id="oeNotes" class="input" maxlength="300" value="${esc(o.notes || '')}"></label>`}
      <div class="actions"><button class="btn btn-primary" data-close>Listo</button></div>`, { wide: true });
    draw(sh);
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
        <button class="btn" id="oCopy" ${m.cols.length ? '' : 'disabled'}>📋 Copiar para Excel</button>
        <button class="btn" id="oCsv" ${m.cols.length ? '' : 'disabled'}>⇩ CSV</button>
        <button class="btn" id="oFlat" ${m.cols.length ? '' : 'disabled'}>⇩ CSV plano</button>
      </div>
      <div class="seller-cards" id="oSellers">${card('', 'Todos')}${S.sellers.map((s) => card(s.id, s.name)).join('')}</div>
      ${m.cols.length ? `<div class="table-wrap"><table class="grid"><thead><tr><th class="sticky-col">Producto</th><th>UM</th>
        ${m.cols.map((c) => `<th class="client" title="${esc(c.client)}">${esc(c.client)}</th>`).join('')}<th class="tot">TOTAL</th></tr></thead>
        <tbody>${m.rows.map((r) => `<tr><td class="sticky-col"><span class="mono muted">${esc(r.code)}</span> ${esc(r.name)} <b>${esc(r.presentation)}</b></td><td><span class="um ${r.um}">${r.um}</span></td>
          ${r.cells.map((v) => `<td class="n ${v ? '' : 'zero'}">${v ? (money ? nf2.format(v) : nf0.format(v)) : '·'}</td>`).join('')}<td class="n tot">${money ? nf2.format(r.total) : nf0.format(r.total)}</td></tr>`).join('')}</tbody>
        <tfoot>${m.footer.map((f) => `<tr><td class="sticky-col">${esc(f.label)}</td><td></td>${f.cells.map((v) => `<td class="n">${f.money ? nf2.format(v) : nf0.format(v)}</td>`).join('')}<td class="n tot">${f.money ? nf2.format(f.total) : nf0.format(f.total)}</td></tr>`).join('')}</tfoot></table></div>
        <div class="section-title">Detalle por cliente</div>
        <div class="card"><table class="inv">${source.map((o) => `<tr><td><b>${esc(o.clientName)}</b>${dupBadge(o, dupIdx)}<div class="muted">${esc(o.sellerName)} · ${esc(o.route || '')}</div></td>
          <td><span class="status ${o.status}">${esc(Loads.orderLabel(o))}</span></td><td class="n">${usd(Matrix.orderTotals(o).monto)}</td>
          <td><button class="btn btn-sm" data-edit="${esc(o.id)}">Ver / editar</button></td></tr>`).join('')}</table></div>`
      : `<div class="empty card"><strong>Sin pedidos</strong>No hay pedidos para ${esc(fmtDate(date))}.</div>`}`;
    $('#oDate').onchange = (e) => { U().date = e.target.value || today(); renderOrders(root); };
    $('#oMode').onclick = (e) => { const b = e.target.closest('[data-m]'); if (b) { U().mode = b.dataset.m; renderOrders(root); } };
    $('#oSellers').onclick = (e) => { const b = e.target.closest('[data-sid]'); if (b) { U().ordSeller = b.dataset.sid; renderOrders(root); } };
    root.onclick = (e) => { const ed = e.target.closest('[data-edit]'); if (ed) orderEditor(orderById(ed.dataset.edit), () => renderOrders(root)); };
    if (!m.cols.length) return;
    const who = sid ? slug(sellerById(sid).name) : 'todos';
    const opts = { sep: S.settings.csvSep, decimal: S.settings.csvDecimal };
    $('#oCopy').onclick = async () => { const ok = await copyText(Matrix.toDelimited(m, { sep: '\t', decimal: opts.decimal })); toast(ok ? 'Copiado: pégalo en Excel' : 'No se pudo copiar', ok ? 'ok' : 'err'); };
    $('#oCsv').onclick = () => saveFile(`pedidos_${who}_${date}_${mode}.csv`, '\uFEFF' + Matrix.toDelimited(m, opts), 'text/csv;charset=utf-8');
    $('#oFlat').onclick = () => saveFile(`pedidos_${who}_${date}_plano.csv`, '\uFEFF' + Matrix.toFlat(source, null, opts), 'text/csv;charset=utf-8');
  }

  /* ============================== ARCHIVO ============================== */
  function renderArchive(root) {
    if (U().archiveId) { const l = S.loads.find((x) => x.id === U().archiveId); if (l) return renderLoadDetail(root, l); U().archiveId = null; }
    const f = U().arch || (U().arch = { from: '', to: '', seller: '', route: '', disp: '', status: '' });
    const dateOf = (l) => String(l.date || l.closedAt || l.approvedAt || '').slice(0, 10);
    const list = S.loads.filter((l) => Loads.isClosed(l) &&
      (!f.from || dateOf(l) >= f.from) && (!f.to || dateOf(l) <= f.to) &&
      (!f.seller || Loads.sellerIdsOf(l).includes(f.seller)) && (!f.route || l.route === f.route) &&
      (!f.disp || l.dispatcherId === f.disp) && (!f.status || Loads.statusOf(l, S.config).id === f.status))
      .sort((a, b) => dateOf(b).localeCompare(dateOf(a)) || (b.number || 0) - (a.number || 0));
    const sum = list.reduce((a, l) => { const t = l.totals || {}; a.c += t.clients || 0; a.b += t.bultos || 0; a.u += t.totalUnidades || 0; a.m += t.monto || 0; return a; }, { c: 0, b: 0, u: 0, m: 0 });
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    root.innerHTML = `
      <div class="toolbar" id="aFilters">
        <label class="field"><span>Desde</span><input type="date" class="input" data-f="from" value="${esc(f.from)}"></label>
        <label class="field"><span>Hasta</span><input type="date" class="input" data-f="to" value="${esc(f.to)}"></label>
        <label class="field"><span>Vendedor</span><select class="select" data-f="seller"><option value="">Todos</option>${opt(S.sellers.map((s) => [s.id, s.name]), f.seller)}</select></label>
        <label class="field"><span>Ruta</span><select class="select" data-f="route"><option value="">Todas</option>${opt((S.config.routes || []).map((r) => [r, r]), f.route)}</select></label>
        <label class="field"><span>Despachador</span><select class="select" data-f="disp"><option value="">Todos</option>${opt((S.config.dispatchers || []).map((d) => [d.id, d.name]), f.disp)}</select></label>
        <label class="field"><span>Estado</span><select class="select" data-f="status"><option value="">Todos</option>${opt(Loads.statuses(S.config).filter((x) => x.closing).map((x) => [x.id, x.name]), f.status)}</select></label>
        <button class="btn" id="aCsv" ${list.length ? '' : 'disabled'}>⇩ Exportar CSV</button>
      </div>
      <div class="kpi-row">
        <div class="kpi"><small>Cargas</small><b>${list.length}</b></div>
        <div class="kpi"><small>Clientes atendidos</small><b>${nf0.format(sum.c)}</b></div>
        <div class="kpi"><small>Bultos despachados</small><b>${nf0.format(sum.b)}</b></div>
        <div class="kpi"><small>Venta despachada</small><b>${usd(sum.m)}</b></div>
      </div>
      ${list.length ? `<div class="card" style="overflow:auto"><table class="inv">
        <thead><tr><th>Código</th><th>Fecha</th><th>Estado</th><th>Vendedor(es)</th><th>Ruta</th><th>Despachador</th><th>Clientes</th><th>Bultos</th><th>Unid.</th><th>Monto</th><th>Notas</th><th></th></tr></thead>
        <tbody>${list.map((l) => { const t = l.totals || {}; return `<tr>
          <td><b class="mono">${esc(Loads.labelOf(l))}</b><div class="muted mono">${esc(Loads.loadCode(l))}</div></td><td data-l="Fecha">${esc(dateOf(l))}</td>
          <td data-l="Estado"><span class="status aprobada">${esc(stName(l))}</span></td>
          <td data-l="Vendedor">${esc(l.sellerName)}</td><td data-l="Ruta">${esc(l.route || '')}</td><td data-l="Despachador">${esc(l.dispatcherName || '')}</td>
          <td class="n" data-l="Clientes">${t.clients || 0}</td><td class="n" data-l="Bultos">${nf0.format(t.bultos || 0)}</td><td class="n" data-l="Unid.">${nf0.format(t.totalUnidades || 0)}</td>
          <td class="n" data-l="Monto">${usd(t.monto)}</td><td class="mono" data-l="Notas">${l.firstNote ? esc(Loads.noteCode(l.firstNote) + '–' + Loads.noteCode(l.lastNote)) : ''}</td>
          <td style="white-space:nowrap"><button class="btn btn-sm" data-view="${esc(l.id)}">Ver</button></td></tr>`; }).join('')}</tbody></table></div>`
      : '<div class="empty card"><strong>Sin cargas cerradas</strong>con esos filtros.</div>'}`;
    $('#aFilters').onchange = (e) => { const k = e.target.dataset.f; if (k) { f[k] = e.target.value; renderArchive(root); } };
    root.onclick = (e) => { const v = e.target.closest('[data-view]'); if (v) { U().archiveId = v.dataset.view; renderArchive(root); } };
    $('#aCsv').onclick = () => {
      const sep = S.settings.csvSep, d = S.settings.csvDecimal;
      const n = (v) => { const s = Number(v || 0).toFixed(2); return d === ',' ? s.replace('.', ',') : s; };
      const q = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return s.includes(sep) || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s; };
      const rows = [['CODIGO', 'CARGA', 'FECHA', 'ESTADO', 'VENDEDORES', 'RUTA', 'DESPACHADOR', 'CLIENTES', 'CAJAS', 'UNID_SUELTAS', 'BULTOS', 'TOTAL_UNIDADES', 'MONTO_USD', 'NOTA_DESDE', 'NOTA_HASTA'].join(sep)];
      list.forEach((l) => { const t = l.totals || {}; rows.push([q(Loads.labelOf(l)), Loads.loadCode(l), dateOf(l), q(stName(l)), q(l.sellerName), q(l.route), q(l.dispatcherName), t.clients || 0, t.cajas || 0, t.unidades || 0, t.bultos || 0, t.totalUnidades || 0, n(t.monto), l.firstNote ? Loads.noteCode(l.firstNote) : '', l.lastNote ? Loads.noteCode(l.lastNote) : ''].join(sep)); });
      saveFile('archivo_cargas_' + today() + '.csv', '\uFEFF' + rows.join('\r\n'), 'text/csv;charset=utf-8');
    };
  }
  // Al cambiar de pestaña se sale de cualquier detalle abierto
  window.addEventListener('hashchange', () => { U().archiveId = null; U().loadId = null; U().editQty = false; });

  /* ============================= INVENTARIO ============================= */
  function renderInventory(root) {
    const q = U().invQ || '', cat = U().invCat || '';
    const tokens = norm(q).split(' ').filter(Boolean);
    const rows = S.products.filter((p) => (!cat || p.category === cat) &&
      tokens.every((t) => norm(p.code + ' ' + (p.unitCode || '') + ' ' + p.name + ' ' + p.presentation + ' ' + (p.brand || '')).includes(t)))
      .sort(PV.productSort());
    const noPhoto = S.products.filter((p) => !p.image).length;
    root.innerHTML = `
      <div class="toolbar">
        <label class="field grow"><span>Buscar</span><input id="iq" class="input" type="search" value="${esc(q)}" placeholder="Código, nombre, marca o gramaje"></label>
        <label class="field"><span>Rubro</span><select id="icat" class="select"><option value="">Todos</option>
          ${rubros().map((c) => `<option ${c === cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <button class="btn btn-primary" id="iNew">＋ Nuevo</button>
        <button class="btn" id="iImp">⇧ Importar Excel/CSV</button>
        <button class="btn" id="iExp">⇩ Exportar</button>
        <button class="btn" id="iPhotos">📷 Fotos en lote</button>
        <button class="btn" id="iOrder">↕ Ordenar catálogo</button>
      </div>
      <p class="muted">${S.products.length} productos · ${rows.length} mostrados · ${noPhoto} sin foto${S.config.priceListDate ? ' · lista de precios del ' + esc(S.config.priceListDate) : ''}. Los cambios de precio, stock u orden se guardan al salir de la casilla y llegan a los teléfonos al sincronizar.</p>
      <div class="card" style="overflow:auto"><table class="inv inv-edit">
        <thead><tr><th></th><th>Código</th><th>Producto</th><th>Rubro</th><th>Venta</th><th>$ Caja</th><th>$ Unidad</th><th>Stock</th><th>Orden</th><th></th></tr></thead>
        <tbody>${rows.map((p) => `
          <tr class="${p.active ? '' : 'inactive'}" data-row="${esc(p.id)}">
            <td class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="">` : `<span>${PV.rubroIcon(p.category)}</span>`}</td>
            <td class="mono" data-l="Código">${esc(p.code)}${p.unitCode ? `<div class="muted">UN: ${esc(p.unitCode)}</div>` : ''}</td>
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
      await saveDocs('products', { ...p, [f]: val });
      toast('Guardado: ' + p.name, 'ok');
    };
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
    let image = p.image || '';
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
        <div class="actions">
          <button class="btn btn-primary" type="submit">Guardar</button>
          ${isNew ? '' : '<button class="btn btn-danger" type="button" id="pDel">Eliminar</button>'}
        </div>
      </form>`, { wide: true });
    const form = $('#pf', sh.el);
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
        active: form.active.checked, image, deleted: false,
      };
      if (doc.boxPrice < 0 || doc.unitPrice < 0) { toast('Los precios no pueden ser negativos', 'err'); return; }
      if (S.products.some((x) => x.id === doc.id && x.id !== p.id)) doc.id = DB.uid('p');
      await saveDocs('products', doc);
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
        rif, name: name.replace(/\s+/g, ' '), phone: get(r, 'phone'), address: get(r, 'address'),
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
    const all = S.clients.filter((c) => (!sid || c.sellerId === sid) && tokens.every((t) => norm(c.name + ' ' + c.rif + ' ' + c.address + ' ' + c.phone).includes(t)))
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const list = all.slice(0, 300);
    const count = (id) => S.clients.filter((c) => c.sellerId === id).length;
    root.innerHTML = `
      <div class="toolbar">
        <label class="field grow"><span>Buscar</span><input id="cq" class="input" type="search" value="${esc(q)}" placeholder="Nombre, RIF, dirección o teléfono"></label>
        <label class="field"><span>Vendedor</span><select id="cs" class="select"><option value="">Todos (${S.clients.length})</option>
          ${S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === sid ? 'selected' : ''}>${esc(s.name)} (${count(s.id)})</option>`).join('')}</select></label>
        <button class="btn btn-primary" id="cNew">＋ Nuevo</button>
        <button class="btn" id="cImp">⇧ Importar Excel</button>
      </div>
      <p class="muted">${all.length} clientes${all.length > list.length ? ' · mostrando 300, usa la búsqueda' : ''}. Los marcados <span class="status abierto">campo</span> los creó un vendedor en la calle.</p>
      <div class="card" style="overflow:auto"><table class="inv">
        <thead><tr><th>Cliente</th><th>RIF / C.I.</th><th>Teléfono</th><th>Vendedor</th><th>Ruta</th><th></th></tr></thead>
        <tbody>${list.map((c) => `<tr data-cid="${esc(c.id)}" class="${c.active === false ? 'inactive' : ''}">
          <td><b>${esc(c.name)}</b>${c.source === 'campo' ? ' <span class="status abierto">campo</span>' : ''}<div class="muted">${esc(c.address || '')}</div></td>
          <td class="mono" data-l="RIF">${esc(c.rif || '')}</td><td data-l="Tel.">${esc(c.phone || '')}</td>
          <td data-l="Vendedor"><select class="select sm" data-cf="sellerId">${S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === c.sellerId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></td>
          <td data-l="Ruta"><select class="select sm" data-cf="route"><option value="">—</option>${(S.config.routes || []).map((r) => `<option ${r === c.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></td>
          <td><button class="btn btn-sm" data-cedit="${esc(c.id)}">Editar</button></td></tr>`).join('')}</tbody></table></div>`;
    let t;
    $('#cq').oninput = (e) => { clearTimeout(t); t = setTimeout(() => { U().cliQ = e.target.value; renderClients(root); const i = $('#cq'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    $('#cs').onchange = (e) => { U().cliSeller = e.target.value; renderClients(root); };
    $('#cNew').onclick = () => clientForm(null, root);
    $('#cImp').onclick = () => importDialog('clients', root);
    root.onchange = async (e) => {
      const s = e.target.closest('[data-cf]'); if (!s) return;
      const c = clientById(s.closest('[data-cid]').dataset.cid);
      await saveDocs('clients', { ...c, [s.dataset.cf]: s.value }); toast('Cliente actualizado', 'ok');
    };
    root.onclick = (e) => { const b = e.target.closest('[data-cedit]'); if (b) clientForm(clientById(b.dataset.cedit), root); };
  }

  function clientForm(c, root) {
    const isNew = !c;
    c = c || { name: '', rif: '', phone: '', address: '', group: '', creditDays: 0, sellerId: U().cliSeller || (S.sellers[0] && S.sellers[0].id), route: '', active: true };
    const sh = openSheet(`
      <div class="row"><h2 class="grow">${isNew ? 'Nuevo cliente' : esc(c.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <form id="cf" class="form-grid" autocomplete="off">
        <label class="field"><span>Nombre / razón social *</span><input name="name" class="input" required maxlength="80" value="${esc(c.name)}"></label>
        <div class="grid2"><label class="field"><span>RIF / C.I.</span><input name="rif" class="input mono" maxlength="20" value="${esc(c.rif)}"></label>
          <label class="field"><span>Teléfono</span><input name="phone" class="input" maxlength="40" value="${esc(c.phone)}"></label></div>
        <label class="field"><span>Dirección</span><input name="address" class="input" maxlength="120" value="${esc(c.address)}"></label>
        <div class="grid3"><label class="field"><span>Vendedor</span><select name="sellerId" class="select">${S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === c.sellerId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
          <label class="field"><span>Ruta</span><select name="route" class="select"><option value="">—</option>${(S.config.routes || []).map((r) => `<option ${r === c.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          <label class="field"><span>Días de crédito</span><input name="creditDays" class="input" inputmode="numeric" value="${c.creditDays || 0}"></label></div>
        <label class="row"><input type="checkbox" name="active" ${c.active !== false ? 'checked' : ''} style="width:22px;height:22px"> Activo</label>
        <div class="actions"><button class="btn btn-primary" type="submit">Guardar</button></div>
      </form>`, { wide: true });
    $('#cf', sh.el).onsubmit = async (e) => {
      e.preventDefault(); const f = e.target;
      await saveDocs('clients', { ...c, id: c.id || DB.uid('c'), name: f.name.value.trim(), rif: f.rif.value.trim(), phone: f.phone.value.trim(),
        address: f.address.value.trim(), sellerId: f.sellerId.value, route: f.route.value, creditDays: int(f.creditDays.value),
        active: f.active.checked, source: c.source === 'campo' ? 'campo-revisado' : (c.source || 'oficina'), deleted: false });
      sh.close(); renderClients(root); toast('Cliente guardado', 'ok');
    };
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
            <div class="muted" style="font-size:13px">${S.clients.filter((c) => c.sellerId === s.id).length} clientes en cartera</div>
          </div>`).join('')}
      </div>`;
    $('#sNew').onsubmit = async (e) => {
      e.preventDefault(); const name = e.target.n.value.trim(); if (!name) return;
      await saveDocs('sellers', { id: DB.uid('s'), name, routes: [], aliases: [], active: true, deleted: false });
      renderSellers(root); toast('Vendedor agregado', 'ok');
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
            <button class="btn" id="bAll">⇪ Respaldo completo</button><button class="btn" id="bCat">⇪ Paquete para teléfonos</button></div></section>

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
            <b>Cierra la carga</b>: numera las notas de entrega, descuenta el inventario, fija la fecha de la carga y la pasa al Archivo.</p>
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

        <section class="card card-pad"><h3>Sincronización</h3>
          <p class="muted">La clave admin permite a este equipo publicar catálogo, clientes, precios, rutas y cargas hacia los teléfonos.</p>
          <div class="grid2">
            <label class="field"><span>Clave de sync (todos)</span><input id="sKey" class="input" type="password" autocomplete="off" value="${esc(st.syncKey)}"></label>
            <label class="field"><span>Clave admin (oficina)</span><input id="sAdmin" class="input" type="password" autocomplete="off" value="${esc(st.adminKey)}"></label>
            <label class="field"><span>URL del servidor</span><input id="sUrl" class="input" placeholder="${esc(Sync.DEFAULT_SYNC_URL)}" value="${esc(st.syncUrl)}"></label>
            <label class="field"><span>Excel</span><select id="sSep" class="select">
              <option value=";|," ${st.csvSep === ';' ? 'selected' : ''}>Excel en español ( ; y coma decimal)</option>
              <option value=",|." ${st.csvSep === ',' ? 'selected' : ''}>Excel en inglés ( , y punto decimal)</option></select></label>
          </div>
          <div class="row wrap" style="margin-top:12px"><button class="btn btn-primary" id="sSave">Guardar y sincronizar</button><span class="muted" id="sLast"></span></div></section>
        <p class="muted" style="font-size:13px">Almacenamiento: ${DB.isFallback ? 'localStorage (limitado)' : 'IndexedDB'} · ${S.products.length} productos · ${S.clients.length} clientes · ${S.orders.length} pedidos</p>
      </div>`;

    const saveCfg = async (patch) => { await saveDocs('config', { ...S.config, ...patch }); renderSettings(root); toast('Guardado', 'ok'); };
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
      await PV.runSync(true); renderSettings(root);
    };
    $('#bImp').onclick = importStarter;
    $('#bAll').onclick = async () => saveFile('respaldo_' + today() + '.json', JSON.stringify(await Sync.exportBundle({ includeCatalog: true, includeLoads: true })), 'application/json');
    $('#bCat').onclick = async () => saveFile('catalogo_telefonos_' + today() + '.json', JSON.stringify(await Sync.exportBundle({ sellerId: '__none__', includeCatalog: true })), 'application/json');
  }
})();
