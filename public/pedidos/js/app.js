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
    S.epoch = await DB.getMeta('epoch', '');
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
    // Datos reiniciados (en esta u otra pestaña): la pantalla tiene datos viejos, no se guardan
    if (await epochChanged()) { location.reload(); return; }
    // Pedidos y hojas: se anota qué campos cambiaron (fusión campo por campo entre
    // equipos). El vendedor no marca el estado/hoja de sus pedidos (eso lo decide
    // la oficina), salvo abrir/enviar un pedido que aún no tomó la oficina.
    const byField = kind === 'orders' || kind === 'loads';
    const prevs = byField ? await Promise.all(docs.map((d) => DB.get(kind, d.id))) : [];
    const SELLER_ST = ['abierto', 'enviado'];
    const skipOf = (prev, d) => (kind === 'orders' && !isOffice() && !(prev && SELLER_ST.includes(prev.status) && SELLER_ST.includes(d.status)) ? DB.FV_GROUPS.orders : null);
    docs.forEach((d, i) => { DB.touch(d); if (byField) DB.stampFields(prevs[i], d, skipOf(prevs[i], d)); });
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
  async function epochChanged() {
    return (await DB.getMeta('epoch', '')) !== (S.epoch || '') || !!(await DB.getMeta('resetPending', null));
  }
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
  // Una sola sincronización a la vez: si llega otra (aviso push, volver a la app,
  // temporizador) espera la que está en curso en vez de procesar dos veces.
  let syncing = null, again = false;
  function runSync(manual) {
    if (syncing) again = true; // p. ej. llegó un aviso push a mitad: se baja de nuevo al terminar
    else {
      syncing = runSyncNow().finally(() => {
        syncing = null;
        if (again) { again = false; setTimeout(() => runSync(false), 0); }
      });
    }
    return syncing.then((r) => { if (manual) syncToast(r); return r; });
  }
  function syncToast(r) {
    if (r.ok) toast('Sincronizado · ↑' + r.pushed + ' ↓' + r.pulled + (r.rejected ? ' · ' + r.rejected + ' ya en manos de la oficina' : ''), 'ok');
    else if (r.offline) toast('Sin internet: todo queda guardado en el equipo', 'err');
    else toast(r.error || 'No se pudo sincronizar', 'err');
  }
  async function runSyncNow() {
    const scope = syncScope();
    // En la primera descarga de un equipo llega todo el historial: no se avisa pedido por pedido
    const firstSync = !(await Sync.hasCursor(scope));
    // Otra pestaña ya reinició los datos: esta muestra datos viejos
    if ((await DB.getMeta('epoch', '')) !== (S.epoch || '')) { location.reload(); return { ok: false }; }
    const r = await Sync.syncNow(scope);
    // La oficina reinició los datos: este equipo ya borró su copia y bajó todo de nuevo
    if (r.reset) { location.reload(); return r; }
    lastSyncResult = r;
    // También se recarga si el servidor devolvió su versión de algo rechazado:
    // si no, la pantalla seguiría mostrando (y volvería a guardar) la copia vieja.
    if (r.ok && (r.pulled || r.reverted)) {
      const before = new Map(S.orders.map((o) => [o.id, o]));
      await loadAll();
      if (!firstSync) await detectNotifs(before);
      refreshAfterRemote();
    }
    updateSyncPill();
    scheduleSync(isOffice() ? 10000 : 30000);
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
  const NOTIF_TITLE = {
    pedido: '🧾 Nuevo pedido', editado: '✏️ Pedido modificado', duplicado: '⚠️ Cliente duplicado', borrado: '🗑 Pedido eliminado',
    aprobado: '✅ Pedido aprobado', espera: '⏸ Pedido en espera', despachado: '🚚 Pedido despachado', ajustado: '✏️ Pedido ajustado',
  };
  // Mismo tag que usa el servidor en el aviso push: si llegan los dos, se ve uno solo
  const NOTIF_EV = { pedido: 'new', editado: 'mod', borrado: 'del', aprobado: 'apr', espera: 'esp', despachado: 'desp', ajustado: 'aj', duplicado: 'dup' };
  const SENT = ['enviado', 'en_carga', 'en_espera', 'despachado'];
  const isSent = (x) => !!x && !x.deleted && SENT.includes(x.status);
  /**
   * Compara antes/después de un sync y avisa.
   * Oficina: pedido nuevo (aunque otro equipo ya lo haya metido en una hoja),
   * modificado o eliminado por el vendedor, cliente duplicado.
   * Vendedor: su pedido fue aprobado, puesto en espera, despachado, ajustado o eliminado por la oficina.
   */
  async function detectNotifs(before) {
    const office = isOffice();
    const sid = S.session && S.session.sellerId;
    if (!office && (!sid || isSupervisor())) return;
    const out = [];
    const add = (kind, o, msg, warn) => out.push({ icon: NOTIF_TITLE[kind].split(' ')[0], kind, orderId: o.id, msg, warn: !!warn });
    const all = await DB.getAll('orders');
    all.forEach((o) => {
      const p = before.get(o.id);
      if (office) {
        const who = o.sellerName;
        if (isSent(o) && !isSent(p)) add('pedido', o, `Nuevo pedido de ${who}: ${o.clientName}`);
        else if (o.deleted && isSent(p)) add('borrado', o, `${who} eliminó el pedido de ${o.clientName}`);
        else if (!o.deleted && o.sellerEdited && p && p.sellerEdited !== o.sellerEdited) add('editado', o, `${who} modificó el pedido de ${o.clientName}`);
        if (!o.deleted && (o.dupWith || []).length && !(p && (p.dupWith || []).length)) add('duplicado', o, `Cliente duplicado: ${o.clientName} (${who} y ${o.dupWith.map((d) => d.sellerName).join(', ')})`, true);
        return;
      }
      if (o.sellerId !== sid || !p) return;
      if (o.deleted && !p.deleted) add('borrado', o, `La oficina eliminó el pedido de ${o.clientName}`, true);
      else if (o.status === 'despachado' && p.status !== 'despachado') add('despachado', o, `${o.clientName}${o.noteNumber ? ' · Nota ' + Loads.noteCode(o.noteNumber) : ''}`);
      else if (o.status === 'en_espera' && p.status !== 'en_espera') add('espera', o, `${o.clientName}: la oficina lo dejó para otra carga`, true);
      else if (o.locked === true && p.locked !== true) add('aprobado', o, `${o.clientName} · ${o.loadStatusName || 'Aprobado para carga'}`);
      else if (o.officeEdited && o.officeEdited !== p.officeEdited) add('ajustado', o, `La oficina ajustó las cantidades de ${o.clientName}`, true);
    });
    if (!out.length) return;
    const at = new Date().toISOString();
    S.notifs = out.map((n) => ({ ...n, at, read: false })).concat(S.notifs || []).slice(0, 80);
    await DB.setMeta('notifs', S.notifs);
    beep();
    // Una notificación del sistema POR CADA aviso, con el mismo tag que el push del
    // servidor (si llegan los dos, el teléfono muestra uno solo).
    if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
      const viaPush = await pushActive();
      out.filter((n) => !viaPush || n.kind === 'duplicado').forEach((n) => {
        try { new Notification(NOTIF_TITLE[n.kind], { body: n.msg, icon: './icons/icon-192.png', tag: `o-${n.orderId}-${NOTIF_EV[n.kind]}` }); } catch (e) { /* noop */ }
      });
    }
    if (!document.hidden) toast(out.length === 1 ? `${NOTIF_TITLE[out[0].kind]}: ${out[0].msg}` : `🔔 ${out.length} avisos nuevos`, 'ok');
    updateBell();
  }
  /** Lista de avisos (oficina y vendedor) con el botón para activar los avisos push. */
  function notifSheet() {
    const list = S.notifs || [];
    const pushOk = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    const sh = openSheet(`<div class="row"><h2 class="grow">🔔 Notificaciones</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${pushOk ? '<div id="nState" class="muted" style="margin:4px 0 10px">Revisando avisos…</div>'
        : '<p class="muted">Este navegador no permite avisos con la app cerrada. En iPhone: instálala con «Agregar a pantalla de inicio».</p>'}
      ${list.length ? `<div class="notif-list">${list.map((n) => `<div class="notif ${n.read ? '' : 'unread'} ${n.warn ? 'warn' : ''}"><span>${n.icon}</span><div class="grow">${esc(n.msg)}<small>${esc(new Date(n.at).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }))}</small></div></div>`).join('')}</div>
        <div class="actions"><button class="btn" id="nClear">Borrar todo</button></div>`
        : `<p class="muted">Sin notificaciones. ${isOffice() ? 'Aquí verás pedidos nuevos, modificados o eliminados por los vendedores y clientes duplicados.' : 'Aquí verás cuando tus pedidos sean aprobados, puestos en espera, ajustados o despachados.'}</p>`}`);
    beep(); // habilita el audio del navegador tras un clic
    S.notifs = list.map((n) => ({ ...n, read: true })); DB.setMeta('notifs', S.notifs); updateBell();
    // Estado real: con permiso Y suscripción en este equipo (no basta el permiso)
    const st = $('#nState', sh.el);
    if (st) pushActive().then((on) => {
      st.innerHTML = on ? '✅ Avisos activados en este equipo: llegan aunque la app esté cerrada.'
        : '<button class="btn btn-primary btn-block" id="nPerm">🔔 Activar avisos en este equipo (llegan aunque la app esté cerrada)</button>';
      const np = $('#nPerm', sh.el);
      if (np) np.onclick = async () => {
        np.disabled = true; np.textContent = 'Activando…';
        const r = await enablePush(true);
        pushKey = r.ok ? pushKey : '';
        toast(r.ok ? '✅ Avisos activados' : (r.error || 'No se pudieron activar los avisos'), r.ok ? 'ok' : 'err');
        sh.close();
      };
    });
    const nc = $('#nClear', sh.el); if (nc) nc.onclick = () => { S.notifs = []; DB.setMeta('notifs', []); sh.close(); updateBell(); };
  }

  /* ----------------- Avisos push (con la app cerrada) ----------------- */
  let pushKey = '';
  function refreshPush() {
    const k = (pushRole() || '') + '|' + ((S.session && S.session.sellerId) || '');
    if (!pushRole() || k === pushKey || !('Notification' in window) || Notification.permission !== 'granted') return;
    pushKey = k;
    enablePush(false).then((r) => { if (!r.ok) pushKey = ''; });
  }
  const pushRole = () => (isOffice() ? 'office' : (S.session && S.session.sellerId && !isSupervisor() ? 'seller' : null));
  function b64ToBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(raw, (c) => c.charCodeAt(0));
  }
  /**
   * Suscribe este equipo (según el rol en pantalla) a los avisos push y lo
   * registra en el servidor. ask=true pide permiso; sin ask solo renueva si ya
   * estaba permitido (se llama en cada arranque y al cambiar de vendedor).
   */
  const pushRegKey = () => (pushRole() || '') + '|' + ((S.session && S.session.sellerId) || '');
  function pushRegs() { try { return JSON.parse(localStorage.getItem('pvPushRegs') || '{}'); } catch (e) { return {}; } }
  /** Avisos push activos para el rol que se usa AHORA en este equipo (no basta con tener suscripción). */
  async function pushActive() {
    try {
      if (!pushRole() || Notification.permission !== 'granted') return false;
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(() => r(null), 3000))]);
      const sub = reg && await reg.pushManager.getSubscription();
      return !!sub && pushRegs()[pushRegKey()] === sub.endpoint;
    } catch (e) { return false; }
  }
  // Nunca deja la pantalla esperando: si el servicio de avisos no responde, se informa
  const withTimeout = (pr, ms) => Promise.race([pr, new Promise((r) => setTimeout(() => r({ ok: false, error: 'El servicio de avisos no respondió. Intenta de nuevo con buena señal.' }), ms))]);
  function enablePush(ask) { return withTimeout(enablePushNow(ask), 20000); }
  async function enablePushNow(ask) {
    try {
      const role = pushRole();
      if (!role) return { ok: false, error: 'Entra como oficina o como vendedor' };
      if (!('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window)) return { ok: false, error: 'Este navegador no permite avisos push' };
      if (Notification.permission !== 'granted') {
        if (!ask) return { ok: false };
        if (await Notification.requestPermission() !== 'granted') return { ok: false, error: 'Permiso de notificaciones denegado en el navegador' };
      }
      if (!navigator.onLine) return { ok: false, error: 'Sin internet' };
      const reg = await navigator.serviceWorker.ready;
      const k = await Sync.pushCall({ action: 'key' });
      if (!k.ok) return k;
      const key = b64ToBytes(k.data.publicKey);
      let sub = await reg.pushManager.getSubscription();
      // Suscripción firmada con otra clave del servidor (p. ej. base restaurada): se renueva
      const same = (a, b) => a && a.byteLength === b.length && new Uint8Array(a).every((x, i) => x === b[i]);
      if (sub && !same(sub.options && sub.options.applicationServerKey, key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      const r = await Sync.pushCall({ action: 'subscribe', role, sellerId: role === 'seller' ? S.session.sellerId : null, subscription: sub.toJSON() }, role === 'office');
      if (r.ok) { try { localStorage.setItem('pvPushRegs', JSON.stringify({ ...pushRegs(), [pushRegKey()]: sub.endpoint })); } catch (e) { /* sin storage */ } }
      return r;
    } catch (e) { return { ok: false, error: 'No se pudieron activar los avisos: ' + (e.message || e) }; }
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
    if (h === '#/ruta/pedidos' && S.session && sellerById(S.session.sellerId)) return renderSellerOrders();
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
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><button class="icon-btn ghost" id="menuBtn" aria-label="Menú">☰</button>`)}
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
    $('#bell').onclick = notifSheet;
    updateBell();

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
      // Lo que pide ahora el vendedor (su propio cambio no es un ajuste de oficina)
      if (o.sentLines) { o.sentLines = { ...o.sentLines }; if (o.lines[pid]) o.sentLines[pid] = { ...o.lines[pid] }; else delete o.sentLines[pid]; }
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
      // Copia de lo que pidió el vendedor: luego ve qué ajustó la oficina
      o.sentLines = JSON.parse(JSON.stringify(o.lines));
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

  /* ====================== Mis pedidos (seguimiento) ====================== */
  // El vendedor sigue TODOS sus pedidos (no solo los de hoy): enviados, aprobados,
  // en espera y despachados, con lo que ajustó la oficina, y las hojas de carga
  // donde están sus clientes. Es su agenda de ventas (base de su comisión).
  const MY_GROUPS = [['todos', 'Todos'], ['enviados', '📤 Enviados'], ['aprobados', '✅ Aprobados'], ['espera', '⏸ En espera'], ['despachados', '🚚 Despachados'], ['abiertos', '✏️ Sin enviar']];
  const MY_RANGES = [['hoy', 'Hoy'], ['7', '7 días'], ['15', '15 días'], ['mes', 'Este mes'], ['todo', 'Todo']];
  const groupOf = (o) => (o.status === 'abierto' ? 'abiertos' : o.status === 'despachado' ? 'despachados'
    : o.status === 'en_espera' ? 'espera' : o.locked ? 'aprobados' : 'enviados');
  const GROUP_TEXT = { abiertos: 'Sin enviar', enviados: 'Enviado · esperando aprobación', aprobados: 'Aprobado para carga', espera: 'En espera', despachados: 'Despachado' };
  function dayMinus(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function inRange(day, r) {
    day = String(day || '').slice(0, 10);
    if (r === 'todo') return true;
    if (r === 'hoy') return day === today();
    if (r === 'mes') return day.slice(0, 7) === today().slice(0, 7);
    return day >= dayMinus(+r - 1);
  }
  const loadOf = (o) => (o.loadId ? S.loads.find((l) => l.id === o.loadId) : null);
  const qty = (l) => (l ? [l.cajas ? l.cajas + ' cj' : '', l.unidades ? l.unidades + ' un' : ''].filter(Boolean).join(' + ') || '—' : '—');

  function renderSellerOrders() {
    const seller = sellerById(S.session.sellerId), sid = seller.id;
    const f = S.ui.myo || (S.ui.myo = { tab: 'pedidos', g: 'todos', r: '15' });
    const mine = S.orders.filter((o) => o.sellerId === sid && inRange(o.routeDate, f.r));
    const list = mine.filter((o) => f.g === 'todos' || groupOf(o) === f.g)
      .sort((a, b) => String(b.routeDate).localeCompare(String(a.routeDate)) || String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt)));
    const sent = mine.filter((o) => o.status !== 'abierto'), desp = mine.filter((o) => o.status === 'despachado');
    const sum = (arr) => arr.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0);
    const count = (g) => mine.filter((o) => g === 'todos' || groupOf(o) === g).length;
    const loads = S.loads.filter((l) => Loads.sellerIdsOf(l).includes(sid) || S.orders.some((o) => o.sellerId === sid && o.loadId === l.id))
      .filter((l) => inRange(l.date || l.closedAt || l.createdAt, f.r))
      .sort((a, b) => String(b.date || b.closedAt || b.createdAt).localeCompare(String(a.date || a.closedAt || a.createdAt)));
    const chip = (key, cur, label, data) => `<button class="chip ${key === cur ? 'active' : ''}" ${data}="${key}">${label}</button>`;
    const orderRow = (o) => {
      const t = Matrix.orderTotals(o), l = loadOf(o), g = groupOf(o);
      return `<tr data-myo="${esc(o.id)}" style="cursor:pointer">
        <td><b>${esc(o.clientName)}</b><div class="muted" style="font-size:12px">${esc(fmtDate(o.routeDate))}${l ? ' · ' + esc(Loads.labelOf(l)) + (l.number ? ' · ' + esc(Loads.loadCode(l)) : '') : ''}${o.noteNumber ? ' · ' + esc(Loads.noteCode(o.noteNumber)) : ''}</div>
          <span class="status ${g === 'aprobados' ? 'en_carga' : o.status}">${esc(GROUP_TEXT[g])}</span>${o.officeEdited ? ' <span class="status en_espera">ajustado por oficina</span>' : ''}</td>
        <td class="n" data-l="Monto">${usd(t.monto)}</td></tr>`;
    };
    app.innerHTML = `
      ${brandHeader(seller.name, 'Mis pedidos · seguimiento',
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="chips" id="myRange">${MY_RANGES.map(([k, l]) => chip(k, f.r, l, 'data-r')).join('')}</div>
        <div class="kpi-row" style="margin-top:10px">
          <div class="kpi"><small>Pedidos enviados</small><b>${sent.length}</b></div>
          <div class="kpi"><small>Monto enviado</small><b>${usd(sum(sent))}</b></div>
          <div class="kpi"><small>Monto despachado</small><b>${usd(sum(desp))}</b></div>
        </div>
        <p class="muted" style="margin-top:-4px">Lo <b>despachado</b> es lo que realmente salió al cliente (base de tu comisión).</p>
        <div class="chips" id="myTab">${chip('pedidos', f.tab, '🧾 Mis pedidos', 'data-t')}${chip('hojas', f.tab, '🚚 Hojas de carga', 'data-t')}</div>
        ${f.tab === 'pedidos' ? `
          <div class="chips" id="myGroup">${MY_GROUPS.map(([k, l]) => chip(k, f.g, `${l} <span class="badge">${count(k)}</span>`, 'data-g')).join('')}</div>
          ${list.length ? `<div class="card" style="overflow:auto"><table class="inv"><tbody>${list.map(orderRow).join('')}</tbody></table></div>`
            : '<div class="empty card"><strong>Sin pedidos</strong>en ese período con ese estado.</div>'}`
        : (loads.length ? loads.map((l) => {
            const os = S.orders.filter((o) => o.sellerId === sid && o.loadId === l.id);
            const st = Loads.statusOf(l, S.config);
            return `<div class="card card-pad" style="margin-bottom:10px">
              <div class="row"><h3 class="grow" style="margin:0">${esc(Loads.labelOf(l))} ${l.number ? '<span class="mono muted">' + esc(Loads.loadCode(l)) + '</span>' : ''}</h3>
                <span class="status ${st.locked ? 'en_carga' : 'enviado'}">${st.locked ? '🔒 ' : ''}${esc(st.name)}</span></div>
              <div class="muted" style="margin:4px 0 8px">📅 ${esc(fmtDate(l.date || String(l.closedAt || l.createdAt).slice(0, 10)))} · Ruta ${esc(l.route || '—')} · Despachador: <b>${esc(l.dispatcherName || 'sin asignar')}</b>${l.firstNote ? ' · Notas ' + esc(Loads.noteCode(l.firstNote)) + ' a ' + esc(Loads.noteCode(l.lastNote)) : ''}</div>
              ${os.length ? `<table class="inv"><tbody>${os.map(orderRow).join('')}</tbody></table>
                <div class="row" style="justify-content:flex-end;margin-top:6px"><b>Tus clientes en esta hoja: ${os.length} · ${usd(sum(os))}</b></div>`
                : '<p class="muted">Tus pedidos ya no están en esta hoja (se movieron o quedaron en espera).</p>'}
            </div>`;
          }).join('') : '<div class="empty card"><strong>Sin hojas de carga</strong>en ese período.</div>')}
      </div>
      ${creditFooter()}`;
    $('#syncPill').onclick = () => runSync(true);
    $('#bell').onclick = notifSheet;
    updateSyncPill(); updateBell();
    $('#myRange').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { f.r = b.dataset.r; renderSellerOrders(); } };
    $('#myTab').onclick = (e) => { const b = e.target.closest('[data-t]'); if (b) { f.tab = b.dataset.t; renderSellerOrders(); } };
    const mg = $('#myGroup'); if (mg) mg.onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { f.g = b.dataset.g; renderSellerOrders(); } };
    app.querySelectorAll('[data-myo]').forEach((tr) => { tr.onclick = () => myOrderSheet(orderById(tr.dataset.myo)); });
  }

  /** Detalle de un pedido para el vendedor: lo que pidió contra lo que queda/salió, hoja, despachador y nota. */
  function myOrderSheet(o) {
    if (!o) return;
    const l = loadOf(o), g = groupOf(o), t = Matrix.orderTotals(o);
    const sentL = o.sentLines || null;
    const ids = [...new Set(Object.keys(sentL || {}).concat(Object.keys(o.lines || {})))];
    const rows = ids.map((pid) => {
      const fin = (o.lines || {})[pid], was = sentL ? sentL[pid] : null, ref = fin || was;
      const changed = sentL && qty(was) !== qty(fin);
      return `<tr${changed ? ' class="short"' : ''}><td><b>${esc(ref.name)} ${esc(ref.presentation || '')}</b><div class="muted mono" style="font-size:12px">${esc(ref.code || '')}</div></td>
        ${sentL ? `<td class="num">${esc(qty(was))}</td>` : ''}<td class="num">${esc(qty(fin))}${changed ? ' ✏️' : ''}</td></tr>`;
    }).join('');
    const info = [
      ['Fecha del pedido', fmtDate(o.routeDate)],
      ['Enviado', o.sentAt ? new Date(o.sentAt).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }) : '—'],
      ['Estado', GROUP_TEXT[g]],
      ['Hoja de carga', l ? Loads.labelOf(l) + (l.number ? ' · ' + Loads.loadCode(l) : '') : '—'],
      ['Estado de la hoja', l ? Loads.statusOf(l, S.config).name : '—'],
      ['Despachador', (l && l.dispatcherName) || '—'],
      ['Fecha de carga', l && (l.date || l.closedAt) ? fmtDate(l.date || String(l.closedAt).slice(0, 10)) : '—'],
      ['Nota de entrega', o.noteNumber ? Loads.noteCode(o.noteNumber) : '—'],
    ];
    openSheet(`
      <div class="row"><h2 class="grow">${esc(o.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="grid2" style="margin:8px 0 12px">${info.map(([k, v]) => `<div><small class="muted">${esc(k)}</small><div><b>${esc(v)}</b></div></div>`).join('')}</div>
      ${o.officeEdited ? `<div class="hint warn">✏️ La oficina ajustó este pedido${sentL ? ': las filas marcadas cambiaron respecto a lo que enviaste.' : '.'}</div>` : ''}
      <table class="lines"><thead><tr><th style="text-align:left">Producto</th>${sentL ? '<th class="num">Pediste</th>' : ''}<th class="num">${g === 'despachados' ? 'Despachado' : 'Queda'}</th></tr></thead>
        <tbody>${rows || '<tr><td class="muted">Sin productos</td></tr>'}</tbody></table>
      <div class="row" style="justify-content:space-between;margin-top:10px;font-size:18px"><b>Total · ${t.cajas} cj + ${t.unidades} un</b><b>${usd(t.monto)}</b></div>
      ${o.notes ? `<p class="muted">📝 ${esc(o.notes)}</p>` : ''}`, { cls: 'sheet-order' });
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
        <a class="btn btn-accent" href="#/ruta/pedidos" data-close>📋 Mis pedidos y cargas</a>
        <button class="btn btn-primary" id="mSync">⟳ Sincronizar ahora</button>
        <button class="btn" id="mExport">⇪ Enviar pedidos de hoy por archivo (WhatsApp)</button>
        <button class="btn" id="mImport">⇩ Cargar catálogo desde archivo</button>
      </div>
      <details style="margin-top:16px" ${S.settings.syncKey ? '' : 'open'}><summary class="section-title" style="cursor:pointer">🔑 Conexión (clave de sincronización)</summary>
        ${S.settings.syncKey ? '' : '<div class="hint warn" style="margin-top:8px">Falta la clave de sincronización: sin ella no bajan los clientes ni el catálogo.</div>'}
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
    window.addEventListener('hashchange', () => { render(); refreshPush(); });
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
      // Llegó un aviso push con la app abierta: sincroniza ya, sin esperar el turno
      navigator.serviceWorker.addEventListener('message', (e) => { if (e.data && e.data.type === 'push') runSync(false); });
      navigator.serviceWorker.register('./sw.js').then((reg) => {
        document.addEventListener('visibilitychange', () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch((e) => console.warn('SW no registrado', e));
    }
    render();
    refreshPush();
    logEvent('apertura', isOffice() ? 'Abrió la oficina' : isSupervisor() ? 'Entró como supervisor' : 'Abrió la app');
    scheduleSync(1200);
  }
  // Arranque: lo invoca index.html después de cargar office.js

  window.PV = {
    S, $, $$, esc, nf2, nf0, usd, bs, int, dec, norm, slug, today, fmtDate, fmtStock, hasStock, productSort, productLabel, rubroIcon,
    toast, openSheet, copyText, saveFile, pickFile, brandHeader, creditFooter,
    loadAll, saveDocs, saveOrder, saveSettings, setSession, runSync, updateSyncPill, render, refreshAfterRemote, updateBell, beep, logEvent, isSupervisor,
    notifSheet, refreshPush,
    productById, sellerById, orderById, clientById, rubros, orderLinesHTML,
    boot,
  };
})();
