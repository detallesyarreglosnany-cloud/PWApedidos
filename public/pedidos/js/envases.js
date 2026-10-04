/* =========================================================================
 * envases.js — Envases retornables (vacíos). Lógica pura, sin DOM.
 *
 * Cada producto puede llevar `ret`:
 *   undefined → nunca se configuró (la plantilla inicial puede marcarlo)
 *   false     → no es retornable
 *   { type, regime, assign }
 *       type   → tipo de envase para agrupar en reportes ('350', '1,25'…);
 *                vacío = el producto va aparte, con su propio total
 *       regime → 'contraentrega' (vacío obligatorio al entregar) | 'prestamo'
 *       assign → admite vacíos asignados
 * Se edita en Oficina → Inventario → producto → «Envase retornable».
 * ========================================================================= */
(function (global) {
  'use strict';

  // Plantilla inicial (Fase 2). Los códigos se corrigen después desde la app.
  const TEMPLATE = [
    { code: '669', type: '350' }, { code: '667', type: '350' }, { code: '670', type: '350' },
    { code: '672', type: '350' }, { code: '2350', type: '350' }, { code: '00123', type: '350' },
    { code: '102', type: '1,25', regime: 'contraentrega', assign: true },
    { code: 'COLIC', type: '1,25', regime: 'contraentrega', assign: true },
    { code: '1305', type: '' }, { code: '1241', type: '' }, { code: '7592243003359', type: '' },
  ];
  const REGIMES = { contraentrega: 'Contraentrega', prestamo: 'Préstamo' };

  const normCode = (c) => String(c == null ? '' : c).trim().toUpperCase();
  const isReturnable = (p) => !!(p && p.ret && typeof p.ret === 'object');
  const info = (p) => (isReturnable(p) ? { type: String(p.ret.type || ''), regime: p.ret.regime === 'contraentrega' ? 'contraentrega' : 'prestamo', assign: !!p.ret.assign } : null);

  /**
   * Aplica la plantilla a los productos que nunca se configuraron.
   * Devuelve los productos a guardar y los códigos de la plantilla que no existen en el catálogo.
   */
  function applyTemplate(products) {
    const docs = [], missing = [];
    TEMPLATE.forEach((t) => {
      const hits = products.filter((p) => !p.deleted && (normCode(p.code) === t.code || normCode(p.unitCode) === t.code));
      if (!hits.length) { missing.push(t.code); return; }
      hits.forEach((p) => {
        if (p.ret !== undefined || docs.some((d) => d.id === p.id)) return;
        docs.push({ ...p, ret: { type: t.type, regime: t.regime || 'prestamo', assign: !!t.assign } });
      });
    });
    return { docs, missing };
  }

  /** Etiqueta corta para listas: «♻ 350 · contraentrega». */
  function label(p) {
    const r = info(p); if (!r) return '';
    return '♻ ' + (r.type || 'aparte') + (r.regime === 'contraentrega' ? ' · contraentrega' : '') + (r.assign ? ' · asignables' : '');
  }

  /* ---------------- Vacíos de un pedido y de una hoja (E2) ----------------
   * Un vacío es una caja: solo cuentan las cajas (CJ) de productos retornables.
   * Asignados (o.envAssign.qty[productId]): solo en productos que los admiten.
   *   clave ausente → sin decidir · 0 → se decidió no asignar · N → asignados
   * o.envAssign.has: '¿el cliente tiene vacíos?' → 'si' | 'no' | (ausente = sin responder)
   */
  function assignedOf(o, pid) {
    const q = o && o.envAssign && o.envAssign.qty;
    return q && Object.prototype.hasOwnProperty.call(q, pid) && q[pid] !== null && q[pid] !== '' ? Math.max(0, +q[pid] || 0) : null;
  }

  /** Vacíos de un pedido: total, por producto, contraentrega, asignados y a recibir. */
  function orderVac(o, productsById) {
    const out = { total: 0, contra: 0, assigned: null, toReceive: 0, lines: [] };
    Object.entries((o && o.lines) || {}).forEach(([pid, l]) => {
      const r = info(productsById.get(pid)); const boxes = +l.cajas || 0;
      if (!r || !boxes) return;
      const a = r.assign ? assignedOf(o, pid) : null;
      out.total += boxes;
      if (r.regime === 'contraentrega') out.contra += boxes;
      if (a !== null) out.assigned = (out.assigned || 0) + Math.min(a, boxes);
      out.lines.push({ pid, code: l.code, name: l.name, boxes, regime: r.regime, assign: r.assign, assigned: a });
    });
    out.toReceive = Math.max(0, out.contra - (out.assigned || 0));
    return out;
  }

  /**
   * Productos que admiten asignados y aparecen en estos pedidos, agrupados por
   * tipo de envase (una sola fila ASIGNADOS 1,25 para 102 y COLIC). Un producto
   * sin tipo va en su propio grupo.
   */
  function assignableIn(orders, productsById) {
    const m = new Map();
    orders.forEach((o) => Object.entries(o.lines || {}).forEach(([pid, l]) => {
      const r = info(productsById.get(pid));
      if (!r || !r.assign || !((+l.cajas || 0) > 0)) return;
      const key = r.type ? 't:' + r.type : 'p:' + pid;
      const g = m.get(key) || { key, label: r.type || l.code, pids: [], items: [] };
      if (!g.pids.includes(pid)) { g.pids.push(pid); g.items.push({ pid, code: l.code, name: l.name }); }
      m.set(key, g);
    }));
    return [...m.values()];
  }

  /**
   * Datos de vacíos de una hoja (columnas = pedidos en el orden de la hoja).
   * Devuelve las filas de pie: VACÍOS POR CLIENTE, ASIGNADOS <código> y A RECIBIR.
   */
  function sheetRows(orders, productsById) {
    const vac = orders.map((o) => orderVac(o, productsById));
    const sum = (a) => a.reduce((x, y) => x + (y || 0), 0);
    const rows = [{ key: 'VACIOS_CLIENTE', label: 'VACÍOS POR CLIENTE', cells: vac.map((v) => v.total) }];
    const asg = assignableIn(orders, productsById);
    asg.forEach((g) => rows.push({ key: 'ASIGNADOS', group: g, label: 'ASIGNADOS ' + g.label, assign: true,
      // Por cliente: suma de sus productos del grupo · null = ninguno decidido · undefined = no lleva ese envase
      cells: orders.map((o) => {
        const mine = g.pids.filter((pid) => (o.lines || {})[pid] && (+o.lines[pid].cajas || 0) > 0);
        if (!mine.length) return undefined;
        const vals = mine.map((pid) => assignedOf(o, pid)).filter((v) => v !== null);
        return vals.length ? vals.reduce((a, b) => a + b, 0) : null;
      }) }));
    if (vac.some((v) => v.contra)) rows.push({ key: 'A_RECIBIR', label: 'A RECIBIR (contraentrega)', cells: vac.map((v) => v.toReceive) });
    rows.forEach((r) => { r.total = sum(r.cells); });
    return rows;
  }

  /** ¿La columna extra de la hoja impresa es la de VACÍOS? */
  const isVacCol = (name) => normCode(name).normalize('NFD').replace(/[\u0300-\u036f]/g, '') === 'VACIOS';

  global.Envases = { TEMPLATE, REGIMES, normCode, isReturnable, info, applyTemplate, label, assignedOf, orderVac, assignableIn, sheetRows, isVacCol };
})(window);
