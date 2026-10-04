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

  global.Envases = { TEMPLATE, REGIMES, normCode, isReturnable, info, applyTemplate, label };
})(window);
