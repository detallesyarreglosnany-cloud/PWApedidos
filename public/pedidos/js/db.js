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
  const DB_VERSION = 2;
  // Stores sincronizables (mismo nombre que "kind" en el servidor)
  const STORES = ['products', 'sellers', 'orders', 'clients', 'loads', 'config'];
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
      };
      req.onsuccess = () => resolve(req.result);
      // Safari en modo privado / cuota bloqueada → localStorage
      req.onerror = () => { useFallback = true; resolve(null); };
      req.onblocked = () => { useFallback = true; resolve(null); };
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
    uid, now, touch, setClockOffset, requestPersistence,
    get isFallback() { return useFallback; },
  };
})(window);
