/* =========================================================================
 * clientes.js — Ficha completa del cliente (oficina y vendedor, mismo formulario).
 *
 *   Persona natural:  nombres + apellidos (mínimo 3 palabras: 2+1 o 1+2; lo ideal 2+2)
 *   Persona jurídica: razón social tal como aparece en el RIF
 *   + nombre del negocio, RIF / C.I., teléfonos, correo, dirección, punto de
 *   referencia, ruta, observaciones, fecha de ingreso y quién lo registró.
 * El vendedor no cambia días de crédito, vendedor ni estado (también lo bloquea
 * el servidor). Para crear un cliente se exige: nombre válido, documento,
 * teléfono y dirección. Un RIF / C.I. que ya existe no se repite.
 * ========================================================================= */
(function (global) {
  'use strict';

  const DOC_TYPES = ['V', 'E', 'J', 'G', 'P'];
  const P = () => global.PV;
  const words = (s) => String(s || '').replace(/[^\p{L}\p{N}.&'-]+/gu, ' ').trim().split(/\s+/).filter((w) => w.replace(/[^\p{L}]/gu, '').length >= 2);
  const up = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const digits = (s) => String(s || '').replace(/\D/g, '');

  /** Tipo de un cliente (los de antes no lo tienen: se deduce del RIF). */
  function kindOf(c) {
    if (c && (c.kind === 'natural' || c.kind === 'juridica')) return c.kind;
    const t = String((c && (c.docType || c.rif)) || '').trim().toUpperCase()[0];
    return t === 'V' || t === 'E' ? 'natural' : 'juridica';
  }
  function docOf(c) {
    if (c && c.docType) return { type: c.docType, num: c.docNumber || digits(c.rif) };
    const m = /^\s*([VEJGP])\s*-?\s*(.*)$/i.exec(String((c && c.rif) || ''));
    return m ? { type: m[1].toUpperCase(), num: digits(m[2]) } : { type: kindOf(c) === 'natural' ? 'V' : 'J', num: digits(c && c.rif) };
  }
  /**
   * ¿La oficina ya revisó este cliente? Los que registra un vendedor quedan «por
   * verificar»; los de la oficina o importados cuentan como verificados.
   */
  const isVerified = (c) => !!c && (c.verified === true || (c.verified !== false && c.source !== 'campo'));
  /** Datos que faltan (para avisar en la lista y en la ficha). */
  function missing(c) {
    const out = [];
    const k = kindOf(c);
    if (k === 'natural' ? words(c.name).length < 3 : words(c.name).length < 2) out.push(k === 'natural' ? 'nombre y apellido completos' : 'razón social completa');
    if (digits(c.rif).length < 6) out.push('RIF / C.I.');
    if (digits(c.phone).length < 10) out.push('teléfono');
    if (String(c.address || '').trim().length < 8) out.push('dirección');
    if (!String(c.reference || '').trim()) out.push('punto de referencia');
    return out;
  }

  /**
   * Formulario (crear o editar). opts: { mode: 'seller'|'office', prefillName, defaults, onSave(prev, next), onSaved(next) }
   * Sin onSave guarda solo (vendedor). Devuelve el cliente guardado en onSaved.
   */
  function formSheet(c0, opts) {
    opts = opts || {};
    const { S, esc, openSheet, toast, fmtDate } = P();
    const $ = (sel, el) => el.querySelector(sel);
    const office = opts.mode === 'office';
    const isNew = !c0;
    const sid = S.session && S.session.sellerId;
    const c = c0 || { ...(opts.defaults || {}), active: true, creditDays: 0, sellerId: (opts.defaults && opts.defaults.sellerId) || (office ? '' : sid) };
    const kind = kindOf(c0 || { kind: 'natural' });
    const doc = c0 ? docOf(c) : { type: 'V', num: '' };
    let fn = c.firstNames || '', ln = c.lastNames || '', legal = c.legalName || '';
    if (!c.firstNames && !c.legalName && c.name) { if (kind === 'natural') fn = c.name; else legal = c.name; }
    if (isNew && opts.prefillName) fn = up(opts.prefillName);
    const seller = c.sellerId ? (S.sellers.find((s) => s.id === c.sellerId) || {}) : {};
    const routes = [...new Set([...((seller.routes && seller.routes.length) ? seller.routes : (S.config.routes || [])), c.route].filter(Boolean))];
    const sellerOpts = S.sellers.map((s) => `<option value="${esc(s.id)}" ${s.id === c.sellerId ? 'selected' : ''}>${esc(s.name)}${s.active === false ? ' (inactivo)' : ''}</option>`).join('');
    const sh = openSheet(`
      <div class="row"><h2 class="grow">${isNew ? '＋ Cliente nuevo' : '✎ ' + esc(c.name)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${!isNew ? `<p class="muted" style="margin-top:0">Ingresó al sistema el ${esc(fmtDate(String(c.createdAt || c.updatedAt || '').slice(0, 10)) || '—')}${c.createdByName ? ' · registrado por ' + esc(c.createdByName) : ''}</p>` : ''}
      ${!isNew && !isVerified(c) ? `<div class="hint warn">🕓 <b>Por verificar:</b> lo registró ${esc(c.createdByName || 'un vendedor')}${c.verifyReason ? ' · ' + esc(c.verifyReason) : ''}. ${office ? 'Revisa nombre, RIF y dirección y pulsa «Guardar y verificar».' : 'La oficina lo revisará.'}</div>` : ''}
      ${!isNew && isVerified(c) && c.verifiedBy ? `<p class="muted" style="margin-top:0">✓ Verificado por ${esc(c.verifiedBy)}${c.verifiedAt ? ' el ' + esc(fmtDate(String(c.verifiedAt).slice(0, 10))) : ''}</p>` : ''}
      <form id="clf" class="form-grid" autocomplete="off" novalidate>
        <div class="field"><span>Tipo de cliente *</span><div class="seg" id="clKind">
          <button type="button" data-k="natural" class="${kind === 'natural' ? 'active' : ''}">👤 Persona natural</button>
          <button type="button" data-k="juridica" class="${kind === 'juridica' ? 'active' : ''}">🏢 Empresa (jurídica)</button></div></div>
        <div class="grid2" data-for="natural">
          <label class="field"><span>Nombres * <small class="muted">(lo ideal: 2)</small></span><input name="firstNames" class="input" maxlength="60" value="${esc(fn)}" placeholder="Ej: JOSÉ LUIS"></label>
          <label class="field"><span>Apellidos * <small class="muted">(lo ideal: 2)</small></span><input name="lastNames" class="input" maxlength="60" value="${esc(ln)}" placeholder="Ej: PÉREZ GÓMEZ"></label></div>
        <label class="field" data-for="juridica"><span>Razón social * <small class="muted">(tal como aparece en el RIF)</small></span><input name="legalName" class="input" maxlength="80" value="${esc(legal)}" placeholder="Ej: INVERSIONES LA ESQUINA, C.A."></label>
        <label class="field"><span>Nombre del negocio <small class="muted">(como lo conocen: bodega, abasto…)</small></span><input name="tradeName" class="input" maxlength="80" value="${esc(c.tradeName || '')}" placeholder="Ej: BODEGA LA ESQUINA"></label>
        <div class="grid2"><label class="field"><span>Documento *</span><div class="row" style="gap:6px"><select name="docType" class="select" style="max-width:76px">${DOC_TYPES.map((t) => `<option ${t === doc.type ? 'selected' : ''}>${t}</option>`).join('')}</select>
            <input name="docNumber" class="input mono grow" inputmode="numeric" maxlength="12" value="${esc(doc.num)}" placeholder="RIF o cédula"></div></label>
          <label class="field"><span>Teléfono *</span><input name="phone" class="input" inputmode="tel" maxlength="20" value="${esc(c.phone || '')}" placeholder="0414-1234567"></label></div>
        <div class="grid2"><label class="field"><span>Otro teléfono</span><input name="phone2" class="input" inputmode="tel" maxlength="20" value="${esc(c.phone2 || '')}"></label>
          <label class="field"><span>Correo</span><input name="email" class="input" inputmode="email" maxlength="80" value="${esc(c.email || '')}"></label></div>
        <label class="field"><span>Dirección *</span><textarea name="address" class="input" rows="2" maxlength="200">${esc(c.address || '')}</textarea></label>
        <label class="field"><span>Punto de referencia</span><input name="reference" class="input" maxlength="120" value="${esc(c.reference || '')}" placeholder="Ej: frente a la plaza, al lado de la farmacia"></label>
        <div class="grid2"><label class="field"><span>Ruta</span><select name="route" class="select"><option value="">—</option>${routes.map((r) => `<option ${r === c.route ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select></label>
          ${office ? `<label class="field"><span>Días de crédito</span><input name="creditDays" class="input" inputmode="numeric" value="${+c.creditDays || 0}"></label>`
            : `<div class="field"><span>Días de crédito</span><div class="input" style="opacity:.7">${+c.creditDays ? +c.creditDays + ' días' : 'Contado'} <small class="muted">(lo define la oficina)</small></div></div>`}</div>
        ${office ? `<div class="grid2"><label class="field"><span>Vendedor</span><select name="sellerId" class="select"><option value="">— Sin vendedor —</option>${sellerOpts}</select></label>
          <label class="row" style="align-self:end"><input type="checkbox" name="active" ${c.active !== false ? 'checked' : ''} style="width:22px;height:22px"> Activo</label></div>` : ''}
        <label class="field"><span>Observaciones</span><input name="notes" class="input" maxlength="200" value="${esc(c.notes || '')}" placeholder="Horario, quién recibe, forma de pago…"></label>
        <div id="clErr"></div>
        <p class="muted" style="margin:0">Los nombres se guardan en MAYÚSCULAS.${!office ? ' El cliente queda <b>por verificar</b> hasta que la oficina lo revise.' : ''}</p>
        <div class="actions"><button class="btn" type="button" data-close>Cancelar</button>${office && (isNew || !isVerified(c)) ? '<button class="btn btn-ok" type="submit" data-verify="1">✓ Guardar y verificar</button>' : ''}<button class="btn btn-primary" type="submit">${isNew ? 'Guardar cliente' : 'Guardar cambios'}</button></div>
      </form>`, { wide: true });
    const form = $('#clf', sh.el);
    let k = kind;
    const showKind = () => {
      sh.el.querySelectorAll('[data-for]').forEach((el) => { el.style.display = el.dataset.for === k ? '' : 'none'; });
      sh.el.querySelectorAll('#clKind [data-k]').forEach((b) => b.classList.toggle('active', b.dataset.k === k));
    };
    $('#clKind', sh.el).onclick = (e) => {
      const b = e.target.closest('[data-k]'); if (!b) return;
      k = b.dataset.k;
      const t = form.docType.value;
      if (k === 'juridica' && (t === 'V' || t === 'E')) form.docType.value = 'J';
      if (k === 'natural' && (t === 'J' || t === 'G')) form.docType.value = 'V';
      if (k === 'juridica' && !form.legalName.value.trim()) form.legalName.value = up([form.firstNames.value, form.lastNames.value].join(' '));
      showKind();
    };
    showKind();
    // Nombres en MAYÚSCULAS mientras se escribe (obligatorio)
    ['firstNames', 'lastNames', 'legalName', 'tradeName'].forEach((n) => { form[n].style.textTransform = 'uppercase'; form[n].addEventListener('blur', () => { form[n].value = up(form[n].value); }); });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const verify = !!(e.submitter && e.submitter.dataset.verify);
      const f = form, errs = [], warns = [];
      const firstNames = up(f.firstNames.value), lastNames = up(f.lastNames.value), legalName = up(f.legalName.value);
      const name = k === 'natural' ? up(firstNames + ' ' + lastNames) : legalName;
      const docType = f.docType.value, docNumber = digits(f.docNumber.value);
      const phone = f.phone.value.trim(), address = f.address.value.replace(/\s+/g, ' ').trim();
      if (k === 'natural') {
        const a = words(firstNames).length, b = words(lastNames).length;
        if (!a || !b || a + b < 3) errs.push('Nombre incompleto: escribe al menos 2 nombres y 1 apellido, o 1 nombre y 2 apellidos.');
        else if (a + b < 4) warns.push('Lo ideal son 2 nombres y 2 apellidos.');
        if (docType === 'J' || docType === 'G') warns.push('Una persona natural normalmente tiene cédula o RIF V / E.');
      } else {
        if (words(legalName).length < 2) errs.push('Escribe la razón social completa, como aparece en el RIF.');
        if (docType !== 'J' && docType !== 'G') warns.push('Una empresa normalmente tiene RIF J o G.');
      }
      if (docNumber.length < 6) errs.push('Falta el RIF o la cédula (solo números).');
      if (digits(phone).length < 10) (isNew ? errs : warns).push('Falta un teléfono válido (ej: 0414-1234567).');
      if (address.length < 8) (isNew ? errs : warns).push('Falta la dirección.');
      if (!f.reference.value.trim()) warns.push('Sin punto de referencia: ayuda al despachador a encontrarlo.');
      // RIF / C.I. repetido: es el mismo cliente
      const same = docNumber.length >= 6 ? S.clients.find((x) => !x.deleted && x.id !== c.id && digits(x.rif) === docNumber) : null;
      if (same) errs.push(`Ya existe un cliente con ese documento: «${same.name}»${office ? '' : '. Búscalo en tu cartera; si no está, pide a la oficina que te lo asigne.'}`);
      const box = $('#clErr', sh.el);
      box.innerHTML = errs.length || warns.length ? `<div class="hint ${errs.length ? 'warn' : ''}">${errs.map((x) => '⛔ ' + esc(x)).join('<br>')}${errs.length && warns.length ? '<br>' : ''}${warns.map((x) => '⚠ ' + esc(x)).join('<br>')}</div>` : '';
      if (errs.length && !(office && !isNew && !same)) { box.scrollIntoView({ block: 'nearest' }); return; }
      if (errs.length && office && !isNew && !confirm('La ficha tiene datos incompletos:\n\n' + errs.join('\n') + '\n\n¿Guardar igual?')) return;
      const now = new Date().toISOString();
      const next = {
        ...c, id: c.id || global.DB.uid('c'), kind: k, name, firstNames: k === 'natural' ? firstNames : '', lastNames: k === 'natural' ? lastNames : '',
        legalName: k === 'juridica' ? legalName : '', tradeName: up(f.tradeName.value), docType, docNumber, rif: docNumber ? docType + '-' + docNumber : '',
        phone, phone2: f.phone2.value.trim(), email: f.email.value.trim(), address, reference: f.reference.value.replace(/\s+/g, ' ').trim(),
        route: f.route.value, notes: f.notes.value.trim(), deleted: false,
        ...(office ? { creditDays: Math.max(0, parseInt(f.creditDays.value, 10) || 0), sellerId: f.sellerId.value, active: f.active.checked } : {}),
        ...(isNew ? { createdAt: now, createdByName: office ? ((S.config && S.config.adminName) || 'Oficina') : ((S.sellers.find((s) => s.id === sid) || {}).name || 'Vendedor'),
          source: office ? 'oficina' : 'campo', active: office ? f.active.checked : true, sellerId: office ? f.sellerId.value : sid } : {}),
      };
      if (office && verify) Object.assign(next, { verified: true, verifiedAt: now, verifiedBy: (S.config && S.config.adminName) || 'Oficina', verifyReason: '' });
      else if (office && isNew) next.verified = true;
      if (!office && isNew) Object.assign(next, { verified: false, verifyReason: 'cliente nuevo' });
      // El vendedor cambió el nombre o el documento de un cliente verificado: vuelve a revisión
      if (!office && !isNew && isVerified(c) && (next.name !== c.name || digits(next.rif) !== digits(c.rif))) Object.assign(next, { verified: false, verifyReason: 'el vendedor cambió nombre o RIF' });
      if (opts.onSave) await opts.onSave(c0, next);
      else {
        await P().saveDocs('clients', next);
        await P().logEvent(isNew ? 'cliente_nuevo' : 'cliente_editado', `${isNew ? 'Registró el cliente' : 'Actualizó los datos de'} ${next.name}${next.rif ? ' (' + next.rif + ')' : ''}`, { clientId: next.id, clientName: next.name });
      }
      // El nombre corregido llega también a sus pedidos que aún se pueden editar
      if (!isNew && c0 && c0.name !== next.name) {
        const L = global.Loads, mine = S.orders.filter((o) => !o.deleted && o.clientId === next.id && (office || (L && L.editable(o))));
        if (mine.length) await P().saveDocs('orders', mine.map((o) => ({ ...o, clientName: next.name, clientKey: P().norm(next.name), clientRif: next.rif || o.clientRif || '' })));
      }
      sh.close();
      toast(isNew ? 'Cliente registrado: ' + next.name : 'Datos guardados', 'ok');
      if (opts.onSaved) opts.onSaved(next);
      P().runSync(false);
    };
  }

  /** Ficha completa (solo lectura) con acciones. */
  function infoHTML(c) {
    const { esc, fmtDate, S } = P();
    const row = (k, v) => (v ? `<div><small class="muted">${esc(k)}</small><div><b>${esc(v)}</b></div></div>` : '');
    const seller = S.sellers.find((s) => s.id === c.sellerId);
    return `${isVerified(c) ? '' : `<div class="hint warn">🕓 Por verificar por la oficina${c.verifyReason ? ' · ' + esc(c.verifyReason) : ''}</div>`}<div class="grid2" style="gap:10px 16px">
      ${row('Tipo', kindOf(c) === 'natural' ? 'Persona natural' : 'Empresa (jurídica)')}${row('RIF / C.I.', c.rif)}
      ${row('Nombre del negocio', c.tradeName)}${row('Teléfono', [c.phone, c.phone2].filter(Boolean).join(' · '))}
      ${row('Dirección', c.address)}${row('Punto de referencia', c.reference)}
      ${row('Ruta', c.route)}${row('Crédito', +c.creditDays ? +c.creditDays + ' días' : 'Contado')}
      ${row('Correo', c.email)}${row('Vendedor', seller && seller.name)}
      ${row('Ingresó al sistema', c.createdAt ? fmtDate(String(c.createdAt).slice(0, 10)) + (c.createdByName ? ' · ' + c.createdByName : '') : '')}${row('Observaciones', c.notes)}</div>`;
  }

  /**
   * Fusión de clientes (oficina): los repetidos pasan al cliente real sin cabos sueltos.
   *  1. Kardex de vacíos: los movimientos manuales se pasan en el servidor (necesita internet).
   *  2. Pedidos (también los liquidados): cliente, nombre y RIF del real. Los liquidados
   *     suben su kxRev: el servidor cancela sus renglones viejos y los escribe para el real.
   *  3. El real completa los datos que le faltan con los de los repetidos.
   *  4. Los repetidos quedan eliminados con mergedInto (no se reusan ni aparecen en carteras).
   */
  async function merge(real, dups) {
    const { S, saveDocs, logEvent, norm } = P();
    dups = dups.filter((d) => d && d.id !== real.id);
    if (!dups.length) return { orders: 0 };
    const by = (S.config && S.config.adminName) || 'Oficina';
    const k = await global.Sync.adminCall('envases', { action: 'merge', from: dups.map((d) => d.id), to: real.id, toName: real.name, by });
    if (!k.ok) throw new Error('Se necesita internet para pasar el kardex de vacíos (' + (k.error || 'sin conexión') + '). No se cambió nada.');
    const ids = new Set(dups.map((d) => d.id));
    const os = S.orders.filter((o) => !o.deleted && ids.has(o.clientId));
    await saveDocs('orders', os.map((o) => ({ ...o, clientId: real.id, clientName: real.name, clientKey: norm(real.name), clientRif: real.rif || o.clientRif || '',
      mergedFrom: o.clientId, ...(o.delivery && o.delivery.at ? { kxRev: (+o.kxRev || 0) + 1 } : {}) })));
    const fill = {};
    ['rif', 'docType', 'docNumber', 'phone', 'phone2', 'email', 'address', 'reference', 'tradeName'].forEach((f) => { if (!real[f]) { const src = dups.find((d) => d[f]); if (src) fill[f] = src[f]; } });
    const now = new Date().toISOString();
    await saveDocs('clients', [{ ...real, ...fill, mergedIds: [...new Set([...(real.mergedIds || []), ...dups.map((d) => d.id)])] },
      ...dups.map((d) => ({ ...d, deleted: true, active: false, mergedInto: real.id, mergedAt: now, mergedBy: by }))]);
    await logEvent('clientes_fusionados', `Fusionó ${dups.map((d) => '«' + d.name + '»').join(', ')} en «${real.name}» · ${os.length} pedido(s) pasados${k.data && k.data.moved ? ' · ' + k.data.moved + ' movimiento(s) de vacíos' : ''}`, { clientId: real.id, clientName: real.name });
    P().runSync(false);
    return { orders: os.length, liquidated: os.filter((o) => o.delivery && o.delivery.at).length, kardex: (k.data && k.data.moved) || 0, filled: Object.keys(fill) };
  }

  global.Clientes = { kindOf, docOf, missing, formSheet, infoHTML, words, isVerified, up, merge };
})(window);
