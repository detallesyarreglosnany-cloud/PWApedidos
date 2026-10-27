/* =========================================================================
 * mkt.js — Promoción y marketing: vitrinas y mezclas (M1).
 *
 * La Oficina y Gerencia arman las vitrinas (nombre, frase, color, sello, qué productos y en qué orden) y las mezclas
 * (por ejemplo, tinto de verano: Tóxica tinta + Chinotto). El vendedor las muestra en la tablet en «🛍 Vitrina»: lo que
 * agrega desde ahí va directo al pedido del cliente (el mismo pedido de la lista), sin anotar en un cuaderno.
 * Todo se guarda en un documento aparte de la configuración (config id «mkt»), así no se mezcla con los ajustes.
 * Mientras nadie guarde, se usan las vitrinas sugeridas (por palabras: categoría, marca, nombre o presentación).
 * ========================================================================= */
(function (global) {
  'use strict';
  const PV = () => global.PV;
  const uid = () => 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const DEF_VITRINAS = [
    { id: 'v_siempre', nombre: 'Los que siempre te acompañan', frase: 'En cada comida y en cada momento: los refrescos que nunca pueden faltar', icono: '🥤', hue: 356, buscar: ['refresco', 'soda', 'coca', 'chinotto', 'gaseosa'], orden: 'ventas', sello: '⭐ El favorito de todos', activa: true },
    { id: 'v_lonchera', nombre: 'Arma la lonchera de los más pequeños', frase: 'Todos los sabores para el recreo: lleva uno de cada uno', icono: '🎒', hue: 42, buscar: ['nectar', 'jugo'], orden: 'peso', sello: '💛 Lo más pedido por las mamás', activa: true },
    { id: 'v_salsas', nombre: 'Quiero, la sazón del hogar', frase: 'Comida casera en minutos, para cuando no hay tiempo: napolitana, rabiata, boloñesa, guiso…', icono: '🍝', hue: 14, buscar: ['salsa'], orden: 'peso', sello: '👩‍🍳 La que más se lleva', activa: true },
    { id: 'v_maltas', nombre: 'Nuestra morena, el sabor de aquí', frase: 'Refrescante y bien nuestra: nada que envidiarle a nadie', icono: '🟤', hue: 28, buscar: ['malta'], orden: 'ventas', sello: '🇻🇪 La preferida', activa: true },
    { id: 'v_finde', nombre: 'Para tus fines de semana', frase: 'Cervezas, sangrías y licores bien fríos para compartir', icono: '🍻', hue: 205, buscar: ['cerveza', 'toxica', 'sangria', 'ron', 'anis', 'whisky', 'licor', 'vino'], orden: 'ventas', sello: '🔥 Se va rápido', adultos: true, activa: true },
    { id: 'v_evento', nombre: 'Todo para tu evento o celebración', frase: 'Cotillón, piñata y mesa de dulces: chowy, surtidos y galletas para todos', icono: '🎉', hue: 300, buscar: ['chowy', 'surtido', 'galleta', 'wabi', 'cotufi', 'charmy', 'mini maria', 'punto rojo'], orden: 'ventas', sello: '🎈 Infaltable en la fiesta', activa: true },
  ];
  const DEF_MEZCLAS = [
    { id: 'x_tinto', nombre: 'Tinto de verano', frase: 'El trago del verano, con lo que ya vendes', icono: '🍷', vitrina: 'v_finde', items: [{ q: 'toxica tinta', cajas: 1, unidades: 0 }, { q: 'chinotto', cajas: 1, unidades: 0 }], pasos: 'Mitad sangría Tóxica tinta y mitad Chinotto bien frío, con mucho hielo y rodajas de limón o naranja.' },
    { id: 'x_michelada', nombre: 'Michelada', frase: 'La cerveza con su toque', icono: '🍺', vitrina: 'v_finde', items: [{ q: 'cerveza azul', cajas: 1, unidades: 0 }], pasos: 'Escarcha el borde del vaso con sal y limón, agrega jugo de limón, unas gotas de salsa picante y cerveza bien fría.' },
    { id: 'x_anis', nombre: 'Anís refrescante', frase: 'Suave y fresco para la tarde', icono: '🍸', vitrina: 'v_finde', items: [{ q: 'anis', cajas: 1, unidades: 0 }, { q: 'chinotto', cajas: 1, unidades: 0 }], pasos: 'Una medida de anís, completa con Chinotto frío y hielo. Decora con hojas de menta o limón.' },
  ];

  /* ---------------- Datos ---------------- */
  function data() {
    const m = PV().S.mkt;
    return { vitrinas: m && Array.isArray(m.vitrinas) ? m.vitrinas : DEF_VITRINAS, mezclas: m && Array.isArray(m.mezclas) ? m.mezclas : DEF_MEZCLAS, saved: !!m };
  }
  async function save(patch, what) {
    const P = PV(), d = data();
    await P.saveDocs('config', { ...(P.S.mkt || {}), id: 'mkt', vitrinas: d.vitrinas, mezclas: d.mezclas, ...patch });
    if (what) P.logEvent('marketing', what);
    P.runSync(false);
  }
  const hayOf = (p) => PV().norm([p.category, p.subgroup, p.brand, p.name, p.presentation].join(' '));
  const active = () => PV().S.products.filter((p) => p.active !== false && !p.deleted);

  /** Tamaño de la presentación en gramos o mililitros (para ordenar salsas por peso: 120 g, 340 g, 500 g…). */
  function sizeOf(p) {
    const s = PV().norm(`${p.presentation || ''} ${p.name || ''}`).replace(/(\d),(\d)/g, '$1.$2');
    const m = s.match(/(\d+(?:\.\d+)?)\s*(kgs?|kilos?|grs?|gramos?|g|ml|cc|lts?|litros?|l)(?![a-z])/);
    if (!m) return null;
    const n = +m[1], u = m[2], big = /^(kg|kilo|lt|litro|l)/.test(u) && !/^ml/.test(u);
    const vol = /^(ml|cc|lt|litro|l)/.test(u);
    const v = big ? n * 1000 : n;
    return { v, label: vol ? (v >= 1000 ? `${String(v / 1000).replace('.', ',')} L` : `${v} ml`) : v >= 1000 ? `${String(v / 1000).replace('.', ',')} kg` : `${v} g` };
  }

  /** Productos de una vitrina: por categorías o palabras, más los agregados a mano, menos los quitados; en su orden. */
  function productsOf(v) {
    const P = PV(), words = (v.buscar || []).map((w) => P.norm(w)).filter(Boolean), cats = new Set(v.cats || []), inc = v.incluir || [], exc = new Set(v.excluir || []);
    const pop = P.popularity().n;
    const all = active();
    const hit = all.filter((p) => !exc.has(p.id) && (cats.has(p.category) || (words.length && words.some((w) => hayOf(p).includes(w))) || inc.includes(p.id)));
    const byName = (a, b) => String(a.name).localeCompare(String(b.name), 'es') || String(a.presentation).localeCompare(String(b.presentation), 'es', { numeric: true });
    const sz = (p) => { const x = sizeOf(p); return x ? x.v : 1e9; };
    const ord = v.orden || 'ventas';
    if (ord === 'peso') hit.sort((a, b) => sz(a) - sz(b) || byName(a, b));
    else if (ord === 'nombre') hit.sort(byName);
    else if (ord === 'manual') hit.sort((a, b) => ((inc.indexOf(a.id) + 1) || 1e6) - ((inc.indexOf(b.id) + 1) || 1e6) || byName(a, b));
    else hit.sort((a, b) => (pop.get(b.id) || 0) - (pop.get(a.id) || 0) || byName(a, b));
    return hit;
  }
  /** Producto de un ingrediente de mezcla: el elegido, o el primero que coincide con sus palabras. */
  function itemProduct(it) {
    const P = PV();
    if (it.pid) { const p = P.productById(it.pid); if (p && p.active !== false && !p.deleted) return p; }
    const t = P.norm(it.q || '').split(' ').filter(Boolean); if (!t.length) return null;
    return active().find((p) => t.every((w) => hayOf(p).includes(w))) || null;
  }

  /* ---------------- Vendedor: la vitrina ---------------- */
  function banner(v, ps) {
    const P = PV(), { esc } = P, pics = ps.filter((p) => P.hasPhoto(p)).slice(0, 3);
    return `<header class="vt-banner"><div class="vt-txt"><span class="vt-ico" aria-hidden="true">${esc(v.icono || '🛍')}</span><h2>${esc(v.nombre)}</h2>${v.frase ? `<p>${esc(v.frase)}</p>` : ''}
      ${v.adultos ? '<span class="vt-18">🔞 Solo mayores de 18 · Consumo responsable</span>' : ''}</div>
      <div class="vt-collage">${pics.map((p) => `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">`).join('')}</div></header>`;
  }
  function mezclaHTML(x) {
    const P = PV(), { esc, usd } = P, its = (x.items || []).map((it) => ({ it, p: itemProduct(it) }));
    if (!its.length || its.some((y) => !y.p)) return ''; // si falta un ingrediente en el catálogo, no se muestra
    const monto = its.reduce((a, { it, p }) => a + (+it.cajas || 0) * (+p.boxPrice || 0) + (+it.unidades || 0) * (+p.unitPrice || 0), 0);
    return `<article class="vt-mix"><div class="vt-mix-head"><span class="vt-ico" aria-hidden="true">${esc(x.icono || '🍹')}</span><div><h3>${esc(x.nombre)}</h3>${x.frase ? `<p>${esc(x.frase)}</p>` : ''}</div></div>
      <div class="vt-mix-items">${its.map(({ it, p }) => `<div class="vt-ing">${P.hasPhoto(p) ? `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">` : `<span>${P.rubroIcon(p.category)}</span>`}<small>${esc(p.name)} ${esc(p.presentation || '')}<br><b>${[+it.cajas ? it.cajas + ' cj' : '', +it.unidades ? it.unidades + ' un' : ''].filter(Boolean).join(' + ')}</b></small></div>`).join('<span class="vt-plus">+</span>')}</div>
      ${x.pasos ? `<p class="vt-pasos">${esc(x.pasos)}</p>` : ''}
      <button type="button" class="btn btn-primary" data-mix="${esc(x.id)}">➕ Agregar los ingredientes · ${usd(monto)}</button></article>`;
  }
  /** HTML de la vitrina para el catálogo del vendedor (mismas tarjetas y mismo pedido que la lista). */
  function renderSeller(o) {
    const P = PV(), { esc } = P, d = data(), pop = P.popularity().n;
    const vs = d.vitrinas.filter((v) => v.activa !== false).map((v) => ({ v, ps: productsOf(v) })).filter((x) => x.ps.length);
    if (!vs.length) return '<div class="empty"><strong>Aún no hay vitrinas</strong>La oficina las arma en «Promoción y marketing».</div>';
    const card = (v, p, top) => {
      const h = P.productHTML(p, o);
      return top.has(p.id) && v.sello ? h.replace('<div class="pimg">', `<div class="pimg"><em class="vt-sello">${esc(v.sello)}</em>`) : h;
    };
    return `<div class="vt-nav">${vs.map(({ v }) => `<button type="button" class="vt-go" data-vgo="${esc(v.id)}" style="--h:${+v.hue || 0}">${esc(v.icono || '')} ${esc(v.nombre)}</button>`).join('')}
        <button type="button" class="vt-go vt-full" data-vfull="1" title="Pantalla completa para mostrar en la tablet">⛶</button></div>
      ${vs.map(({ v, ps }) => {
        const top = new Set(ps.filter((p) => (pop.get(p.id) || 0) >= 2).sort((a, b) => (pop.get(b.id) || 0) - (pop.get(a.id) || 0)).slice(0, 3).map((p) => p.id));
        let lastSz = null;
        const row = ps.map((p) => {
          let sep = '';
          if (v.orden === 'peso') { const s = sizeOf(p), lbl = s ? s.label : 'Otras'; if (lbl !== lastSz) { sep = `<div class="vt-sep">${esc(lbl)}</div>`; lastSz = lbl; } }
          return sep + card(v, p, top);
        }).join('');
        const mixes = d.mezclas.filter((x) => x.vitrina === v.id).map(mezclaHTML).filter(Boolean).join('');
        return `<section class="vt" id="vt-${esc(v.id)}" style="--h:${+v.hue || 0}">${banner(v, ps)}<div class="vt-row">${row}</div>${mixes ? `<div class="vt-mixes">${mixes}</div>` : ''}</section>`;
      }).join('')}`;
  }
  /** Clics de la vitrina en el catálogo del vendedor. true = ya se atendió. */
  function onSellerClick(e) {
    const P = PV();
    const go = e.target.closest('[data-vgo]');
    if (go) { const t = document.getElementById('vt-' + go.dataset.vgo); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
    if (e.target.closest('[data-vfull]')) {
      const de = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (de.requestFullscreen) de.requestFullscreen().catch(() => {});
      return true;
    }
    const mb = e.target.closest('[data-mix]'); if (!mb) return false;
    const x = data().mezclas.find((m) => m.id === mb.dataset.mix); if (!x) return true;
    (async () => {
      const o = P.activeOrder(); if (!o) { await P.setQty('', 'cajas', 0); return; } // pide elegir el cliente
      for (const it of x.items || []) {
        const p = itemProduct(it); if (!p) continue;
        const l = (P.activeOrder().lines || {})[p.id] || {};
        if (+it.cajas && p.sellBy !== 'unidad') await P.setQty(p.id, 'cajas', (+l.cajas || 0) + +it.cajas);
        if (+it.unidades && p.sellBy !== 'caja') await P.setQty(p.id, 'unidades', (+(P.activeOrder().lines[p.id] || {}).unidades || 0) + +it.unidades);
      }
      P.toast(`${x.nombre}: ingredientes agregados al pedido`, 'ok');
      if (navigator.vibrate) navigator.vibrate(15);
    })();
    return true;
  }

  /* ---------------- Oficina y Gerencia: Promoción y marketing ---------------- */
  const PALETTE = [356, 14, 28, 42, 95, 150, 175, 205, 230, 265, 300, 330];
  function render(root) {
    const P = PV(), S = P.S, { esc } = P, ui = (S.ui.mkt = S.ui.mkt || { tab: 'vitrinas' }), d = data();
    const tab = S.ui.mktTab || ui.tab || 'vitrinas';
    root.innerHTML = `<div class="toolbar"><div class="seg">${[['vitrinas', '🛍 Vitrinas'], ['mezclas', '🍹 Mezclas'], ['combos', '🎁 Combos']].map(([k, l]) => `<button type="button" class="${tab === k ? 'active' : ''}" data-mt="${k}">${l}</button>`).join('')}</div><span class="grow"></span>
        ${tab === 'vitrinas' ? '<button class="btn btn-primary" id="mkNew">＋ Nueva vitrina</button>' : tab === 'mezclas' ? '<button class="btn btn-primary" id="mkNewX">＋ Nueva mezcla</button>' : ''}</div>
      ${d.saved ? '' : '<div class="hint">✨ Estas son las <b>vitrinas sugeridas</b>. Edítalas a tu gusto: al guardar el primer cambio quedan como las de la empresa y les llegan a todos los vendedores.</div>'}
      <div id="mkBody"></div>`;
    const body = root.querySelector('#mkBody');
    if (tab === 'vitrinas') listVitrinas(body);
    else if (tab === 'mezclas') listMezclas(body);
    else body.innerHTML = '<div class="empty card"><strong>🎁 Combos promocionales</strong>Próxima ola: combos con su precio, lo que incluyen de regalo y la autorización de Gerencia.</div>';
    root.onclick = (e) => {
      const t = e.target.closest('[data-mt]'); if (t) { S.ui.mktTab = t.dataset.mt; render(root); return; }
      if (e.target.closest('#mkNew')) { editVitrina(null, () => render(root)); return; }
      if (e.target.closest('#mkNewX')) { editMezcla(null, () => render(root)); return; }
      const ev = e.target.closest('[data-ev]'); if (ev) { editVitrina(data().vitrinas.find((v) => v.id === ev.dataset.ev), () => render(root)); return; }
      const ex = e.target.closest('[data-ex]'); if (ex) { editMezcla(data().mezclas.find((x) => x.id === ex.dataset.ex), () => render(root)); return; }
      const mv = e.target.closest('[data-mv]');
      if (mv) {
        const [id, dir] = mv.dataset.mv.split('|'), list = data().vitrinas.slice(), i = list.findIndex((v) => v.id === id), j = i + +dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        save({ vitrinas: list }, 'Cambió el orden de las vitrinas').then(() => render(root));
        return;
      }
      const tg = e.target.closest('[data-tg]');
      if (tg) { const list = data().vitrinas.map((v) => (v.id === tg.dataset.tg ? { ...v, activa: v.activa === false } : v)); const v = list.find((x) => x.id === tg.dataset.tg); save({ vitrinas: list }, `Vitrina «${v.nombre}» ${v.activa === false ? 'oculta' : 'visible'}`).then(() => render(root)); }
    };
  }
  function listVitrinas(body) {
    const P = PV(), { esc } = P, list = data().vitrinas;
    body.innerHTML = `<p class="muted">Así las ve el vendedor en «🛍 Vitrina», en este orden. Lo que el cliente pide desde la vitrina va directo a su pedido.</p>
      <div class="mk-list">${list.map((v, i) => { const ps = productsOf(v); return `<div class="mk-card ${v.activa === false ? 'off' : ''}" style="--h:${+v.hue || 0}">
        <div class="mk-sw">${esc(v.icono || '🛍')}</div>
        <div class="grow"><b>${esc(v.nombre)}</b>${v.adultos ? ' <span class="status over">🔞 +18</span>' : ''}${v.activa === false ? ' <span class="status espera">oculta</span>' : ''}<div class="muted">${esc(v.frase || '')}</div>
          <small class="muted">${ps.length} productos · orden: ${({ peso: 'por peso', ventas: 'más vendidos primero', nombre: 'por nombre', manual: 'a mano' })[v.orden || 'ventas']}${v.sello ? ' · sello «' + esc(v.sello) + '»' : ''}</small></div>
        <div class="row" style="gap:4px"><button class="btn btn-sm" data-mv="${esc(v.id)}|-1" ${i ? '' : 'disabled'} aria-label="Subir">↑</button><button class="btn btn-sm" data-mv="${esc(v.id)}|1" ${i < list.length - 1 ? '' : 'disabled'} aria-label="Bajar">↓</button>
          <button class="btn btn-sm" data-tg="${esc(v.id)}">${v.activa === false ? '👁 Mostrar' : '🙈 Ocultar'}</button><button class="btn btn-sm btn-primary" data-ev="${esc(v.id)}">✎ Editar</button></div></div>`; }).join('')}</div>`;
  }
  function listMezclas(body) {
    const P = PV(), { esc } = P, d = data();
    body.innerHTML = `<p class="muted">Ideas para vender juntos varios productos (tragos, combinaciones). El vendedor las agrega al pedido con un toque. Si falta un ingrediente en el catálogo, la mezcla no se muestra.</p>
      <div class="mk-list">${d.mezclas.map((x) => { const miss = (x.items || []).filter((it) => !itemProduct(it)); const v = d.vitrinas.find((y) => y.id === x.vitrina);
        return `<div class="mk-card"><div class="mk-sw">${esc(x.icono || '🍹')}</div><div class="grow"><b>${esc(x.nombre)}</b> <span class="muted">en ${esc(v ? v.nombre : '—')}</span><div class="muted">${(x.items || []).map((it) => { const p = itemProduct(it); return p ? esc(p.name + ' ' + (p.presentation || '')) : `<span class="warn-txt">«${esc(it.q || '?')}» no está en el catálogo</span>`; }).join(' + ')}</div>${miss.length ? '<small class="warn-txt">No se muestra hasta que estén todos los ingredientes</small>' : ''}</div>
          <button class="btn btn-sm btn-primary" data-ex="${esc(x.id)}">✎ Editar</button></div>`; }).join('') || '<p class="muted">Sin mezclas.</p>'}</div>`;
  }
  /** Buscador de productos para agregar a una vitrina o mezcla. */
  function picker(el, onPick) {
    const P = PV(), { esc } = P, inp = el.querySelector('input'), out = el.querySelector('.mk-res');
    inp.oninput = () => {
      const t = P.norm(inp.value).split(' ').filter(Boolean);
      out.innerHTML = t.length ? active().filter((p) => t.every((w) => (P.norm(p.code + ' ' + (p.unitCode || '')) + ' ' + hayOf(p)).includes(w))).slice(0, 8)
        .map((p) => `<button type="button" class="sug-item" data-pk="${esc(p.id)}"><b>${esc(p.name)}</b> <small>${esc(p.presentation || '')} · ${esc(p.category)} · ${esc(p.code)}</small></button>`).join('') : '';
    };
    out.onclick = (e) => { const b = e.target.closest('[data-pk]'); if (b) { onPick(b.dataset.pk); inp.value = ''; out.innerHTML = ''; } };
  }
  function editVitrina(v0, done) {
    const P = PV(), { esc, toast } = P, isNew = !v0;
    const v = { ...(v0 || { id: uid(), nombre: '', frase: '', icono: '🛍', hue: 205, buscar: [], cats: [], incluir: [], excluir: [], orden: 'ventas', sello: '', activa: true }) };
    v.incluir = (v.incluir || []).slice(); v.excluir = (v.excluir || []).slice(); v.cats = (v.cats || []).slice();
    const cats = [...new Set((P.rubros ? P.rubros() : []).concat(active().map((p) => p.category)).filter(Boolean))];
    const sh = P.openSheet(`<div class="row"><h2 class="grow">${isNew ? '＋ Nueva vitrina' : '✎ ' + esc(v.nombre)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="row wrap" style="gap:8px"><label class="field" style="max-width:90px"><span>Ícono</span><input id="veI" class="input" maxlength="4" value="${esc(v.icono || '')}"></label>
        <label class="field grow"><span>Nombre de la vitrina</span><input id="veN" class="input" maxlength="70" value="${esc(v.nombre)}" placeholder="Ej.: Arma la lonchera de los más pequeños"></label></div>
      <label class="field"><span>Frase de venta</span><input id="veF" class="input" maxlength="140" value="${esc(v.frase || '')}" placeholder="Ej.: Todos los sabores para el recreo"></label>
      <div class="field"><span>Color</span><div class="mk-pal">${PALETTE.map((h) => `<button type="button" class="mk-dot ${+v.hue === h ? 'on' : ''}" data-hue="${h}" style="--h:${h}" aria-label="Color ${h}"></button>`).join('')}</div></div>
      <div class="row wrap" style="gap:8px"><label class="field grow"><span>Sello para sus 3 más pedidos</span><input id="veS" class="input" maxlength="40" value="${esc(v.sello || '')}" placeholder="Ej.: 💛 Lo más pedido por las mamás"></label>
        <label class="field"><span>Orden</span><select id="veO" class="select">${[['ventas', 'Más vendidos primero'], ['peso', 'Por peso / tamaño (120 g, 340 g, 500 g…)'], ['nombre', 'Por nombre'], ['manual', 'A mano (los agregados, en su orden)']].map(([k, l]) => `<option value="${k}" ${v.orden === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Qué productos entran: palabras (marca, tipo, sabor…), separadas por coma</span><input id="veB" class="input" value="${esc((v.buscar || []).join(', '))}" placeholder="Ej.: salsa, quiero"></label>
      <div class="field"><span>…o categorías completas</span><div class="mk-cats">${cats.map((c) => `<label class="chip-check"><input type="checkbox" data-cat="${esc(c)}" ${v.cats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div></div>
      <div class="field mk-pick" id="veAdd"><span>Agregar un producto a mano</span><input class="input" placeholder="Buscar producto…" autocomplete="off"><div class="mk-res"></div></div>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="veA" ${v.adultos ? 'checked' : ''}> 🔞 Bebidas alcohólicas: «Solo mayores de 18 · Consumo responsable»</label>
      <div class="section-title">Vista previa · <span id="veCnt"></span></div><div id="veList" class="mk-prev"></div>
      <div class="actions">${isNew ? '' : '<button class="btn btn-danger" id="veDel">Eliminar</button>'}<span class="grow"></span><button class="btn btn-primary" id="veOk">Guardar vitrina</button></div>`, { wide: true });
    const q = (s) => sh.el.querySelector(s);
    const read = () => { v.icono = q('#veI').value.trim(); v.nombre = q('#veN').value.trim(); v.frase = q('#veF').value.trim(); v.sello = q('#veS').value.trim(); v.orden = q('#veO').value; v.adultos = q('#veA').checked;
      v.buscar = q('#veB').value.split(',').map((w) => w.trim()).filter(Boolean); v.cats = [...sh.el.querySelectorAll('[data-cat]:checked')].map((x) => x.dataset.cat); };
    const prev = () => {
      read(); const ps = productsOf(v);
      q('#veCnt').textContent = `${ps.length} productos`;
      q('#veList').innerHTML = ps.slice(0, 60).map((p) => { const s = sizeOf(p); return `<div class="mk-pi">${P.hasPhoto(p) ? `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">` : `<span>${P.rubroIcon(p.category)}</span>`}<small><b>${esc(p.name)}</b> ${esc(p.presentation || '')}${v.orden === 'peso' && s ? ` · ${esc(s.label)}` : ''}</small>
        <button type="button" class="btn btn-sm" data-out="${esc(p.id)}" title="Quitar de esta vitrina">✕</button></div>`; }).join('') + (ps.length > 60 ? `<p class="muted">… y ${ps.length - 60} más</p>` : '')
        + (v.excluir.length ? `<p class="muted" style="grid-column:1/-1">Quitados a mano: ${v.excluir.map((id) => { const p = P.productById(id); return `<button type="button" class="chip" data-back="${esc(id)}">↩ ${esc(p ? p.name + ' ' + (p.presentation || '') : id)}</button>`; }).join(' ')}</p>` : '');
    };
    sh.el.addEventListener('input', (e) => { if (e.target.closest('#veAdd')) return; prev(); });
    sh.el.addEventListener('change', prev);
    sh.el.addEventListener('click', (e) => {
      const h = e.target.closest('[data-hue]'); if (h) { v.hue = +h.dataset.hue; sh.el.querySelectorAll('[data-hue]').forEach((x) => x.classList.toggle('on', x === h)); return; }
      const o = e.target.closest('[data-out]'); if (o) { v.incluir = v.incluir.filter((x) => x !== o.dataset.out); if (!v.excluir.includes(o.dataset.out)) v.excluir.push(o.dataset.out); prev(); return; }
      const b = e.target.closest('[data-back]'); if (b) { v.excluir = v.excluir.filter((x) => x !== b.dataset.back); prev(); }
    });
    picker(q('#veAdd'), (pid) => { v.excluir = v.excluir.filter((x) => x !== pid); if (!v.incluir.includes(pid)) v.incluir.push(pid); prev(); });
    prev();
    q('#veOk').onclick = async () => {
      read();
      if (!v.nombre) { toast('Ponle un nombre a la vitrina', 'err'); return; }
      const list = data().vitrinas.slice(), i = list.findIndex((x) => x.id === v.id);
      if (i >= 0) list[i] = v; else list.push(v);
      await save({ vitrinas: list }, `${isNew ? 'Creó' : 'Editó'} la vitrina «${v.nombre}»`);
      sh.close(); toast('Vitrina guardada: les llega a los vendedores', 'ok'); done();
    };
    const del = q('#veDel');
    if (del) del.onclick = async () => { if (!confirm(`¿Eliminar la vitrina «${v.nombre}»? Los productos no se borran.`)) return; await save({ vitrinas: data().vitrinas.filter((x) => x.id !== v.id) }, `Eliminó la vitrina «${v.nombre}»`); sh.close(); done(); };
  }
  function editMezcla(x0, done) {
    const P = PV(), { esc, toast } = P, isNew = !x0, d = data();
    const x = { ...(x0 || { id: uid(), nombre: '', frase: '', icono: '🍹', vitrina: (d.vitrinas[0] || {}).id || '', items: [], pasos: '' }) };
    x.items = (x.items || []).map((it) => ({ ...it }));
    const sh = P.openSheet(`<div class="row"><h2 class="grow">${isNew ? '＋ Nueva mezcla' : '✎ ' + esc(x.nombre)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="row wrap" style="gap:8px"><label class="field" style="max-width:90px"><span>Ícono</span><input id="xeI" class="input" maxlength="4" value="${esc(x.icono || '')}"></label>
        <label class="field grow"><span>Nombre</span><input id="xeN" class="input" maxlength="60" value="${esc(x.nombre)}" placeholder="Ej.: Tinto de verano"></label></div>
      <label class="field"><span>Frase</span><input id="xeF" class="input" maxlength="120" value="${esc(x.frase || '')}"></label>
      <label class="field"><span>Se muestra en la vitrina</span><select id="xeV" class="select">${d.vitrinas.map((v) => `<option value="${esc(v.id)}" ${v.id === x.vitrina ? 'selected' : ''}>${esc(v.icono || '')} ${esc(v.nombre)}</option>`).join('')}</select></label>
      <div class="section-title">Ingredientes (lo que se agrega al pedido)</div><div id="xeItems"></div>
      <div class="field mk-pick" id="xeAdd"><span>Agregar ingrediente</span><input class="input" placeholder="Buscar producto…" autocomplete="off"><div class="mk-res"></div></div>
      <label class="field"><span>Cómo se prepara</span><textarea id="xeP" class="input" rows="3" maxlength="400">${esc(x.pasos || '')}</textarea></label>
      <div class="actions">${isNew ? '' : '<button class="btn btn-danger" id="xeDel">Eliminar</button>'}<span class="grow"></span><button class="btn btn-primary" id="xeOk">Guardar mezcla</button></div>`);
    const q = (s) => sh.el.querySelector(s);
    const draw = () => {
      q('#xeItems').innerHTML = x.items.map((it, i) => { const p = itemProduct(it); return `<div class="row" style="gap:8px;align-items:flex-end;margin-bottom:6px"><span class="grow">${p ? `<b>${esc(p.name)}</b> ${esc(p.presentation || '')}` : `<span class="warn-txt">«${esc(it.q || '?')}» no está en el catálogo: elige el producto abajo</span>`}</span>
        <label class="field" style="max-width:80px"><span>Cajas</span><input class="input" inputmode="numeric" data-ic="${i}" value="${+it.cajas || ''}"></label>
        <label class="field" style="max-width:80px"><span>Unid.</span><input class="input" inputmode="numeric" data-iu="${i}" value="${+it.unidades || ''}"></label>
        <button type="button" class="btn btn-sm btn-danger" data-irm="${i}">✕</button></div>`; }).join('') || '<p class="muted">Sin ingredientes.</p>';
    };
    draw();
    sh.el.addEventListener('change', (e) => {
      const c = e.target.closest('[data-ic]'), u = e.target.closest('[data-iu]');
      if (c) x.items[+c.dataset.ic].cajas = Math.max(0, Math.round(+c.value || 0));
      if (u) x.items[+u.dataset.iu].unidades = Math.max(0, Math.round(+u.value || 0));
    });
    sh.el.addEventListener('click', (e) => { const r = e.target.closest('[data-irm]'); if (r) { x.items.splice(+r.dataset.irm, 1); draw(); } });
    picker(q('#xeAdd'), (pid) => { const p = P.productById(pid); x.items.push({ pid, q: P.norm(p ? p.name : ''), cajas: p && p.sellBy === 'unidad' ? 0 : 1, unidades: p && p.sellBy === 'unidad' ? 1 : 0 }); draw(); });
    q('#xeOk').onclick = async () => {
      Object.assign(x, { icono: q('#xeI').value.trim(), nombre: q('#xeN').value.trim(), frase: q('#xeF').value.trim(), vitrina: q('#xeV').value, pasos: q('#xeP').value.trim() });
      if (!x.nombre) { toast('Ponle un nombre a la mezcla', 'err'); return; }
      if (!x.items.some((it) => (+it.cajas || +it.unidades) && itemProduct(it))) { toast('Agrega al menos un ingrediente con cantidad', 'err'); return; }
      const list = data().mezclas.slice(), i = list.findIndex((y) => y.id === x.id);
      if (i >= 0) list[i] = x; else list.push(x);
      await save({ mezclas: list }, `${isNew ? 'Creó' : 'Editó'} la mezcla «${x.nombre}»`);
      sh.close(); toast('Mezcla guardada', 'ok'); done();
    };
    const del = q('#xeDel');
    if (del) del.onclick = async () => { if (!confirm(`¿Eliminar la mezcla «${x.nombre}»?`)) return; await save({ mezclas: data().mezclas.filter((y) => y.id !== x.id) }, `Eliminó la mezcla «${x.nombre}»`); sh.close(); done(); };
  }

  global.Mkt = { data, productsOf, sizeOf, itemProduct, renderSeller, onSellerClick, render, DEF_VITRINAS, DEF_MEZCLAS };
})(window);
