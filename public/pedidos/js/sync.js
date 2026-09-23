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
  const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config'];
  // Solo la oficina (clave admin) publica estos tipos
  const ADMIN_KINDS = ['products', 'sellers', 'loads', 'config'];
  // Un pedido bloqueado (hoja aprobada/cerrada) ya no lo puede pisar el teléfono
  const isLocked = (o) => !!o && (o.locked === true || o.status === 'despachado');
  const INITIAL_ORDER_DAYS = 14; // historial que baja un teléfono nuevo
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

  /** Fusiona documentos remotos en el store local. Devuelve cuántos cambió. */
  async function mergeRemote(store, remoteDocs, isAdmin, markDirty) {
    if (!remoteDocs || !remoteDocs.length) return 0;
    const locals = await DB.getAll(store);
    const byId = new Map(locals.map((d) => [d.id, d]));
    const toPut = [];
    remoteDocs.forEach((r) => {
      const l = byId.get(r.id);
      if (l && l.dirty) {
        if (store === 'orders') {
          const frozen = isLocked(r) && !isAdmin;
          if (!frozen && newer(l, r)) return; // mi cambio local es más reciente
        } else if ((isAdmin || store === 'clients') && newer(l, r)) {
          return; // la oficina editó después: se subirá en el próximo push
        }
      }
      if (l && !l.dirty && l.updatedAt === r.updatedAt) return; // idéntico
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

  async function collectDirty(isAdmin) {
    const strip = (d) => { const c = { ...d }; delete c.dirty; return c; };
    const out = {};
    for (const k of KINDS) {
      out[k] = (!isAdmin && ADMIN_KINDS.includes(k)) ? [] : (await DB.getAll(k)).filter((d) => d.dirty).map(strip);
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
    return { ok: true, data: await res.json() };
  }

  /**
   * Sincroniza contra el servidor. scope = { sellerId } para teléfonos
   * (solo baja sus propios pedidos) o {} para la oficina (todos).
   */
  async function syncNow(scope) {
    if (running) return running;
    running = (async () => {
      if (!navigator.onLine) return { ok: false, offline: true };
      const cfg = await settings();
      const url = cfg.syncUrl || DEFAULT_SYNC_URL;
      const isAdmin = !!cfg.adminKey;
      const since = await DB.getMeta('syncCursor', null);
      const push = await collectDirty(isAdmin);

      const headers = { 'Content-Type': 'application/json' };
      if (cfg.syncKey) headers['x-sync-key'] = cfg.syncKey;
      if (cfg.adminKey) headers['x-admin-key'] = cfg.adminKey;

      // Vercel rechaza cuerpos de más de 4,5 MB: la subida va por tandas y solo
      // la última trae la bajada (así el cursor avanza una sola vez).
      const batches = splitPush(push);
      const base = { deviceId: await deviceId(), since, sinceDays: since ? null : INITIAL_ORDER_DAYS, sellerId: scope && scope.sellerId || null };
      let data = null;
      const rejected = [];
      for (let i = 0; i < batches.length; i++) {
        const last = i === batches.length - 1;
        const r = await post(url, headers, { ...base, push: batches[i], noPull: !last });
        if (!r.ok) return r;
        // 1) Lo aceptado por el servidor deja de estar pendiente
        for (const k of KINDS) {
          const ok = new Set((r.data.accepted && r.data.accepted[k]) || []);
          await clearDirty(k, batches[i][k].filter((d) => ok.has(d.id)));
        }
        rejected.push(...(r.data.rejected || []));
        if (last) data = r.data;
      }

      // 2) Lo rechazado vuelve con la versión del servidor (ya despachado, o
      //    el servidor tiene una edición más reciente)
      const back = rejected.filter((r) => r.doc && KINDS.includes(r.kind));
      for (const r of back) await DB.put(r.kind, { ...r.doc, dirty: false });
      const rejectedOrders = back.filter((r) => r.kind === 'orders');

      // 3) Bajar cambios remotos
      let changed = 0;
      for (const k of ['config', 'products', 'sellers', 'clients', 'loads', 'orders']) {
        changed += await mergeRemote(k, data.pull[k] || [], isAdmin);
      }

      await DB.setMeta('syncCursor', data.serverTime);
      await DB.setMeta('lastSyncAt', new Date().toISOString());
      return {
        ok: true,
        pushed: total(push),
        pulled: changed,
        rejected: rejectedOrders.length,
      };
    })();
    try { return await running; } finally { running = null; }
  }

  async function pendingCount() {
    const cfg = await settings();
    return total(await collectDirty(!!cfg.adminKey));
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
    for (const k of ['config', 'products', 'sellers', 'loads']) n += await mergeRemote(k, bundle[k] || [], false, isAdmin);
    // markDirty: si este equipo también sincroniza con servidor, los pedidos y
    // clientes recibidos por archivo se reenvían en el próximo sync.
    n += await mergeRemote('clients', bundle.clients || [], isAdmin, isAdmin);
    n += await mergeRemote('orders', bundle.orders || [], isAdmin, true);
    return n;
  }

  global.Sync = { KINDS, isLocked, syncNow, pendingCount, exportBundle, importBundle, deviceId, DEFAULT_SYNC_URL };
})(window);
