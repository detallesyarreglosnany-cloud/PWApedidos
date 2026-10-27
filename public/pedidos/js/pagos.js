/* =========================================================================
 * pagos.js — Pagos de clientes (Fase 4 · cobranza).
 *
 * Vendedor («💵 Pagos»): registra lo que le pagó cada cliente: una o varias notas,
 *   varias formas de pago a la vez (transferencia, pago móvil, efectivo Bs, efectivo $,
 *   Zelle, Binance, pesos colombianos) y ajustes (colaboración, autoconsumo, donativo,
 *   descuento %). La app va restando y muestra lo que falta o sobra. Imprime y exporta
 *   sus pagos del día para llevarlos a cobranzas.
 * Oficina («💵 Pagos»): cobranza verifica cada pago (aprobado / rechazado), por día y
 *   vendedor, y lo imprime o exporta a Excel.
 * Un número de referencia no se puede repetir (lo garantiza el servidor).
 * Sin internet, el pago queda guardado en el teléfono y se sube solo al volver la señal.
 * ========================================================================= */
(function (global) {
  'use strict';

  const METHODS = {
    transferencia: { label: 'Transferencia', currency: 'VES', ref: true, bank: true },
    pago_movil: { label: 'Pago móvil', currency: 'VES', ref: true, bank: true },
    efectivo_bs: { label: 'Efectivo Bs', currency: 'VES', ref: false, bank: false },
    efectivo_usd: { label: 'Efectivo $', currency: 'USD', ref: false, bank: false },
    zelle: { label: 'Zelle', currency: 'USD', ref: true, bank: false },
    binance: { label: 'Binance', currency: 'USD', ref: true, bank: false },
    efectivo_cop: { label: 'Pesos colombianos', currency: 'COP', ref: false, bank: false },
  };
  const ADJUSTS = { colaboracion: 'Colaboración', autoconsumo: 'Autoconsumo', donativo: 'Donativo', descuento: 'Descuento %' };
  const ST = { espera: ['⏳ En espera de cobranza', 'en_espera'], aprobado: ['✅ Aprobado por cobranza', 'despachado'], rechazado: ['✖ Rechazado', 'over'], anulado: ['Anulado', 'abierto'], local: ['📵 Sin subir (sin señal)', 'en_espera'] };
  // Bancos de Venezuela (sugerencias; las cuentas de la empresa se editan en Ajustes)
  const BANKS = ['Banco de Venezuela (BDV)', 'Banco del Tesoro', 'Banco Bicentenario del Pueblo', 'Banco Digital de los Trabajadores (BDT)', 'Banfanb', 'Banco Agrícola de Venezuela',
    'Banesco', 'Mercantil', 'BBVA Provincial', 'Banco Nacional de Crédito (BNC)', 'Bancamiga', 'Bancaribe', 'Banco Exterior', 'Banco Plaza', 'Banco Caroní', 'Banco Activo', 'Bancrecer', 'Banplus',
    'Mi Banco', '100% Banco', 'Banco Sofitasa', 'Venezolano de Crédito', 'DelSur', 'R4'];
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  // Montos al estilo venezolano: «2.000» = dos mil, «2.000,50» = dos mil y medio; «20.5» también se entiende
  const dec = (v) => { const s = String(v == null ? '' : v).trim().replace(/\s/g, ''); if (!s) return 0;
    const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s); return Number.isFinite(n) ? n : 0; };
  // Tasas: «40,25» o «40.25» (nunca separador de miles)
  const decRate = (v) => { const n = Number(String(v == null ? '' : v).trim().replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const normRef = (v) => String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+(?=[0-9])/, '');
  const PV = () => global.PV;

  /** Mismo cálculo que el servidor: cada forma de pago en $, ajustes y lo que falta o sobra. */
  function calc(p) {
    const debe = r2((p.notas || []).reduce((a, n) => a + (+n.monto || 0), 0));
    const lines = (p.lines || []).map((l) => {
      const m = METHODS[l.method] || {}, amount = r2(typeof l.amount === 'number' ? l.amount : dec(l.amount));
      const usd = m.currency === 'USD' ? amount : m.currency === 'VES' ? (p.rate > 0 ? r2(amount / p.rate) : 0) : (p.copRate > 0 ? r2(amount / p.copRate) : 0);
      return { ...l, currency: m.currency, amount, usd };
    });
    const num = (v) => (typeof v === 'number' ? v : dec(v));
    const adjusts = (p.adjusts || []).map((a) => ({ ...a, usd: a.type === 'descuento' ? r2((debe * num(a.pct)) / 100) : r2(num(a.usd)) }));
    const pagado = r2(lines.reduce((a, l) => a + l.usd, 0)), ajustes = r2(adjusts.reduce((a, x) => a + x.usd, 0));
    return { debe, lines, adjusts, pagado, ajustes, diferencia: r2(debe - pagado - ajustes) };
  }

  /* ---------------- Cola sin señal (el pago no se pierde) ---------------- */
  const pend = async () => (await global.DB.getMeta('pagosPend', [])) || [];
  const setPend = (arr) => global.DB.setMeta('pagosPend', arr);
  let flushing = null;
  function flush() { flushing = flushing || flushNow().finally(() => { flushing = null; }); return flushing; } // uno a la vez
  async function flushNow() {
    const list = await pend(); if (!list.length || !navigator.onLine) return { sent: 0, left: list.length };
    const left = []; let sent = 0;
    for (const p of list) {
      const r = await global.Sync.pagosCall({ action: 'create', pago: { ...p, error: undefined } });
      if (r.ok) sent++;
      else if (r.offline || !r.status || r.status >= 500) left.push(p);
      else left.push({ ...p, error: r.error || 'No se pudo subir' }); // p. ej. referencia repetida: el vendedor lo corrige o lo borra
    }
    await setPend(left);
    return { sent, left: left.length };
  }
  if (typeof window !== 'undefined') window.addEventListener('online', () => { flush(); });

  /* ---------------- Notas por cobrar de un cliente (las que tiene el teléfono) ---------------- */
  function notasDe(clientId) {
    const { S, Matrix } = { S: PV().S, Matrix: global.Matrix };
    return S.orders.filter((o) => !o.deleted && o.clientId === clientId && (o.status === 'despachado' || (o.delivery && o.delivery.at)))
      .map((o) => {
        const d = o.delivery && o.delivery.at ? o.delivery : null;
        if (d && d.result === 'anulada') return null;
        const monto = d ? r2(+d.monto || 0) : r2(Matrix.orderTotals(o).monto);
        return monto > 0 ? { orderId: o.id, nota: String((d && d.newValery) || o.valeryNote || '').replace(/\D/g, ''), monto, date: (d && d.date) || o.routeDate, liquidado: !!d } : null;
      }).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  const accounts = () => ((PV().S.config && PV().S.config.payAccounts) || []).filter((a) => a && a.bank);
  const banksFor = () => { const a = [...new Set(accounts().map((x) => x.bank))]; return a.length ? a : BANKS; };

  /* ---------------- Búsqueda de cliente (por nombre, negocio, RIF, dirección o N° de nota) ---------------- */
  const nkey = (nota, orderId) => { const n = String(nota || '').replace(/\D/g, '').replace(/^0+(?=\d)/, ''); return n ? 'n:' + n : 'o:' + orderId; };
  function clientsOf(sid) { return PV().S.clients.filter((c) => !c.deleted && c.active !== false && (!sid || c.sellerId === sid)).sort((a, b) => a.name.localeCompare(b.name, 'es')); }
  function searchHits(q, sid) {
    const P = PV(), norm = P.norm, t = norm(q), digits = String(q).replace(/\D/g, '');
    if (t.length < 2 && digits.length < 3) return [];
    const out = [], seen = new Set();
    if (digits.length >= 3) P.S.orders.filter((o) => !o.deleted && (!sid || o.sellerId === sid) && o.clientId && [o.valeryNote, o.delivery && o.delivery.newValery].some((n) => String(n || '').includes(digits)))
      .slice(0, 5).forEach((o) => { const n = (o.delivery && o.delivery.newValery && String(o.delivery.newValery).includes(digits)) ? o.delivery.newValery : o.valeryNote; out.push({ cid: o.clientId, label: `Nota ${n} · ${o.clientName}`, nota: n, key: nkey(n, o.id) }); });
    const toks = t.split(' ').filter(Boolean);
    if (toks.length) clientsOf(sid).filter((c) => toks.every((x) => norm([c.name, c.tradeName, c.rif, c.address, c.phone].join(' ')).includes(x)))
      .sort((a, b) => (norm(a.name).startsWith(t) ? 0 : 1) - (norm(b.name).startsWith(t) ? 0 : 1)).slice(0, 8)
      .forEach((c) => { if (!seen.has(c.id)) { seen.add(c.id); out.push({ cid: c.id, label: c.name, sub: [c.tradeName, c.rif, c.address].filter(Boolean).join(' · ') }); } });
    return out;
  }
  const sugHTML = (hits, q) => { const esc = PV().esc; return hits.length ? hits.map((h) => `<button type="button" class="sug-item" data-cid="${esc(h.cid)}" data-key="${esc(h.key || '')}"><b>${esc(h.label)}</b>${h.sub ? `<small>${esc(h.sub)}</small>` : ''}</button>`).join('')
    : (String(q).trim().length >= 2 ? '<div class="muted" style="padding:8px">No hay coincidencias en tu cartera.</div>' : ''); };

  /** Estado de cuenta del cliente: cada nota despachada o liquidada con lo abonado y su estado (del servidor; sin señal, lo del teléfono). */
  async function fetchCuenta(clientId, sid) {
    if (navigator.onLine) {
      const r = await global.Sync.pagosCall({ action: 'cuenta', clientId, sellerId: sid });
      if (r.ok) return { notas: r.data.notas, deuda: r.data.deuda, enEspera: r.data.enEspera, live: true };
      if (r.status === 401 && r.error === 'PIN') { if (global.PinGate) global.PinGate.check({ force: true }); return { notas: localCuenta(clientId), msg: '🔒 Escribe tu PIN para ver el estado de cuenta en este teléfono.' }; }
    }
    return { notas: localCuenta(clientId), msg: 'Sin internet: se muestran las notas de este teléfono, sin lo abonado.' };
  }
  function localCuenta(clientId) {
    return notasDe(clientId).map((n) => ({ ...n, key: nkey(n.nota, n.orderId), resta: n.monto, pagado: 0, estado: '', texto: '' }));
  }
  const EST = { sin_pago: 'warn-txt', parcial: 'warn-txt', en_revision: 'pay-rev', pagada: 'pay-ok' };

  /* ======================= Formulario de pago ======================= */
  function payForm(opts) {
    const P = PV(), { S, esc, usd, bs, toast, openSheet, today, fmtDate } = P;
    const sid = opts.sellerId, seller = P.sellerById(sid) || { name: '' };
    const p = { id: global.DB.uid('pg'), date: today(), sellerId: sid, sellerName: seller.name, clientId: '', clientName: '', notas: [], rate: +S.config.exchangeRate || 0,
      copRate: +S.config.copRate || 0, lines: [{ method: 'transferencia', bank: '', ref: '', amount: '' }], adjusts: [], comment: '', by: opts.by || seller.name };
    let cuenta = null, cuentaMsg = '';
    const sh = openSheet(`<div class="row"><h2 class="grow">💵 Registrar pago</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div><div id="pfBody"></div>`, { wide: true });
    const body = sh.el.querySelector('#pfBody');
    const opt = (arr, cur) => arr.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
    function draw() {
      const c = calc(p), notas = cuenta || [];
      const sel = new Set(p.notas.map((n) => nkey(n.nota, n.orderId)));
      const debenN = notas.filter((n) => n.resta > 0.01 && !sel.has(n.key)).length;
      body.innerHTML = `
        <label class="field"><span>Cliente o N° de nota</span><input id="pfCli" class="input" placeholder="Escribe 2 letras del cliente o el número de nota" value="${esc(p.clientName)}" autocomplete="off"></label>
        <div id="pfSug" class="suggest"></div>
        ${p.clientId ? `<div class="row" style="align-items:center;gap:8px;margin:10px 0 4px"><div class="section-title grow" style="margin:0">Notas de ${esc(p.clientName)}</div>${debenN ? `<button type="button" class="btn btn-sm" id="pfAll">Marcar todas las que deben (${debenN})</button>` : ''}</div>
          ${cuentaMsg ? `<p class="muted">${esc(cuentaMsg)}</p>` : ''}
          ${notas.length ? `<div class="pick-list">${notas.map((n) => { const can = n.resta > 0.01; return `<label class="sug-item" style="display:flex;gap:10px;align-items:center;${can ? '' : 'opacity:.6'}"><input type="checkbox" data-nkey="${esc(n.key)}" ${sel.has(n.key) ? 'checked' : ''} ${can ? '' : 'disabled'} style="width:22px;height:22px">
            <span class="grow"><b>Nota ${esc(n.nota || '—')}</b> · ${esc(fmtDate(n.date))} · ${usd(n.monto)}${n.manual ? ' <span class="muted">(a mano)</span>' : n.liquidado ? '' : ' <span class="muted">(sin liquidar)</span>'}${n.hoja ? ` <span class="muted">· ${esc(n.hoja)}</span>` : ''}
              ${n.texto ? `<br><span class="${EST[n.estado] || 'muted'}">${esc(n.texto)}</span>` : ''}</span></label>`; }).join('')}</div>`
            : (cuenta ? '<p class="muted">No hay notas despachadas o liquidadas de este cliente. Agrega la nota a mano.</p>' : '')}
          ${p.notas.filter((n) => !notas.some((x) => x.key === nkey(n.nota, n.orderId))).map((n) => `<div class="row" style="gap:8px;margin-top:6px"><span class="grow">Nota ${esc(n.nota)} · ${usd(n.monto)} <span class="muted">(a mano)</span></span><button class="btn btn-sm" data-rmnota="${esc(n.orderId)}">✕</button></div>`).join('')}
          <details style="margin-top:6px"><summary class="muted" style="cursor:pointer">＋ Agregar una nota a mano</summary><div class="row wrap" style="gap:8px;margin-top:6px;align-items:flex-end">
            <label class="field"><span>N° de nota</span><input id="pfMN" class="input" inputmode="numeric" placeholder="Ej: 12345"></label><label class="field"><span>Monto $ de la nota</span><input id="pfMM" class="input" inputmode="decimal" placeholder="0,00"></label>
            <button class="btn btn-sm" id="pfMAdd">Agregar</button></div></details>` : ''}
        <div class="row wrap" style="gap:8px;margin-top:10px">
          <label class="field"><span>Fecha del pago</span><input id="pfDate" type="date" class="input" value="${esc(p.date)}"></label>
          <label class="field"><span>Tasa del día (Bs por $)</span><input id="pfRate" class="input" inputmode="decimal" value="${p.rate || ''}"></label>
          ${p.lines.some((l) => l.method === 'efectivo_cop') ? `<label class="field"><span>Tasa pesos (COP por $)</span><input id="pfCop" class="input" inputmode="decimal" value="${p.copRate || ''}"></label>` : ''}</div>
        <div class="section-title" style="margin:12px 0 4px">Formas de pago</div>
        ${p.lines.map((l, i) => { const m = METHODS[l.method]; const cl = c.lines[i]; return `<div class="card card-pad pay-line" style="margin-bottom:6px"><div class="row wrap" style="gap:8px;align-items:flex-end">
          <label class="field"><span>Forma</span><select class="select" data-l="${i}" data-k="method">${opt(Object.entries(METHODS).map(([k, x]) => [k, x.label]), l.method)}</select></label>
          ${m.bank ? `<label class="field"><span>Banco</span><select class="select" data-l="${i}" data-k="bank"><option value="">— Banco —</option>${opt(banksFor().map((b) => [b, b]), l.bank)}</select></label>` : ''}
          ${m.ref ? `<label class="field"><span>N° de referencia</span><input class="input" data-l="${i}" data-k="ref" value="${esc(l.ref)}" placeholder="Referencia"></label>` : ''}
          <label class="field"><span>Monto (${m.currency === 'VES' ? 'Bs' : m.currency === 'COP' ? 'COP' : '$'})</span><input class="input" inputmode="decimal" data-l="${i}" data-k="amount" value="${esc(l.amount)}" placeholder="0,00"></label>
          <span class="muted" style="padding-bottom:12px" data-usd="${i}">≈ ${usd(cl ? cl.usd : 0)}</span>
          <button type="button" class="btn btn-sm" data-fill="${i}" title="Poner aquí lo que falta">= lo que falta</button>
          ${p.lines.length > 1 ? `<button class="btn btn-sm" data-rml="${i}" aria-label="Quitar">✕</button>` : ''}</div></div>`; }).join('')}
        <button class="btn btn-sm" id="pfAddL">＋ Otra forma de pago</button>
        <div class="section-title" style="margin:12px 0 4px">Ajustes (si aplica)</div>
        ${p.adjusts.map((a, i) => `<div class="row wrap" style="gap:8px;align-items:flex-end;margin-bottom:6px">
          <label class="field"><span>Tipo</span><select class="select" data-a="${i}" data-k="type">${opt(Object.entries(ADJUSTS), a.type)}</select></label>
          ${a.type === 'descuento' ? `<label class="field"><span>% de descuento</span><input class="input" inputmode="decimal" data-a="${i}" data-k="pct" value="${esc(a.pct)}"></label>` : `<label class="field"><span>Monto $</span><input class="input" inputmode="decimal" data-a="${i}" data-k="usd" value="${esc(a.usd)}"></label>`}
          <span class="muted" style="padding-bottom:12px" data-ausd="${i}">${usd((c.adjusts[i] || {}).usd || 0)}</span><button class="btn btn-sm" data-rma="${i}">✕</button></div>`).join('')}
        <button class="btn btn-sm" id="pfAddA">＋ Colaboración, autoconsumo, donativo o descuento</button>
        <div id="pfSum">${sumHTML(c)}</div>
        <label class="field"><span>Comentario (opcional)</span><input id="pfCom" class="input" maxlength="300" value="${esc(p.comment)}"></label>
        <p id="pfErr" class="warn-txt" style="min-height:1.2em"></p>
        <div class="actions"><button class="btn btn-primary" id="pfSave">Guardar pago</button><button class="btn" data-close>Cancelar</button></div>`;
    }
    function diffOf(c) {
      return c.debe ? (Math.abs(c.diferencia) < 0.01 ? '<b class="ok-txt">✓ Completo</b>' : c.diferencia > 0 ? `<b class="warn-txt">Falta ${usd(c.diferencia)}</b>${p.rate ? ' · ' + bs(c.diferencia * p.rate) : ''}` : `<b>Sobra ${usd(-c.diferencia)}</b>${p.rate ? ' · ' + bs(-c.diferencia * p.rate) : ''}`) : '<span class="muted">Elige la nota que paga</span>';
    }
    function sumHTML(c) {
      return `<div class="kpi-row" style="margin-top:12px"><div class="kpi"><small>Debe</small><b>${usd(c.debe)}</b>${p.rate ? `<small>${bs(c.debe * p.rate)}</small>` : ''}</div>
          <div class="kpi"><small>Pagó</small><b>${usd(c.pagado)}</b>${c.ajustes ? `<small>+ ajustes ${usd(c.ajustes)}</small>` : ''}</div><div class="kpi"><small>Diferencia</small><div style="margin-top:6px">${diffOf(c)}</div></div></div>`;
    }
    /** Al escribir: solo se actualizan los montos en $ y el resumen (sin redibujar, el cursor no se pierde). */
    function refresh() {
      const c = calc(p);
      c.lines.forEach((l, i) => { const el = body.querySelector(`[data-usd="${i}"]`); if (el) el.textContent = '≈ ' + usd(l.usd); });
      c.adjusts.forEach((a, i) => { const el = body.querySelector(`[data-ausd="${i}"]`); if (el) el.textContent = usd(a.usd); });
      const sm = body.querySelector('#pfSum'); if (sm) sm.innerHTML = sumHTML(c);
    }
    async function pickClient(cid, preKey) {
      const c = clientsOf(sid).find((x) => x.id === cid) || P.clientById(cid); if (!c) return;
      p.clientId = c.id; p.clientName = c.name; p.notas = []; cuenta = null; cuentaMsg = 'Consultando el estado de cuenta…';
      draw();
      const r = await fetchCuenta(c.id, sid);
      if (!sh.el.isConnected || p.clientId !== c.id) return;
      cuenta = r.notas; cuentaMsg = r.msg || '';
      const pre = preKey && cuenta.find((n) => n.key === preKey && n.resta > 0.01);
      if (pre) p.notas.push({ orderId: pre.orderId, nota: pre.nota, monto: r2(pre.resta) });
      draw();
    }
    const addNota = (n) => { if (!p.notas.some((x) => nkey(x.nota, x.orderId) === n.key)) p.notas.push({ orderId: n.orderId, nota: n.nota, monto: r2(n.resta) }); };
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'pfCli') { const sg = body.querySelector('#pfSug'); if (sg) sg.innerHTML = sugHTML(searchHits(t.value, sid), t.value); return; }
      if (t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'date') return;
      if (t.id === 'pfRate') p.rate = decRate(t.value);
      else if (t.id === 'pfCop') p.copRate = decRate(t.value);
      else if (t.id === 'pfCom') p.comment = t.value;
      else if (t.dataset.l !== undefined) p.lines[+t.dataset.l][t.dataset.k] = t.value;
      else if (t.dataset.a !== undefined) p.adjusts[+t.dataset.a][t.dataset.k] = t.value;
      else return;
      refresh();
    });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.tagName === 'INPUT' && t.type !== 'checkbox' && t.type !== 'date' && t.id !== 'pfCli') return; // ya se tomó al escribir
      if (t.id === 'pfCli') return; // se elige de la lista de coincidencias
      if (t.dataset.nkey) {
        const n = (cuenta || []).find((x) => x.key === t.dataset.nkey);
        if (t.checked && n) addNota(n); else p.notas = p.notas.filter((x) => nkey(x.nota, x.orderId) !== t.dataset.nkey);
        draw(); return;
      }
      if (t.id === 'pfDate') p.date = t.value;
      if (t.id === 'pfRate') p.rate = decRate(t.value);
      if (t.id === 'pfCop') p.copRate = decRate(t.value);
      if (t.id === 'pfCom') p.comment = t.value;
      if (t.dataset.l !== undefined) { const l = p.lines[+t.dataset.l]; l[t.dataset.k] = t.value; if (t.dataset.k === 'method') { l.bank = ''; l.ref = ''; } }
      if (t.dataset.a !== undefined) { const a = p.adjusts[+t.dataset.a]; a[t.dataset.k] = t.value; }
      draw();
    });
    body.addEventListener('click', async (e) => {
      const t = e.target;
      const sg = t.closest('[data-cid]');
      if (sg && body.querySelector('#pfSug').contains(sg)) { pickClient(sg.dataset.cid, sg.dataset.key || ''); return; }
      if (t.id === 'pfAll') { (cuenta || []).filter((n) => n.resta > 0.01).forEach(addNota); draw(); return; }
      if (t.dataset.fill !== undefined) {
        // Pone en esta forma de pago justo lo que falta (en su moneda)
        const i = +t.dataset.fill, l = p.lines[i], m = METHODS[l.method]; l.amount = '';
        const falta = calc(p).diferencia;
        if (falta <= 0.004) { toast('No falta nada', 'ok'); draw(); return; }
        if (m.currency === 'VES' && !(p.rate > 0)) { toast('Escribe primero la tasa del día', 'err'); return; }
        if (m.currency === 'COP' && !(p.copRate > 0)) { toast('Escribe primero la tasa de los pesos', 'err'); return; }
        const v = m.currency === 'USD' ? falta : m.currency === 'VES' ? falta * p.rate : falta * p.copRate;
        l.amount = String(r2(v)).replace('.', ','); draw(); return;
      }
      if (t.id === 'pfAddL') { p.lines.push({ method: 'efectivo_usd', bank: '', ref: '', amount: '' }); draw(); return; }
      if (t.id === 'pfAddA') { p.adjusts.push({ type: 'colaboracion', usd: '', pct: '' }); draw(); return; }
      if (t.dataset.rml) { p.lines.splice(+t.dataset.rml, 1); draw(); return; }
      if (t.dataset.rma) { p.adjusts.splice(+t.dataset.rma, 1); draw(); return; }
      if (t.dataset.rmnota) { p.notas = p.notas.filter((x) => x.orderId !== t.dataset.rmnota); draw(); return; }
      if (t.id === 'pfMAdd') {
        const nn = String(body.querySelector('#pfMN').value).replace(/\D/g, ''), mm = r2(dec(body.querySelector('#pfMM').value));
        if (!nn || !(mm > 0)) { toast('Escribe el número de nota y su monto', 'err'); return; }
        const known = (cuenta || []).find((x) => x.key === nkey(nn, ''));
        if (known) { if (known.resta > 0.01) { addNota(known); toast(`La nota ${nn} ya está en la cuenta del cliente: quedó marcada`, 'ok'); } else toast(`La nota ${nn} ya está pagada (${known.texto})`, 'err'); draw(); return; }
        if (p.notas.some((x) => nkey(x.nota, x.orderId) === nkey(nn, ''))) { toast('Esa nota ya está en este pago', 'err'); return; }
        p.notas.push({ orderId: 'manual:' + nn, nota: nn, monto: mm }); draw(); return;
      }
      if (t.id === 'pfSave') {
        const err = body.querySelector('#pfErr');
        const out = { ...p, notas: p.notas.map((n) => ({ ...n })), lines: p.lines.map((l) => ({ ...l, amount: dec(l.amount), ref: METHODS[l.method].ref ? normRef(l.ref) : '' })),
          adjusts: p.adjusts.map((a) => ({ type: a.type, pct: dec(a.pct), usd: dec(a.usd) })) };
        if (!out.clientId) { err.textContent = 'Elige el cliente de tu cartera'; return; }
        if (!out.notas.length) { err.textContent = 'Marca la nota (o notas) que paga'; return; }
        for (const l of out.lines) {
          const m = METHODS[l.method];
          if (!(l.amount > 0)) { err.textContent = `Escribe el monto de ${m.label}`; return; }
          if (m.bank && !l.bank) { err.textContent = `${m.label}: elige el banco`; return; }
          if (m.ref && l.ref.length < 4) { err.textContent = `${m.label}: escribe el número de referencia`; return; }
          if (m.currency === 'VES' && !(out.rate > 0)) { err.textContent = 'Escribe la tasa del día (Bs por $)'; return; }
          if (m.currency === 'COP' && !(out.copRate > 0)) { err.textContent = 'Escribe la tasa de los pesos (COP por $)'; return; }
        }
        const refs = out.lines.filter((l) => l.ref).map((l) => l.ref);
        if (new Set(refs).size !== refs.length) { err.textContent = 'La misma referencia está dos veces'; return; }
        const c = calc(out);
        if (c.diferencia > 0.01 && !confirm(`Falta ${usd(c.diferencia)} para cubrir lo que debe. ¿Guardar como abono?`)) return;
        t.disabled = true;
        const r = await global.Sync.pagosCall({ action: 'create', pago: out });
        t.disabled = false;
        if (r.ok) { sh.close(); toast('Pago guardado: queda en espera de cobranza', 'ok'); P.logEvent('pago', `Registró pago de ${out.clientName} · ${usd(c.pagado + c.ajustes)}`, { clientName: out.clientName }); if (opts.onSaved) opts.onSaved(); return; }
        if (r.offline || !r.status || r.status >= 500) {
          await setPend((await pend()).concat(out)); sh.close();
          toast('Sin señal: el pago quedó guardado en el teléfono y se sube solo al volver la señal', 'ok'); if (opts.onSaved) opts.onSaved(); return;
        }
        if (r.status === 401 && r.error === 'PIN') { err.textContent = 'Escribe tu PIN para registrar pagos en este teléfono'; if (global.PinGate) global.PinGate.check({ force: true }); return; }
        err.textContent = r.error || 'No se pudo guardar';
      }
    });
    draw();
    if (opts.clientId) pickClient(opts.clientId, opts.notaKey || '');
    else setTimeout(() => { const i = body.querySelector('#pfCli'); if (i) i.focus(); }, 60);
  }

  /* ======================= Estado de cuenta de un cliente ======================= */
  function cuentaSheet(sid, cid) {
    const P = PV(), { esc, usd, fmtDate, openSheet } = P;
    const sh = openSheet(`<div class="row"><h2 class="grow">📒 Estado de cuenta</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <label class="field"><span>Cliente o N° de nota</span><input id="ecCli" class="input" placeholder="Escribe 2 letras del cliente o el número de nota" autocomplete="off"></label>
      <div id="ecSug" class="suggest"></div><div id="ecOut"></div>`, { wide: true });
    const out = sh.el.querySelector('#ecOut');
    const show = async (id) => {
      const c = P.clientById(id); if (!c) return;
      sh.el.querySelector('#ecCli').value = c.name; sh.el.querySelector('#ecSug').innerHTML = '';
      out.innerHTML = '<p class="muted">Consultando…</p>';
      const r = await fetchCuenta(c.id, sid);
      const notas = r.notas || [];
      out.innerHTML = `${r.msg ? `<div class="hint warn">${esc(r.msg)}</div>` : ''}
        ${r.live ? `<div class="kpi-row" style="margin-top:8px"><div class="kpi"><small>Debe</small><b class="${r.deuda > 0.01 ? 'warn-txt' : ''}">${usd(r.deuda)}</b><small>${notas.filter((n) => n.resta > 0.01).length} nota(s) por cobrar</small></div>
          <div class="kpi"><small>Esperando a cobranza</small><b>${usd(r.enEspera)}</b></div></div>` : ''}
        ${notas.length ? notas.map((n) => `<div class="card card-pad" style="margin-bottom:6px"><div class="row wrap" style="gap:8px;align-items:center"><span class="grow"><b>Nota ${esc(n.nota || '—')}</b> · ${esc(fmtDate(n.date))} · ${usd(n.monto)}${n.hoja ? ` <span class="muted">· ${esc(n.hoja)}</span>` : ''}${n.manual ? ' <span class="muted">(a mano)</span>' : ''}
            ${n.texto ? `<br><span class="${EST[n.estado] || 'muted'}">${esc(n.texto)}</span>` : ''}</span>
          ${n.resta > 0.01 ? `<button class="btn btn-sm btn-primary" data-pay="${esc(n.key)}">💵 Pagar ${usd(n.resta)}</button>` : ''}</div></div>`).join('')
          : '<p class="muted">Sin notas despachadas o liquidadas de este cliente.</p>'}
        <div class="actions"><button class="btn btn-primary" data-pay="">＋ Registrar pago de ${esc(c.name)}</button></div>`;
      out.onclick = (e) => { const b = e.target.closest('[data-pay]'); if (!b) return; sh.close(); payForm({ sellerId: sid, clientId: c.id, notaKey: b.dataset.pay, onSaved: () => { if (location.hash === '#/ruta/pagos') { PV().S.ui.pagos = null; renderSeller(); } } }); };
    };
    sh.el.querySelector('#ecCli').addEventListener('input', (e) => { sh.el.querySelector('#ecSug').innerHTML = sugHTML(searchHits(e.target.value, sid), e.target.value); });
    sh.el.querySelector('#ecSug').addEventListener('click', (e) => { const b = e.target.closest('[data-cid]'); if (b) show(b.dataset.cid); });
    if (cid) show(cid); else setTimeout(() => sh.el.querySelector('#ecCli').focus(), 60);
  }

  /**
   * Estado de pago junto a cada nota en cualquier pantalla (Mis pedidos, lupa…): los elementos con
   * data-paynota / data-payoid / data-paymonto se llenan con una sola consulta.
   */
  async function fillStatus(root) {
    const els = [...(root || document).querySelectorAll('[data-paymonto]')].filter((el) => !el.dataset.payDone);
    if (!els.length || !navigator.onLine) return;
    els.forEach((el) => { el.dataset.payDone = '1'; });
    const notas = els.map((el) => ({ nota: el.dataset.paynota || '', orderId: el.dataset.payoid || '', monto: +el.dataset.paymonto || 0 }));
    const r = await global.Sync.pagosCall({ action: 'estado', notas });
    if (!r.ok) return;
    els.forEach((el, i) => { const x = r.data.byKey[nkey(notas[i].nota, notas[i].orderId)]; if (!x || !el.isConnected) return;
      el.className = 'pay-st ' + (EST[x.estado] || 'muted'); el.textContent = `💵 ${notas[i].nota ? 'Nota ' + notas[i].nota + ' · ' : ''}${x.texto}`; });
  }

  /* ======================= Detalle de un pago ======================= */
  function payHTML(p) {
    const { esc, usd, bs, fmtDate } = PV();
    const c = { debe: p.debe, pagado: p.pagado, ajustes: p.ajustes, diferencia: p.diferencia };
    const money = (l) => (l.currency === 'VES' ? bs(l.amount) : l.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(l.amount) : usd(l.amount));
    return `<div class="muted">${esc(fmtDate(p.date))} · ${esc(p.sellerName || '')} · notas ${esc(p.notas.map((n) => n.nota || '—').join(', '))}</div>
      <table class="lines" style="margin-top:6px"><tbody>${p.lines.map((l) => `<tr><td>${esc((METHODS[l.method] || {}).label || l.method)}${l.bank ? ' · ' + esc(l.bank) : ''}${l.ref ? ' · Ref ' + esc(l.ref) : ''}</td><td class="num">${money(l)}</td><td class="num">${usd(l.usd)}</td></tr>`).join('')}
        ${(p.adjusts || []).map((a) => `<tr><td>${esc(ADJUSTS[a.type] || a.type)}${a.type === 'descuento' ? ' ' + a.pct + ' %' : ''}</td><td></td><td class="num">${usd(a.usd)}</td></tr>`).join('')}</tbody></table>
      <div class="row" style="justify-content:space-between;margin-top:6px"><span>Debe ${usd(c.debe)} · Pagó ${usd(c.pagado)}${c.ajustes ? ' + ajustes ' + usd(c.ajustes) : ''}</span><b>${Math.abs(c.diferencia) < 0.01 ? '✓ Completo' : c.diferencia > 0 ? 'Falta ' + usd(c.diferencia) : 'Sobra ' + usd(-c.diferencia)}</b></div>
      ${p.rate ? `<div class="muted" style="font-size:12px">Tasa ${esc(String(p.rate))} Bs/$${p.copRate ? ' · ' + esc(String(p.copRate)) + ' COP/$' : ''}</div>` : ''}
      ${p.comment ? `<div class="muted">📝 ${esc(p.comment)}</div>` : ''}
      ${p.review && p.review.motivo && p.status !== 'aprobado' ? `<div class="hint ${p.status === 'rechazado' ? 'warn' : ''}">${esc(p.review.by || '')}: ${esc(p.review.motivo)}</div>` : ''}`;
  }
  const pill = (s) => `<span class="status ${(ST[s] || ST.espera)[1]}">${(ST[s] || [s])[0]}</span>`;

  /** Totales por forma de pago (cierre de caja): Bs, $ y COP por separado, más el equivalente en $. */
  function totals(pagos) {
    const t = {};
    pagos.filter((p) => p.status !== 'rechazado' && p.status !== 'anulado').forEach((p) => p.lines.forEach((l) => {
      const k = l.method; const x = t[k] || (t[k] = { method: k, currency: l.currency, amount: 0, usd: 0, n: 0 });
      x.amount = r2(x.amount + l.amount); x.usd = r2(x.usd + l.usd); x.n++;
    }));
    return Object.values(t);
  }

  function excel(pagos, title) {
    const E = global.Exporta, rows = [];
    pagos.slice().sort((a, b) => String(a.sellerName).localeCompare(String(b.sellerName), 'es') || a.date.localeCompare(b.date) || String(a.clientName).localeCompare(String(b.clientName), 'es')).forEach((p) => {
      p.lines.forEach((l) => rows.push([p.date, p.sellerName, p.clientName, p.notas.map((n) => n.nota).join(', '), (METHODS[l.method] || {}).label || l.method, l.bank, l.ref, l.amount, l.currency === 'VES' ? 'Bs' : l.currency === 'COP' ? 'COP' : '$', l.currency === 'VES' ? p.rate : l.currency === 'COP' ? p.copRate : '', l.usd, (ST[p.status] || [p.status])[0], p.id]));
      (p.adjusts || []).forEach((a) => rows.push([p.date, p.sellerName, p.clientName, p.notas.map((n) => n.nota).join(', '), (ADJUSTS[a.type] || a.type) + (a.type === 'descuento' ? ' ' + a.pct + '%' : ''), '', '', a.usd, '$', '', a.usd, (ST[p.status] || [p.status])[0], p.id]));
    });
    return E.table({ name: 'Pagos', title: 'PAGOS DE CLIENTES', subtitle: title, cols: [{ h: 'FECHA', k: 'date', w: 12 }, { h: 'VENDEDOR', w: 16 }, { h: 'CLIENTE', w: 32 }, { h: 'NOTAS', w: 14 }, { h: 'FORMA DE PAGO', w: 18 }, { h: 'BANCO', w: 22 }, { h: 'REFERENCIA', w: 16 },
      { h: 'MONTO', k: 'money', w: 14 }, { h: 'MONEDA', w: 8 }, { h: 'TASA', w: 10 }, { h: 'EQUIVALENTE $', k: 'money', w: 14, total: true }, { h: 'ESTADO', w: 22 }, { h: 'ID', w: 14 }], rows });
  }

  /* ======================= Pantalla del vendedor ======================= */
  function renderSeller() {
    const P = PV(), { S, $, esc, usd, toast, openSheet, today } = P;
    const app = document.getElementById('app');
    const seller = P.sellerById(S.session.sellerId), sid = seller.id;
    const st = S.ui.pagos || (S.ui.pagos = { r: 'hoy', list: null, err: '' });
    const dm = (n) => { const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    const range = st.r === '7d' ? { from: dm(6), to: today() } : st.r === 'mes' ? { from: today().slice(0, 8) + '01', to: today() } : { from: today(), to: today() };
    app.innerHTML = `${P.brandHeader(seller.name, 'Pagos de mis clientes', `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="row wrap" style="gap:8px;align-items:center"><button class="btn btn-primary" id="pgNew">＋ Registrar pago</button><button class="btn" id="pgCta">📒 Estado de cuenta</button>
          <div class="chips" id="pgR">${[['hoy', 'Hoy'], ['7d', 'Últimos 7 días'], ['mes', 'Este mes']].map(([k, l]) => `<button class="chip ${st.r === k ? 'active' : ''}" data-r="${k}">${l}</button>`).join('')}</div></div>
        <div id="pgBody"><p class="muted">Cargando…</p></div>
      </div>${P.creditFooter()}`;
    $('#bell').onclick = P.notifSheet; P.updateBell(); $('#syncPill').onclick = () => P.runSync(true); P.updateSyncPill();
    $('#pgR').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { st.r = b.dataset.r; st.list = null; renderSeller(); } };
    $('#pgNew').onclick = () => payForm({ sellerId: sid, onSaved: () => { st.list = null; renderSeller(); } });
    $('#pgCta').onclick = () => cuentaSheet(sid);
    (async () => {
      await flush();
      const local = (await pend()).filter((p) => p.sellerId === sid).map((p) => ({ ...p, ...calc(p), status: 'local' }));
      const r = await global.Sync.pagosCall({ action: 'mine', sellerId: sid, from: range.from, to: range.to });
      const box = document.getElementById('pgBody'); if (!box || S.ui.pagos !== st) return;
      if (!r.ok && r.status === 401 && r.error === 'PIN') { box.innerHTML = '<div class="hint warn">🔒 Escribe tu PIN para ver tus pagos en este teléfono.</div>'; if (global.PinGate) global.PinGate.check({ force: true }); return; }
      const list = local.concat(r.ok ? r.data.pagos : []);
      const tot = totals(list), all = list.filter((p) => p.status !== 'rechazado' && p.status !== 'anulado');
      box.innerHTML = `${r.ok ? '' : `<div class="hint warn">${esc(r.error || 'Sin conexión')}: se muestran solo los pagos guardados en este teléfono.</div>`}
        <div class="kpi-row" style="margin-top:10px"><div class="kpi"><small>Cobrado (${esc(range.from === range.to ? 'hoy' : 'período')})</small><b>${usd(all.reduce((a, p) => a + p.pagado + p.ajustes, 0))}</b><small>${all.length} pagos</small></div>
          <div class="kpi"><small>En espera de cobranza</small><b>${list.filter((p) => p.status === 'espera' || p.status === 'local').length}</b></div>
          <div class="kpi"><small>Aprobados</small><b>${list.filter((p) => p.status === 'aprobado').length}</b><small>${list.filter((p) => p.status === 'rechazado').length} rechazados</small></div></div>
        ${tot.length ? `<div class="card card-pad"><b>Cierre por forma de pago</b>${tot.map((x) => `<div class="row" style="justify-content:space-between"><span>${esc(METHODS[x.method].label)} (${x.n})</span><span>${x.currency === 'VES' ? P.bs(x.amount) : x.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(x.amount) : usd(x.amount)} · ≈ ${usd(x.usd)}</span></div>`).join('')}</div>` : ''}
        <div class="row wrap" style="gap:8px;margin:10px 0"><button class="btn" id="pgPrint">🖨 Imprimir para cobranzas</button><button class="btn" id="pgXls">⇩ Excel</button></div>
        ${list.length ? list.map((p, i) => `<div class="card card-pad" style="margin-bottom:8px" data-i="${i}"><div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${esc(p.clientName)} · ${usd(p.pagado + p.ajustes)}</b>${pill(p.status)}</div>
          ${payHTML(p)}${p.error ? `<div class="hint warn">⚠ ${esc(p.error)}</div>` : ''}
          ${p.status === 'espera' ? `<div class="actions"><button class="btn btn-sm" data-anular="${esc(p.id)}">Anular (me equivoqué)</button></div>` : p.status === 'local' ? `<div class="actions"><button class="btn btn-sm" data-borrar="${esc(p.id)}">Borrar del teléfono</button></div>` : ''}</div>`).join('')
          : '<div class="empty card"><strong>Sin pagos en este período</strong>Toca «＋ Registrar pago».</div>'}`;
      box.onclick = async (e) => {
        const an = e.target.closest('[data-anular]'), bo = e.target.closest('[data-borrar]');
        if (an) { if (!confirm('¿Anular este pago? Se libera su referencia para registrarlo bien.')) return; const r2x = await global.Sync.pagosCall({ action: 'anular', id: an.dataset.anular, sellerId: sid }); toast(r2x.ok ? 'Pago anulado' : r2x.error || 'No se pudo', r2x.ok ? 'ok' : 'err'); st.list = null; renderSeller(); }
        if (bo) { if (!confirm('¿Borrar este pago que no se ha subido?')) return; await setPend((await pend()).filter((p) => p.id !== bo.dataset.borrar)); renderSeller(); }
      };
      $('#pgPrint').onclick = () => global.Print.printPagos(list.filter((p) => p.status !== 'anulado'), { config: S.config, title: `Pagos de ${seller.name} · ${range.from === range.to ? range.from : range.from + ' al ' + range.to}`, METHODS, ADJUSTS, ST });
      $('#pgXls').onclick = () => global.Exporta.save(`pagos_${seller.name}_${range.from}_${range.to}.xlsx`, [excel(list, `${seller.name} · ${range.from} al ${range.to}`)]);
    })();
  }

  /* ======================= Oficina: cobranza ======================= */
  function renderOffice(root) {
    const P = PV(), { S, esc, usd, toast, today } = P;
    const st = S.ui.office.pagos || (S.ui.office.pagos = { from: today(), to: today(), seller: '', status: 'espera' });
    root.innerHTML = `<div class="card card-pad"><div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="field"><span>Desde</span><input id="pfFrom" type="date" class="input" value="${esc(st.from)}"></label><label class="field"><span>Hasta</span><input id="pfTo" type="date" class="input" value="${esc(st.to)}"></label>
        <label class="field"><span>Vendedor</span><select id="pfSel" class="select"><option value="">Todos</option>${S.sellers.filter((s) => s.active !== false).map((s) => `<option value="${esc(s.id)}" ${s.id === st.seller ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Estado</span><select id="pfSt" class="select">${[['', 'Todos'], ['espera', 'En espera de cobranza'], ['aprobado', 'Aprobados'], ['rechazado', 'Rechazados'], ['anulado', 'Anulados']].map(([k, l]) => `<option value="${k}" ${k === st.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn btn-primary" id="pfGo">Consultar</button></div></div><div id="pfOut" style="margin-top:12px"><p class="muted">Cargando…</p></div>`;
    const q = (id) => root.querySelector(id);
    const load = async () => {
      Object.assign(st, { from: q('#pfFrom').value, to: q('#pfTo').value, seller: q('#pfSel').value, status: q('#pfSt').value });
      const r = await global.Sync.pagosCall({ action: 'list', from: st.from, to: st.to, sellerId: st.seller, status: st.status });
      const out = q('#pfOut'); if (!out) return;
      if (!r.ok) { out.innerHTML = `<div class="hint warn">${esc(r.error || 'No se pudo consultar')}</div>`; return; }
      const pagos = r.data.pagos, office = !!(S.settings && S.settings.adminKey);
      const bySeller = new Map(); pagos.forEach((p) => bySeller.set(p.sellerName || p.sellerId, (bySeller.get(p.sellerName || p.sellerId) || []).concat(p)));
      const tot = totals(pagos);
      out.innerHTML = `<div class="kpi-row"><div class="kpi"><small>Pagos</small><b>${pagos.length}</b><small>${pagos.filter((p) => p.status === 'espera').length} en espera</small></div>
          <div class="kpi"><small>Total cobrado (≈ $)</small><b>${usd(pagos.filter((p) => p.status !== 'rechazado' && p.status !== 'anulado').reduce((a, p) => a + p.pagado + p.ajustes, 0))}</b></div>
          ${tot.map((x) => `<div class="kpi"><small>${esc(METHODS[x.method].label)}</small><b>${x.currency === 'VES' ? P.bs(x.amount) : x.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(x.amount) : usd(x.amount)}</b><small>${x.n} · ≈ ${usd(x.usd)}</small></div>`).join('')}</div>
        <div class="row wrap" style="gap:8px;margin:6px 0 10px"><button class="btn" id="pfPrint">🖨 Imprimir (por vendedor)</button><button class="btn" id="pfXls">⇩ Excel</button></div>
        ${pagos.length ? [...bySeller.entries()].map(([name, list]) => `<h3>${esc(name)} · ${list.length} pago${list.length === 1 ? '' : 's'}</h3>
          ${list.map((p) => `<div class="card card-pad" style="margin-bottom:8px"><div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${esc(p.clientName)} · ${usd(p.pagado + p.ajustes)}</b>${pill(p.status)}</div>${payHTML(p)}
            ${office ? `<div class="actions">${p.status === 'espera' ? `<button class="btn btn-sm btn-ok" data-ap="${esc(p.id)}">✅ Aprobar</button><button class="btn btn-sm btn-danger" data-re="${esc(p.id)}">✖ Rechazar</button>` : `<button class="btn btn-sm" data-ab="${esc(p.id)}">↺ Volver a «en espera»</button>`}</div>` : ''}</div>`).join('')}`).join('')
          : '<div class="empty card"><strong>Sin pagos</strong>con esos filtros.</div>'}`;
      out.onclick = async (e) => {
        const ap = e.target.closest('[data-ap]'), re = e.target.closest('[data-re]'), ab = e.target.closest('[data-ab]');
        const by = (S.config && S.config.adminName) || 'Cobranza';
        if (ap) { const x = await global.Sync.pagosCall({ action: 'review', id: ap.dataset.ap, status: 'aprobado', by }); toast(x.ok ? 'Pago aprobado' : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('pago_aprobado', `Aprobó el pago de ${x.data.pago.clientName} (${x.data.pago.sellerName}) · ${usd(x.data.pago.pagado + x.data.pago.ajustes)}`); load(); }
        if (re) { const m = prompt('Motivo del rechazo (le llega al vendedor):'); if (!m) return; const x = await global.Sync.pagosCall({ action: 'review', id: re.dataset.re, status: 'rechazado', motivo: m, by }); toast(x.ok ? 'Pago rechazado' : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('pago_rechazado', `Rechazó el pago de ${x.data.pago.clientName} (${x.data.pago.sellerName}): ${m}`); load(); }
        if (ab) { if (!confirm('¿Volver este pago a «en espera de cobranza»?')) return; const x = await global.Sync.pagosCall({ action: 'reabrir', id: ab.dataset.ab, by }); toast(x.ok ? 'Pago en espera otra vez' : x.error, x.ok ? 'ok' : 'err'); load(); }
      };
      q('#pfPrint').onclick = () => global.Print.printPagos(pagos.filter((p) => p.status !== 'anulado'), { config: S.config, title: `Pagos del ${st.from}${st.to !== st.from ? ' al ' + st.to : ''}`, METHODS, ADJUSTS, ST });
      q('#pfXls').onclick = () => global.Exporta.save(`pagos_${st.from}_${st.to}.xlsx`, [excel(pagos, `Del ${st.from} al ${st.to}`)]);
    };
    q('#pfGo').onclick = load;
    load();
  }

  /* ======================= Ajustes: cuentas de la empresa ======================= */
  function renderAccounts(box, draft) {
    const P = PV(), { S, esc, toast } = P;
    const list = draft || (S.config.payAccounts || []).slice();
    box.innerHTML = `<h3>🏦 Cuentas para cobrar y tasas</h3>
      <p class="muted">Las cuentas de la empresa donde pagan los clientes. El vendedor elige el banco de esta lista al registrar un pago (si no hay ninguna, ve la lista de bancos de Venezuela).</p>
      <div class="row wrap" style="gap:8px"><label class="field"><span>Tasa del día (Bs por $)</span><input id="acRate" class="input" inputmode="decimal" value="${esc(S.config.exchangeRate || '')}" disabled title="Se cambia en «Precios» de Ajustes"></label>
        <label class="field"><span>Tasa pesos colombianos (COP por $)</span><input id="acCop" class="input" inputmode="decimal" value="${esc(S.config.copRate || '')}"></label></div>
      <datalist id="acBanks">${BANKS.map((b) => `<option value="${esc(b)}">`).join('')}</datalist>
      ${list.map((a, i) => `<div class="row wrap" style="gap:8px;align-items:flex-end;margin-top:8px" data-ac="${i}">
        <label class="field"><span>Banco</span><input class="input" list="acBanks" data-k="bank" value="${esc(a.bank)}"></label>
        <label class="field"><span>Tipo</span><select class="select" data-k="kind">${[['transferencia', 'Transferencia'], ['pago_movil', 'Pago móvil'], ['ambos', 'Transferencia y pago móvil']].map(([k, l]) => `<option value="${k}" ${a.kind === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="field"><span>Titular</span><input class="input" data-k="holder" value="${esc(a.holder || '')}"></label>
        <label class="field"><span>Cuenta / teléfono</span><input class="input" data-k="number" value="${esc(a.number || '')}"></label>
        <label class="field"><span>RIF / C.I.</span><input class="input" data-k="rif" value="${esc(a.rif || '')}"></label>
        <button class="btn btn-sm btn-danger" data-rm="${i}">✕</button></div>`).join('')}
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-sm" id="acAdd">＋ Agregar cuenta</button><button class="btn btn-sm btn-primary" id="acSave">Guardar cuentas</button></div>`;
    const read = () => [...box.querySelectorAll('[data-ac]')].map((row) => { const g = (k) => { const el = row.querySelector(`[data-k="${k}"]`); return el ? el.value.trim() : ''; }; return { bank: g('bank'), kind: g('kind'), holder: g('holder'), number: g('number'), rif: g('rif') }; });
    const save = async (accs) => {
      const cop = decRate(box.querySelector('#acCop').value);
      await P.saveDocs('config', { ...S.config, payAccounts: accs.filter((a) => a.bank), copRate: cop || 0 });
      toast('Cuentas guardadas', 'ok'); P.runSync(false); renderAccounts(box);
    };
    box.querySelector('#acAdd').onclick = () => { const a = read(); a.push({ bank: '', kind: 'ambos', holder: '', number: '', rif: '' }); renderAccounts(box, a); };
    box.querySelector('#acSave').onclick = () => save(read());
    box.onclick = (e) => { const rm = e.target.closest('[data-rm]'); if (rm) { const a = read(); a.splice(+rm.dataset.rm, 1); save(a); } };
  }

  global.Pagos = { calc, METHODS, ADJUSTS, BANKS, normRef, renderSeller, renderOffice, renderAccounts, payForm, cuentaSheet, fillStatus, flush };
})(window);
