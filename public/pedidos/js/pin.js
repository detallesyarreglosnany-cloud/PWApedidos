/* =========================================================================
 * pin.js — PIN personal del vendedor (VOLUNTARIO).
 *
 * - Tomar, enviar y subir pedidos NUNCA depende del PIN (la sincronización sigue
 *   aunque la pantalla esté pidiendo el PIN).
 * - El vendedor crea su propio PIN cuando quiera («Ahora no» lo deja seguir).
 * - Teléfono de confianza: al crear o escribir el PIN, este teléfono recibe un permiso
 *   y no lo vuelve a pedir.
 * - Si el vendedor tiene PIN y este teléfono no tiene permiso (otro teléfono, otro
 *   vendedor, o la oficina restableció el PIN), se pide el PIN para seguir aquí.
 * - Sin internet no se puede comprobar: no se pide nada.
 * ========================================================================= */
(function (global) {
  'use strict';
  let busy = false;

  const tokens = async () => (await global.DB.getMeta('sellerTokens', {})) || {};
  async function saveToken(sid, t) { const m = await tokens(); m[sid] = t; await global.DB.setMeta('sellerTokens', m); }
  async function dropToken(sid) { const m = await tokens(); if (m[sid]) { delete m[sid]; await global.DB.setMeta('sellerTokens', m); } }

  /** Hoja que no se cierra tocando afuera (para cuando el PIN es necesario). */
  function lockedSheet(html) {
    const ov = document.createElement('div');
    ov.className = 'overlay pin-overlay';
    ov.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + '</div>';
    document.body.appendChild(ov);
    return { el: ov.querySelector('.sheet'), close: () => ov.remove() };
  }
  const pinInput = (id, label) => `<label class="field"><span>${label}</span><input id="${id}" class="input pin-in" type="password" inputmode="numeric" autocomplete="off" maxlength="6" placeholder="••••"></label>`;
  const clean = (v) => String(v || '').replace(/\D/g, '');

  /** Pide el PIN de un vendedor que ya lo tiene. onDone(true) al entrar. */
  function askSheet(sid, name) {
    const PV = global.PV;
    const sh = lockedSheet(`
      <h2 style="margin-top:0">🔒 ${PV.esc(name)}</h2>
      <p>Escribe tu PIN para usar tu usuario en este teléfono. Solo se pide una vez por teléfono.</p>
      <p class="muted" style="font-size:13px">Tus pedidos guardados siguen subiendo mientras tanto.</p>
      ${pinInput('pinAsk', 'PIN')}
      <p id="pinErr" class="warn-txt" style="min-height:1.2em"></p>
      <div class="actions"><button class="btn btn-primary" id="pinGo">Entrar</button><button class="btn" id="pinOut">Cambiar de vendedor</button></div>
      <p class="muted" style="font-size:13px">¿Olvidaste tu PIN? Pide a la oficina que lo restablezca y crea uno nuevo.</p>`);
    const inp = sh.el.querySelector('#pinAsk'), err = sh.el.querySelector('#pinErr');
    setTimeout(() => inp.focus(), 50);
    const go = async () => {
      const pin = clean(inp.value);
      if (pin.length < 4) { err.textContent = 'El PIN son 4 a 6 números'; return; }
      const r = await global.Sync.pinCall({ action: 'verify', sellerId: sid, pin });
      if (r && r.ok && r.data && r.data.token) { await saveToken(sid, r.data.token); sh.close(); PV.toast('Listo. Este teléfono queda como de confianza.', 'ok'); PV.render(); return; }
      if (r && r.offline) { err.textContent = 'Sin internet: inténtalo cuando tengas señal.'; return; }
      if (r && r.status === 403 && /no tiene PIN/.test(r.error || '')) { sh.close(); PV.render(); return; }
      if (r && r.status === 403 && /desconectó/.test(r.error || '')) { sh.close(); await PV.setSession(null); location.hash = '#/'; PV.render(); PV.toast(r.error, 'err'); return; }
      err.textContent = (r && r.error) || 'No se pudo comprobar el PIN'; inp.value = ''; inp.focus();
    };
    sh.el.querySelector('#pinGo').onclick = go;
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    sh.el.querySelector('#pinOut').onclick = async () => { sh.close(); await PV.setSession(null); location.hash = '#/'; PV.render(); };
  }

  /** Ofrece crear el PIN (siempre se puede decir «Ahora no»). */
  function createSheet(sid, name, fromMenu) {
    const PV = global.PV;
    const sh = PV.openSheet(`
      <div class="row"><h2 class="grow">🔒 Protege tu usuario</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p>Crea un PIN de 4 a 6 números para que nadie más pueda entrar como <b>${PV.esc(name)}</b> ni ver tus ventas. En este teléfono no te lo volverá a pedir.</p>
      ${pinInput('pinNew', 'PIN nuevo')}${pinInput('pinNew2', 'Repite el PIN')}
      <p id="pinErr" class="warn-txt" style="min-height:1.2em"></p>
      <div class="actions"><button class="btn btn-primary" id="pinMake">Crear PIN</button><button class="btn" id="pinLater">Ahora no</button></div>
      <p class="muted" style="font-size:13px">Tomar y enviar pedidos no cambia. Si lo olvidas, la oficina lo restablece.</p>`);
    const err = sh.el.querySelector('#pinErr');
    sh.el.querySelector('#pinLater').onclick = async () => { await global.DB.setMeta('pinAsk:' + sid, PV.today()); sh.close(); };
    sh.el.querySelector('#pinMake').onclick = async () => {
      const a = clean(sh.el.querySelector('#pinNew').value), b = clean(sh.el.querySelector('#pinNew2').value);
      if (a.length < 4) { err.textContent = 'El PIN son 4 a 6 números'; return; }
      if (a !== b) { err.textContent = 'Los dos PIN no coinciden'; return; }
      const r = await global.Sync.pinCall({ action: 'create', sellerId: sid, pin: a });
      if (r && r.ok && r.data && r.data.token) {
        await saveToken(sid, r.data.token); sh.close();
        PV.toast('PIN creado. Este teléfono queda como de confianza.', 'ok');
        PV.logEvent('pin_creado', 'Creó su PIN personal');
        return;
      }
      err.textContent = r && r.offline ? 'Sin internet: créalo cuando tengas señal.' : (r && r.error) || 'No se pudo crear el PIN';
    };
    if (fromMenu) sh.el.querySelector('#pinLater').textContent = 'Cancelar';
  }

  /**
   * Comprueba el PIN del vendedor en sesión (una vez por entrada; force = volver a comprobar).
   * Nunca detiene la sincronización.
   */
  async function check(opts) {
    const PV = global.PV, S = PV && PV.S;
    if (busy || !S || !S.session || !S.session.sellerId || !navigator.onLine) return;
    const sid = S.session.sellerId, seller = PV.sellerById(sid);
    if (!seller || (!(opts && opts.force) && S.ui.pinChecked === sid)) return;
    if (document.querySelector('.pin-overlay')) return;
    busy = true;
    try {
      const token = (await tokens())[sid] || '';
      const r = await global.Sync.pinCall({ action: 'status', sellerId: sid, token });
      if (!r || !r.ok || !r.data) return; // sin respuesta: se intenta luego, no se bloquea nada
      S.ui.pinChecked = sid;
      if (S.session.sellerId !== sid || !location.hash.startsWith('#/ruta')) return;
      if (r.data.blocked) {
        // La oficina desconectó este teléfono (perdido o robado): se sale del vendedor
        await dropToken(sid); await PV.setSession(null); location.hash = '#/'; PV.render();
        PV.toast('La oficina desconectó este teléfono para ' + seller.name + '. Habla con la oficina.', 'err');
        return;
      }
      if (r.data.hasPin && !r.data.tokenOk) { await dropToken(sid); askSheet(sid, seller.name); return; }
      // Ofrecer el PIN nunca interrumpe: si está escribiendo (cliente, cantidades…) se ofrece en otro momento
      const typing = document.activeElement && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
      if (!r.data.hasPin && typing) { S.ui.pinChecked = ''; return; }
      if (!r.data.hasPin && !document.querySelector('.overlay')) {
        if ((await global.DB.getMeta('pinAsk:' + sid, '')) === PV.today()) return; // «Ahora no»: mañana se vuelve a ofrecer
        createSheet(sid, seller.name);
      }
    } finally { busy = false; }
  }

  /** Desde el menú del vendedor: crear el PIN o ver su estado. */
  async function menu() {
    const PV = global.PV, sid = PV.S.session && PV.S.session.sellerId, seller = sid && PV.sellerById(sid);
    if (!seller) return;
    const t = (await tokens())[sid];
    if (!navigator.onLine) { PV.toast(t ? '🔒 Este teléfono es de confianza para ' + seller.name : 'Conéctate a internet para crear tu PIN', t ? 'ok' : 'err'); return; }
    const r = await global.Sync.pinCall({ action: 'status', sellerId: sid, token: t || '' });
    if (r && r.ok && r.data && r.data.hasPin && r.data.tokenOk) {
      PV.openSheet(`<div class="row"><h2 class="grow">🔒 Mi PIN</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <p>Ya tienes PIN y este teléfono es de confianza: no te lo pide aquí.</p><p class="muted">Si lo olvidas, la oficina lo restablece y creas uno nuevo. Si pierdes el teléfono, avisa a la oficina para que lo desconecte.</p>
        <div class="actions"><button class="btn btn-primary" data-close>Entendido</button></div>`);
      return;
    }
    if (r && r.ok && r.data && r.data.hasPin) { S_ui(PV).pinChecked = ''; check({ force: true }); return; }
    createSheet(sid, seller.name, true);
  }
  const S_ui = (PV) => PV.S.ui;

  global.PinGate = { check, menu, askSheet, createSheet };
})(window);
