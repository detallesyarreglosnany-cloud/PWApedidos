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
    anterior: { label: 'Pago anterior (FileMaker)', currency: 'USD', ref: false, bank: false, hidden: true },
  };
  const ORIGEN = { anterior: '🗂 Pago anterior (FileMaker)', filemaker: '⇩ Importado de FileMaker' };
  // Día de subida en hora de Venezuela (UTC−4)
  const vzDay = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t - 4 * 3600000).toISOString().slice(0, 10) : ''; };
  const vzTime = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t - 4 * 3600000).toISOString().slice(11, 16) : ''; };
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
  const REF_MIN = 6; // referencia completa (igual que el servidor)
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
  // Un pago con un error que el vendedor debe corregir (referencia repetida, nota de otro cliente…) no se reintenta solo
  const needsFix = (p) => !!p.error && [400, 409, 422].includes(+p.errStatus || 409);
  async function flushNow() {
    const list = await pend(); if (!list.length || !navigator.onLine) return { sent: 0, left: list.length };
    const left = []; let sent = 0, nuevos = 0;
    for (const p of list) {
      if (needsFix(p)) { left.push(p); continue; }
      const r = await global.Sync.pagosCall({ action: 'create', pago: { ...p, error: undefined, errStatus: undefined } });
      if (r.ok) sent++;
      else if (r.offline || !r.status || r.status >= 500 || r.status === 401) left.push({ ...p, error: r.status === 401 ? 'Falta tu PIN para subirlo' : undefined, errStatus: r.status === 401 ? 401 : undefined });
      else { left.push({ ...p, error: r.error || 'No se pudo subir', errStatus: r.status }); nuevos++; } // p. ej. referencia repetida: el vendedor lo corrige o lo borra
    }
    await setPend(left);
    if (nuevos) { const P = PV(); if (P && P.localNotif) P.localNotif({ kind: 'pago', icon: '⚠', warn: true, msg: `${nuevos} pago${nuevos === 1 ? '' : 's'} guardado${nuevos === 1 ? '' : 's'} sin señal no se pudo subir: corrígelo en «Pagos» (✏️ Corregir).` }); if (P && P.toast) P.toast('⚠ Un pago sin señal necesita corrección: revisa «Pagos»', 'err'); }
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
        return monto > 0 ? { orderId: o.id, nota: noteFmt((d && d.newValery) || o.valeryNote), monto, date: (d && d.date) || o.routeDate, liquidado: !!d } : null;
      }).filter(Boolean).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }

  const accounts = () => ((PV().S.config && PV().S.config.payAccounts) || []).filter((a) => a && a.bank);
  const banksFor = () => { const a = [...new Set(accounts().map((x) => x.bank))]; return a.length ? a : BANKS; };

  /* ---------------- Búsqueda de cliente (por nombre, negocio, RIF, dirección o N° de nota) ---------------- */
  // Varias notas en un pedido: «85643-85644» (se muestra así; la clave de cobro son todos los números juntos, como siempre)
  const noteFmt = (v) => (String(v == null ? '' : v).match(/\d+/g) || []).join('-');
  const noteParts = (v) => (String(v == null ? '' : v).match(/\d+/g) || []).map((x) => x.replace(/^0+(?=\d)/, ''));
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
    const ed = opts.edit || null; // corregir un pago guardado sin señal que el servidor rechazó (mismo id: nunca se duplica)
    const p = ed ? { ...ed, notas: ed.notas.map((n) => ({ ...n })), lines: ed.lines.map((l) => ({ method: l.method, bank: l.bank || '', ref: l.ref || '', amount: l.amount })), adjusts: (ed.adjusts || []).map((a) => ({ ...a })), error: undefined, errStatus: undefined }
      : { id: global.DB.uid('pg'), date: today(), sellerId: sid, sellerName: seller.name, clientId: '', clientName: '', notas: [], rate: +S.config.exchangeRate || 0,
        copRate: +S.config.copRate || 0, lines: [{ method: 'transferencia', bank: '', ref: '', amount: '' }], adjusts: [], comment: '', by: opts.by || seller.name };
    let cuenta = null, cuentaMsg = '';
    const sh = openSheet(`<div class="row"><h2 class="grow">💵 ${ed ? 'Corregir pago sin subir' : 'Registrar pago'}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div><div id="pfBody"></div>`, { wide: true });
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
          <label class="field"><span>Forma</span><select class="select" data-l="${i}" data-k="method">${opt(Object.entries(METHODS).filter(([, x]) => !x.hidden).map(([k, x]) => [k, x.label]), l.method)}</select></label>
          ${m.bank ? `<label class="field"><span>Banco</span><select class="select" data-l="${i}" data-k="bank"><option value="">— Banco —</option>${opt(banksFor().map((b) => [b, b]), l.bank)}</select></label>` : ''}
          ${m.ref ? `<label class="field"><span>N° de referencia (completa)</span><input class="input" data-l="${i}" data-k="ref" value="${esc(l.ref)}" placeholder="Mínimo ${REF_MIN} dígitos" autocomplete="off"><small class="warn-txt" data-refmsg="${i}">${esc(l._dup || '')}</small></label>` : ''}
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
    /** Al escribir la referencia: avisa al instante si ya está en otro pago (servidor o este teléfono) y no deja guardar. */
    const refTimers = {};
    function setRefMsg(i, msg) { const l = p.lines[i]; if (!l) return; l._dup = msg; const el = body.querySelector(`[data-refmsg="${i}"]`); if (el) el.textContent = msg; }
    function checkRef(i) {
      clearTimeout(refTimers[i]);
      const l = p.lines[i], ref = normRef(l && l.ref);
      if (!l || ref.length < REF_MIN) { setRefMsg(i, ref && ref.length < REF_MIN ? `Escribe la referencia completa (mínimo ${REF_MIN} dígitos)` : ''); return; }
      const twice = p.lines.some((x, j) => j !== i && METHODS[x.method] && METHODS[x.method].ref && normRef(x.ref) === ref);
      if (twice) { setRefMsg(i, '⚠ Esta referencia ya está en otra forma de pago de este mismo pago'); return; }
      setRefMsg(i, '');
      refTimers[i] = setTimeout(async () => {
        const local = (await pend()).find((x) => x.id !== p.id && (x.lines || []).some((y) => normRef(y.ref) === ref));
        if (local) { setRefMsg(i, `⚠ Ya la usaste en un pago de ${local.clientName} guardado sin señal`); return; }
        if (!navigator.onLine) return; // sin señal: el servidor la revisa al subir
        const r = await global.Sync.pagosCall({ action: 'ref', refs: [ref], pagoId: p.id });
        if (!sh.el.isConnected || normRef(p.lines[i] && p.lines[i].ref) !== ref) return;
        const u = r.ok && r.data.usadas[ref];
        setRefMsg(i, u ? `⚠ Referencia ya registrada: pago de ${u.clientName} (${u.sellerName || 'oficina'}, ${fmtDate(u.date)}). Una referencia no se repite: revisa el comprobante.` : '');
      }, 450);
    }
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'pfCli') { const sg = body.querySelector('#pfSug'); if (sg) sg.innerHTML = sugHTML(searchHits(t.value, sid), t.value); return; }
      if (t.tagName !== 'INPUT' || t.type === 'checkbox' || t.type === 'date') return;
      if (t.id === 'pfRate') p.rate = decRate(t.value);
      else if (t.id === 'pfCop') p.copRate = decRate(t.value);
      else if (t.id === 'pfCom') p.comment = t.value;
      else if (t.dataset.l !== undefined) { p.lines[+t.dataset.l][t.dataset.k] = t.value; if (t.dataset.k === 'ref') checkRef(+t.dataset.l); }
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
        const nn = noteFmt(body.querySelector('#pfMN').value), mm = r2(dec(body.querySelector('#pfMM').value));
        if (!nn || !(mm > 0)) { toast('Escribe el número de nota y su monto', 'err'); return; }
        // También si es UNA de las notas de un pedido con varias («85643» de «85643-85644»)
        const known = (cuenta || []).find((x) => x.key === nkey(nn, '')) || (noteParts(nn).length === 1 ? (cuenta || []).find((x) => noteParts(x.nota).length > 1 && noteParts(x.nota).includes(noteParts(nn)[0])) : null);
        if (known) { if (known.resta > 0.01) { addNota(known); toast(`La nota ${nn} ya está en la cuenta del cliente: quedó marcada`, 'ok'); } else toast(`La nota ${nn} ya está pagada (${known.texto})`, 'err'); draw(); return; }
        if (p.notas.some((x) => nkey(x.nota, x.orderId) === nkey(nn, ''))) { toast('Esa nota ya está en este pago', 'err'); return; }
        p.notas.push({ orderId: 'manual:' + nn, nota: nn, monto: mm }); draw(); return;
      }
      if (t.id === 'pfSave') {
        const err = body.querySelector('#pfErr');
        const out = { ...p, notas: p.notas.map((n) => ({ ...n })), lines: p.lines.map((l) => ({ ...l, amount: dec(l.amount), ref: METHODS[l.method].ref ? normRef(l.ref) : '' })),
          adjusts: p.adjusts.map((a) => ({ type: a.type, pct: dec(a.pct), usd: dec(a.usd) })) };
        const dupL = p.lines.find((l) => l._dup && /^⚠/.test(l._dup)); if (dupL) { err.textContent = dupL._dup + ' Corrígela para poder guardar.'; return; }
        if (!out.clientId) { err.textContent = 'Elige el cliente de tu cartera'; return; }
        if (!out.notas.length) { err.textContent = 'Marca la nota (o notas) que paga'; return; }
        for (const l of out.lines) {
          const m = METHODS[l.method];
          if (!(l.amount > 0)) { err.textContent = `Escribe el monto de ${m.label}`; return; }
          if (m.bank && !l.bank) { err.textContent = `${m.label}: elige el banco`; return; }
          if (m.ref && l.ref.length < REF_MIN) { err.textContent = `${m.label}: escribe la referencia completa (mínimo ${REF_MIN} dígitos)`; return; }
          if (m.currency === 'VES' && !(out.rate > 0)) { err.textContent = 'Escribe la tasa del día (Bs por $)'; return; }
          if (m.currency === 'COP' && !(out.copRate > 0)) { err.textContent = 'Escribe la tasa de los pesos (COP por $)'; return; }
        }
        const refs = out.lines.filter((l) => l.ref).map((l) => l.ref);
        if (new Set(refs).size !== refs.length) { err.textContent = 'La misma referencia está dos veces'; return; }
        out.lines.forEach((l) => { delete l._dup; });
        const c = calc(out);
        if (c.diferencia > 0.01 && !confirm(`Falta ${usd(c.diferencia)} para cubrir lo que debe. ¿Guardar como abono?`)) return;
        t.disabled = true;
        const r = await global.Sync.pagosCall({ action: 'create', pago: out });
        t.disabled = false;
        if (ed && (r.ok || r.offline || !r.status || r.status >= 500)) await setPend((await pend()).filter((x) => x.id !== p.id));
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
    if (ed) { fetchCuenta(p.clientId, sid).then((r) => { if (!sh.el.isConnected) return; cuenta = r.notas; cuentaMsg = r.msg || ''; draw(); p.lines.forEach((l, i) => { if (l.ref) checkRef(i); }); }); }
    else if (opts.clientId) pickClient(opts.clientId, opts.notaKey || '');
    else setTimeout(() => { const i = body.querySelector('#pfCli'); if (i) i.focus(); }, 60);
  }

  /* ======================= Estado de cuenta de un cliente ======================= */
  /** Oficina o cobranzas (pueden deshacer un «pago cargado al sistema»). */
  const esCob = () => { const S = PV().S; return !!((S.settings && S.settings.adminKey && location.hash.startsWith('#/oficina')) || (global.Roles && global.Roles.isRole('cobranzas') && location.hash.startsWith('#/cobranzas'))); };
  /**
   * «✅ Pago cargado al sistema»: la nota ya se pagó completa en el sistema de cobranzas de la empresa. No hace falta
   * subir el pago: solo la fecha. La nota sale de la deuda; con la fecha, el sistema calcula si pagó dentro del plazo
   * o con atraso (y ese atraso sí cuenta en su crédito y semáforo).
   */
  function cargadoForm(o) {
    const P = PV(), { esc, usd, toast } = P;
    const sh = P.openSheet(`<div class="row"><h2 class="grow">✅ Pago cargado al sistema</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p><b>${esc(o.clientName || '')}</b>${o.nota ? ` · nota <b>${esc(o.nota)}</b>` : ''}${o.monto ? ` · ${usd(o.monto)}` : ''}</p>
      <p class="muted">Úsalo cuando el pago <b>ya está cargado en el sistema de cobranzas de la empresa</b>. No hace falta subir el detalle: la nota queda pagada completa y sale de la lista de deudores. Con la <b>fecha del pago</b> el sistema calcula si pagó dentro del plazo o con atraso (el atraso afecta su crédito).</p>
      <label class="field"><span>Fecha del pago</span><input id="cgF" type="date" class="input" value="${esc(P.today())}" max="${esc(P.today())}"></label>
      <div id="cgV"></div><p id="cgE" class="warn-txt"></p>
      <div class="actions"><button class="btn" data-close>Cancelar</button><button class="btn btn-primary" id="cgOk">Marcar como pagada</button></div>`);
    // Vista previa: ¿dentro del plazo? (con el vencimiento de la nota, si lo tenemos; si no, lo calcula el servidor)
    const dd = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
    const prev = () => {
      const f = sh.el.querySelector('#cgF').value, box = sh.el.querySelector('#cgV');
      if (!o.vence || !f) { box.innerHTML = ''; return; }
      const at = dd(o.vence, f);
      box.innerHTML = at > 0 ? `<div class="hint warn">⚠ Venció el ${esc(P.fmtDate(o.vence))}: pagó <b>${at} día${at === 1 ? '' : 's'} tarde</b>. Cuenta como atraso y afecta su crédito.</div>`
        : `<div class="hint">✅ Dentro del plazo (vencía el ${esc(P.fmtDate(o.vence))}): no afecta su crédito.</div>`;
    };
    sh.el.querySelector('#cgF').addEventListener('input', prev); prev();
    sh.el.querySelector('#cgOk').onclick = async () => {
      const fecha = sh.el.querySelector('#cgF').value, err = sh.el.querySelector('#cgE');
      if (!fecha || fecha > P.today()) { err.textContent = 'Pon la fecha del pago (no puede ser futura)'; return; }
      const b = sh.el.querySelector('#cgOk'); b.disabled = true;
      const r = await global.Sync.pagosCall({ action: 'cargado', sellerId: o.sellerId || '', orderId: o.orderId, fecha, by: (P.S.config && P.S.config.adminName) || '' });
      b.disabled = false;
      if (!r.ok) { err.textContent = r.error || 'No se pudo guardar (hace falta internet)'; return; }
      P.logEvent('pago_cargado', `Pago cargado al sistema: ${o.clientName}${o.nota ? ' · nota ' + o.nota : ''} · ${fecha}`, { orderId: o.orderId, clientName: o.clientName });
      try { Object.keys(localStorage).filter((k) => k.startsWith('pv_cart:')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* noop */ }
      const at = r.data.cargado && +r.data.cargado.atraso || 0;
      sh.close(); toast(at ? `✅ Nota pagada · ${at} día${at === 1 ? '' : 's'} de atraso (cuenta en su crédito)` : '✅ Nota pagada a tiempo', at ? 'err' : 'ok'); if (o.onDone) o.onDone();
    };
  }
  async function cargadoUndo(o) {
    const P = PV();
    if (!confirm(`¿Deshacer «pago cargado al sistema» de la nota ${o.nota || ''}? Vuelve a aparecer como deuda.`)) return;
    const r = await global.Sync.pagosCall({ action: 'cargado', orderId: o.orderId, deshacer: true });
    if (!r.ok) { P.toast(r.error || 'No se pudo deshacer', 'err'); return; }
    P.logEvent('pago_cargado', `Deshizo «pago cargado al sistema»: ${o.clientName || ''}${o.nota ? ' · nota ' + o.nota : ''}`, { orderId: o.orderId });
    try { Object.keys(localStorage).filter((k) => k.startsWith('pv_cart:')).forEach((k) => localStorage.removeItem(k)); } catch (e) { /* noop */ }
    P.toast('Listo: la nota vuelve a la deuda', 'ok'); if (o.onDone) o.onDone();
  }

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
          ${n.resta > 0.01 ? `<button class="btn btn-sm btn-primary" data-pay="${esc(n.key)}">💵 Pagar ${usd(n.resta)}</button>${!n.manual && n.orderId ? `<button class="btn btn-sm btn-ok" data-car="${esc(n.key)}">✅ Pago cargado al sistema</button>` : ''}<button class="btn btn-sm" data-ant="${esc(n.key)}">🗂 Ya pagada en FileMaker</button>` : ''}
          ${n.cargado && esCob() ? `<button class="btn btn-sm" data-carx="${esc(n.key)}">↩ Deshacer</button>` : ''}</div></div>`).join('')
          : '<p class="muted">Sin notas despachadas o liquidadas de este cliente.</p>'}
        <div class="actions"><button class="btn btn-primary" data-pay="">＋ Registrar pago de ${esc(c.name)}</button></div>`;
      out.onclick = (e) => {
        const cg = e.target.closest('[data-car]'), cx = e.target.closest('[data-carx]');
        if (cg || cx) { const n = notas.find((x) => x.key === (cg || cx).dataset[cg ? 'car' : 'carx']); if (!n) return; const arg = { sellerId: sid, orderId: n.orderId, nota: n.nota, monto: n.monto, clientName: c.name, onDone: () => show(c.id) }; if (cg) cargadoForm(arg); else cargadoUndo(arg); return; }
        const an = e.target.closest('[data-ant]'); if (an) { sh.close(); anteriorForm({ sellerId: sid, clientId: c.id, notaKey: an.dataset.ant, onSaved: () => cuentaSheet(sid, c.id) }); return; }
        const b = e.target.closest('[data-pay]'); if (!b) return; sh.close(); payForm({ sellerId: sid, clientId: c.id, notaKey: b.dataset.pay, onSaved: () => { if (location.hash === '#/ruta/pagos') { PV().S.ui.pagos = null; renderSeller(); } } }); };
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
    const notas = els.map((el) => ({ nota: el.dataset.paynota || '', orderId: el.dataset.payoid || '', clientId: el.dataset.paycid || '', monto: +el.dataset.paymonto || 0 }));
    const r = await global.Sync.pagosCall({ action: 'estado', notas });
    if (!r.ok) return;
    els.forEach((el, i) => { const x = (r.data.byIdx && r.data.byIdx[i]) || r.data.byKey[nkey(notas[i].nota, notas[i].orderId)]; if (!x || !el.isConnected) return;
      el.className = 'pay-st ' + (EST[x.estado] || 'muted'); el.textContent = `💵 ${notas[i].nota ? 'Nota ' + notas[i].nota + ' · ' : ''}${x.texto}`; });
  }

  /* ======================= Detalle de un pago ======================= */
  function payHTML(p) {
    const { esc, usd, bs, fmtDate } = PV();
    const c = { debe: p.debe, pagado: p.pagado, ajustes: p.ajustes, diferencia: p.diferencia };
    const money = (l) => (l.currency === 'VES' ? bs(l.amount) : l.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(l.amount) : usd(l.amount));
    return `<div class="muted">Pagado el ${esc(fmtDate(p.date))}${p.createdAt ? ` · subido el ${esc(fmtDate(vzDay(p.createdAt)))} ${esc(vzTime(p.createdAt))}` : ''} · ${esc(p.sellerName || '')} · notas ${esc(p.notas.map((n) => n.nota || '—').join(', '))}</div>
      ${ORIGEN[p.origen] ? `<div><span class="tag">${ORIGEN[p.origen]}</span>${p.info ? ` <span class="muted">${esc(p.info)}</span>` : ''}</div>` : ''}
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
    const st = S.ui.pagos || (S.ui.pagos = { r: 'hoy', by: 'subido', list: null, err: '' });
    if (!st.by) st.by = 'subido';
    const dm = (n) => { const d = new Date(today() + 'T12:00:00'); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
    const range = st.r === '7d' ? { from: dm(6), to: today() } : st.r === 'mes' ? { from: today().slice(0, 8) + '01', to: today() } : { from: today(), to: today() };
    const espera = st.r === 'espera';
    app.innerHTML = `${P.brandHeader(seller.name, 'Pagos de mis clientes', `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="row wrap" style="gap:8px;align-items:center"><button class="btn btn-primary" id="pgNew">＋ Registrar pago</button><button class="btn" id="pgCta">📒 Estado de cuenta</button><button class="btn" id="pgAnt">🗂 Pago anterior (FileMaker)</button><a class="btn" href="#/ruta/cobrar">📅 Cuentas por cobrar</a></div>
        <div class="chips" id="pgR">${[['hoy', 'Hoy'], ['7d', 'Últimos 7 días'], ['mes', 'Este mes'], ['espera', '⏳ En espera (todos)']].map(([k, l]) => `<button class="chip ${st.r === k ? 'active' : ''}" data-r="${k}">${l}</button>`).join('')}</div>
        ${espera ? '' : `<div class="chips" id="pgBy"><span class="muted" style="align-self:center">Ver por:</span>${[['subido', 'Fecha en que se subió'], ['pago', 'Fecha del pago']].map(([k, l]) => `<button class="chip ${st.by === k ? 'active' : ''}" data-by="${k}">${l}</button>`).join('')}</div>`}
        <div id="pgBody"><p class="muted">Cargando…</p></div>
      </div>${P.creditFooter()}`;
    $('#bell').onclick = P.notifSheet; P.updateBell(); $('#syncPill').onclick = () => P.runSync(true); P.updateSyncPill();
    $('#pgR').onclick = (e) => { const b = e.target.closest('[data-r]'); if (b) { st.r = b.dataset.r; st.list = null; renderSeller(); } };
    $('#pgNew').onclick = () => payForm({ sellerId: sid, onSaved: () => { st.list = null; renderSeller(); } });
    $('#pgCta').onclick = () => cuentaSheet(sid);
    $('#pgAnt').onclick = () => anteriorForm({ sellerId: sid, onSaved: () => { st.list = null; renderSeller(); } });
    const pb = $('#pgBy'); if (pb) pb.onclick = (e) => { const b = e.target.closest('[data-by]'); if (b) { st.by = b.dataset.by; renderSeller(); } };
    (async () => {
      await flush();
      const local = (await pend()).filter((p) => p.sellerId === sid).map((p) => ({ ...p, ...calc(p), status: 'local' }));
      const r = await global.Sync.pagosCall(espera ? { action: 'mine', sellerId: sid, status: 'espera', all: true } : { action: 'mine', sellerId: sid, from: range.from, to: range.to, by: st.by });
      const box = document.getElementById('pgBody'); if (!box || S.ui.pagos !== st) return;
      if (!r.ok && r.status === 401 && r.error === 'PIN') { box.innerHTML = '<div class="hint warn">🔒 Escribe tu PIN para ver tus pagos en este teléfono.</div>'; if (global.PinGate) global.PinGate.check({ force: true }); return; }
      const list = local.concat(r.ok ? r.data.pagos : []);
      const tot = totals(list), all = list.filter((p) => p.status !== 'rechazado' && p.status !== 'anulado');
      box.innerHTML = `${r.ok ? '' : `<div class="hint warn">${esc(r.error || 'Sin conexión')}: se muestran solo los pagos guardados en este teléfono.</div>`}
        <div class="kpi-row" style="margin-top:10px"><div class="kpi"><small>${espera ? 'En espera de cobranza' : st.by === 'subido' ? 'Subido (' + esc(range.from === range.to ? 'hoy' : 'período') + ')' : 'Pagado (' + esc(range.from === range.to ? 'hoy' : 'período') + ')'}</small><b>${usd(all.reduce((a, p) => a + p.pagado + p.ajustes, 0))}</b><small>${all.length} pagos</small></div>
          <div class="kpi"><small>En espera de cobranza</small><b>${list.filter((p) => p.status === 'espera' || p.status === 'local').length}</b></div>
          <div class="kpi"><small>Aprobados</small><b>${list.filter((p) => p.status === 'aprobado').length}</b><small>${list.filter((p) => p.status === 'rechazado').length} rechazados</small></div></div>
        ${tot.length ? `<div class="card card-pad"><b>Cierre por forma de pago</b>${tot.map((x) => `<div class="row" style="justify-content:space-between"><span>${esc(METHODS[x.method].label)} (${x.n})</span><span>${x.currency === 'VES' ? P.bs(x.amount) : x.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(x.amount) : usd(x.amount)} · ≈ ${usd(x.usd)}</span></div>`).join('')}</div>` : ''}
        <div class="row wrap" style="gap:8px;margin:10px 0"><button class="btn" id="pgPrint">🖨 Imprimir para cobranzas</button><button class="btn" id="pgXls">⇩ Excel</button></div>
        ${list.length ? list.map((p, i) => `<div class="card card-pad" style="margin-bottom:8px" data-i="${i}"><div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${esc(p.clientName)} · ${usd(p.pagado + p.ajustes)}</b>${pill(p.status)}</div>
          ${payHTML(p)}${p.error ? `<div class="hint warn">⚠ ${esc(p.error)}</div>` : ''}
          ${p.status === 'espera' ? `<div class="actions"><button class="btn btn-sm" data-anular="${esc(p.id)}">Anular (me equivoqué)</button></div>` : p.status === 'local' ? `<div class="actions">${p.error ? `<button class="btn btn-sm btn-primary" data-corregir="${esc(p.id)}">✏️ Corregir</button>` : ''}<button class="btn btn-sm" data-borrar="${esc(p.id)}">Borrar del teléfono</button></div>` : ''}</div>`).join('')
          : '<div class="empty card"><strong>Sin pagos en este período</strong>Toca «＋ Registrar pago».</div>'}`;
      box.onclick = async (e) => {
        const an = e.target.closest('[data-anular]'), bo = e.target.closest('[data-borrar]'), co = e.target.closest('[data-corregir]');
        if (co) { const x = (await pend()).find((q) => q.id === co.dataset.corregir); if (x) payForm({ sellerId: sid, edit: x, onSaved: () => { st.list = null; renderSeller(); } }); return; }
        if (an) { if (!confirm('¿Anular este pago? Se libera su referencia para registrarlo bien.')) return; const r2x = await global.Sync.pagosCall({ action: 'anular', id: an.dataset.anular, sellerId: sid }); toast(r2x.ok ? 'Pago anulado' : r2x.error || 'No se pudo', r2x.ok ? 'ok' : 'err'); st.list = null; renderSeller(); }
        if (bo) { if (!confirm('¿Borrar este pago que no se ha subido?')) return; await setPend((await pend()).filter((p) => p.id !== bo.dataset.borrar)); renderSeller(); }
      };
      $('#pgPrint').onclick = () => global.Print.printPagos(list.filter((p) => p.status !== 'anulado' && p.status !== 'local'), { config: S.config, title: `Pagos de ${seller.name}`, METHODS, ADJUSTS, ST, dayOf: (p) => (st.by === 'pago' ? p.date : vzDay(p.createdAt)), timeOf: (p) => vzTime(p.createdAt) });
      $('#pgXls').onclick = () => global.Exporta.save(`pagos_${seller.name}_${range.from}_${range.to}.xlsx`, [excel(list, `${seller.name} · ${range.from} al ${range.to}`)]);
    })();
  }

  /* ======================= Oficina: cobranza ======================= */
  /** Excel para cobranzas: una hoja por día, un bloque por vendedor (cada forma de pago de cada cliente) y el total del día. */
  function excelDays(pagos, dayOf, label) {
    const E = global.Exporta, days = new Map();
    pagos.forEach((p) => { const d = dayOf(p); days.set(d, (days.get(d) || []).concat(p)); });
    const cols = [{ h: 'HORA', w: 7 }, { h: 'CLIENTE', w: 30 }, { h: 'NOTAS', w: 14 }, { h: 'FECHA DEL PAGO', k: 'date', w: 12 }, { h: 'FORMA DE PAGO', w: 18 }, { h: 'BANCO', w: 20 }, { h: 'REFERENCIA', w: 16 },
      { h: 'MONTO', k: 'money', w: 14 }, { h: 'MONEDA', w: 8 }, { h: 'TASA', w: 9 }, { h: 'EQUIVALENTE $', k: 'money', w: 14, total: true }, { h: 'ESTADO', w: 20 }];
    const rowsOf = (list) => { const rows = []; list.forEach((p) => {
      p.lines.forEach((l, i) => rows.push([i ? '' : vzTime(p.createdAt), i ? '' : p.clientName, i ? '' : p.notas.map((n) => n.nota).join(', '), i ? '' : p.date, (METHODS[l.method] || {}).label || l.method, l.bank, l.ref, l.amount, l.currency === 'VES' ? 'Bs' : l.currency === 'COP' ? 'COP' : '$', l.currency === 'VES' ? p.rate : l.currency === 'COP' ? p.copRate : '', l.usd, i ? '' : (ST[p.status] || [p.status])[0]]));
      (p.adjusts || []).forEach((a) => rows.push(['', '', '', '', (ADJUSTS[a.type] || a.type) + (a.type === 'descuento' ? ' ' + a.pct + '%' : ''), '', '', a.usd, '$', '', a.usd, '']));
    }); return rows; };
    return [...days.keys()].sort().map((d) => {
      const list = days.get(d), bySeller = new Map();
      list.slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt))).forEach((p) => bySeller.set(p.sellerName || p.sellerId, (bySeller.get(p.sellerName || p.sellerId) || []).concat(p)));
      const tot = totals(list);
      const blocks = [...bySeller.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]), 'es')).map(([name, l]) => ({ title: `${name} · ${l.length} pago${l.length === 1 ? '' : 's'}`, cols, rows: rowsOf(l) }))
        .concat([{ title: 'Total del día por forma de pago', cols: [{ h: 'FORMA DE PAGO', w: 22 }, { h: 'PAGOS', k: 'int' }, { h: 'MONTO', k: 'money', w: 14 }, { h: 'MONEDA', w: 8 }, { h: 'EQUIVALENTE $', k: 'money', w: 14, total: true }],
          rows: tot.map((x) => [METHODS[x.method].label, x.n, x.amount, x.currency === 'VES' ? 'Bs' : x.currency === 'COP' ? 'COP' : '$', x.usd]) }]);
      return E.blocks(d, blocks, { title: `PAGOS PARA COBRANZAS · ${d}`, subtitle: label });
    });
  }

  function renderOffice(root) {
    const P = PV(), { S, esc, usd, toast, today } = P;
    const st = S.ui.office.pagos || (S.ui.office.pagos = { from: today(), to: today(), seller: '', status: '', by: 'subido', ant: false });
    if (!st.by) st.by = 'subido';
    root.innerHTML = `<div class="card card-pad"><div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="field"><span>Ver por</span><select id="pfBy" class="select"><option value="subido" ${st.by === 'subido' ? 'selected' : ''}>Día en que se subió</option><option value="pago" ${st.by === 'pago' ? 'selected' : ''}>Fecha del pago</option></select></label>
        <label class="field"><span>Desde</span><input id="pfFrom" type="date" class="input" value="${esc(st.from)}"></label><label class="field"><span>Hasta</span><input id="pfTo" type="date" class="input" value="${esc(st.to)}"></label>
        <label class="field"><span>Vendedor</span><select id="pfSel" class="select"><option value="">Todos</option>${S.sellers.filter((s) => s.active !== false).map((s) => `<option value="${esc(s.id)}" ${s.id === st.seller ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Estado</span><select id="pfSt" class="select">${[['', 'Todos'], ['espera', 'En espera de cobranza'], ['aprobado', 'Aprobados'], ['rechazado', 'Rechazados'], ['anulado', 'Anulados']].map(([k, l]) => `<option value="${k}" ${k === st.status ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <button class="btn btn-primary" id="pfGo">Consultar</button></div>
        <div class="row wrap" style="gap:8px;margin-top:10px"><button class="btn" id="pfAnt">🗂 Pago anterior (FileMaker)</button><button class="btn" id="pfImp">⇩ Importar pagos de FileMaker (Excel/CSV)</button><button class="btn" id="pfCart">📅 Cuentas por cobrar</button><button class="btn" id="pfCred">🚦 Crédito de clientes</button><button class="btn" id="pfInt">🛡 Revisión de integridad</button></div></div>
      <div id="pfOut" style="margin-top:12px"><p class="muted">Cargando…</p></div>`;
    const q = (id) => root.querySelector(id);
    const load = async () => {
      Object.assign(st, { from: q('#pfFrom').value, to: q('#pfTo').value, seller: q('#pfSel').value, status: q('#pfSt').value, by: q('#pfBy').value });
      const r = await global.Sync.pagosCall({ action: 'list', from: st.from, to: st.to, sellerId: st.seller, status: st.status, by: st.by });
      const out = q('#pfOut'); if (!out) return;
      if (!r.ok) { out.innerHTML = `<div class="hint warn">${esc(r.error || 'No se pudo consultar')}</div>`; return; }
      const pagos = r.data.pagos, office = !!(S.settings && (S.settings.adminKey || S.settings.userRole === 'cobranzas'));
      const bySeller = new Map(); pagos.forEach((p) => bySeller.set(p.sellerName || p.sellerId, (bySeller.get(p.sellerName || p.sellerId) || []).concat(p)));
      const tot = totals(pagos);
      const dayOf = (p) => (st.by === 'subido' ? vzDay(p.createdAt) : p.date);
      const forSheet = () => pagos.filter((p) => p.status !== 'anulado' && p.status !== 'rechazado' && (st.ant || !ORIGEN[p.origen]));
      out.innerHTML = `<div class="kpi-row"><div class="kpi"><small>Pagos</small><b>${pagos.length}</b><small>${pagos.filter((p) => p.status === 'espera').length} en espera</small></div>
          <div class="kpi"><small>Total cobrado (≈ $)</small><b>${usd(pagos.filter((p) => p.status !== 'rechazado' && p.status !== 'anulado').reduce((a, p) => a + p.pagado + p.ajustes, 0))}</b></div>
          ${tot.map((x) => `<div class="kpi"><small>${esc(METHODS[x.method].label)}</small><b>${x.currency === 'VES' ? P.bs(x.amount) : x.currency === 'COP' ? 'COP ' + new Intl.NumberFormat('es-VE').format(x.amount) : usd(x.amount)}</b><small>${x.n} · ≈ ${usd(x.usd)}</small></div>`).join('')}</div>
        <div class="card card-pad" style="margin:6px 0 10px"><b>📄 Hoja para cobranzas</b> <span class="muted">— un día por hoja, separado por vendedor, con cada pago de cada cliente (sin rechazados ni anulados)</span>
          <div class="row wrap" style="gap:8px;margin-top:8px;align-items:center"><button class="btn" id="pfPrint">🖨 Imprimir</button><button class="btn" id="pfXls">⇩ Excel</button>
          <label class="row" style="gap:6px"><input type="checkbox" id="pfAntChk" ${st.ant ? 'checked' : ''} style="width:20px;height:20px"> Incluir pagos anteriores e importados de FileMaker</label></div></div>
        ${pagos.length ? [...bySeller.entries()].map(([name, list]) => `<h3>${esc(name)} · ${list.length} pago${list.length === 1 ? '' : 's'}</h3>
          ${list.map((p) => `<div class="card card-pad" style="margin-bottom:8px"><div class="row wrap" style="gap:8px;align-items:center"><b class="grow">${esc(p.clientName)} · ${usd(p.pagado + p.ajustes)}</b>${pill(p.status)}</div>${payHTML(p)}
            ${office ? `<div class="actions">${p.status === 'espera' ? `<button class="btn btn-sm btn-ok" data-ap="${esc(p.id)}">✅ ${p.origen === 'anterior' ? 'Confirmar pago anterior' : 'Aprobar'}</button><button class="btn btn-sm btn-danger" data-re="${esc(p.id)}">✖ Rechazar</button>` : `<button class="btn btn-sm" data-ab="${esc(p.id)}">↺ Volver a «en espera»</button>`}</div>` : ''}</div>`).join('')}`).join('')
          : '<div class="empty card"><strong>Sin pagos</strong>con esos filtros.</div>'}`;
      out.onclick = async (e) => {
        const ap = e.target.closest('[data-ap]'), re = e.target.closest('[data-re]'), ab = e.target.closest('[data-ab]');
        const by = (S.config && S.config.adminName) || 'Cobranza';
        if (ap) { const x = await global.Sync.pagosCall({ action: 'review', id: ap.dataset.ap, status: 'aprobado', by }); toast(x.ok ? 'Pago aprobado' : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('pago_aprobado', `Aprobó el pago de ${x.data.pago.clientName} (${x.data.pago.sellerName}) · ${usd(x.data.pago.pagado + x.data.pago.ajustes)}`); load(); }
        if (re) { const m = prompt('Motivo del rechazo (le llega al vendedor):'); if (!m) return; const x = await global.Sync.pagosCall({ action: 'review', id: re.dataset.re, status: 'rechazado', motivo: m, by }); toast(x.ok ? 'Pago rechazado' : x.error, x.ok ? 'ok' : 'err'); if (x.ok) P.logEvent('pago_rechazado', `Rechazó el pago de ${x.data.pago.clientName} (${x.data.pago.sellerName}): ${m}`); load(); }
        if (ab) { if (!confirm('¿Volver este pago a «en espera de cobranza»?')) return; const x = await global.Sync.pagosCall({ action: 'reabrir', id: ab.dataset.ab, by }); toast(x.ok ? 'Pago en espera otra vez' : x.error, x.ok ? 'ok' : 'err'); load(); }
      };
      q('#pfAntChk').onchange = (e) => { st.ant = e.target.checked; };
      const label = `${st.by === 'subido' ? 'Subidos' : 'Pagados'} del ${st.from}${st.to !== st.from ? ' al ' + st.to : ''}`;
      q('#pfPrint').onclick = () => { const l = forSheet(); if (!l.length) { toast('No hay pagos para la hoja', 'err'); return; } global.Print.printPagos(l, { config: S.config, title: label, METHODS, ADJUSTS, ST, dayOf, timeOf: (p) => vzTime(p.createdAt) }); };
      q('#pfXls').onclick = () => { const l = forSheet(); if (!l.length) { toast('No hay pagos para la hoja', 'err'); return; } global.Exporta.save(`cobranzas_${st.from}_${st.to}.xlsx`, excelDays(l, dayOf, label)); };
    };
    q('#pfGo').onclick = load;
    q('#pfAnt').onclick = () => anteriorForm({ sellerId: '', office: true, onSaved: load });
    q('#pfImp').onclick = () => importSheet(load);
    q('#pfCart').onclick = () => { if (global.Cobranza) global.Cobranza.officeSheet(); };
    q('#pfCred').onclick = () => { if (global.Cobranza) global.Cobranza.creditSheet(); };
    q('#pfInt').onclick = () => integridadSheet();
    load();
  }

  /* ======================= Revisión de integridad (solo lectura) ======================= */
  async function integridadSheet() {
    const P = PV(), { esc, usd, fmtDate, openSheet } = P;
    const sh = openSheet(`<div class="row"><h2 class="grow">🛡 Revisión de integridad de pagos</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Revisa todos los pagos en espera y aprobados. No cambia nada: muestra lo que hay que corregir (rechazar, anular o volver a registrar en la cuenta correcta).</p><div id="inOut"><p class="muted">Revisando…</p></div>`, { wide: true });
    const r = await global.Sync.pagosCall({ action: 'integridad' }), out = sh.el.querySelector('#inOut');
    if (!r.ok) { out.innerHTML = `<div class="hint warn">${esc(r.error || 'No se pudo revisar')}</div>`; return; }
    const d = r.data, secs = [['cruzados', '🔀 Pagos que abonan la nota de OTRO cliente', 'Rechaza o anula el pago y regístralo en la cuenta del cliente correcto.'],
      ['refs', '🔁 Referencias repetidas o sin reservar', 'Verifica el comprobante: una referencia solo puede estar en un pago.'],
      ['sobre', '➕ Notas con más abonado que su monto', 'Revisa si el pago se registró dos veces o si sobró dinero (saldo a favor).'],
      ['ajenos', '👥 Pagos registrados por un vendedor que no es el del cliente', 'Puede ser correcto (cliente cambiado de cartera); confírmalo.']];
    const total = secs.reduce((a, [k]) => a + d[k].length, 0);
    out.innerHTML = `<div class="hint ${total ? 'warn' : ''}">${total ? `⚠ <b>${total}</b> caso${total === 1 ? '' : 's'} para revisar` : '✅ <b>Todo en orden</b>: ningún pago mezclado ni referencia repetida'} · ${d.revisados} pagos revisados</div>
      ${secs.map(([k, t, tip]) => d[k].length ? `<h3>${t} <span class="muted">(${d[k].length})</span></h3><p class="muted" style="margin-top:0">${tip}</p>
        <div style="overflow:auto"><table class="inv"><thead><tr><th>Fecha</th><th>Cliente del pago</th><th>Vendedor</th><th class="n">Monto</th><th>Estado</th><th>Detalle</th></tr></thead><tbody>
        ${d[k].map((x) => `<tr><td>${esc(fmtDate(x.date))}</td><td><b>${esc(x.clientName)}</b></td><td>${esc(x.sellerName || '—')}</td><td class="n">${usd(x.monto)}</td><td>${esc((ST[x.status] || [x.status])[0])}</td><td>${esc(x.detalle)}</td></tr>`).join('')}</tbody></table></div>` : '').join('')}`;
  }

  /* ======================= Pago anterior (ya está en FileMaker) ======================= */
  // Para que el récord del cliente quede bien sin pasar otra vez por cobranza: PAGADO COMPLETO o PARCIAL, con su fecha.
  // Si lo registra la oficina queda confirmado; si es el vendedor, la oficina lo confirma.
  function anteriorForm(opts) {
    const P = PV(), { S, esc, usd, toast, openSheet, today, fmtDate } = P;
    const sid = opts.sellerId || '';
    let client = null, cuenta = null, msg = '';
    const pick = {}; // key → { tipo: 'completo' | 'parcial', monto }
    const manual = [];
    const sh = openSheet(`<div class="row"><h2 class="grow">🗂 Pago anterior (ya está en FileMaker)</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Para notas que el cliente ya pagó y cobranza ya cargó en FileMaker. No va a la cola de cobranza ni a la hoja del día; sirve para que su estado de cuenta y su récord queden al día.${opts.office ? '' : ' La oficina lo confirma.'}</p>
      <div id="anBody"></div>`, { wide: true });
    const body = sh.el.querySelector('#anBody');
    function draw() {
      const notas = (cuenta || []).filter((n) => n.resta > 0.01);
      body.innerHTML = `<label class="field"><span>Cliente o N° de nota</span><input id="anCli" class="input" placeholder="Escribe 2 letras del cliente o el número de nota" value="${esc(client ? client.name : '')}" autocomplete="off"></label>
        <div id="anSug" class="suggest"></div>
        ${client ? `${msg ? `<p class="muted">${esc(msg)}</p>` : ''}
          ${notas.length ? `<div class="section-title" style="margin:10px 0 4px">Notas por cobrar de ${esc(client.name)}</div>${notas.map((n) => { const x = pick[n.key]; return `<div class="card card-pad" style="margin-bottom:6px"><div class="row wrap" style="gap:8px;align-items:center">
              <label class="row grow" style="gap:8px"><input type="checkbox" data-an="${esc(n.key)}" ${x ? 'checked' : ''} style="width:22px;height:22px"><span><b>Nota ${esc(n.nota || '—')}</b> · ${esc(fmtDate(n.date))} · debe ${usd(n.resta)}</span></label>
              ${x ? `<select class="select" data-tipo="${esc(n.key)}"><option value="completo" ${x.tipo === 'completo' ? 'selected' : ''}>Pagado completo</option><option value="parcial" ${x.tipo === 'parcial' ? 'selected' : ''}>Pagado parcial</option></select>
                ${x.tipo === 'parcial' ? `<input class="input" style="max-width:130px" inputmode="decimal" data-monto="${esc(n.key)}" placeholder="Monto $" value="${esc(x.monto || '')}">` : ''}` : ''}</div></div>`; }).join('')}` : (cuenta ? '<p class="muted">No tiene notas pendientes en la plataforma.</p>' : '')}
          <div class="section-title" style="margin:10px 0 4px">Nota que no está en la plataforma</div>
          ${manual.map((m, i) => `<div class="row" style="gap:8px"><span class="grow">Nota ${esc(m.nota)} · de ${usd(m.montoNota)} · ${m.tipo === 'completo' ? 'pagada completa' : 'pagó ' + usd(m.monto)}</span><button class="btn btn-sm" data-rmm="${i}">✕</button></div>`).join('')}
          <div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field"><span>N° de nota</span><input id="anMN" class="input" inputmode="numeric"></label><label class="field"><span>Monto de la nota $</span><input id="anMM" class="input" inputmode="decimal"></label>
            <label class="field"><span>Pagó</span><select id="anMT" class="select"><option value="completo">Completo</option><option value="parcial">Parcial</option></select></label><label class="field"><span>Monto pagado $ (si es parcial)</span><input id="anMP" class="input" inputmode="decimal"></label>
            <button class="btn btn-sm" id="anMAdd">Agregar</button></div>
          <div class="row wrap" style="gap:8px;margin-top:10px"><label class="field"><span>Fecha del pago</span><input id="anDate" type="date" class="input" value="${esc(today())}"></label>
            <label class="field grow"><span>Datos del pago en FileMaker (opcional: forma, banco, referencia)</span><input id="anInfo" class="input" maxlength="200"></label></div>
          <p id="anErr" class="warn-txt" style="min-height:1.2em"></p>
          <div class="actions"><button class="btn btn-primary" id="anSave">Guardar pago anterior</button><button class="btn" data-close>Cancelar</button></div>` : ''}`;
    }
    async function pickClient(cid, preKey) {
      client = P.clientById(cid); if (!client) return;
      cuenta = null; msg = 'Consultando el estado de cuenta…'; draw();
      const r = await fetchCuenta(client.id, client.sellerId || sid);
      if (!sh.el.isConnected) return;
      cuenta = r.notas; msg = r.msg || '';
      const pre = preKey && cuenta.find((n) => n.key === preKey && n.resta > 0.01);
      if (pre) pick[pre.key] = { tipo: 'completo', monto: '' };
      draw();
    }
    body.addEventListener('input', (e) => {
      const t = e.target;
      if (t.id === 'anCli') { body.querySelector('#anSug').innerHTML = sugHTML(searchHits(t.value, sid), t.value); return; }
      if (t.dataset.monto) pick[t.dataset.monto].monto = t.value;
    });
    body.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.an) { if (t.checked) pick[t.dataset.an] = { tipo: 'completo', monto: '' }; else delete pick[t.dataset.an]; draw(); }
      if (t.dataset.tipo) { pick[t.dataset.tipo].tipo = t.value; draw(); }
    });
    body.addEventListener('click', async (e) => {
      const t = e.target, sg = t.closest('[data-cid]');
      if (sg) { pickClient(sg.dataset.cid, sg.dataset.key || ''); return; }
      if (t.dataset.rmm !== undefined) { manual.splice(+t.dataset.rmm, 1); draw(); return; }
      if (t.id === 'anMAdd') {
        const nota = String(body.querySelector('#anMN').value).replace(/\D/g, ''), montoNota = r2(dec(body.querySelector('#anMM').value)), tipo = body.querySelector('#anMT').value, monto = r2(dec(body.querySelector('#anMP').value));
        if (!nota || !(montoNota > 0)) { toast('Escribe el número de nota y su monto', 'err'); return; }
        if (tipo === 'parcial' && !(monto > 0 && monto < montoNota)) { toast('El pago parcial debe ser menor que el monto de la nota', 'err'); return; }
        if ((cuenta || []).some((n) => n.key === nkey(nota, ''))) { toast(`La nota ${nota} ya está en la cuenta del cliente: márcala arriba`, 'err'); return; }
        manual.push({ nota, montoNota, tipo, monto: tipo === 'completo' ? montoNota : monto }); draw(); return;
      }
      if (t.id === 'anSave') {
        const err = body.querySelector('#anErr'), date = body.querySelector('#anDate').value, info = body.querySelector('#anInfo').value.trim();
        const items = [];
        for (const [key, x] of Object.entries(pick)) {
          const n = (cuenta || []).find((y) => y.key === key); if (!n) continue;
          const amount = x.tipo === 'completo' ? n.resta : r2(dec(x.monto));
          if (!(amount > 0) || amount > n.resta + 0.01) { err.textContent = `Nota ${n.nota}: el pago parcial debe ser mayor que 0 y no más de ${usd(n.resta)}`; return; }
          items.push({ nota: { orderId: n.orderId, nota: n.nota, monto: r2(n.resta) }, amount: r2(amount) });
        }
        manual.forEach((m) => items.push({ nota: { orderId: 'manual:' + m.nota, nota: m.nota, monto: m.montoNota }, amount: m.monto }));
        if (!items.length) { err.textContent = 'Marca al menos una nota'; return; }
        if (!date) { err.textContent = 'Escribe la fecha del pago'; return; }
        t.disabled = true;
        const seller = P.sellerById(client.sellerId || sid) || { id: client.sellerId || sid, name: '' };
        let okN = 0, fail = '';
        for (const it of items) {
          const pago = { id: global.DB.uid('pa'), date, sellerId: seller.id || '—', sellerName: seller.name || '', clientId: client.id, clientName: client.name, notas: [it.nota], rate: 0, copRate: 0,
            lines: [{ method: 'anterior', amount: it.amount }], adjusts: [], comment: '', info, origen: 'anterior', by: opts.office ? ((S.config && S.config.adminName) || 'Oficina') : seller.name };
          const r = await global.Sync.pagosCall({ action: 'create', pago });
          if (r.ok) okN++;
          else if (r.offline || !r.status || r.status >= 500) { await setPend((await pend()).concat(pago)); okN++; }
          else { fail = r.error || 'No se pudo guardar'; break; }
        }
        t.disabled = false;
        if (fail) { err.textContent = fail; return; }
        sh.close();
        toast(`${okN} pago${okN === 1 ? '' : 's'} anterior${okN === 1 ? '' : 'es'} registrado${okN === 1 ? '' : 's'}${opts.office ? '' : ' · la oficina los confirma'}`, 'ok');
        P.logEvent('pago_anterior', `Registró ${okN} pago(s) anterior(es) de ${client.name} (FileMaker)`, { clientName: client.name });
        if (opts.onSaved) opts.onSaved();
      }
    });
    draw();
    if (opts.clientId) pickClient(opts.clientId, opts.notaKey || ''); else setTimeout(() => { const i = body.querySelector('#anCli'); if (i) i.focus(); }, 60);
  }

  /* ======================= Importar pagos de FileMaker (Excel / CSV) ======================= */
  // Columnas que se reconocen solas (se pueden cambiar a mano antes de importar)
  const IMP_FIELDS = [
    ['date', 'Fecha del pago *', ['FECHA', 'FECHA PAGO', 'FECHA DE PAGO', 'FECHA COBRO', 'DIA']],
    ['nota', 'N° de nota', ['NOTA', 'N NOTA', 'NRO NOTA', 'NUMERO NOTA', 'NOTA ENTREGA', 'FACTURA', 'DOCUMENTO', 'NRO DOCUMENTO']],
    ['rif', 'RIF / C.I. del cliente', ['RIF', 'CEDULA', 'CI', 'RIF CI']],
    ['client', 'Cliente (nombre)', ['CLIENTE', 'NOMBRE', 'RAZON SOCIAL', 'NOMBRE CLIENTE']],
    ['code', 'Código del cliente', ['CODIGO', 'COD', 'CODIGO CLIENTE', 'COD CLIENTE']],
    ['amount', 'Monto *', ['MONTO', 'IMPORTE', 'TOTAL', 'MONTO PAGADO', 'ABONO', 'PAGO']],
    ['currency', 'Moneda', ['MONEDA', 'DIVISA']],
    ['rate', 'Tasa', ['TASA', 'TASA CAMBIO', 'CAMBIO', 'TASA BCV']],
    ['usd', 'Monto en $', ['MONTO USD', 'USD', 'DOLARES', 'MONTO $', 'EQUIVALENTE']],
    ['method', 'Forma de pago', ['FORMA PAGO', 'FORMA DE PAGO', 'METODO', 'TIPO PAGO', 'TIPO']],
    ['bank', 'Banco', ['BANCO']],
    ['ref', 'Referencia', ['REFERENCIA', 'REF', 'NRO REFERENCIA', 'N REFERENCIA', 'COMPROBANTE']],
    ['montoNota', 'Monto de la nota', ['MONTO NOTA', 'TOTAL NOTA', 'MONTO FACTURA']],
  ];
  const nrm = (v) => String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  function guessMethod(v) {
    const t = nrm(v);
    if (/MOVIL/.test(t)) return 'pago_movil';
    if (/TRANSF/.test(t)) return 'transferencia';
    if (/ZELLE/.test(t)) return 'zelle';
    if (/BINANCE|USDT/.test(t)) return 'binance';
    if (/PESO|COP/.test(t)) return 'efectivo_cop';
    if (/EFECTIVO|CASH|CONTADO/.test(t)) return /BS|BOLIV/.test(t) ? 'efectivo_bs' : 'efectivo_usd';
    return '';
  }
  function parseDay(v) {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/); if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
    m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})/); if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
    return '';
  }
  async function readTable(file) {
    let matrix;
    if (/\.(csv|txt)$/i.test(file.name)) matrix = global.Importer.parseCSV(await file.text());
    else {
      const { XLSX, wb } = await global.Importer.readWorkbook(file);
      matrix = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '', blankrows: false, dateNF: 'yyyy-mm-dd' });
    }
    matrix = matrix.map((r) => r.map((c) => String(c == null ? '' : c).trim()));
    const known = new Set([].concat(...IMP_FIELDS.map((f) => f[2])));
    let best = 0, score = -1;
    matrix.slice(0, 15).forEach((r, i) => { const sc = r.filter((c) => known.has(nrm(c))).length; if (sc > score) { best = i; score = sc; } });
    return { headers: matrix[best] || [], rows: matrix.slice(best + 1).filter((r) => r.some((c) => c)) };
  }
  function importSheet(onDone) {
    const P = PV(), { S, esc, usd, toast, openSheet } = P;
    const sh = openSheet(`<div class="row"><h2 class="grow">⇩ Importar pagos de FileMaker</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Sube el Excel o CSV que exporta FileMaker. Revisa la vista previa antes de guardar: nada se guarda hasta que tocas «Importar». Volver a subir el mismo archivo no duplica pagos.
        Si un pago que subió un vendedor tiene la misma referencia, queda aprobado (cobranza ya lo cargó en FileMaker).</p>
      <div class="row wrap" style="gap:8px"><button class="btn btn-primary" id="imFile">Elegir archivo (.xlsx, .xls, .csv)</button>
        <label class="field"><span>Tasa si el archivo trae Bs sin tasa (Bs por $)</span><input id="imRate" class="input" inputmode="decimal" value="${esc(S.config.exchangeRate || '')}"></label></div>
      <div id="imOut" style="margin-top:10px"></div>`, { wide: true });
    const out = sh.el.querySelector('#imOut');
    let table = null, map = {}, rows = [];
    // Clientes: por código, RIF, nota (si la nota ya está en la plataforma, el cliente sale de ahí) o nombre exacto
    const clients = S.clients.filter((c) => !c.deleted);
    const byRif = new Map(), byName = new Map(), byCode = new Map();
    clients.forEach((c) => { const r = String(c.rif || '').replace(/\D/g, ''); if (r) byRif.set(r, (byRif.get(r) || []).concat(c)); const n = nrm(c.name); byName.set(n, (byName.get(n) || []).concat(c)); if (c.code) byCode.set(nrm(c.code), (byCode.get(nrm(c.code)) || []).concat(c)); });
    const notaIdx = new Map(); S.orders.forEach((o) => { if (o.deleted) return; [o.valeryNote, o.delivery && o.delivery.newValery].forEach((n) => { const k = String(n || '').replace(/\D/g, '').replace(/^0+(?=\d)/, ''); if (k) notaIdx.set(k, o); const ps = noteParts(n); if (ps.length > 1) ps.forEach((x) => { if (!notaIdx.has(x)) notaIdx.set(x, o); }); }); });
    function analyze() {
      const g = (r, f) => (map[f] >= 0 ? String(r[map[f]] || '').trim() : '');
      const rate0 = decRate(sh.el.querySelector('#imRate').value);
      rows = table.rows.map((r, i) => {
        const fila = i + 2, nota = g(r, 'nota').replace(/\D/g, '').replace(/^0+(?=\d)/, ''), o = nota ? notaIdx.get(nota) : null;
        let cands = [];
        if (map.code >= 0 && g(r, 'code')) cands = byCode.get(nrm(g(r, 'code'))) || [];
        if (!cands.length && g(r, 'rif').replace(/\D/g, '')) cands = byRif.get(g(r, 'rif').replace(/\D/g, '')) || [];
        if (!cands.length && o && o.clientId) cands = clients.filter((c) => c.id === o.clientId);
        if (!cands.length && g(r, 'client')) cands = byName.get(nrm(g(r, 'client'))) || [];
        const date = parseDay(g(r, 'date')), method = guessMethod(g(r, 'method')) || (/BS|BOLIV|VES/.test(nrm(g(r, 'currency'))) ? 'transferencia' : '');
        const cur = /BS|BOLIV|VES/.test(nrm(g(r, 'currency'))) || (method && METHODS[method].currency === 'VES') ? 'VES' : /COP|PESO/.test(nrm(g(r, 'currency'))) ? 'COP' : 'USD';
        const amount = dec(g(r, 'amount')), rate = decRate(g(r, 'rate')) || (cur === 'VES' ? rate0 : 0);
        const usdV = dec(g(r, 'usd')) || (cur === 'USD' ? amount : cur === 'VES' && rate > 0 ? r2(amount / rate) : 0);
        const issues = [];
        if (!date) issues.push('sin fecha');
        if (!(usdV > 0)) issues.push(cur === 'VES' && !rate ? 'Bs sin tasa' : 'sin monto');
        if (!cands.length) issues.push('cliente no encontrado');
        else if (cands.length > 1) issues.push(`cliente repetido (${cands.length})`);
        const c = cands.length === 1 ? cands[0] : null;
        return { fila, date, nota, orderId: o && c && o.clientId === c.id ? o.id : '', clientId: c ? c.id : '', clientName: c ? c.name : g(r, 'client'), cands, sellerId: c ? c.sellerId || '' : '', sellerName: c ? ((P.sellerById(c.sellerId) || {}).name || '') : '',
          method: method || 'anterior', bank: g(r, 'bank'), ref: g(r, 'ref'), amount, currency: cur, rate, usd: r2(usdV), montoNota: dec(g(r, 'montoNota')) || (o ? (o.delivery && o.delivery.at ? +o.delivery.monto || 0 : global.Matrix.orderTotals(o).monto) : 0), issues, key: r.join('|').slice(0, 200) };
      });
    }
    function draw() {
      const okRows = rows.filter((x) => !x.issues.length);
      out.innerHTML = `<div class="card card-pad"><b>Columnas</b> <span class="muted">(revisa que cada dato venga de la columna correcta)</span>
          <div class="row wrap" style="gap:8px;margin-top:6px">${IMP_FIELDS.map(([f, l]) => `<label class="field"><span>${esc(l)}</span><select class="select" data-map="${f}"><option value="-1">— no viene —</option>${table.headers.map((h, i) => `<option value="${i}" ${map[f] === i ? 'selected' : ''}>${esc(h || 'Columna ' + (i + 1))}</option>`).join('')}</select></label>`).join('')}</div></div>
        <div class="kpi-row" style="margin-top:10px"><div class="kpi"><small>Filas</small><b>${rows.length}</b></div><div class="kpi"><small>Listas para importar</small><b>${okRows.length}</b><small>${usd(okRows.reduce((a, x) => a + x.usd, 0))}</small></div>
          <div class="kpi"><small>Con problemas</small><b class="${rows.length - okRows.length ? 'warn-txt' : ''}">${rows.length - okRows.length}</b><small>no se importan</small></div></div>
        <div style="overflow:auto;max-height:50vh"><table class="inv"><thead><tr><th>Fila</th><th>Fecha</th><th>Cliente</th><th>Nota</th><th class="n">Monto</th><th class="n">$</th><th>Forma</th><th>Referencia</th><th>Estado</th></tr></thead><tbody>
          ${rows.slice(0, 400).map((x, i) => `<tr><td>${x.fila}</td><td>${esc(x.date)}</td><td>${x.cands.length > 1 ? `<select class="select sm" data-pickc="${i}"><option value="">— ¿cuál? —</option>${x.cands.map((c) => `<option value="${esc(c.id)}" ${c.id === x.clientId ? 'selected' : ''}>${esc(c.name)} · ${esc(c.rif || '')} · ${esc((P.sellerById(c.sellerId) || {}).name || '')}</option>`).join('')}</select>` : esc(x.clientName)}</td>
            <td>${esc(x.nota)}</td><td class="n">${esc(String(x.amount))} ${x.currency === 'VES' ? 'Bs' : x.currency === 'COP' ? 'COP' : '$'}</td><td class="n">${usd(x.usd)}</td><td>${esc((METHODS[x.method] || {}).label || '')}</td><td>${esc(x.ref)}</td>
            <td>${x.issues.length ? `<span class="warn-txt">⚠ ${esc(x.issues.join(', '))}</span>` : '✓'}</td></tr>`).join('')}</tbody></table></div>
        <div class="actions"><button class="btn btn-primary" id="imGo" ${okRows.length ? '' : 'disabled'}>Importar ${okRows.length} pago${okRows.length === 1 ? '' : 's'}</button></div>`;
    }
    out.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.map) { map[t.dataset.map] = +t.value; analyze(); draw(); }
      if (t.dataset.pickc !== undefined) { const x = rows[+t.dataset.pickc], c = x.cands.find((y) => y.id === t.value); if (c) { x.clientId = c.id; x.clientName = c.name; x.sellerId = c.sellerId || ''; x.sellerName = (P.sellerById(c.sellerId) || {}).name || ''; x.issues = x.issues.filter((s2) => !/repetido/.test(s2)); } draw(); }
    });
    out.addEventListener('click', async (e) => {
      if (e.target.id !== 'imGo') return;
      const ready = rows.filter((x) => !x.issues.length);
      if (!confirm(`¿Importar ${ready.length} pagos de FileMaker? Quedan confirmados.`)) return;
      e.target.disabled = true;
      const res = { creados: 0, repetidos: 0, conciliados: 0, errores: [], conflictos: [] };
      for (let i = 0; i < ready.length; i += 200) {
        const r = await global.Sync.pagosCall({ action: 'importar', rows: ready.slice(i, i + 200).map((x) => ({ fila: x.fila, date: x.date, clientId: x.clientId, clientName: x.clientName, sellerId: x.sellerId, sellerName: x.sellerName, nota: x.nota, orderId: x.orderId,
          montoNota: x.montoNota, method: x.method, bank: x.bank, ref: x.ref, amount: x.amount, rate: x.rate, usd: x.usd, key: x.key, info: 'FileMaker' })) });
        if (!r.ok) { toast(r.error || 'No se pudo importar', 'err'); break; }
        ['creados', 'repetidos', 'conciliados'].forEach((k) => { res[k] += r.data[k] || 0; }); res.errores.push(...(r.data.errores || [])); res.conflictos.push(...(r.data.conflictos || []));
      }
      out.innerHTML = `<div class="hint">✓ Importación terminada: <b>${res.creados}</b> pagos nuevos · <b>${res.conciliados}</b> pagos de vendedores aprobados por coincidir la referencia · <b>${res.repetidos}</b> ya estaban.
        ${res.errores.length ? `<br><span class="warn-txt">${esc(res.errores.slice(0, 10).join(' · '))}</span>` : ''}</div>
        ${res.conflictos.length ? `<div class="hint warn">⚠ <b>${res.conflictos.length} referencia${res.conflictos.length === 1 ? '' : 's'} en conflicto</b> (ya usadas por otro cliente o con otro monto). No se aprobó ni se creó nada con ellas:<br>${res.conflictos.slice(0, 30).map(esc).join('<br>')}</div>` : ''}`;
      P.logEvent('pagos_importados', `Importó pagos de FileMaker: ${res.creados} nuevos, ${res.conciliados} conciliados, ${res.repetidos} repetidos${res.conflictos.length ? ', ' + res.conflictos.length + ' en conflicto' : ''}`);
      if (onDone) onDone();
    });
    sh.el.querySelector('#imFile').onclick = async () => {
      const f = await P.pickFile('.xlsx,.xls,.csv,.txt'); if (!f) return;
      try { table = await readTable(f); } catch (err) { toast(err.message || 'No se pudo leer el archivo', 'err'); return; }
      map = {}; IMP_FIELDS.forEach(([fld, , syn]) => { map[fld] = table.headers.findIndex((h) => syn.includes(nrm(h))); });
      analyze(); draw();
    };
    sh.el.querySelector('#imRate').onchange = () => { if (table) { analyze(); draw(); } };
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
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-sm" id="acAdd">＋ Agregar cuenta</button><button class="btn btn-sm btn-primary" id="acSave">Guardar cuentas</button></div>
      <div id="crBox" style="margin-top:18px"></div>`;
    renderRules(box.querySelector('#crBox'));
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

  /* ======================= Plazos de crédito (cuentas por cobrar) ======================= */
  const DEF_RULES = { def: 15, rules: [{ category: 'REFRESCOS', days: 8 }], desde: '2026-10-15', penal: 2, nuevas: 3, nuevosDesde: '2026-10-27' };
  const rulesNow = () => { const S = PV().S; return S.config.creditRules && typeof S.config.creditRules === 'object' ? S.config.creditRules : DEF_RULES; };
  function renderRules(box) {
    const P = PV(), { S, esc, toast } = P, cur = rulesNow();
    box.innerHTML = `<h3>📅 Cuentas por cobrar</h3>
      <p class="muted">Los <b>plazos de crédito por categoría</b> se fijan en <b>Inventario → 📅 Plazos de crédito</b>.</p>
      <div class="row wrap" style="gap:8px"><label class="field"><span>Cuentas desde (despachadas desde)</span><input id="crDesde" type="date" class="input" value="${esc(cur.desde || DEF_RULES.desde)}"></label></div>
      <p class="muted" style="font-size:13px">Las notas despachadas antes de «Cuentas desde» no aparecen como deuda (se cobraron en FileMaker antes de la app).</p>
      <h3 style="margin-top:16px">🚦 Crédito</h3>
      <div class="row wrap" style="gap:8px"><label class="field"><span>Bajar el límite sugerido (% por día de atraso)</span><input id="crPen" class="input" inputmode="decimal" value="${esc(cur.penal ?? DEF_RULES.penal)}" style="max-width:120px"></label>
        <label class="field"><span>Compras de contado de un cliente nuevo</span><input id="crNue" class="input" inputmode="numeric" value="${esc(cur.nuevas ?? DEF_RULES.nuevas)}" style="max-width:120px"></label>
        <label class="field"><span>Cuentan como nuevos los creados desde</span><input id="crNd" type="date" class="input" value="${esc(cur.nuevosDesde || DEF_RULES.nuevosDesde)}"></label></div>
      <p class="muted" style="font-size:13px">Cliente nuevo = creado en la app (por el vendedor o la oficina) desde esa fecha. Paga de contado sus primeras compras; luego el límite sugerido es el promedio de esas compras. Cobranza puede cambiarlo en Pagos → 🚦 Crédito de clientes.</p>
      <div class="row" style="gap:8px;margin-top:10px"><button class="btn btn-sm btn-primary" id="crSave">Guardar crédito</button></div>
      <h3 style="margin-top:16px">🧾 Revisión de cobranzas</h3>
      <label style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="crObl" ${S.config.cobObligatoria ? 'checked' : ''}> <span>Aprobación de cobranzas <b>obligatoria</b> antes de aprobar la hoja de carga<br><small class="muted">Apagado: es solo un aviso para la oficina. Encendido: la hoja no pasa a 🔒 hasta que la oficina la envíe a cobranzas, cobranzas revise todos los clientes y no quede ninguno retenido.</small></span></label>`;
    box.querySelector('#crObl').onchange = async (e) => {
      const on = e.target.checked;
      await P.saveDocs('config', { ...S.config, cobObligatoria: on });
      P.logEvent('ajustes', `Revisión de cobranzas ${on ? 'obligatoria' : 'como aviso (no bloquea)'}`);
      toast(on ? 'Cobranzas debe aprobar cada hoja antes de aprobarla' : 'La revisión de cobranzas queda como aviso', 'ok'); P.runSync(false);
    };
    box.querySelector('#crSave').onclick = async (e) => {
      e.stopPropagation();
      const r = { desde: box.querySelector('#crDesde').value || DEF_RULES.desde, penal: Number(String(box.querySelector('#crPen').value).replace(',', '.')), nuevas: Math.round(Number(box.querySelector('#crNue').value)), nuevosDesde: box.querySelector('#crNd').value || DEF_RULES.nuevosDesde };
      if (!(r.penal >= 0 && r.penal <= 50)) { toast('El % por día de atraso debe ser de 0 a 50', 'err'); return; }
      if (!(r.nuevas >= 0 && r.nuevas <= 10)) { toast('Las compras de contado deben ser de 0 a 10', 'err'); return; }
      // Los plazos (def, rules, hist) se conservan: se cambian en Inventario
      await P.saveDocs('config', { ...S.config, creditRules: { ...DEF_RULES, ...rulesNow(), ...r } });
      try { Object.keys(localStorage).filter((k) => k.startsWith('pv_cart:')).forEach((k) => localStorage.removeItem(k)); } catch (err) { /* noop */ }
      toast('Crédito guardado', 'ok'); P.runSync(false); renderRules(box);
    };
  }

  /* ======================= Plazos de crédito por categoría (Inventario) ======================= */
  // Cada categoría con sus días; las que no tienen, el plazo general. Un cambio vale para lo que se despache desde hoy:
  // se guarda una versión con fecha (hist) y las notas ya despachadas conservan el plazo con que salieron.
  const upc = (x) => String(x || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().trim();
  function plazosSheet(canEdit) {
    const P = PV(), { S, esc, toast } = P, cur = rulesNow();
    const cats = [...new Set((P.rubros ? P.rubros() : []).map((c) => (typeof c === 'string' ? c : c && (c.name || c.id))).filter(Boolean)
      .concat(S.products.filter((p) => !p.deleted && p.category).map((p) => p.category)))];
    const daysOf = (c) => { const r = (cur.rules || []).find((x) => upc(x.category) === upc(c)); return r ? r.days : ''; };
    const def = cur.def || DEF_RULES.def;
    const sh = P.openSheet(`<div class="row"><h2 class="grow">📅 Plazos de crédito</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Días que tiene el cliente para pagar, contados desde que la carga quedó <b>DESPACHADA</b>. Si una nota lleva productos de varias categorías, <b>cada parte vence en su plazo</b> (lo pagado se abona primero a lo que vence antes).</p>
      <p class="muted">Un cambio vale para lo que se despache <b>desde hoy</b>: las notas ya despachadas conservan su plazo.</p>
      <label class="field"><span>Plazo general (categorías sin plazo propio)</span><input id="plDef" class="input" inputmode="numeric" value="${esc(def)}" style="max-width:120px" ${canEdit ? '' : 'disabled'}></label>
      <table class="inv" style="margin-top:8px"><thead><tr><th>Categoría</th><th class="n">Productos</th><th>Plazo (días)</th></tr></thead><tbody>
        ${cats.map((c) => `<tr><td>${P.rubroIcon ? P.rubroIcon(c) : ''} <b>${esc(c)}</b></td><td class="n">${S.products.filter((p) => !p.deleted && p.category === c).length}</td>
          <td><input class="input sm" inputmode="numeric" data-plc="${esc(c)}" value="${esc(daysOf(c))}" placeholder="general (${esc(def)})" style="max-width:130px" ${canEdit ? '' : 'disabled'}></td></tr>`).join('')}</tbody></table>
      ${canEdit ? '<div class="actions"><button class="btn btn-primary" id="plOk">Guardar plazos</button></div>' : '<p class="muted">Solo consulta.</p>'}`);
    const ok = sh.el.querySelector('#plOk'); if (!ok) return;
    ok.onclick = async () => {
      const d = Math.round(Number(sh.el.querySelector('#plDef').value));
      if (!(d > 0 && d <= 120)) { toast('El plazo general debe ser de 1 a 120 días', 'err'); return; }
      const rules = [];
      for (const inp of sh.el.querySelectorAll('[data-plc]')) {
        const v = inp.value.trim(); if (!v) continue;
        const n = Math.round(Number(v)); if (!(n > 0 && n <= 120)) { toast(`Plazo inválido para ${inp.dataset.plc} (1 a 120 días)`, 'err'); return; }
        rules.push({ category: inp.dataset.plc, days: n });
      }
      const base = { ...DEF_RULES, ...rulesNow() }, today = P.today();
      const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
      if (base.def === d && same(base.rules || [], rules)) { sh.close(); return; }
      let hist = Array.isArray(base.hist) ? base.hist.slice() : [];
      if (!hist.length) hist.push({ from: '2000-01-01', def: base.def, rules: base.rules || [] }); // lo despachado antes conserva sus plazos
      hist = hist.filter((h) => h.from < today).concat({ from: today, def: d, rules });
      await P.saveDocs('config', { ...S.config, creditRules: { ...base, def: d, rules, hist: hist.slice(-60) } });
      P.logEvent('ajustes', `Plazos de crédito: general ${d} días${rules.length ? ' · ' + rules.map((r) => `${r.category} ${r.days}`).join(', ') : ''} (desde ${today})`);
      try { Object.keys(localStorage).filter((k) => k.startsWith('pv_cart:')).forEach((k) => localStorage.removeItem(k)); } catch (err) { /* noop */ }
      sh.close(); toast('Plazos guardados: valen para lo que se despache desde hoy', 'ok'); P.runSync(false);
    };
  }

  global.Pagos = { calc, METHODS, ADJUSTS, BANKS, normRef, renderSeller, renderOffice, renderAccounts, payForm, cuentaSheet, anteriorForm, importSheet, integridadSheet, plazosSheet, cargadoForm, cargadoUndo, fillStatus, flush, pend };
})(window);
