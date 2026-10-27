/* =========================================================================
 * revision.js — Cobranzas revisa las hojas de carga (D4).
 *
 * La oficina envía la hoja (📤, campo cobSent de la hoja). Cobranzas ve cada cliente con su pedido en $, bultos y
 * unidades, su deuda, semáforo, límite y disponible, y decide: ✅ crédito · 💵 contado · ⏸ retener (o ajusta el límite).
 * La decisión la guarda el servidor dentro de la hoja (cobRev, acción «revisar» de /pagos): dos personas revisando a
 * la vez no se pisan y la oficina la ve con la hoja, aun sin internet. Si el pedido cambia de monto, vuelve a revisión.
 * Por ahora es un aviso que no bloquea; en Ajustes se puede volver obligatoria antes de aprobar la hoja.
 * ========================================================================= */
(function (global) {
  'use strict';
  const PV = () => global.PV;
  const EST = { aprobado: { icon: '✅', label: 'Crédito', cls: 'en_carga' }, contado: { icon: '💵', label: 'Contado', cls: 'abierto' }, retener: { icon: '⏸', label: 'Retenido', cls: 'over' } };
  // Decisiones recién guardadas, hasta que la hoja llegue con ellas por la sincronización
  const fresh = new Map();

  function revOf(load) {
    const f = fresh.get(load.id), at = (load.fv && load.fv.cobRev) || '';
    if (f && f.at > at) return f.rev;
    if (f) fresh.delete(load.id);
    return load.cobRev || {};
  }
  /** Estado de la revisión de una hoja: enviada, revisados, pendientes y retenidos. */
  function status(load, os) {
    const rev = revOf(load), out = { sent: !!(load.cobSent && load.cobSent.at), total: os.length, decided: 0, pending: 0, changed: 0, ret: [], contado: [], by: {} };
    os.forEach((o) => {
      const r = rev[o.id];
      if (!r) { out.pending++; return; }
      if (Math.abs((+r.monto || 0) - global.Matrix.orderTotals(o).monto) > 0.5) { out.pending++; out.changed++; out.by[o.id] = { ...r, changed: true }; return; }
      out.decided++; out.by[o.id] = r;
      if (r.estado === 'retener') out.ret.push(o); else if (r.estado === 'contado') out.contado.push(o);
    });
    return out;
  }
  /** Etiqueta de la decisión de cobranzas para un pedido de la hoja. */
  function chip(load, o, g) {
    const P = PV(), esc = P.esc, x = (g || status(load, [o])).by[o.id];
    if (!x) return load.cobSent && load.cobSent.at ? ' <span class="status espera" title="Cobranzas aún no lo revisa">🧾 por revisar</span>' : '';
    if (x.changed) return ` <span class="status en_espera" title="Cobranzas lo revisó por ${esc(P.usd(x.monto))}; el pedido cambió">🧾 cambió · revisar de nuevo</span>`;
    const e = EST[x.estado]; if (!e) return '';
    return ` <span class="status ${e.cls}" title="${esc(`Cobranzas: ${e.label} · ${x.by || ''} · ${new Date(x.at).toLocaleString('es-VE')}${x.nota ? ' · ' + x.nota : ''}`)}">${e.icon} ${esc(e.label)}${x.nota ? ': ' + esc(x.nota) : ''}</span>`;
  }
  /** Bloque de la hoja en la oficina: enviar a cobranzas y cómo va la revisión. */
  function officeBlock(load, os, canSend) {
    const P = PV(), { esc, fmtDate } = P;
    if (!os.length) return '';
    const g = status(load, os), ob = !!(P.S.config && P.S.config.cobObligatoria);
    if (!g.sent) return canSend ? `<div class="hint no-print">🧾 ${ob ? '<b>Cobranzas debe aprobar esta hoja antes de aprobarla.</b>' : 'Cobranzas aún no ve esta hoja.'} <button type="button" class="btn btn-sm btn-primary" id="dCob">📤 Enviar a cobranzas</button></div>` : '';
    const done = !g.pending && !g.ret.length;
    return `<div class="hint ${done ? '' : 'warn'} no-print">🧾 <b>Enviada a cobranzas</b> ${esc(fmtDate(String(load.cobSent.at).slice(0, 10)))}${load.cobSent.by ? ' por ' + esc(load.cobSent.by) : ''} · revisados <b>${g.decided}/${g.total}</b>${g.pending ? ` · <b>${g.pending} por revisar</b>${g.changed ? ` (${g.changed} cambiaron)` : ''}` : ''}${g.contado.length ? ` · 💵 ${g.contado.length} de contado` : ''}${g.ret.length ? ` · <b class="warn-txt">⏸ ${g.ret.length} retenido${g.ret.length > 1 ? 's' : ''}: ${g.ret.map((o) => esc(o.clientName)).join(', ')}</b> (pásalo${g.ret.length > 1 ? 's' : ''} a espera o pide a cobranzas que cambie la decisión)` : ''}${done ? ' · ✅ lista' : ''}${ob ? ' · <i>obligatoria</i>' : ''}</div>`;
  }
  /** Pedido en espera que cobranzas retuvo: su nota (para que se vea por qué está ahí). */
  function heldNote(o) {
    for (const l of PV().S.loads) {
      if (l.deleted || !l.cobRev) continue;
      const r = revOf(l)[o.id];
      if (r && r.estado === 'retener') return ` <span class="status over" title="${PV().esc(`${r.by || ''} · ${new Date(r.at).toLocaleString('es-VE')}`)}">⏸ Retenido por cobranzas${r.nota ? ': ' + PV().esc(r.nota) : ''}</span>`;
    }
    return '';
  }
  /** Antes de aprobar o cerrar la hoja: obligatoria → bloquea; si no, solo pregunta. Devuelve false para no seguir. */
  function gate(load, os, stName) {
    const P = PV(), g = status(load, os), ob = !!(P.S.config && P.S.config.cobObligatoria);
    if (ob && (!g.sent || g.pending || g.ret.length)) {
      P.toast(!g.sent ? 'La aprobación de cobranzas es obligatoria: envía la hoja a cobranzas primero (📤)' : g.ret.length ? `Cobranzas retuvo ${g.ret.length} cliente(s): pásalos a espera o pide que cambien la decisión` : `Cobranzas aún no revisa ${g.pending} cliente(s) de esta hoja`, 'err');
      return false;
    }
    if (g.sent && (g.pending || g.ret.length)) {
      return confirm(`🧾 Revisión de cobranzas incompleta:\n${g.pending ? `\n• ${g.pending} cliente(s) sin revisar` : ''}${g.ret.length ? `\n• Retenidos: ${g.ret.map((o) => o.clientName).join(', ')}` : ''}\n\n¿${stName} igual?`);
    }
    return true;
  }
  /** Hojas enviadas a cobranzas y aún sin cerrar (lo que ya está en el equipo). */
  function sentLoads() {
    const S = PV().S, L = global.Loads, byId = new Map(S.orders.map((o) => [o.id, o]));
    return S.loads.filter((l) => !l.deleted && l.cobSent && l.cobSent.at && !L.isClosed(l)).map((l) => {
      const os = L.loadOrders(l, byId);
      return { l, os, g: status(l, os), st: L.statusOf(l, S.config) };
    }).filter((x) => x.os.length);
  }
  const pendingCount = () => sentLoads().filter((x) => !x.st.locked && x.g.pending).length;

  /* ---------------- Pantalla de Cobranzas: Hojas por aprobar ---------------- */
  let creds = null, credsAt = 0, credsFail = 0;
  async function loadCreds(force) {
    if (!force && creds && Date.now() - credsAt < 120000) return creds;
    const r = await global.Sync.pagosCall({ action: 'creditos' });
    if (r.ok) { creds = new Map(r.data.clientes.map((k) => [k.clientId, k])); credsAt = Date.now(); } else credsFail = Date.now();
    return creds;
  }
  function render(root) {
    const P = PV(), S = P.S, ui = (S.ui.cobHojas = S.ui.cobHojas || { id: null });
    const x = ui.id && sentLoads().find((y) => y.l.id === ui.id);
    if (x) return detail(root, x);
    ui.id = null;
    const { esc, usd, fmtDate } = P, list = sentLoads().sort((a, b) => (!a.st.locked && a.g.pending ? 0 : 1) - (!b.st.locked && b.g.pending ? 0 : 1) || String(a.l.cobSent.at).localeCompare(String(b.l.cobSent.at)));
    root.innerHTML = `<p class="muted">La oficina envía aquí sus hojas de carga. Revisa cada cliente y decide: <b>✅ crédito</b>, <b>💵 contado</b> o <b>⏸ retener</b>. ${S.config && S.config.cobObligatoria ? 'La oficina <b>no puede aprobar</b> la hoja hasta que la revises.' : 'Por ahora es un aviso para la oficina: no bloquea la hoja.'}</p>
      <div class="row" style="justify-content:flex-end"><button class="btn btn-sm" id="chSync">⟳ Actualizar</button></div>
      ${list.length ? `<div class="load-grid">${list.map(({ l, os, g, st }) => `<button class="load-card ${st.locked ? 'locked' : ''}" data-hid="${esc(l.id)}">
        <div class="row"><b class="grow">${esc(global.Loads.labelOf(l))}</b><span class="status ${!g.pending && !g.ret.length ? 'en_carga' : 'espera'}">${g.decided}/${g.total} revisados</span></div>
        <div class="muted">${esc(l.sellerName || '')} · Ruta ${esc(l.route || '—')} · enviada ${esc(fmtDate(String(l.cobSent.at).slice(0, 10)))}</div>
        <div class="row"><span>${os.length} clientes · <b>${usd(os.reduce((a, o) => a + global.Matrix.orderTotals(o).monto, 0))}</b></span><span class="grow"></span>${g.ret.length ? `<span class="status over">⏸ ${g.ret.length}</span>` : ''}${st.locked ? `<span class="status locked">🔒 ${esc(st.name)}</span>` : ''}</div></button>`).join('')}</div>`
        : '<div class="empty card"><strong>No hay hojas por revisar</strong>Cuando la oficina envíe una hoja de carga a cobranzas, aparece aquí.</div>'}`;
    root.querySelector('#chSync').onclick = () => P.runSync(true);
    root.onclick = (e) => { const c = e.target.closest('[data-hid]'); if (c) { ui.id = c.dataset.hid; render(root); } };
  }
  async function detail(root, x) {
    const P = PV(), S = P.S, { esc, usd } = P, { l, os } = x, g = status(l, os), M = global.Matrix, C = global.Cobranza;
    // Sin internet o si la consulta falló: lo guardado en el equipo (semáforo, deuda y límite)
    const cr = creds || (!navigator.onLine || Date.now() - credsFail < 60000 ? new Map() : null);
    const k0 = (cid) => (cr && cr.get(cid)) || null, mk = (cid) => (C ? C.markOf(cid) : null);
    const row = (o, i) => {
      const t = M.orderTotals(o), k = k0(o.clientId), m = mk(o.clientId), r = g.by[o.id];
      const sem = k ? k.semaforo : m && m.s, deuda = k ? k.deuda : m ? m.d : null, ven = k ? k.vencido : m ? m.v : null, lim = k ? k.limite : m ? m.l : 0, modo = k ? k.modo : m && m.m;
      const disp = lim > 0 && deuda !== null ? Math.round((lim - deuda - t.monto) * 100) / 100 : null;
      const btn = (est) => `<button type="button" class="btn btn-sm ${r && !r.changed && r.estado === est ? 'btn-primary' : ''}" data-rv="${esc(o.id)}" data-est="${est}">${EST[est].icon} ${EST[est].label === 'Retenido' ? 'Retener' : EST[est].label}</button>`;
      return `<tr><td>${i + 1}</td><td style="min-width:210px"><b>${esc(o.clientName)}</b> <span class="muted">${esc(o.sellerName || '')}</span>${modo === 'contado' ? ' <b class="warn-txt">CONTADO</b>' : modo === 'nuevo' ? ' <span class="status abierto">🆕 nuevo · contado</span>' : ''}${chip(l, o, g)}${k && k.nota ? `<div class="muted" style="font-size:12px">📝 ${esc(k.nota)}</div>` : ''}</td>
        <td class="n" data-l="Bultos">${t.bultos}</td><td class="n" data-l="Unid.">${t.totalUnidades}</td><td class="n" data-l="Pedido"><b>${usd(t.monto)}</b></td>
        <td data-l="Semáforo" title="${esc((C && C.SEM[sem]) || 'sin datos')}">${(C && C.DOT[sem]) || '·'}</td>
        <td class="n" data-l="Debe">${deuda ? `<button type="button" class="btn btn-sm" data-cob-of="${esc(o.sellerId || '')}|${esc(o.clientId)}" title="Ver su estado de cuenta">${usd(deuda)}</button>` : deuda === 0 ? '—' : '·'}</td>
        <td class="n ${ven ? 'warn-txt' : ''}" data-l="Vencido">${ven ? usd(ven) : ''}</td>
        <td class="n" data-l="Límite">${lim ? usd(lim) : '—'}</td>
        <td class="n ${disp !== null && disp < 0 ? 'warn-txt' : ''}" data-l="Disponible">${disp === null ? '' : disp < 0 ? 'pasa ' + usd(-disp) : usd(disp)}</td>
        <td style="white-space:nowrap">${btn('aprobado')} ${btn('contado')} ${btn('retener')} ${r ? `<button type="button" class="btn btn-sm" data-rv="${esc(o.id)}" data-est="" title="Quitar la decisión">↺</button>` : ''} ${k ? `<button type="button" class="btn btn-sm" data-lim="${esc(o.clientId)}" title="Ajustar condición y límite de crédito">✎ Límite</button>` : ''}</td></tr>`;
    };
    const tot = os.reduce((a, o) => { const t = M.orderTotals(o); a.b += t.bultos; a.u += t.totalUnidades; a.m += t.monto; return a; }, { b: 0, u: 0, m: 0 });
    root.innerHTML = `<div class="toolbar"><button class="btn" id="chBack">← Hojas por aprobar</button>
        <div class="grow"><h2 style="margin:0">${esc(global.Loads.labelOf(l))}</h2><div class="muted">${esc(l.sellerName || '')} · Ruta ${esc(l.route || '—')} · ${esc(x.st.name)}</div></div>
        <button class="btn btn-sm" id="chRe">⟳ Actualizar</button></div>
      <div class="hint ${g.pending || g.ret.length ? 'warn' : ''}">Revisados <b>${g.decided}/${g.total}</b>${g.pending ? ` · ${g.pending} por revisar` : ' · ✅ hoja revisada'}${g.ret.length ? ` · ⏸ ${g.ret.length} retenido(s)` : ''}${x.st.locked ? ` · la oficina ya la pasó a 🔒 ${esc(x.st.name)}` : ''}</div>
      ${cr ? '' : '<p class="muted" id="chLoad">Consultando crédito de los clientes…</p>'}${!navigator.onLine ? '<div class="hint warn">Sin internet: se muestran los datos guardados; para decidir hace falta conexión.</div>' : ''}
      <div class="table-wrap"><table class="inv"><thead><tr><th>#</th><th>Cliente</th><th class="n">Bultos</th><th class="n">Unid.</th><th class="n">Pedido $</th><th>Sem.</th><th class="n">Debe</th><th class="n">Vencido</th><th class="n">Límite</th><th class="n">Disponible</th><th>Decisión</th></tr></thead>
        <tbody>${os.map(row).join('')}</tbody>
        <tfoot><tr><td></td><td><b>Total</b></td><td class="n"><b>${tot.b}</b></td><td class="n"><b>${tot.u}</b></td><td class="n"><b>${usd(Math.round(tot.m * 100) / 100)}</b></td><td colspan="6"></td></tr></tfoot></table></div>`;
    root.querySelector('#chBack').onclick = () => { S.ui.cobHojas.id = null; render(root); };
    root.querySelector('#chRe').onclick = async () => { await loadCreds(true); P.runSync(true); render(root); };
    root.onclick = async (e) => {
      const lb = e.target.closest('[data-lim]');
      if (lb) { const k = k0(lb.dataset.lim); if (k && C) C.creditEdit(k, (lst) => { creds = new Map(lst.map((z) => [z.clientId, z])); credsAt = Date.now(); render(root); }); return; }
      const b = e.target.closest('[data-rv]'); if (!b) return;
      const o = os.find((y) => y.id === b.dataset.rv), est = b.dataset.est; if (!o) return;
      let nota = '';
      if (est === 'retener') { nota = prompt(`¿Por qué se retiene a ${o.clientName}? (lo ven la oficina y el vendedor)`, (g.by[o.id] && g.by[o.id].nota) || 'Tiene deuda pendiente'); if (nota === null) return; }
      b.disabled = true;
      const res = await global.Sync.pagosCall({ action: 'revisar', loadId: l.id, orderId: o.id, estado: est, nota: nota.trim() });
      b.disabled = false;
      if (!res.ok) { P.toast(res.error || 'No se pudo guardar', 'err'); if (res.status === 409) P.runSync(true); return; }
      fresh.set(l.id, { at: res.data.at, rev: res.data.cobRev });
      P.logEvent('cobranzas_revision', `Cobranzas: ${o.clientName} (${o.sellerName}) → ${est ? EST[est].label : 'sin decisión'}${nota ? ' · ' + nota : ''} · hoja ${global.Loads.labelOf(l)}`, { orderId: o.id, clientName: o.clientName, loadId: l.id });
      P.toast(`${o.clientName}: ${est ? EST[est].label : 'sin decisión'}`, 'ok');
      render(root); P.runSync(false);
    };
    if (!cr) { await loadCreds(); if (S.ui.cobHojas.id === l.id && root.isConnected && document.getElementById('chLoad')) render(root); }
  }

  global.Revision = { status, chip, officeBlock, heldNote, gate, sentLoads, pendingCount, render, EST };
})(window);
