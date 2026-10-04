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
 *     newValery: 'N°'   nota Valery que reemplaza (parcial)
 *     motivo: '...'
 *     vac:    { <productId>: { recv, asg } }         vacíos recibidos / asignados confirmados
 *   } },
 *   truck: { '<productId>|CJ' | '<productId>|UN': { carga, dev, motivo, dest } }
 *     dest: 'almacen' (volvió a almacén) | 'siguiente' (siguiente carga, mismo despachador)
 *   carryFrom: <loadId>  hoja anterior de la que viene QUEDAN
 *   carry:  { dispatcherId, rows: { <key>: qty } }   lo que pasa a la siguiente carga
 *   carryUsedBy: <loadId>  hoja que ya usó esa carga
 * }
 * Al cerrar, cada pedido recibe order.delivery (lo entregado de verdad).
 * ========================================================================= */
(function (global) {
  'use strict';

  const RESULTS = [
    ['entregada', '✓ Entregada'],
    ['parcial', '↩ Devolución parcial · nota nueva'],
    ['pendiente', '⏳ No entregado · se entrega después (misma nota)'],
    ['anulada', '✕ No entregado · nota anulada'],
  ];
  const MOTIVOS = ['DEVOLUCIÓN', 'CAMBIO', 'SIN VACÍOS', 'NEGOCIO CERRADO', 'RECHAZO', 'AJUSTE PRECIO', 'ERROR FACTURACIÓN', 'ROTURA', 'OTRO'];
  const n0 = (v) => Math.max(0, Math.round(+v || 0));

  const isDone = (load) => !!(load && load.liq && load.liq.status === 'cerrada');
  const entry = (liq, oid) => ({ result: 'entregada', ...(((liq && liq.orders) || {})[oid] || {}) });

  /** Líneas entregadas de un pedido según su resultado. */
  function deliveredLines(o, e) {
    if (e.result === 'pendiente' || e.result === 'anulada') return {};
    if (e.result !== 'parcial') return { ...(o.lines || {}) };
    const out = {};
    Object.entries(o.lines || {}).forEach(([pid, l]) => {
      const r = (e.ret || {})[pid] || {};
      const cajas = Math.max(0, (+l.cajas || 0) - n0(r.cajas)), unidades = Math.max(0, (+l.unidades || 0) - n0(r.unidades));
      if (cajas || unidades) out[pid] = { ...l, cajas, unidades };
    });
    return out;
  }
  const delivered = (o, liq) => ({ ...o, lines: deliveredLines(o, entry(liq, o.id)) });
  const returnedAny = (e) => Object.values(e.ret || {}).some((r) => n0(r.cajas) || n0(r.unidades));

  /**
   * Lo que trae el camión de una liquidación anterior del MISMO despachador
   * marcado «siguiente carga» y que todavía no usó otra hoja.
   */
  function carryFor(load, loads) {
    if (!load.dispatcherId) return null;
    const liq = load.liq || {};
    if (liq.carryFrom) {
      const src = loads.find((l) => l.id === liq.carryFrom && !l.deleted);
      return src && src.liq && src.liq.carry ? { fromId: src.id, label: src.label, rows: src.liq.carry.rows || {} } : null;
    }
    const cands = loads.filter((l) => !l.deleted && l.id !== load.id && isDone(l) && l.liq.carry && l.liq.carry.dispatcherId === load.dispatcherId
      && Object.values(l.liq.carry.rows || {}).some((q) => q > 0) && (!l.liq.carryUsedBy || l.liq.carryUsedBy === load.id));
    cands.sort((a, b) => String(b.liq.closedAt).localeCompare(String(a.liq.closedAt)));
    const src = cands[0];
    return src ? { fromId: src.id, rows: src.liq.carry.rows || {} } : null;
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
    Object.keys(carryRows).forEach((k) => {
      if (rows.some((r) => r.key === k) || !(carryRows[k] > 0)) return;
      const [pid, um] = k.split('|'), p = opts.productsById.get(pid) || {};
      rows.push({ key: k, productId: pid, um, code: p.code || pid, name: p.name || pid, presentation: p.presentation || '', category: p.category || '', pedido: 0 });
    });
    const t = (liq && liq.truck) || {};
    return rows.map((r) => {
      const x = t[r.key] || {};
      const entregado = delBy.get(r.key) || 0;
      const queda = n0(carryRows[r.key]);
      const carga = x.carga !== undefined && x.carga !== '' ? n0(x.carga) : Math.max(0, r.pedido - queda);
      const total = queda + carga;
      const debe = total - entregado;
      const dev = x.dev !== undefined && x.dev !== '' ? n0(x.dev) : (debe === 0 ? 0 : null);
      return { ...r, entregado, queda, carga, total, debe, dev, dif: dev === null ? null : debe - dev, motivo: x.motivo || '', dest: x.dest === 'siguiente' ? 'siguiente' : 'almacen' };
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
        const recv = v.recv !== undefined && v.recv !== '' ? n0(v.recv) : Math.max(0, boxes - (asg || 0));
        out.push({ orderId: o.id, client: o.clientName, pid, code: l.code, name: l.name, regime: r.regime, assign: r.assign, type: r.type,
          boxes, recv, asg, pending: Math.max(0, boxes - recv) });
      });
    });
    return out;
  }

  /**
   * Vacíos por producto retornable (fila CJ de la hoja): cajas entregadas,
   * lo que suman los clientes como recibido y los VACÍOS DEVUELTOS que cuenta la
   * oficina (por omisión, la suma de los clientes).
   */
  function vacByRow(liq, vac) {
    const out = new Map(), t = (liq && liq.truck) || {};
    (vac || []).forEach((v) => {
      const k = v.pid + '|CJ', x = out.get(k) || { ent: 0, sum: 0 };
      x.ent += v.boxes; x.sum += v.recv; out.set(k, x);
    });
    out.forEach((x, k) => { const d = (t[k] || {}).vacDev; x.dev = d !== undefined && d !== '' && d !== null ? n0(d) : x.sum; x.counted = d !== undefined && d !== '' && d !== null; });
    return out;
  }

  /** Lo que impide cerrar la liquidación (lista de textos). */
  function problems(orders, liq, rows, vac) {
    const out = [];
    orders.forEach((o) => {
      const e = entry(liq, o.id);
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
    });
    vacByRow(liq, vac).forEach((x, k) => {
      if (x.dev !== x.sum) { const r = rows.find((y) => y.key === k) || {}; out.push(`Vacíos ${r.code || k} ${r.name || ''}: devolvieron ${x.dev} pero por cliente suman ${x.sum} (corrige los vacíos de cada cliente)`); }
    });
    vac.forEach((v) => {
      if (v.regime === 'contraentrega' && v.recv + (v.asg || 0) < v.boxes) out.push(`${v.client} · ${v.code}: recibió ${v.recv} vacíos y tiene ${v.asg || 0} asignados para ${v.boxes} cajas (contraentrega)`);
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
    const vbr = vacByRow(liq, vac);
    const mrows = rows.map((r) => {
      const cells = cols.map((c) => { const ped = qty((c.order.lines || {})[r.productId], r.um), del = qty(c.lines[r.productId], r.um); return { del, ret: Math.max(0, ped - del) }; });
      const usd = Matrix.r2(cols.reduce((a, c) => a + usdOf(c.lines[r.productId], r.um), 0));
      const vx = vbr.get(r.key) || null;
      return { ...r, cells, usd, vacEnt: vx ? vx.ent : null, vacDev: vx ? vx.dev : null, vacSum: vx ? vx.sum : null };
    });
    // Vacíos por tipo: recibidos, asignados y lo que quedan debiendo, por cliente
    const types = [];
    (vac || []).forEach((v) => { if (!types.includes(v.type)) types.push(v.type); });
    const vacRowsOut = [];
    types.forEach((ty) => {
      const of = (c, f) => vac.filter((v) => v.type === ty && v.orderId === c.order.id).reduce((a, v) => (v[f] === null ? a : a + v[f]), null);
      const mk = (key, label, f) => { const cells = cols.map((c) => of(c, f)); return { key, label: `${label} ${ty}`, cells, total: cells.reduce((a, x) => a + (x || 0), 0) }; };
      const recv = mk('RECIBIDOS', 'VACÍOS RECIBIDOS', 'recv'), asg = mk('ASIGNADOS', 'ASIGNADOS', 'asg'), pend = mk('DEBEN', 'QUEDAN DEBIENDO', 'pending');
      vacRowsOut.push(recv);
      if (asg.cells.some((x) => x !== null)) vacRowsOut.push(asg);
      if (pend.total) vacRowsOut.push(pend);
    });
    return { cols, rows: mrows, vac: vacRowsOut,
      totals: { bultos: cols.map((c) => c.bultos), monto: cols.map((c) => c.monto), usd: Matrix.r2(cols.reduce((a, c) => a + c.monto, 0)) } };
  }

  /** Texto corto de la novedad de un cliente (encabezado de su columna). */
  const shortResult = (e) => ({ entregada: '', parcial: 'DEV. PARCIAL', pendiente: 'SE ENTREGA DESPUÉS', anulada: 'ANULADA' })[e.result] || '';

  global.Liq = { RESULTS, MOTIVOS, isDone, entry, deliveredLines, delivered, returnedAny, carryFor, truckRows, vacRows, problems, sheet, shortResult, vacByRow };
})(window);
