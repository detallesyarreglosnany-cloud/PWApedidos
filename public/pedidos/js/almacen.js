/**
 * Almacenes de despacho: la hoja de carga se separa por almacén (ALMACÉN 1, ALMACÉN 3…) para que cada uno sepa
 * lo que sale de él y sus productos no se mezclen con los del otro.
 *
 * Cada categoría va a un almacén (config.almacenCat) y un producto puede ir a otro distinto al de su categoría
 * (config.almacenProd: ej. MALTAS en el 1, pero la Malta 207 y las latas en el 3). Mientras no se configure,
 * se usa la sugerencia (ver suggest) para que la hoja ya salga separada.
 */
(function (global) {
  'use strict';
  const DEF = [{ id: '1', nombre: 'ALMACÉN 1' }, { id: '3', nombre: 'ALMACÉN 3' }];
  const SIN = { id: '', nombre: 'SIN ALMACÉN', orden: 99 };
  const fold = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

  const list = (cfg) => ((cfg && Array.isArray(cfg.almacenes) && cfg.almacenes.length) ? cfg.almacenes : DEF);
  const configured = (cfg) => !!(cfg && (Object.keys(cfg.almacenCat || {}).length || Object.keys(cfg.almacenProd || {}).length));

  /**
   * Almacén sugerido para un producto (lista de Distribuidora Puerto Venado):
   * ALMACÉN 1: refrescos, aguas, jugos Del Valle, Malta 222, cerveza 222, Tóxica.
   * ALMACÉN 3: lo demás (galletas, sardinas, confitería, salsas, arroz, pasta, néctar Kaito, latas, Malta 207,
   * Chowy, surtido, papas fritas, gelatina, mermelada, whisky, ron, anís, vodka y licores).
   */
  function suggest(p) {
    const t = fold(`${p.category} ${p.name} ${p.presentation} ${p.brand || ''}`);
    if (/\blatas?\b|\b207\b/.test(t)) return '3';
    if (/del valle/.test(t)) return '1';
    if (/nectar|kaito|whisk|\bron\b|anis|vodka|licor|ginebra|tequila|vino|aguardiente/.test(t)) return '3';
    if (/refresco|gaseosa|\bagua|jugo|malta|cerveza|toxica/.test(t)) return '1';
    return '3';
  }
  /** Asignación sugerida para todo el catálogo: cada categoría al almacén de la mayoría y las excepciones por producto. */
  function suggestAll(products) {
    const by = {};
    products.filter((p) => !p.deleted).forEach((p) => { const c = p.category || ''; (by[c] = by[c] || {}); const s = suggest(p); by[c][s] = (by[c][s] || 0) + 1; });
    const cat = {};
    Object.entries(by).forEach(([c, n]) => { cat[c] = Object.entries(n).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]; });
    const prod = {};
    products.filter((p) => !p.deleted).forEach((p) => { const s = suggest(p); if (s !== cat[p.category || '']) prod[p.id] = s; });
    return { cat, prod };
  }

  /**
   * Función para Matrix.build (opts.almacen): (productId, categoría) → { id, nombre, orden }.
   * Sin configuración, usa la sugerencia con el producto del catálogo.
   */
  function resolver(cfg, products) {
    const alms = list(cfg), pById = new Map((products || []).map((p) => [p.id, p]));
    const auto = configured(cfg) ? null : suggestAll(products || []);
    const catMap = auto ? auto.cat : (cfg.almacenCat || {}), prodMap = auto ? auto.prod : (cfg.almacenProd || {});
    const memo = new Map();
    return (pid, cat) => {
      const k = pid + '\u0001' + cat;
      if (memo.has(k)) return memo.get(k);
      let id = prodMap[pid] || catMap[cat || ''];
      if (!id && auto) { const p = pById.get(pid); id = suggest(p || { category: cat, name: '' }); }
      const i = alms.findIndex((a) => String(a.id) === String(id));
      const r = i < 0 ? SIN : { id: String(alms[i].id), nombre: alms[i].nombre || `ALMACÉN ${alms[i].id}`, orden: i };
      memo.set(k, r); return r;
    };
  }

  /** Pantalla de Inventario → 🏬 Almacenes: almacén de cada categoría y excepciones por producto. */
  function sheet(canEdit) {
    const P = global.PV, { S, esc, toast } = P, cfg = S.config || {};
    const alms = list(cfg), prods = S.products.filter((p) => !p.deleted);
    const cats = [...new Set(P.rubros().concat(prods.map((p) => p.category)).filter((c) => c !== undefined))];
    const sug = suggestAll(prods);
    let cat = { ...(configured(cfg) ? cfg.almacenCat || {} : sug.cat) }, prod = { ...(configured(cfg) ? cfg.almacenProd || {} : sug.prod) };
    const opt = (sel, none) => `${none ? `<option value="">${esc(none)}</option>` : ''}${alms.map((a) => `<option value="${esc(a.id)}" ${String(sel) === String(a.id) ? 'selected' : ''}>${esc(a.nombre)}</option>`).join('')}`;
    const sh = P.openSheet('<div id="almBox"></div>');
    const draw = () => {
      sh.el.querySelector('#almBox').innerHTML = `<div class="row"><h2 class="grow">🏬 Almacenes de la hoja de carga</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <p class="muted">La hoja de carga sale separada por almacén: cada almacén ve solo lo que sale de él. Elige el almacén de cada categoría; si un producto sale de otro almacén (ej. la Malta 207 o las latas), cámbialo abajo.</p>
        ${configured(cfg) ? '' : '<div class="hint">Aún no se ha guardado: se muestra la <b>sugerencia</b> (refrescos, aguas, jugos Del Valle, Malta 222, cerveza 222 y Tóxica en el ALMACÉN 1; lo demás en el ALMACÉN 3). Revísala y toca «Guardar».</div>'}
        ${canEdit ? '<div class="toolbar"><button class="btn" id="almSug">✨ Sugerir de nuevo</button></div>' : ''}
        <table class="inv"><thead><tr><th>Categoría</th><th class="n">Productos</th><th>Almacén</th></tr></thead><tbody>
          ${cats.map((c) => `<tr><td>${P.rubroIcon(c)} <b>${esc(c || '(sin categoría)')}</b></td><td class="n">${prods.filter((p) => p.category === c).length}</td>
            <td><select class="select sm" data-almc="${esc(c)}" ${canEdit ? '' : 'disabled'}>${opt(cat[c] || '', 'Sin almacén')}</select></td></tr>`).join('')}</tbody></table>
        <div class="section-title">Productos que salen de otro almacén</div>
        <label class="field"><span>Buscar producto</span><input id="almQ" class="input" placeholder="Nombre o código"></label>
        <table class="inv" id="almProds"><thead><tr><th>Producto</th><th>Categoría</th><th>Almacén</th></tr></thead><tbody>
          ${prods.slice().sort((a, b) => (+!prod[a.id]) - (+!prod[b.id]) || String(a.category).localeCompare(String(b.category), 'es') || a.name.localeCompare(b.name, 'es')).map((p) => `<tr data-q="${esc(fold(p.code + ' ' + p.name + ' ' + p.presentation))}" ${prod[p.id] ? 'class="alm-exc"' : ''}>
            <td><span class="mono muted">${esc(p.code)}</span> ${esc(p.name)} <b>${esc(p.presentation || '')}</b></td><td>${esc(p.category)}</td>
            <td><select class="select sm" data-almp="${esc(p.id)}" ${canEdit ? '' : 'disabled'}>${opt(prod[p.id] || '', 'Como su categoría')}</select></td></tr>`).join('')}</tbody></table>
        ${canEdit ? '<div class="actions"><button class="btn btn-primary" id="almOk">Guardar almacenes</button></div>' : '<p class="muted">Solo consulta.</p>'}`;
      const q = sh.el.querySelector('#almQ');
      q.oninput = () => { const f = fold(q.value.trim()); sh.el.querySelectorAll('#almProds tbody tr').forEach((tr) => { tr.hidden = !!f && !tr.dataset.q.includes(f); }); };
      const sg = sh.el.querySelector('#almSug'); if (sg) sg.onclick = () => { cat = { ...sug.cat }; prod = { ...sug.prod }; draw(); toast('Sugerencia cargada: revisa y guarda', 'ok'); };
      const ok = sh.el.querySelector('#almOk'); if (!ok) return;
      ok.onclick = async () => {
        const c2 = {}, p2 = {};
        sh.el.querySelectorAll('[data-almc]').forEach((s) => { if (s.value) c2[s.dataset.almc] = s.value; });
        sh.el.querySelectorAll('[data-almp]').forEach((s) => { if (s.value && s.value !== c2[prods.find((p) => p.id === s.dataset.almp).category]) p2[s.dataset.almp] = s.value; });
        await P.saveDocs('config', { ...S.config, almacenes: alms, almacenCat: c2, almacenProd: p2 });
        P.logEvent('ajustes', `Almacenes: ${alms.map((a) => `${a.nombre}: ${Object.keys(c2).filter((c) => c2[c] === a.id).join(', ') || '—'}`).join(' · ')}${Object.keys(p2).length ? ` · ${Object.keys(p2).length} producto(s) en otro almacén` : ''}`);
        sh.close(); toast('Almacenes guardados: la hoja de carga sale separada por almacén', 'ok'); P.runSync(false);
      };
    };
    draw();
  }

  global.Almacen = { DEF, list, configured, suggest, suggestAll, resolver, sheet };
})(window);
