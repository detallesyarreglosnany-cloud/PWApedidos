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
  // Lectura con memoria: el texto guardado solo se vuelve a interpretar si cambió (las listas de la oficina lo leen
  // por cada pedido; interpretar 100 KB cada vez trababa la pantalla)
  const memo = new Map();
  const lsGet = (k) => {
    try { const raw = localStorage.getItem(k); const m = memo.get(k); if (m && m.raw === raw) return m.val; const val = JSON.parse(raw || 'null'); memo.set(k, { raw, val }); return val; }
    catch (e) { return null; }
  };
  const lsSet = (k, v) => { try { const raw = JSON.stringify(v); localStorage.setItem(k, raw); memo.set(k, { raw, val: v }); } catch (e) { /* noop */ } };
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

  /* ---------------- Crédito (Fase 6) ---------------- */
  const DOT = { verde: '🟢', amarillo: '🟡', rojo: '🔴', nuevo: '🆕' };
  const SEM = { verde: 'Sin atrasos', amarillo: 'Con atraso', rojo: 'Atraso grave (más de 7 días)', nuevo: 'Cliente nuevo' };
  /** Crédito del cliente (lo calcula el servidor; un cliente recién creado en el teléfono ya cuenta como nuevo). */
  function credOf(clientId) {
    const P = PV(), S = P.S, sid = S.session && S.session.sellerId, c = sid ? lsGet(key(sid)) : null, d = c && c.data;
    const k = d && d.credito && d.credito[clientId]; if (k) return k;
    const cl = P.clientById(clientId), R = (d && d.reglas) || { nuevas: 3, nuevosDesde: '2026-10-27' };
    if (cl && (cl.source === 'campo' || cl.source === 'oficina') && String(cl.createdAt || '').slice(0, 10) >= R.nuevosDesde && R.nuevas > 0)
      return { modo: 'nuevo', limite: 0, sugerido: 0, bajaPct: 0, deuda: 0, atrasoMax: 0, semaforo: 'nuevo', nuevo: { n: 0, need: R.nuevas }, motivo: `Cliente nuevo: compra 1 de ${R.nuevas} de contado`, nota: '' };
    return null;
  }
  function credHTML(k, monto) {
    const P = PV(), { esc, usd } = P; if (!k) return '';
    if (k.modo === 'contado') return `<div class="hint warn">🔴 <b>Este cliente va de CONTADO</b>: debe pagar antes o al recibir su pedido.${k.nota ? ' <i>' + esc(k.nota) + '</i>' : ''}</div>`;
    if (k.modo === 'nuevo') return `<div class="hint warn">🆕 <b>Cliente nuevo: compra ${k.nuevo.n + 1} de ${k.nuevo.need} de contado.</b> Debe pagar al recibir. Después de ${k.nuevo.need} compras su crédito será el promedio de esas compras.</div>`;
    if (k.semaforo === 'verde' && !(k.limite > 0) && !k.pagadas && !k.nota) return '';
    const parts = [`${DOT[k.semaforo] || ''} <b>${esc(SEM[k.semaforo] || '')}</b>${k.motivo ? ' · ' + esc(k.motivo) : ''}`];
    if (k.limite > 0) {
      const disp = Math.round((k.limite - k.deuda - (monto || 0)) * 100) / 100;
      parts.push(`Límite de crédito <b>${usd(k.limite)}</b> · debe ${usd(k.deuda)}${monto ? ' · este pedido ' + usd(monto) : ''} · <b class="${disp < 0 ? 'warn-txt' : ''}">${disp < 0 ? 'pasa su límite por ' + usd(-disp) : 'disponible ' + usd(disp)}</b>`);
    }
    if (k.nota) parts.push('<i>' + esc(k.nota) + '</i>');
    return `<div class="hint ${k.semaforo === 'verde' && !(k.limite > 0 && k.limite - k.deuda - (monto || 0) < 0) ? '' : 'warn'}">${parts.join('<br>')}</div>`;
  }
  /** Para la barra de abajo: contado o si el pedido pasa el límite. */
  function barNote(clientId, monto) {
    const k = credOf(clientId); if (!k) return '';
    if (k.modo === 'contado') return ' · <b class="warn-txt">🔴 CONTADO</b>';
    if (k.modo === 'nuevo') return ` · <b class="warn-txt">🆕 contado (${k.nuevo.n + 1}/${k.nuevo.need})</b>`;
    if (k.limite > 0 && k.deuda + (monto || 0) > k.limite + 0.004) return ' · <b class="warn-txt">⚠ pasa su límite</b>';
    return '';
  }

  /** Deuda del cliente según la cartera del teléfono: vencido, por vencer y sus notas. */
  function debtOf(clientId) {
    const S = PV().S, sid = S.session && S.session.sellerId, c = sid ? lsGet(key(sid)) : null;
    if (!c || !c.data) return null;
    const notas = c.data.notas.filter((n) => n.clientId === clientId).sort((x, y) => x.dias - y.dias);
    const sum = (l) => Math.round(l.reduce((a, n) => a + n.resta, 0) * 100) / 100;
    const ven = notas.filter((n) => n.dias < 0);
    return { notas, total: sum(notas), vencido: sum(ven), porVencer: sum(notas.filter((n) => n.dias >= 0)), alDia: !notas.length && (c.data.alDia || []).includes(clientId) };
  }
  /** Bloque de deuda con acciones al instante: enviarle la deuda por WhatsApp, registrar el pago, ver el detalle. */
  function debtHTML(clientId) {
    const P = PV(), { esc, usd, fmtDate } = P, d = debtOf(clientId); if (!d) return '';
    if (!d.notas.length) return d.alDia ? '<div class="hint">✅ Cliente <b>al día</b> con sus pagos.</div>' : '';
    const row = (n) => `<div class="row" style="gap:6px;font-size:13px"><span class="grow">📄 Nota ${esc(n.nota || '—')} · ${usd(n.resta)}${n.resta < n.monto - 0.01 ? ` de ${usd(n.monto)}` : ''}</span><span class="${n.dias < 0 ? 'warn-txt' : n.dias <= 1 ? 'pay-rev' : 'muted'}">${esc(diasTxt(n.dias))} · ${esc(fmtDate(n.vence))}</span></div>`;
    return `<div class="hint warn cob-debt">💵 <b>Debe ${usd(d.total)}</b>${d.vencido ? ` · <b class="warn-txt">vencido ${usd(d.vencido)}</b>` : ''}${d.porVencer ? ` · por vencer ${usd(d.porVencer)}` : ''}
      <div style="margin:6px 0">${d.notas.slice(0, 5).map(row).join('')}${d.notas.length > 5 ? `<div class="muted" style="font-size:12px">… y ${d.notas.length - 5} notas más</div>` : ''}</div>
      ${d.vencido ? '<div style="font-size:13px">Pídele que cancele lo vencido para hacer su nuevo pedido y mantener su crédito.</div>' : ''}
      <div class="row wrap" style="gap:6px;margin-top:6px"><button type="button" class="btn btn-sm btn-primary" data-cob-wa="${esc(clientId)}">📲 Enviarle la deuda</button><button type="button" class="btn btn-sm" data-cob-pay="${esc(clientId)}">💵 Registrar pago</button><button type="button" class="btn btn-sm" data-cob-cid="${esc(clientId)}">📄 Ver detalle</button></div></div>`;
  }

  /** Aviso al tomar un pedido: crédito del cliente y su deuda con acciones (no bloquea). */
  function hintFor(clientId, o) {
    const P = PV(), S = P.S, sid = S.session && S.session.sellerId; if (!sid || !clientId) return '';
    const monto = o && global.Matrix ? global.Matrix.orderTotals(o).monto : 0;
    return credHTML(credOf(clientId), monto) + debtHTML(clientId);
  }
  /** Después de un pago registrado desde el pedido: se recalcula la cartera y el semáforo al instante. */
  async function afterPay(clientId) {
    const P = PV(), sid = P.S.session && P.S.session.sellerId; if (!sid) return;
    const before = credOf(clientId);
    await load(sid, true);
    const now = credOf(clientId), d = debtOf(clientId);
    if (location.hash === '#/ruta' && P.render) P.render();
    if (location.hash === '#/ruta/cobrar') renderSeller(false);
    if (d && !d.notas.length) P.toast(`✅ ${(P.clientById(clientId) || {}).name || 'El cliente'} quedó al día${before && now && before.semaforo !== now.semaforo ? ' · semáforo ' + (DOT[now.semaforo] || '') : ''}`, 'ok');
    else if (d) P.toast(`Pago registrado · aún debe ${P.usd(d.total)}`, 'ok');
  }
  /** Al enviar un pedido: si el cliente tiene algo vencido o que vence en 1 día, se lo recuerda con las acciones. */
  function afterSend(clientId, clientName) {
    const P = PV(), d = debtOf(clientId); if (!d || !d.notas.length || !(d.vencido > 0 || d.notas.some((n) => n.dias <= 1))) return;
    const k = credOf(clientId);
    P.openSheet(`<div class="row"><h2 class="grow">✓ Pedido enviado</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p><b>${P.esc(clientName || '')}</b> tiene deuda pendiente${k && DOT[k.semaforo] ? ` · ${DOT[k.semaforo]} ${P.esc(SEM[k.semaforo] || '')}` : ''}. Aprovecha que estás con el cliente:</p>${debtHTML(clientId)}
      <div class="actions"><button class="btn" data-close>Ahora no</button></div>`);
  }
  document.addEventListener('click', (e) => {
    const P = PV(), sid = P.S.session && P.S.session.sellerId;
    const b = e.target.closest('[data-cob-cid]'), wa = e.target.closest('[data-cob-wa]'), pay = e.target.closest('[data-cob-pay]'), of = e.target.closest('[data-cob-of]');
    if (of) { const [s0, c0] = of.dataset.cobOf.split('|'); if (global.Pagos) global.Pagos.cuentaSheet(s0, c0); return; }
    if (!sid || !(b || wa || pay)) return;
    const closeOv = () => { const ov = e.target.closest('.overlay'); if (ov) { const x = ov.querySelector('[data-close]'); if (x) x.click(); } };
    if (b && global.Pagos) { closeOv(); global.Pagos.cuentaSheet(sid, b.dataset.cobCid); return; }
    if (wa) { const cid = wa.dataset.cobWa, d = debtOf(cid), c = P.clientById(cid) || { id: cid, name: d && d.notas[0] ? d.notas[0].clientName : '' }; if (d && d.notas.length) openWA(c, d.notas); return; }
    if (pay && global.Pagos) { const cid = pay.dataset.cobPay; closeOv(); global.Pagos.payForm({ sellerId: sid, clientId: cid, onSaved: () => afterPay(cid) }); }
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
    const k = credOf(client.id);
    if (k && k.limite > 0 && k.bajaPct > 0) lines.push('', `⚠ Con ${k.atrasoMax} días de atraso su límite de crédito de $ ${nf.format(k.limite)} puede bajar a $ ${nf.format(k.sugerido)}. Pague hoy y mantenga su crédito.`);
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
        <div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${(credOf(cid) && DOT[credOf(cid).semaforo]) || ''} ${esc(c.name)} · ${usd(ns.reduce((a, n) => a + n.resta, 0))}</b>
          <button class="btn btn-sm btn-primary" data-wa="${esc(cid)}">📲 WhatsApp</button><button class="btn btn-sm" data-seg="${esc(cid)}">📋 Seguimiento</button><button class="btn btn-sm" data-pay="${esc(cid)}">💵 Pago</button></div>
        ${ns.map((n) => `<div class="row" style="gap:8px;align-items:center;margin-top:6px;cursor:pointer" data-nota="${esc(cid)}|${esc(n.key)}"><span class="grow">📄 <b>Nota ${esc(n.nota || '—')}</b> · ${usd(n.resta)} de ${usd(n.monto)} · <span class="${n.dias < 0 ? 'warn-txt' : n.dias <= 1 ? 'pay-rev' : 'muted'}">${esc(diasTxt(n.dias))}</span> (${esc(fmtDate(n.vence))})
          ${n.espera ? '<br><span class="pay-rev">💵 pago subido, esperando a cobranza</span>' : ''}${n.seg ? `<br><span class="muted">📋 ${esc(n.seg.texto)}${n.seg.comentario ? ' — ' + esc(n.seg.comentario) : ''}</span>` : ''}</span><span class="muted">›</span></div>`).join('')}
        ${(() => { const k = credOf(cid); if (k && k.limite > 0 && k.bajaPct > 0) return `<div class="warn-txt" style="font-size:13px;margin-top:6px">Su límite de crédito es ${usd(k.limite)}: con ${k.atrasoMax} días de atraso el sistema sugiere bajarlo a <b>${usd(k.sugerido)}</b> (−${k.bajaPct}%). Mientras más días, más baja.</div>`;
          return ns.some((n) => n.dias < 0) ? '<div class="warn-txt" style="font-size:13px;margin-top:6px">El atraso está afectando su límite de crédito: mientras más días, más baja.</div>' : ''; })()}</div>`; }).join('');
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

  /* ---------------- Oficina: crédito de clientes (lo ajusta cobranza) ---------------- */
  const CMAP = 'pv_credmap';
  /** Guarda qué clientes van de contado para marcarlos en la hoja de carga. */
  // Una consulta a la vez, y si falla se espera 5 minutos antes de reintentar (no una por cada redibujo de pantalla)
  let warming = null, warmFailAt = 0;
  async function warmOffice(force) {
    const c = lsGet(CMAP); if (!force && c && Date.now() - c.at < 15 * 60000 && c.v === 3) return false;
    if (!navigator.onLine || warming || (!force && Date.now() - warmFailAt < 5 * 60000)) return false;
    warming = global.Sync.pagosCall({ action: 'creditos' });
    let r; try { r = await warming; } finally { warming = null; }
    if (!r.ok) { warmFailAt = Date.now(); return false; }
    const map = {}; r.data.clientes.forEach((k) => { map[k.clientId] = { m: k.modo, s: k.semaforo, d: k.deuda, v: k.vencido, a: k.atrasoMax }; });
    lsSet(CMAP, { at: Date.now(), v: 3, map }); return true;
  }
  /** 'contado' | 'nuevo' | '' para la hoja de carga (oficina). */
  /** Crédito de un cliente para la hoja de carga (oficina): { m: 'credito'|'contado'|'nuevo', s: semáforo } o null. */
  function credMark(clientId) {
    const c = lsGet(CMAP), x = c && c.map && c.map[clientId];
    if (x) return typeof x === 'string' ? { m: x, s: x === 'nuevo' ? 'nuevo' : '' } : x;
    // Cliente creado después de la última consulta: si es nuevo según Ajustes, va de contado
    const P = PV(), cl = P.clientById(clientId), R = (P.S.config && P.S.config.creditRules) || {}, nd = R.nuevosDesde || '2026-10-27', nu = R.nuevas === undefined || R.nuevas === '' ? 3 : +R.nuevas;
    return cl && nu > 0 && (cl.source === 'campo' || cl.source === 'oficina') && String(cl.createdAt || '').slice(0, 10) >= nd ? { m: 'nuevo', s: 'nuevo' } : null;
  }
  /** 'contado' | 'nuevo' | '' para la hoja de carga (oficina). */
  const contadoOf = (clientId) => { const x = credMark(clientId); return x && x.m !== 'credito' ? x.m : ''; };
  /** Oficina: etiqueta del cliente de un pedido con semáforo y deuda; al tocarla abre su estado de cuenta. */
  function officeChip(o) {
    const x = credMark(o.clientId); if (!x) return '';
    const P = PV(), usd = P.usd, esc = P.esc, txt = [x.m === 'contado' ? 'CONTADO' : x.m === 'nuevo' ? 'nuevo · contado' : '', x.d ? 'debe ' + usd(x.d) : '', x.v ? 'vencido ' + usd(x.v) : ''].filter(Boolean).join(' · ') || (SEM[x.s] || '');
    return ` <button type="button" class="status cob-chip" data-cob-of="${esc(o.sellerId || '')}|${esc(o.clientId)}" title="${esc(SEM[x.s] || '')}${x.a ? ' · ' + x.a + ' días de atraso' : ''} · toca para ver su estado de cuenta">${DOT[x.s] || ''} ${esc(txt)}</button>`;
  }
  /** Semáforo del cliente para la hoja de carga: 'verde' | 'amarillo' | 'rojo' | 'nuevo' | ''. */
  const semOf = (clientId) => { const x = credMark(clientId); return (x && x.s) || ''; };

  async function creditSheet() {
    const P = PV(), { esc, usd, openSheet, toast, S } = P;
    const st = { q: '', sem: '', seller: '' };
    const sh = openSheet(`<div class="row"><h2 class="grow">🚦 Crédito de clientes</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">El sistema sugiere; <b>cobranza decide</b>. El límite sugerido baja <span id="crPct">…</span>% por cada día de atraso y se recupera al pagar.</p>
      <div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field grow"><span>Buscar cliente</span><input id="crQ" class="input" autocomplete="off"></label>
        <label class="field"><span>Vendedor</span><select id="crS" class="select"><option value="">Todos</option>${S.sellers.filter((s) => s.active !== false).map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Semáforo</span><select id="crF" class="select"><option value="">Todos</option><option value="rojo">🔴 Atraso grave</option><option value="amarillo">🟡 Con atraso</option><option value="verde">🟢 Al día</option><option value="nuevo">🆕 Nuevos</option><option value="contado">Contado</option><option value="sug">Con sugerencia de bajar</option></select></label>
        <button class="btn" id="crX">⇩ Excel</button></div><div id="crOut" style="margin-top:10px"><p class="muted">Cargando…</p></div>`, { wide: true });
    const el = sh.el, out = el.querySelector('#crOut');
    const r = await global.Sync.pagosCall({ action: 'creditos' });
    if (!r.ok) { out.innerHTML = `<div class="hint warn">${esc(r.error || 'No se pudo consultar')}</div>`; return; }
    el.querySelector('#crPct').textContent = String(r.data.reglas.penal).replace('.', ',');
    let list = r.data.clientes.slice().sort((a, b) => b.atrasoMax - a.atrasoMax || b.deuda - a.deuda || a.clientName.localeCompare(b.clientName, 'es'));
    const map = {}; list.forEach((k) => { map[k.clientId] = { m: k.modo, s: k.semaforo, d: k.deuda, v: k.vencido, a: k.atrasoMax }; }); lsSet(CMAP, { at: Date.now(), v: 3, map });
    const sname = (k) => ((P.sellerById(k.sellerId) || {}).name || k.sellerName || '—');
    const filt = () => list.filter((k) => (!st.q || P.norm(k.clientName).includes(P.norm(st.q))) && (!st.seller || k.sellerId === st.seller)
      && (!st.sem || (st.sem === 'contado' ? k.modo === 'contado' : st.sem === 'sug' ? k.limite > 0 && k.bajaPct > 0 : k.semaforo === st.sem)));
    const draw = () => {
      const l = filt();
      out.innerHTML = `<p class="muted">${l.length} clientes</p><div style="overflow:auto"><table class="inv"><thead><tr><th></th><th>Cliente</th><th>Vendedor</th><th>Condición</th><th class="n">Límite</th><th class="n">Debe</th><th class="n">Vencido</th><th class="n">Atraso</th><th>Récord</th><th class="n">Sugerido</th><th></th></tr></thead><tbody>
        ${l.slice(0, 400).map((k) => `<tr><td>${DOT[k.semaforo] || ''}</td><td><b>${esc(k.clientName)}</b>${k.nota ? `<br><small class="muted">${esc(k.nota)}</small>` : ''}</td><td>${esc(sname(k))}</td>
          <td>${k.modo === 'contado' ? '<b class="warn-txt">CONTADO</b>' : k.modo === 'nuevo' ? `Nuevo ${k.nuevo.n}/${k.nuevo.need}` : 'Crédito'}${k.fijado !== 'auto' ? ' <small class="muted">(cobranza)</small>' : ''}</td>
          <td class="n">${k.limite ? usd(k.limite) + (k.base === 'promedio' ? '<br><small class="muted">promedio</small>' : '') : '—'}</td><td class="n">${k.deuda ? usd(k.deuda) : ''}</td><td class="n">${k.vencido ? usd(k.vencido) : ''}</td>
          <td class="n">${k.atrasoMax ? k.atrasoMax + ' d' : ''}</td><td>${k.pagadas ? `${k.aTiempo}/${k.pagadas} a tiempo${k.promAtraso ? ` · prom. ${String(k.promAtraso).replace('.', ',')} d` : ''}` : ''}</td>
          <td class="n">${k.limite > 0 && k.bajaPct > 0 ? `<b class="warn-txt">${usd(k.sugerido)}</b><br><small>−${k.bajaPct}%</small>` : ''}</td><td><button class="btn btn-sm" data-ed="${esc(k.clientId)}">Ajustar</button></td></tr>`).join('')}</tbody></table></div>
        ${l.length > 400 ? '<p class="muted">Se muestran 400: usa el buscador.</p>' : ''}`;
    };
    el.querySelector('#crQ').oninput = (e) => { st.q = e.target.value; draw(); };
    el.querySelector('#crS').onchange = (e) => { st.seller = e.target.value; draw(); };
    el.querySelector('#crF').onchange = (e) => { st.sem = e.target.value; draw(); };
    el.querySelector('#crX').onclick = () => global.Exporta.save(`credito_clientes_${r.data.hoy}.xlsx`, [global.Exporta.table({ name: 'Crédito', title: 'CRÉDITO DE CLIENTES', subtitle: 'Al ' + r.data.hoy,
      cols: [{ h: 'SEMÁFORO', w: 12 }, { h: 'CLIENTE', w: 32 }, { h: 'VENDEDOR', w: 16 }, { h: 'CONDICIÓN', w: 12 }, { h: 'LÍMITE', k: 'money' }, { h: 'DEBE', k: 'money', total: true }, { h: 'VENCIDO', k: 'money', total: true }, { h: 'DÍAS ATRASO', k: 'int' }, { h: 'A TIEMPO', w: 10 }, { h: 'SUGERIDO', k: 'money' }, { h: 'NOTA', w: 30 }],
      rows: filt().map((k) => [SEM[k.semaforo] || '', k.clientName, sname(k), k.modo === 'contado' ? 'Contado' : k.modo === 'nuevo' ? 'Nuevo' : 'Crédito', k.limite || '', k.deuda, k.vencido, k.atrasoMax, k.pagadas ? `${k.aTiempo}/${k.pagadas}` : '', k.limite > 0 && k.bajaPct > 0 ? k.sugerido : '', k.nota || '']) })]);
    out.onclick = (e) => { const b = e.target.closest('[data-ed]'); if (b) editForm(list.find((k) => k.clientId === b.dataset.ed)); };
    function editForm(k) {
      const f = openSheet(`<div class="row"><h2 class="grow">🚦 ${esc(k.clientName)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <p>${DOT[k.semaforo] || ''} ${esc(SEM[k.semaforo] || '')}${k.motivo ? ' · ' + esc(k.motivo) : ''}</p>
        <p class="muted">Debe ${usd(k.deuda)}${k.vencido ? ' · vencido ' + usd(k.vencido) : ''}${k.pagadas ? ` · pagó ${k.aTiempo} de ${k.pagadas} notas a tiempo` : ''} · ${k.compras} compras recientes</p>
        <label class="field"><span>Condición</span><select id="ceM" class="select"><option value="auto">Según el sistema${k.nuevo ? ' (nuevo: contado)' : ''}</option><option value="credito">Crédito</option><option value="contado">Contado</option></select></label>
        <label class="field"><span>Límite de crédito ($) <small class="muted">0 = sin límite fijado</small></span><input id="ceL" class="input" inputmode="decimal" value="${k.base === 'cobranza' ? esc(k.limite) : ''}" placeholder="${k.base === 'promedio' ? 'promedio: ' + esc(k.limite) : ''}"></label>
        ${k.limite > 0 && k.bajaPct > 0 ? `<button class="btn btn-sm" id="ceSug">Usar el sugerido: ${usd(k.sugerido)}</button>` : ''}
        <label class="field"><span>Nota (la ve el vendedor)</span><input id="ceN" class="input" maxlength="300" value="${esc(k.nota || '')}"></label>
        <div class="actions"><button class="btn btn-primary" id="ceOk">Guardar</button></div>`);
      const q = (id) => f.el.querySelector(id);
      q('#ceM').value = k.fijado || 'auto';
      if (q('#ceSug')) q('#ceSug').onclick = () => { q('#ceL').value = k.sugerido; };
      q('#ceOk').onclick = async () => {
        const lim = Number(String(q('#ceL').value).replace(/\./g, '').replace(',', '.')) || 0;
        const x = await global.Sync.pagosCall({ action: 'credito', clientId: k.clientId, modo: q('#ceM').value, limite: lim, nota: q('#ceN').value, by: (S.config && S.config.adminName) || 'Cobranza' });
        if (!x.ok) { toast(x.error || 'No se pudo guardar', 'err'); return; }
        P.logEvent('credito', `Crédito de ${k.clientName}: ${q('#ceM').value === 'contado' ? 'contado' : q('#ceM').value === 'credito' ? 'crédito' : 'según el sistema'}${lim ? ' · límite $' + lim : ''}`);
        f.close(); toast('Crédito guardado: le llega al vendedor', 'ok');
        const r2 = await global.Sync.pagosCall({ action: 'creditos' }); if (r2.ok) { list = r2.data.clientes.slice().sort((a, b) => b.atrasoMax - a.atrasoMax || b.deuda - a.deuda || a.clientName.localeCompare(b.clientName, 'es')); const m = {}; list.forEach((z) => { m[z.clientId] = { m: z.modo, s: z.semaforo, d: z.deuda, v: z.vencido, a: z.atrasoMax }; }); lsSet(CMAP, { at: Date.now(), v: 3, map: m }); }
        draw();
      };
    }
    draw();
  }

  global.Cobranza = { load, refresh, hintFor, credOf, barNote, debtOf, afterSend, afterPay, officeChip, renderSeller, officeSheet, creditSheet, warmOffice, contadoOf, semOf, DOT, SEM, waText, phoneOf, diasTxt, SEG };
})(window);
