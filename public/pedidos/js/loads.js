/* =========================================================================
 * loads.js — Hojas de carga (lógica pura: recibe datos, devuelve cambios)
 *
 * Estados de la hoja: configurables en Oficina → Ajustes. Cada estado dice:
 *   locked  → los pedidos de la hoja ya NO se pueden editar (vendedor ni oficina)
 *   closing → "cierre de carga": numera notas de entrega, descuenta inventario,
 *             fija la fecha de la carga y la pasa al Archivo
 * Por defecto:
 *   Esperando aprobación (editable) → Aprobada para carga (bloqueada)
 *   → Carga cerrada (cierra) → Despachada (cierra)
 *
 * Ciclo del pedido:
 *   abierto ─(vendedor envía)→ enviado ─(armado automático)→ en_carga
 *   en_carga ─(oficina: espera)→ en_espera ─(reincorporar)→ enviado
 *   en_carga + hoja en estado "closing" → despachado (+ Nº de nota)
 * Mientras la hoja esté en un estado NO bloqueado, vendedor y oficina pueden
 * editar el pedido (con o sin señal).
 *
 * Una hoja agrupa pedidos de uno o varios vendedores (hojas fusionadas) y una
 * ruta, hasta config.load.limit bultos o config.load.maxClients clientes.
 * ========================================================================= */
(function (global) {
  'use strict';

  const DEFAULT_STATUSES = [
    { id: 'espera', name: 'Esperando aprobación', locked: false, closing: false },
    { id: 'aprobada_carga', name: 'Aprobada para carga', locked: true, closing: false },
    { id: 'cerrada', name: 'Carga cerrada', locked: true, closing: true },
    { id: 'despachada', name: 'Despachada', locked: true, closing: true },
  ];
  const ORDER_LABEL = {
    abierto: 'Abierto', enviado: 'Enviado', en_carga: 'En hoja de carga',
    en_espera: 'Carga en espera', despachado: 'Despachado',
  };
  const MESES = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];

  function statuses(cfg) {
    const s = cfg && Array.isArray(cfg.loadStatuses) && cfg.loadStatuses.length ? cfg.loadStatuses : DEFAULT_STATUSES;
    return s;
  }
  /** Estado actual de una hoja (compatible con hojas de versiones anteriores). */
  function statusOf(load, cfg) {
    const list = statuses(cfg);
    let st = list.find((x) => x.id === load.status);
    if (!st) {
      const closed = load.closedAt || load.status === 'aprobada';
      st = closed ? (list.find((x) => x.closing) || list[list.length - 1]) : (list.find((x) => !x.locked) || list[0]);
    }
    return st;
  }
  const isOpen = (load, cfg) => !load.deleted && !statusOf(load, cfg).locked;
  const isClosed = (load) => !!(load.closedAt || load.status === 'aprobada');

  function limits(cfg) {
    const l = (cfg && cfg.load) || {};
    return { limit: +l.limit || 900, maxClients: +l.maxClients || 32, measure: l.measure === 'unidades' ? 'unidades' : 'bultos' };
  }
  function measure(order, cfg) {
    const t = Matrix.orderTotals(order);
    return limits(cfg).measure === 'unidades' ? t.totalUnidades : t.bultos;
  }
  function loadOrders(load, ordersById) {
    return (load.orderIds || []).map((id) => ordersById.get(id)).filter((o) => o && !o.deleted);
  }
  function usage(load, ordersById, cfg) {
    const L = limits(cfg);
    const os = loadOrders(load, ordersById);
    const used = os.reduce((a, o) => a + measure(o, cfg), 0);
    return {
      used, clients: os.length, limit: L.limit, maxClients: L.maxClients, measure: L.measure,
      pct: Math.min(100, Math.round((used / L.limit) * 100)),
      pctClients: Math.min(100, Math.round((os.length / L.maxClients) * 100)),
      full: used >= L.limit || os.length >= L.maxClients,
      over: used > L.limit || os.length > L.maxClients,
    };
  }

  /** "Luis R." → "L.R." (iniciales sobre cada cliente, como en la hoja de almacén). */
  function initials(name) {
    return String(name || '').replace(/\./g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase() + '.').join('');
  }
  const sellerIdsOf = (load) => (load.sellerIds && load.sellerIds.length ? load.sellerIds : [load.sellerId]).filter(Boolean);

  /** Código tipo "SEP16-BARR" (fecha de la carga + ruta). */
  function autoLabel(load) {
    const d = String(load.date || load.createdAt || '').slice(0, 10);
    const [, m, day] = d.split('-');
    const route = String(load.route || 'GEN').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z ]/g, '')
      .split(' ').filter(Boolean).map((w, i, a) => (a.length > 1 ? w.slice(0, 2) : w.slice(0, 4))).join('');
    return (MESES[(+m || 1) - 1] || '') + (day || '') + '-' + route;
  }
  function labelOf(load) { return load.label || autoLabel(load); }

  /** Rango de fechas de los pedidos de la hoja: "14-16SEP" o "30AGO-02SEP". */
  function orderDateRange(orders) {
    const ds = orders.map((o) => o.routeDate).filter(Boolean).sort();
    if (!ds.length) return '';
    const f = (d) => { const [, m, day] = d.split('-'); return { day, mon: MESES[+m - 1] }; };
    const a = f(ds[0]), b = f(ds[ds.length - 1]);
    if (ds[0] === ds[ds.length - 1]) return a.day + a.mon;
    return a.mon === b.mon ? `${a.day}-${b.day}${a.mon}` : `${a.day}${a.mon}-${b.day}${b.mon}`;
  }

  function routeOf(order, sellersById) {
    if (order.route) return order.route;
    const s = sellersById.get(order.sellerId);
    return (s && s.routes && s.routes[0]) || '';
  }

  function newLoad(sellerId, sellerName, route, cfg) {
    const list = statuses(cfg);
    return {
      id: DB.uid('l'), status: (list.find((x) => !x.locked) || list[0]).id, number: null, label: '',
      sellerId, sellerIds: [sellerId], sellerName, route, dispatcherId: '', dispatcherName: '',
      date: '', orderIds: [], createdAt: DB.now(), closedAt: null, notes: '', deleted: false,
    };
  }

  /**
   * Armado automático: cada pedido "enviado" entra en la primera hoja abierta
   * (estado editable) de su vendedor y ruta donde quepa; si no, hoja nueva.
   */
  function autoPack(state) {
    const { orders, loads, sellers, config } = state;
    const L = limits(config);
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    const sellersById = new Map(sellers.map((s) => [s.id, s]));
    const changedLoads = new Map(), changedOrders = [];
    const queue = orders
      .filter((o) => !o.deleted && o.status === 'enviado' && !o.loadId && Matrix.orderTotals(o).items > 0)
      .sort((a, b) => String(a.sentAt || a.updatedAt).localeCompare(String(b.sentAt || b.updatedAt)));
    if (!queue.length) return { loads: [], orders: [] };
    const open = loads.filter((l) => isOpen(l, config) && !isClosed(l))
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    // Un pedido que ya figura en una hoja no se vuelve a ubicar (evita duplicados)
    const placed = new Map();
    loads.filter((l) => !l.deleted).forEach((l) => (l.orderIds || []).forEach((id) => placed.set(id, l)));
    queue.forEach((o) => {
      const already = placed.get(o.id);
      if (already) {
        const fix = { ...o, loadId: already.id, status: isClosed(already) ? 'despachado' : 'en_carga', locked: statusOf(already, config).locked, loadStatusName: statusOf(already, config).name };
        ordersById.set(o.id, fix); changedOrders.push(fix); return;
      }
      const route = routeOf(o, sellersById);
      const m = measure(o, config);
      let target = open.find((l) => {
        if (!sellerIdsOf(l).includes(o.sellerId) || (l.route || '') !== route) return false;
        const u = usage(l, ordersById, config);
        return u.clients === 0 || (u.clients < L.maxClients && u.used + m <= L.limit);
      });
      if (!target) {
        const s = sellersById.get(o.sellerId);
        target = newLoad(o.sellerId, s ? s.name : o.sellerName, route, config);
        open.push(target);
      }
      target.orderIds = (target.orderIds || []).concat(o.id);
      changedLoads.set(target.id, target);
      const upd = { ...o, loadId: target.id, status: 'en_carga', route, locked: false, loadStatusName: statusOf(target, config).name };
      ordersById.set(o.id, upd);
      changedOrders.push(upd);
    });
    return { loads: [...changedLoads.values()], orders: changedOrders };
  }

  /** Sacar un cliente de la hoja: su pedido queda en cola ("Carga en espera"). */
  function hold(load, order) {
    return {
      load: { ...load, orderIds: (load.orderIds || []).filter((id) => id !== order.id) },
      order: { ...order, loadId: null, status: 'en_espera', locked: false, loadStatusName: '', heldAt: DB.now() },
    };
  }
  function release(order) {
    return { ...order, status: 'enviado', loadId: null, locked: false, sentAt: order.sentAt || DB.now() };
  }

  /** Mover un cliente de una hoja a otra (target null = hoja nueva). */
  function moveOrder(order, from, target, state) {
    const sellersById = new Map(state.sellers.map((s) => [s.id, s]));
    const out = { loads: [] };
    if (from) out.loads.push({ ...from, orderIds: from.orderIds.filter((id) => id !== order.id) });
    let t = target;
    if (!t) { const s = sellersById.get(order.sellerId); t = newLoad(order.sellerId, s ? s.name : order.sellerName, order.route || (from && from.route) || '', state.config); }
    t = withSellers({ ...t, orderIds: (t.orderIds || []).filter((id) => id !== order.id).concat(order.id) }, [order], state);
    out.loads.push(t);
    out.order = { ...order, loadId: t.id, status: 'en_carga', locked: false, loadStatusName: statusOf(t, state.config).name };
    return out;
  }

  /** Fusionar: los clientes de "source" pasan al final de "target" (hoja de 2+ vendedores). */
  function merge(target, source, state) {
    const ordersById = new Map(state.orders.map((o) => [o.id, o]));
    const moved = loadOrders(source, ordersById);
    const t = withSellers({ ...target, orderIds: (target.orderIds || []).concat(moved.map((o) => o.id)) }, moved, state);
    return {
      target: t, source: { ...source, orderIds: [], deleted: true },
      orders: moved.map((o) => ({ ...o, loadId: t.id, loadStatusName: statusOf(t, state.config).name })),
    };
  }
  function withSellers(load, orders, state) {
    const ids = [...new Set(sellerIdsOf(load).concat(orders.map((o) => o.sellerId)))];
    const names = ids.map((id) => { const s = state.sellers.find((x) => x.id === id); return s ? s.name : ''; }).filter(Boolean);
    return { ...load, sellerId: ids[0], sellerIds: ids, sellerName: names.join(' + ') };
  }

  /**
   * Cambiar el estado de la hoja. Aplica efectos una sola vez:
   *  - primer estado bloqueado → número de carga
   *  - primer estado de cierre → notas de entrega, inventario, fecha, archivo
   *  - volver a un estado sin cierre → reabre y devuelve el inventario
   */
  function setStatus(load, statusId, state, opts) {
    opts = opts || {};
    const { orders, products, config } = state;
    const st = statuses(config).find((x) => x.id === statusId);
    if (!st) throw new Error('Estado no válido');
    const ordersById = new Map(orders.map((o) => [o.id, o]));
    const os = loadOrders(load, ordersById);
    const cfg = { ...config, counters: { load: 0, note: 0, ...(config.counters || {}) } };
    let cfgChanged = false;
    const ts = DB.now();
    let l = { ...load, status: st.id, statusHistory: (load.statusHistory || []).concat({ id: st.id, name: st.name, at: ts }) };
    if (st.locked && !l.number) { cfg.counters.load += 1; l.number = cfg.counters.load; cfgChanged = true; }

    const productsById = new Map(products.map((p) => [p.id, p]));
    const delta = new Map();
    const addDelta = (o, sign) => Object.entries(o.lines || {}).forEach(([pid, ln]) =>
      delta.set(pid, (delta.get(pid) || 0) + sign * Matrix.lineTotals(ln).totalUnidades));

    let updOrders;
    if (st.closing && !isClosed(load)) {
      // CIERRE DE CARGA: la fecha de la carga es la del cierre (salvo que se haya fijado a mano)
      l.closedAt = ts;
      l.date = l.date || (opts.today || ts.slice(0, 10));
      updOrders = os.map((o) => {
        addDelta(o, -1);
        const n = o.noteNumber || (cfg.counters.note += 1, cfgChanged = true, cfg.counters.note);
        return { ...o, status: 'despachado', locked: true, loadStatusName: st.name, dispatchedAt: ts, noteNumber: n, loadNumber: l.number };
      });
      const tot = updOrders.reduce((a, o) => {
        const t = Matrix.orderTotals(o);
        a.cajas += t.cajas; a.unidades += t.unidades; a.bultos += t.bultos; a.totalUnidades += t.totalUnidades; a.monto = Matrix.r2(a.monto + t.monto);
        return a;
      }, { cajas: 0, unidades: 0, bultos: 0, totalUnidades: 0, monto: 0 });
      l.totals = { clients: updOrders.length, ...tot };
      l.firstNote = updOrders.length ? Math.min(...updOrders.map((o) => o.noteNumber)) : null;
      l.lastNote = updOrders.length ? Math.max(...updOrders.map((o) => o.noteNumber)) : null;
    } else if (!st.closing && isClosed(load)) {
      // REAPERTURA: se devuelve el inventario; los números ya emitidos se conservan
      l.closedAt = null; l.approvedAt = null;
      updOrders = os.map((o) => { addDelta(o, +1); return { ...o, status: 'en_carga', locked: st.locked, loadStatusName: st.name }; });
    } else {
      updOrders = os.map((o) => ({ ...o, locked: st.locked, loadStatusName: st.name }));
    }
    const updProducts = [];
    delta.forEach((units, pid) => {
      const p = productsById.get(pid);
      if (units && p && p.stock !== null && p.stock !== undefined && p.stock !== '') updProducts.push({ ...p, stock: (+p.stock || 0) + units });
    });
    return { load: l, orders: updOrders, products: updProducts, config: cfgChanged ? cfg : null };
  }

  function shortages(os, products) {
    const need = new Map();
    os.forEach((o) => Object.entries(o.lines || {}).forEach(([pid, l]) => {
      need.set(pid, (need.get(pid) || 0) + Matrix.lineTotals(l).totalUnidades);
    }));
    const byId = new Map(products.map((p) => [p.id, p]));
    const out = [];
    need.forEach((units, pid) => {
      const p = byId.get(pid);
      if (p && p.stock !== null && p.stock !== undefined && p.stock !== '' && units > (+p.stock || 0)) out.push({ product: p, need: units, stock: +p.stock || 0 });
    });
    return out;
  }

  const fmtNum = (n, w) => String(n || 0).padStart(w || 5, '0');

  global.Loads = {
    DEFAULT_STATUSES, ORDER_LABEL, statuses, statusOf, isOpen, isClosed, limits, measure, usage, loadOrders,
    autoPack, hold, release, moveOrder, merge, setStatus, shortages, initials, sellerIdsOf, labelOf, autoLabel, orderDateRange,
    loadCode: (l) => (l.number ? 'C-' + fmtNum(l.number) : 'Borrador'),
    noteCode: (n) => 'NE-' + fmtNum(n, 6),
    /** Etiqueta del estado de un pedido para el vendedor. */
    orderLabel: (o) => (o.loadId && o.loadStatusName && o.status !== 'despachado' ? o.loadStatusName : ORDER_LABEL[o.status] || o.status),
    /** ¿Se puede editar el pedido? (vendedor y oficina) */
    editable: (o) => !!o && !o.deleted && !o.locked && o.status !== 'despachado',
  };
})(window);
