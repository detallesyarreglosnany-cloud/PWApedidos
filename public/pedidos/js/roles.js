/* =========================================================================
 * roles.js — Usuarios con rol y PIN: Gerencia y Cobranzas (D2).
 *
 * La oficina crea a cada persona (Administración → Usuarios y roles) con su nombre, rol y PIN. En la entrada,
 * cada uno elige su nombre y escribe su PIN: el servidor le da un permiso para ese equipo y solo lo de su rol
 * (lo hace cumplir el servidor). La sesión queda en el equipo: funciona sin internet con lo ya descargado.
 * ========================================================================= */
(function (global) {
  'use strict';
  const PV = () => global.PV;
  const ROLE = { gerencia: { label: 'Gerencia', icon: '👔', home: '#/gerencia/pedidos' }, cobranzas: { label: 'Cobranzas', icon: '🧾', home: '#/cobranzas/pagos' } };

  const session = () => { const s = PV().S.settings || {}; return s.userToken && s.userRole ? { id: s.userId, name: s.userName, role: s.userRole, token: s.userToken } : null; };
  const isRole = (role) => { const u = session(); return !!u && u.role === role; };
  async function logout(msg) {
    await PV().saveSettings({ userId: '', userToken: '', userRole: '', userName: '' });
    if (msg) PV().toast(msg, 'err');
    location.hash = '#/';
  }

  /* ---------------- Entrada con PIN ---------------- */
  function renderGate(role) {
    const P = PV(), { S, esc, toast } = P, r = ROLE[role], app = document.getElementById('app');
    app.innerHTML = `<section class="login"><img class="login-logo" src="./icons/logo-white.png" alt="Puerto Venado">
      <div class="card login-card"><h2 style="margin:0 0 8px">${r.icon} ${esc(r.label)}</h2>
        ${S.settings.syncKey ? '' : '<label class="field"><span>Clave de sincronización (la da la oficina)</span><input id="rgKey" class="input" type="password" autocomplete="off"></label>'}
        <label class="field"><span>¿Quién eres?</span><select id="rgUser" class="select"><option value="">${navigator.onLine ? 'Cargando…' : 'Sin internet: conéctate para entrar'}</option></select></label>
        <label class="field"><span>Tu PIN</span><input id="rgPin" class="input" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>
        <p id="rgErr" class="warn-txt" style="min-height:1.2em"></p>
        <button class="btn btn-primary btn-block" id="rgGo">Entrar</button>
        <a class="btn btn-block" href="#/" style="margin-top:8px">← Volver</a></div>${P.creditFooter()}</section>`;
    const q = (id) => document.getElementById(id), err = q('rgErr');
    const loadRoster = async () => {
      const r2 = await global.Sync.usersCall({ action: 'roster', role });
      const sel = q('rgUser'); if (!sel) return;
      if (!r2.ok) { sel.innerHTML = `<option value="">${esc(r2.error || 'Sin conexión')}</option>`; return; }
      sel.innerHTML = r2.data.users.length ? `<option value="">— Elige tu nombre —</option>${r2.data.users.map((u) => `<option value="${esc(u.id)}" ${S.settings.userId === u.id ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}`
        : `<option value="">La oficina aún no creó usuarios de ${esc(r.label)}</option>`;
    };
    if (S.settings.syncKey) loadRoster();
    else q('rgKey').onchange = async () => { await P.saveSettings({ syncKey: q('rgKey').value.trim() }); loadRoster(); };
    q('rgGo').onclick = async () => {
      err.textContent = '';
      if (q('rgKey') && q('rgKey').value.trim()) await P.saveSettings({ syncKey: q('rgKey').value.trim() });
      const userId = q('rgUser').value, pin = q('rgPin').value.trim();
      if (!userId) { err.textContent = 'Elige tu nombre'; return; }
      if (!/^\d{4,6}$/.test(pin)) { err.textContent = 'El PIN es de 4 a 6 números'; return; }
      q('rgGo').disabled = true;
      const x = await global.Sync.usersCall({ action: 'login', userId, pin, deviceId: await global.Sync.deviceId() });
      q('rgGo').disabled = false;
      if (!x.ok) { err.textContent = x.error || 'No se pudo entrar'; return; }
      await P.saveSettings({ userId: x.data.user.id, userName: x.data.user.name, userRole: x.data.user.role, userToken: x.data.token });
      await P.logEvent('entrada', `${x.data.user.name} entró como ${r.label}`);
      toast(`Bienvenido(a), ${x.data.user.name}`, 'ok');
      location.hash = r.home; P.runSync(true);
    };
  }

  function shell(role, sub) {
    const P = PV(), u = session(), r = ROLE[role];
    return `${P.brandHeader(u.name, `${r.label} · ${sub}`, `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><button class="btn btn-sm" type="button" id="roleOut">Salir</button>`)}`;
  }
  function wire() {
    const P = PV(), b = document.getElementById('bell'), sp = document.getElementById('syncPill'), out = document.getElementById('roleOut');
    if (b) { b.onclick = P.notifSheet; P.updateBell(); }
    if (sp) { sp.onclick = () => P.runSync(true); P.updateSyncPill(); }
    if (out) out.onclick = async () => { if (confirm('¿Cerrar tu sesión en este equipo?')) await logout(); };
  }

  /* ---------------- Gerencia ---------------- */
  // Tomar pedido (todos los clientes), Pedidos del día, consulta de hojas, liquidaciones, vacíos, pagos y crédito,
  // inventario y catálogo, reportes (ventas, rutas, productos sin movimiento) e historial.
  async function renderGerencia(tab) {
    if (!isRole('gerencia')) return renderGate('gerencia');
    const P = PV(), S = P.S;
    if (tab === 'tomar') {
      const cur = S.session && P.sellerById(S.session.sellerId) ? S.session.sellerId : (S.sellers.find((x) => x.active !== false) || {}).id;
      if (!cur) { P.toast('Aún no hay vendedores: sincroniza primero', 'err'); location.hash = '#/gerencia/pedidos'; return; }
      await P.setSession({ sellerId: cur, route: '', activeOrderId: null, gerencia: true });
      location.hash = '#/ruta';
      return;
    }
    if (tab === 'resumen') return P.renderSupervisor('resumen', { base: '#/gerencia', head: () => shell('gerencia', 'Resumen del día'), wire });
    if (tab === 'sinmov') {
      document.getElementById('app').innerHTML = `${shell('gerencia', 'Productos sin movimiento')}<div class="container" id="gerBody"></div>${P.creditFooter()}`;
      wire();
      return global.Reportes.sinMovimiento(document.getElementById('gerBody'));
    }
    return P.renderOffice(tab, { role: 'gerencia', head: () => shell('gerencia', 'Puerto Venado'), wire });
  }

  /* ---------------- Cobranzas: pagos y crédito (D2) y hojas de carga por aprobar (D4) ---------------- */
  function renderCobranzas(tab) {
    if (!isRole('cobranzas')) return renderGate('cobranzas');
    const P = PV(), app = document.getElementById('app');
    P.S.ui.office = P.S.ui.office || {};
    app.innerHTML = `${shell('cobranzas', tab === 'hojas' ? 'Hojas por aprobar' : 'Pagos y crédito')}<div class="container" id="cobBody"></div>${P.creditFooter()}`;
    wire();
    if (tab === 'hojas') return global.Revision.render(document.getElementById('cobBody'));
    global.Pagos.renderOffice(document.getElementById('cobBody'));
  }

  /* ---------------- Oficina: Administración → Usuarios y roles ---------------- */
  async function renderAdmin(root) {
    const P = PV(), { esc, toast, openSheet, fmtDate } = P;
    root.innerHTML = '<p class="muted">Cargando…</p>';
    const r = await global.Sync.usersCall({ action: 'list' }, true);
    if (!r.ok) { root.innerHTML = `<div class="hint warn">${esc(r.error || 'Sin conexión: los usuarios se administran con internet')}</div>`; return; }
    const users = r.data.users;
    const card = (role) => { const list = users.filter((u) => u.role === role); return `<div class="card card-pad" style="margin-bottom:12px"><div class="row" style="align-items:center;gap:8px"><h3 class="grow" style="margin:0">${ROLE[role].icon} ${ROLE[role].label} <span class="muted">(${list.filter((u) => u.active).length} activos)</span></h3><button class="btn btn-sm btn-primary" data-new="${role}">＋ Agregar</button></div>
      ${list.length ? `<table class="inv" style="margin-top:8px"><thead><tr><th>Nombre</th><th>Estado</th><th class="n">Equipos con sesión</th><th>Desde</th><th></th></tr></thead><tbody>${list.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${u.active ? '✅ Activo' : '⛔ Desactivado'}</td><td class="n">${u.devices}</td><td>${esc(fmtDate(String(u.at).slice(0, 10)))}</td>
        <td style="white-space:nowrap"><button class="btn btn-sm" data-pin="${esc(u.id)}">🔑 PIN</button> <button class="btn btn-sm" data-rev="${esc(u.id)}" ${u.devices ? '' : 'disabled'}>Cerrar sesiones</button> <button class="btn btn-sm ${u.active ? 'btn-danger' : ''}" data-act="${esc(u.id)}">${u.active ? 'Desactivar' : 'Activar'}</button></td></tr>`).join('')}</tbody></table>` : '<p class="muted">Sin usuarios todavía.</p>'}</div>`; };
    root.innerHTML = `<p class="muted">Cada persona entra en la pantalla de inicio (👔 Gerencia o 🧾 Cobranzas) con su nombre y su PIN. Solo ve y hace lo de su rol: lo controla el servidor. Si alguien olvida su PIN, ponle uno nuevo aquí.</p>${card('gerencia')}${card('cobranzas')}`;
    const pinPrompt = (title, cb) => {
      const sh = openSheet(`<div class="row"><h2 class="grow">${esc(title)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <label class="field"><span>PIN (4 a 6 números)</span><input id="upPin" class="input" inputmode="numeric" maxlength="6" autocomplete="off"></label><p id="upErr" class="warn-txt"></p>
        <div class="actions"><button class="btn btn-primary" id="upOk">Guardar</button></div>`);
      sh.el.querySelector('#upOk').onclick = async () => { const e = await cb(sh.el.querySelector('#upPin').value.trim()); if (e) sh.el.querySelector('#upErr').textContent = e; else sh.close(); };
    };
    root.onclick = async (e) => {
      const nw = e.target.closest('[data-new]'), pin = e.target.closest('[data-pin]'), rev = e.target.closest('[data-rev]'), act = e.target.closest('[data-act]');
      const by = (P.S.config && P.S.config.adminName) || 'Oficina';
      if (nw) {
        const role = nw.dataset.new, sh = openSheet(`<div class="row"><h2 class="grow">${ROLE[role].icon} Nuevo usuario de ${ROLE[role].label}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
          <label class="field"><span>Nombre y apellido</span><input id="unName" class="input" maxlength="60"></label>
          <label class="field"><span>PIN inicial (4 a 6 números; dáselo en persona)</span><input id="unPin" class="input" inputmode="numeric" maxlength="6" autocomplete="off"></label><p id="unErr" class="warn-txt"></p>
          <div class="actions"><button class="btn btn-primary" id="unOk">Crear</button></div>`);
        sh.el.querySelector('#unOk').onclick = async () => {
          const x = await global.Sync.usersCall({ action: 'create', role, name: sh.el.querySelector('#unName').value, pin: sh.el.querySelector('#unPin').value.trim(), by }, true);
          if (!x.ok) { sh.el.querySelector('#unErr').textContent = x.error; return; }
          sh.close(); toast('Usuario creado', 'ok'); P.logEvent('usuario', `Creó el usuario ${x.data.user.name} (${ROLE[role].label})`); renderAdmin(root);
        };
      }
      if (pin) { const u = users.find((x) => x.id === pin.dataset.pin); pinPrompt(`🔑 PIN nuevo de ${u.name}`, async (v) => { const x = await global.Sync.usersCall({ action: 'pin', id: u.id, pin: v, by }, true); if (!x.ok) return x.error; toast('PIN cambiado: debe entrar de nuevo con el PIN nuevo', 'ok'); P.logEvent('usuario', `Cambió el PIN de ${u.name}`); renderAdmin(root); return ''; }); }
      if (rev) { const u = users.find((x) => x.id === rev.dataset.rev); if (!confirm(`¿Cerrar la sesión de ${u.name} en todos sus equipos?`)) return; const x = await global.Sync.usersCall({ action: 'revoke', id: u.id, by }, true); toast(x.ok ? 'Sesiones cerradas' : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('usuario', `Cerró las sesiones de ${u.name}`); renderAdmin(root); }
      if (act) { const u = users.find((x) => x.id === act.dataset.act); if (u.active && !confirm(`¿Desactivar a ${u.name}? No podrá entrar y se cierran sus sesiones.`)) return; const x = await global.Sync.usersCall({ action: 'update', id: u.id, active: !u.active, by }, true); toast(x.ok ? (u.active ? 'Usuario desactivado' : 'Usuario activado') : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('usuario', `${u.active ? 'Desactivó' : 'Activó'} a ${u.name}`); renderAdmin(root); }
    };
  }

  global.Roles = { session, isRole, logout, renderGate, renderGerencia, renderCobranzas, renderAdmin, ROLE };
})(window);
