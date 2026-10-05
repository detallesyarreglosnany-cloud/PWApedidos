/* =========================================================================
 * kardex.js — Kardex de vacíos (Fase 2 · E4). Lógica pura sobre los
 * movimientos que guarda el servidor (/api/pedidos/envases).
 *
 * Por cliente y tipo de envase (350, 1,25…):
 *   DEBE      = apertura + despachados − recibidos − asignados − devoluciones
 *   ASIGNADOS = apertura de asignados + asignados − devoluciones de asignados
 *   EN PODER  = DEBE + ASIGNADOS   (vacíos de la empresa que tiene el cliente)
 * Un renglón anulado (oficina) o revertido (liquidación reabierta) no cuenta.
 * ========================================================================= */
(function (global) {
  'use strict';

  const KIND_LABEL = {
    despacho: 'Despacho (liquidación)', recibido: 'Vacíos recibidos', asignado: 'Asignados',
    devolucion: 'Devolución de vacíos', dev_asignado: 'Devolución de asignados',
    apertura: 'Saldo de apertura (debe)', apertura_asig: 'Saldo de apertura (asignados)',
    anulacion: 'Anulación', reverso: 'Reverso (liquidación reabierta)',
  };
  const MANUAL = ['devolucion', 'dev_asignado', 'apertura', 'apertura_asig'];
  // Efecto de cada renglón en [debe, asignados]
  const EFFECT = {
    despacho: [1, 0], recibido: [-1, 0], asignado: [-1, 1], devolucion: [-1, 0],
    dev_asignado: [0, -1], apertura: [1, 0], apertura_asig: [0, 1],
  };
  // Dentro de una misma liquidación: primero lo despachado, luego lo recibido y lo asignado (así el saldo nunca baja de 0 en el historial)
  const KRANK = { despacho: 0, recibido: 1, asignado: 2 };
  const sortMov = (a, b) => String(a.date).localeCompare(String(b.date))
    || (a.orderId && a.orderId === b.orderId && KRANK[a.kind] !== undefined && KRANK[b.kind] !== undefined ? KRANK[a.kind] - KRANK[b.kind] || String(a.pid).localeCompare(String(b.pid)) : 0)
    || String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id));

  /** Renglones que cuentan (sin los cancelados ni los que cancelan) + quién canceló a quién. */
  function effective(movs) {
    const cancelledBy = new Map();
    movs.forEach((m) => { if ((m.kind === 'anulacion' || m.kind === 'reverso') && m.refId) cancelledBy.set(m.refId, m); });
    return { live: movs.filter((m) => EFFECT[m.kind] && !cancelledBy.has(m.id)), cancelledBy };
  }

  /** Saldos por cliente y tipo. */
  function balances(movs) {
    const { live } = effective(movs);
    const map = new Map();
    live.forEach((m) => {
      const k = m.clientId + '\u0001' + m.type;
      let b = map.get(k);
      if (!b) {
        b = { clientId: m.clientId, clientName: m.clientName, sellerId: m.sellerId, sellerName: m.sellerName, type: m.type,
          despacho: 0, recibido: 0, asignado: 0, devolucion: 0, dev_asignado: 0, apertura: 0, apertura_asig: 0, debe: 0, asignados: 0, last: '' };
        map.set(k, b);
      }
      b[m.kind] += m.qty;
      const [d, a] = EFFECT[m.kind];
      b.debe += d * m.qty; b.asignados += a * m.qty;
      if (String(m.date) >= b.last) { b.last = m.date; b.clientName = m.clientName || b.clientName; if (m.sellerName) { b.sellerId = m.sellerId; b.sellerName = m.sellerName; } }
    });
    return [...map.values()].map((b) => ({ ...b, enPoder: b.debe + b.asignados }));
  }

  /** Un renglón por cliente con sus tipos (para la lista). */
  function byClient(movs) {
    const map = new Map();
    balances(movs).forEach((b) => {
      let c = map.get(b.clientId);
      if (!c) { c = { clientId: b.clientId, clientName: b.clientName, sellerName: b.sellerName, types: {}, debe: 0, asignados: 0, last: '' }; map.set(b.clientId, c); }
      c.types[b.type] = b; c.debe += b.debe; c.asignados += b.asignados;
      if (b.last > c.last) { c.last = b.last; c.clientName = b.clientName; c.sellerName = b.sellerName || c.sellerName; }
    });
    return [...map.values()];
  }

  /** Totales por tipo (toda la empresa). */
  function totalsByType(movs) {
    const t = {};
    balances(movs).forEach((b) => {
      const x = t[b.type] || (t[b.type] = { type: b.type, despacho: 0, recibido: 0, asignado: 0, devolucion: 0, debe: 0, asignados: 0, clientes: 0 });
      ['despacho', 'recibido', 'asignado', 'devolucion', 'debe', 'asignados'].forEach((f) => { x[f] += b[f]; });
      if (b.debe > 0) x.clientes++;
    });
    return Object.values(t);
  }

  /** Historial de un cliente con el saldo acumulado por tipo después de cada renglón. */
  function history(movs, clientId) {
    const mine = movs.filter((m) => m.clientId === clientId).sort(sortMov);
    const { cancelledBy } = effective(mine);
    const run = {};
    return mine.map((m) => {
      const r = run[m.type] || (run[m.type] = { debe: 0, asignados: 0 });
      const counts = !!EFFECT[m.kind] && !cancelledBy.has(m.id);
      if (counts) { const [d, a] = EFFECT[m.kind]; r.debe += d * m.qty; r.asignados += a * m.qty; }
      return { ...m, counts, cancelled: cancelledBy.get(m.id) || null, debe: r.debe, asignados: r.asignados, label: KIND_LABEL[m.kind] || m.kind };
    });
  }

  /**
   * Deuda por despacho (lo más viejo primero): cada liquidación deja una deuda
   * (despachados − recibidos − asignados de ese pedido); las devoluciones la
   * cubren — primero la del despacho que eligió la oficina, luego la más antigua.
   */
  function fifo(movs, clientId, type) {
    const { live } = effective(movs.filter((m) => m.clientId === clientId && m.type === type));
    const debts = [], idx = new Map();
    live.slice().sort(sortMov).forEach((m) => {
      if (m.kind === 'apertura') { debts.push({ id: m.id, date: m.date, label: 'Saldo de apertura', orderId: null, owed: m.qty, paid: 0 }); return; }
      if (!m.orderId || !['despacho', 'recibido', 'asignado'].includes(m.kind)) return;
      const k = m.orderId + '|' + m.pid;
      let d = idx.get(k);
      if (!d) { d = { id: null, date: m.date, label: '', orderId: m.orderId, code: m.code, owed: 0, paid: 0, valery: '' }; idx.set(k, d); debts.push(d); }
      if (m.kind === 'despacho') { d.id = m.id; d.date = m.date; d.owed += m.qty; try { d.valery = JSON.parse(m.data || '{}').valeryNote || ''; } catch (e) { /* noop */ } d.label = `Despacho ${m.code}${d.valery ? ' · nota ' + d.valery : ''}`; }
      else d.owed -= m.qty;
    });
    const open = debts.filter((d) => d.owed > 0).sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const devs = live.filter((m) => m.kind === 'devolucion').sort(sortMov);
    const apply = (d, left) => { const x = Math.min(left, d.owed - d.paid); d.paid += x; return left - x; };
    let extra = 0;
    devs.forEach((m) => {
      let left = m.qty;
      const target = m.refId && open.find((d) => d.id === m.refId);
      if (target) left = apply(target, left);
      for (const d of open) { if (!left) break; left = apply(d, left); }
      extra += left;
    });
    return { rows: open.map((d) => ({ ...d, left: d.owed - d.paid })), extra };
  }

  global.Kardex = { KIND_LABEL, MANUAL, EFFECT, effective, balances, byClient, totalsByType, history, fifo };
})(window);
