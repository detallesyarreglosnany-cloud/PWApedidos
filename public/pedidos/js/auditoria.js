/**
 * Auditoría de hojas, liquidaciones y notas (Oficina → Hojas de carga → 🔎 Auditoría).
 * SOLO LEE: no cambia ningún dato. Revisa lo que este equipo tiene descargado y lista lo que hay que corregir
 * con las herramientas de siempre (cada caso abre su hoja).
 */
(function (global) {
  'use strict';
  const DAY = 86400000;
  const digits = (v) => String(v == null ? '' : v).replace(/\D/g, '').replace(/^0+(?=\d)/, '');

  /** Lista de hallazgos: { sec, level: 'error'|'revisar'|'info', text, loadId?, orderId? } */
  function run(S, today) {
    const out = [], add = (sec, level, text, ref) => out.push({ sec, level, text, ...(ref || {}) });
    const loads = S.loads.filter((l) => !l.deleted), orders = S.orders.filter((o) => !o.deleted);
    const loadById = new Map(loads.map((l) => [l.id, l])), orderById = new Map(orders.map((o) => [o.id, o]));
    const clientById = new Map(S.clients.map((c) => [c.id, c]));
    const lab = (l) => `${Loads.labelOf(l)}${l.number ? ' ' + Loads.loadCode(l) : ''}`;
    const dayOf = (l) => l.date || String(l.closedAt || '').slice(0, 10);
    const ago = (d) => (d ? Math.floor((Date.parse(today) - Date.parse(d)) / DAY) : 0);
    const isRet = (l) => Loads.isRetiro(l);

    // 1 · Hojas ↔ pedidos
    const inLoads = new Map();
    loads.forEach((l) => (l.orderIds || []).forEach((id) => { (inLoads.get(id) || inLoads.set(id, []).get(id)).push(l.id); }));
    inLoads.forEach((ids, oid) => {
      const o = orderById.get(oid); if (!o) return;
      if (ids.length > 1) add('Hojas y pedidos', 'error', `${o.clientName} (${o.sellerName}) está en ${ids.length} hojas: ${ids.map((id) => lab(loadById.get(id))).join(' y ')}`, { loadId: ids[0], orderId: oid });
      ids.forEach((lid) => { if (o.loadId && o.loadId !== lid && ids.length === 1) add('Hojas y pedidos', 'error', `${o.clientName} (${o.sellerName}) aparece en ${lab(loadById.get(lid))} pero el pedido dice que va en ${loadById.get(o.loadId) ? lab(loadById.get(o.loadId)) : 'una hoja que no existe'}`, { loadId: lid, orderId: oid }); });
    });
    orders.forEach((o) => {
      if (!o.loadId) return;
      const l = loadById.get(o.loadId);
      if (!l) add('Hojas y pedidos', 'error', `${o.clientName} (${o.sellerName}, ${o.routeDate || ''}) dice que va en una hoja borrada o que no existe`, { orderId: o.id });
      else if (!(l.orderIds || []).includes(o.id) && !inLoads.has(o.id)) add('Hojas y pedidos', 'error', `${o.clientName} (${o.sellerName}) dice que va en ${lab(l)}, pero esa hoja no lo tiene`, { loadId: l.id, orderId: o.id });
    });

    // 2 · Liquidaciones
    loads.forEach((l) => {
      const done = Liq.isDone(l), closed = Loads.isClosed(l), d = dayOf(l);
      if (closed && !done) {
        const n = ago(d);
        if (l.liq) add('Cargas y liquidaciones en el aire', n > 2 ? 'error' : 'revisar', `${lab(l)} (${d}) · liquidación en BORRADOR hace ${n} día(s) · ${l.dispatcherName || 'sin despachador'}`, { loadId: l.id });
        else if (n > 2) add('Cargas y liquidaciones en el aire', 'error', `${lab(l)} (${d}) · cerrada hace ${n} días y SIN LIQUIDAR · ${l.dispatcherName || 'sin despachador'}`, { loadId: l.id });
      }
      if ((closed || done) && !isRet(l) && !l.dispatcherId) add('Despachadores', 'error', `${lab(l)} (${d}) no tiene despachador: sus ventas no se le suman a nadie`, { loadId: l.id });
      if (done && l.liq.carry && l.liq.carry.dispatcherId && l.dispatcherId && l.liq.carry.dispatcherId !== l.dispatcherId) add('Despachadores', 'error', `${lab(l)}: lo que quedó en el camión quedó a nombre de otro despachador que el de la hoja (${l.dispatcherName || ''})`, { loadId: l.id });
      if (!done) return;
      // Cada pedido de una hoja liquidada debe traer su entrega de ESE cierre; si no, no entra al reporte quincenal
      (l.orderIds || []).forEach((id) => {
        const o = orderById.get(id); if (!o) return;
        const dl = o.delivery;
        if (!dl || dl.loadId !== l.id) add('Liquidaciones', 'error', `${lab(l)} (${d}) · ${o.clientName}: la hoja está liquidada pero el pedido no tiene la entrega de esta hoja (no entra al reporte quincenal)`, { loadId: l.id, orderId: o.id });
        else if (dl.at !== l.liq.closedAt) add('Liquidaciones', 'error', `${lab(l)} (${d}) · ${o.clientName}: la entrega del pedido no es la del último cierre de la liquidación (no entra al reporte quincenal). Reabrir y volver a cerrar la liquidación lo corrige`, { loadId: l.id, orderId: o.id });
      });
    });
    // Lo que quedó en un camión y ninguna hoja ha tomado
    Liq.pendingCarries(loads).forEach((x) => {
      const n = ago(String(x.load.liq.closedAt || '').slice(0, 10));
      if (n >= 3) add('Cargas y liquidaciones en el aire', 'revisar', `${lab(x.load)} · ${x.keys.length} producto(s) siguen en el camión de ${x.load.dispatcherName || '—'} hace ${n} días sin que otra hoja los tome`, { loadId: x.load.id });
    });

    // 3 · Vendedores: pedido a nombre de un vendedor distinto al del cliente (últimos 60 días)
    orders.forEach((o) => {
      if (!o.loadId || ago(o.routeDate) > 60) return;
      const c = clientById.get(o.clientId);
      if (c && c.sellerId && o.sellerId && c.sellerId !== o.sellerId) {
        const sv = S.sellers.find((s) => s.id === c.sellerId);
        add('Vendedores', 'revisar', `${o.clientName} (${o.routeDate}): el pedido es de ${o.sellerName} pero el cliente es de ${sv ? sv.name : 'otro vendedor'}${loadById.get(o.loadId) ? ' · ' + lab(loadById.get(o.loadId)) : ''}`, { loadId: o.loadId, orderId: o.id });
      }
    });

    // 4 · Notas Valery: pegadas (dos notas sin «-») y repetidas
    const byNote = new Map();
    orders.forEach((o) => {
      const raw = String(o.valeryNote || ''); if (!raw) return;
      const parts = raw.split('-').map(digits).filter(Boolean);
      if (parts.some((p) => p.length >= 9)) add('Notas', 'error', `${o.clientName} (${o.sellerName}, ${o.routeDate || ''}): nota «${raw}» parece DOS notas pegadas. Corrígela separándolas con «-»`, { loadId: o.loadId || '', orderId: o.id });
      parts.forEach((p) => (byNote.get(p) || byNote.set(p, []).get(p)).push(o));
    });
    byNote.forEach((os, n) => {
      const ids = new Set(os.map((o) => o.pendingFrom || o.id)); // la copia de «se entrega después» lleva la misma nota
      if (ids.size > 1) add('Notas', 'revisar', `Nota ${n} repetida en: ${os.map((o) => `${o.clientName} (${o.routeDate || ''})`).join(' · ')}`, { loadId: os[0].loadId || '', orderId: os[0].id });
    });

    // 5 · Envases retornables
    const rets = S.products.filter((p) => !p.deleted && Envases.isReturnable(p));
    const codes = new Map(S.products.filter((p) => !p.deleted).map((p) => [Envases.normCode(p.code), p]));
    rets.forEach((p) => {
      const r = Envases.info(p), sameCode = r.type && codes.get(Envases.normCode(r.type));
      add('Envases retornables', 'info', `${p.code} ${p.name} ${p.presentation || ''} · ${r.type ? 'tipo ' + r.type : 'aparte (se cuenta con su código)'} · ${r.regime === 'contraentrega' ? 'contraentrega' : 'préstamo'}${r.assign ? ' · asignables' : ''}`);
      if (sameCode && sameCode.id !== p.id) {
        // Solo se mezclan las cuentas si el otro producto también es retornable «aparte» (se cuenta con su código)
        const o = Envases.info(sameCode), mezcla = !!o && !o.type;
        add('Envases retornables', mezcla ? 'error' : 'info', mezcla
          ? `Los vacíos de ${sameCode.code} ${sameCode.name} (aparte, se cuentan con su código) se MEZCLAN con el tipo de envase «${r.type}» de ${p.code} ${p.name}. Avísale a soporte antes de cambiar nada (cambiar el tipo separa los saldos ya registrados)`
          : `Ojo: «${r.type}» es el TIPO de envase de ${p.code} ${p.name}, no el código ${sameCode.code} (${sameCode.name}, que no es retornable). No se mezclan cuentas; no cambies el tipo (separaría los saldos de vacíos ya registrados)`);
      }
    });
    const byType = new Map();
    rets.forEach((p) => { const t = Envases.info(p).type; if (t) (byType.get(t) || byType.set(t, []).get(t)).push(p); });
    byType.forEach((ps, t) => {
      const sizes = [...new Set(ps.map((p) => Matrix.sizeOf(p)).filter(Boolean))];
      if (sizes.length > 1) add('Envases retornables', 'revisar', `El tipo «${t}» junta envases de tamaños distintos: ${ps.map((p) => `${p.code} ${p.presentation || ''}`).join(' · ')}`);
    });
    return out;
  }

  const SECS = ['Hojas y pedidos', 'Liquidaciones', 'Cargas y liquidaciones en el aire', 'Despachadores', 'Vendedores', 'Notas', 'Envases retornables'];
  const ICON = { error: '⛔', revisar: '⚠️', info: 'ℹ️' };

  function sheet() {
    const P = global.PV, { S, esc, toast } = P;
    const res = run(S, P.today()), errs = res.filter((x) => x.level === 'error').length, rev = res.filter((x) => x.level === 'revisar').length;
    const text = () => `AUDITORÍA ${P.today()} · ${errs} errores · ${rev} por revisar\n` + SECS.map((s) => { const xs = res.filter((x) => x.sec === s); return xs.length ? `\n${s.toUpperCase()}\n` + xs.map((x) => `${ICON[x.level]} ${x.text}`).join('\n') : ''; }).join('');
    const sh = P.openSheet(`<div class="row"><h2 class="grow">🔎 Auditoría de hojas y liquidaciones</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Solo revisa: <b>no cambia ningún dato</b>. Mira lo que este equipo tiene descargado (${S.loads.filter((l) => !l.deleted).length} hojas, ${S.orders.filter((o) => !o.deleted).length} pedidos). Cada caso abre su hoja para corregirlo.</p>
      <div class="kpi-row"><div class="kpi"><small>Errores</small><b class="${errs ? 'warn-txt' : ''}">${errs}</b></div><div class="kpi"><small>Por revisar</small><b>${rev}</b></div></div>
      <div class="toolbar"><button class="btn" id="auCopy">📋 Copiar informe</button></div>
      ${SECS.map((s) => { const xs = res.filter((x) => x.sec === s); const bad = xs.filter((x) => x.level !== 'info').length;
        return `<details class="card card-pad au-sec" ${bad ? 'open' : ''}><summary><b>${esc(s)}</b> <span class="muted">${bad ? `${bad} caso(s)` : xs.length ? 'todo bien' : 'todo bien'}</span></summary>
          ${xs.length ? xs.map((x) => `<div class="au-row au-${x.level}">${ICON[x.level]} ${esc(x.text)}${x.loadId ? ` <button class="btn btn-sm" data-goto="${esc(x.loadId)}">Abrir hoja</button>` : ''}</div>`).join('') : '<div class="muted">✓ Sin hallazgos</div>'}</details>`; }).join('')}`, { wide: true });
    sh.el.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]'); if (g) { sh.close(); P.openLoad(g.dataset.goto); return; }
      if (e.target.closest('#auCopy')) P.copyText(text()).then((ok) => toast(ok === false ? 'No se pudo copiar' : 'Informe copiado', ok === false ? 'err' : 'ok'));
    });
  }

  global.Auditoria = { run, sheet };
})(window);
