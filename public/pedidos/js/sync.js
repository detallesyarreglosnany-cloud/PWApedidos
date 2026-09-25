/* =========================================================================
 * sync.js — Sincronización offline-first
 *
 * Dos canales, mismas reglas de fusión:
 *   1. HTTP  → POST {syncUrl}  (endpoint /api/pedidos/sync del mismo host)
 *   2. Archivo → paquete JSON exportado/importado (WhatsApp, USB, correo)
 *      para cuando no hay servidor o no hay datos en la calle.
 *
 * Reglas de fusión (idénticas en cliente y servidor):
 *   - Last-write-wins por updatedAt.
 *   - Catálogo (products/sellers): la oficina es la autoridad. Un equipo sin
 *     clave admin SIEMPRE acepta la versión remota y nunca sube catálogo.
 *   - Pedidos: si su hoja de carga está en un estado bloqueado (aprobada para
 *     carga, cerrada…) queda congelado; la versión del vendedor no lo pisa.
 * ========================================================================= */
(function (global) {
  'use strict';

  const DEFAULT_SYNC_URL = '/api/pedidos/sync';
  const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config', 'events'];
  // Solo la oficina (clave admin) publica estos tipos
  const ADMIN_KINDS = ['products', 'sellers', 'loads', 'config'];
  // Un pedido bloqueado (hoja aprobada/cerrada) ya no lo puede pisar el teléfono
  const isLocked = (o) => !!o && (o.locked === true || o.status === 'despachado');
  const INITIAL_ORDER_DAYS = 60; // historial que baja un teléfono nuevo (seguimiento y comisiones)
  let running = null;

  async function settings() {
    return DB.getMeta('settings', {});
  }

  async function deviceId() {
    let id = await DB.getMeta('deviceId', null);
    if (!id) { id = DB.uid('dev'); await DB.setMeta('deviceId', id); }
    return id;
  }

  function newer(a, b) {
    return String(a && a.updatedAt || '') > String(b && b.updatedAt || '');
  }

  // Campos de un pedido que decide la oficina (espejo del servidor)
  const OFFICE_ORDER_FIELDS = ['loadId', 'locked', 'loadStatusName', 'noteNumber', 'loadNumber', 'dispatchedAt', 'officeEdited', 'heldAt'];
  const OFFICE_ORDER_STATUS = ['en_carga', 'en_espera', 'despachado'];

  /**
   * Fusiona documentos remotos en el store local. Devuelve cuántos cambió.
   * fromFile: el documento viene de un archivo (WhatsApp/USB), no del servidor.
   *   Solo entra si es más nuevo que el local, y un pedido que llega de un
   *   teléfono nunca deshace lo que decidió la oficina (hoja, bloqueo, número).
   */
  async function mergeRemote(store, remoteDocs, isAdmin, markDirty, fromFile) {
    if (!remoteDocs || !remoteDocs.length) return 0;
    const locals = await DB.getAll(store);
    const byId = new Map(locals.map((d) => [d.id, d]));
    const toPut = [];
    remoteDocs.forEach((r0) => {
      let r = r0;
      if (!r || typeof r.id !== 'string' || !r.updatedAt) return;
      const l = byId.get(r.id);
      if (fromFile && l) {
        if (!newer(r, l)) return; // el archivo trae una versión igual o más vieja
        if (store === 'orders') {
          if (isLocked(l) && !isAdmin) return;
          if (isAdmin && (isLocked(l) || l.loadId || OFFICE_ORDER_STATUS.includes(l.status))) {
            if (isLocked(l)) return; // pedido ya aprobado/despachado: no lo cambia un archivo
            r = { ...r };
            OFFICE_ORDER_FIELDS.forEach((f) => { if (l[f] !== undefined) r[f] = l[f]; });
            if (OFFICE_ORDER_STATUS.includes(l.status)) r.status = l.status;
          }
        }
      }
      if (l && l.dirty) {
        if (store === 'orders' || store === 'loads') {
          const frozen = store === 'orders' && isLocked(r) && !isAdmin;
          if (!frozen && !r.partial && !l.partial) {
            // Mis cambios locales aún sin subir + los del otro equipo, campo por campo
            const m = DB.mergeFields(r, l, store);
            if (m.fromB) {
              if (m.fromA) toPut.push({ ...m.doc, updatedAt: DB.after(r.updatedAt, l.updatedAt), dirty: true });
              return;
            }
          }
        } else if ((isAdmin || store === 'clients') && newer(l, r)) {
          return; // la oficina editó después: se subirá en el próximo push
        }
      }
      // Vista reducida de una hoja (la que baja un vendedor): nunca pisa la hoja
      // completa que ya tiene este equipo si también se usa como oficina
      if (l && r.partial && !l.partial) return;
      if (l && !l.dirty && l.updatedAt === r.updatedAt && !!l.partial === !!r.partial) return; // idéntico
      toPut.push({ ...r, dirty: !!markDirty });
    });
    await DB.putMany(store, toPut);
    return toPut.length;
  }

  /** Quita la marca dirty solo si el doc no cambió mientras se subía. */
  async function clearDirty(store, pushedDocs) {
    const toPut = [];
    for (const p of pushedDocs) {
      const cur = await DB.get(store, p.id);
      if (cur && cur.dirty && cur.updatedAt === p.updatedAt) toPut.push({ ...cur, dirty: false });
    }
    await DB.putMany(store, toPut);
  }

  /**
   * Lo pendiente de subir. Un teléfono solo sube pedidos y clientes del vendedor
   * que está usando la app: si antes lo usó otro vendedor, lo de ese vendedor
   * queda guardado hasta que él vuelva a entrar (nunca se mezcla).
   */
  async function collectDirty(isAdmin, sellerId) {
    const strip = (d) => { const c = { ...d }; delete c.dirty; delete c.dupWith; return c; };
    const mine = (k, d) => isAdmin || (k !== 'orders' && k !== 'clients' && k !== 'events') || (sellerId && d.sellerId === sellerId);
    const out = {};
    for (const k of KINDS) {
      out[k] = (!isAdmin && ADMIN_KINDS.includes(k)) ? [] : (await DB.getAll(k)).filter((d) => d.dirty && mine(k, d)).map(strip);
    }
    return out;
  }
  const total = (push) => KINDS.reduce((a, k) => a + push[k].length, 0);

  const MAX_BATCH_CHARS = 2500000;
  /** Parte la subida en tandas que caben en una petición a Vercel. */
  function splitPush(push) {
    const empty = () => Object.fromEntries(KINDS.map((k) => [k, []]));
    const out = [empty()];
    let size = 0;
    for (const k of KINDS) {
      for (const d of push[k]) {
        const n = JSON.stringify(d).length;
        if (size && size + n > MAX_BATCH_CHARS) { out.push(empty()); size = 0; }
        out[out.length - 1][k].push(d);
        size += n;
      }
    }
    return out;
  }

  async function post(url, headers, body) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    let res;
    const t0 = Date.now();
    try {
      res = await fetch(url, { method: 'POST', headers, signal: ctrl.signal, credentials: 'same-origin', body: JSON.stringify(body) });
    } catch (e) {
      return { ok: false, error: 'Sin conexión con el servidor' };
    } finally { clearTimeout(timer); }
    if (!res.ok) {
      let msg = 'Error ' + res.status;
      try { msg = (await res.json()).error || msg; } catch (e) { /* noop */ }
      if (res.status === 401 && msg === 'Error 401') msg = 'Sesión vencida: recarga la página y vuelve a entrar';
      return { ok: false, error: msg, status: res.status };
    }
    const data = await res.json();
    if (data && data.serverTime) DB.setClockOffset(Date.parse(data.serverTime) - (t0 + Date.now()) / 2);
    return { ok: true, data };
  }

  /**
   * Sincroniza contra el servidor. scope = { sellerId } para teléfonos
   * (solo baja sus propios pedidos) o {} para la oficina (todos).
   */
  async function syncNow(scope) {
    if (running) return running;
    running = (async () => {
      // Un reinicio que quedó a medias (se cerró la app) se termina primero
      const pending = await DB.getMeta('resetPending', null);
      if (pending) { await applyReset(pending.epoch, pending.resetAt, pending.keep); return { ...(await syncOnce(scope)), reset: true }; }
      const r = await syncOnce(scope);
      if (typeof r.resetTo !== 'string') return r;
      // La oficina reinició los datos del servidor: se borra la copia de este
      // equipo y se baja todo de nuevo
      await applyReset(r.resetTo, r.resetAt);
      return { ...(await syncOnce(scope)), reset: true };
    })();
    try { return await running; } finally { running = null; }
  }

  /**
   * Borra la copia local. Lo que este equipo hizo DESPUÉS del reinicio (sin
   * señal) y aún no subió se conserva y se sube: pedidos creados, clientes y
   * actividad posteriores a resetAt. Lo de antes (datos de prueba) se descarta.
   */
  async function applyReset(epoch, resetAt, saved) {
    const after = (t) => !!resetAt && String(t || '') > resetAt;
    const keep = saved || {
      orders: (await DB.getAll('orders')).filter((d) => d.dirty && after(d.createdAt)),
      clients: (await DB.getAll('clients')).filter((d) => d.dirty && after(d.updatedAt)),
      events: (await DB.getAll('events')).filter((d) => d.dirty && after(d.at)),
    };
    // Primero se anota qué se conserva: si la app se cierra a mitad, se retoma sin perderlo
    await DB.setMeta('resetPending', { epoch, resetAt: resetAt || '', keep });
    for (const k of KINDS) await DB.clear(k);
    for (const k of Object.keys(keep)) await DB.putMany(k, keep[k]);
    for (const m of await DB.getAll('meta')) {
      if (/^syncCursor/.test(m.key) || m.key === 'lastSyncAt' || m.key === 'notifs') await DB.remove('meta', m.key);
    }
    await DB.setMeta('epoch', epoch);
    await DB.remove('meta', 'resetPending');
  }

  async function syncOnce(scope) {
    if (!navigator.onLine) return { ok: false, offline: true };
    const cfg = await settings();
    if (!cfg.syncKey) return { ok: false, noKey: true, error: 'Falta la clave de sincronización (☰ → Conexión, o Ajustes en la oficina)' };
    const url = cfg.syncUrl || DEFAULT_SYNC_URL;
    const isAdmin = !!cfg.adminKey;
    const isSupervisor = !isAdmin && !!cfg.supervisorKey;
    const fullRead = isAdmin || isSupervisor; // el supervisor lee todo, pero jamás publica nada
    const sellerId = scope && scope.sellerId || null;
    const cursorKey = cursorKeyOf(scope);
    const since = await DB.getMeta(cursorKey, null);
    const push = await collectDirty(isAdmin, sellerId);

    const headers = { 'Content-Type': 'application/json' };
    if (cfg.syncKey) headers['x-sync-key'] = cfg.syncKey;
    if (cfg.adminKey) headers['x-admin-key'] = cfg.adminKey;
    if (cfg.supervisorKey) headers['x-supervisor-key'] = cfg.supervisorKey;

    // Vercel rechaza cuerpos de más de 4,5 MB en ambos sentidos: la subida va
    // por tandas y la bajada por páginas. El cursor avanza solo al terminar.
    const batches = splitPush(push);
    const base = { deviceId: await deviceId(), epoch: await DB.getMeta('epoch', ''), since, sinceDays: since ? null : INITIAL_ORDER_DAYS, sellerId };
    const empty = Object.fromEntries(KINDS.map((k) => [k, []]));
    const rejected = [];
    let first = null;
    let changed = 0;
    let dups = null;
    let page = null;
    for (let i = 0; ; i++) {
      const pushing = i < batches.length;
      const last = !pushing || i === batches.length - 1;
      const r = await post(url, headers, { ...base, push: pushing ? batches[i] : empty, noPull: !last, page });
      if (!r.ok) return r;
      if (typeof r.data.reset === 'string') return { ok: true, resetTo: r.data.reset, resetAt: r.data.resetAt || '' };
      if (pushing) {
        // 1) Lo aceptado por el servidor deja de estar pendiente
        for (const k of KINDS) {
          const ok = new Set((r.data.accepted && r.data.accepted[k]) || []);
          await clearDirty(k, batches[i][k].filter((d) => ok.has(d.id)));
        }
        rejected.push(...(r.data.rejected || []));
      }
      if (!last) continue;
      // 2) Bajar cambios remotos (una página)
      first = first || r.data;
      for (const k of ['config', 'products', 'sellers', 'clients', 'loads', 'orders', 'events']) {
        changed += await mergeRemote(k, (r.data.pull && r.data.pull[k]) || [], fullRead);
      }
      if (!r.data.more) { dups = r.data.dups; break; }
      page = r.data.page;
    }

    // 3) Lo rechazado vuelve con la versión del servidor (ya despachado, o
    //    el servidor tiene una edición más reciente)
    const back = rejected.filter((r) => r.doc && KINDS.includes(r.kind));
    for (const r of back) {
      // Otro equipo escribió justo antes: lo mío que siga siendo más nuevo se vuelve a subir
      const l = r.reason === 'stale' && (r.kind === 'orders' || r.kind === 'loads') ? await DB.get(r.kind, r.id) : null;
      const frozen = r.kind === 'orders' && isLocked(r.doc) && !isAdmin;
      if (l && l.dirty && !frozen && !l.partial && !r.doc.partial) {
        const m = DB.mergeFields(r.doc, l, r.kind);
        if (m.fromB) { await DB.put(r.kind, { ...m.doc, updatedAt: DB.after(r.doc.updatedAt, l.updatedAt), dirty: true }); continue; }
      }
      await DB.put(r.kind, { ...r.doc, dirty: false });
    }
    const rejectedOrders = back.filter((r) => r.kind === 'orders');

    // 4) Alertas de cliente duplicado: solo en este equipo, sin tocar la versión del pedido
    if (dups && dups.map) changed += await applyDups(dups, sellerId);

    // El cursor es la hora de la PRIMERA página: nada escrito durante la bajada se pierde
    await DB.setMeta(cursorKey, first.serverTime);
    await DB.setMeta('lastSyncAt', new Date().toISOString());
    return {
      ok: true,
      pushed: total(push),
      pulled: changed,
      rejected: rejectedOrders.length,
      reverted: back.length,
    };
  }

  // Un marcador por perfil: si en el mismo teléfono entra otro vendedor (u
  // Oficina), baja completo lo suyo en vez de continuar el marcador del anterior.
  // v2: con la versión que trae las hojas de carga al vendedor y 60 días de
  // historial, cada equipo hace UNA descarga completa (el cursor anterior no las incluía)
  const cursorKeyOf = (scope) => 'syncCursor2:' + (scope && scope.sellerId ? scope.sellerId : 'all');
  async function hasCursor(scope) { return !!(await DB.getMeta(cursorKeyOf(scope), null)); }

  async function applyDups(dups, sellerId) {
    const orders = await DB.getAll('orders');
    const toPut = [];
    orders.forEach((o) => {
      if (!o.routeDate || o.routeDate < dups.from || (sellerId && o.sellerId !== sellerId)) return;
      const next = (dups.map[o.id] || []).filter(Boolean);
      if (JSON.stringify(next) !== JSON.stringify(o.dupWith || [])) toPut.push({ ...o, dupWith: next });
    });
    await DB.putMany('orders', toPut);
    return toPut.length;
  }

  async function pendingCount(scope) {
    const cfg = await settings();
    return total(await collectDirty(!!cfg.adminKey, scope && scope.sellerId || null));
  }

  /** Llamada a una ruta de oficina (/api/pedidos/<name>) con las claves guardadas. */
  async function adminCall(name, body) {
    if (!navigator.onLine) return { ok: false, error: 'Sin internet' };
    const cfg = await settings();
    if (!cfg.adminKey) return { ok: false, error: 'Falta la clave admin en Ajustes' };
    const headers = { 'Content-Type': 'application/json', 'x-admin-key': cfg.adminKey };
    if (cfg.syncKey) headers['x-sync-key'] = cfg.syncKey;
    return post((cfg.syncUrl || DEFAULT_SYNC_URL).replace(/\/sync$/, '/' + name), headers, body || {});
  }

  /** Llamada de solo lectura: sirve con la clave admin o con la de supervisor. */
  async function readerCall(name, body) {
    if (!navigator.onLine) return { ok: false, error: 'Sin internet' };
    const cfg = await settings();
    if (!cfg.adminKey && !cfg.supervisorKey) return { ok: false, error: 'Falta la clave de acceso' };
    const headers = { 'Content-Type': 'application/json' };
    if (cfg.syncKey) headers['x-sync-key'] = cfg.syncKey;
    if (cfg.adminKey) headers['x-admin-key'] = cfg.adminKey;
    if (cfg.supervisorKey) headers['x-supervisor-key'] = cfg.supervisorKey;
    return post((cfg.syncUrl || DEFAULT_SYNC_URL).replace(/\/sync$/, '/' + name), headers, body || {});
  }
  /** Suscripción a avisos push (/api/pedidos/push). La oficina se identifica con su clave admin. */
  async function pushCall(body, asOffice) {
    const cfg = await settings();
    if (!cfg.syncKey) return { ok: false, error: 'Falta la clave de sincronización' };
    const headers = { 'Content-Type': 'application/json', 'x-sync-key': cfg.syncKey };
    if (asOffice) {
      if (!cfg.adminKey) return { ok: false, error: 'Falta la clave admin en Ajustes' };
      headers['x-admin-key'] = cfg.adminKey;
    }
    return post((cfg.syncUrl || DEFAULT_SYNC_URL).replace(/\/sync$/, '/push'), headers, body);
  }

  /** Reporte de ventas del servidor para un rango de fechas (sin límite de historial local). */
  const report = (from, to) => readerCall('report', { from, to });

  /** Respaldo completo del servidor, en el formato del paquete de arranque (se restaura con "Cargar paquete"). */
  async function serverBackup(onProgress) {
    const bundle = { format: 'distribuidora-pedidos/v1', kind: 'respaldo-servidor', exportedAt: new Date().toISOString(), deviceId: await deviceId() };
    KINDS.forEach((k) => { bundle[k] = []; });
    let after = null, n = 0;
    for (;;) {
      const r = await adminCall('backup', { after });
      if (!r.ok) return r;
      r.data.docs.forEach(({ kind, doc }) => { (bundle[kind] = bundle[kind] || []).push(doc); });
      n += r.data.docs.length;
      if (onProgress) onProgress(n);
      if (!r.data.next) { bundle.counters = r.data.counters || {}; break; }
      after = r.data.next;
    }
    return { ok: true, bundle, count: n };
  }

  /** Reserva números de carga y de notas en el servidor (solo oficina, con internet). */
  async function reserveNumbers(need, floor) {
    if (!navigator.onLine) return { ok: false, error: 'Sin internet' };
    const cfg = await settings();
    if (!cfg.adminKey) return { ok: false, error: 'Falta la clave admin en Ajustes' };
    const headers = { 'Content-Type': 'application/json', 'x-admin-key': cfg.adminKey };
    if (cfg.syncKey) headers['x-sync-key'] = cfg.syncKey;
    const url = (cfg.syncUrl || DEFAULT_SYNC_URL).replace(/\/sync$/, '/numbers');
    const r = await post(url, headers, { load: need.load, note: need.note, floor: { load: +floor.load || 0, note: +floor.note || 0 }, epoch: await DB.getMeta('epoch', '') });
    if (!r.ok) return r;
    return { ok: true, load: r.data.load, notes: r.data.notes || [] };
  }

  /* ---------------- Canal 2: paquete de archivo ---------------- */

  /** Paquete con los pedidos de un vendedor (o todo, si es la oficina). */
  async function exportBundle(opts) {
    const all = await DB.getAll('orders');
    const orders = all.filter((o) =>
      (!opts.sellerId || o.sellerId === opts.sellerId) &&
      (!opts.routeDate || o.routeDate === opts.routeDate));
    const bundle = {
      format: 'distribuidora-pedidos/v1',
      exportedAt: new Date().toISOString(),
      deviceId: await deviceId(),
      orders: orders.map((o) => { const c = { ...o }; delete c.dirty; return c; }),
    };
    const strip = (d) => { const c = { ...d }; delete c.dirty; return c; };
    if (opts.includeCatalog) {
      for (const k of ['products', 'sellers', 'config']) bundle[k] = (await DB.getAll(k)).map(strip);
      const clients = await DB.getAll('clients');
      bundle.clients = clients.filter((c) => !opts.clientsOf || c.sellerId === opts.clientsOf).map(strip);
    }
    if (opts.includeLoads) bundle.loads = (await DB.getAll('loads')).map(strip);
    // Clientes nuevos creados en la calle viajan con los pedidos del vendedor
    if (opts.sellerId && !opts.includeCatalog) {
      bundle.clients = (await DB.getAll('clients')).filter((c) => c.sellerId === opts.sellerId && c.source === 'campo').map(strip);
    }
    return bundle;
  }

  /**
   * @param {boolean} fromOffice  true en la oficina: todo lo importado queda
   *        pendiente de subir (se publica al servidor con la clave admin).
   */
  async function importBundle(bundle, fromOffice) {
    const isAdmin = !!fromOffice;
    if (!bundle || bundle.format !== 'distribuidora-pedidos/v1') {
      throw new Error('Archivo no reconocido (formato inválido)');
    }
    let n = 0;
    for (const k of ['config', 'products', 'sellers', 'loads']) n += await mergeRemote(k, bundle[k] || [], isAdmin, isAdmin, true);
    // markDirty: si este equipo también sincroniza con servidor, los pedidos y
    // clientes recibidos por archivo se reenvían en el próximo sync.
    n += await mergeRemote('clients', bundle.clients || [], isAdmin, isAdmin, true);
    n += await mergeRemote('orders', bundle.orders || [], isAdmin, true, true);
    return n;
  }

  global.Sync = { KINDS, isLocked, syncNow, pendingCount, hasCursor, reserveNumbers, adminCall, readerCall, report, pushCall, serverBackup, exportBundle, importBundle, deviceId, DEFAULT_SYNC_URL };
})(window);
