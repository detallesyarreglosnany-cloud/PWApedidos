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
  // Foto del producto: la de este equipo si aún la tiene adentro (recién tomada o
  // versión anterior), o la del servidor por su huella (se guarda en caché y
  // funciona sin señal). Un cambio de precio ya no vuelve a bajar las fotos.
  const imgSrc = (p) => (!p ? '' : p.image ? p.image : p.imageV ? '/api/pedidos/img?id=' + encodeURIComponent(p.id) + '&v=' + encodeURIComponent(p.imageV) : '');
  const hasPhoto = (p) => !!(p && (p.image || p.imageV));
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
    return saveBlob(filename, new Blob([text], { type: mime || 'text/plain;charset=utf-8' }));
  }
  /** Archivo binario (por ejemplo un .xlsx): en el teléfono abre «Compartir», en la PC lo descarga. */
  async function saveBinary(filename, u8, mime) {
    return saveBlob(filename, new Blob([u8], { type: mime || 'application/octet-stream' }));
  }
  async function saveBlob(filename, blob) {
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
    S.wipeNotice = await DB.getMeta('wipeNotice', null);
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
  async function setSession(sess) {
    S.session = sess; await DB.setMeta('session', sess);
    // El último vendedor también queda en una cookie: sobrevive si el navegador borra los datos
    if (sess && sess.sellerId) DB.setCookie('pv_seller', sess.sellerId);
  }

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
      // Aviso pendiente: el navegador borró los datos de este equipo (queda en el Historial)
      if (S.wipeNotice) {
        const w = S.wipeNotice; S.wipeNotice = null;
        await DB.remove('meta', 'wipeNotice');
        const wt = DB.now(), wd = new Date(Date.parse(wt));
        await DB.put('events', {
          id: DB.uid('ev'), at: wt, day: wd.getFullYear() + '-' + String(wd.getMonth() + 1).padStart(2, '0') + '-' + String(wd.getDate()).padStart(2, '0'),
          type: 'datos_borrados', text: 'El navegador borró los datos guardados de este equipo (detectado ' + new Date(w.at).toLocaleString('es-VE') + '). Se recuperaron del servidor.',
          sellerId: sid, sellerName: office ? 'Oficina' : (seller ? seller.name : sid), deviceId: await Sync.deviceId(), prevDeviceId: w.prev || '', updatedAt: wt, dirty: true,
        });
      }
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
  // Cada cuánto se revisa el servidor. Con la app en segundo plano casi no se
  // consulta: al volver a la pantalla, al recuperar señal o al llegar un aviso
  // push se sincroniza en el acto (así se ahorra tráfico de servidor y base de datos).
  // Modo ahorro: si nadie toca la pantalla (10 min en el teléfono, 15 en la
  // oficina) se consulta cada 5 / 2 min, y tras 1 hora cada 15 / 5 min. Lo que
  // se escribe en el equipo se sube igual a los segundos (notifyChange), un aviso
  // push sincroniza en el acto, y al primer toque vuelve a la velocidad normal.
  let lastInput = Date.now();
  const idleFor = () => Date.now() - lastInput;
  const isIdle = () => idleFor() > (isOffice() ? 15 : 10) * 60000;
  const syncEvery = () => {
    const off = isOffice();
    if (idleFor() > 3600000) return off ? 300000 : 900000;
    if (document.hidden || isIdle()) return off ? 120000 : 300000;
    return off ? 20000 : 45000;
  };
  function onUserInput() {
    const wasIdle = isIdle();
    lastInput = Date.now();
    if (wasIdle) { updateSyncPill(); runSync(false); }
  }
  ['pointerdown', 'keydown', 'touchstart', 'wheel'].forEach((ev) => window.addEventListener(ev, onUserInput, { passive: true, capture: true }));

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
    // Marca de equipo ya conectado (cookie): permite detectar si el navegador borra los datos
    if (r.ok && !DB.getCookie('pv_dev')) DB.setCookie('pv_dev', await Sync.deviceId());
    // También se recarga si el servidor devolvió su versión de algo rechazado:
    // si no, la pantalla seguiría mostrando (y volvería a guardar) la copia vieja.
    if (r.ok && (r.pulled || r.reverted)) {
      const before = new Map(S.orders.map((o) => [o.id, o])), beforeCli = new Set(S.clients.map((c) => c.id));
      await loadAll();
      if (!firstSync) await detectNotifs(before, beforeCli);
      refreshAfterRemote();
    }
    updateSyncPill();
    scheduleSync(syncEvery());
    if (r.ok) warmImages();
    return r;
  }
  // Precarga en segundo plano las fotos que este equipo aún no tiene (una vez por
  // versión): así el catálogo se ve completo en la ruta, sin señal.
  let warming = false;
  async function warmImages() {
    if (warming || !navigator.onLine || !('caches' in window) || !navigator.serviceWorker || !navigator.serviceWorker.controller) return;
    warming = true;
    try {
      const c = await caches.open('fotos-productos');
      const todo = [];
      for (const p of S.products) { if (p.active === false || !p.imageV || p.image) continue; const u = new URL(imgSrc(p), location.href).href; if (!(await c.match(u))) todo.push(u); }
      for (const u of todo.slice(0, 60)) { if (!navigator.onLine) break; try { await fetch(u, { credentials: 'same-origin' }); } catch (e) { break; } }
    } catch (e) { /* sin caché: se ven al abrir el catálogo */ } finally { warming = false; }
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
    el.innerHTML = '<span class="dot"></span>' + label + (online && !serverDown && isIdle() ? ' · ahorro' : '') +
      (pending ? ' · ' + pending : '');
    el.title = lastSyncResult && lastSyncResult.error ? lastSyncResult.error : isIdle() ? 'Modo ahorro: sin uso hace un rato, se consulta el servidor con menos frecuencia. Toca para sincronizar.' : 'Tocar para sincronizar';
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
    pedido: '🧾 Nuevo pedido', editado: '✏️ Pedido modificado', duplicado: '⚠️ Cliente duplicado', borrado: '🗑 Pedido eliminado', mensaje: '💬 Mensaje de la oficina',
    aprobado: '✅ Pedido aprobado', espera: '⏸ Pedido en espera', despachado: '🚚 Pedido despachado', ajustado: '✏️ Pedido ajustado',
    liquidado: '✓ Pedido liquidado', oficina: '🏢 Pedido cargado por la oficina', cliente: '🕓 Cliente por verificar',
  };
  // Mismo tag que usa el servidor en el aviso push: si llegan los dos, se ve uno solo
  const NOTIF_EV = { mensaje: 'msg', pedido: 'new', editado: 'mod', borrado: 'del', aprobado: 'apr', espera: 'esp', despachado: 'desp', ajustado: 'aj', duplicado: 'dup', liquidado: 'liq', oficina: 'ofi', cliente: 'cli' };
  const SENT = ['enviado', 'en_carga', 'en_espera', 'despachado'];
  const isSent = (x) => !!x && !x.deleted && SENT.includes(x.status);
  /**
   * Compara antes/después de un sync y avisa.
   * Oficina: pedido nuevo (aunque otro equipo ya lo haya metido en una hoja),
   * modificado o eliminado por el vendedor, cliente duplicado.
   * Vendedor: su pedido fue aprobado, puesto en espera, despachado, ajustado o eliminado por la oficina.
   */
  async function detectNotifs(before, beforeCli) {
    const office = isOffice();
    const sid = S.session && S.session.sellerId;
    if (!office && (!sid || isSupervisor())) return;
    const out = [];
    const add = (kind, o, msg, warn) => out.push({ icon: NOTIF_TITLE[kind].split(' ')[0], kind, orderId: o.id, msg, warn: !!warn });
    if (office) {
      // Cliente nuevo registrado por un vendedor: la oficina lo verifica
      const prevCli = beforeCli || new Set(S.clients.map((c) => c.id));
      (await DB.getAll('clients')).forEach((c) => {
        if (!c.deleted && !prevCli.has(c.id) && c.verified === false && c.source === 'campo') out.push({ icon: '🕓', kind: 'cliente', orderId: c.id, msg: `${c.name} · registrado por ${c.createdByName || 'un vendedor'}: revisa sus datos y verifícalo`, warn: true });
      });
    }
    const all = await DB.getAll('orders');
    all.forEach((o) => {
      const p = before.get(o.id);
      if (office) {
        const who = o.sellerName;
        if (isSent(o) && !isSent(p)) add('pedido', o, o.createdBy === 'oficina' ? `Oficina cargó un pedido para ${who}: ${o.clientName}` : `Nuevo pedido de ${who}: ${o.clientName}`);
        else if (o.deleted && isSent(p)) add('borrado', o, `${o.deletedBy === 'oficina' ? 'La oficina' : who} eliminó el pedido de ${o.clientName}`);
        else if (!o.deleted && o.sellerEdited && p && p.sellerEdited !== o.sellerEdited) add('editado', o, `${who} modificó el pedido de ${o.clientName}`);
        if (!o.deleted && (o.dupWith || []).length && !(p && (p.dupWith || []).length)) add('duplicado', o, `Cliente duplicado: ${o.clientName} (${who} y ${o.dupWith.map((d) => d.sellerName).join(', ')})`, true);
        return;
      }
      // Pedido que la oficina cargó a su nombre (solo los de hoy en adelante: un equipo nuevo no se llena de avisos)
      if (o.sellerId === sid && !p && o.createdBy === 'oficina' && isSent(o) && String(o.routeDate) >= today()) { add('oficina', o, `${o.clientName} · ${usd(Matrix.orderTotals(o).monto)}`); return; }
      if (o.sellerId !== sid || !p) return;
      // Posible pedido duplicado (mismo cliente o nombre parecido en 4 días, de él o de otro vendedor)
      const realD = (x) => (x.dupWith || []).filter((d) => !d.extra);
      const newD = realD(o).filter((d) => !realD(p).some((q) => q.id === d.id));
      if (!o.deleted && newD.length) add('duplicado', o, `${o.clientName}: ${newD.map((d) => `${d.kind === 'similar' ? 'nombre parecido «' + d.clientName + '» ' : ''}${d.sellerName === o.sellerName ? 'tienes otro pedido' : 'pedido de ' + d.sellerName} del ${fmtDate(d.routeDate)}`).join('; ')} — verifica que no sea el mismo`, true);
      const om = o.officeMsgs || [], pm = p.officeMsgs || [];
      if (om.length > pm.length) add('mensaje', o, `${o.clientName}: ${om[om.length - 1].text}`, true);
      if (o.delivery && o.delivery.at && !(p.delivery && p.delivery.at)) {
        const d = o.delivery, res = d.result || 'entregada';
        const txt = res === 'anulada' ? `${o.clientName}: se anuló la nota${d.voidedNote ? ' ' + d.voidedNote : ''}`
          : res === 'pendiente' ? `${o.clientName}: no se entregó, queda para otra carga`
          : res === 'parcial' ? `${o.clientName}: devolución parcial · entregado ${usd(d.monto)}${d.newValery ? ' · nota nueva ' + d.newValery : ''}`
          : `${o.clientName}: liquidado ${usd(d.monto)}`;
        add('liquidado', o, txt, res !== 'entregada');
        out[out.length - 1].icon = res === 'anulada' ? '✕' : res === 'pendiente' ? '⏳' : res === 'parcial' ? '↩' : '✓';
      }
      if (o.deleted && !p.deleted) add('borrado', o, `La oficina eliminó el pedido de ${o.clientName}`, true);
      else if (o.status === 'despachado' && p.status !== 'despachado') add('despachado', o, `${o.clientName}${o.valeryNote ? ' · Nota ' + o.valeryNote : ''}`);
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
  /** Aviso propio de la app (no viene de un pedido): queda en la campana de este equipo. */
  function localNotif(n) {
    S.notifs = [{ icon: n.icon || '🔔', kind: n.kind || 'aviso', orderId: '', msg: n.msg, warn: !!n.warn, at: new Date().toISOString(), read: false }].concat(S.notifs || []).slice(0, 80);
    DB.setMeta('notifs', S.notifs); updateBell();
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
        : `<p class="muted">Sin notificaciones. ${isOffice() ? 'Aquí verás pedidos nuevos, modificados o eliminados por los vendedores y clientes duplicados.' : 'Aquí verás cuando tus pedidos sean aprobados, puestos en espera, ajustados, despachados o liquidados (con sus devoluciones).'}</p>`}`);
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
    if (h === '#/ruta/clientes' && S.session && sellerById(S.session.sellerId)) return renderMyClients();
    if (h === '#/ruta' && S.session && sellerById(S.session.sellerId)) return renderSeller();
    return renderLogin();
  }

  /** Créditos del proyecto (editable en Ajustes → Mi perfil) y enlace «Acerca de» (todos los roles). */
  function creditFooter() {
    const t = (S.config && S.config.footer) || '';
    return `<footer class="credit">${t ? `<span>${esc(t)}</span>` : ''}<button type="button" class="about-link" data-about>Acerca de</button></footer>`;
  }

  /* ======================= Mensajes oficina → vendedor ======================= */
  /** Nota del vendedor + mensajes de la oficina de un pedido, en orden. */
  function msgThreadHTML(o) {
    const fmt = (iso) => new Date(iso).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' });
    const items = (o.notes ? [`<div class="msg msg-seller"><small>📝 Nota de ${esc(o.sellerName || 'vendedor')}</small>${esc(o.notes)}</div>`] : [])
      .concat((o.officeMsgs || []).map((m) => `<div class="msg msg-office"><small>💬 ${esc(m.by || 'Oficina')} · ${esc(fmt(m.at))}</small>${esc(m.text)}</div>`));
    return items.length ? `<div class="msg-list">${items.join('')}</div>` : '<p class="muted" style="margin:0 0 8px">Sin mensajes en este pedido.</p>';
  }

  /* ============================== Acerca de ============================== */
  const APP_VERSION = '2026.10';
  function aboutSheet() {
    const co = (S.config && S.config.company && S.config.company.name) || 'Distribuidora de Suministros Puerto Venado';
    openSheet(`
      <div class="row"><h2 class="grow">Acerca de</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="about">
        <img class="about-mark" src="./icons/icon-192.png" alt="" width="64" height="64">
        <h3>Puerto Venado · Pedidos</h3>
        <p class="about-ver">Versión ${APP_VERSION}</p>
        <p>Aplicación de toma de pedidos, hojas de carga y despacho de ${esc(co)}.</p>
        <p><b>Desarrollado por Daniela Silva.</b></p>
        <p class="about-legal">© 2026 Daniela Silva. Todos los derechos reservados.</p>
        <p class="about-legal">Este software y su código, diseño, marcas y documentación están protegidos por las leyes de derecho de autor y propiedad intelectual. Se otorga a ${esc(co)} una licencia de uso exclusiva e intransferible. Queda prohibida su reproducción, distribución, modificación, ingeniería inversa o uso no autorizado, total o parcial, sin el consentimiento previo y por escrito de su autora.</p>
        <p class="about-legal">La información registrada en la aplicación (clientes, productos, pedidos y operaciones) es propiedad de ${esc(co)} y se trata de forma confidencial. Uso exclusivo de personal autorizado: la actividad queda registrada.</p>
      </div>
      <div class="actions"><button class="btn btn-primary" data-close>Cerrar</button></div>`);
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-about]')) aboutSheet(); });

  function brandHeader(title, sub, right) {
    return `<header class="topbar">
      <img class="brand-mark" src="./icons/mark-white.png" alt="Puerto Venado" width="40" height="40">
      <div class="grow"><h1>${esc(title)}<small>${esc(sub)}</small></h1></div><button class="bell" type="button" data-search aria-label="Buscar cliente, nota o fecha" title="Buscar cliente, nota Valery o fecha">🔍</button>${right}</header>`;
  }

  /* =============================== Login =============================== */
  function renderLogin() {
    const active = S.sellers.filter((s) => s.active).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const cookieSeller = DB.getCookie('pv_seller');
    const last = (S.session && S.session.sellerId) || (sellerById(cookieSeller) ? cookieSeller : null);
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
  // Pantalla de pedidos: solo lo que espera aprobación; lo aprobado en adelante
  // se sigue en "Mis pedidos" y el cliente queda libre para un pedido nuevo
  const pendingOrdersToday = () => myOrdersToday().filter(editable);
  function activeOrder() {
    const o = S.session.activeOrderId && orderById(S.session.activeOrderId);
    return o && o.routeDate === today() && editable(o) ? o : null;
  }
  function myClients() {
    const sid = S.session.sellerId;
    return S.clients.filter((c) => c.sellerId === sid && c.active !== false)
      .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  // Candado: elegir de la lista dispara "change" y "submit" a la vez; sin esto
  // se creaban dos pedidos (y dos clientes nuevos) para el mismo cliente.
  let opening = Promise.resolve();
  function openClient(name, opts) {
    opening = opening.then(() => openClientNow(name, opts)).catch((e) => toast(e.message || 'Error', 'err'));
    return opening;
  }
  // Pedidos recientes (últimos 4 días) del mismo cliente: por id de cartera, por
  // nombre o por nombre equivalente («Bodega Sofía» = «VARIEDADES SOFIA»).
  function recentOrdersOf(client, name) {
    const sid = S.session.sellerId, from = dayMinus(Dedup.WINDOW_DAYS), fk = Dedup.key(client ? client.name : name), key = norm(client ? client.name : name);
    return S.orders.filter((o) => o.sellerId === sid && Dedup.live(o) && String(o.routeDate) >= from && Matrix.orderTotals(o).items &&
      ((client && o.clientId === client.id) || o.clientKey === key || Dedup.key(o.clientName || o.clientKey) === fk))
      .sort((a, b) => String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt)));
  }
  const hhmm = (iso) => (iso ? new Date(iso).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }) : '');
  /** El nombre escrito no está tal cual en la cartera: ¿es uno de estos? (evita clientes repetidos). */
  function pickClientSheet(name, like) {
    const busy = (c) => recentOrdersOf(c, c.name).length;
    const sh = openSheet(`
      <div class="row"><h2 class="grow">¿Quién es «${esc(name)}»?</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${like.length ? `<p>Se parece a ${like.length === 1 ? 'este cliente' : 'estos clientes'} de tu cartera. <b>Elige el correcto</b> para no repetir el cliente ni el pedido:</p>
        <div class="pick-list">${like.map((c) => `<button type="button" class="sug-item" data-pick="${esc(c.id)}"><b>${esc(c.name)}</b>
          <small>${esc([c.rif, c.address, c.phone].filter(Boolean).join(' · '))}${busy(c) ? ' · <span class="warn-txt">ya tiene pedido</span>' : ''}</small></button>`).join('')}</div>`
        : '<p>No está en tu cartera.</p>'}
      <div class="hint warn" style="margin-top:12px">Crea un cliente nuevo <b>solo si de verdad no está en tu cartera</b>. Un cliente repetido hace que se despache dos veces.</div>
      <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn btn-danger" id="pcNew">＋ Sí, es un cliente nuevo</button></div>`);
    sh.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-pick]'); if (!b) return;
      const c = clientById(b.dataset.pick); sh.close(); if (c) openClient(c.name, { client: c });
    });
    $('#pcNew', sh.el).onclick = () => { sh.close(); openClient(name, { isNew: true }); };
  }
  /** Ya le tomó pedido en los últimos 4 días: ¿de verdad es un pedido ADICIONAL? */
  function extraOrderSheet(client, name, prev) {
    const sh = openSheet(`
      <div class="row"><h2 class="grow">⚠ Ya le tomaste pedido a ${esc(client ? client.name : name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <table class="inv">${prev.slice(0, 4).map((o) => `<tr><td><b>${esc(fmtDate(o.routeDate))}</b> ${esc(hhmm(o.sentAt || o.createdAt))}<div class="muted">${esc(Loads.orderLabel(o))}${loadOf(o) ? ' · hoja ' + esc(Loads.labelOf(loadOf(o))) + (loadOf(o).number ? ' ' + esc(Loads.loadCode(loadOf(o))) : '') : ''}${o.createdBy === 'oficina' ? ' · 🏢 cargado por oficina' : ''}</div></td>
        <td class="n">${usd(Matrix.orderTotals(o).monto)}</td><td><button class="btn btn-sm" type="button" data-see="${esc(o.id)}">Ver</button></td></tr>`).join('')}</table>
      <div class="hint warn" style="margin-top:12px">Si es el <b>mismo pedido</b>, no lo cargues otra vez: se despacharía dos veces y habría devolución.<br>Solo si el cliente pidió <b>más mercancía aparte</b>, cárgalo como adicional.</div>
      <div class="actions"><button class="btn btn-primary" data-close>No, cancelar</button><button class="btn" id="eoExtra">＋ Es un pedido adicional</button></div>`);
    sh.el.addEventListener('click', (e) => { const b = e.target.closest('[data-see]'); if (b) { sh.close(); myOrderSheet(orderById(b.dataset.see)); } });
    $('#eoExtra', sh.el).onclick = () => { sh.close(); openClient(client ? client.name : name, { client, isNew: !client, extra: true }); };
  }
  /* ---------------- Pausa de pedidos (la oficina suspende al vendedor) ---------------- */
  function suspension() {
    const me = S.session && sellerById(S.session.sellerId);
    const until = me && me.suspendedUntil && Date.parse(me.suspendedUntil) > Date.now() ? me.suspendedUntil : null;
    if (!until) return null;
    // Cifras reales: sus pedidos enviados que aún no se despachan (en hojas o en espera)
    const pend = S.orders.filter((o) => o.sellerId === me.id && !o.deleted && ['enviado', 'en_carga', 'en_espera'].includes(o.status) && Matrix.orderTotals(o).items);
    const t = pend.reduce((a, o) => { const x = Matrix.orderTotals(o); a.cajas += x.cajas; a.unidades += x.unidades; return a; }, { cajas: 0, unidades: 0 });
    return { until, note: me.suspendNote || '', clients: new Set(pend.map((o) => o.clientId || o.clientKey)).size, cajas: t.cajas, unidades: t.unidades };
  }
  function suspensionHTML(su) {
    const hasta = new Date(su.until), mañana = hasta.toDateString() !== new Date().toDateString();
    return `<div class="pause-card"><div class="pause-ico">☕</div><div>
      <b>Tienes ${su.clients} cliente${su.clients === 1 ? '' : 's'} y ${nf0.format(su.cajas)} caja${su.cajas === 1 ? '' : 's'}${su.unidades ? ' + ' + nf0.format(su.unidades) + ' unid.' : ''} pendientes por despachar.</b>
      <p>Excelente trabajo. Toma un respiro. Te avisaremos cuando se descongestionen tus hojas de pedidos y puedas volver a subir pedidos.</p>
      <small class="muted">Pausa de la oficina hasta ${mañana ? hasta.toLocaleDateString('es-VE', { weekday: 'short', day: 'numeric', month: 'short' }) + ' ' : ''}${hasta.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}${su.note ? ' · ' + esc(su.note) : ''}</small></div></div>`;
  }
  let pauseTimer;
  async function openClientNow(name, opts) {
    opts = opts || {};
    if (suspension()) { toast('Pausa de la oficina: por ahora no puedes subir pedidos nuevos', 'err'); return; }
    name = String(name || '').replace(/\s+/g, ' ').trim();
    if (!name) { toast('Escribe o elige el cliente', 'err'); return; }
    if (name.length > 80) name = name.slice(0, 80);
    const seller = sellerById(S.session.sellerId);
    let client = opts.client || myClients().find((c) => norm(c.name) === norm(name));
    // 1) Escrito a mano y no está tal cual: primero se ofrecen los parecidos
    if (!client && !opts.isNew) { pickClientSheet(name, Dedup.similar(name, myClients())); return; }
    // 1b) Cliente nuevo: se registra con su ficha completa (nombre, RIF, teléfono, dirección…)
    if (!client) {
      Clientes.formSheet(null, { mode: 'seller', prefillName: name, defaults: { route: S.session.route || '' }, onSaved: (c) => openClient(c.name, { client: c, extra: opts.extra }) });
      return;
    }
    if (client) name = client.name;
    const key = norm(name);
    // 2) Pedido de hoy aún editable: se abre ese (no se crea otro)
    let o = pendingOrdersToday().find((x) => x.clientKey === key || (client && x.clientId === client.id));
    if (o && !opts.extra) toast(`Ya tenías un pedido de ${o.clientName}: se abrió ese`, 'ok');
    // 3) Ya pidió en los últimos 4 días (en cualquier hoja: esperando aprobación, aprobada, despachada…): confirmar que es adicional
    if (!o && !opts.extra) {
      const prev = recentOrdersOf(client, name);
      if (prev.length) { extraOrderSheet(client, name, prev); return; }
    }
    if (o && opts.extra) o = null;
    if (!o) {
      if (!client) return; // nunca se crea un cliente solo con el nombre: siempre con su ficha
      o = {
        id: DB.uid('o'), sellerId: seller.id, sellerName: seller.name,
        clientId: client.id, clientRif: client.rif || '', clientName: client.name, clientKey: key,
        route: client.route || S.session.route || '', routeDate: today(),
        status: 'abierto', lines: {}, notes: '', loadId: null,
        createdAt: DB.now(), deviceId: await Sync.deviceId(), deleted: false, ...(opts.extra ? { extraOk: true } : {}),
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
        <div class="pimg">${hasPhoto(p) ? `<img src="${esc(imgSrc(p))}" alt="" loading="lazy">` : `<span aria-hidden="true">${rubroIcon(p.category)}</span>`}
          ${req ? `<em class="qty-badge">${cj ? cj + 'cj' : ''}${cj && un ? '+' : ''}${un ? un + 'u' : ''}</em>` : ''}</div>
        <div class="pname">${esc(p.name)}</div>
        <div class="pcode mono">${esc(p.code)}</div>
        <div class="ppres">${esc(p.presentation)}${p.brand && !norm(p.name).includes(norm(p.brand)) ? ' · ' + esc(p.brand) : ''}</div>
        <div class="pprice">${prices.map((x) => '<div>' + x + '</div>').join('')}</div>
        ${hasStock(p) ? `<div class="pmeta"><span class="${over || low ? 'stock-low' : ''}">${over ? '⚠ ' : ''}${fmtStock(p.stock, p.unitsPerBox, p.sellBy)}</span></div>` : ''}
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
    const orders = pendingOrdersToday();
    const o = activeOrder();
    const cats = rubros();
    const routes = (seller.routes && seller.routes.length) ? seller.routes : (S.config.routes || []);
    const clients = myClients();
    app.innerHTML = `
      ${brandHeader(seller.name, 'Ruta ' + (S.session.route || '—') + ' · ' + fmtDate(today()),
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><button class="icon-btn ghost" id="menuBtn" aria-label="Menú">☰</button>`)}
      <nav class="quick-nav" id="quickNav" aria-label="Accesos">
        <button type="button" data-go="pedidos">🧾 Mis pedidos</button><button type="button" data-go="hojas">🚚 Mis hojas</button>
        <button type="button" data-go="clientes">👥 Mis clientes</button><button type="button" data-go="vacios">♻ Vacíos</button></nav>
      ${suspension() ? suspensionHTML(suspension()) : ''}
      <section class="client-bar" ${suspension() ? 'hidden' : ''}>
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
              ${markOf(x)}${x.createdBy === 'oficina' ? '🏢 ' : ''}${(x.dupWith || []).some((d) => !d.extra) ? '⚠ ' : ''}${esc(x.clientName)} <span class="badge">${usd(t.monto)}</span></button>`;
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
    clearTimeout(pauseTimer);
    { const su = suspension(); if (su) pauseTimer = setTimeout(() => { if (location.hash === '#/ruta') renderSeller(); }, Math.min(Date.parse(su.until) - Date.now() + 1000, 2147000000)); }
    $('#quickNav').onclick = (e) => {
      const b = e.target.closest('[data-go]'); if (!b) return;
      if (b.dataset.go === 'clientes') { location.hash = '#/ruta/clientes'; return; }
      S.ui.myo = { ...(S.ui.myo || { g: 'todos', r: '15' }), tab: b.dataset.go };
      location.hash = '#/ruta/pedidos';
    };
    $('#clientForm').onsubmit = (e) => { e.preventDefault(); $('#clientSug').innerHTML = ''; openClient($('#clientInput').value); };
    // Buscador: desde 2 letras muestra coincidencias de la cartera (nombre, RIF,
    // dirección o teléfono); si no aparece, se escribe y se crea como nuevo.
    const sug = $('#clientSug');
    $('#clientInput').addEventListener('input', (e) => {
      const q = norm(e.target.value);
      if (q.length < 2) { sug.innerHTML = ''; return; }
      const tokens = q.split(' ').filter(Boolean);
      const clean = (x) => norm(x).replace(/^[^a-z0-9]+/, '');
      const rank = (c) => (clean(c.name).startsWith(q) ? 0 : clean(c.name).split(' ').some((w) => w.startsWith(tokens[0])) ? 1 : 2);
      const hits = clients.filter((c) => { const h = norm(c.name + ' ' + (c.tradeName || '') + ' ' + c.rif + ' ' + c.address + ' ' + c.phone); return tokens.every((t) => h.includes(t)); })
        .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es')).slice(0, 8);
      sug.innerHTML = hits.map((c) => `<button type="button" class="sug-item" data-name="${esc(c.name)}"><b>${esc(c.name)}</b><small>${esc([c.tradeName, c.rif, c.address].filter(Boolean).join(' · '))}</small></button>`).join('') +
        `<button type="button" class="sug-item new" data-name="${esc(e.target.value.trim())}">＋ No está en la lista: registrar «${esc(e.target.value.trim().toUpperCase())}» con sus datos</button>`;
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
    const real = o.dupWith.filter((d) => !d.extra);
    const where = (d) => { const l = d.loadId ? S.loads.find((x) => x.id === d.loadId) : null; return `${d.routeDate ? 'del ' + esc(fmtDate(d.routeDate)) : ''}${l ? ' en hoja ' + esc(Loads.labelOf(l)) : ''} con ${esc(d.sellerName)}`; };
    if (!real.length) return `<div class="hint">➕ Pedido adicional confirmado: ${esc(o.clientName)} ya tenía otro pedido ${where(o.dupWith[0])}.</div>`;
    const same = real.filter((d) => d.kind !== 'similar'), sim = real.filter((d) => d.kind === 'similar');
    return `<div class="hint warn">${same.length ? `⚠ <b>Posible pedido duplicado:</b> ${esc(o.clientName)} también tiene pedido ${same.map(where).join('; ')}.` : ''}
      ${sim.length ? `${same.length ? '<br>' : ''}≈ <b>Nombre parecido:</b> ${sim.map((d) => `«${esc(d.clientName)}» ${where(d)}`).join('; ')}.` : ''} Verifica que no sea el mismo pedido.</div>`;
  }

  /**
   * Líneas de un pedido agrupadas por presentación (2 L, 1,5 L, 1,25 L…): los grupos
   * en el orden en que aparecen en el catálogo y, dentro de cada grupo, el orden del
   * catálogo. Solo cambia cómo se muestran: el pedido guardado no se toca.
   * items: [{ pid, l, ... }] → [{ pres, items }]
   */
  const presKey = (s) => String(s || '').toUpperCase().replace(/\s+/g, '').replace('.', ',');
  function groupLines(items) {
    const sorted = S.products.filter((p) => !p.deleted).sort(productSort());
    const rank = new Map(sorted.map((p, i) => [p.id, i]));
    const presRank = new Map();
    sorted.forEach((p, i) => { const k = presKey(p.presentation); if (!presRank.has(k)) presRank.set(k, i); });
    const R = 1e9, rk = (x) => (rank.has(x.pid) ? rank.get(x.pid) : R);
    const gr = (k) => (k ? (presRank.has(k) ? presRank.get(k) : R - 1) : R);
    const groups = new Map();
    items.forEach((x) => { const k = presKey(x.l.presentation); if (!groups.has(k)) groups.set(k, { key: k, pres: x.l.presentation || '', items: [] }); groups.get(k).items.push(x); });
    return [...groups.values()]
      .sort((a, b) => gr(a.key) - gr(b.key) || a.key.localeCompare(b.key, 'es', { numeric: true }))
      .map((g) => ({ pres: g.pres, items: g.items.sort((a, b) => rk(a) - rk(b) || String(a.l.category || '').localeCompare(String(b.l.category || ''), 'es') || String(a.l.name || '').localeCompare(String(b.l.name || ''), 'es')) }));
  }
  /** Filas de una tabla .lines con un rótulo por presentación (si hay más de una). */
  function groupedRows(items, cols, rowHTML) {
    const gs = groupLines(items);
    return gs.map((g) => (gs.length > 1 ? `<tr class="grp-row"><td colspan="${cols}">${esc(g.pres || 'Otros')}</td></tr>` : '') + g.items.map(rowHTML).join('')).join('');
  }

  function orderLinesHTML(o) {
    const lines = Object.entries(o.lines || {}).map(([pid, l]) => ({ pid, l, t: Matrix.lineTotals(l) }));
    const tot = Matrix.orderTotals(o);
    const rate = +S.config.exchangeRate || 0;
    if (!lines.length) return '<div class="empty"><strong>Pedido vacío</strong>Agrega productos desde el catálogo.</div>';
    return `<table class="lines">${groupedRows(lines, 2, ({ l, t }) => `
        <tr><td><b>${esc(l.name)} ${esc(l.presentation)}</b><div class="muted mono" style="font-size:12px">${esc(l.code)} · ${t.cajas ? t.cajas + ' cj × ' + usd(l.boxPrice) : ''}${t.cajas && t.unidades ? ' + ' : ''}${t.unidades ? t.unidades + ' un × ' + usd(l.unitPrice) : ''}</div></td>
            <td class="num">${usd(t.monto)}</td></tr>`)}
        <tr class="total-row"><td><b>TOTAL</b> · ${tot.cajas} cj + ${tot.unidades} un</td>
            <td class="num">${usd(tot.monto)}${rate ? `<div class="muted" style="font-size:12px">${bs(tot.monto * rate)}</div>` : ''}</td></tr>
      </table>`;
  }

  /** Vacíos de contraentrega (102, COLIC…): ¿tiene vacíos? y cuántos se le asignan. */
  function vacAskHTML(o, locked) {
    const v = Envases.orderVac(o, new Map(S.products.map((p) => [p.id, p])));
    const asg = v.lines.filter((l) => l.assign);
    if (!v.contra && !asg.length) return '';
    const has = o.envAssign && o.envAssign.has;
    return `<div class="vac-ask"><div class="section-title" style="margin:14px 0 6px">♻ Vacíos</div>
      <div class="row wrap" style="gap:8px;align-items:center"><span>¿El cliente tiene vacíos para entregar?</span>
        <button type="button" class="chip ${has === 'si' ? 'active' : ''}" data-has="si" ${locked ? 'disabled' : ''}>Sí</button>
        <button type="button" class="chip ${has === 'no' ? 'active' : ''}" data-has="no" ${locked ? 'disabled' : ''}>No</button></div>
      ${asg.map((l) => `<label class="field" style="margin-top:8px"><span>Vacíos asignados · ${esc(l.code)} ${esc(l.name)} (${l.boxes} cj) — en blanco si no aplica</span>
        <input class="input vac-asg" inputmode="numeric" data-pid="${esc(l.pid)}" value="${l.assigned === null ? '' : l.assigned}" placeholder="—" ${locked ? 'disabled' : ''}></label>`).join('')}
      ${v.contra ? `<p class="muted" style="margin:6px 0 0">Debe recibir <b>${v.toReceive}</b> vacíos al entregar (contraentrega).</p>` : ''}</div>`;
  }
  function bindVacAsk(sh, o) {
    const box = $('.vac-ask', sh.el); if (!box) return;
    // Un 'change' tardío (al perder el foco) puede llegar con el bloque ya redibujado
    const redraw = () => { if (!box.isConnected) return; box.outerHTML = vacAskHTML(o, !editable(o)); bindVacAsk(sh, o); };
    box.onclick = async (e) => {
      const b = e.target.closest('[data-has]'); if (!b || b.disabled) return;
      const cur = o.envAssign && o.envAssign.has;
      o.envAssign = { ...(o.envAssign || {}), has: cur === b.dataset.has ? null : b.dataset.has };
      if (!o.envAssign.has) delete o.envAssign.has;
      await saveOrder(o); redraw();
    };
    box.onchange = async (e) => {
      const i = e.target.closest('.vac-asg'); if (!i) return;
      const pid = i.dataset.pid, max = +((o.lines || {})[pid] || {}).cajas || 0, raw = i.value.trim();
      const qty = { ...((o.envAssign && o.envAssign.qty) || {}) };
      if (raw === '') delete qty[pid]; else qty[pid] = Math.min(max, Math.max(0, int(raw)));
      o.envAssign = { ...(o.envAssign || {}), qty };
      await saveOrder(o); redraw();
    };
  }

  function orderSheet() {
    const o = activeOrder(); if (!o) return;
    const locked = !editable(o);
    const client = clientById(o.clientId) || {};
    const sh = openSheet(`
      <div class="row"><div class="grow"><h2>${esc(o.clientName)} <button type="button" class="btn btn-sm" id="fixClient" title="Elegir el cliente correcto o corregir el nombre">✎ Cliente</button></h2>
        <div class="muted">${esc([client.rif, client.address].filter(Boolean).join(' · '))}</div>
        <div class="muted">${esc(fmtDate(o.routeDate))} · Ruta ${esc(o.route || '—')} · <span class="status ${o.status}">${esc(Loads.orderLabel(o))}</span></div></div>
        <button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${o.dupWith && o.dupWith.length ? dupHint(o) : ''}
      ${o.officeEdited ? '<div class="hint warn">La oficina ajustó cantidades de este pedido.</div>' : ''}
      ${orderLinesHTML(o)}
      ${vacAskHTML(o, locked)}
      <label class="field" style="margin-top:14px"><span>Nota para despacho</span>
        <textarea id="notes" class="input" maxlength="300" placeholder="Ej: entregar antes de las 10am, cobrar en divisas…" ${locked ? 'disabled' : ''}>${esc(o.notes || '')}</textarea></label>
      <div class="actions">
        ${o.status === 'abierto' ? `<button class="btn btn-ok" id="sendOrder" ${Object.keys(o.lines).length ? '' : 'disabled'}>✓ Cerrar y enviar</button>` : ''}
        ${!locked && o.status !== 'abierto' ? '<button class="btn btn-primary" data-close>✓ Listo (cambios guardados)</button>' : ''}
        <button class="btn btn-danger" id="delOrder" ${canDelete(o) ? '' : 'disabled'}>Eliminar</button>
      </div>`, { cls: 'sheet-order' });
    const notes = $('#notes', sh.el);
    notes.onchange = async () => { o.notes = notes.value.slice(0, 300); await saveOrder(o); };
    $('#fixClient', sh.el).onclick = () => { sh.close(); clientFixSheet(orderById(o.id) || o, { onDone: () => renderSeller() }); };
    bindVacAsk(sh, o);
    const send = $('#sendOrder', sh.el);
    if (send) send.onclick = async () => {
      if (suspension()) { toast('Pausa de la oficina: tu pedido queda guardado sin enviar hasta que te reactiven', 'err'); return; }
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

  /* ================== Corregir el cliente de un pedido ================== */
  // El vendedor escribió el nombre a mano (con errores, en minúsculas o repitiendo
  // un cliente). La oficina, y el vendedor en lo suyo, pueden:
  //   · elegir el cliente correcto de la lista de coincidencias (y unir el repetido)
  //   · corregir el nombre del cliente (se corrige en todos sus pedidos)
  // Un pedido ya liquidado no cambia de cliente (sus vacíos están en el kardex):
  // solo se le corrige el nombre.
  const liquidated = (x) => !!(x && x.delivery && x.delivery.at);
  function clientFixSheet(o, opts) {
    opts = opts || {};
    const office = !!opts.office, sid = S.session && S.session.sellerId;
    const cur = o.clientId ? clientById(o.clientId) : null;
    const pool = (office ? S.clients : S.clients.filter((c) => c.sellerId === sid)).filter((c) => c.active !== false && !c.deleted && (!cur || c.id !== cur.id));
    const canMove = !liquidated(o) && (office || editable(o));
    const canRename = office || !cur || (cur.sellerId === sid && cur.source === 'campo');
    const owner = cur && cur.sellerId ? (sellerById(cur.sellerId) || {}).name : '';
    const list = (q) => {
      const tokens = norm(q).split(' ').filter(Boolean);
      const hits = tokens.length ? pool.filter((c) => tokens.every((t) => norm(c.name + ' ' + (c.rif || '') + ' ' + (c.phone || '')).includes(t))).slice(0, 8) : Dedup.similar(o.clientName, pool, 0.34);
      return hits.map((c) => `<button type="button" class="sug-item" data-fix="${esc(c.id)}"><b>${esc(c.name)}</b><small>${esc([c.rif, c.address, office && c.sellerId ? 'cartera de ' + ((sellerById(c.sellerId) || {}).name || '—') : ''].filter(Boolean).join(' · '))}</small></button>`).join('')
        || '<p class="muted">Sin coincidencias. Escribe parte del nombre, RIF o teléfono.</p>';
    };
    const sh = openSheet(`
      <div class="row"><h2 class="grow">✎ Cliente del pedido</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="hint">Ahora: <b>${esc(o.clientName)}</b>${cur ? ` <span class="muted">${esc([cur.rif, cur.address, owner ? 'cartera de ' + owner : '', cur.source === 'campo' ? 'creado por el vendedor en la calle' : cur.source === 'oficina' ? 'creado por la oficina' : ''].filter(Boolean).join(' · '))}</span>` : ''}</div>
      ${canMove ? `<div class="section-title" style="margin:14px 0 6px">1 · Elegir el cliente correcto <span class="muted">(un solo nombre, sin duplicados)</span></div>
        <input id="cfQ" class="input" placeholder="Buscar cliente por nombre, RIF o teléfono…" autocomplete="off">
        <div id="cfList" class="pick-list" style="margin-top:8px">${list('')}</div>`
        : `<div class="hint warn">${liquidated(o) ? 'Este pedido ya está liquidado: no cambia de cliente (sus vacíos ya están en el kardex).' : 'Este pedido ya está aprobado: el cambio de cliente lo hace la oficina.'} Sí puedes corregir el nombre.</div>`}
      ${canRename ? `<div class="section-title" style="margin:16px 0 6px">${canMove ? '2 · ' : ''}Corregir el nombre de este cliente <span class="muted">(se corrige en todos sus pedidos)</span></div>
        <div class="row" style="gap:6px"><input id="cfName" class="input grow" maxlength="80" value="${esc(o.clientName.toUpperCase())}" style="text-transform:uppercase"><button type="button" class="btn btn-sm" id="cfUp" title="Pasar a MAYÚSCULAS">AA</button></div>
        <div class="actions"><button class="btn btn-primary" id="cfSave">Guardar nombre</button></div>` : ''}`, { wide: true });
    const done = () => { sh.close(); if (opts.onDone) opts.onDone(); runSync(false); };
    const q = $('#cfQ', sh.el);
    if (q) q.oninput = () => { $('#cfList', sh.el).innerHTML = list(q.value); };
    const up = $('#cfUp', sh.el); if (up) up.onclick = () => { const i = $('#cfName', sh.el); i.value = i.value.toUpperCase(); i.focus(); };
    const asOrder = (x, c) => ({ ...x, clientId: c.id, clientName: c.name, clientKey: norm(c.name), clientRif: c.rif || x.clientRif || '', clientFixedAt: DB.now() });
    sh.el.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-fix]'); if (!b) return;
      const target = clientById(b.dataset.fix); if (!target) return;
      const cur2 = orderById(o.id) || o;
      if (!confirm(`¿Cambiar el cliente de este pedido?\n\n«${cur2.clientName}» → «${target.name}»`)) return;
      await saveDocs('orders', asOrder(cur2, target));
      let merged = '';
      if (cur) {
        // Unir: los demás pedidos del cliente repetido pasan al correcto
        const others = S.orders.filter((x) => !x.deleted && x.clientId === cur.id && x.id !== o.id);
        const movable = others.filter((x) => !liquidated(x) && (office || editable(x)));
        const blocked = others.length - movable.length;
        const canDrop = !blocked && (office || cur.source === 'campo');
        if (office && confirm(`¿Fusionar «${cur.name}» en «${target.name}»?\n\nTodos sus pedidos (también los liquidados, con su kardex de vacíos) pasan a «${target.name}» y «${cur.name}» se elimina. Queda un solo cliente.`)) {
          try { const r = await Clientes.merge(target, [cur]); merged = ` · se fusionó «${cur.name}» (${r.orders} pedido(s))`; } catch (err) { toast(err.message, 'err'); }
        } else if (!office && (movable.length || canDrop) && confirm(`¿Unir «${cur.name}» con «${target.name}»?\n\n${movable.length ? `• ${movable.length} pedido(s) más de «${cur.name}» pasan a «${target.name}».\n` : ''}${canDrop ? `• «${cur.name}» se elimina de la cartera (queda un solo cliente).` : `• «${cur.name}» se queda en la cartera: tiene ${blocked} pedido(s) ya liquidado(s) o aprobado(s).`}`)) {
          if (movable.length) await saveDocs('orders', movable.map((x) => asOrder(x, target)));
          if (canDrop) await saveDocs('clients', { ...cur, deleted: true, mergedInto: target.id });
          merged = ` · se unió «${cur.name}»`;
        }
      }
      await logEvent('cliente_corregido', `Cambió el cliente del pedido: «${cur2.clientName}» → «${target.name}» (${cur2.sellerName})${merged}`, { orderId: o.id, clientId: target.id, clientName: target.name });
      toast(`Cliente: ${target.name}${merged}`, 'ok');
      done();
    });
    const save = $('#cfSave', sh.el);
    if (save) save.onclick = async () => {
      const name = $('#cfName', sh.el).value.replace(/\s+/g, ' ').trim().slice(0, 80).toUpperCase();
      if (!name) return;
      const cur2 = orderById(o.id) || o;
      if (name === cur2.clientName) { sh.close(); return; }
      const clash = pool.find((c) => norm(c.name) === norm(name));
      if (clash && canMove) { toast(`Ya existe «${clash.name}»: elígelo en la lista (así se unen y queda uno solo)`, 'err'); $('#cfQ', sh.el).value = clash.name; $('#cfList', sh.el).innerHTML = list(clash.name); return; }
      if (cur) {
        await saveDocs('clients', { ...cur, name, ...(!office && Clientes.isVerified(cur) ? { verified: false, verifyReason: 'el vendedor cambió el nombre' } : {}) });
        const mine = S.orders.filter((x) => !x.deleted && x.clientId === cur.id && (office || editable(x)));
        await saveDocs('orders', mine.map((x) => ({ ...x, clientName: name, clientKey: norm(name), clientFixedAt: DB.now() })));
      } else {
        await saveDocs('orders', { ...cur2, clientName: name, clientKey: norm(name), clientFixedAt: DB.now() });
      }
      await logEvent('cliente_corregido', `Corrigió el nombre del cliente: «${cur2.clientName}» → «${name}»`, { orderId: o.id, clientId: cur ? cur.id : '', clientName: name });
      toast('Nombre corregido: ' + name, 'ok');
      done();
    };
  }

  /* =============== Buscar: cliente, nota Valery o fecha (lupa) =============== */
  // Para todos (vendedor: sus pedidos; oficina y supervisor: todos). Si la nota
  // buscada se anuló, dice qué llevaba el cliente, el estado y la nota que la reemplaza.
  const RESULT_TXT = { entregada: '✓ Entregada', parcial: '↩ Devolución parcial', pendiente: '⏳ No se entregó · se entrega después', anulada: '✕ Nota anulada · no se entregó' };
  function noteStatusHTML(o, hitNote) {
    const d = o.delivery && o.delivery.at ? o.delivery : null;
    const vn = o.valeryNote || '', mark = (n) => (hitNote && n && String(n).replace(/\D/g, '').includes(hitNote) ? `<mark>${esc(n)}</mark>` : esc(n));
    if (!d) return `${esc(Loads.orderLabel(o))} · ${vn ? 'Nota Valery ' + mark(vn) : '<span class="muted">sin nota Valery todavía</span>'}`;
    if (d.result === 'parcial') return `<span class="warn-txt">Nota ${mark(d.voidedNote || vn)} ANULADA</span> → la reemplaza la nota <b>${mark(d.newValery || '—')}</b> (devolución parcial)`;
    if (d.result === 'anulada') return `<span class="warn-txt">Nota ${mark(d.voidedNote || vn)} ANULADA</span> · el cliente no recibió el pedido${d.motivo ? ' · ' + esc(d.motivo) : ''}`;
    if (d.result === 'pendiente') return `⏳ No se entregó: se entrega después con la misma nota ${mark(vn)}`;
    return `✓ Entregada · Nota ${mark(vn)}`;
  }
  function searchSheet() {
    const office = isOffice() || isSupervisor(), sid = S.session && S.session.sellerId;
    const scope = () => S.orders.filter((o) => !o.deleted && (office || o.sellerId === sid));
    const sh = openSheet(`
      <div class="row"><h2 class="grow">🔍 Buscar</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="row wrap" style="gap:8px"><input id="sQ" class="input grow" type="search" placeholder="Cliente, N° de nota Valery o RIF…" autocomplete="off">
        <input id="sD" class="input" type="date" style="max-width:180px" aria-label="Fecha"></div>
      <p class="muted" style="margin:6px 0 0">${office ? 'Todos los pedidos de este equipo.' : 'Tus pedidos.'} Puedes buscar una nota anulada: te dice qué llevaba y la nota que la reemplaza.</p>
      <div id="sRes" style="margin-top:10px"></div>`, { wide: true });
    const draw = () => {
      const q = $('#sQ', sh.el).value.trim(), date = $('#sD', sh.el).value;
      const digits = q.replace(/\D/g, ''), isNum = !!q && /^[\d\s.\-#ne]+$/i.test(q) && digits.length >= 2;
      const tokens = isNum ? [] : norm(q).split(' ').filter(Boolean);
      if (!q && !date) { $('#sRes', sh.el).innerHTML = '<p class="muted">Escribe un nombre, un número de nota o elige una fecha.</p>'; return; }
      const notesOf = (o) => [o.valeryNote, o.delivery && o.delivery.voidedNote, o.delivery && o.delivery.newValery, o.noteNumber ? Loads.noteCode(o.noteNumber) : ''].filter(Boolean);
      const res = scope().filter((o) => {
        if (date) { const l = loadOf(o); if (![o.routeDate, l && l.date, o.delivery && o.delivery.date].includes(date)) return false; }
        if (isNum) return notesOf(o).some((n) => String(n).replace(/\D/g, '').includes(digits)) || String(o.clientRif || '').replace(/\D/g, '').includes(digits);
        if (!tokens.length) return true;
        const h = norm([o.clientName, o.clientRif, o.sellerName, o.route].join(' '));
        return tokens.every((t) => h.includes(t));
      }).sort((a, b) => String(b.routeDate).localeCompare(String(a.routeDate)) || String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt))).slice(0, 40);
      const qty = (l) => (l ? [l.cajas ? l.cajas + ' cj' : '', l.unidades ? l.unidades + ' un' : ''].filter(Boolean).join(' + ') : '') || '—';
      const card = (o) => {
        const l = loadOf(o), d = o.delivery && o.delivery.at ? o.delivery : null, t = Matrix.orderTotals(o);
        const dl = d ? d.lines || {} : null;
        const rows = groupedRows(Object.entries(o.lines || {}).map(([pid, l]) => ({ pid, l })), dl ? 4 : 2, ({ pid, l: x }) => {
          const got = dl ? dl[pid] : null;
          const ret = dl ? { cajas: Math.max(0, (+x.cajas || 0) - (got ? +got.cajas || 0 : 0)), unidades: Math.max(0, (+x.unidades || 0) - (got ? +got.unidades || 0 : 0)) } : null;
          return `<tr><td>${esc(x.code)} ${esc(x.name)} ${esc(x.presentation || '')}</td><td class="num">${qty(x)}</td>${dl ? `<td class="num">${qty(got)}</td><td class="num">${ret.cajas || ret.unidades ? qty(ret) : ''}</td>` : ''}</tr>`;
        });
        return `<details class="card card-pad sr" style="margin-bottom:8px"><summary><b>${esc(o.clientName)}</b> · ${esc(fmtDate(o.routeDate))}${office ? ' · ' + esc(o.sellerName) : ''} · ${usd(d ? d.monto : t.monto)}
          <div style="margin-top:3px">${noteStatusHTML(o, isNum ? digits : '')}</div>
          <div class="muted" style="font-size:13px">${l ? `Hoja ${esc(Loads.labelOf(l))}${l.number ? ' ' + esc(Loads.loadCode(l)) : ''} · ${esc(Loads.statusOf(l, S.config).name)}` : 'Sin hoja'}${o.route ? ' · Ruta ' + esc(o.route) : ''}${o.pendingFrom ? ' · reprogramado de otro pedido' : ''}${o.createdBy === 'oficina' ? ' · 🏢 oficina' : ''}</div></summary>
          <table class="lines" style="margin-top:8px"><thead><tr><th style="text-align:left">Producto</th><th class="num">Llevaba</th>${dl ? '<th class="num">Entregado</th><th class="num">Devuelto</th>' : ''}</tr></thead><tbody>${rows}</tbody></table>
          ${o.notes ? `<p class="muted">📝 ${esc(o.notes)}</p>` : ''}</details>`;
      };
      $('#sRes', sh.el).innerHTML = res.length ? `<p class="muted">${res.length === 40 ? 'Primeros 40 resultados' : res.length + ' resultado' + (res.length > 1 ? 's' : '')}</p>${res.map(card).join('')}`
        : '<div class="empty"><strong>Sin resultados</strong>Prueba con parte del nombre o del número.</div>';
      if (res.length === 1) { const dt = $('#sRes details', sh.el); if (dt) dt.open = true; }
    };
    let tm;
    $('#sQ', sh.el).oninput = () => { clearTimeout(tm); tm = setTimeout(draw, 120); };
    $('#sD', sh.el).onchange = draw;
    draw();
    setTimeout(() => $('#sQ', sh.el).focus(), 50);
  }
  document.addEventListener('click', (e) => { if (e.target.closest('[data-search]')) searchSheet(); });

  /* ============================ Mis clientes ============================ */
  // El vendedor ve completa su cartera, registra clientes nuevos con todos sus
  // datos y actualiza los que tiene (no cambia crédito, vendedor ni estado).
  function renderMyClients() {
    const seller = sellerById(S.session.sellerId), sid = seller.id;
    const f = S.ui.myc || (S.ui.myc = { q: '', faltan: false });
    const all = myClients();
    const tokens = norm(f.q).split(' ').filter(Boolean);
    const list = all.filter((c) => (!f.faltan || Clientes.missing(c).length) &&
      (!tokens.length || tokens.every((t) => norm([c.name, c.tradeName, c.rif, c.phone, c.address, c.reference, c.route].join(' ')).includes(t))));
    const incompletos = all.filter((c) => Clientes.missing(c).length).length;
    const lastOrder = (c) => S.orders.filter((o) => !o.deleted && o.clientId === c.id).sort((a, b) => String(b.routeDate).localeCompare(String(a.routeDate)))[0];
    app.innerHTML = `
      ${brandHeader(seller.name, 'Mis clientes · ' + all.length + ' en mi cartera',
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="row wrap" style="gap:8px"><input id="mcQ" class="input grow" type="search" placeholder="Buscar por nombre, negocio, RIF, teléfono o dirección…" value="${esc(f.q)}">
          <button class="btn btn-primary" id="mcNew">＋ Cliente nuevo</button></div>
        <div class="chips" style="margin-top:8px"><button class="chip ${f.faltan ? '' : 'active'}" data-f="0">Todos (${all.length})</button><button class="chip ${f.faltan ? 'active' : ''}" data-f="1">⚠ Les faltan datos (${incompletos})</button></div>
        ${list.length ? `<div class="card" style="overflow:auto;margin-top:8px"><table class="inv"><tbody>${list.map((c) => { const miss = Clientes.missing(c), lo = lastOrder(c); return `<tr data-cli="${esc(c.id)}" style="cursor:pointer">
          <td><b>${esc(c.name)}</b>${c.tradeName ? ` <span class="muted">· ${esc(c.tradeName)}</span>` : ''}<div class="muted" style="font-size:12px">${esc([c.rif, c.phone, c.address].filter(Boolean).join(' · ') || 'Sin datos')}</div>
            ${Clientes.isVerified(c) ? '' : '<span class="status abierto">🕓 por verificar</span> '}${miss.length ? `<span class="status en_espera">⚠ falta: ${esc(miss.join(', '))}</span>` : ''}</td>
          <td class="n" data-l="Último pedido">${lo ? esc(fmtDate(lo.routeDate)) : '<span class="muted">—</span>'}</td></tr>`; }).join('')}</tbody></table></div>`
          : '<div class="empty card" style="margin-top:8px"><strong>Sin clientes</strong>con esa búsqueda.</div>'}
      </div>${creditFooter()}`;
    $('#bell').onclick = notifSheet; updateBell();
    $('#syncPill').onclick = () => runSync(true); updateSyncPill();
    let qt; $('#mcQ').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { f.q = e.target.value; renderMyClients(); const i = $('#mcQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 250); };
    app.querySelector('.chips').onclick = (e) => { const b = e.target.closest('[data-f]'); if (b) { f.faltan = b.dataset.f === '1'; renderMyClients(); } };
    $('#mcNew').onclick = () => Clientes.formSheet(null, { mode: 'seller', defaults: { route: S.session.route || '' }, onSaved: () => renderMyClients() });
    app.onclick = (e) => { const r = e.target.closest('[data-cli]'); if (r) myClientSheet(clientById(r.dataset.cli)); };
  }
  function myClientSheet(c) {
    if (!c) return;
    const orders = S.orders.filter((o) => !o.deleted && o.clientId === c.id).sort((a, b) => String(b.routeDate).localeCompare(String(a.routeDate)));
    const miss = Clientes.missing(c);
    const sh = openSheet(`
      <div class="row"><h2 class="grow">${esc(c.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${miss.length ? `<div class="hint warn">⚠ Le falta: ${esc(miss.join(', '))}. Complétalo con «Editar datos».</div>` : ''}
      ${Clientes.infoHTML(c)}
      <div class="section-title" style="margin:14px 0 6px">Últimos pedidos (${orders.length})</div>
      ${orders.length ? `<table class="inv">${orders.slice(0, 5).map((o) => `<tr><td>${esc(fmtDate(o.routeDate))}<div class="muted" style="font-size:12px">${esc(Loads.orderLabel(o))}${o.valeryNote ? ' · Nota ' + esc(o.valeryNote) : ''}</div></td><td class="n">${usd(o.delivery && o.delivery.at ? o.delivery.monto : Matrix.orderTotals(o).monto)}</td></tr>`).join('')}</table>` : '<p class="muted">Todavía no tiene pedidos.</p>'}
      <div class="actions"><button class="btn" id="mcEdit">✎ Editar datos</button><button class="btn btn-primary" id="mcOrder">🧾 Tomar pedido</button></div>`, { wide: true });
    $('#mcEdit', sh.el).onclick = () => { sh.close(); Clientes.formSheet(c, { mode: 'seller', onSaved: (n) => { renderMyClients(); myClientSheet(clientById(n.id) || n); } }); };
    $('#mcOrder', sh.el).onclick = () => { sh.close(); location.hash = '#/ruta'; setTimeout(() => openClient(c.name, { client: c }), 50); };
  }

  /* ====================== Mis pedidos (seguimiento) ====================== */
  // El vendedor sigue TODOS sus pedidos (no solo los de hoy): enviados, aprobados,
  // en espera y despachados, con lo que ajustó la oficina, y las hojas de carga
  // donde están sus clientes. Es su agenda de ventas.
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
  // Pedido liquidado: la oficina cerró la liquidación de su hoja (delivery solo existe mientras está cerrada)
  const isLiquidated = (o) => !!(o && o.delivery && o.delivery.at);
  const LIQ_TEXT = { entregada: '✓ Liquidado', parcial: '↩ Devolución parcial', pendiente: '⏳ Se entrega después', anulada: '✕ Nota anulada' };
  const liqBadge = (d) => `<span class="status ${d.result === 'entregada' ? 'aprobada' : d.result === 'anulada' ? 'over' : 'en_espera'}">${esc(LIQ_TEXT[d.result] || 'Liquidado')}</span>${d.newValery ? ` <span class="muted" style="font-size:12px">nota nueva ${esc(d.newValery)}</span>` : ''}`;
  const qty = (l) => (l ? [l.cajas ? l.cajas + ' cj' : '', l.unidades ? l.unidades + ' un' : ''].filter(Boolean).join(' + ') || '—' : '—');

  /**
   * Pedido «sin enviar»: se elimina completo (no suma en nada). Si su cliente es uno
   * nuevo sin verificar y no tiene otros pedidos, se ofrece eliminarlo también.
   */
  async function deleteUnsent(o, after) {
    if (!o || o.status !== 'abierto') return;
    if (!confirm(`¿Eliminar el pedido sin enviar de ${o.clientName}${Matrix.orderTotals(o).items ? ' (' + orderSummary(o) + ')' : ''}?`)) return;
    await saveOrder({ ...o, deleted: true });
    await logEvent('pedido_eliminado', `Eliminó el pedido sin enviar de ${o.clientName}`, { orderId: o.id, clientName: o.clientName });
    if (S.session && S.session.activeOrderId === o.id) await setSession({ ...S.session, activeOrderId: null });
    const c = o.clientId ? clientById(o.clientId) : null;
    const others = c ? S.orders.filter((x) => !x.deleted && x.clientId === c.id && x.id !== o.id).length : 1;
    if (c && !others && !Clientes.isVerified(c) && c.sellerId === S.session.sellerId &&
      confirm(`${c.name} no tiene otros pedidos y aún no está verificado por la oficina. ¿Eliminarlo también de tu cartera?`)) {
      await saveDocs('clients', { ...c, deleted: true });
      await logEvent('cliente_eliminado', `Eliminó el cliente ${c.name} (sin pedidos, sin verificar)`, { clientId: c.id, clientName: c.name });
    }
    toast('Pedido eliminado', 'ok'); runSync(false);
    if (after) after();
  }
  function renderSellerOrders() {
    const seller = sellerById(S.session.sellerId), sid = seller.id;
    const f = S.ui.myo || (S.ui.myo = { tab: 'pedidos', g: 'todos', r: '15' });
    const mine = S.orders.filter((o) => o.sellerId === sid && inRange(o.routeDate, f.r));
    const list = mine.filter((o) => f.g === 'todos' || groupOf(o) === f.g)
      .sort((a, b) => String(b.routeDate).localeCompare(String(a.routeDate)) || String(b.sentAt || b.createdAt).localeCompare(String(a.sentAt || a.createdAt)));
    const sent = mine.filter((o) => o.status !== 'abierto' && !isLiquidated(o)), desp = mine.filter((o) => o.status === 'despachado');
    const sum = (arr) => arr.reduce((a, o) => a + Matrix.orderTotals(o).monto, 0);
    // Lo que cuenta es lo LIQUIDADO: lo que el cliente recibió de verdad (sin devoluciones ni notas anuladas)
    const liqd = mine.filter(isLiquidated), porLiq = desp.filter((o) => !isLiquidated(o));
    const delivered = (arr) => arr.reduce((a, o) => a + (+o.delivery.monto || 0), 0);
    const count = (g) => mine.filter((o) => g === 'todos' || groupOf(o) === g).length;
    const loads = S.loads.filter((l) => Loads.sellerIdsOf(l).includes(sid) || S.orders.some((o) => o.sellerId === sid && o.loadId === l.id))
      .filter((l) => inRange(l.date || l.closedAt || l.createdAt, f.r))
      .sort((a, b) => String(b.date || b.closedAt || b.createdAt).localeCompare(String(a.date || a.closedAt || a.createdAt)));
    const chip = (key, cur, label, data) => `<button class="chip ${key === cur ? 'active' : ''}" ${data}="${key}">${label}</button>`;
    const orderRow = (o) => {
      const t = Matrix.orderTotals(o), l = loadOf(o), g = groupOf(o), d = isLiquidated(o) ? o.delivery : null;
      const del = o.status === 'abierto' ? `<button type="button" class="btn btn-sm btn-danger" data-delopen="${esc(o.id)}" title="Eliminar este pedido sin enviar">🗑</button>` : '';
      return `<tr data-myo="${esc(o.id)}" style="cursor:pointer">
        <td><b>${esc(o.clientName)}</b><div class="muted" style="font-size:12px">${esc(fmtDate(o.routeDate))}${l ? ' · ' + esc(Loads.labelOf(l)) + (l.number ? ' · ' + esc(Loads.loadCode(l)) : '') : ''}${o.valeryNote ? ' · Nota ' + esc(o.valeryNote) : ''}${(o.officeMsgs || []).length ? ' · 💬 ' + o.officeMsgs.length : ''}</div>
          ${d ? liqBadge(d) : `<span class="status ${g === 'aprobados' ? 'en_carga' : o.status}">${esc(GROUP_TEXT[g])}</span>`}${o.createdBy === 'oficina' ? ' <span class="status aprobada">🏢 cargado por oficina</span>' : ''}${o.officeEdited ? ' <span class="status en_espera">ajustado por oficina</span>' : ''}${(o.dupWith || []).some((d) => !d.extra) ? ' <span class="status over">⚠ posible duplicado</span>' : ''}</td>
        <td class="n" data-l="Monto">${d ? `${usd(d.monto)}${Math.abs(d.monto - t.monto) > 0.004 ? `<div class="muted" style="font-size:12px;text-decoration:line-through">${usd(t.monto)}</div>` : ''}` : usd(t.monto)} ${del}</td></tr>`;
    };
    app.innerHTML = `
      ${brandHeader(seller.name, 'Mis pedidos · seguimiento',
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="chips" id="myRange">${MY_RANGES.map(([k, l]) => chip(k, f.r, l, 'data-r')).join('')}</div>
        <div class="kpi-row" style="margin-top:10px">
          <div class="kpi"><small>Venta liquidada</small><b>${usd(delivered(liqd))}</b><small>${liqd.filter((o) => +o.delivery.monto > 0).length} clientes</small></div>
          <div class="kpi"><small>Venta en proceso</small><b>${usd(sum(sent))}</b><small>${sent.length} pedidos · aún no cuenta (${porLiq.length} despachados sin liquidar)</small></div>
        </div>
        <p class="muted" style="margin-top:-4px"><b>Venta liquidada</b> = lo que el cliente recibió y paga de verdad, ya sin devoluciones ni notas anuladas. <b>Venta en proceso</b> = enviados, aprobados y despachados que todavía no se liquidan: puede cambiar.</p>
        <div class="chips" id="myTab">${chip('pedidos', f.tab, '🧾 Mis pedidos', 'data-t')}${chip('hojas', f.tab, '🚚 Hojas de carga', 'data-t')}${chip('vacios', f.tab, '♻ Vacíos', 'data-t')}<a class="chip" href="#/ruta/clientes">👥 Mis clientes</a></div>
        ${f.tab === 'vacios' ? '<div id="myVac"></div>' : f.tab === 'pedidos' ? `
          <div class="chips" id="myGroup">${MY_GROUPS.map(([k, l]) => chip(k, f.g, `${l} <span class="badge">${count(k)}</span>`, 'data-g')).join('')}</div>
          ${list.length ? `<div class="card" style="overflow:auto"><table class="inv"><tbody>${list.map(orderRow).join('')}</tbody></table></div>`
            : '<div class="empty card"><strong>Sin pedidos</strong>en ese período con ese estado.</div>'}`
        : (loads.length ? loads.map((l) => {
            const os = S.orders.filter((o) => o.sellerId === sid && o.loadId === l.id);
            const st = Loads.statusOf(l, S.config);
            return `<div class="card card-pad" style="margin-bottom:10px">
              <div class="row"><h3 class="grow" style="margin:0">${esc(Loads.labelOf(l))} ${l.number ? '<span class="mono muted">' + esc(Loads.loadCode(l)) + '</span>' : ''}</h3>
                <span class="status ${st.locked ? 'en_carga' : 'enviado'}">${st.locked ? '🔒 ' : ''}${esc(st.name)}</span></div>
              <div class="muted" style="margin:4px 0 8px">📅 ${esc(fmtDate(l.date || String(l.closedAt || l.createdAt).slice(0, 10)))} · Ruta ${esc(l.route || '—')} · Despachador: <b>${esc(l.dispatcherName || 'sin asignar')}</b></div>
              ${os.length ? `<table class="inv"><tbody>${os.map(orderRow).join('')}</tbody></table>
                <div class="row" style="justify-content:flex-end;margin-top:6px"><b>Tus clientes en esta hoja: ${os.length} · ${os.some(isLiquidated) ? `entregado ${usd(delivered(os.filter(isLiquidated)))}` : usd(sum(os))}</b></div>`
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
    if (f.tab === 'vacios') renderMyVacios($('#myVac'), sid);
    const mg = $('#myGroup'); if (mg) mg.onclick = (e) => { const b = e.target.closest('[data-g]'); if (b) { f.g = b.dataset.g; renderSellerOrders(); } };
    app.querySelectorAll('[data-myo]').forEach((tr) => { tr.onclick = (e) => { const d = e.target.closest('[data-delopen]'); if (d) { deleteUnsent(orderById(d.dataset.delopen), renderSellerOrders); return; } myOrderSheet(orderById(tr.dataset.myo)); }; });
  }

  /* ---------- ♻ Vacíos de mis clientes (E6): saldo y movimientos, solo lectura ---------- */
  async function renderMyVacios(box, sid) {
    if (!box) return;
    const st = S.ui.myVac || (S.ui.myVac = { movs: null, at: 0, err: '', loading: false });
    if (!st.movs) { try { const c = await DB.getMeta('myVac:' + sid, null); if (c && c.movs) { st.movs = c.movs; st.at = c.at; } } catch (e) { /* noop */ } }
    const draw = () => {
      if (!box.isConnected) return;
      if (!st.movs) { box.innerHTML = `<div class="empty card"><strong>♻ Vacíos de tus clientes</strong>${st.loading ? 'Cargando…' : (st.err ? esc(st.err) : 'Sin datos todavía.')}${st.loading ? '' : '<div class="row" style="justify-content:center;margin-top:10px"><button class="btn" id="mvRef">⟳ Actualizar</button></div>'}</div>`; const b = $('#mvRef'); if (b) b.onclick = load; return; }
      const bal = Kardex.balances(st.movs), cl = Kardex.byClient(st.movs).filter((c) => c.debe || c.asignados).sort((a, b) => b.debe - a.debe || a.clientName.localeCompare(b.clientName, 'es'));
      const types = [...new Set(bal.map((b) => b.type))].sort((a, b) => parseFloat(String(a).replace(',', '.')) - parseFloat(String(b).replace(',', '.')));
      const tot = Kardex.totalsByType(st.movs);
      box.innerHTML = `
        <div class="kpi-row">${tot.map((t) => `<div class="kpi"><small>Vacíos ${esc(t.type)} · te deben</small><b class="${t.debe > 0 ? 'warn-txt' : ''}">${nf0.format(t.debe)}</b><small>${t.clientes} clientes · ${nf0.format(t.asignados)} asignados</small></div>`).join('') || '<div class="kpi"><small>Vacíos</small><b>0</b><small>Tus clientes no deben vacíos</small></div>'}</div>
        <p class="muted">Lo que cada cliente <b>debe</b> (despachados − recibidos − asignados − devoluciones) y los <b>asignados</b> que tiene. Se actualiza cuando la oficina liquida las hojas${st.at ? ` · al ${esc(new Date(st.at).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }))}` : ''}.</p>
        <div class="row" style="margin-bottom:8px"><button class="btn btn-sm" id="mvRef">⟳ Actualizar</button>${st.err ? `<span class="warn-txt" style="margin-left:8px">${esc(st.err)} (se muestra lo último guardado)</span>` : ''}</div>
        ${cl.length ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Cliente</th>${types.map((t) => `<th class="n">${esc(t)}</th>`).join('')}<th></th></tr></thead><tbody>
          ${cl.map((c) => `<tr data-mvc="${esc(c.clientId)}" style="cursor:pointer"><td><b>${esc(c.clientName)}</b><div class="muted" style="font-size:12px">${esc(fmtDate(c.last))}</div></td>${types.map((t) => { const b = c.types[t]; return !b || (!b.debe && !b.asignados) ? '<td class="n muted">·</td>' : `<td class="n"><b class="${b.debe > 0 ? 'warn-txt' : ''}">${nf0.format(b.debe)}</b>${b.asignados ? `<div class="muted" style="font-size:12px">+${nf0.format(b.asignados)} asig.</div>` : ''}</td>`; }).join('')}<td class="muted">›</td></tr>`).join('')}</tbody></table></div>`
          : '<div class="empty card"><strong>Sin saldos</strong>ninguno de tus clientes debe vacíos.</div>'}`;
      $('#mvRef').onclick = load;
      box.querySelectorAll('[data-mvc]').forEach((tr) => { tr.onclick = () => myVacSheet(st.movs, tr.dataset.mvc); });
    };
    const load = async () => {
      st.loading = true; st.err = ''; draw();
      const r = await Sync.myVacios(sid);
      st.loading = false;
      if (r.ok) { st.movs = r.data.movs || []; st.at = Date.now(); try { await DB.setMeta('myVac:' + sid, { movs: st.movs, at: st.at }); } catch (e) { /* noop */ } }
      else st.err = r.offline ? 'Sin internet' : (r.error || 'No se pudo actualizar');
      draw();
    };
    draw();
    if (!st.movs || Date.now() - st.at > 120000) load();
  }

  function myVacSheet(movs, clientId) {
    const h = Kardex.history(movs, clientId), bal = Kardex.balances(movs).filter((b) => b.clientId === clientId);
    const name = (h[h.length - 1] || {}).clientName || '';
    const parse = (m) => { try { return JSON.parse(m.data || '{}'); } catch (e) { return {}; } };
    const types = bal.map((b) => b.type);
    openSheet(`
      <div class="row"><h2 class="grow">♻ ${esc(name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="kpi-row">${bal.map((b) => `<div class="kpi"><small>Vacíos ${esc(b.type)} · debe</small><b class="${b.debe > 0 ? 'warn-txt' : ''}">${nf0.format(b.debe)}</b><small>${nf0.format(b.asignados)} asignados</small></div>`).join('')}</div>
      ${types.map((t) => { const f = Kardex.fifo(movs, clientId, t); return f.rows.length ? `<div class="section-title" style="margin:10px 0 4px">Lo que debe de ${esc(t)}</div><table class="lines"><tbody>${f.rows.map((r) => `<tr><td>${esc(fmtDate(r.date))} · ${esc(r.label)}</td><td class="num">${r.left}${r.paid ? `<div class="muted" style="font-size:12px">de ${r.owed}</div>` : ''}</td></tr>`).join('')}</tbody></table>` : ''; }).join('')}
      <div class="section-title" style="margin:12px 0 4px">Movimientos</div>
      <table class="lines"><tbody>${h.slice().reverse().map((m) => { const d = parse(m); const cancel = m.kind === 'anulacion' || m.kind === 'reverso';
        return `<tr${m.cancelled ? ' style="opacity:.5;text-decoration:line-through"' : ''}><td>${esc(fmtDate(m.date))} · ${esc(m.label)}${m.cancelled ? ' (anulado)' : ''}<div class="muted" style="font-size:12px">${esc([m.type, m.code, d.valeryNote && 'nota ' + d.valeryNote, m.motivo].filter(Boolean).join(' · '))}</div></td>
          <td class="num">${cancel ? '' : (Kardex.EFFECT[m.kind] && Kardex.EFFECT[m.kind][0] > 0 ? '+' : '−') + m.qty}${cancel ? '' : `<div class="muted" style="font-size:12px">debe ${m.debe}</div>`}</td></tr>`; }).join('')}</tbody></table>
      <p class="muted">Las devoluciones de vacíos las registra la oficina.</p>`, { wide: true });
  }

  /** Detalle de un pedido para el vendedor: lo que pidió contra lo que queda/salió, hoja, despachador y nota. */
  function myOrderSheet(o) {
    if (!o) return;
    const l = loadOf(o), g = groupOf(o), t = Matrix.orderTotals(o);
    const sentL = o.sentLines || null;
    const ids = [...new Set(Object.keys(sentL || {}).concat(Object.keys(o.lines || {})))];
    const liqd = isLiquidated(o), dl = liqd ? (o.delivery.lines || {}) : {};
    // Lo devuelto = lo que llevaba el pedido menos lo que el cliente se quedó
    const retOf = (pid) => { const f = (o.lines || {})[pid], x = dl[pid]; if (!f) return null;
      const c = Math.max(0, (+f.cajas || 0) - (x ? +x.cajas || 0 : 0)), u = Math.max(0, (+f.unidades || 0) - (x ? +x.unidades || 0 : 0));
      return c || u ? { cajas: c, unidades: u } : null; };
    const rows = ids.map((pid) => {
      const fin = (o.lines || {})[pid], was = sentL ? sentL[pid] : null, ref = fin || was;
      const changed = sentL && qty(was) !== qty(fin);
      const ret = liqd ? retOf(pid) : null;
      return `<tr${changed ? ' class="short"' : ''}><td><b>${esc(ref.name)} ${esc(ref.presentation || '')}</b><div class="muted mono" style="font-size:12px">${esc(ref.code || '')}</div></td>
        ${sentL ? `<td class="num">${esc(qty(was))}</td>` : ''}<td class="num">${esc(qty(fin))}${changed ? ' ✏️' : ''}</td>${liqd ? `<td class="num"><b>${esc(qty(dl[pid]))}</b>${ret ? `<div class="muted" style="font-size:12px">↩ ${esc(qty(ret))}</div>` : ''}</td>` : ''}</tr>`;
    }).join('');
    const vacD = liqd && o.delivery.vac ? Object.values(o.delivery.vac) : [];
    const vacBlock = vacD.length ? `<div class="section-title" style="margin:14px 0 6px">♻ Vacíos de este pedido</div>
      <table class="lines"><thead><tr><th style="text-align:left">Envase</th><th class="num">Enviados</th><th class="num">Recibidos</th><th class="num">Asignados</th><th class="num">Quedan</th></tr></thead>
      <tbody>${vacD.map((v) => `<tr><td><b>${esc(v.code)}</b> <span class="muted">${esc(v.type)}${v.regime === 'prestamo' ? ' · préstamo' : ''}</span>${v.motivo ? `<div class="muted" style="font-size:12px">${esc(v.motivo)}</div>` : ''}</td><td class="num">${v.boxes}</td><td class="num">${v.recv}</td><td class="num">${v.asg == null ? '—' : v.asg}</td><td class="num"><b>${v.pending || 0}</b></td></tr>`).join('')}</tbody></table>` : '';
    const info = [
      ['Fecha del pedido', fmtDate(o.routeDate)],
      ['Enviado', o.sentAt ? new Date(o.sentAt).toLocaleString('es-VE', { dateStyle: 'short', timeStyle: 'short' }) : '—'],
      ['Estado', GROUP_TEXT[g]],
      ['Hoja de carga', l ? Loads.labelOf(l) + (l.number ? ' · ' + Loads.loadCode(l) : '') : '—'],
      ['Estado de la hoja', l ? Loads.statusOf(l, S.config).name : '—'],
      ['Despachador', (l && l.dispatcherName) || '—'],
      ['Fecha de carga', l && (l.date || l.closedAt) ? fmtDate(l.date || String(l.closedAt).slice(0, 10)) : '—'],
      ['Nota de entrega', o.valeryNote || '—'],
      ...(isLiquidated(o) ? [['Liquidación', LIQ_TEXT[o.delivery.result] || 'Liquidado'], ['Entregado', usd(o.delivery.monto)],
        ...(o.delivery.newValery ? [['Nota que la reemplaza', o.delivery.newValery]] : []), ...(o.delivery.motivo ? [['Motivo', o.delivery.motivo]] : [])] : []),
    ];
    openSheet(`
      <div class="row"><h2 class="grow">${esc(o.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="grid2" style="margin:8px 0 12px">${info.map(([k, v]) => `<div><small class="muted">${esc(k)}</small><div><b>${esc(v)}</b></div></div>`).join('')}</div>
      ${o.createdBy === 'oficina' ? '<div class="hint">🏢 Este pedido lo cargó la oficina a tu nombre.</div>' : ''}
      ${o.dupWith && o.dupWith.length ? dupHint(o) : ''}
      ${o.officeEdited ? `<div class="hint warn">✏️ La oficina ajustó este pedido${sentL ? ': las filas marcadas cambiaron respecto a lo que enviaste.' : '.'}</div>` : ''}
      <table class="lines"><thead><tr><th style="text-align:left">Producto</th>${sentL ? '<th class="num">Pediste</th>' : ''}<th class="num">${g === 'despachados' ? 'Despachado' : 'Queda'}</th>${liqd ? '<th class="num">Entregado</th>' : ''}</tr></thead>
        <tbody>${rows || '<tr><td class="muted">Sin productos</td></tr>'}</tbody></table>
      <div class="row" style="justify-content:space-between;margin-top:10px;font-size:18px"><b>Total · ${t.cajas} cj + ${t.unidades} un</b><b>${usd(t.monto)}</b></div>
      ${vacBlock}
      <div class="section-title" style="margin:14px 0 6px">💬 Notas y mensajes</div>
      ${msgThreadHTML(o)}`, { cls: 'sheet-order' });
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
      ${S.persisted === false ? `<div class="hint warn" style="margin-top:12px">${PERSIST_HINT}</div>` : ''}
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

  /* ================== Claves y almacenamiento del equipo ================== */
  const PERSIST_HINT = '⚠ El navegador puede borrar los datos de este equipo si se queda sin espacio. Para protegerlos: en Chrome abre el menú ⋮ → <b>Instalar app</b> (o «Agregar a pantalla principal») y entra siempre desde ese ícono. Activar los avisos 🔔 también ayuda.';

  /**
   * Equipo que ya estaba conectado y perdió sus claves (el navegador borró los
   * datos): las pide al servidor con la cookie de acceso, que sobrevive.
   */
  async function recoverKeys() {
    const st = S.settings;
    if (st.syncKey && (st.adminKey || st.supervisorKey || !DB.getCookie('pv_office_on'))) return false;
    const r = await Sync.keysCall('recover');
    if (!r.ok || !r.data) return false;
    const patch = {};
    if (!st.syncKey && r.data.syncKey) patch.syncKey = r.data.syncKey;
    if (!st.adminKey && !st.supervisorKey && r.data.adminKey) patch.adminKey = r.data.adminKey;
    if (!Object.keys(patch).length) return false;
    await saveSettings(patch);
    return true;
  }
  /** La PC de oficina deja (o renueva cada 30 días) su cookie para recuperar la clave admin. */
  async function rememberOffice(force) {
    if (!S.settings.adminKey) return;
    const at = await DB.getMeta('officeKeyAt', '');
    if (!force && at && Date.now() - Date.parse(at) < 30 * 86400000) return;
    const r = await Sync.keysCall('remember');
    if (r.ok) { await DB.setMeta('officeKeyAt', new Date().toISOString()); DB.setCookie('pv_office_on', '1'); }
  }
  /** El equipo deja de ser oficina (quitaron la clave admin o entró como supervisor). */
  async function forgetOffice() {
    await DB.remove('meta', 'officeKeyAt');
    DB.setCookie('pv_office_on', '');
    await Sync.keysCall('forget');
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
    if (window.Aviso) Aviso.start(); // cinta de suscripción (todas las pantallas)
    // Equipo que ya trabajaba con la app (cookie) y amanece sin datos: el navegador los borró
    const prevDev = DB.getCookie('pv_dev');
    if (prevDev && !(await DB.getMeta('deviceId', null)) && !S.wipeNotice) {
      S.wipeNotice = { at: new Date().toISOString(), prev: prevDev };
      await DB.setMeta('wipeNotice', S.wipeNotice);
    }
    DB.requestPersistence().then((v) => { S.persisted = !!v; });
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
    // Primero se recuperan las claves perdidas (si hace falta); luego se sincroniza y baja todo
    recoverKeys().catch(() => false).then((ok) => {
      if (ok) { toast('Conexión recuperada: bajando tus datos del servidor…', 'ok'); render(); }
      rememberOffice(false).catch(() => {});
      scheduleSync(ok ? 0 : 1200);
    });
  }
  // Arranque: lo invoca index.html después de cargar office.js

  window.PV = {
    S, $, $$, esc, nf2, nf0, usd, bs, int, dec, norm, slug, today, fmtDate, fmtStock, hasStock, productSort, productLabel, rubroIcon,
    toast, openSheet, copyText, saveFile, saveBinary, pickFile, brandHeader, creditFooter,
    clientFixSheet, searchSheet, imgSrc, hasPhoto,
    syncInfo: () => ({ idle: isIdle(), every: syncEvery() }), _idleSince: (ms) => { lastInput = Date.now() - ms; },
    loadAll, saveDocs, saveOrder, saveSettings, setSession, msgThreadHTML, rememberOffice, forgetOffice, PERSIST_HINT, runSync, updateSyncPill, render, refreshAfterRemote, updateBell, beep, logEvent, isSupervisor,
    notifSheet, refreshPush,
    productById, sellerById, orderById, clientById, rubros, orderLinesHTML, groupLines, groupedRows,
    boot, localNotif,
  };
})();
