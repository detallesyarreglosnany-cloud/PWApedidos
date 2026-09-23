/* =========================================================================
 * app.js — Núcleo (estado, persistencia, sync, router) + Login + Vendedor
 *
 *   #/                  → selector de vendedor (sin contraseña)
 *   #/ruta              → módulo de campo (móvil)
 *   #/oficina/<tab>     → oficina (ver office.js)
 *
 * Expone window.PV con utilidades y estado para office.js.
 * ========================================================================= */
(function () {
  'use strict';

  /* ============================ Utilidades ============================ */
  const app = document.getElementById('app');
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);
  const nf2 = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const nf0 = new Intl.NumberFormat('es-VE', { maximumFractionDigits: 2 });
  const usd = (n) => '$ ' + nf2.format(n || 0);
  const bs = (n) => 'Bs ' + nf2.format(n || 0);
  const int = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return isNaN(n) ? 0 : n; };
  const dec = (v) => {
    let s = String(v == null ? '' : v).replace(/[^\d,.-]/g, '');
    // "1.234,50" | "1234,50" | "1234.50" | "1,234.50"
    if (s.includes(',') && s.includes('.')) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
    else if (s.includes(',')) s = s.replace(',', '.');
    const n = parseFloat(s); return isNaN(n) ? 0 : n;
  };
  const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
  const slug = (s) => norm(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  function fmtDate(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric', month: 'short' });
  }
  /** Stock en unidades → texto. null/'' = sin control de inventario. */
  function fmtStock(units, upb, sellBy) {
    if (units === null || units === undefined || units === '') return '—';
    units = +units || 0; upb = +upb || 1;
    if (sellBy === 'unidad') return nf0.format(units) + ' un';
    if (upb <= 1) return nf0.format(units) + (sellBy === 'caja' ? ' cj' : ' un');
    if (units < 0) return nf0.format(units) + ' un';
    const cj = Math.floor(units / upb), un = units % upb;
    return cj + ' cj' + (un ? ' + ' + un + ' un' : '');
  }
  const hasStock = (p) => p.stock !== null && p.stock !== undefined && p.stock !== '';
  const productLabel = (p) => p.name + ' ' + p.presentation;
  const RUBRO_ICON = {
    REFRESCOS: '🥤', SODA: '🥤', JUGO: '🧃', NECTAR: '🧃', AGUA: '💧', MALTA: '🍺', CERVEZA: '🍺',
    SARDINA: '🐟', CONFITERIA: '🍿', GALLETA: '🍪', ARROZ: '🍚', PASTA: '🍝', MERMELADA: '🍓', GELATINA: '🍮',
    SALSA: '🍅', MAYONESA: '🥫', MOSTAZA: '🥫', LICOR: '🥃',
  };
  const rubroIcon = (c) => RUBRO_ICON[c] || '📦';

  let toastTimer;
  function toast(msg, kind) {
    let el = $('.toast');
    if (!el) { el = document.createElement('div'); document.body.appendChild(el); }
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    el.setAttribute('role', 'status');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.remove(), 2800);
  }

  function openSheet(html, opts) {
    const ov = document.createElement('div');
    ov.className = 'overlay';
    ov.innerHTML = '<div class="sheet ' + ((opts && opts.wide) ? 'wide' : '') + ' ' + ((opts && opts.cls) || '') + '" role="dialog" aria-modal="true">' + html + '</div>';
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); flushDeferredRender(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    ov.addEventListener('click', (e) => { if (e.target === ov || e.target.closest('[data-close]')) close(); });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(ov);
    return { el: ov.querySelector('.sheet'), close };
  }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (e2) { /* noop */ }
      ta.remove(); return ok;
    }
  }

  async function saveFile(filename, text, mime) {
    const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    try {
      const file = new File([blob], filename, { type: blob.type });
      if (matchMedia('(pointer:coarse)').matches && navigator.canShare && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function pickFile(accept) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file'; inp.accept = accept;
      inp.onchange = () => resolve(inp.files[0] || null);
      inp.click();
    });
  }

  /* ============================== Estado ============================== */
  const S = {
    products: [], sellers: [], orders: [], clients: [], loads: [],
    config: null, settings: {}, session: null,
    ui: { q: '', cat: '', onlyInOrder: false, office: {} },
  };
  const DEFAULT_SETTINGS = { csvSep: ';', csvDecimal: ',', syncUrl: '', syncKey: '', adminKey: '', supervisorKey: '' };
  const bc = ('BroadcastChannel' in window) ? new BroadcastChannel('pedidos') : null;

  async function loadAll() {
    const all = await Promise.all(['products', 'sellers', 'orders', 'clients', 'loads', 'config'].map((k) => DB.getAll(k)));
    [S.products, S.sellers, S.orders, S.clients, S.loads] = all.slice(0, 5).map((a) => a.filter((x) => !x.deleted));
    S.config = all[5].find((c) => c.id === 'main') || Seed.defaultConfig();
    S.settings = { ...DEFAULT_SETTINGS, ...(await DB.getMeta('settings', {})) };
    S.session = await DB.getMeta('session', null);
    S.notifs = await DB.getMeta('notifs', []);
    S.officePin = await DB.getMeta('officePin', '');
  }
  const byId = (arr, id) => arr.find((x) => x.id === id);
  const productById = (id) => byId(S.products, id);
  const sellerById = (id) => byId(S.sellers, id);
  const orderById = (id) => byId(S.orders, id);
  const clientById = (id) => byId(S.clients, id);
  const rubros = () => {
    const cfg = (S.config && S.config.rubros) || [];
    const extra = [...new Set(S.products.map((p) => p.category))].filter((c) => !cfg.includes(c)).sort((a, b) => a.localeCompare(b, 'es'));
    return cfg.filter((c) => S.products.some((p) => p.category === c)).concat(extra);
  };

  /** Guarda (y marca pendiente de sync) uno o varios docs de un tipo. */
  async function saveDocs(kind, docs) {
    docs = [].concat(docs).filter(Boolean);
    if (!docs.length) return;
    docs.forEach((d) => DB.touch(d));
    await DB.putMany(kind, docs);
    if (kind === 'config') { S.config = docs[docs.length - 1]; }
    else {
      const arr = S[kind];
      docs.forEach((d) => {
        const i = arr.findIndex((x) => x.id === d.id);
        if (d.deleted) { if (i >= 0) arr.splice(i, 1); }
        else if (i >= 0) arr[i] = d; else arr.push(d);
      });
    }
    notifyChange();
  }
  const saveOrder = (o) => saveDocs('orders', o);
  async function saveSettings(patch) { S.settings = { ...S.settings, ...patch }; await DB.setMeta('settings', S.settings); }
  async function setSession(sess) { S.session = sess; await DB.setMeta('session', sess); }

  /* ====================== Historial de actividad ====================== */
  // Cada acción queda con hora, quién y equipo. Solo se agrega: nadie la edita.
  const lastLogged = new Map();
  async function logEvent(type, text, extra, opts) {
    try {
      const office = isOffice();
      const sid = office ? 'oficina' : (S.session && S.session.sellerId);
      if (!sid) return;
      // Evita repetir el mismo aviso (p. ej. cada toque de cantidad): una vez cada X minutos
      const k = (opts && opts.onceKey) || '';
      if (k && Date.now() - (lastLogged.get(k) || 0) < (opts.everyMin || 10) * 60000) return;
      if (k) lastLogged.set(k, Date.now());
      const seller = office ? null : sellerById(sid);
      const at = DB.now();
      const d = new Date(Date.parse(at));
      const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      await DB.put('events', {
        id: DB.uid('ev'), at, day, type, text: String(text).slice(0, 300),
        sellerId: sid, sellerName: office ? 'Oficina' : (seller ? seller.name : sid),
        deviceId: await Sync.deviceId(), ...(extra || {}), updatedAt: at, dirty: true,
      });
      notifyChange();
    } catch (e) { console.warn('historial', e); }
  }
  const orderSummary = (o) => { const t = Matrix.orderTotals(o); return `${t.items} ítems · ${t.cajas} cj + ${t.unidades} un · ${usd(t.monto)}`; };

  let changeTimer;
  function notifyChange() {
    updateSyncPill();
    clearTimeout(changeTimer);
    changeTimer = setTimeout(() => { if (bc) bc.postMessage('changed'); scheduleSync(4000); }, 300);
  }

  /* ========================= Sincronización UI ========================= */
  let syncTimer, lastSyncResult = null;
  const isOffice = () => location.hash.startsWith('#/oficina');
  function scheduleSync(ms) { clearTimeout(syncTimer); syncTimer = setTimeout(runSync, ms); }

  const isSupervisor = () => location.hash.startsWith('#/supervisor');
  const syncScope = () => (isOffice() || isSupervisor() ? {} : (S.session && S.session.sellerId ? { sellerId: S.session.sellerId } : {}));
  async function runSync(manual) {
    const scope = syncScope();
    // En la primera descarga de un equipo llega todo el historial: no se avisa pedido por pedido
    const firstSync = !(await Sync.hasCursor(scope));
    const r = await Sync.syncNow(scope);
    lastSyncResult = r;
    // También se recarga si el servidor devolvió su versión de algo rechazado:
    // si no, la pantalla seguiría mostrando (y volvería a guardar) la copia vieja.
    if (r.ok && (r.pulled || r.reverted)) {
      const before = new Map(S.orders.map((o) => [o.id, o]));
      await loadAll();
      if (!firstSync) await detectNotifs(before);
      refreshAfterRemote();
    }
    if (manual) {
      if (r.ok) toast('Sincronizado · ↑' + r.pushed + ' ↓' + r.pulled + (r.rejected ? ' · ' + r.rejected + ' ya en manos de la oficina' : ''), 'ok');
      else if (r.offline) toast('Sin internet: todo queda guardado en el equipo', 'err');
      else toast(r.error || 'No se pudo sincronizar', 'err');
    }
    updateSyncPill();
    scheduleSync(isOffice() ? 20000 : 45000);
    return r;
  }

  async function updateSyncPill() {
    const el = $('#syncPill');
    if (!el) return;
    const pending = await Sync.pendingCount(syncScope());
    const online = navigator.onLine;
    const serverDown = lastSyncResult && !lastSyncResult.ok && !lastSyncResult.offline;
    el.className = 'pill' + (!online || serverDown ? ' offline' : '') + (pending ? ' pending' : '');
    const r = lastSyncResult || {};
    const label = !online ? 'Sin señal' : r.noKey ? 'Falta clave' : r.status === 401 ? 'Clave inválida' : serverDown ? 'Sin servidor' : 'En línea';
    el.innerHTML = '<span class="dot"></span>' + label +
      (pending ? ' · ' + pending : '');
    el.title = lastSyncResult && lastSyncResult.error ? lastSyncResult.error : 'Tocar para sincronizar';
  }

  /* ===================== Notificaciones (oficina) ===================== */
  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      [880, 1320].forEach((f, i) => {
        const o = audioCtx.createOscillator(), g = audioCtx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0.0001, audioCtx.currentTime + i * 0.16);
        g.gain.exponentialRampToValueAtTime(0.25, audioCtx.currentTime + i * 0.16 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + i * 0.16 + 0.15);
        o.connect(g).connect(audioCtx.destination); o.start(audioCtx.currentTime + i * 0.16); o.stop(audioCtx.currentTime + i * 0.16 + 0.16);
      });
    } catch (e) { /* sin audio */ }
  }
  /** Compara antes/después de un sync y avisa: pedido nuevo, modificado por vendedor, cliente duplicado. */
  async function detectNotifs(before) {
    if (!isOffice()) return;
    const out = [];
    S.orders.forEach((o) => {
      const p = before.get(o.id), who = o.sellerName;
      if (o.status === 'enviado' && (!p || p.status !== 'enviado')) out.push({ icon: '🧾', msg: `Nuevo pedido de ${who}: ${o.clientName}` });
      else if (o.sellerEdited && (!p || p.sellerEdited !== o.sellerEdited)) out.push({ icon: '✏️', msg: `${who} modificó el pedido de ${o.clientName}` });
      if ((o.dupWith || []).length && !(p && (p.dupWith || []).length)) out.push({ icon: '⚠️', warn: true, msg: `Cliente duplicado: ${o.clientName} (${who} y ${o.dupWith.map((d) => d.sellerName).join(', ')})` });
    });
    if (!out.length) return;
    const at = new Date().toISOString();
    S.notifs = out.map((n) => ({ ...n, at, read: false })).concat(S.notifs || []).slice(0, 80);
    await DB.setMeta('notifs', S.notifs);
    beep();
    try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('Puerto Venado', { body: out.map((n) => n.msg).join('\n'), icon: './icons/icon-192.png' }); } catch (e) { /* noop */ }
    updateBell();
  }
  function updateBell() {
    const b = $('#bell'); if (!b) return;
    const n = (S.notifs || []).filter((x) => !x.read).length;
    b.innerHTML = '🔔' + (n ? `<span class="bell-n">${n > 99 ? '99+' : n}</span>` : '');
    b.classList.toggle('ring', n > 0);
  }

  let deferredRender = false;
  function refreshAfterRemote() {
    const a = document.activeElement;
    const typing = a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT') && app.contains(a);
    if ($('.overlay') || typing) { deferredRender = true; return; }
    deferredRender = false;
    render();
  }
  function flushDeferredRender() {
    if (!deferredRender) return;
    setTimeout(() => { if (deferredRender) refreshAfterRemote(); }, 0);
  }

  /* =============================== Router =============================== */
  function render() {
    const h = location.hash || '#/';
    if (h.startsWith('#/oficina')) return PV.renderOffice(h.split('/')[2] || 'cargas');
    if (h.startsWith('#/supervisor')) return PV.renderSupervisor(h.split('/')[2] || 'resumen');
    if (h === '#/ruta' && S.session && sellerById(S.session.sellerId)) return renderSeller();
    return renderLogin();
  }

  /** Créditos del proyecto (editable en Ajustes → Mi perfil). */
  function creditFooter() {
    const t = (S.config && S.config.footer) || '';
    return t ? `<footer class="credit">${esc(t)}</footer>` : '';
  }

  function brandHeader(title, sub, right) {
    return `<header class="topbar">
      <img class="brand-mark" src="./icons/mark-white.png" alt="Puerto Venado" width="40" height="40">
      <div class="grow"><h1>${esc(title)}<small>${esc(sub)}</small></h1></div>${right}</header>`;
  }

  /* =============================== Login =============================== */
  function renderLogin() {
    const active = S.sellers.filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const last = S.session && S.session.sellerId;
    app.innerHTML = `
      <section class="login">
        <img class="login-logo" src="./icons/logo-white.png" alt="Distribuidora de Suministros Puerto Venado">
        <div class="card login-card">
          <label class="field"><span>¿Quién eres?</span>
            <select id="sellerSel" class="select" aria-label="Vendedor">
              <option value="">— Elige tu nombre —</option>
              ${active.map((s) => `<option value="${esc(s.id)}" ${s.id === last ? 'selected' : ''}>${esc(s.name)}${s.routes && s.routes.length ? ' · ' + esc(s.routes.join(', ')) : ''}</option>`).join('')}
            </select>
          </label>
          <button id="enterBtn" class="btn btn-primary btn-block" ${last ? '' : 'disabled'}>Entrar a mi ruta →</button>
          <div class="divider">o</div>
          <a class="btn btn-block" href="#/oficina/cargas">🖥️ Oficina · Administración</a>
          <a class="btn btn-block" href="#/supervisor" style="margin-top:8px">👁 Supervisor · Solo consulta</a>
        </div>
        ${creditFooter()}
      </section>`;
    const sel = $('#sellerSel'), btn = $('#enterBtn');
    sel.onchange = () => { btn.disabled = !sel.value; };
    btn.onclick = async () => {
      if (!sel.value) return;
      const s = sellerById(sel.value);
      const same = S.session && S.session.sellerId === sel.value;
      await setSession({
        sellerId: sel.value,
        activeOrderId: same ? S.session.activeOrderId : null,
        route: same && S.session.route ? S.session.route : ((s.routes && s.routes[0]) || ''),
      });
      location.hash = '#/ruta';
      await logEvent('entrada', `Entró a su ruta${S.session.route ? ' ' + S.session.route : ''}`);
      runSync(false);
    };
  }

  /* ========================== Módulo de campo ========================== */
  const editable = (o) => Loads.editable(o);
  // Mientras la hoja no esté aprobada (🔒), el vendedor puede borrar un pedido hecho por error
  const canDelete = (o) => editable(o);

  function myOrdersToday() {
    const sid = S.session.sellerId, d = today();
    return S.orders.filter((o) => o.sellerId === sid && o.routeDate === d)
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  }
  function activeOrder() {
    const o = S.session.activeOrderId && orderById(S.session.activeOrderId);
    return o && o.routeDate === today() ? o : null;
  }
  function myClients() {
    const sid = S.session.sellerId;
    return S.clients.filter((c) => c.sellerId === sid && c.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // Candado: elegir de la lista dispara "change" y "submit" a la vez; sin esto
  // se creaban dos pedidos (y dos clientes nuevos) para el mismo cliente.
  let opening = Promise.resolve();
  function openClient(name) {
    opening = opening.then(() => openClientNow(name)).catch((e) => toast(e.message || 'Error', 'err'));
    return opening;
  }
  async function openClientNow(name) {
    name = String(name || '').replace(/\s+/g, ' ').trim();
    if (!name) { toast('Escribe o elige el cliente', 'err'); return; }
    if (name.length > 80) name = name.slice(0, 80);
    const key = norm(name);
    const seller = sellerById(S.session.sellerId);
    let client = myClients().find((c) => norm(c.name) === key);
    let o = myOrdersToday().find((x) => x.clientKey === key);
    if (!o) {
      if (!client) {
        // Cliente nuevo captado en la calle: la oficina lo verá en Clientes
        client = { id: DB.uid('c'), rif: '', name, phone: '', address: '', group: '', creditDays: 0,
          sellerId: seller.id, route: S.session.route || '', active: true, source: 'campo', deleted: false };
        await saveDocs('clients', client);
        await logEvent('cliente_nuevo', `Creó el cliente nuevo ${client.name}`, { clientId: client.id, clientName: client.name });
      }
      o = {
        id: DB.uid('o'), sellerId: seller.id, sellerName: seller.name,
        clientId: client.id, clientRif: client.rif || '', clientName: client.name, clientKey: key,
        route: client.route || S.session.route || '', routeDate: today(),
        status: 'abierto', lines: {}, notes: '', loadId: null,
        createdAt: DB.now(), deviceId: await Sync.deviceId(), deleted: false,
      };
      await saveOrder(o);
      await logEvent('pedido_nuevo', `Abrió pedido de ${client.name}`, { orderId: o.id, clientId: client.id, clientName: client.name });
      toast('Cliente: ' + client.name, 'ok');
    }
    await setSession({ ...S.session, activeOrderId: o.id });
    renderSeller();
  }

  function filteredProducts() {
    const tokens = norm(S.ui.q).split(' ').filter(Boolean);
    const o = activeOrder();
    const order = rubros();
    return S.products.filter((p) => {
      if (!p.active) return false;
      if (S.ui.cat && p.category !== S.ui.cat) return false;
      if (S.ui.onlyInOrder && !(o && o.lines[p.id])) return false;
      if (!tokens.length) return true;
      const hay = norm(p.code + ' ' + p.name + ' ' + p.presentation + ' ' + p.category + ' ' + (p.brand || ''));
      return tokens.every((t) => hay.includes(t));
    }).sort(productSort(order));
  }
  /** Orden del catálogo: rubro (configurable) → orden manual → nombre. */
  function productSort(order) {
    order = order || rubros();
    return (a, b) => order.indexOf(a.category) - order.indexOf(b.category) ||
      (+a.sort || 9999) - (+b.sort || 9999) || a.name.localeCompare(b.name, 'es') ||
      a.code.localeCompare(b.code, 'es', { numeric: true });
  }

  function stepperHTML(p, kind, value, over) {
    const lbl = kind === 'cajas' ? 'CAJAS' : 'UNID.';
    return `
      <div class="stepper ${value ? 'active' : ''} ${over ? 'over' : ''}">
        <button type="button" data-act="dec" data-kind="${kind}" aria-label="Restar ${lbl.toLowerCase()}">−</button>
        <label><small>${lbl}</small>
          <input type="text" inputmode="numeric" pattern="[0-9]*" data-kind="${kind}" value="${value || ''}" placeholder="0" aria-label="${lbl.toLowerCase()} de ${esc(productLabel(p))}">
        </label>
        <button type="button" class="plus" data-act="inc" data-kind="${kind}" aria-label="Sumar ${lbl.toLowerCase()}">+</button>
      </div>`;
  }

  // Color estable por grupo (categoría + subgrupo): mismo grupo → mismo color siempre,
  // sin listas que mantener. Distribuye los tonos (hue 0-360) según el texto.
  const grpHue = (() => {
    const cache = new Map();
    return (key) => {
      if (cache.has(key)) return cache.get(key);
      let h = 0; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
      const hue = h % 360;
      cache.set(key, hue);
      return hue;
    };
  })();

  function productHTML(p, o) {
    const l = o && o.lines[p.id];
    const cj = l ? l.cajas : 0, un = l ? l.unidades : 0;
    const req = cj * p.unitsPerBox + un;
    const over = hasStock(p) && req > 0 && req > p.stock;
    const low = hasStock(p) && p.stock <= (p.sellBy === 'unidad' ? 3 : p.unitsPerBox * 2);
    const prices = [];
    if (p.sellBy !== 'unidad') prices.push(`<span>Caja${p.unitsPerBox > 1 ? ' x' + p.unitsPerBox : ''}</span><b>${usd(p.boxPrice)}</b>`);
    if (p.sellBy !== 'caja') prices.push(`<span>Unidad</span><b>${usd(p.unitPrice)}</b>`);
    return `
      <article class="pitem ${req ? 'has-qty' : ''}" data-pid="${esc(p.id)}" style="--grp:${grpHue(p.category + '|' + (p.subgroup || ''))}">
        <div class="pimg">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : `<span aria-hidden="true">${rubroIcon(p.category)}</span>`}
          ${req ? `<em class="qty-badge">${cj ? cj + 'cj' : ''}${cj && un ? '+' : ''}${un ? un + 'u' : ''}</em>` : ''}</div>
        <div class="pname">${esc(p.name)}</div>
        <div class="ppres">${esc(p.presentation)}${p.brand && !norm(p.name).includes(norm(p.brand)) ? ' · ' + esc(p.brand) : ''}</div>
        <div class="pprice">${prices.map((x) => '<div>' + x + '</div>').join('')}</div>
        <div class="pmeta"><span class="mono">${esc(p.code)}</span>
          ${hasStock(p) ? `<span class="${over || low ? 'stock-low' : ''}">${over ? '⚠ ' : ''}${fmtStock(p.stock, p.unitsPerBox, p.sellBy)}</span>` : ''}</div>
        <div class="qty-col">
          ${p.sellBy !== 'unidad' ? stepperHTML(p, 'cajas', cj, over) : ''}
          ${p.sellBy !== 'caja' ? stepperHTML(p, 'unidades', un, over) : ''}
        </div>
      </article>`;
  }

  const STATUS_MARK = { enviado: '✓ ', en_carga: '🚚 ', en_espera: '⏸ ', despachado: '▣ ' };
  const markOf = (o) => (o.locked && o.status !== 'despachado' ? '🔒 ' : STATUS_MARK[o.status] || '');

  function renderSeller() {
    const seller = sellerById(S.session.sellerId);
    const orders = myOrdersToday();
    const o = activeOrder();
    const cats = rubros();
    const routes = (seller.routes && seller.routes.length) ? seller.routes : (S.config.routes || []);
    const clients = myClients();
    app.innerHTML = `
      ${brandHeader(seller.name, 'Ruta ' + (S.session.route || '—') + ' · ' + fmtDate(today()),
        `<button id="syncPill" class="pill" type="button"></button><button class="icon-btn ghost" id="menuBtn" aria-label="Menú">☰</button>`)}
      <section class="client-bar">
        <div class="row wrap client-row">
          ${routes.length > 1 ? `<select id="routeSel" class="select route-sel" aria-label="Ruta del día">
            ${routes.map((r) => `<option ${r === S.session.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>` : ''}
          <form id="clientForm" class="row grow" autocomplete="off">
            <input id="clientInput" class="input grow" enterkeyhint="go" autocomplete="off"
                   placeholder="Cliente (${clients.length} en tu cartera)" aria-label="Nombre del cliente" maxlength="80">
            <button class="btn btn-primary" type="submit" aria-label="Abrir cliente">＋</button>
          </form>
        </div>
        <div id="clientSug" class="suggest" role="listbox" aria-label="Clientes que coinciden"></div>
        <div class="chips" id="clientChips" role="tablist" aria-label="Clientes de hoy">
          ${orders.length ? orders.map((x) => {
            const t = Matrix.orderTotals(x);
            return `<button class="chip ${o && o.id === x.id ? 'active' : ''} st-${x.status}" data-oid="${esc(x.id)}" role="tab">
              ${markOf(x)}${esc(x.clientName)} <span class="badge">${usd(t.monto)}</span></button>`;
          }).join('') : '<span class="muted" style="padding:10px 2px">Escribe el primer cliente de tu ruta de hoy.</span>'}
        </div>
      </section>
      <section class="catalog-tools">
        <div class="search"><input id="q" class="input" type="search" placeholder="Buscar producto, sabor, gramaje o código…" value="${esc(S.ui.q)}" aria-label="Buscar producto"></div>
        <div class="chips" id="catChips">
          <button class="chip ${!S.ui.cat && !S.ui.onlyInOrder ? 'active' : ''}" data-cat="">Todos</button>
          <button class="chip ${S.ui.onlyInOrder ? 'active' : ''}" data-only="1">🧾 En pedido</button>
          ${cats.map((c) => `<button class="chip ${S.ui.cat === c ? 'active' : ''}" data-cat="${esc(c)}">${rubroIcon(c)} ${esc(c)}</button>`).join('')}
        </div>
      </section>
      <section class="plist" id="plist"></section>
      <footer class="cart-bar" id="bottomBar"></footer>`;

    renderProductList();
    renderBottomBar();
    updateSyncPill();

    const rs = $('#routeSel');
    if (rs) rs.onchange = async () => { await setSession({ ...S.session, route: rs.value }); renderSeller(); };
    $('#clientForm').onsubmit = (e) => { e.preventDefault(); openClient($('#clientInput').value); };
    // Buscador: desde 2 letras muestra coincidencias de la cartera (nombre, RIF,
    // dirección o teléfono); si no aparece, se escribe y se crea como nuevo.
    const sug = $('#clientSug');
    $('#clientInput').addEventListener('input', (e) => {
      const q = norm(e.target.value);
      if (q.length < 2) { sug.innerHTML = ''; return; }
      const tokens = q.split(' ').filter(Boolean);
      const clean = (x) => norm(x).replace(/^[^a-z0-9]+/, '');
      const rank = (c) => (clean(c.name).startsWith(q) ? 0 : clean(c.name).split(' ').some((w) => w.startsWith(tokens[0])) ? 1 : 2);
      const hits = clients.filter((c) => { const h = norm(c.name + ' ' + c.rif + ' ' + c.address + ' ' + c.phone); return tokens.every((t) => h.includes(t)); })
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es')).slice(0, 8);
      sug.innerHTML = hits.map((c) => `<button type="button" class="sug-item" data-name="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc([c.rif, c.address].filter(Boolean).join(' · '))}</small></button>`).join('') +
        `<button type="button" class="sug-item new" data-name="${esc(e.target.value.trim())}">＋ Usar «${esc(e.target.value.trim())}» como cliente nuevo</button>`;
    });
    sug.onclick = (e) => { const b = e.target.closest('[data-name]'); if (b) { sug.innerHTML = ''; openClient(b.dataset.name); } };
    $('#clientChips').onclick = async (e) => {
      const b = e.target.closest('[data-oid]'); if (!b) return;
      await setSession({ ...S.session, activeOrderId: b.dataset.oid });
      renderSeller();
    };
    let qt;
    $('#q').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { S.ui.q = e.target.value; renderProductList(); }, 90); };
    $('#catChips').onclick = (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      if (b.dataset.only) { S.ui.onlyInOrder = !S.ui.onlyInOrder; S.ui.cat = ''; }
      else { S.ui.cat = b.dataset.cat; S.ui.onlyInOrder = false; }
      $$('#catChips .chip').forEach((c) => c.classList.toggle('active',
        c.dataset.only ? S.ui.onlyInOrder : (!S.ui.onlyInOrder && c.dataset.cat === S.ui.cat)));
      renderProductList();
    };
    $('#syncPill').onclick = () => runSync(true);
    $('#menuBtn').onclick = sellerMenu;

    const list = $('#plist');
    list.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const pid = b.closest('[data-pid]').dataset.pid;
      const cur0 = activeOrder();
      const l = cur0 && cur0.lines[pid];
      const cur = l ? l[b.dataset.kind] : 0;
      setQty(pid, b.dataset.kind, cur + (b.dataset.act === 'inc' ? 1 : -1));
      if (navigator.vibrate) navigator.vibrate(8);
    });
    list.addEventListener('focusin', (e) => { if (e.target.matches('input[data-kind]')) e.target.select(); });
    list.addEventListener('change', (e) => {
      const inp = e.target.closest('input[data-kind]'); if (!inp) return;
      setQty(inp.closest('[data-pid]').dataset.pid, inp.dataset.kind, int(inp.value));
    });
    list.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('input[data-kind]')) e.target.blur(); });
  }

  function renderProductList() {
    const list = $('#plist'); if (!list) return;
    const items = filteredProducts();
    const o = activeOrder();
    let hint = '';
    if (!o) hint = `<div class="hint">👆 Primero escribe o elige el cliente. Las cantidades se cargan a ese cliente.</div>`;
    else if (!editable(o)) hint = `<div class="hint warn">🔒 Este pedido está <b>${esc(Loads.orderLabel(o))}</b>: la carga ya fue aprobada y no se puede modificar.</div>`;
    if (o && o.dupWith && o.dupWith.length) hint += dupHint(o);
    if (o && o.loadId && editable(o)) hint += `<div class="hint">✏️ Este pedido ya está en una hoja de carga (<b>${esc(Loads.orderLabel(o))}</b>). Aún puedes modificarlo; la oficina verá los cambios.</div>`;
    if (!S.products.length) {
      list.innerHTML = `<div class="empty"><strong>Catálogo vacío</strong>Toca ⟳ para sincronizar con la oficina.</div>`;
      return;
    }
    // Encabezados de rubro / subgrupo (ej. REFRESCOS · 2 L)
    let last = '';
    const html = items.map((p) => {
      const key = p.category + '|' + (p.subgroup || '');
      const head = key !== last ? `<h3 class="plist-head">${rubroIcon(p.category)} ${esc(p.category)}${p.subgroup ? ' · <span>' + esc(p.subgroup) + '</span>' : ''}</h3>` : '';
      last = key;
      return head + productHTML(p, o);
    }).join('');
    list.innerHTML = hint + (items.length ? html
      : `<div class="empty"><strong>Sin resultados</strong>Prueba con otra palabra o rubro.</div>`);
  }

  function renderBottomBar() {
    const bar = $('#bottomBar'); if (!bar) return;
    const o = activeOrder();
    if (!o) { bar.innerHTML = `<div class="cart-info">Sin cliente seleccionado · ${myOrdersToday().length} clientes hoy</div>`; return; }
    const t = Matrix.orderTotals(o);
    const rate = +S.config.exchangeRate || 0;
    bar.innerHTML = `
      <div class="cart-info"><b>${esc(o.clientName)}</b> · ${t.cajas} cj + ${t.unidades} un${rate ? ' · ' + bs(t.monto * rate) : ''}
        ${o.status !== 'abierto' ? ` · <span class="status ${o.status}">${esc(Loads.orderLabel(o))}</span>` : ''}</div>
      <button class="cart-btn" id="viewOrder">Ver pedido (${t.items} ítems) · ${usd(t.monto)}</button>`;
    $('#viewOrder').onclick = orderSheet;
  }

  async function setQty(pid, kind, value) {
    const o = activeOrder();
    if (!o) { toast('Primero escribe el nombre del cliente', 'err'); $('#clientInput').focus(); return; }
    if (!editable(o)) { toast('Pedido bloqueado (' + Loads.orderLabel(o) + '): ya no se puede modificar', 'err'); return; }
    const p = productById(pid); if (!p) return;
    value = Math.max(0, Math.min(99999, int(value)));
    const line = o.lines[pid] || {
      // Snapshot: el pedido conserva precio y descripción del momento de la venta
      code: p.code, name: p.name, presentation: p.presentation, category: p.category,
      unitsPerBox: p.unitsPerBox, unitPrice: p.unitPrice, boxPrice: p.boxPrice, cajas: 0, unidades: 0,
    };
    line[kind] = value;
    if (!line.cajas && !line.unidades) delete o.lines[pid]; else o.lines[pid] = line;
    if (o.status === 'enviado') {
      o.status = 'abierto'; toast('Pedido reabierto: recuerda enviarlo de nuevo');
      logEvent('pedido_reabierto', `Reabrió el pedido de ${o.clientName} para modificarlo`, { orderId: o.id, clientName: o.clientName });
    } else if (o.loadId || o.status === 'en_espera') {
      o.sellerEdited = DB.now(); // la oficina ve "modificado por el vendedor"
      logEvent('pedido_modificado', `Modificó el pedido de ${o.clientName} (ya estaba en hoja de carga)`, { orderId: o.id, clientName: o.clientName }, { onceKey: 'mod:' + o.id });
    }
    await saveOrder(o);
    const card = $(`#plist [data-pid="${CSS.escape(pid)}"]`);
    if (card) {
      if (S.ui.onlyInOrder && !o.lines[pid]) card.remove();
      else card.outerHTML = productHTML(p, o);
    }
    renderBottomBar();
    const chip = $(`#clientChips [data-oid="${CSS.escape(o.id)}"]`);
    if (chip) chip.innerHTML = `${esc(o.clientName)} <span class="badge">${usd(Matrix.orderTotals(o).monto)}</span>`;
  }

  /** Alerta (no bloquea): el mismo cliente tiene otro pedido ese día (mismo u otro vendedor). */
  function dupHint(o) {
    return `<div class="hint warn">⚠ <b>Cliente posiblemente duplicado:</b> ${esc(o.clientName)} también tiene pedido hoy con ${o.dupWith.map((d) => esc(d.sellerName)).join(', ')}. Verifica que no sea un error.</div>`;
  }

  function orderLinesHTML(o) {
    const lines = Object.values(o.lines).map((l) => ({ l, t: Matrix.lineTotals(l) }))
      .sort((a, b) => a.l.category.localeCompare(b.l.category, 'es') || a.l.name.localeCompare(b.l.name, 'es'));
    const tot = Matrix.orderTotals(o);
    const rate = +S.config.exchangeRate || 0;
    if (!lines.length) return '<div class="empty"><strong>Pedido vacío</strong>Agrega productos desde el catálogo.</div>';
    return `<table class="lines">${lines.map(({ l, t }) => `
        <tr><td><b>${esc(l.name)} ${esc(l.presentation)}</b><div class="muted mono" style="font-size:12px">${esc(l.code)} · ${t.cajas ? t.cajas + ' cj × ' + usd(l.boxPrice) : ''}${t.cajas && t.unidades ? ' + ' : ''}${t.unidades ? t.unidades + ' un × ' + usd(l.unitPrice) : ''}</div></td>
            <td class="num">${usd(t.monto)}</td></tr>`).join('')}
        <tr class="total-row"><td><b>TOTAL</b> · ${tot.cajas} cj + ${tot.unidades} un</td>
            <td class="num">${usd(tot.monto)}${rate ? `<div class="muted" style="font-size:12px">${bs(tot.monto * rate)}</div>` : ''}</td></tr>
      </table>`;
  }

  function orderSheet() {
    const o = activeOrder(); if (!o) return;
    const locked = !editable(o);
    const client = clientById(o.clientId) || {};
    const sh = openSheet(`
      <div class="row"><div class="grow"><h2>${esc(o.clientName)}</h2>
        <div class="muted">${esc([client.rif, client.address].filter(Boolean).join(' · '))}</div>
        <div class="muted">${esc(fmtDate(o.routeDate))} · Ruta ${esc(o.route || '—')} · <span class="status ${o.status}">${esc(Loads.orderLabel(o))}</span></div></div>
        <button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${o.dupWith && o.dupWith.length ? dupHint(o) : ''}
      ${o.officeEdited ? '<div class="hint warn">La oficina ajustó cantidades de este pedido.</div>' : ''}
      ${orderLinesHTML(o)}
      <label class="field" style="margin-top:14px"><span>Nota para despacho</span>
        <textarea id="notes" class="input" maxlength="300" placeholder="Ej: entregar antes de las 10am, cobrar en divisas…" ${locked ? 'disabled' : ''}>${esc(o.notes || '')}</textarea></label>
      <div class="actions">
        ${o.status === 'abierto' ? `<button class="btn btn-ok" id="sendOrder" ${Object.keys(o.lines).length ? '' : 'disabled'}>✓ Cerrar y enviar</button>` : ''}
        ${!locked && o.status !== 'abierto' ? '<button class="btn btn-primary" data-close>✓ Listo (cambios guardados)</button>' : ''}
        <button class="btn btn-danger" id="delOrder" ${canDelete(o) ? '' : 'disabled'}>Eliminar</button>
      </div>`, { cls: 'sheet-order' });
    const notes = $('#notes', sh.el);
    notes.onchange = async () => { o.notes = notes.value.slice(0, 300); await saveOrder(o); };
    const send = $('#sendOrder', sh.el);
    if (send) send.onclick = async () => {
      o.notes = notes.value.slice(0, 300);
      o.status = 'enviado'; o.sentAt = DB.now();
      await saveOrder(o);
      await logEvent('pedido_enviado', `Envió el pedido de ${o.clientName} · ${orderSummary(o)}`, { orderId: o.id, clientName: o.clientName, amount: Matrix.orderTotals(o).monto });
      await setSession({ ...S.session, activeOrderId: null });
      sh.close(); renderSeller();
      toast('Pedido enviado. ' + (navigator.onLine ? 'Subiendo…' : 'Se subirá al tener señal.'), 'ok');
      runSync(false);
      setTimeout(() => { const i = $('#clientInput'); if (i) i.focus(); }, 50);
    };
    $('#delOrder', sh.el).onclick = async () => {
      if (!confirm('¿Eliminar el pedido de ' + o.clientName + '?')) return;
      o.deleted = true;
      await saveOrder(o);
      await logEvent('pedido_eliminado', `Eliminó el pedido de ${o.clientName} · ${orderSummary(o)}`, { orderId: o.id, clientName: o.clientName });
      await setSession({ ...S.session, activeOrderId: null });
      sh.close(); renderSeller(); toast('Pedido eliminado');
      runSync(false);
    };
  }

  function sellerMenu() {
    const orders = myOrdersToday();
    const total = orders.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0);
    const last = lastSyncResult;
    const sh = openSheet(`
      <div class="row"><h2 class="grow">Mi ruta de hoy</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">${orders.length} clientes · <b>${usd(total)}</b></p>
      <table class="lines">${orders.map((o) => `<tr><td>${markOf(o)}${esc(o.clientName)}<div class="muted" style="font-size:12px">${esc(Loads.orderLabel(o))}</div></td><td class="num">${usd(Matrix.orderTotals(o).monto)}</td></tr>`).join('')}</table>
      <div class="actions" style="flex-direction:column">
        <button class="btn btn-primary" id="mSync">⟳ Sincronizar ahora</button>
        <button class="btn" id="mExport">⇪ Enviar pedidos de hoy por archivo (WhatsApp)</button>
        <button class="btn" id="mImport">⇩ Cargar catálogo desde archivo</button>
      </div>
      <details style="margin-top:16px"><summary class="section-title" style="display:inline">Conexión</summary>
        <div style="display:grid;gap:10px;margin-top:10px">
          <label class="field"><span>Clave de sincronización</span><input id="mKey" class="input" type="password" autocomplete="off" value="${esc(S.settings.syncKey)}"></label>
          <label class="field"><span>Servidor (opcional)</span><input id="mUrl" class="input" placeholder="${esc(Sync.DEFAULT_SYNC_URL)}" value="${esc(S.settings.syncUrl)}"></label>
          <button class="btn" id="mSave">Guardar conexión</button>
          <div class="muted" style="font-size:13px">${last ? (last.ok ? 'Último sync correcto.' : 'Último intento: ' + esc(last.error || 'sin señal')) : ''}</div>
        </div>
      </details>
      <div class="actions"><button class="btn btn-danger" id="mOut">Cambiar de vendedor</button></div>
      ${creditFooter()}`);
    $('#mSync', sh.el).onclick = () => runSync(true);
    $('#mExport', sh.el).onclick = async () => {
      const seller = sellerById(S.session.sellerId);
      const b = await Sync.exportBundle({ sellerId: seller.id, routeDate: today() });
      await saveFile('pedidos_' + slug(seller.name) + '_' + today() + '.json', JSON.stringify(b), 'application/json');
    };
    $('#mImport', sh.el).onclick = async () => {
      const f = await pickFile('.json,application/json'); if (!f) return;
      try { const n = await Sync.importBundle(JSON.parse(await f.text()), false); await loadAll(); sh.close(); renderSeller(); toast(n + ' registros actualizados', 'ok'); }
      catch (e) { toast(e.message, 'err'); }
    };
    $('#mSave', sh.el).onclick = async () => {
      await saveSettings({ syncKey: $('#mKey', sh.el).value.trim(), syncUrl: $('#mUrl', sh.el).value.trim() });
      toast('Conexión guardada', 'ok'); runSync(true);
    };
    $('#mOut', sh.el).onclick = async () => { await logEvent('salida', 'Salió de su ruta (cambiar de vendedor)'); await setSession(null); sh.close(); location.hash = '#/'; };
  }

  /* =============================== Arranque =============================== */
  async function boot() {
    try {
      await DB.open();
      await Seed.ensureSeed();
      await loadAll();
    } catch (e) {
      app.innerHTML = `<div class="empty"><strong>No se pudo abrir la base local</strong>${esc(e.message)}</div>`;
      return;
    }
    DB.requestPersistence();
    window.addEventListener('hashchange', render);
    window.addEventListener('online', () => { updateSyncPill(); runSync(false); });
    window.addEventListener('offline', updateSyncPill);
    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > 15 * 60000) logEvent('regreso', 'Volvió a la app');
      hiddenAt = 0;
      runSync(false);
    });
    if (bc) bc.onmessage = async () => { await loadAll(); refreshAfterRemote(); };
    app.addEventListener('focusout', flushDeferredRender);
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      // Versión nueva publicada: el service worker toma el control y la página se
      // recarga una vez (los datos viven en IndexedDB, no se pierde nada).
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true; location.reload();
      });
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch((e) => console.warn('SW no registrado', e));
    }
    render();
    logEvent('apertura', isOffice() ? 'Abrió la oficina' : isSupervisor() ? 'Entró como supervisor' : 'Abrió la app');
    scheduleSync(1200);
  }
  // Arranque: lo invoca index.html después de cargar office.js

  window.PV = {
    S, $, $$, esc, nf2, nf0, usd, bs, int, dec, norm, slug, today, fmtDate, fmtStock, hasStock, productSort, productLabel, rubroIcon,
    toast, openSheet, copyText, saveFile, pickFile, brandHeader, creditFooter,
    loadAll, saveDocs, saveOrder, saveSettings, setSession, runSync, updateSyncPill, render, updateBell, beep, logEvent, isSupervisor,
    productById, sellerById, orderById, clientById, rubros, orderLinesHTML,
    boot,
  };
})();
