/* =========================================================================
 * nav.js — Panel de secciones (a la izquierda en PC, deslizable con ☰ en el teléfono).
 *
 * Cada rol ve sus secciones y, al tocar una, se despliegan sus subsecciones. Solo cambia la navegación: cada
 * subsección abre la misma pantalla de siempre (mismas rutas #/…), con o sin internet, sin descargar nada.
 * ========================================================================= */
(function (global) {
  'use strict';
  const PV = () => global.PV;

  // go: ruta · myo: pestaña de «Mis pedidos» · act: acción al llegar · el: sección de la página a mostrar
  const MENUS = {
    seller: [
      { id: 'desp', icon: '🚚', label: 'Despachos a crédito', items: [
        { icon: '🛒', label: 'Tomar pedido', go: '#/ruta' },
        { icon: '🧾', label: 'Mis pedidos', go: '#/ruta/pedidos', myo: 'pedidos' },
        { icon: '📄', label: 'Mis hojas', go: '#/ruta/pedidos', myo: 'hojas' },
        { icon: '👥', label: 'Mis clientes', go: '#/ruta/clientes' },
        { icon: '♻', label: 'Vacíos', go: '#/ruta/pedidos', myo: 'vacios' },
        { icon: '📊', label: 'Mi quincena y metas', go: '#/ruta/resumen' },
      ] },
      { id: 'pagos', icon: '💵', label: 'Pagos y cobranza', items: [
        { icon: '📅', label: 'Cobrar (vencimientos)', go: '#/ruta/cobrar', count: 'cobrar' },
        { icon: '＋', label: 'Registrar pago', go: '#/ruta/pagos', act: 'pay' },
        { icon: '💵', label: 'Mis pagos', go: '#/ruta/pagos', count: 'pend' },
        { icon: '📒', label: 'Estado de cuenta', go: '#/ruta/pagos', act: 'cuenta' },
        { icon: '🗂', label: 'Pagos anteriores (FileMaker)', go: '#/ruta/pagos', act: 'anterior' },
      ] },
    ],
    office: [
      { id: 'desp', icon: '🚚', label: 'Despachos a crédito', items: [
        { icon: '🧾', label: 'Pedidos del día', go: '#/oficina/pedidos' },
        { icon: '🚚', label: 'Hojas de carga', go: '#/oficina/cargas', count: 'hojas' },
        { icon: '🏢', label: 'Retiro por oficina', go: '#/oficina/cargas', el: 'navRetiro' },
        { icon: '⏸', label: 'Clientes en espera', go: '#/oficina/cargas', el: 'navEspera', count: 'espera' },
        { icon: '🗄', label: 'Liquidaciones y archivo', go: '#/oficina/archivo' },
        { icon: '🗑', label: 'Papelera', go: '#/oficina/archivo', act: 'trash' },
      ] },
      { id: 'vac', icon: '♻', label: 'Vacíos', items: [
        { icon: '♻', label: 'Kardex y envases', go: '#/oficina/envases' },
      ] },
      { id: 'pagos', icon: '💵', label: 'Pagos y cobranza', items: [
        { icon: '⏳', label: 'Pagos por verificar', go: '#/oficina/pagos' },
        { icon: '📅', label: 'Cuentas por cobrar', go: '#/oficina/pagos', act: 'cartera' },
        { icon: '🚦', label: 'Crédito de clientes', go: '#/oficina/pagos', act: 'credito' },
        { icon: '🛡', label: 'Revisión de integridad', go: '#/oficina/pagos', act: 'integridad' },
        { icon: '⇩', label: 'Importar de FileMaker', go: '#/oficina/pagos', act: 'importar' },
      ] },
      { id: 'inv', icon: '📦', label: 'Inventario y catálogo', items: [
        { icon: '📦', label: 'Inventario y productos', go: '#/oficina/inventario' },
      ] },
      { id: 'rep', icon: '📈', label: 'Reportes', items: [
        { icon: '📈', label: 'Quincena, ventas y notas', go: '#/oficina/reportes' },
      ] },
      { id: 'adm', icon: '⚙', label: 'Administración', items: [
        { icon: '👥', label: 'Clientes', go: '#/oficina/clientes', count: 'verificar' },
        { icon: '🧑‍💼', label: 'Vendedores', go: '#/oficina/vendedores' },
        { icon: '🔐', label: 'Usuarios y roles', go: '#/oficina/usuarios' },
        { icon: '🕘', label: 'Historial', go: '#/oficina/historial' },
        { icon: '⚙', label: 'Ajustes', go: '#/oficina/ajustes' },
      ] },
    ],
    gerencia: [
      { id: 'desp', icon: '🚚', label: 'Despachos a crédito', items: [
        { icon: '🛒', label: 'Tomar pedido', go: '#/gerencia/tomar' },
        { icon: '🧾', label: 'Pedidos del día', go: '#/gerencia/pedidos' },
        { icon: '🚚', label: 'Hojas de carga y despacho', go: '#/gerencia/cargas' },
        { icon: '🗄', label: 'Liquidaciones y notas', go: '#/gerencia/archivo' },
      ] },
      { id: 'vac', icon: '♻', label: 'Vacíos', items: [
        { icon: '♻', label: 'Kardex y envases', go: '#/gerencia/envases' },
      ] },
      { id: 'pagos', icon: '💵', label: 'Pagos y cobranza', items: [
        { icon: '💵', label: 'Pagos', go: '#/gerencia/pagos' },
        { icon: '📅', label: 'Cuentas por cobrar', go: '#/gerencia/pagos', act: 'cartera' },
        { icon: '🚦', label: 'Crédito de clientes', go: '#/gerencia/pagos', act: 'credito' },
      ] },
      { id: 'inv', icon: '📦', label: 'Inventario y catálogo', items: [
        { icon: '📦', label: 'Inventario y productos', go: '#/gerencia/inventario' },
        { icon: '🐢', label: 'Productos sin movimiento', go: '#/gerencia/sinmov' },
      ] },
      { id: 'rep', icon: '📈', label: 'Reportes', items: [
        { icon: '📊', label: 'Resumen del día', go: '#/gerencia/resumen' },
        { icon: '📈', label: 'Ventas y liquidaciones', go: '#/gerencia/reportes' },
        { icon: '👥', label: 'Clientes', go: '#/gerencia/clientes' },
        { icon: '🕘', label: 'Historial', go: '#/gerencia/historial' },
      ] },
    ],
    cobranzas: [
      { id: 'pagos', icon: '💵', label: 'Pagos y cobranza', items: [
        { icon: '⏳', label: 'Pagos por verificar', go: '#/cobranzas/pagos' },
        { icon: '📅', label: 'Cuentas por cobrar', go: '#/cobranzas/pagos', act: 'cartera' },
        { icon: '🚦', label: 'Crédito de clientes', go: '#/cobranzas/pagos', act: 'credito' },
        { icon: '🛡', label: 'Revisión de integridad', go: '#/cobranzas/pagos', act: 'integridad' },
        { icon: '⇩', label: 'Importar de FileMaker', go: '#/cobranzas/pagos', act: 'importar' },
      ] },
    ],
    super: [
      { id: 'cons', icon: '👁', label: 'Consulta', items: [
        { icon: '📊', label: 'Resumen', go: '#/supervisor/resumen' },
        { icon: '📈', label: 'Reportes', go: '#/supervisor/reportes' },
        { icon: '🕘', label: 'Historial', go: '#/supervisor/historial' },
      ] },
    ],
  };

  function roleOf(h) {
    if (h.startsWith('#/oficina')) return 'office';
    if (h.startsWith('#/supervisor')) return 'super';
    if (h.startsWith('#/gerencia') || h.startsWith('#/cobranzas')) { const R = global.Roles; const role = h.startsWith('#/gerencia') ? 'gerencia' : 'cobranzas'; return R && R.isRole(role) ? role : ''; }
    if (h.startsWith('#/ruta')) {
      const S = PV() && PV().S; if (!(S && S.session && PV().sellerById(S.session.sellerId))) return '';
      return S.session.gerencia && global.Roles && global.Roles.isRole('gerencia') ? 'gerencia' : 'seller'; // Gerencia tomando pedidos
    }
    return '';
  }
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } };

  /** ¿Esta subsección es la pantalla abierta? */
  function isActive(it, h) {
    const P = PV(), S = P.S, base = h.split('?')[0];
    if (it.act || it.el) return false;
    const tab = (x) => x.split('/')[2] || '';
    if (it.go.startsWith('#/oficina/')) return base.startsWith('#/oficina') && (tab(base) || 'cargas') === tab(it.go) && !(tab(it.go) === 'archivo' && S.ui.office && S.ui.office.trash);
    if (it.go.startsWith('#/supervisor/')) return base.startsWith('#/supervisor') && (tab(base) || 'resumen') === tab(it.go);
    if (it.go === '#/gerencia/tomar') return base.startsWith('#/ruta');
    if (it.go.startsWith('#/gerencia/') || it.go.startsWith('#/cobranzas/')) return base.split('/')[1] === it.go.split('/')[1] && (tab(base) || tab(it.go)) === tab(it.go);
    if (it.myo) return base === it.go && ((S.ui.myo && S.ui.myo.tab) || 'pedidos') === it.myo;
    return base === it.go;
  }

  /** Contadores pequeños junto a cada subsección (solo con lo que ya está en el equipo). */
  async function counts(role) {
    const P = PV(), S = P.S, c = {};
    if (role === 'seller') {
      const sid = S.session && S.session.sellerId, cart = sid ? lsGet('pv_cart:' + sid, null) : null;
      if (cart && cart.data) c.cobrar = cart.data.notas.filter((n) => n.dias <= 0).length;
      if (global.Pagos && global.Pagos.pend) { try { c.pend = (await global.Pagos.pend()).filter((p) => p.sellerId === sid).length; } catch (e) { /* noop */ } }
    }
    if (role === 'office') {
      c.hojas = S.loads.filter((l) => !l.deleted && global.Loads && !global.Loads.isClosed(l)).length;
      c.espera = S.orders.filter((o) => !o.deleted && o.status === 'en_espera').length;
      c.verificar = S.clients.filter((x) => !x.deleted && global.Clientes && !global.Clientes.isVerified(x)).length;
    }
    return c;
  }

  let el = null, lastRole = '';
  async function render() {
    const P = PV(); if (!P || !P.S) return;
    const h = location.hash || '#/', role = roleOf(h), menu = MENUS[role];
    document.body.classList.toggle('has-side', !!menu);
    if (!menu) { if (el) el.innerHTML = ''; document.body.classList.remove('side-open'); return; }
    if (!el) {
      el = document.createElement('nav'); el.id = 'side'; el.className = 'side'; el.setAttribute('aria-label', 'Secciones');
      document.body.appendChild(el);
      const scrim = document.createElement('div'); scrim.className = 'side-scrim'; scrim.onclick = close; document.body.appendChild(scrim);
      el.addEventListener('click', onClick);
    }
    const open = lsGet('pv_sideOpen:' + role, null) || Object.fromEntries(menu.map((s) => [s.id, true]));
    const mini = !!lsGet('pv_sideMini', false); document.body.classList.toggle('side-mini', mini);
    const c = await counts(role), esc = P.esc;
    const badge = (k) => (k && c[k] ? `<span class="side-count">${c[k]}</span>` : '');
    el.innerHTML = `<div class="side-head"><b>${esc(role === 'office' ? 'Oficina' : role === 'super' ? 'Supervisor' : role === 'gerencia' || role === 'cobranzas' ? (P.S.settings.userName || '') + ' · ' + (role === 'gerencia' ? 'Gerencia' : 'Cobranzas') : ((P.sellerById(P.S.session.sellerId) || {}).name || 'Vendedor'))}</b>
        <button type="button" class="side-mini-btn" data-mini title="${mini ? 'Mostrar el panel' : 'Achicar el panel'}" aria-label="Achicar el panel">${mini ? '»' : '«'}</button></div>
      ${menu.map((s) => { const on = open[s.id] !== false, act = s.items.some((it) => isActive(it, h)), tot = s.items.reduce((a, it) => a + (it.count ? c[it.count] || 0 : 0), 0);
        return `<div class="side-sec ${on ? 'open' : ''} ${act ? 'has-active' : ''}"><button type="button" class="side-sec-btn" data-sec="${s.id}" title="${esc(s.label)}"><span class="side-ico">${s.icon}</span><span class="side-lbl">${esc(s.label)}</span>${tot && !on ? `<span class="side-count">${tot}</span>` : ''}<span class="side-car">${on ? '▾' : '▸'}</span></button>
          <div class="side-items">${s.items.map((it, i) => `<button type="button" class="side-item ${isActive(it, h) ? 'active' : ''}" data-it="${s.id}:${i}" title="${esc(it.label)}"><span class="side-ico">${it.icon}</span><span class="side-lbl">${esc(it.label)}</span>${badge(it.count)}</button>`).join('')}</div></div>`; }).join('')}`;
    lastRole = role;
  }

  function close() { document.body.classList.remove('side-open'); }
  function toggle() { document.body.classList.toggle('side-open'); }

  async function onClick(e) {
    const P = PV(), S = P.S, role = lastRole, menu = MENUS[role]; if (!menu) return;
    if (e.target.closest('[data-mini]')) { lsSet('pv_sideMini', !lsGet('pv_sideMini', false)); render(); return; }
    const sb = e.target.closest('[data-sec]');
    if (sb) {
      const open = lsGet('pv_sideOpen:' + role, null) || Object.fromEntries(menu.map((s) => [s.id, true]));
      open[sb.dataset.sec] = open[sb.dataset.sec] === false; lsSet('pv_sideOpen:' + role, open);
      if (document.body.classList.contains('side-mini')) { lsSet('pv_sideMini', false); open[sb.dataset.sec] = true; lsSet('pv_sideOpen:' + role, open); }
      render(); return;
    }
    const ib = e.target.closest('[data-it]'); if (!ib) return;
    const [sid, i] = ib.dataset.it.split(':'), it = menu.find((s) => s.id === sid).items[+i];
    close();
    if (it.myo) S.ui.myo = { ...(S.ui.myo || { g: 'todos', r: '15' }), tab: it.myo };
    if (it.go.startsWith('#/oficina') && S.ui.office) S.ui.office.trash = it.act === 'trash' ? { q: '' } : null;
    if (location.hash !== it.go) { location.hash = it.go; await new Promise((r) => setTimeout(r, 60)); }
    else P.render();
    await new Promise((r) => setTimeout(r, 30));
    if (it.el) { const t = document.getElementById(it.el); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    const sidN = S.session && S.session.sellerId;
    if (it.act === 'pay' && global.Pagos) global.Pagos.payForm({ sellerId: sidN, onSaved: () => { if (S.ui.pagos) S.ui.pagos.list = null; P.render(); } });
    if (it.act === 'cuenta' && global.Pagos) global.Pagos.cuentaSheet(sidN);
    if (it.act === 'anterior' && global.Pagos) global.Pagos.anteriorForm({ sellerId: sidN, onSaved: () => P.render() });
    if (it.act === 'cartera' && global.Cobranza) global.Cobranza.officeSheet();
    if (it.act === 'credito' && global.Cobranza) global.Cobranza.creditSheet();
    if (it.act === 'integridad' && global.Pagos) global.Pagos.integridadSheet();
    if (it.act === 'importar' && global.Pagos) global.Pagos.importSheet(() => P.render());
    render();
  }

  // ☰ en el encabezado (teléfono y PC con el panel achicado)
  document.addEventListener('click', (e) => { if (e.target.closest('[data-side]')) { e.preventDefault(); toggle(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  global.addEventListener('hashchange', () => { close(); setTimeout(render, 0); });

  global.Nav = { render, toggle, close, MENUS };
})(window);
