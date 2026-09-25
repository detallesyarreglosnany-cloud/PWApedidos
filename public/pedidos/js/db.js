/* =========================================================================
 * db.js — Capa de persistencia offline-first (IndexedDB + fallback)
 *
 * Stores (todas con keyPath "id", salvo meta):
 *   products : catálogo maestro (lo edita la oficina)
 *   sellers  : vendedores con sus rutas (lo edita la oficina)
 *   clients  : cartera de clientes asignada a cada vendedor
 *   orders   : un pedido = 1 vendedor + 1 cliente + 1 fecha de ruta
 *   loads    : hojas de carga (máx. N bultos / N clientes) y su archivo
 *   config   : doc único "main": empresa, rutas, despachadores, límites, tasa
 *   events   : historial de actividad (quién, cuándo, qué); solo se agrega
 *   meta     : { key, value } → ajustes locales, deviceId, cursor, sesión
 *
 * Cada documento sincronizable lleva:
 *   updatedAt (ISO, reloj del dispositivo) → resolución last-write-wins
 *   deleted   (tombstone, nunca se borra físicamente antes de sincronizar)
 *   dirty     (true = cambio local pendiente de subir al servidor)
 * ========================================================================= */
(function (global) {
  'use strict';

  const DB_NAME = 'distribuidora-pedidos';
  const DB_VERSION = 3;
  // Stores sincronizables (mismo nombre que "kind" en el servidor)
  const STORES = ['products', 'sellers', 'orders', 'clients', 'loads', 'config', 'events'];
  const LS_PREFIX = 'dp:';

  let dbPromise = null;
  let useFallback = false;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve) => {
      if (!('indexedDB' in global)) { useFallback = true; return resolve(null); }
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VERSION); }
      catch (e) { useFallback = true; return resolve(null); }

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('products')) {
          const s = db.createObjectStore('products', { keyPath: 'id' });
          s.createIndex('code', 'code', { unique: false });
          s.createIndex('category', 'category', { unique: false });
        }
        if (!db.objectStoreNames.contains('sellers')) {
          db.createObjectStore('sellers', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('orders')) {
          const s = db.createObjectStore('orders', { keyPath: 'id' });
          s.createIndex('seller_date', ['sellerId', 'routeDate'], { unique: false });
          s.createIndex('routeDate', 'routeDate', { unique: false });
        }
        // v2: clientes por vendedor, hojas de carga y configuración compartida
        if (!db.objectStoreNames.contains('clients')) {
          const s = db.createObjectStore('clients', { keyPath: 'id' });
          s.createIndex('sellerId', 'sellerId', { unique: false });
        }
        if (!db.objectStoreNames.contains('loads')) {
          const s = db.createObjectStore('loads', { keyPath: 'id' });
          s.createIndex('status', 'status', { unique: false });
        }
        if (!db.objectStoreNames.contains('config')) {
          db.createObjectStore('config', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
        // v3: historial de actividad
        if (!db.objectStoreNames.contains('events')) {
          const s = db.createObjectStore('events', { keyPath: 'id' });
          s.createIndex('day', 'day', { unique: false });
        }
      };
      let settled = false;
      const finish = (v) => { if (settled) return; settled = true; clearTimeout(blockedTimer); resolve(v); };
      req.onsuccess = () => {
        const db = req.result;
        // Si otra pestaña abre una versión nueva, esta suelta la base y se recarga
        db.onversionchange = () => { db.close(); location.reload(); };
        finish(db);
      };
      // Safari en modo privado / cuota bloqueada → localStorage
      req.onerror = () => { useFallback = true; finish(null); };
      // Otra pestaña con la versión anterior sigue abierta: normalmente se cierra
      // sola (ve onversionchange) y esto sigue en 1-2 s. Si no (pestaña vieja sin
      // ese código, o colgada), no se deja la app esperando para siempre: pasa a
      // localStorage para no bloquear el login ni la sincronización.
      const blockedTimer = setTimeout(() => { useFallback = true; finish(null); }, 4000);
      req.onblocked = () => console.warn('Base local ocupada por otra pestaña: esperando');
    });
    return dbPromise;
  }

  /* ---------- Fallback localStorage (misma API, JSON por store) ---------- */
  const ls = {
    read(store) {
      try { return JSON.parse(localStorage.getItem(LS_PREFIX + store) || '{}'); }
      catch (e) { return {}; }
    },
    write(store, obj) {
      try { localStorage.setItem(LS_PREFIX + store, JSON.stringify(obj)); }
      catch (e) { console.error('localStorage lleno o bloqueado', e); throw e; }
    },
  };

  function tx(db, store, mode) {
    return db.transaction(store, mode).objectStore(store);
  }
  function reqP(r) {
    return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  }

  async function getAll(store) {
    const db = await open();
    if (useFallback || !db) return Object.values(ls.read(store));
    return reqP(tx(db, store, 'readonly').getAll());
  }

  async function get(store, id) {
    const db = await open();
    if (useFallback || !db) return ls.read(store)[id];
    return reqP(tx(db, store, 'readonly').get(id));
  }

  async function putMany(store, docs) {
    if (!docs.length) return;
    const db = await open();
    const keyPath = store === 'meta' ? 'key' : 'id';
    if (useFallback || !db) {
      const all = ls.read(store);
      docs.forEach((d) => { all[d[keyPath]] = d; });
      ls.write(store, all);
      return;
    }
    await new Promise((res, rej) => {
      const t = db.transaction(store, 'readwrite');
      const s = t.objectStore(store);
      docs.forEach((d) => s.put(d));
      t.oncomplete = res;
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  }

  async function put(store, doc) { return putMany(store, [doc]); }

  async function remove(store, id) {
    const db = await open();
    if (useFallback || !db) {
      const all = ls.read(store); delete all[id]; ls.write(store, all); return;
    }
    return reqP(tx(db, store, 'readwrite').delete(id));
  }

  async function clear(store) {
    const db = await open();
    if (useFallback || !db) { ls.write(store, {}); return; }
    return reqP(tx(db, store, 'readwrite').clear());
  }

  async function getMeta(key, fallback) {
    const row = await get('meta', key);
    return row === undefined ? fallback : row.value;
  }
  async function setMeta(key, value) { return put('meta', { key, value }); }

  /* ---------- Helpers de dominio ---------- */
  function uid(prefix) {
    const rnd = (global.crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
    return (prefix ? prefix + '_' : '') + rnd;
  }
  // Diferencia con el reloj del servidor (se mide en cada sincronización): un
  // teléfono con la hora mal puesta no pierde ni pisa ediciones de otros.
  let clockOffset = 0;
  try { clockOffset = +localStorage.getItem('pvClockOffset') || 0; } catch (e) { /* sin storage */ }
  function setClockOffset(ms) {
    if (!Number.isFinite(ms) || Math.abs(ms) > 7 * 86400000) return;
    clockOffset = Math.round(ms);
    try { localStorage.setItem('pvClockOffset', String(clockOffset)); } catch (e) { /* sin storage */ }
  }
  function now() { return new Date(Date.now() + clockOffset).toISOString(); }

  /** Marca un documento como modificado localmente (pendiente de sync). */
  function touch(doc) {
    const t = now();
    // Una edición siempre es posterior a la versión que se editó
    doc.updatedAt = doc.updatedAt && doc.updatedAt >= t ? new Date(Date.parse(doc.updatedAt) + 1).toISOString() : t;
    doc.dirty = true;
    return doc;
  }

  /* ---- Versión por campo (pedidos y hojas de carga) ----
   * Cada campo guarda la hora de su último cambio (doc.fv). Si dos equipos
   * editan el mismo pedido u hoja antes de sincronizarse, se combinan campo por
   * campo: gana el cambio más reciente de CADA campo, no el documento entero.
   * Espejo de mergeFields en src/app/api/pedidos/sync/route.ts. */
  const FV_SKIP = new Set(['id', 'updatedAt', 'fv', 'dirty', 'dupWith', 'partial']);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const keysOf = (a, b) => new Set(Object.keys(a).concat(Object.keys(b)));
  // Documento sin fv (anterior a esta versión): todos sus campos valen con su updatedAt
  function fvFull(d) {
    if (!d) return {};
    if (d.fv && typeof d.fv === 'object') return d.fv;
    const fv = {};
    Object.keys(d).forEach((k) => { if (!FV_SKIP.has(k)) fv[k] = String(d.updatedAt || ''); });
    return fv;
  }
  const fvOf = (d, k) => (typeof fvFull(d)[k] === 'string' ? fvFull(d)[k] : '');
  function fvUnion(...docs) {
    const fv = {};
    docs.forEach((d) => Object.entries(fvFull(d)).forEach(([k, t]) => { if (typeof t === 'string' && t > (fv[k] || '')) fv[k] = t; }));
    return fv;
  }

  /**
   * Marca con la hora de doc.updatedAt los campos que cambiaron respecto de la
   * versión guardada. skip: campos que este equipo no controla (no se marcan).
   */
  function stampFields(prev, doc, skip) {
    const fv = prev ? fvUnion(prev, doc.fv ? doc : null) : fvUnion(doc.fv ? doc : null);
    if (prev) keysOf(prev, doc).forEach((k) => { if (!FV_SKIP.has(k) && !(skip && skip.includes(k)) && !same(prev[k], doc[k])) fv[k] = doc.updatedAt; });
    doc.fv = fv;
    return doc;
  }

  // Campos que cambian juntos: se toman todos del mismo lado (nunca "enviado"
  // de un lado con la hoja del otro). Los del pedido los decide la oficina: el
  // teléfono del vendedor no los marca, así nunca le ganan a la oficina.
  const GROUPS = {
    orders: ['status', 'loadId', 'locked', 'loadStatusName', 'noteNumber', 'loadNumber', 'dispatchedAt', 'heldAt'],
    loads: ['status', 'statusHistory', 'number', 'closedAt', 'approvedAt', 'totals', 'firstNote', 'lastNote'],
  };

  /**
   * Combina dos versiones del mismo documento (kind: 'orders' | 'loads').
   * fromA / fromB: el resultado trae algo de a que b no tenía / algo de b que a no tenía.
   */
  function mergeFields(a, b, kind) {
    const aWins = String(a.updatedAt || '') >= String(b.updatedAt || '');
    const w = aWins ? a : b, lo = aWins ? b : a;
    const doc = { ...w };
    const take = (src, k) => { if (k in src) doc[k] = src[k]; else delete doc[k]; };
    const group = GROUPS[kind] || [];
    const stamp = (d) => group.reduce((m, k) => (fvOf(d, k) > m ? fvOf(d, k) : m), '');
    if (stamp(lo) > stamp(w)) group.forEach((k) => take(lo, k));
    keysOf(a, b).forEach((k) => {
      if (FV_SKIP.has(k) || group.includes(k) || !(fvOf(lo, k) > fvOf(w, k))) return;
      take(lo, k);
    });
    doc.fv = fvUnion(lo, w);
    const differs = (x) => [...keysOf(doc, x)].some((k) => !FV_SKIP.has(k) && !same(doc[k], x[k]));
    return { doc, fromA: differs(b), fromB: differs(a) };
  }
  /** Una hora estrictamente posterior a todas las dadas (para que la versión combinada gane). */
  function after(...ts) {
    const max = ts.map((t) => String(t || '')).sort().pop();
    const t = now();
    return t > max ? t : new Date(Date.parse(max) + 1).toISOString();
  }

  /** Pide al navegador que no purgue el almacenamiento (crítico en móviles). */
  async function requestPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) {
        return await navigator.storage.persist();
      }
    } catch (e) { /* no soportado */ }
    return false;
  }

  global.DB = {
    STORES, open, getAll, get, put, putMany, remove, getMeta, setMeta,
    uid, now, touch, setClockOffset, requestPersistence, clear, stampFields, mergeFields, after, FV_GROUPS: GROUPS,
    get isFallback() { return useFallback; },
  };
})(window);
