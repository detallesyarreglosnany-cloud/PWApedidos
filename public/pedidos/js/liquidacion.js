/* =========================================================================
 * liquidacion.js — Liquidación de una hoja de carga (Fase 2 · E3). Lógica pura.
 *
 * La liquidación vive dentro de la hoja (load.liq), la escribe solo la oficina
 * y nunca modifica lo que el vendedor pidió: lo entregado se guarda aparte.
 *
 * load.liq = {
 *   status: 'borrador' | 'cerrada', startedAt, closedAt, closedBy,
 *   orders: { <orderId>: {
 *     result: 'entregada' | 'parcial' | 'pendiente' | 'anulada',
 *     ret:    { <productId>: { cajas, unidades } }   devuelto (solo 'parcial')
 *     nf:     { <productId>: { cajas, unidades, why } }  lo que NO se facturó en la misma nota (solo 'nofact')
 *             why 'nohabia' = no salió del almacén (no cuenta como carga) · 'camion' = iba en el camión y vuelve
 *     newValery: 'N°'   nota Valery que reemplaza (parcial)
 *     motivo: '...'
 *     vac:    { <productId>: { recv, asg } }         vacíos recibidos / asignados confirmados
 *     prev:   { '<tipo>|<from>': { type, from, qty, motivo } }  vacíos que el cliente devolvió
 *             de entregas ANTERIORES (los trajo el despachador de esta hoja; from:
 *             'devolucion' = de lo que debía · 'dev_asignado' = de sus asignados)
 *   } },
 *   truck: { '<productId>|CJ' | '<productId>|UN': { queda, carga, dev, motivo, dest } }
 *     queda / carga: lo que la oficina corrige a mano (si no, QUEDAN viene de la hoja anterior y CARGA de la hoja)
 *     dest: 'almacen' (volvió a almacén) | 'siguiente' (siguiente carga, mismo despachador)
 *   carryFrom: [<loadId>]  hojas anteriores de las que viene QUEDAN (todas las pendientes del despachador)
 *   carry:  { dispatcherId, rows: { <key>: qty } }   lo que pasa a la siguiente carga
 *   carry.to / carry.used: por producto, hoja destino elegida y hoja que ya lo tomó ('almacen' = se descargó con motivo)
 *   truck[key].destLoad: hoja destino elegida para lo que sobra (vacío = la próxima que se liquide)
 *   prevRet: { <id>: { clientId, clientName, orderId, loadId, label, pid, um, qty, nota, motivo } }
 *     mercancía que un cliente devolvió de una entrega ANTERIOR y trajo este camión:
 *     entra al cuadre (Total = Quedan + Carga + Dev. anteriores) y sigue como cualquier sobrante
 * }
 * Al cerrar, cada pedido recibe order.delivery (lo entregado de verdad).
 * ========================================================================= */
(function (global) {
  'use strict';

  const RESULTS = [
    ['entregada', '✓ Entregada'],
    ['parcial', '↩ Devolución parcial · nota nueva'],
    ['nofact', '⊘ No se facturó todo · misma nota'],
    ['pendiente', '⏳ No entregado · se entrega después (misma nota)'],
    ['anulada', '✕ No entregado · nota anulada'],
  ];
  // Por qué un cliente queda debiendo vacíos (va al kardex)
  const VAC_MOTIVOS = ['PRÉSTAMO', 'LOS ENTREGA EN LA PRÓXIMA', 'SIN VACÍOS', 'NEGOCIO CERRADO', 'OTRO'];
  const MOTIVOS = ['NO HABÍA (NO SALIÓ DEL ALMACÉN)', 'ERROR FACTURACIÓN', 'DEVOLUCIÓN', 'CAMBIO', 'SIN VACÍOS', 'NEGOCIO CERRADO', 'RECHAZO', 'AJUSTE PRECIO', 'ROTURA', 'OTRO'];
  const n0 = (v) => Math.max(0, Math.round(+v || 0));

  const isDone = (load) => !!(load && load.liq && load.liq.status === 'cerrada');
  const entry = (liq, oid) => ({ result: 'entregada', ...(((liq && liq.orders) || {})[oid] || {}) });

  /** Líneas entregadas de un pedido según su resultado. */
  function deliveredLines(o, e) {
    if (e.result === 'pendiente' || e.result === 'anulada') return {};
    if (e.result !== 'parcial' && e.result !== 'nofact') return { ...(o.lines || {}) };
    const out = {};
    Object.entries(o.lines || {}).forEach(([pid, l]) => {
      const r = ((e.result === 'nofact' ? e.nf : e.ret) || {})[pid] || {};
      const cajas = Math.max(0, (+l.cajas || 0) - n0(r.cajas)), unidades = Math.max(0, (+l.unidades || 0) - n0(r.unidades));
      if (cajas || unidades) out[pid] = { ...l, cajas, unidades };
    });
    return out;
  }
  const delivered = (o, liq) => ({ ...o, lines: deliveredLines(o, entry(liq, o.id)) });
  const returnedAny = (e) => Object.values((e.result === 'nofact' ? e.nf : e.ret) || {}).some((r) => n0(r.cajas) || n0(r.unidades));
  /** Lo que no salió del almacén (no facturado, «no había»): por producto y UM. No cuenta como carga. */
  function noSalioOf(orders, liq) {
    const out = {};
    orders.forEach((o) => {
      const e = entry(liq, o.id); if (e.result !== 'nofact') return;
      Object.entries(e.nf || {}).forEach(([pid, r]) => {
        if (r.why !== 'nohabia') return;
        if (n0(r.cajas)) out[pid + '|CJ'] = (out[pid + '|CJ'] || 0) + n0(r.cajas);
        if (n0(r.unidades)) out[pid + '|UN'] = (out[pid + '|UN'] || 0) + n0(r.unidades);
      });
    });
    return out;
  }

  const fromList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  /*
   * Sobrante del camión, producto por producto (liq.carry):
   *   rows: { <key>: qty }       lo que quedó en el camión para otra carga
   *   to:   { <key>: <loadId> }  hoja destino elegida (si no, la próxima que se liquide)
   *   used: { <key>: <loadId> | 'almacen' }  hoja que ya lo tomó (o se mandó a almacén con motivo)
   * carryUsedBy (versión anterior) = toda la hoja tomada de una vez.
   */
  const usedOf = (l, k) => (l.liq.carryUsedBy ? l.liq.carryUsedBy : ((l.liq.carry && l.liq.carry.used) || {})[k] || null);
  const carryKeys = (l) => Object.entries((l.liq && l.liq.carry && l.liq.carry.rows) || {}).filter(([, q]) => n0(q) > 0).map(([k]) => k);
  /** Destino válido: existe, no está borrada ni liquidada y es del mismo despachador. */
  function targetOf(l, k, loads) {
    const id = ((l.liq.carry && l.liq.carry.to) || {})[k];
    if (!id) return null;
    const t = loads.find((x) => x.id === id);
    return t && !t.deleted && !isDone(t) && t.dispatcherId === l.liq.carry.dispatcherId ? t : null;
  }
  const pendingKeys = (l) => (!l.deleted && isDone(l) && l.liq.carry ? carryKeys(l).filter((k) => !usedOf(l, k)) : []);
  /**
   * Lo que trae el camión: TODO el sobrante pendiente de liquidaciones anteriores del
   * MISMO despachador. Lo que se mandó a una hoja concreta solo aparece en esa hoja;
   * lo demás, en la próxima que se liquide. Si hay varias hojas de origen, se suman.
   */
  function carryFor(load, loads) {
    if (!load.dispatcherId) return null;
    const done = isDone(load), rows = {}, sources = [];
    loads.forEach((l) => {
      if (l.deleted || l.id === load.id || !isDone(l) || !l.liq.carry) return;
      if (!done && l.liq.carry.dispatcherId !== load.dispatcherId) return;
      const keys = carryKeys(l).filter((k) => {
        const u = usedOf(l, k);
        if (done) return u === load.id;
        if (u && u !== load.id) return false;
        const t = targetOf(l, k, loads);
        return !t || t.id === load.id;
      });
      if (!keys.length) return;
      const part = {};
      keys.forEach((k) => { const q = n0(l.liq.carry.rows[k]); part[k] = q; rows[k] = (rows[k] || 0) + q; });
      sources.push({ id: l.id, closedAt: l.liq.closedAt, rows: part });
    });
    if (!sources.length) return null;
    sources.sort((a, b) => String(a.closedAt).localeCompare(String(b.closedAt)));
    const ordBy = {}; // de la hoja más vieja a la más nueva
    sources.forEach((x) => Object.keys(x.rows).forEach((k) => { (ordBy[k] = ordBy[k] || []).push(x.id); }));
    return { fromIds: sources.map((x) => x.id), fromId: sources[sources.length - 1].id, sources, rows, by: ordBy };
  }

  /** Sobrante en los camiones que ninguna hoja ha tomado: [{ load, keys, to: {key: hoja destino} }]. */
  function pendingCarries(loads) {
    return loads.map((l) => ({ load: l, keys: pendingKeys(l) })).filter((x) => x.keys.length)
      .map((x) => ({ ...x, to: Object.fromEntries(x.keys.map((k) => [k, targetOf(x.load, k, loads)])) }))
      .sort((a, b) => String(a.load.liq.closedAt).localeCompare(String(b.load.liq.closedAt)));
  }
  /** Marca como tomados (o los suelta, con id null) los productos que esta hoja tomó de cada origen. */
  function markUsed(src, keys, value) {
    const used = { ...((src.liq.carry && src.liq.carry.used) || {}) };
    // Hojas viejas con carryUsedBy: se pasa a producto por producto
    if (src.liq.carryUsedBy && src.liq.carryUsedBy !== 'almacen') carryKeys(src).forEach((k) => { if (!used[k]) used[k] = src.liq.carryUsedBy; });
    keys.forEach((k) => { if (value) used[k] = value; else delete used[k]; });
    return { ...src, liq: { ...src.liq, carryUsedBy: src.liq.carryUsedBy === 'almacen' ? 'almacen' : null, carry: { ...src.liq.carry, used } } };
  }
  /** Hojas a las que puede ir el sobrante: del mismo despachador y sin liquidar. */
  function destLoads(load, loads) {
    if (!load.dispatcherId) return [];
    const k = (l) => `${l.date || '9999'}|${String(l.number || 0).padStart(8, '0')}`;
    return loads.filter((l) => !l.deleted && l.id !== load.id && l.dispatcherId === load.dispatcherId && !isDone(l)).sort((a, b) => k(a).localeCompare(k(b)));
  }

  /**
   * Pasa las liquidaciones cerradas con versiones anteriores al formato nuevo (una sola vez,
   * sin cambiar ninguna cantidad): en la foto del camión anota cuánto TRAÍA de verdad (lo
   * que le pasaron sus hojas de origen), y el «ya lo tomó» del sobrante queda por producto.
   * Devuelve las hojas a guardar.
   */
  function upgradeOld(loads) {
    const out = new Map();
    const cur = (l) => out.get(l.id) || l;
    loads.forEach((l0) => {
      if (l0.deleted || !isDone(l0) || !l0.liq.snapshot || l0.liq.snapshot.v3) return;
      const l = cur(l0), traia = {};
      fromList(l.liq.carryFrom).forEach((sid) => {
        const s0 = loads.find((x) => x.id === sid); if (!s0 || !s0.liq || !s0.liq.carry) return;
        const src = cur(s0);
        carryKeys(src).forEach((k) => { if (usedOf(src, k) === l.id) traia[k] = (traia[k] || 0) + n0(src.liq.carry.rows[k]); });
        if (src.liq.carryUsedBy && src.liq.carryUsedBy !== 'almacen') out.set(src.id, markUsed(src, [], null));
      });
      const rows = (l.liq.snapshot.rows || []).map((r) => ({ ...r, traia: r.traia !== undefined ? r.traia : traia[r.key] || 0, anterior: r.anterior || 0, destLoad: r.destLoad || '' }));
      // Lo que traía y no quedó en la foto (producto que la hoja no mostraba): se agrega para no perderlo
      Object.keys(traia).forEach((k) => { if (!rows.some((r) => r.key === k)) rows.push({ key: k, traia: traia[k], queda: 0, carga: 0, anterior: 0, entregado: 0, total: 0, debe: 0, dev: 0, dif: 0, motivo: 'no se registró en esta hoja', dest: 'almacen' }); });
      const base = cur(l);
      out.set(l.id, { ...base, liq: { ...base.liq, carryFrom: fromList(base.liq.carryFrom), snapshot: { ...base.liq.snapshot, rows, v3: true, upgradedAt: new Date().toISOString() } } });
    });
    return [...out.values()];
  }

  /** Hojas del mismo despachador, anteriores a esta, aprobadas y aún sin liquidar (se liquidan primero). */
  function olderUnliquidated(load, loads, isClosed) {
    if (!load.dispatcherId) return [];
    const k = (l) => `${l.date || ''}|${String(l.number || 0).padStart(8, '0')}`;
    return loads.filter((l) => !l.deleted && l.id !== load.id && l.dispatcherId === load.dispatcherId && isClosed(l) && !isDone(l) && k(l) < k(load));
  }

  /** Mercancía devuelta de entregas anteriores (por producto y UM). */
  function prevRetRows(liq) {
    return Object.entries((liq && liq.prevRet) || {}).map(([id, x]) => ({ id, ...x, qty: n0(x.qty) })).filter((x) => x.qty > 0 && x.pid);
  }

  /**
   * Filas del cuadre del camión (una por producto y CJ/UN, como la hoja).
   * pedido = lo que lleva la hoja · entregado = lo entregado según las notas.
   */
  function truckRows(orders, liq, carry, opts) {
    const keyOf = (r) => r.productId + '|' + r.um;
    const ped = Matrix.build(orders, 'bultos', { keepOrder: true, money: false, rubros: opts.rubros, productRank: opts.productRank });
    const del = Matrix.build(orders.map((o) => delivered(o, liq)), 'bultos', { keepOrder: true, money: false });
    const delBy = new Map(del.rows.map((r) => [keyOf(r), r.total]));
    const rows = ped.rows.map((r) => ({ key: keyOf(r), productId: r.productId, um: r.um, code: r.code, name: r.name, presentation: r.presentation, category: r.category, pedido: r.total }));
    const carryRows = (carry && carry.rows) || {};
    const ant = {};
    prevRetRows(liq).forEach((x) => { const k = x.pid + '|' + (x.um === 'UN' ? 'UN' : 'CJ'); ant[k] = (ant[k] || 0) + x.qty; });
    const addRow = (k) => {
      if (rows.some((r) => r.key === k)) return;
      const [pid, um] = k.split('|'), p = opts.productsById.get(pid) || {};
      rows.push({ key: k, productId: pid, um, code: p.code || pid, name: p.name || pid, presentation: p.presentation || '', category: p.category || '', pedido: 0 });
    };
    Object.keys(carryRows).forEach((k) => { if (carryRows[k] > 0) addRow(k); });
    Object.keys(ant).forEach(addRow);
    const t = (liq && liq.truck) || {};
    const ns = noSalioOf(orders, liq);
    return rows.map((r) => {
      const x = t[r.key] || {};
      const entregado = delBy.get(r.key) || 0;
      const traia = n0(carryRows[r.key]);
      const quedaMan = x.queda !== undefined && x.queda !== '';
      const queda = quedaMan ? n0(x.queda) : traia;
      const anterior = ant[r.key] || 0;
      const noSalio = ns[r.key] || 0;
      const carga = x.carga !== undefined && x.carga !== '' ? n0(x.carga) : Math.max(0, r.pedido - noSalio - queda);
      const total = queda + carga + anterior;
      const debe = total - entregado;
      const dev = x.dev !== undefined && x.dev !== '' ? n0(x.dev) : (debe === 0 ? 0 : null);
      // Lo que sobra hay que decidirlo SIEMPRE (nunca se va solo a almacén)
      const dest = x.dest === 'siguiente' || x.dest === 'almacen' ? x.dest : null;
      const destLoad = dest === 'siguiente' && x.destLoad ? String(x.destLoad) : '';
      const desde = (carry && carry.by && carry.by[r.key]) || [];
      return { ...r, noSalio, entregado, traia, desde, queda, quedaMan, anterior, destLoad, cargaMan: x.carga !== undefined && x.carga !== '', carga, total, debe, dev, dif: dev === null ? null : debe - dev, motivo: x.motivo || '', dest };
    });
  }

  /** Vacíos de cada pedido: entregadas, recibidos y asignados (con sus valores por omisión). */
  function vacRows(orders, liq, productsById) {
    const out = [];
    orders.forEach((o) => {
      const d = delivered(o, liq), e = entry(liq, o.id);
      Object.entries(d.lines || {}).forEach(([pid, l]) => {
        const r = Envases.info(productsById.get(pid)); const boxes = +l.cajas || 0;
        if (!r || !boxes) return;
        const v = (e.vac || {})[pid] || {};
        const asg0 = r.assign ? Envases.assignedOf(o, pid) : null;
        const asg = r.assign ? (v.asg !== undefined && v.asg !== '' && v.asg !== null ? Math.min(boxes, n0(v.asg)) : (asg0 === null ? null : Math.min(boxes, asg0))) : null;
        const recv = v.recv !== undefined && v.recv !== '' ? Math.min(boxes, n0(v.recv)) : Math.max(0, boxes - (asg || 0));
        out.push({ orderId: o.id, client: o.clientName, pid, code: l.code, name: l.name, regime: r.regime, assign: r.assign, type: r.type,
          boxes, recv, asg, pending: Math.max(0, boxes - recv - (asg || 0)), motivo: v.motivo || '' });
      });
    });
    return out;
  }

  /** Vacíos de entregas anteriores que trajo el despachador (uno por cliente, tipo y origen). */
  function prevRows(orders, liq) {
    const out = [];
    orders.forEach((o) => {
      Object.entries(entry(liq, o.id).prev || {}).forEach(([key, p]) => {
        const qty = n0(p && p.qty); if (!qty || !p.type) return;
        out.push({ key, orderId: o.id, clientId: o.clientId || '', client: o.clientName, type: String(p.type), from: p.from === 'dev_asignado' ? 'dev_asignado' : 'devolucion', qty, motivo: p.motivo || '' });
      });
    });
    return out;
  }

  /** Lo que impide cerrar la liquidación (lista de textos). */
  function problems(orders, liq, rows, vac) {
    const out = [];
    orders.forEach((o) => {
      const e = entry(liq, o.id);
      if (e.result === 'nofact' && !returnedAny(e)) out.push(`${o.clientName}: marca qué productos no se facturaron`);
      if (e.result === 'parcial') {
        if (!returnedAny(e)) out.push(`${o.clientName}: marca qué devolvió`);
        if (!String(e.newValery || '').trim()) out.push(`${o.clientName}: falta el número de la nota nueva de Valery`);
      }
      if (e.result !== 'entregada' && !e.motivo) out.push(`${o.clientName}: falta el motivo`);
    });
    rows.forEach((r) => {
      const lbl = `${r.code} ${r.name} ${r.um}`;
      if (r.dev === null) out.push(`Camión · ${lbl}: falta contar lo que volvió`);
      else if (r.dif !== 0 && !r.motivo) out.push(`Camión · ${lbl}: diferencia de ${r.dif} sin motivo`);
      if (r.dev > 0 && !r.dest) out.push(`Camión · ${lbl}: sobran ${r.dev} — indica si vuelve a almacén o sigue a la siguiente carga`);
      if (r.quedaMan && r.queda !== r.traia && !r.motivo) out.push(`Camión · ${lbl}: QUEDAN cambiado a ${r.queda} pero el camión traía ${r.traia} de cargas anteriores — escribe el motivo`);
    });
    vac.forEach((v) => {
      if (v.regime === 'contraentrega' && v.pending && !v.motivo) out.push(`${v.client} · ${v.code}: contraentrega con ${v.pending} vacíos sin recibir ni asignar — corrige o indica el motivo`);
    });
    return out;
  }


  /**
   * Matriz de la liquidación (como la hoja de carga): una columna por cliente
   * con lo que se le entregó (y lo devuelto), $ por cliente y por producto, y
   * filas de vacíos por tipo al pie.
   */
  function sheet(orders, liq, rows, vac) {
    const cols = orders.map((o) => {
      const e = entry(liq, o.id), lines = deliveredLines(o, e), t = Matrix.orderTotals({ lines });
      return { order: o, entry: e, lines, monto: t.monto, bultos: t.bultos };
    });
    const qty = (l, um) => (l ? (um === 'CJ' ? +l.cajas || 0 : +l.unidades || 0) : 0);
    const usdOf = (l, um) => (l ? Matrix.lineTotals(um === 'CJ' ? { ...l, unidades: 0 } : { ...l, cajas: 0 }).monto : 0);
    const mrows = rows.map((r) => {
      const cells = cols.map((c) => { const ped = qty((c.order.lines || {})[r.productId], r.um), del = qty(c.lines[r.productId], r.um); return { del, ret: Math.max(0, ped - del), nf: c.entry.result === 'nofact' }; });
      const usd = Matrix.r2(cols.reduce((a, c) => a + usdOf(c.lines[r.productId], r.um), 0));
      return { ...r, cells, usd };
    });
    // Vacíos por tipo (como la hoja de carga): DESPACHADOS (cajas retornables
    // entregadas) − RECIBIDOS − ASIGNADOS = QUEDAN DEBIENDO, por cliente y total.
    // Si el despachador trajo vacíos de entregas anteriores: + DEVUELTOS ANTERIORES y
    // ENTRAN AL CAMIÓN (recibidos + anteriores) para ver lo que sale contra lo que entra.
    vac = vac || [];
    const prev = prevRows(orders, liq);
    const types = [];
    vac.concat(prev).forEach((v) => { if (!types.includes(v.type)) types.push(v.type); });
    const vacRowsOut = [];
    types.forEach((ty) => {
      const of = (c, f) => vac.filter((v) => v.type === ty && v.orderId === c.order.id).reduce((a, v) => (v[f] === null ? a : (a || 0) + v[f]), null);
      const mk = (key, label, f) => { const cells = cols.map((c) => of(c, f)); return { key, type: ty, label: `${label} ${ty}`, cells, total: cells.reduce((a, x) => a + (x || 0), 0) }; };
      vacRowsOut.push(mk('DESPACHADOS', 'VACÍOS DESPACHADOS', 'boxes'), mk('RECIBIDOS', 'VACÍOS RECIBIDOS', 'recv'), mk('ASIGNADOS', 'ASIGNADOS', 'asg'), mk('DEBEN', 'QUEDAN DEBIENDO', 'pending'));
      const pv = prev.filter((p) => p.type === ty);
      if (!pv.length) return;
      const prevCells = cols.map((c) => pv.filter((p) => p.orderId === c.order.id).reduce((a, p) => (a || 0) + p.qty, null));
      const recvRow = vacRowsOut[vacRowsOut.length - 3];
      const inCells = cols.map((c, i) => (recvRow.cells[i] === null && prevCells[i] === null ? null : (recvRow.cells[i] || 0) + (prevCells[i] || 0)));
      const sum = (cells) => cells.reduce((a, x) => a + (x || 0), 0);
      vacRowsOut.push({ key: 'PREV', type: ty, label: `VAC. ANTERIORES ${ty}`, cells: prevCells, total: sum(prevCells) },
        { key: 'ENTRAN', type: ty, label: `VACÍOS QUE ENTRAN ${ty}`, cells: inCells, total: sum(inCells) });
    });
    return { cols, rows: mrows, vac: vacRowsOut,
      totals: { bultos: cols.map((c) => c.bultos), monto: cols.map((c) => c.monto), usd: Matrix.r2(cols.reduce((a, c) => a + c.monto, 0)) } };
  }

  /**
   * Cuadre en dólares de la hoja: el camión valorado al precio de cada producto
   * (el de la nota; si no hay, el del catálogo) contra lo que suman los clientes.
   *   QUEDAN $ + CARGA $ = TOTAL $
   *   TOTAL $ − DEVOLUCIÓN $ − DIFERENCIA $ = ENTREGADO $
   *   ENTREGADO $ (según el camión) ⇔ TOTAL $ DE LOS CLIENTES (según las notas)
   * Si no coinciden por centavos o dólares, dice cuánto y en qué productos.
   */
  function cuadre(sh, productsById) {
    const r2 = (n) => Math.round(n * 100) / 100;
    const priceOf = (r) => {
      const fromLine = sh.cols.map((c) => (c.order.lines || {})[r.productId]).find(Boolean);
      const src = fromLine || (productsById && productsById.get(r.productId)) || {};
      return r.um === 'CJ' ? +src.boxPrice || 0 : +src.unitPrice || 0;
    };
    const t = { queda: 0, carga: 0, anterior: 0, total: 0, entregado: 0, dev: 0, dif: 0, pend: 0 };
    const off = [];
    let sinContar = 0;
    sh.rows.forEach((r) => {
      const p = priceOf(r);
      t.queda += r.queda * p; t.carga += r.carga * p; t.anterior += (r.anterior || 0) * p; t.total += r.total * p; t.entregado += r.entregado * p;
      if (r.dev === null) { sinContar++; t.pend += r.debe * p; } else { t.dev += r.dev * p; t.dif += (r.dif || 0) * p; }
      // Clientes con otro precio en su nota: el producto no cuadra al precio de la hoja
      const d = r2((r.usd || 0) - r.entregado * p);
      if (Math.abs(d) >= 0.01) off.push({ code: r.code, name: r.name, presentation: r.presentation, um: r.um, diff: d });
    });
    Object.keys(t).forEach((k) => { t[k] = r2(t[k]); });
    const clientes = r2(sh.totals.usd), diff = r2(clientes - t.entregado);
    return { ...t, clientes, diff, ok: Math.abs(diff) < 0.01, off, sinContar };
  }

  /** Texto del cuadre (pantalla, impresión y Excel). */
  function cuadreLines(c, fmt) {
    const lines = [
      `QUEDAN ${fmt(c.queda)} + CARGA ${fmt(c.carga)}${c.anterior ? ` + DEV. ANTERIORES ${fmt(c.anterior)}` : ''} = TOTAL ${fmt(c.total)}`,
      `TOTAL ${fmt(c.total)} − DEVOLUCIÓN ${fmt(c.dev)} − DIFERENCIA ${fmt(c.dif)}${c.pend ? ` − SIN CONTAR ${fmt(c.pend)}` : ''} = ENTREGADO ${fmt(r2s(c.total - c.dev - c.dif - c.pend))}`,
      `ENTREGADO SEGÚN EL CAMIÓN ${fmt(c.entregado)} · TOTAL DE LOS CLIENTES (NOTAS) ${fmt(c.clientes)}`,
    ];
    const verdict = c.ok ? '✓ CUADRA: el total de los clientes coincide con el total del camión'
      : `⚠ NO CUADRA POR ${fmt(Math.abs(c.diff))} (${c.diff > 0 ? 'los clientes suman más' : 'los clientes suman menos'} que el camión)${c.off.length ? ' · precio distinto en: ' + c.off.slice(0, 6).map((o) => `${o.code} ${o.um} (${o.diff > 0 ? '+' : ''}${fmt(o.diff)})`).join(', ') : ' · redondeo'}`;
    const extra = [];
    if (c.dif) extra.push(`Diferencia del camión valorada: ${fmt(Math.abs(c.dif))} ${c.dif > 0 ? 'que falta' : 'que sobra'}`);
    if (c.sinContar) extra.push(`Cuadre provisional: faltan por contar ${c.sinContar} producto(s)`);
    return { lines, verdict, extra };
  }
  const r2s = (n) => Math.round(n * 100) / 100;

  /**
   * Cuadre de despachos de un período (quincena), por despachador y producto, con las
   * hojas LIQUIDADAS cuya fecha de carga cae en el período (foto del camión al cerrar):
   *   VENÍA (de antes del período) + AJUSTES de QUEDAN + CARGADO + DEV. ANTERIORES
   *   − ENTREGADO − VOLVIÓ A ALMACÉN − DIFERENCIA − CORTE (recibido + faltante)
   *   = QUEDA EN EL CAMIÓN (pasó a otra carga y aún no la toma ninguna hoja del período)
   * Si no da, el camión no cuadra. Faltantes = diferencias positivas + faltantes de corte.
   */
  function truckLedger(loads, from, to) {
    const inP = (l) => !l.deleted && isDone(l) && l.dispatcherId && String(l.date || l.liq.closedAt || '').slice(0, 10) >= from && String(l.date || l.liq.closedAt || '').slice(0, 10) <= to;
    const period = loads.filter(inP), ids = new Set(period.map((l) => l.id));
    const ord = (l) => `${l.date || ''}|${String(l.number || 0).padStart(8, '0')}|${l.liq.closedAt || ''}`;
    period.sort((a, b) => ord(a).localeCompare(ord(b)));
    const disp = new Map();
    const D = (l) => { const id = l.dispatcherId; if (!disp.has(id)) disp.set(id, { id, name: l.dispatcherName || id, keys: new Map(), hojas: [] }); return disp.get(id); };
    const K = (d, k) => { if (!d.keys.has(k)) d.keys.set(k, { key: k, inicio: 0, ajuste: 0, cargado: 0, anterior: 0, entregado: 0, almacen: 0, dif: 0, corteRec: 0, corteFalt: 0, final: 0 }); return d.keys.get(k); };
    period.forEach((l) => {
      const d = D(l), snap = ((l.liq.snapshot || {}).rows) || [], hoja = { load: l, rows: [] };
      snap.forEach((r) => {
        const x = K(d, r.key), traia = r.traia !== undefined ? n0(r.traia) : n0(r.queda);
        x.ajuste += n0(r.queda) - traia; x.cargado += n0(r.carga); x.anterior += n0(r.anterior); x.entregado += n0(r.entregado);
        const dev = r.dev === null || r.dev === undefined ? 0 : n0(r.dev);
        if (r.dest === 'almacen') x.almacen += dev;
        x.dif += +r.dif || 0;
        hoja.rows.push({ ...r, traia, sigue: r.dest === 'siguiente' ? dev : 0, almacen: r.dest === 'almacen' ? dev : 0 });
      });
      // Lo que venía de hojas ANTERIORES al período
      fromList(l.liq.carryFrom).forEach((sid) => {
        if (ids.has(sid)) return;
        const src = loads.find((x) => x.id === sid); if (!src || !src.liq || !src.liq.carry) return;
        carryKeys(src).forEach((k) => { if (usedOf(src, k) === l.id) K(d, k).inicio += n0(src.liq.carry.rows[k]); });
      });
      // Lo que esta hoja pasó a otra carga y ninguna hoja del período tomó (o se descargó en un corte)
      if (l.liq.carry) carryKeys(l).forEach((k) => {
        const u = usedOf(l, k), q = n0(l.liq.carry.rows[k]);
        if (u && u !== 'almacen' && ids.has(u)) return;
        if (u === 'almacen') {
          const cut = (l.liq.carryCuts || []).map((c) => (c.rows || {})[k]).find(Boolean);
          const rec = cut ? n0(cut.recibido) : q;
          K(d, k).corteRec += rec; K(d, k).corteFalt += Math.max(0, q - rec);
        } else K(d, k).final += q;
      });
      d.hojas.push(hoja);
    });
    return [...disp.values()].map((d) => {
      const rows = [...d.keys.values()].map((x) => {
        const calc = x.inicio + x.ajuste + x.cargado + x.anterior - x.entregado - x.almacen - x.dif - x.corteRec - x.corteFalt;
        return { ...x, descuadre: calc - x.final, faltante: Math.max(0, x.dif) + x.corteFalt, sobrante: Math.max(0, -x.dif) };
      });
      return { ...d, rows, ok: rows.every((r) => r.descuadre === 0), faltantes: rows.filter((r) => r.faltante > 0) };
    });
  }

  /** Texto corto de la novedad de un cliente (encabezado de su columna). */
  const shortResult = (e) => ({ entregada: '', parcial: 'DEV. PARCIAL', nofact: 'NO FACTURADO', pendiente: 'SE ENTREGA DESPUÉS', anulada: 'ANULADA' })[e.result] || '';

  global.Liq = { RESULTS, MOTIVOS, VAC_MOTIVOS, isDone, entry, deliveredLines, delivered, returnedAny, carryFor, pendingCarries, markUsed, destLoads, upgradeOld, olderUnliquidated, prevRetRows, truckRows, vacRows, prevRows, problems, sheet, cuadre, cuadreLines, truckLedger, shortResult };
})(window);
