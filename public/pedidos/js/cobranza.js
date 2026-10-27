/* =========================================================================
 * cobranza.js — Cuentas por cobrar (Fase 5).
 *
 * Cada nota despachada vence según lo que llevó (por omisión refrescos 8 días y lo
 * demás 15, desde que la carga quedó DESPACHADA; se cambia en Ajustes). El vendedor
 * ve a sus clientes agrupados por días que faltan (o de atraso), les manda por
 * WhatsApp el detalle con los datos para pagar, anota el seguimiento (le llega a la
 * oficina) y registra el pago. Al tomar un pedido nuevo, la app avisa si el cliente
 * debe (no bloquea) o si está al día. Una vez al día deja en la campana lo que vence
 * mañana, lo que vence hoy y lo atrasado.
 * ========================================================================= */
(function (global) {
  'use strict';
  const PV = () => global.PV;
  const SEG = { ya_pago: 'Ya pagó', no_paga: 'Aún no paga', datos_enviados: 'Se le enviaron los datos de pago', no_recibio: 'El cliente no ha recibido', sin_devolucion: 'No se le ha hecho la devolución', incompleto: 'No recibió completo' };
  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } };
  const key = (sid) => 'pv_cart:' + sid;

  /** Cartera del vendedor (del servidor; sin señal, la última guardada). */
  async function load(sid, force) {
    const c = lsGet(key(sid));
    if (!force && c && Date.now() - c.at < 20 * 60000) return c.data;
    if (!navigator.onLine) return c ? c.data : null;
    const r = await global.Sync.pagosCall({ action: 'cartera', sellerId: sid });
    if (r.ok) { lsSet(key(sid), { at: Date.now(), data: r.data }); notifyOnce(sid, r.data); return r.data; }
    if (r.status === 401 && r.error === 'PIN' && global.PinGate) global.PinGate.check({ force: true });
    return c ? c.data : null;
  }
  let busy = false;
  /** Se llama al abrir la pantalla de pedidos: refresca la cartera sin frenar nada. */
  async function refresh(sid, onFresh) {
    if (busy || !sid) return; busy = true;
    try {
      const before = lsGet(key(sid)), d = await load(sid);
      if (d && onFresh && (!before || Date.now() - before.at >= 20 * 60000)) onFresh(d);
    } finally { busy = false; }
  }

  const plural = (n, a, b) => (n === 1 ? a : b);
  const diasTxt = (d) => (d < 0 ? `${-d} ${plural(-d, 'día', 'días')} de atraso` : d === 0 ? 'vence HOY' : d === 1 ? 'vence mañana' : `vence en ${d} días`);

  /** Avisos en la campana, una vez al día: mañana vence, hoy vence, atrasados. */
  async function notifyOnce(sid, d) {
    const P = PV(); if (!P || !P.localNotif || !d) return;
    const day = d.hoy, mk = 'cobNotif:' + sid;
    try { if ((await global.DB.getMeta(mk, '')) === day) return; await global.DB.setMeta(mk, day); } catch (e) { return; }
    const names = (arr) => [...new Set(arr.map((n) => n.clientName))];
    const man = d.notas.filter((n) => n.dias === 1), hoy = d.notas.filter((n) => n.dias === 0), atr = d.notas.filter((n) => n.dias < 0);
    if (man.length) P.localNotif({ kind: 'cobro', icon: '📅', warn: true, msg: `Mañana vence el plazo de pago de: ${names(man).join(', ')}. Recuérdales que deben cancelar para hacer su nuevo pedido y mantener limpio su historial.` });
    if (hoy.length) P.localNotif({ kind: 'cobro', icon: '⏰', warn: true, msg: `HOY vence el plazo de pago de: ${names(hoy).join(', ')}.` });
    if (atr.length) P.localNotif({ kind: 'cobro', icon: '🚩', warn: true, msg: `${names(atr).length} cliente(s) con pagos atrasados: ${names(atr).slice(0, 6).join(', ')}${names(atr).length > 6 ? '…' : ''}. Esto afecta su crédito.` });
    if (man.length || hoy.length || atr.length) { if (P.beep) P.beep(); if (P.toast) P.toast('📅 Tienes cobros por hacer: revisa «Cobrar»', 'ok'); }
  }

  /** Aviso al tomar un pedido: el cliente debe (no bloquea) o está al día. */
  function hintFor(clientId) {
    const P = PV(), S = P.S, sid = S.session && S.session.sellerId; if (!sid || !clientId) return '';
    const c = lsGet(key(sid)); if (!c || !c.data) return '';
    const notas = c.data.notas.filter((n) => n.clientId === clientId), usd = P.usd, esc = P.esc;
    if (!notas.length) return (c.data.alDia || []).includes(clientId) ? '<div class="hint">✅ Cliente <b>al día</b> con sus pagos.</div>' : '';
    const total = notas.reduce((a, n) => a + n.resta, 0), peor = notas.reduce((a, n) => (n.dias < a.dias ? n : a), notas[0]);
    return `<div class="hint warn">💵 <b>Este cliente tiene ${notas.length} ${plural(notas.length, 'nota pendiente', 'notas pendientes')} por ${usd(total)}</b> · ${esc(diasTxt(peor.dias))}${peor.dias < 0 ? ' (afecta su crédito)' : ''}.
      Pídele que cancele para hacer su nuevo pedido. <button type="button" class="btn btn-sm" data-cob-cid="${esc(clientId)}">Ver sus notas</button></div>`;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-cob-cid]'); if (!b) return;
    const P = PV(), sid = P.S.session && P.S.session.sellerId; if (global.Pagos && sid) global.Pagos.cuentaSheet(sid, b.dataset.cobCid);
  });

  /* ---------------- WhatsApp ---------------- */
  function phoneOf(c) {
    let d = String((c && c.phone) || '').split(/[\/,;]| y /)[0].replace(/\D/g, '');
    if (!d) return '';
    if (d.startsWith('0')) d = '58' + d.slice(1); else if (d.length === 10 && d.startsWith('4')) d = '58' + d;
    return d.length >= 11 ? d : '';
  }
  function waText(client, notas) {
    const P = PV(), S = P.S, nf = new Intl.NumberFormat('es-VE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const rate = +S.config.exchangeRate || 0, seller = P.sellerById(S.session && S.session.sellerId) || {}, co = (S.config.company && S.config.company.name) || 'Distribuidora Puerto Venado';
    const f = (d) => (d ? d.split('-').reverse().join('/') : '');
    const lines = [`Hola ${client.name}, le saluda ${seller.name || 'su vendedor'} de ${co}.`, '', `Le recordamos ${notas.length === 1 ? 'su nota pendiente' : 'sus notas pendientes'}:`];
    notas.forEach((n) => {
      lines.push(`• Nota ${n.nota || '—'} · despachada el ${f(n.despacho)} · ${diasTxt(n.dias)} (${f(n.vence)}) · saldo $ ${nf.format(n.resta)}${rate ? ` (Bs ${nf.format(n.resta * rate)})` : ''}`);
      const o = P.orderById(n.orderId), d = o && o.delivery && o.delivery.at ? o.delivery : null, src = o ? (d ? d.lines : o.lines) || {} : {};
      Object.values(src).filter((l) => (+l.cajas || 0) || (+l.unidades || 0)).slice(0, 25).forEach((l) => lines.push(`   - ${l.cajas ? l.cajas + ' cj' : ''}${l.cajas && l.unidades ? ' + ' : ''}${l.unidades ? l.unidades + ' un' : ''} ${l.name} ${l.presentation || ''}`.replace(/\s+/g, ' ')));
    });
    const total = notas.reduce((a, n) => a + n.resta, 0);
    lines.push('', `*Total a pagar: $ ${nf.format(total)}${rate ? ` · Bs ${nf.format(total * rate)} (tasa ${nf.format(rate)})` : ''}*`);
    const acc = (S.config.payAccounts || []).filter((a) => a.bank);
    if (acc.length) { lines.push('', 'Datos para pagar:'); acc.forEach((a) => lines.push(`• ${a.bank}${a.kind === 'pago_movil' ? ' (pago móvil)' : a.kind === 'transferencia' ? ' (transferencia)' : ''} · ${a.number || ''}${a.holder ? ' · ' + a.holder : ''}${a.rif ? ' · ' + a.rif : ''}`)); }
    lines.push('', 'Al pagar, envíenos el comprobante por aquí. ¡Gracias por mantener su crédito al día! 🙌');
    return lines.join('\n');
  }
  function openWA(client, notas) {
    const ph = phoneOf(client), url = `https://wa.me/${ph}?text=${encodeURIComponent(waText(client, notas))}`;
    const a = document.createElement('a'); a.href = url; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    if (!ph) PV().toast('El cliente no tiene teléfono en su ficha: elige el contacto en WhatsApp', 'ok');
  }

  /* ---------------- Nota de despacho completa ---------------- */
  function notaSheet(n) {
    const P = PV(), { esc, usd, bs, fmtDate, openSheet, S } = P, o = P.orderById(n.orderId), rate = +S.config.exchangeRate || 0;
    const d = o && o.delivery && o.delivery.at ? o.delivery : null, src = o ? (d ? d.lines : o.lines) || {} : {}, l = o && o.loadId ? S.loads.find((x) => x.id === o.loadId) : null;
    const rows = Object.values(src).filter((x) => (+x.cajas || 0) || (+x.unidades || 0)).map((x) => { const m = (+x.cajas || 0) * (+x.boxPrice || 0) + (+x.unidades || 0) * (+x.unitPrice || 0); return `<tr><td>${esc(x.code || '')} ${esc(x.name)} ${esc(x.presentation || '')}</td><td class="num">${x.cajas || ''}${x.cajas && x.unidades ? ' + ' : ''}${x.unidades ? x.unidades + ' un' : ''}</td><td class="num">${usd(m)}</td></tr>`; }).join('');
    const c = P.clientById(n.clientId) || { name: n.clientName };
    const sh = openSheet(`<div class="row"><h2 class="grow">📄 Nota ${esc(n.nota || '—')}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="grid2" style="margin:6px 0 10px">${[['Cliente', c.name], ['RIF', c.rif || '—'], ['Ruta', (o && o.route) || '—'], ['Despachador', (d && d.dispatcherName) || (l && l.dispatcherName) || '—'], ['Despachada', fmtDate(n.despacho)], ['Vence', `${fmtDate(n.vence)} · ${diasTxt(n.dias)}`]].map(([k, v]) => `<div><small class="muted">${k}</small><div><b>${esc(v)}</b></div></div>`).join('')}</div>
      ${rows ? `<table class="lines"><thead><tr><th style="text-align:left">Producto</th><th class="num">Cantidad</th><th class="num">Monto</th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="muted">El detalle de productos no está en este teléfono (nota vieja).</p>'}
      <div class="row" style="justify-content:space-between;margin-top:8px;font-size:17px"><b>Total nota ${usd(n.monto)}</b><b>Saldo ${usd(n.resta)}${rate ? ' · ' + bs(n.resta * rate) : ''}</b></div>
      <div class="${n.estado === 'parcial' ? 'warn-txt' : 'muted'}" style="margin-top:4px">${esc(n.texto || '')}</div>
      ${(n.tramos || []).length > 1 ? `<p class="muted" style="font-size:13px">${n.tramos.map((t) => `${t.days} días: ${usd(t.monto)} (vence ${fmtDate(t.vence)}${t.resta < 0.01 ? ' · pagado' : ' · resta ' + usd(t.resta)})`).join(' · ')}</p>` : ''}
      <div class="actions"><button class="btn btn-primary" id="nsWA">📲 Enviar por WhatsApp</button><button class="btn" id="nsPay">💵 Registrar pago</button></div>`);
    sh.el.querySelector('#nsWA').onclick = () => openWA(c, [n]);
    sh.el.querySelector('#nsPay').onclick = () => { sh.close(); global.Pagos.payForm({ sellerId: S.session.sellerId, clientId: n.clientId, notaKey: n.key, onSaved: () => renderSeller(true) }); };
  }

  /* ---------------- Seguimiento de cobro ---------------- */
  function segSheet(client, notas, sid, onDone) {
    const P = PV(), { esc, openSheet, toast } = P;
    const sh = openSheet(`<div class="row"><h2 class="grow">📋 Seguimiento · ${esc(client.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Lo que pasó con el cobro. Le llega a la oficina para que lo valide.</p>
      <label class="field"><span>Nota</span><select id="sgN" class="select">${notas.map((n) => `<option value="${esc(n.key)}">Nota ${esc(n.nota || '—')} · saldo ${P.usd(n.resta)}</option>`).join('')}</select></label>
      <label class="field"><span>Estado</span><select id="sgE" class="select">${Object.entries(SEG).map(([k, l]) => `<option value="${k}">${esc(l)}</option>`).join('')}</select></label>
      <label class="field"><span>Comentario (opcional)</span><input id="sgC" class="input" maxlength="300"></label>
      <div class="actions"><button class="btn btn-primary" id="sgOk">Guardar</button></div>`);
    sh.el.querySelector('#sgOk').onclick = async () => {
      const n = notas.find((x) => x.key === sh.el.querySelector('#sgN').value), estado = sh.el.querySelector('#sgE').value;
      const r = await global.Sync.pagosCall({ action: 'seguir', sellerId: sid, clientId: client.id || n.clientId, clientName: client.name, key: n.key, nota: n.nota, estado, comentario: sh.el.querySelector('#sgC').value, by: (P.sellerById(sid) || {}).name || '' });
      if (!r.ok) { toast(r.error || 'No se pudo guardar', 'err'); return; }
      sh.close(); toast('Seguimiento guardado: le llegó a la oficina', 'ok');
      if (estado === 'ya_pago' && confirm('¿Registrar ahora el pago de esta nota?')) global.Pagos.payForm({ sellerId: sid, clientId: n.clientId, notaKey: n.key, onSaved: onDone });
      else if (onDone) onDone();
    };
  }

  /* ---------------- Pantalla «Cobrar» del vendedor ---------------- */
  async function renderSeller(force) {
    const P = PV(), { S, $, esc, usd, fmtDate } = P, app = document.getElementById('app');
    const seller = P.sellerById(S.session.sellerId), sid = seller.id;
    app.innerHTML = `${P.brandHeader(seller.name, 'Cobrar · vencimientos de mis clientes', `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container"><div class="row wrap" style="gap:8px"><a class="btn" href="#/ruta/pagos">💵 Mis pagos</a><button class="btn" id="cbRef">⟳ Actualizar</button></div><div id="cbBody"><p class="muted">Cargando…</p></div></div>${P.creditFooter()}`;
    $('#bell').onclick = P.notifSheet; P.updateBell(); $('#syncPill').onclick = () => P.runSync(true); P.updateSyncPill();
    $('#cbRef').onclick = () => renderSeller(true);
    const d = await load(sid, force !== false);
    const box = document.getElementById('cbBody'); if (!box) return;
    if (!d) { box.innerHTML = '<div class="empty card"><strong>Sin datos</strong>Conéctate a internet para ver tus cobros.</div>'; return; }
    const notas = d.notas, total = notas.reduce((a, n) => a + n.resta, 0), atr = notas.filter((n) => n.dias < 0);
    // Grupos: atrasados (por días de atraso), hoy, mañana y los demás por días que faltan
    const groups = new Map();
    notas.forEach((n) => { const k = n.dias < 0 ? 'atr' : String(n.dias); (groups.get(k) || groups.set(k, []).get(k)).push(n); });
    const order = [...groups.keys()].filter((k) => k !== 'atr').sort((a, b) => +a - +b); if (groups.has('atr')) order.unshift('atr');
    const title = (k) => (k === 'atr' ? '🚩 Atrasados' : k === '0' ? '⏰ Vence HOY' : k === '1' ? '📅 Vence mañana' : `Faltan ${k} días`);
    const clientBlock = (list) => {
      const byC = new Map(); list.forEach((n) => (byC.get(n.clientId) || byC.set(n.clientId, []).get(n.clientId)).push(n));
      return [...byC.entries()].map(([cid, ns]) => { const c = P.clientById(cid) || { id: cid, name: ns[0].clientName }; return `<div class="card card-pad" style="margin-bottom:8px">
        <div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${esc(c.name)} · ${usd(ns.reduce((a, n) => a + n.resta, 0))}</b>
          <button class="btn btn-sm btn-primary" data-wa="${esc(cid)}">📲 WhatsApp</button><button class="btn btn-sm" data-seg="${esc(cid)}">📋 Seguimiento</button><button class="btn btn-sm" data-pay="${esc(cid)}">💵 Pago</button></div>
        ${ns.map((n) => `<div class="row" style="gap:8px;align-items:center;margin-top:6px;cursor:pointer" data-nota="${esc(cid)}|${esc(n.key)}"><span class="grow">📄 <b>Nota ${esc(n.nota || '—')}</b> · ${usd(n.resta)} de ${usd(n.monto)} · <span class="${n.dias < 0 ? 'warn-txt' : n.dias <= 1 ? 'pay-rev' : 'muted'}">${esc(diasTxt(n.dias))}</span> (${esc(fmtDate(n.vence))})
          ${n.espera ? '<br><span class="pay-rev">💵 pago subido, esperando a cobranza</span>' : ''}${n.seg ? `<br><span class="muted">📋 ${esc(n.seg.texto)}${n.seg.comentario ? ' — ' + esc(n.seg.comentario) : ''}</span>` : ''}</span><span class="muted">›</span></div>`).join('')}
        ${ns.some((n) => n.dias < 0) ? '<div class="warn-txt" style="font-size:13px;margin-top:6px">El atraso está afectando su límite de crédito: mientras más días, más baja.</div>' : ''}</div>`; }).join('');
    };
    box.innerHTML = `<div class="kpi-row" style="margin-top:10px"><div class="kpi"><small>Por cobrar</small><b>${usd(total)}</b><small>${new Set(notas.map((n) => n.clientId)).size} clientes · ${notas.length} notas</small></div>
        <div class="kpi"><small>Atrasado</small><b class="${atr.length ? 'warn-txt' : ''}">${usd(atr.reduce((a, n) => a + n.resta, 0))}</b><small>${new Set(atr.map((n) => n.clientId)).size} clientes</small></div>
        <div class="kpi"><small>Al día</small><b>${(d.alDia || []).length}</b><small>clientes sin deuda 🙌</small></div></div>
      <p class="muted" style="font-size:13px">Plazos: ${esc((d.reglas.rules || []).map((r) => `${r.category} ${r.days} días`).concat(`lo demás ${d.reglas.def} días`).join(' · '))}, desde que la carga quedó despachada${d.reglas.desde ? ` · notas despachadas desde el ${esc(fmtDate(d.reglas.desde))}` : ''}.</p>
      ${notas.length ? order.map((k) => `<h3>${title(k)} <span class="muted">(${new Set(groups.get(k).map((n) => n.clientId)).size})</span></h3>${clientBlock(groups.get(k))}`).join('') : '<div class="empty card"><strong>🎉 Ningún cliente te debe</strong>Todas tus notas están pagadas.</div>'}`;
    box.onclick = (e) => {
      const get = (cid) => notas.filter((n) => n.clientId === cid), cl = (cid) => P.clientById(cid) || { id: cid, name: (get(cid)[0] || {}).clientName };
      const wa = e.target.closest('[data-wa]'), sg = e.target.closest('[data-seg]'), py = e.target.closest('[data-pay]'), nt = e.target.closest('[data-nota]');
      if (wa) { openWA(cl(wa.dataset.wa), get(wa.dataset.wa)); return; }
      if (sg) { segSheet(cl(sg.dataset.seg), get(sg.dataset.seg), sid, () => renderSeller(true)); return; }
      if (py) { global.Pagos.payForm({ sellerId: sid, clientId: py.dataset.pay, onSaved: () => renderSeller(true) }); return; }
      if (nt) { const [cid, k] = nt.dataset.nota.split('|'); const n = get(cid).find((x) => x.key === k); if (n) notaSheet(n); }
    };
  }

  /* ---------------- Oficina: cuentas por cobrar de todos ---------------- */
  async function officeSheet() {
    const P = PV(), { esc, usd, fmtDate, openSheet, S } = P;
    const sh = openSheet(`<div class="row"><h2 class="grow">📅 Cuentas por cobrar</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div><div id="ocOut"><p class="muted">Cargando…</p></div>`, { wide: true });
    const r = await global.Sync.pagosCall({ action: 'cartera' });
    const out = sh.el.querySelector('#ocOut');
    if (!r.ok) { out.innerHTML = `<div class="hint warn">${esc(r.error || 'No se pudo consultar')}</div>`; return; }
    const notas = r.data.notas, bySeller = new Map(); notas.forEach((n) => (bySeller.get(n.sellerName || '—') || bySeller.set(n.sellerName || '—', []).get(n.sellerName || '—')).push(n));
    out.innerHTML = `<div class="kpi-row"><div class="kpi"><small>Por cobrar</small><b>${usd(notas.reduce((a, n) => a + n.resta, 0))}</b><small>${notas.length} notas</small></div>
        <div class="kpi"><small>Atrasado</small><b class="warn-txt">${usd(notas.filter((n) => n.dias < 0).reduce((a, n) => a + n.resta, 0))}</b></div></div>
      <div class="row" style="gap:8px;margin:6px 0"><button class="btn" id="ocXls">⇩ Excel</button></div>
      ${[...bySeller.entries()].map(([name, ns]) => `<h3>${esc(name)} · ${usd(ns.reduce((a, n) => a + n.resta, 0))}</h3><div style="overflow:auto"><table class="inv"><thead><tr><th>Cliente</th><th>Nota</th><th class="n">Saldo</th><th>Vence</th><th>Situación</th><th>Seguimiento</th></tr></thead><tbody>
        ${ns.map((n) => `<tr><td><b>${esc(n.clientName)}</b></td><td>${esc(n.nota || '—')}</td><td class="n">${usd(n.resta)}</td><td>${esc(fmtDate(n.vence))}</td><td class="${n.dias < 0 ? 'warn-txt' : ''}">${esc(diasTxt(n.dias))}${n.espera ? ' · pago en espera' : ''}</td><td>${n.seg ? esc(n.seg.texto + (n.seg.comentario ? ' — ' + n.seg.comentario : '')) : ''}</td></tr>`).join('')}</tbody></table></div>`).join('') || '<p class="muted">Nadie debe.</p>'}`;
    out.querySelector('#ocXls').onclick = () => global.Exporta.save(`por_cobrar_${r.data.hoy}.xlsx`, [global.Exporta.table({ name: 'Por cobrar', title: 'CUENTAS POR COBRAR', subtitle: 'Al ' + r.data.hoy,
      cols: [{ h: 'VENDEDOR', w: 16 }, { h: 'CLIENTE', w: 32 }, { h: 'NOTA', w: 10 }, { h: 'DESPACHADA', k: 'date', w: 12 }, { h: 'VENCE', k: 'date', w: 12 }, { h: 'DÍAS', k: 'int' }, { h: 'MONTO NOTA', k: 'money', total: true }, { h: 'SALDO', k: 'money', total: true }, { h: 'SEGUIMIENTO', w: 30 }],
      rows: notas.map((n) => [n.sellerName, n.clientName, n.nota, n.despacho, n.vence, n.dias, n.monto, n.resta, n.seg ? n.seg.texto + (n.seg.comentario ? ' — ' + n.seg.comentario : '') : '']) })]);
  }

  global.Cobranza = { load, refresh, hintFor, renderSeller, officeSheet, waText, phoneOf, diasTxt, SEG };
})(window);
