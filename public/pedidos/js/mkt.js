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
    { id: 'v_salsas', nombre: 'Kiero, la sazón del hogar', frase: 'Comida casera en minutos, para cuando no hay tiempo: napolitana, rabiata, boloñesa, guiso… en todos los tamaños', icono: '🍝', hue: 14, buscar: ['salsa', 'kiero'], orden: 'peso', sello: '👩‍🍳 La que más se lleva', activa: true },
    { id: 'v_maltas', nombre: 'Nuestra morena, el sabor de aquí', frase: 'Refrescante y bien nuestra: nada que envidiarle a nadie', icono: '🟤', hue: 28, buscar: ['malta'], orden: 'ventas', sello: '🇻🇪 La preferida', activa: true },
    { id: 'v_finde', nombre: 'Para tus fines de semana', frase: 'Cervezas, sangrías y licores bien fríos para compartir', icono: '🍻', hue: 205, buscar: ['cerveza', 'toxica', 'sangria', 'ron', 'anis', 'whisky', 'licor', 'vino'], orden: 'ventas', sello: '🔥 Se va rápido', adultos: true, activa: true },
    { id: 'v_evento', nombre: 'Todo para tu evento o celebración', frase: 'Cotillón, piñata y mesa de dulces: chowy, surtidos y galletas para todos', icono: '🎉', hue: 300, buscar: ['chowy', 'surtido', 'galleta', 'wabi', 'cotufi', 'charmy', 'mini maria', 'punto rojo'], orden: 'ventas', sello: '🎈 Infaltable en la fiesta', activa: true },
  ];
  const DEF_MEZCLAS = [
    { id: 'x_tinto', nombre: 'Tinto de verano', frase: 'El trago del verano, con lo que ya vendes', icono: '🍷', vitrina: 'v_finde', items: [{ q: 'toxica tinta', cajas: 1, unidades: 0 }, { q: 'chinotto', cajas: 1, unidades: 0 }], pasos: 'Mitad sangría Tóxica tinta y mitad Chinotto bien frío, con mucho hielo y rodajas de limón o naranja.' },
    { id: 'x_michelada', nombre: 'Michelada', frase: 'La cerveza con su toque', icono: '🍺', vitrina: 'v_finde', items: [{ q: 'cerveza azul', cajas: 1, unidades: 0 }], pasos: 'Escarcha el borde del vaso con sal y limón, agrega jugo de limón, unas gotas de salsa picante y cerveza bien fría.' },
    { id: 'x_anis', nombre: 'Anís refrescante', frase: 'Suave y fresco para la tarde', icono: '🍸', vitrina: 'v_finde', items: [{ q: 'anis', cajas: 1, unidades: 0 }, { q: 'chinotto', cajas: 1, unidades: 0 }], pasos: 'Una medida de anís, completa con Chinotto frío y hielo. Decora con hojas de menta o limón.' },
  ];

  /* ---------------- Campaña navideña (se carga desde «🎄 Campaña»; cada vitrina sale sola en sus fechas) ---------------- */
  const NAV = {
    campana: { activa: true, tema: 'navidad', titulo: 'Esta Navidad, el sabor se hace en familia', frase: 'De la Chinita al Año Nuevo: gaitas, hallacas y brindis con los tuyos', meta: '2026-12-24', metaLbl: 'Nochebuena', desde: '2026-11-10', hasta: '2027-01-06' },
    vitrinas: [
      { id: 'n_gaita', nombre: '¡Arrancó la gaita!', frase: 'Feria de la Chinita: las gaitas suenan más sabrosas con todo bien frío', icono: '🥁', hue: 42, buscar: ['refresco', 'coca', 'zulia', 'malta', 'cerveza', 'toxica'], orden: 'ventas', sello: '🎶 El de la feria', activa: true, desde: '2026-11-10', hasta: '2026-11-24' },
      { id: 'n_hallaca', nombre: 'La hallaquiada se hace en familia', frase: 'Mientras se amasa, se amarra y se echa el cuento: Coca-Cola, Zulia y Tóxica para toda la familia', icono: '🫔', hue: 150, buscar: ['coca', 'zulia', 'refresco', 'toxica', 'malta', 'cerveza', 'guiso'], orden: 'ventas', sello: '🎄 No falta en la hallaquiada', activa: true, desde: '2026-11-20', hasta: '2026-12-23' },
      { id: 'n_patinata', nombre: 'Patinatas y aguinaldos', frase: 'Para los niños en la madrugada de diciembre: néctares, galletas y chucherías', icono: '🛼', hue: 200, buscar: ['nectar', 'jugo', 'galleta', 'chowy', 'surtido', 'cotufi', 'wabi'], orden: 'ventas', sello: '⭐ Favorito de los niños', activa: true, desde: '2026-12-10', hasta: '2026-12-24' },
      { id: 'n_nochebuena', nombre: 'Nochebuena: la mesa y el brindis', frase: 'Pan de jamón, hallacas y un buen brindis: que no falte nada el 24', icono: '🍷', hue: 356, buscar: ['ron', 'anis', 'whisky', 'vino', 'sangria', 'toxica', 'coca', 'refresco', 'cerveza'], orden: 'ventas', sello: '🎁 Infaltable el 24', adultos: true, activa: true, desde: '2026-12-15', hasta: '2026-12-25' },
      { id: 'n_anonuevo', nombre: '¡Feliz Año! El brindis de las 12', frase: 'Las 12 uvas, el abrazo y el brindis: celebra el año nuevo con los tuyos', icono: '🥂', hue: 45, buscar: ['sangria', 'toxica', 'anis', 'ron', 'whisky', 'vino', 'cerveza', 'refresco', 'coca'], orden: 'ventas', sello: '✨ Para el brindis', adultos: true, activa: true, desde: '2026-12-26', hasta: '2027-01-06' },
    ],
    mezclas: [
      { id: 'nx_sangria', nombre: 'Sangría navideña', frase: 'Roja como la Navidad', icono: '🍷', vitrina: 'n_nochebuena', items: [{ q: 'toxica tinta', cajas: 1, unidades: 0 }, { q: 'chinotto', cajas: 1, unidades: 0 }], pasos: 'Tóxica tinta y Chinotto bien frío, con trozos de manzana, naranja y canela. Se sirve con hielo.' },
      { id: 'nx_cuba', nombre: 'Cuba libre del brindis', frase: 'El clásico de las 12', icono: '🥃', vitrina: 'n_anonuevo', items: [{ q: 'ron', cajas: 1, unidades: 0 }, { q: 'coca cola', cajas: 1, unidades: 0 }], pasos: 'Una medida de ron, Coca-Cola bien fría, hielo y una rodaja de limón.' },
    ],
    combos: [
      { id: 'c_hallaca', nombre: 'Combo Hallaquiada en familia', frase: 'Todo lo de tomar para la jornada de hallacas', icono: '🫔', vitrina: 'n_hallaca', items: [{ q: 'coca cola', cajas: 2, unidades: 0 }, { q: 'zulia', cajas: 1, unidades: 0 }, { q: 'toxica', cajas: 1, unidades: 0 }], incluye: '', desde: '2026-11-20', hasta: '2026-12-23' },
      { id: 'c_gaitero', nombre: 'Combo Gaitero', frase: 'Para la feria y las parrandas', icono: '🥁', vitrina: 'n_gaita', items: [{ q: 'cerveza', cajas: 2, unidades: 0 }, { q: 'malta', cajas: 1, unidades: 0 }], incluye: '', desde: '2026-11-10', hasta: '2026-11-24' },
      { id: 'c_patinata', nombre: 'Combo Patinata', frase: 'Para que los niños salgan a patinar con todo', icono: '🛼', vitrina: 'n_patinata', items: [{ q: 'nectar', cajas: 2, unidades: 0 }, { q: 'galleta', cajas: 1, unidades: 0 }, { q: 'chowy', cajas: 1, unidades: 0 }], incluye: '', desde: '2026-12-10', hasta: '2026-12-24' },
      { id: 'c_nochebuena', nombre: 'Combo Nochebuena', frase: 'La mesa y el brindis del 24', icono: '🍷', vitrina: 'n_nochebuena', items: [{ q: 'toxica', cajas: 1, unidades: 0 }, { q: 'coca cola', cajas: 1, unidades: 0 }, { q: 'anis', cajas: 1, unidades: 0 }], incluye: '', desde: '2026-12-15', hasta: '2026-12-25' },
      { id: 'c_anonuevo', nombre: 'Combo Brindis de Año Nuevo', frase: 'Para recibir el año como se debe', icono: '🥂', vitrina: 'n_anonuevo', items: [{ q: 'sangria', cajas: 2, unidades: 0 }, { q: 'refresco', cajas: 1, unidades: 0 }], incluye: '', desde: '2026-12-26', hasta: '2027-01-06' },
    ],
  };

  /* ---------------- Datos ---------------- */
  /**
   * Lanzamiento: hasta que la Oficina o Gerencia lancen la vitrina, los vendedores no la ven.
   * Gerencia sí la ve al tomar pedidos (para probarla en la tablet antes del lanzamiento oficial).
   */
  const lanzada = () => { const m = PV().S.mkt; return !!(m && m.lanzamiento && m.lanzamiento.lanzada); };
  const enabled = () => lanzada() || !!(PV().gerMode && PV().gerMode());
  function data() {
    const m = PV().S.mkt;
    return { vitrinas: m && Array.isArray(m.vitrinas) ? m.vitrinas : DEF_VITRINAS, mezclas: m && Array.isArray(m.mezclas) ? m.mezclas : DEF_MEZCLAS,
      combos: m && Array.isArray(m.combos) ? m.combos : [], campana: (m && m.campana) || null, lanzamiento: (m && m.lanzamiento) || null, saved: !!m };
  }
  async function save(patch, what) {
    const P = PV(), d = data();
    await P.saveDocs('config', { ...(P.S.mkt || {}), id: 'mkt', vitrinas: d.vitrinas, mezclas: d.mezclas, combos: d.combos, campana: d.campana, lanzamiento: d.lanzamiento, ...patch });
    if (what) P.logEvent('marketing', what);
    P.runSync(false);
  }
  const hayOf = (p) => PV().norm([p.category, p.subgroup, p.brand, p.name, p.presentation].join(' '));
  const active = () => PV().S.products.filter((p) => p.active !== false && !p.deleted);
  /** Visible hoy: activa y dentro de sus fechas (vitrinas de temporada: Navidad, Carnaval, Regreso a clases…). */
  const enFecha = (v) => { const t = PV().today(); return (!v.desde || t >= v.desde) && (!v.hasta || t <= v.hasta); };
  const visible = (v) => v.activa !== false && enFecha(v);

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
    return hit.filter((p) => !p.agotado).concat(hit.filter((p) => p.agotado)); // los agotados, al final
  }
  /** Producto de un ingrediente de mezcla: el elegido, o el primero que coincide con sus palabras. */
  function itemProduct(it) {
    const P = PV();
    if (it.pid) { const p = P.productById(it.pid); if (p && p.active !== false && !p.deleted) return p; }
    const t = P.norm(it.q || '').split(' ').filter(Boolean); if (!t.length) return null;
    return active().find((p) => t.every((w) => hayOf(p).includes(w))) || null;
  }

  /* ---------------- Combos (espejo de src/lib/money.ts: el servidor recalcula y verifica lo mismo) ---------------- */
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  /** Huella de lo que Gerencia autoriza: si cambian productos, cantidades, regalos o precio, vuelve a autorización. */
  function comboV(c) {
    const str = JSON.stringify({ items: (c.items || []).map((it) => ({ pid: String(it.pid || ''), cajas: +it.cajas || 0, unidades: +it.unidades || 0, regalo: !!it.regalo })), precio: r2(+c.precio || 0) });
    let h = 5381; for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  const comboOk = (c) => !!(c && c.aprobado && c.aprobado.v === comboV(c));
  /** Valor normal del combo (S), su descuento (D) y el descuento de cada producto (prices: precios de la línea o del catálogo). */
  function comboAlloc(c, prices) {
    const parts = [];
    for (const it of c.items || []) {
      const p = prices(String(it.pid || '')); if (!p) return null;
      if ((+it.cajas || 0) > 0) parts.push({ pid: String(it.pid), um: 'cj', q: +it.cajas, v: r2(+it.cajas * (+p.boxPrice || 0)) });
      if ((+it.unidades || 0) > 0) parts.push({ pid: String(it.pid), um: 'un', q: +it.unidades, v: r2(+it.unidades * (+p.unitPrice || 0)) });
    }
    const S = r2(parts.reduce((a, x) => a + x.v, 0)), D = r2(S - (+c.precio || 0));
    if (!parts.length || S <= 0 || D < 0) return null;
    const out = {}; let used = 0;
    parts.forEach((x, i) => {
      const d = i === parts.length - 1 ? r2(D - used) : r2((D * x.v) / S); used = r2(used + d);
      const o = (out[x.pid] = out[x.pid] || { cj: 0, un: 0, dcj: 0, dun: 0 });
      if (x.um === 'cj') { o.cj += x.q; o.dcj += d; } else { o.un += x.q; o.dun += d; }
    });
    return { S, D, out };
  }
  const catPrices = (pid) => PV().productById(pid);
  /** Combo que el vendedor puede ofrecer hoy: autorizado por Gerencia, dentro de sus fechas y con todos sus productos. */
  const comboLive = (c) => comboOk(c) && enFecha(c) && (c.items || []).every((it) => { const p = PV().productById(it.pid); return p && p.active !== false && !p.deleted && !p.agotado; });
  /** Reparte el descuento de los combos del pedido en sus líneas (line.cmb) con los precios de cada línea. */
  function applyCmb(o) {
    Object.values(o.lines || {}).forEach((l) => { delete l.cmb; });
    const all = data().combos, tot = {};
    Object.entries(o.combos || {}).forEach(([id, x]) => {
      const c = all.find((y) => y.id === id), n = +x.n || 0;
      const al = c && n > 0 ? comboAlloc(c, (pid) => (o.lines || {})[pid] || null) : null; if (!al) return;
      Object.entries(al.out).forEach(([pid, a]) => { const t = (tot[pid] = tot[pid] || { cj: 0, un: 0, dcj: 0, dun: 0 }); t.cj += a.cj * n; t.un += a.un * n; t.dcj += a.dcj * n; t.dun += a.dun * n; });
      x.ahorro = r2(al.D * n);
    });
    Object.entries(tot).forEach(([pid, t]) => { const l = (o.lines || {})[pid]; if (l) l.cmb = { cj: t.cj, un: t.un, dcj: t.cj ? t.dcj / t.cj : 0, dun: t.un ? t.dun / t.un : 0 }; });
  }
  /** Agrega (delta +1) o quita (−1) un combo del pedido activo: sus productos, regalos y descuento, en un solo guardado. */
  async function addCombo(id, delta) {
    const P = PV(), o = P.activeOrder(), c = data().combos.find((y) => y.id === id);
    if (!o) { await P.setQty('', 'cajas', 0); return; } // pide elegir el cliente
    if (!c || (delta > 0 && !comboLive(c))) { P.toast('Este combo ya no está disponible', 'err'); return; }
    const cur = (o.combos || {})[id], n = Math.max(0, (cur ? +cur.n || 0 : 0) + delta); if (delta < 0 && !cur) return;
    for (const it of c.items || []) {
      const l = o.lines[it.pid] || {};
      if (+it.cajas) { if (!P.applyQty(o, it.pid, 'cajas', Math.max(0, (+l.cajas || 0) + delta * +it.cajas))) return; }
      const l2 = o.lines[it.pid] || {};
      if (+it.unidades) { if (!P.applyQty(o, it.pid, 'unidades', Math.max(0, (+l2.unidades || 0) + delta * +it.unidades))) return; }
    }
    if (delta > 0) (c.items || []).forEach((it) => P.markVt(o, it.pid));
    o.combos = { ...(o.combos || {}) };
    if (n) o.combos[id] = { n, nombre: c.nombre, precio: r2(+c.precio || 0), v: comboV(c) }; else delete o.combos[id];
    if (!Object.keys(o.combos).length) delete o.combos;
    applyCmb(o);
    await P.saveOrder(o);
    P.toast(delta > 0 ? `🎁 ${c.nombre} agregado al pedido` : `${c.nombre}: quitado`, 'ok');
    if (navigator.vibrate) navigator.vibrate(15);
    P.render();
  }
  function comboCard(c, o) {
    const P = PV(), { esc, usd } = P, al = comboAlloc(c, catPrices); if (!al) return '';
    const n = o && o.combos && o.combos[c.id] ? +o.combos[c.id].n || 0 : 0;
    const its = (c.items || []).map((it) => ({ it, p: P.productById(it.pid) }));
    return `<article class="vt-combo ${n ? 'on' : ''}"><div class="vt-mix-head"><span class="vt-ico" aria-hidden="true">${esc(c.icono || '🎁')}</span><div><h3>${esc(c.nombre)}</h3>${c.frase ? `<p>${esc(c.frase)}</p>` : ''}</div>${n ? `<em class="vt-cnt">×${n}</em>` : ''}</div>
      <div class="vt-mix-items">${its.map(({ it, p }) => `<div class="vt-ing">${P.hasPhoto(p) ? `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">` : `<span>${P.rubroIcon(p.category)}</span>`}<small>${it.regalo ? '<b class="vt-gift">🎁 REGALO</b><br>' : ''}${esc(p.name)} ${esc(p.presentation || '')}<br><b>${[+it.cajas ? it.cajas + ' cj' : '', +it.unidades ? it.unidades + ' un' : ''].filter(Boolean).join(' + ')}</b></small></div>`).join('<span class="vt-plus">+</span>')}</div>
      <div class="vt-price">${al.D > 0 ? `<span class="vt-was">Por separado ${usd(al.S)}</span>` : ''}<b>Combo ${usd(+c.precio)}</b>${al.D > 0 ? `<span class="vt-save">Ahorras ${usd(al.D)}</span>` : ''}</div>
      ${c.incluye ? `<div class="vt-inc">✨ ${esc(c.incluye)}</div>` : ''}${c.hasta ? `<small class="muted">Válido hasta el ${esc(P.fmtDate(c.hasta))}</small>` : ''}
      <div class="row" style="gap:8px">${n ? `<button type="button" class="btn" data-combo="${esc(c.id)}" data-cd="-1" aria-label="Quitar un combo">−</button>` : ''}<button type="button" class="btn btn-primary grow" data-combo="${esc(c.id)}" data-cd="1">➕ Agregar combo</button></div></article>`;
  }
  /** Encabezado de la campaña: título, frase y cuenta regresiva (p. ej. «Faltan 57 días para Nochebuena»). */
  function campanaHTML() {
    const P = PV(), { esc } = P, c = data().campana; if (!c || !c.activa || !enFecha(c)) return '';
    const dias = c.meta ? Math.round((Date.parse(c.meta + 'T12:00:00') - Date.parse(P.today() + 'T12:00:00')) / 86400000) : null;
    return `<div class="vt-camp vt-tema-${esc(c.tema || 'navidad')}"><div class="vt-lights" aria-hidden="true">${'<i></i>'.repeat(18)}</div>
      <h2>${esc(c.titulo || '')}</h2>${c.frase ? `<p>${esc(c.frase)}</p>` : ''}
      ${dias !== null && dias > 0 ? `<div class="vt-count"><b>${dias}</b><span>día${dias === 1 ? '' : 's'} para ${esc(c.metaLbl || '')}</span></div>` : dias === 0 ? `<div class="vt-count"><b>¡Hoy!</b><span>${esc(c.metaLbl || '')}</span></div>` : ''}</div>`;
  }

  /* ---------------- Vendedor: la vitrina ---------------- */
  /**
   * Banner de una vitrina. v.banner (todo opcional): fondo 'tono' (color de la vitrina) | 'colores' (c1 → c2, ángulo) |
   * 'imagen' (foto propia, con oscurecer 0–80 %), color de letras, alinear izq/centro/der, vertical arriba/centro/abajo,
   * tamaño del título y si muestra el collage de productos.
   */
  const BN_DEF = { fondo: 'tono', c1: '#c62828', c2: '#4a0d0d', angulo: 135, oscurecer: 35, texto: '#ffffff', alinear: 'izq', vertical: 'centro', tam: 'normal', collage: true };
  function bannerStyle(v) {
    const b = { ...BN_DEF, ...(v.banner || {}) }, img = b.fondo === 'imagen' && b.img && PV().S.banners && PV().S.banners[b.img];
    let bg = '';
    if (b.fondo === 'colores') bg = `background:linear-gradient(${+b.angulo || 135}deg, ${b.c1}, ${b.c2});`;
    else if (img && img.image) bg = `background:linear-gradient(rgba(0,0,0,${Math.min(0.8, Math.max(0, (+b.oscurecer || 0) / 100))}), rgba(0,0,0,${Math.min(0.8, Math.max(0, (+b.oscurecer || 0) / 100))})), url("${img.image}") center/cover;`;
    return { b, css: `${bg}color:${/^#[0-9a-f]{6}$/i.test(b.texto) ? b.texto : '#fff'};` };
  }
  function banner(v, ps) {
    const P = PV(), { esc } = P, { b, css } = bannerStyle(v), pics = b.collage === false ? [] : ps.filter((p) => P.hasPhoto(p)).slice(0, 3);
    return `<header class="vt-banner al-${esc(b.alinear)} va-${esc(b.vertical)} tam-${esc(b.tam)} ${b.fondo === 'imagen' ? 'con-img' : ''}" style="${esc(css)}"><div class="vt-txt"><span class="vt-ico" aria-hidden="true">${esc(v.icono || '🛍')}</span><h2>${esc(v.nombre)}</h2>${v.frase ? `<p>${esc(v.frase)}</p>` : ''}
      ${v.adultos ? '<span class="vt-18">🔞 Solo mayores de 18 · Consumo responsable</span>' : ''}</div>
      ${pics.length ? `<div class="vt-collage">${pics.map((p) => `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">`).join('')}</div>` : ''}</header>`;
  }
  /** Foto de fondo del banner: JPEG liviano (máx. 1400 px y ~180 KB) para que viaje por la sincronización. */
  function bannerImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file), img = new Image();
      img.onload = () => {
        const k = Math.min(1, 1400 / Math.max(img.width, img.height)), c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        const g = c.getContext('2d'); g.drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        let q = 0.78, out = c.toDataURL('image/jpeg', q);
        while (out.length > 240000 && q > 0.35) { q -= 0.08; out = c.toDataURL('image/jpeg', q); }
        resolve(out.length > 240000 ? null : out);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Imagen no válida')); };
      img.src = url;
    });
  }
  function mezclaHTML(x) {
    const P = PV(), { esc, usd } = P, its = (x.items || []).map((it) => ({ it, p: itemProduct(it) }));
    if (!its.length || its.some((y) => !y.p || y.p.agotado)) return ''; // si falta (o está agotado) un ingrediente, no se muestra
    const monto = its.reduce((a, { it, p }) => a + (+it.cajas || 0) * (+p.boxPrice || 0) + (+it.unidades || 0) * (+p.unitPrice || 0), 0);
    return `<article class="vt-mix"><div class="vt-mix-head"><span class="vt-ico" aria-hidden="true">${esc(x.icono || '🍹')}</span><div><h3>${esc(x.nombre)}</h3>${x.frase ? `<p>${esc(x.frase)}</p>` : ''}</div></div>
      <div class="vt-mix-items">${its.map(({ it, p }) => `<div class="vt-ing">${P.hasPhoto(p) ? `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">` : `<span>${P.rubroIcon(p.category)}</span>`}<small>${esc(p.name)} ${esc(p.presentation || '')}<br><b>${[+it.cajas ? it.cajas + ' cj' : '', +it.unidades ? it.unidades + ' un' : ''].filter(Boolean).join(' + ')}</b></small></div>`).join('<span class="vt-plus">+</span>')}</div>
      ${x.pasos ? `<p class="vt-pasos">${esc(x.pasos)}</p>` : ''}
      <button type="button" class="btn btn-primary" data-mix="${esc(x.id)}">➕ Agregar los ingredientes · ${usd(monto)}</button></article>`;
  }
  /** 🔁 Lo de siempre: lo que este cliente más compra (sus pedidos anteriores) y aún no lleva en este pedido. */
  function siempreOf(o) {
    const P = PV(); if (!o || !o.clientId) return [];
    const from = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10), n = new Map();
    P.S.orders.forEach((x) => {
      if (x.deleted || x.id === o.id || x.clientId !== o.clientId || String(x.routeDate || '') < from) return;
      Object.entries(x.lines || {}).forEach(([pid, l]) => { const c = n.get(pid) || { k: 0, cajas: 0, unidades: 0, at: '' }; c.k++; if (String(x.routeDate) >= c.at) { c.at = String(x.routeDate); c.cajas = +l.cajas || 0; c.unidades = +l.unidades || 0; } n.set(pid, c); });
    });
    return [...n.entries()].map(([pid, c]) => ({ p: P.productById(pid), ...c })).filter((x) => x.p && x.p.active !== false && !x.p.deleted && !x.p.agotado && !(o.lines || {})[x.p.id])
      .sort((a, b2) => b2.k - a.k || String(a.p.name).localeCompare(String(b2.p.name), 'es')).slice(0, 12);
  }
  /** 🤝 Combina con: lo que otros clientes llevan en el mismo pedido que este producto. */
  function combinaCon(pid) {
    const P = PV(), n = new Map();
    P.S.orders.forEach((x) => { if (x.deleted || !(x.lines || {})[pid]) return; Object.keys(x.lines).forEach((q) => { if (q !== pid) n.set(q, (n.get(q) || 0) + 1); }); });
    return [...n.entries()].filter((x) => x[1] >= 2).sort((a, b) => b[1] - a[1]).map(([q]) => P.productById(q)).filter((p) => p && p.active !== false && !p.deleted).slice(0, 6);
  }
  /** HTML de la vitrina para el catálogo del vendedor (mismas tarjetas y mismo pedido que la lista). */
  function renderSeller(o) {
    const P = PV(), { esc } = P, d = data(), pop = P.popularity().n;
    const vs = d.vitrinas.filter(visible).map((v) => ({ v, ps: productsOf(v) })).filter((x) => x.ps.length);
    const combos = d.combos.filter(comboLive), camp = campanaHTML();
    if (!vs.length && !combos.length) return camp + '<div class="empty"><strong>Aún no hay vitrinas</strong>La oficina las arma en «Promoción y marketing».</div>';
    const card = (v, p, top) => {
      const h = P.productHTML(p, o);
      return top.has(p.id) && v.sello ? h.replace('<div class="pimg">', `<div class="pimg"><em class="vt-sello">${esc(v.sello)}</em>`) : h;
    };
    const sie = siempreOf(o);
    // Historias (burbujas) para saltar a cada vitrina + carrusel destacado que avanza solo
    return `${camp}<div class="vt-stories">${vs.map(({ v, ps }) => { const p = ps.find((x) => P.hasPhoto(x)); return `<button type="button" class="vt-story" data-vgo="${esc(v.id)}" style="--h:${+v.hue || 0}"><span class="vt-ring">${p ? `<img src="${esc(P.imgSrc(p))}" alt="" loading="lazy">` : `<b>${esc(v.icono || '🛍')}</b>`}</span><small>${esc(v.nombre)}</small></button>`; }).join('')}
        <button type="button" class="vt-story" data-vfull="1" title="Pantalla completa para mostrar en la tablet"><span class="vt-ring vt-ring-plain"><b>⛶</b></span><small>Pantalla completa</small></button></div>
      <div class="vt-hero" id="vtHero">${vs.map(({ v, ps }) => `<div class="vt-slide" data-vgo="${esc(v.id)}" style="--h:${+v.hue || 0}">${banner(v, ps)}</div>`).join('')}</div>
      ${vs.length > 1 ? `<div class="vt-dots">${vs.map((x, i) => `<i data-dot="${i}" class="${i ? '' : 'on'}"></i>`).join('')}</div>` : ''}
      ${combos.length ? `<section class="vt" id="vt-combos" style="--h:45"><header class="vt-mini"><div><h3>🎁 Combos de temporada</h3><p>Autorizados por Gerencia · el precio y el ahorro ya van en el pedido</p></div></header><div class="vt-mixes">${combos.map((c) => comboCard(c, o)).join('')}</div></section>` : ''}
      ${sie.length ? `<section class="vt vt-siempre" style="--h:265"><header class="vt-mini"><div><h3>🔁 Lo de siempre de ${esc(o.clientName)}</h3><p>Lo que más compra y hoy aún no lleva</p></div>
        <button type="button" class="btn btn-primary" data-siempre="1">➕ Agregar lo de siempre</button></header><div class="vt-row">${sie.map((x) => P.productHTML(x.p, o)).join('')}</div></section>` : ''}
      ${vs.map(({ v, ps }) => {
        const top = new Set(ps.filter((p) => (pop.get(p.id) || 0) >= 2).sort((a, b) => (pop.get(b.id) || 0) - (pop.get(a.id) || 0)).slice(0, 3).map((p) => p.id));
        let lastSz = null;
        const row = ps.map((p) => {
          let sep = '';
          if (v.orden === 'peso') { const sz = sizeOf(p), lbl = sz ? sz.label : 'Otras'; if (lbl !== lastSz) { sep = `<div class="vt-sep">${esc(lbl)}</div>`; lastSz = lbl; } }
          return sep + card(v, p, top);
        }).join('');
        const mixes = d.mezclas.filter((x) => x.vitrina === v.id).map(mezclaHTML).filter(Boolean).join('');
        return `<section class="vt" id="vt-${esc(v.id)}" style="--h:${+v.hue || 0}">${banner(v, ps)}<div class="vt-row">${row}</div>${mixes ? `<div class="vt-mixes">${mixes}</div>` : ''}</section>`;
      }).join('')}`;
  }
  // El carrusel destacado avanza solo cada 6 s; se detiene mientras el vendedor lo toca
  let heroTimer = null;
  function afterRender(list) {
    clearInterval(heroTimer);
    const h = list.querySelector('#vtHero'); if (!h) return;
    const dots = [...list.querySelectorAll('[data-dot]')];
    let hold = 0;
    const cur = () => Math.round(h.scrollLeft / Math.max(1, h.clientWidth));
    const mark = () => dots.forEach((x, i) => x.classList.toggle('on', i === cur()));
    h.addEventListener('scroll', () => { clearTimeout(h._t); h._t = setTimeout(mark, 80); }, { passive: true });
    h.addEventListener('pointerdown', () => { hold = Date.now(); }, { passive: true });
    heroTimer = setInterval(() => {
      if (!h.isConnected) { clearInterval(heroTimer); return; }
      if (Date.now() - hold < 12000 || document.hidden || document.querySelector('.overlay')) return;
      const n = h.children.length, i = (cur() + 1) % n;
      h.scrollTo({ left: i * h.clientWidth, behavior: 'smooth' });
    }, 6000);
  }
  /** Ficha a pantalla completa: foto grande, precios, ganancia del bodeguero y lo que combina con el producto. */
  function ficha(p) {
    const P = PV(), { esc, usd } = P;
    const draw = () => {
      const o = P.activeOrder(), g = P.gainOf(p), cc = combinaCon(p.id), sz = sizeOf(p);
      return `<div class="row"><span class="grow"></span><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <div class="vt-ficha"><div class="vt-ficha-img">${P.hasPhoto(p) ? `<img src="${esc(P.imgSrc(p))}" alt="">` : `<span>${P.rubroIcon(p.category)}</span>`}</div>
          <div class="vt-ficha-txt">${P.isNewProduct(p) ? '<span class="hot-badge new-badge" style="position:static">🆕 Nuevo</span>' : ''}<h2>${esc(p.name)}</h2>
            <p class="muted">${esc([p.presentation, p.brand, p.category].filter(Boolean).join(' · '))}${sz ? '' : ''}</p>
            <div class="vt-ficha-prices">${p.sellBy !== 'unidad' ? `<div><small>Caja x${p.unitsPerBox}</small><b>${usd(p.boxPrice)}</b></div>` : ''}${p.sellBy !== 'caja' ? `<div><small>Unidad</small><b>${usd(p.unitPrice)}</b></div>` : ''}</div>
            ${g ? `<div class="vt-gain">💰 Vendiéndolo a <b>${usd(g.pvp)}</b> la unidad, el bodeguero gana <b>${usd(g.g)} ${g.por}</b> <span>(+${g.pct}%)</span></div>` : ''}
            <div class="vt-ficha-card">${P.productHTML(p, o)}</div></div></div>
        ${cc.length ? `<div class="section-title">🤝 Combina con (lo que otros clientes llevan junto)</div><div class="vt-row vt-row-sm">${cc.map((q) => P.productHTML(q, o)).join('')}</div>` : ''}`;
    };
    const sh = P.openSheet(draw(), { wide: true });
    sh.el.addEventListener('click', async (e) => {
      const b = e.target.closest('button[data-act]'); if (!b) return;
      const pid = b.closest('[data-pid]').dataset.pid, o = P.activeOrder(), l = o && o.lines[pid];
      await P.setQty(pid, b.dataset.kind, (l ? +l[b.dataset.kind] || 0 : 0) + (b.dataset.act === 'inc' ? 1 : -1), 'vt');
      sh.el.innerHTML = draw();
    });
  }
  /** Clics de la vitrina en el catálogo del vendedor. true = ya se atendió. */
  function onSellerClick(e) {
    const P = PV();
    const im = e.target.closest('.pimg');
    if (im && !e.target.closest('button')) { const c = im.closest('[data-pid]'), p = c && P.productById(c.dataset.pid); if (p) { ficha(p); return true; } }
    const go = e.target.closest('[data-vgo]');
    if (go) { const t = document.getElementById('vt-' + go.dataset.vgo); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); return true; }
    const dot = e.target.closest('[data-dot]');
    if (dot) { const h = document.getElementById('vtHero'); if (h) h.scrollTo({ left: +dot.dataset.dot * h.clientWidth, behavior: 'smooth' }); return true; }
    if (e.target.closest('[data-vfull]')) {
      const de = document.documentElement;
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {}); else if (de.requestFullscreen) de.requestFullscreen().catch(() => {});
      return true;
    }
    if (e.target.closest('[data-siempre]')) {
      (async () => {
        const o = P.activeOrder(); if (!o) return;
        const list = siempreOf(o);
        for (const x of list) {
          if (x.cajas && x.p.sellBy !== 'unidad') await P.setQty(x.p.id, 'cajas', x.cajas, 'vt');
          if (x.unidades && x.p.sellBy !== 'caja') await P.setQty(x.p.id, 'unidades', x.unidades, 'vt');
        }
        P.toast(`Lo de siempre de ${o.clientName}: ${list.length} productos agregados`, 'ok'); P.render();
      })();
      return true;
    }
    const cb = e.target.closest('[data-combo]'); if (cb) { addCombo(cb.dataset.combo, +cb.dataset.cd); return true; }
    const mb = e.target.closest('[data-mix]'); if (!mb) return false;
    const x = data().mezclas.find((m) => m.id === mb.dataset.mix); if (!x) return true;
    (async () => {
      const o = P.activeOrder(); if (!o) { await P.setQty('', 'cajas', 0); return; } // pide elegir el cliente
      for (const it of x.items || []) {
        const p = itemProduct(it); if (!p) continue;
        const l = (P.activeOrder().lines || {})[p.id] || {};
        if (+it.cajas && p.sellBy !== 'unidad') await P.setQty(p.id, 'cajas', (+l.cajas || 0) + +it.cajas, 'vt');
        if (+it.unidades && p.sellBy !== 'caja') await P.setQty(p.id, 'unidades', (+(P.activeOrder().lines[p.id] || {}).unidades || 0) + +it.unidades, 'vt');
      }
      P.toast(`${x.nombre}: ingredientes agregados al pedido`, 'ok');
      if (navigator.vibrate) navigator.vibrate(15);
    })();
    return true;
  }

  /* ---------------- Oficina y Gerencia: Promoción y marketing ---------------- */
  const PALETTE = [356, 14, 28, 42, 95, 150, 175, 205, 230, 265, 300, 330];
  /* ---------------- PIN de la sección: solo quien tiene el PIN la construye ---------------- */
  const LOCK_MIN = 30; // sin usarla 30 minutos, se vuelve a pedir el PIN
  const lsGet2 = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet2 = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* noop */ } };
  function pinState(root) {
    const P = PV(), S = P.S, st = (S.ui.mktPin = S.ui.mktPin || { has: null, ok: null, at: 0 });
    if (S.settings.mktToken && Date.now() - (+lsGet2('pv_mktAt') || 0) > LOCK_MIN * 60000 && +lsGet2('pv_mktAt')) { P.saveSettings({ mktToken: '' }); st.ok = null; }
    if (st.has !== null && Date.now() - st.at < 120000) return st;
    const known = lsGet2('pv_mktPin');
    if (st.has === null) { st.has = known === '1' ? true : known === '0' ? false : null; st.ok = st.has === false || !!S.settings.mktToken; }
    global.Sync.mktCall({ action: 'estado' }).then(async (r) => {
      if (!r.ok) { if (st.has === null) { st.has = !!S.settings.mktToken; st.ok = !!S.settings.mktToken; st.at = Date.now(); render(root); } return; }
      const was = JSON.stringify([st.has, st.ok]);
      st.has = r.data.hasPin; st.ok = r.data.ok; st.at = Date.now(); lsSet2('pv_mktPin', r.data.hasPin ? '1' : '0');
      if (!r.data.ok && S.settings.mktToken) await P.saveSettings({ mktToken: '' });
      if (was !== JSON.stringify([st.has, st.ok]) && root.isConnected) render(root);
    });
    return st;
  }
  function gate(root) {
    const P = PV(), { esc, toast } = P, ger = esGerencia();
    root.innerHTML = `<div class="card card-pad mk-gate"><h2 style="margin-top:0">🔒 Promoción y marketing</h2>
        <p class="muted">Esta sección está protegida: solo quien tiene el PIN la construye (vitrinas, banners, combos, campaña y lanzamiento).</p>
        <div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field"><span>PIN</span><input id="mgPin" class="input" type="password" inputmode="numeric" maxlength="6" autocomplete="off" style="max-width:160px"></label>
          <button class="btn btn-primary" id="mgGo">🔓 Entrar</button></div><p id="mgErr" class="warn-txt"></p></div>
      ${ger ? '<div class="section-title">🎁 Combos por autorizar (Gerencia, sin PIN)</div><div id="mgCombos"></div>' : ''}`;
    const q = (x) => root.querySelector(x);
    const go = async () => {
      q('#mgErr').textContent = '';
      const r = await global.Sync.mktCall({ action: 'entrar', pin: q('#mgPin').value.trim() });
      if (!r.ok) { q('#mgErr').textContent = r.error || 'No se pudo entrar'; return; }
      await P.saveSettings({ mktToken: r.data.token }); lsSet2('pv_mktAt', String(Date.now()));
      const st = P.S.ui.mktPin; st.ok = true; st.at = Date.now();
      toast('🔓 Sección abierta', 'ok'); P.runSync(false); render(root);
    };
    q('#mgGo').onclick = go; q('#mgPin').onkeydown = (e) => { if (e.key === 'Enter') go(); };
    if (ger) {
      const box = q('#mgCombos'); listCombos(box, true);
      box.onclick = (e) => { const ap = e.target.closest('[data-cap]'), rj = e.target.closest('[data-crj]'); if (ap) decideCombo(ap.dataset.cap, true).then(() => render(root)); if (rj) decideCombo(rj.dataset.crj, false).then(() => render(root)); };
    }
    setTimeout(() => { const i = q('#mgPin'); if (i) i.focus(); }, 60);
  }
  function pinBar(st) {
    const P = PV(), adm = !!(P.S.settings && P.S.settings.adminKey && location.hash.startsWith('#/oficina'));
    if (!st.has) return adm ? '<div class="hint warn">🔐 <b>Protege esta sección con tu PIN</b>: así solo tú construyes las vitrinas, banners, combos y el lanzamiento. <button class="btn btn-sm btn-primary" id="mpNew">Crear PIN</button></div>' : '';
    return '<div class="row" style="justify-content:flex-end;gap:6px;margin-bottom:6px"><span class="muted" style="align-self:center">🔓 Abierta con tu PIN</span><button class="btn btn-sm" id="mpChg">Cambiar PIN</button><button class="btn btn-sm" id="mpLock">🔒 Cerrar sección</button></div>';
  }
  function pinBarWire(root) {
    const P = PV(), { toast } = P, q = (x) => root.querySelector(x);
    const ask = (title, cb) => {
      const sh = P.openSheet(`<div class="row"><h2 class="grow">${title}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
        <label class="field"><span>PIN nuevo (4 a 6 números)</span><input id="mpA" class="input" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>
        <label class="field"><span>Repite el PIN</span><input id="mpB" class="input" type="password" inputmode="numeric" maxlength="6" autocomplete="off"></label>
        <p class="muted" style="font-size:13px">Si lo olvidas, se restablece con la clave del desarrollador.</p><p id="mpE" class="warn-txt"></p>
        <div class="actions"><button class="btn btn-primary" id="mpOk">Guardar PIN</button></div>`);
      sh.el.querySelector('#mpOk').onclick = async () => {
        const a = sh.el.querySelector('#mpA').value.trim(), b = sh.el.querySelector('#mpB').value.trim(), e = sh.el.querySelector('#mpE');
        if (!/^\d{4,6}$/.test(a)) { e.textContent = 'El PIN es de 4 a 6 números'; return; }
        if (a !== b) { e.textContent = 'Los dos PIN no coinciden'; return; }
        const r = await cb(a); if (!r.ok) { e.textContent = r.error || 'No se pudo guardar'; return; }
        await P.saveSettings({ mktToken: r.data.token }); lsSet2('pv_mktAt', String(Date.now())); lsSet2('pv_mktPin', '1');
        const st = P.S.ui.mktPin; st.has = true; st.ok = true; st.at = Date.now();
        sh.close(); toast('🔐 PIN guardado: solo tú construyes esta sección', 'ok'); P.logEvent('marketing', 'PIN de Promoción y marketing ' + (title.includes('Cambiar') ? 'cambiado' : 'creado')); render(root);
      };
    };
    const nw = q('#mpNew'); if (nw) nw.onclick = () => ask('🔐 Crear PIN de la sección', (pin) => global.Sync.mktCall({ action: 'crear', pin }));
    const ch = q('#mpChg'); if (ch) ch.onclick = () => ask('🔐 Cambiar PIN de la sección', (pin) => global.Sync.mktCall({ action: 'cambiar', pin }));
    const lk = q('#mpLock'); if (lk) lk.onclick = async () => { await P.saveSettings({ mktToken: '' }); const st = P.S.ui.mktPin; st.ok = false; st.at = Date.now(); toast('🔒 Sección cerrada', 'ok'); render(root); };
  }

  function render(root) {
    const P = PV(), S = P.S, { esc } = P, ui = (S.ui.mkt = S.ui.mkt || { tab: 'vitrinas' }), d = data();
    const st = pinState(root);
    if (st.has && !st.ok) return gate(root);
    if (st.has) lsSet2('pv_mktAt', String(Date.now()));
    const tab = S.ui.mktTab || ui.tab || 'campana';
    root.innerHTML = `<div class="toolbar"><div class="seg">${[['campana', '🎄 Campaña'], ['vitrinas', '🛍 Vitrinas'], ['mezclas', '🍹 Mezclas'], ['combos', '🎁 Combos'], ['ganancia', '💰 Ganancia bodega'], ['impacto', '📈 Impacto vitrina'], ['resultados', '📊 Resultados']].map(([k, l]) => `<button type="button" class="${tab === k ? 'active' : ''}" data-mt="${k}">${l}</button>`).join('')}</div><span class="grow"></span>
        ${tab === 'vitrinas' ? '<button class="btn btn-primary" id="mkNew">＋ Nueva vitrina</button>' : tab === 'mezclas' ? '<button class="btn btn-primary" id="mkNewX">＋ Nueva mezcla</button>' : tab === 'combos' ? '<button class="btn btn-primary" id="mkNewC">＋ Nuevo combo</button>' : ''}</div>
      ${pinBar(st)}${d.saved ? '' : '<div class="hint">✨ Estas son las <b>vitrinas sugeridas</b>. Edítalas a tu gusto: al guardar el primer cambio quedan como las de la empresa y les llegan a todos los vendedores.</div>'}
      <div id="mkBody"></div>`;
    const body = root.querySelector('#mkBody');
    pinBarWire(root);
    if (tab === 'vitrinas') listVitrinas(body);
    else if (tab === 'mezclas') listMezclas(body);
    else if (tab === 'combos') listCombos(body);
    else if (tab === 'resultados') resultados(body);
    else if (tab === 'ganancia') ganancia(body);
    else if (tab === 'impacto') impacto(body);
    else campanaForm(body, () => render(root));
    root.onclick = (e) => {
      const t = e.target.closest('[data-mt]'); if (t) { S.ui.mktTab = t.dataset.mt; render(root); return; }
      if (e.target.closest('#mkNew')) { editVitrina(null, () => render(root)); return; }
      if (e.target.closest('#mkNewX')) { editMezcla(null, () => render(root)); return; }
      if (e.target.closest('#mkNewC')) { editCombo(null, () => render(root)); return; }
      const ec = e.target.closest('[data-ec]'); if (ec) { editCombo(data().combos.find((c) => c.id === ec.dataset.ec), () => render(root)); return; }
      const ap = e.target.closest('[data-cap]'); if (ap) { decideCombo(ap.dataset.cap, true).then(() => render(root)); return; }
      const rj = e.target.closest('[data-crj]'); if (rj) { decideCombo(rj.dataset.crj, false).then(() => render(root)); return; }
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
          ${v.desde || v.hasta ? ` <span class="status ${enFecha(v) ? 'en_carga' : 'espera'}">📅 ${v.desde ? 'del ' + esc(P.fmtDate(v.desde)) : ''}${v.hasta ? ' al ' + esc(P.fmtDate(v.hasta)) : ''}${enFecha(v) ? '' : ' · fuera de fecha'}</span>` : ''}<small class="muted" style="display:block">${ps.length} productos · orden: ${({ peso: 'por peso', ventas: 'más vendidos primero', nombre: 'por nombre', manual: 'a mano' })[v.orden || 'ventas']}${v.sello ? ' · sello «' + esc(v.sello) + '»' : ''}</small></div>
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
  /* ---------------- Combos: Oficina los arma, Gerencia los autoriza ---------------- */
  const esGerencia = () => location.hash.startsWith('#/gerencia') && !!(global.Roles && global.Roles.isRole('gerencia'));
  function estadoCombo(c) {
    if (comboOk(c)) return `<span class="status en_carga">✅ Autorizado${c.aprobado.by ? ' por ' + PV().esc(c.aprobado.by) : ''}</span>`;
    if (c.estado === 'rechazado') return `<span class="status over">❌ Rechazado${c.motivo ? ': ' + PV().esc(c.motivo) : ''}</span>`;
    return '<span class="status espera">⏳ Espera autorización de Gerencia</span>';
  }
  function listCombos(body, soloAprobar) {
    const P = PV(), { esc, usd } = P, d = data(), ger = esGerencia(); // soloAprobar: Gerencia sin PIN (sin editar)
    body.innerHTML = `<p class="muted">El combo se arma con productos reales y su precio. <b>Solo Gerencia lo autoriza</b>; si alguien cambia productos, cantidades, regalos o precio, vuelve a autorización. El vendedor solo ve los autorizados y dentro de sus fechas. El ahorro que se anuncia es real: el sistema lo calcula con los precios.</p>
      <div class="mk-list">${d.combos.map((c) => { const al = comboAlloc(c, catPrices), miss = (c.items || []).filter((it) => !P.productById(it.pid));
        return `<div class="mk-card"><div class="mk-sw">${esc(c.icono || '🎁')}</div><div class="grow"><b>${esc(c.nombre)}</b> ${estadoCombo(c)}${c.desde || c.hasta ? ` <span class="status ${enFecha(c) ? 'en_carga' : 'espera'}">📅 ${c.desde ? esc(P.fmtDate(c.desde)) : ''} – ${c.hasta ? esc(P.fmtDate(c.hasta)) : ''}</span>` : ''}
          <div class="muted">${(c.items || []).map((it) => { const p = P.productById(it.pid); return `${[+it.cajas ? it.cajas + ' cj' : '', +it.unidades ? it.unidades + ' un' : ''].filter(Boolean).join(' + ')} ${p ? esc(p.name + ' ' + (p.presentation || '')) : `<span class="warn-txt">«${esc(it.q || '?')}» sin producto</span>`}${it.regalo ? ' 🎁' : ''}`; }).join(' + ')}</div>
          <small>${al ? `Por separado ${usd(al.S)} · <b>combo ${usd(+c.precio || 0)}</b>${al.D > 0 ? ` · ahorra ${usd(al.D)} (${Math.round((al.D / al.S) * 100)}%)` : ''}` : '<span class="warn-txt">Falta elegir productos o el precio</span>'}${c.incluye ? ' · ✨ ' + esc(c.incluye) : ''}</small>${miss.length ? '<br><small class="warn-txt">Elige los productos que faltan antes de autorizar</small>' : ''}</div>
          <div class="row" style="gap:4px">${ger && !comboOk(c) && al && !miss.length ? `<button class="btn btn-sm btn-ok" data-cap="${esc(c.id)}">✅ Autorizar</button><button class="btn btn-sm btn-danger" data-crj="${esc(c.id)}">❌ Rechazar</button>` : ''}${ger && comboOk(c) ? `<button class="btn btn-sm btn-danger" data-crj="${esc(c.id)}">⏸ Retirar</button>` : ''}${soloAprobar ? '' : `<button class="btn btn-sm btn-primary" data-ec="${esc(c.id)}">✎ Editar</button>`}</div></div>`; }).join('') || '<p class="muted">Sin combos. Crea uno o carga la campaña navideña en «🎄 Campaña».</p>'}</div>`;
  }
  async function decideCombo(id, ok) {
    const P = PV(), c = data().combos.find((x) => x.id === id); if (!c) return;
    let motivo = '';
    if (!ok) { motivo = prompt(`¿Por qué no se autoriza «${c.nombre}»? (lo ve la oficina)`, ''); if (motivo === null) return; }
    const who = (P.S.settings && P.S.settings.userName) || 'Gerencia';
    const list = data().combos.map((x) => { if (x.id !== id) return x; const y = { ...x }; delete y.aprobado; if (ok) { y.aprobado = { v: comboV(y), by: who, at: new Date().toISOString() }; y.estado = 'aprobado'; delete y.motivo; } else { y.estado = 'rechazado'; y.motivo = motivo.trim(); } return y; });
    await save({ combos: list }, `${ok ? 'Autorizó' : 'No autorizó'} el combo «${c.nombre}»${motivo ? ': ' + motivo : ''}`);
    P.toast(ok ? 'Combo autorizado: ya lo ven los vendedores' : 'Combo no autorizado', ok ? 'ok' : 'err');
  }
  function editCombo(c0, done) {
    const P = PV(), { esc, usd, toast } = P, isNew = !c0, d = data();
    const c = { ...(c0 || { id: uid(), nombre: '', frase: '', icono: '🎁', vitrina: '', items: [], precio: 0, incluye: '' }) };
    c.items = (c.items || []).map((it) => { const p = it.pid ? P.productById(it.pid) : itemProduct(it); return { ...it, pid: p ? p.id : it.pid || '' }; });
    const sh = P.openSheet(`<div class="row"><h2 class="grow">${isNew ? '＋ Nuevo combo' : '✎ ' + esc(c.nombre)}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      ${comboOk(c0 || {}) ? '<div class="hint warn">Este combo está autorizado. Si cambias productos, cantidades, regalos o precio, <b>vuelve a autorización de Gerencia</b> y los vendedores dejan de verlo hasta entonces.</div>' : ''}
      <div class="row wrap" style="gap:8px"><label class="field" style="max-width:90px"><span>Ícono</span><input id="ceI" class="input" maxlength="4" value="${esc(c.icono || '')}"></label>
        <label class="field grow"><span>Nombre del combo</span><input id="ceN" class="input" maxlength="60" value="${esc(c.nombre)}" placeholder="Ej.: Combo Hallaquiada en familia"></label></div>
      <label class="field"><span>Frase</span><input id="ceF" class="input" maxlength="120" value="${esc(c.frase || '')}"></label>
      <div class="section-title">Productos del combo</div><div id="ceItems"></div>
      <div class="field mk-pick" id="ceAdd"><span>Agregar producto</span><input class="input" placeholder="Buscar producto…" autocomplete="off"><div class="mk-res"></div></div>
      <div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field"><span>Precio del combo $</span><input id="ceP" class="input" inputmode="decimal" value="${+c.precio ? String(c.precio).replace('.', ',') : ''}" style="max-width:140px"></label><div id="ceCalc" class="grow"></div></div>
      <label class="field"><span>✨ Incluye además (opcional)</span><input id="ceX" class="input" maxlength="80" value="${esc(c.incluye || '')}" placeholder="Ej.: Delivery gratis"></label>
      <div class="row wrap" style="gap:8px"><label class="field"><span>📅 Desde</span><input id="ceD" type="date" class="input" value="${esc(c.desde || '')}"></label><label class="field"><span>Hasta</span><input id="ceH" type="date" class="input" value="${esc(c.hasta || '')}"></label></div>
      <div class="actions">${isNew ? '' : '<button class="btn btn-danger" id="ceDel">Eliminar</button>'}<span class="grow"></span><button class="btn btn-primary" id="ceOk">Guardar y enviar a autorización</button></div>`, { wide: true });
    const q = (x) => sh.el.querySelector(x);
    const precio = () => Math.round((Number(String(q('#ceP').value).replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100;
    const regaloVal = () => c.items.filter((it) => it.regalo).reduce((a, it) => { const p = P.productById(it.pid); return a + (p ? (+it.cajas || 0) * (+p.boxPrice || 0) + (+it.unidades || 0) * (+p.unitPrice || 0) : 0); }, 0);
    const calc = () => {
      const al = comboAlloc({ ...c, precio: precio() }, catPrices), S = al ? al.S : c.items.reduce((a, it) => { const p = P.productById(it.pid); return a + (p ? (+it.cajas || 0) * (+p.boxPrice || 0) + (+it.unidades || 0) * (+p.unitPrice || 0) : 0); }, 0);
      const rg = regaloVal(), max = r2(S - rg), pr = precio();
      q('#ceCalc').innerHTML = S ? `Por separado <b>${usd(S)}</b>${rg ? ` · sin los regalos ${usd(max)}` : ''}${pr ? (pr > max ? ` · <b class="warn-txt">El precio no puede pasar de ${usd(max)}${rg ? ' (si no, el regalo no sería regalo)' : ''}</b>` : ` · <b class="pay-ok">ahorra ${usd(S - pr)} (${Math.round(((S - pr) / S) * 100)}%)</b>`) : ''}` : '';
    };
    const draw = () => {
      q('#ceItems').innerHTML = c.items.map((it, i) => { const p = P.productById(it.pid); return `<div class="row wrap" style="gap:8px;align-items:flex-end;margin-bottom:6px"><span class="grow">${p ? `<b>${esc(p.name)}</b> ${esc(p.presentation || '')} <small class="muted">${usd(p.boxPrice)} cj · ${usd(p.unitPrice)} un</small>` : `<span class="warn-txt">«${esc(it.q || '?')}»: elige el producto abajo</span>`}</span>
        <label class="field" style="max-width:80px"><span>Cajas</span><input class="input" inputmode="numeric" data-cc="${i}" value="${+it.cajas || ''}"></label>
        <label class="field" style="max-width:80px"><span>Unid.</span><input class="input" inputmode="numeric" data-cu="${i}" value="${+it.unidades || ''}"></label>
        <label class="chip-check"><input type="checkbox" data-cg="${i}" ${it.regalo ? 'checked' : ''}> 🎁 Regalo</label>
        <button type="button" class="btn btn-sm btn-danger" data-crm="${i}">✕</button></div>`; }).join('') || '<p class="muted">Sin productos.</p>';
      calc();
    };
    draw();
    sh.el.addEventListener('input', (e) => { if (e.target.id === 'ceP') calc(); });
    sh.el.addEventListener('change', (e) => {
      const a = e.target.closest('[data-cc]'), u = e.target.closest('[data-cu]'), g = e.target.closest('[data-cg]');
      if (a) c.items[+a.dataset.cc].cajas = Math.max(0, Math.round(+a.value || 0));
      if (u) c.items[+u.dataset.cu].unidades = Math.max(0, Math.round(+u.value || 0));
      if (g) c.items[+g.dataset.cg].regalo = g.checked;
      if (a || u || g) calc();
    });
    sh.el.addEventListener('click', (e) => { const r = e.target.closest('[data-crm]'); if (r) { c.items.splice(+r.dataset.crm, 1); draw(); } });
    picker(q('#ceAdd'), (pid) => {
      const p = P.productById(pid), unresolved = c.items.findIndex((it) => !P.productById(it.pid));
      const it = { pid, cajas: p && p.sellBy === 'unidad' ? 0 : 1, unidades: p && p.sellBy === 'unidad' ? 1 : 0 };
      if (unresolved >= 0) c.items[unresolved] = { ...c.items[unresolved], ...it, cajas: c.items[unresolved].cajas || it.cajas }; else c.items.push(it);
      draw();
    });
    q('#ceOk').onclick = async () => {
      Object.assign(c, { icono: q('#ceI').value.trim(), nombre: q('#ceN').value.trim(), frase: q('#ceF').value.trim(), incluye: q('#ceX').value.trim(), desde: q('#ceD').value, hasta: q('#ceH').value, precio: precio() });
      if (!c.nombre) { toast('Ponle un nombre al combo', 'err'); return; }
      if (c.items.some((it) => !P.productById(it.pid))) { toast('Hay productos sin elegir', 'err'); return; }
      if (!c.items.some((it) => (+it.cajas || +it.unidades) && !it.regalo)) { toast('El combo necesita al menos un producto que no sea regalo', 'err'); return; }
      const al = comboAlloc(c, catPrices);
      if (!(c.precio > 0) || !al) { toast('Pon un precio mayor que 0 y que no pase de lo que vale por separado', 'err'); return; }
      if (c.precio > r2(al.S - regaloVal()) + 0.001) { toast('Con ese precio el regalo no sería regalo: bájalo', 'err'); return; }
      if (c.desde && c.hasta && c.hasta < c.desde) { toast('La fecha «hasta» es antes de «desde»', 'err'); return; }
      if (!c.desde) delete c.desde; if (!c.hasta) delete c.hasta;
      c.items = c.items.map(({ pid, cajas, unidades, regalo }) => ({ pid, cajas: +cajas || 0, unidades: +unidades || 0, ...(regalo ? { regalo: true } : {}) }));
      const prev = c0 && c0.aprobado && c0.aprobado.v === comboV(c) ? c0.aprobado : null; // sin cambios de fondo: sigue autorizado
      if (prev) c.aprobado = prev; else { delete c.aprobado; c.estado = 'pendiente'; delete c.motivo; }
      const list = data().combos.slice(), i = list.findIndex((x) => x.id === c.id);
      if (i >= 0) list[i] = c; else list.push(c);
      await save({ combos: list }, `${isNew ? 'Creó' : 'Editó'} el combo «${c.nombre}» (${P.usd(c.precio)})`);
      sh.close(); toast(prev ? 'Combo guardado' : 'Combo guardado: espera la autorización de Gerencia', 'ok'); done();
    };
    const del = q('#ceDel');
    if (del) del.onclick = async () => { if (!confirm(`¿Eliminar el combo «${c.nombre}»?`)) return; await save({ combos: data().combos.filter((x) => x.id !== c.id) }, `Eliminó el combo «${c.nombre}»`); sh.close(); done(); };
  }

  /* ---------------- 💰 Ganancia de la bodega: precio de venta sugerido (PVP) y cuánto gana el bodeguero ---------------- */
  // Costo para la bodega = lo que nos paga por unidad (precio de la caja ÷ unidades, o el precio por unidad).
  // Ganancia % = (PVP − costo) ÷ costo. La vitrina y la ficha del producto se la muestran al cliente.
  const costoU = (p) => (p.sellBy !== 'unidad' && +p.boxPrice > 0 ? +p.boxPrice / (+p.unitsPerBox || 1) : +p.unitPrice || 0);
  function ganancia(body) {
    const P = PV(), S = P.S, { esc, usd, toast } = P, ui = (S.ui.mktGan = S.ui.mktGan || { q: '', cat: '', sin: false });
    const cats = [...new Set(active().map((p) => p.category).filter(Boolean))].sort();
    const toks = P.norm(ui.q).split(' ').filter(Boolean);
    const rows = active().filter((p) => (!ui.cat || p.category === ui.cat) && (!ui.sin || !(+p.pvp > 0)) && toks.every((t) => (P.norm(p.code + ' ' + (p.unitCode || '')) + ' ' + hayOf(p)).includes(t)))
      .sort((a, b) => String(a.category).localeCompare(String(b.category), 'es') || String(a.name).localeCompare(String(b.name), 'es'));
    const g = (p) => { const c = costoU(p), v = +p.pvp || 0; return v > 0 && c > 0 ? { u: r2(v - c), cj: r2((v - c) * (p.sellBy !== 'unidad' ? +p.unitsPerBox || 1 : 1)), pct: Math.round(((v - c) / c) * 100) } : null; };
    const con = active().filter((p) => +p.pvp > 0), prom = con.length ? Math.round(con.reduce((a, p) => a + ((g(p) || { pct: 0 }).pct), 0) / con.length) : 0;
    body.innerHTML = `<p class="muted">Carga el <b>precio de venta sugerido al público</b> (por unidad) y el sistema calcula cuánto gana el bodeguero. La vitrina y la ficha se lo muestran al cliente: «💰 Ganas $X por caja (+Y %)». Es el mejor argumento para venderle a una bodega.</p>
      <div class="kpis big" style="margin:6px 0 10px"><span><b>${con.length}</b> de ${active().length} productos con precio sugerido</span><span><b>${prom}%</b> de ganancia promedio para la bodega</span></div>
      <div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field grow"><span>Buscar</span><input id="gnQ" class="input" value="${esc(ui.q)}"></label>
        <label class="field"><span>Categoría</span><select id="gnC" class="select"><option value="">Todas</option>${cats.map((c) => `<option ${c === ui.cat ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
        <label class="chip-check"><input type="checkbox" id="gnS" ${ui.sin ? 'checked' : ''}> Solo sin precio</label>
        <label class="field"><span>Sugerir con ganancia de</span><div class="row" style="gap:4px"><input id="gnP" class="input" inputmode="numeric" value="30" style="max-width:70px"><b style="align-self:center">%</b><button class="btn" id="gnApply" title="A los productos mostrados que aún no tienen precio">Aplicar</button></div></label>
        <button class="btn" id="gnX">⇩ Excel</button></div>
      <div class="card" style="overflow:auto;margin-top:8px"><table class="inv"><thead><tr><th>Producto</th><th>Categoría</th><th class="n">Precio caja</th><th class="n">Costo por unidad</th><th class="n">Precio sugerido (unidad)</th><th class="n">Gana por unidad</th><th class="n">Gana por caja</th><th class="n">Ganancia</th></tr></thead><tbody>
        ${rows.slice(0, 500).map((p) => { const x = g(p); return `<tr data-gp="${esc(p.id)}"><td><b>${esc(p.name)}</b> <span class="muted">${esc(p.presentation || '')}${p.sellBy !== 'unidad' ? ' · caja x' + (+p.unitsPerBox || 1) : ''}</span></td><td>${esc(p.category)}</td>
          <td class="n">${p.sellBy !== 'unidad' ? usd(p.boxPrice) : '—'}</td><td class="n">${usd(r2(costoU(p)))}</td>
          <td class="n"><input class="input sm gn-in" inputmode="decimal" data-pvp="${esc(p.id)}" value="${+p.pvp ? String(p.pvp).replace('.', ',') : ''}" placeholder="—" style="max-width:100px"></td>
          <td class="n">${x ? usd(x.u) : ''}</td><td class="n">${x && p.sellBy !== 'unidad' ? usd(x.cj) : ''}</td><td class="n ${x ? (x.pct >= 15 ? 'pay-ok' : 'warn-txt') : ''}"><b>${x ? '+' + x.pct + '%' : ''}</b></td></tr>`; }).join('')}</tbody></table></div>
      ${rows.length > 500 ? '<p class="muted">Se muestran 500: usa el buscador.</p>' : ''}`;
    const q = (x) => body.querySelector(x);
    let tq; q('#gnQ').oninput = (e) => { clearTimeout(tq); tq = setTimeout(() => { ui.q = e.target.value; ganancia(body); const i = q('#gnQ'); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }, 300); };
    q('#gnC').onchange = (e) => { ui.cat = e.target.value; ganancia(body); };
    q('#gnS').onchange = (e) => { ui.sin = e.target.checked; ganancia(body); };
    body.onchange = async (e) => {
      const inp = e.target.closest('[data-pvp]'); if (!inp) return;
      const p = P.productById(inp.dataset.pvp); if (!p) return;
      const v = Math.round((Number(String(inp.value).replace(/\./g, '').replace(',', '.')) || 0) * 100) / 100;
      if (v < 0) { toast('El precio no puede ser negativo', 'err'); return; }
      if (v && v <= costoU(p)) toast(`Ojo: a ${usd(v)} la bodega no gana (le cuesta ${usd(r2(costoU(p)))})`, 'err');
      await P.saveDocs('products', { ...p, pvp: v }); P.runSync(false); ganancia(body);
    };
    q('#gnApply').onclick = async () => {
      const pct = Number(q('#gnP').value); if (!(pct > 0 && pct <= 300)) { toast('Pon un % de 1 a 300', 'err'); return; }
      const sinP = rows.filter((p) => !(+p.pvp > 0) && costoU(p) > 0);
      if (!sinP.length) { toast('Todos los productos mostrados ya tienen precio sugerido', 'ok'); return; }
      if (!confirm(`¿Poner precio sugerido con ${pct}% de ganancia a ${sinP.length} productos sin precio? (redondeado a 0,05)`)) return;
      await P.saveDocs('products', sinP.map((p) => ({ ...p, pvp: Math.ceil((costoU(p) * (1 + pct / 100)) * 20) / 20 })));
      P.logEvent('precios_sugeridos', `Precio sugerido con ${pct}% de ganancia para ${sinP.length} productos`); P.runSync(false);
      toast(`Precio sugerido cargado a ${sinP.length} productos`, 'ok'); ganancia(body);
    };
    q('#gnX').onclick = () => global.Exporta.save(`precios_sugeridos_${P.today()}.xlsx`, [global.Exporta.table({ name: 'Precios sugeridos', title: 'PRECIO DE VENTA SUGERIDO Y GANANCIA DE LA BODEGA', subtitle: 'Al ' + P.today(),
      cols: [{ h: 'PRODUCTO', w: 34 }, { h: 'PRESENTACIÓN', w: 14 }, { h: 'CATEGORÍA', w: 16 }, { h: 'PRECIO CAJA', k: 'money' }, { h: 'UND/CAJA', k: 'int' }, { h: 'COSTO UNIDAD', k: 'money' }, { h: 'PRECIO SUGERIDO', k: 'money' }, { h: 'GANA UNIDAD', k: 'money' }, { h: 'GANA CAJA', k: 'money' }, { h: 'GANANCIA %', k: 'int' }],
      rows: rows.map((p) => { const x = g(p); return [p.name, p.presentation || '', p.category, p.sellBy !== 'unidad' ? +p.boxPrice : '', p.sellBy !== 'unidad' ? +p.unitsPerBox || 1 : '', r2(costoU(p)), +p.pvp || '', x ? x.u : '', x && p.sellBy !== 'unidad' ? x.cj : '', x ? x.pct : '']; }) })]);
  }

  /* ---------------- 📈 Impacto de la vitrina: ¿no compraban porque no querían o porque no se les ofrecía? ---------------- */
  // Cada pedido recuerda qué productos se agregaron desde la vitrina (o.vt). Se compara: pedidos con y sin vitrina,
  // productos que el cliente no compraba (90 días antes) y que llevó desde la vitrina, y un período contra otro.
  function impacto(body) {
    const P = PV(), S = P.S, { esc, usd } = P, ui = (S.ui.mktImp = S.ui.mktImp || {}), d = data(), hoy = P.today();
    const addD = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const span = (a, b) => Math.max(1, Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) + 1);
    const lz = d.lanzamiento && d.lanzamiento.lanzada ? String(d.lanzamiento.at).slice(0, 10) : '';
    const pre = ui.pre || (lz ? 'lanz' : 'mes');
    let A1, A2;
    if (pre === 'lanz' && lz) { A1 = lz; A2 = hoy; } else if (pre === 'camp' && d.campana && d.campana.desde) { A1 = d.campana.desde; A2 = d.campana.hasta && d.campana.hasta < hoy ? d.campana.hasta : hoy; }
    else if (pre === 'custom') { A1 = ui.a1 || addD(hoy, -29); A2 = ui.a2 || hoy; } else { A1 = addD(hoy, -29); A2 = hoy; }
    const n = span(A1, A2), B1 = pre === 'custom' && ui.b1 ? ui.b1 : addD(A1, -n), B2 = pre === 'custom' && ui.b2 ? ui.b2 : addD(A1, -1);
    const vivos = S.orders.filter((o) => !o.deleted && o.status !== 'abierto');
    const inR = (o, a, b) => String(o.routeDate || '') >= a && String(o.routeDate || '') <= b;
    const M = global.Matrix, monto = (o) => (o.delivery && o.delivery.at ? +o.delivery.monto || 0 : M.orderTotals(o).monto), skus = (o) => Object.values(o.lines || {}).filter((l) => (+l.cajas || 0) || (+l.unidades || 0)).length;
    const stats = (os) => { const c = new Set(os.map((o) => o.clientId)), v = r2(os.reduce((a, o) => a + monto(o), 0)); return { n: os.length, v, cl: c.size, tk: os.length ? r2(v / os.length) : 0, sk: os.length ? Math.round((os.reduce((a, o) => a + skus(o), 0) / os.length) * 10) / 10 : 0 }; };
    const A = vivos.filter((o) => inR(o, A1, A2)), B = vivos.filter((o) => inR(o, B1, B2));
    const conV = A.filter((o) => o.vt && (o.vt.pids || []).length), sinV = A.filter((o) => !(o.vt && (o.vt.pids || []).length));
    const sA = stats(A), sB = stats(B), sC = stats(conV), sS = stats(sinV);
    // Venta que salió de la vitrina y productos «nuevos para el cliente» (no los compró en los 90 días anteriores)
    const byClient = new Map(); vivos.forEach((o) => { const a = byClient.get(o.clientId) || []; a.push(o); byClient.set(o.clientId, a); });
    let ventaVt = 0, nuevosN = 0, nuevosV = 0; const nuevosCl = new Set(), topNuevos = new Map();
    conV.forEach((o) => {
      const prev = (byClient.get(o.clientId) || []).filter((x) => x.id !== o.id && String(x.routeDate) < String(o.routeDate) && String(x.routeDate) >= addD(o.routeDate, -90));
      o.vt.pids.forEach((pid) => {
        const l = (o.lines || {})[pid]; if (!l) return;
        const m = M.lineTotals(l).monto; ventaVt += m;
        if (!prev.some((x) => (x.lines || {})[pid])) { nuevosN++; nuevosV += m; nuevosCl.add(o.clientId); const t = topNuevos.get(pid) || { name: `${l.name} ${l.presentation || ''}`, n: 0, v: 0 }; t.n++; t.v += m; topNuevos.set(pid, t); }
      });
    });
    ventaVt = r2(ventaVt); nuevosV = r2(nuevosV);
    const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);
    const arrow = (x) => (x === null ? '—' : `<b class="${x >= 0 ? 'pay-ok' : 'warn-txt'}">${x >= 0 ? '▲ +' : '▼ '}${x}%</b>`);
    // Por vendedor
    const vend = new Map(); A.forEach((o) => { const k = o.sellerName || o.sellerId || '—', x = vend.get(k) || { con: [], sin: [] }; (o.vt && (o.vt.pids || []).length ? x.con : x.sin).push(o); vend.set(k, x); });
    const vrows = [...vend.entries()].map(([k, x]) => ({ k, n: x.con.length + x.sin.length, ad: Math.round((x.con.length / Math.max(1, x.con.length + x.sin.length)) * 100), tc: stats(x.con).tk, ts: stats(x.sin).tk, v: r2(stats(x.con).v + stats(x.sin).v) })).sort((a, b) => b.ad - a.ad || b.v - a.v);
    // Conclusiones en palabras
    const con = [];
    const dTk = pct(sC.tk, sS.tk);
    if (conV.length && sinV.length && dTk !== null) con.push(dTk >= 0 ? `🛍 Los pedidos tomados <b>con la vitrina son ${dTk}% más grandes</b> (${usd(sC.tk)} contra ${usd(sS.tk)} sin vitrina) y llevan ${sC.sk} productos distintos contra ${sS.sk}.` : `🛍 Los pedidos con vitrina son ${-dTk}% más pequeños (${usd(sC.tk)} contra ${usd(sS.tk)}): revisa cómo se está usando.`);
    if (nuevosN) con.push(`💡 <b>${nuevosCl.size} cliente${nuevosCl.size === 1 ? '' : 's'} compraron ${nuevosN} producto${nuevosN === 1 ? '' : 's'} que no habían comprado en 90 días</b> (${usd(nuevosV)}). No es que no quisieran: no se los estaban ofreciendo.`);
    if (ventaVt) con.push(`💵 Desde la vitrina salieron <b>${usd(ventaVt)}</b>, el ${sA.v ? Math.round((ventaVt / sA.v) * 100) : 0}% de la venta del período.`);
    const dV = pct(sA.v, sB.v);
    if (dV !== null) con.push(`📊 La venta ${dV >= 0 ? 'creció' : 'bajó'} <b>${Math.abs(dV)}%</b> frente al período anterior (${usd(sA.v)} contra ${usd(sB.v)}); el pedido promedio ${pct(sA.tk, sB.tk) >= 0 ? 'subió' : 'bajó'} ${Math.abs(pct(sA.tk, sB.tk) || 0)}%.`);
    if (A.length) con.push(`📱 El <b>${Math.round((conV.length / A.length) * 100)}%</b> de los pedidos usó la vitrina${vrows.length > 1 ? `; quien más la usa: <b>${esc(vrows[0].k)}</b> (${vrows[0].ad}%)` : ''}.`);
    if (!conV.length) con.push(d.lanzamiento && d.lanzamiento.lanzada ? 'Aún no hay pedidos tomados con la vitrina en este período.' : '🔒 La vitrina aún no está lanzada: estas métricas empiezan a llenarse desde el lanzamiento.');
    const fd = (x) => esc(P.fmtDate(x));
    body.innerHTML = `<div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="field"><span>Comparar</span><select id="imPre" class="select">${[lz ? ['lanz', 'Desde el lanzamiento vs. antes'] : null, ['mes', 'Últimos 30 días vs. los 30 anteriores'], d.campana && d.campana.desde ? ['camp', 'Campaña vs. mismo número de días antes'] : null, ['custom', 'Personalizado']].filter(Boolean).map(([k, l]) => `<option value="${k}" ${k === pre ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${pre === 'custom' ? `<label class="field"><span>Período A desde</span><input id="imA1" type="date" class="input" value="${esc(A1)}"></label><label class="field"><span>hasta</span><input id="imA2" type="date" class="input" value="${esc(A2)}"></label>
          <label class="field"><span>Contra B desde</span><input id="imB1" type="date" class="input" value="${esc(B1)}"></label><label class="field"><span>hasta</span><input id="imB2" type="date" class="input" value="${esc(B2)}"></label>` : ''}
        <span class="grow"></span><button class="btn" id="imX">⇩ Excel</button></div>
      <p class="muted">Período A: <b>${fd(A1)} – ${fd(A2)}</b> · contra B: ${fd(B1)} – ${fd(B2)}</p>
      <div class="card card-pad mk-conc"><h3 style="margin-top:0">🧠 Conclusiones</h3>${con.map((x) => `<p>${x}</p>`).join('')}<p class="muted" style="font-size:12px">Las cifras muestran lo que pasó; también influyen la temporada, los precios y el inventario.</p></div>
      <div class="mk-cards">
        <div class="card card-pad"><h3>🛍 Con vitrina</h3><p><b>${sC.n}</b> pedidos · ticket <b>${usd(sC.tk)}</b> · ${sC.sk} productos por pedido</p></div>
        <div class="card card-pad"><h3>📋 Sin vitrina</h3><p><b>${sS.n}</b> pedidos · ticket <b>${usd(sS.tk)}</b> · ${sS.sk} productos por pedido</p></div>
        <div class="card card-pad"><h3>💡 Productos nuevos para el cliente</h3><p><b>${nuevosN}</b> en ${nuevosCl.size} clientes · ${usd(nuevosV)}</p></div></div>
      <div class="section-title">Período A contra B</div>
      <div class="card" style="overflow:auto"><table class="inv"><thead><tr><th></th><th class="n">A</th><th class="n">B</th><th class="n">Cambio</th></tr></thead><tbody>
        ${[['Venta', usd(sA.v), usd(sB.v), pct(sA.v, sB.v)], ['Pedidos', sA.n, sB.n, pct(sA.n, sB.n)], ['Clientes que compraron', sA.cl, sB.cl, pct(sA.cl, sB.cl)], ['Pedido promedio', usd(sA.tk), usd(sB.tk), pct(sA.tk, sB.tk)], ['Productos distintos por pedido', sA.sk, sB.sk, pct(sA.sk, sB.sk)]].map(([k, a, b, x]) => `<tr><td>${k}</td><td class="n">${a}</td><td class="n">${b}</td><td class="n">${arrow(x)}</td></tr>`).join('')}</tbody></table></div>
      ${topNuevos.size ? `<div class="section-title">💡 Lo que los clientes empezaron a comprar desde la vitrina</div><div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Producto</th><th class="n">Clientes nuevos</th><th class="n">Venta $</th></tr></thead><tbody>${[...topNuevos.values()].sort((a, b) => b.n - a.n).slice(0, 20).map((t) => `<tr><td>${esc(t.name)}</td><td class="n">${t.n}</td><td class="n">${usd(r2(t.v))}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <div class="section-title">Por vendedor (período A)</div>
      <div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Vendedor</th><th class="n">Pedidos</th><th class="n">Usa la vitrina</th><th class="n">Ticket con vitrina</th><th class="n">Ticket sin vitrina</th><th class="n">Venta</th></tr></thead><tbody>
        ${vrows.map((x) => `<tr><td>${esc(x.k)}</td><td class="n">${x.n}</td><td class="n"><b>${x.ad}%</b></td><td class="n">${x.tc ? usd(x.tc) : '—'}</td><td class="n">${x.ts ? usd(x.ts) : '—'}</td><td class="n">${usd(x.v)}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Sin pedidos en el período.</td></tr>'}</tbody></table></div>`;
    const q = (x) => body.querySelector(x);
    q('#imPre').onchange = (e) => { ui.pre = e.target.value; impacto(body); };
    ['imA1', 'imA2', 'imB1', 'imB2'].forEach((id) => { const el = q('#' + id); if (el) el.onchange = (e) => { ui[id.slice(2).toLowerCase()] = e.target.value; impacto(body); }; });
    q('#imX').onclick = () => global.Exporta.save(`impacto_vitrina_${A1}_${A2}.xlsx`, [
      global.Exporta.table({ name: 'Resumen', title: 'IMPACTO DE LA VITRINA', subtitle: `A: ${A1} a ${A2} · B: ${B1} a ${B2}`, cols: [{ h: 'INDICADOR', w: 36 }, { h: 'A', w: 14 }, { h: 'B', w: 14 }, { h: 'CAMBIO %', k: 'int' }],
        rows: [['Venta $', sA.v, sB.v, pct(sA.v, sB.v) ?? ''], ['Pedidos', sA.n, sB.n, pct(sA.n, sB.n) ?? ''], ['Clientes', sA.cl, sB.cl, pct(sA.cl, sB.cl) ?? ''], ['Pedido promedio $', sA.tk, sB.tk, pct(sA.tk, sB.tk) ?? ''], ['Productos por pedido', sA.sk, sB.sk, pct(sA.sk, sB.sk) ?? ''],
          ['Pedidos con vitrina', sC.n, '', ''], ['Ticket con vitrina $', sC.tk, '', ''], ['Ticket sin vitrina $', sS.tk, '', ''], ['Venta desde la vitrina $', ventaVt, '', ''], ['Productos nuevos para el cliente', nuevosN, '', ''], ['Clientes con productos nuevos', nuevosCl.size, '', '']] }),
      global.Exporta.table({ name: 'Vendedores', title: 'USO DE LA VITRINA POR VENDEDOR', subtitle: `${A1} a ${A2}`, cols: [{ h: 'VENDEDOR', w: 24 }, { h: 'PEDIDOS', k: 'int' }, { h: 'USA LA VITRINA %', k: 'int' }, { h: 'TICKET CON $', k: 'money' }, { h: 'TICKET SIN $', k: 'money' }, { h: 'VENTA $', k: 'money', total: true }],
        rows: vrows.map((x) => [x.k, x.n, x.ad, x.tc, x.ts, x.v]) }),
    ]);
  }

  /* ---------------- Resultados: ¿funcionó la campaña? ---------------- */
  // Con los pedidos que hay en este equipo (la oficina guarda 400 días): combos vendidos y ventas de cada vitrina en sus
  // fechas contra el mismo número de días justo antes (crecimiento). Pedidos eliminados no cuentan.
  function resultados(body) {
    const P = PV(), S = P.S, { esc, usd } = P, d = data(), ui = (S.ui.mktRes = S.ui.mktRes || {});
    const c0 = d.campana || {}, hoy = P.today();
    const addD = (day, n) => new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
    const desde = ui.desde || c0.desde || addD(hoy, -30), hasta = ui.hasta || (c0.hasta && c0.hasta < hoy ? c0.hasta : hoy);
    const vivos = S.orders.filter((o) => !o.deleted && o.status !== 'abierto');
    const inR = (o, a, b) => String(o.routeDate || '') >= a && String(o.routeDate || '') <= b;
    const montoOf = (o) => (o.delivery && o.delivery.at ? +o.delivery.monto || 0 : global.Matrix.orderTotals(o).monto);
    // Combos vendidos en el rango
    const cmb = new Map(), porVend = new Map();
    vivos.filter((o) => inR(o, desde, hasta) && o.combos).forEach((o) => Object.entries(o.combos).forEach(([id, x]) => {
      const n = +x.n || 0; if (!n) return;
      const r = cmb.get(id) || { id, nombre: x.nombre || id, n: 0, clientes: new Set(), monto: 0, ahorro: 0 };
      r.n += n; r.clientes.add(o.clientId); r.monto += (+x.precio || 0) * n; r.ahorro += +x.ahorro || 0; cmb.set(id, r);
      const v = porVend.get(o.sellerName || o.sellerId) || { n: 0, monto: 0 }; v.n += n; v.monto += (+x.precio || 0) * n; porVend.set(o.sellerName || o.sellerId, v);
    }));
    // Vitrinas: ventas de sus productos en sus fechas (o en el rango) contra el período anterior del mismo largo
    const span = (a, b) => Math.max(1, Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000) + 1);
    const ventas = (ids, a, b) => { let m = 0, cj = 0, cl = new Set(); vivos.filter((o) => inR(o, a, b)).forEach((o) => { let hit = false; Object.entries(o.lines || {}).forEach(([pid, l]) => { if (!ids.has(pid)) return; m += global.Matrix.lineTotals(l).monto; cj += +l.cajas || 0; hit = true; }); if (hit) cl.add(o.clientId); }); return { m: r2(m), cj, cl: cl.size }; };
    const vit = d.vitrinas.map((v) => {
      const a = v.desde && v.desde > desde ? v.desde : desde, b = v.hasta && v.hasta < hasta ? v.hasta : hasta; if (a > b) return null;
      const ids = new Set(productsOf(v).map((p) => p.id)); if (!ids.size) return null;
      const n = span(a, b), now = ventas(ids, a, b), antes = ventas(ids, addD(a, -n), addD(a, -1));
      return { v, a, b, now, antes, pct: antes.m > 0 ? Math.round(((now.m - antes.m) / antes.m) * 100) : null };
    }).filter(Boolean);
    const tot = [...cmb.values()].reduce((x, r) => ({ n: x.n + r.n, monto: x.monto + r.monto, ahorro: x.ahorro + r.ahorro }), { n: 0, monto: 0, ahorro: 0 });
    const ventaTot = r2(vivos.filter((o) => inR(o, desde, hasta)).reduce((a, o) => a + montoOf(o), 0));
    body.innerHTML = `<div class="row wrap" style="gap:8px;align-items:flex-end"><label class="field"><span>Desde</span><input id="rsD" type="date" class="input" value="${esc(desde)}"></label><label class="field"><span>Hasta</span><input id="rsH" type="date" class="input" value="${esc(hasta)}"></label>
        <span class="grow"></span><button class="btn" id="rsX">⇩ Excel</button></div>
      <div class="kpis big" style="margin:10px 0"><span><b>${tot.n}</b> combos vendidos</span><span><b>${usd(tot.monto)}</b> en combos</span><span><b>${usd(tot.ahorro)}</b> de ahorro dado a clientes</span><span><b>${usd(ventaTot)}</b> venta total del período</span></div>
      <div class="section-title">🎁 Combos</div>
      ${cmb.size ? `<div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Combo</th><th class="n">Vendidos</th><th class="n">Clientes</th><th class="n">Venta $</th><th class="n">Ahorro dado</th></tr></thead><tbody>${[...cmb.values()].sort((a, b) => b.n - a.n).map((r) => `<tr><td><b>${esc(r.nombre)}</b></td><td class="n">${r.n}</td><td class="n">${r.clientes.size}</td><td class="n">${usd(r.monto)}</td><td class="n">${usd(r.ahorro)}</td></tr>`).join('')}</tbody></table></div>
        <div class="section-title">Por vendedor</div><div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Vendedor</th><th class="n">Combos</th><th class="n">Venta $</th></tr></thead><tbody>${[...porVend.entries()].sort((a, b) => b[1].n - a[1].n).map(([k, x]) => `<tr><td>${esc(k)}</td><td class="n">${x.n}</td><td class="n">${usd(x.monto)}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted">Aún no se han vendido combos en este período.</p>'}
      <div class="section-title">🛍 Vitrinas: venta de sus productos contra el período anterior</div>
      <div class="card" style="overflow:auto"><table class="inv"><thead><tr><th>Vitrina</th><th>Fechas</th><th class="n">Venta $</th><th class="n">Cajas</th><th class="n">Clientes</th><th class="n">Antes $</th><th class="n">Crecimiento</th></tr></thead><tbody>
        ${vit.map((x) => `<tr><td>${esc(x.v.icono || '')} <b>${esc(x.v.nombre)}</b></td><td><small>${esc(P.fmtDate(x.a))} – ${esc(P.fmtDate(x.b))}</small></td><td class="n">${usd(x.now.m)}</td><td class="n">${x.now.cj}</td><td class="n">${x.now.cl}</td><td class="n">${usd(x.antes.m)}</td>
          <td class="n ${x.pct === null ? '' : x.pct >= 0 ? 'pay-ok' : 'warn-txt'}"><b>${x.pct === null ? (x.now.m ? 'nuevo' : '—') : (x.pct >= 0 ? '▲ +' : '▼ ') + x.pct + '%'}</b></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Sin vitrinas con productos en este período.</td></tr>'}</tbody></table></div>
      <p class="muted" style="font-size:13px">«Antes» = los mismos días justo antes de la vitrina. Se cuentan los pedidos enviados, en hoja o despachados que hay en este equipo.</p>`;
    const q = (x) => body.querySelector(x);
    q('#rsD').onchange = (e) => { ui.desde = e.target.value; resultados(body); };
    q('#rsH').onchange = (e) => { ui.hasta = e.target.value; resultados(body); };
    q('#rsX').onclick = () => global.Exporta.save(`resultados_campana_${desde}_${hasta}.xlsx`, [
      global.Exporta.table({ name: 'Combos', title: 'COMBOS VENDIDOS', subtitle: `Del ${desde} al ${hasta}`, cols: [{ h: 'COMBO', w: 34 }, { h: 'VENDIDOS', k: 'int', total: true }, { h: 'CLIENTES', k: 'int' }, { h: 'VENTA $', k: 'money', total: true }, { h: 'AHORRO DADO', k: 'money', total: true }],
        rows: [...cmb.values()].map((r) => [r.nombre, r.n, r.clientes.size, r2(r.monto), r2(r.ahorro)]) }),
      global.Exporta.table({ name: 'Vitrinas', title: 'VITRINAS: VENTA CONTRA EL PERÍODO ANTERIOR', subtitle: `Del ${desde} al ${hasta}`, cols: [{ h: 'VITRINA', w: 40 }, { h: 'DESDE', w: 12 }, { h: 'HASTA', w: 12 }, { h: 'VENTA $', k: 'money', total: true }, { h: 'CAJAS', k: 'int', total: true }, { h: 'CLIENTES', k: 'int' }, { h: 'ANTES $', k: 'money', total: true }, { h: 'CRECIMIENTO %', k: 'int' }],
        rows: vit.map((x) => [x.v.nombre, x.a, x.b, x.now.m, x.now.cj, x.now.cl, x.antes.m, x.pct === null ? '' : x.pct]) }),
    ]);
  }

  /* ---------------- Campaña (encabezado con cuenta regresiva + carga de la campaña navideña) ---------------- */
  function campanaForm(body, done) {
    const P = PV(), { esc, toast } = P, d = data(), c = d.campana || { activa: false, tema: 'navidad', titulo: '', frase: '', meta: '', metaLbl: '' };
    const has = (arr, id) => arr.some((x) => x.id === id);
    const faltan = NAV.vitrinas.filter((v) => !has(d.vitrinas, v.id)).length + NAV.mezclas.filter((x) => !has(d.mezclas, x.id)).length + NAV.combos.filter((x) => !has(d.combos, x.id)).length;
    const lz = d.lanzamiento;
    body.innerHTML = `<div class="card card-pad mk-launch ${lz && lz.lanzada ? 'on' : ''}"><div class="row wrap" style="gap:10px;align-items:center"><div class="grow">
        ${lz && lz.lanzada ? `<h3 style="margin:0">🚀 Vitrina lanzada</h3><p class="muted" style="margin:4px 0 0">Los vendedores la ven desde el ${esc(P.fmtDate(String(lz.at).slice(0, 10)))}${lz.by ? ' (lanzó ' + esc(lz.by) + ')' : ''}.</p>`
          : '<h3 style="margin:0">🔒 Vitrina en preparación</h3><p class="muted" style="margin:4px 0 0">Los vendedores todavía <b>no la ven</b>. Gerencia puede probarla en «Tomar pedido». Cuando esté lista, lánzala.</p>'}</div>
        <button class="btn" id="cmPrev">👁 Vista previa</button>${lz && lz.lanzada ? '<button class="btn btn-danger" id="cmOff">Ocultar de nuevo</button>' : '<button class="btn btn-primary" id="cmLaunch">🚀 Lanzar la vitrina</button>'}</div></div>
      <div class="card card-pad mk-camp-pre">${campanaHTML() || '<p class="muted">La campaña no está visible hoy (apagada o fuera de fechas).</p>'}</div>
      ${faltan ? `<div class="hint">🎄 <b>Campaña navideña lista para cargar</b>: ${NAV.vitrinas.length} vitrinas por etapa (Feria de la Chinita → Hallaquiada → Patinatas → Nochebuena → Año Nuevo), ${NAV.mezclas.length} mezclas y ${NAV.combos.length} combos en borrador para que les pongas precio y Gerencia los autorice. Cada vitrina aparece sola en sus fechas.
        <div style="margin-top:8px"><button class="btn btn-primary" id="cmLoad">✨ Cargar la campaña navideña</button></div></div>` : '<div class="hint">✅ La campaña navideña ya está cargada: revisa las vitrinas y ponles precio a los combos.</div>'}
      <div class="card card-pad"><h3 style="margin-top:0">Encabezado de la campaña</h3>
        <label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="cmOn" ${c.activa ? 'checked' : ''}> Mostrar el encabezado en la vitrina del vendedor</label>
        <div class="row wrap" style="gap:8px"><label class="field grow"><span>Título</span><input id="cmT" class="input" maxlength="70" value="${esc(c.titulo || '')}"></label>
          <label class="field"><span>Decoración</span><select id="cmTema" class="select"><option value="navidad" ${c.tema === 'navidad' ? 'selected' : ''}>🎄 Navidad (luces)</option><option value="fiesta" ${c.tema === 'fiesta' ? 'selected' : ''}>🎉 Fiesta</option><option value="simple" ${c.tema === 'simple' ? 'selected' : ''}>Sencilla</option></select></label></div>
        <label class="field"><span>Frase</span><input id="cmF" class="input" maxlength="140" value="${esc(c.frase || '')}"></label>
        <div class="row wrap" style="gap:8px"><label class="field"><span>Cuenta regresiva hasta</span><input id="cmM" type="date" class="input" value="${esc(c.meta || '')}"></label><label class="field"><span>…para</span><input id="cmML" class="input" maxlength="30" value="${esc(c.metaLbl || '')}" placeholder="Nochebuena"></label>
          <label class="field"><span>Se muestra desde</span><input id="cmD" type="date" class="input" value="${esc(c.desde || '')}"></label><label class="field"><span>hasta</span><input id="cmH" type="date" class="input" value="${esc(c.hasta || '')}"></label></div>
        <div class="actions"><button class="btn btn-primary" id="cmOk">Guardar encabezado</button></div></div>`;
    const q = (x) => body.querySelector(x);
    const who = (P.S.settings && P.S.settings.userName) || (P.S.config && P.S.config.adminName) || 'Oficina';
    const lb = q('#cmLaunch');
    if (lb) lb.onclick = async () => { if (!confirm('¿Lanzar la vitrina? Desde ahora todos los vendedores la ven en «Tomar pedido».')) return; await save({ lanzamiento: { lanzada: true, at: new Date().toISOString(), by: who } }, '🚀 Lanzó la vitrina'); toast('🚀 Vitrina lanzada: ya la ven los vendedores', 'ok'); done(); };
    const lo = q('#cmOff');
    if (lo) lo.onclick = async () => { if (!confirm('¿Ocultar la vitrina a los vendedores?')) return; await save({ lanzamiento: { lanzada: false, at: new Date().toISOString(), by: who } }, 'Ocultó la vitrina a los vendedores'); done(); };
    q('#cmPrev').onclick = () => preview();
    const ld = q('#cmLoad');
    if (ld) ld.onclick = async () => {
      const v = d.vitrinas.concat(NAV.vitrinas.filter((x) => !has(d.vitrinas, x.id)));
      const m = d.mezclas.concat(NAV.mezclas.filter((x) => !has(d.mezclas, x.id)));
      // Combos en borrador: sus productos se buscan en el catálogo y el precio arranca igual a lo que vale por separado
      const cb = d.combos.concat(NAV.combos.filter((x) => !has(d.combos, x.id)).map((x) => {
        const items = x.items.map((it) => { const p = itemProduct(it); return { pid: p ? p.id : '', q: it.q, cajas: it.cajas, unidades: it.unidades }; });
        const al = comboAlloc({ items, precio: 0 }, catPrices);
        return { ...x, items, precio: al ? al.S : 0, estado: 'pendiente' };
      }));
      await save({ vitrinas: v, mezclas: m, combos: cb, campana: d.campana || NAV.campana }, 'Cargó la campaña navideña');
      toast('Campaña navideña cargada: ponles precio a los combos y que Gerencia los autorice', 'ok'); done();
    };
    q('#cmOk').onclick = async () => {
      const nc = { activa: q('#cmOn').checked, tema: q('#cmTema').value, titulo: q('#cmT').value.trim(), frase: q('#cmF').value.trim(), meta: q('#cmM').value, metaLbl: q('#cmML').value.trim(), desde: q('#cmD').value, hasta: q('#cmH').value };
      if (nc.activa && !nc.titulo) { toast('Ponle un título a la campaña', 'err'); return; }
      await save({ campana: nc }, `Campaña: «${nc.titulo}» ${nc.activa ? 'visible' : 'apagada'}`); toast('Campaña guardada', 'ok'); done();
    };
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
      <details class="mk-bn" open><summary><b>🎨 Banner</b> <span class="muted">fondo, colores, letras y posición</span></summary>
        <div id="veBnPrev" class="vt" style="margin:8px 0"></div>
        <div class="row wrap" style="gap:8px;align-items:flex-end">
          <label class="field"><span>Fondo</span><select id="bnF" class="select"><option value="tono">Color de la vitrina</option><option value="colores">Dos colores</option><option value="imagen">Imagen propia</option></select></label>
          <label class="field bn-col"><span>Color 1</span><input id="bnC1" type="color" class="input"></label><label class="field bn-col"><span>Color 2</span><input id="bnC2" type="color" class="input"></label>
          <label class="field bn-col"><span>Ángulo</span><input id="bnA" type="range" min="0" max="360" step="15"></label>
          <label class="field bn-img"><span>Imagen (se ajusta sola)</span><input id="bnI" type="file" accept="image/*" class="input"></label>
          <label class="field bn-img"><span>Oscurecer la imagen</span><input id="bnO" type="range" min="0" max="80" step="5"></label></div>
        <div class="row wrap" style="gap:8px;align-items:flex-end">
          <label class="field"><span>Color de las letras</span><input id="bnT" type="color" class="input"></label>
          <label class="field"><span>Letras</span><select id="bnAl" class="select"><option value="izq">A la izquierda</option><option value="centro">Al centro</option><option value="der">A la derecha</option></select></label>
          <label class="field"><span>Altura</span><select id="bnV" class="select"><option value="arriba">Arriba</option><option value="centro">En medio</option><option value="abajo">Abajo</option></select></label>
          <label class="field"><span>Título</span><select id="bnTam" class="select"><option value="normal">Normal</option><option value="grande">Grande</option><option value="enorme">Enorme</option></select></label>
          <label class="chip-check"><input type="checkbox" id="bnCo"> Fotos de productos</label></div></details>
      <div class="row wrap" style="gap:8px"><label class="field grow"><span>Sello para sus 3 más pedidos</span><input id="veS" class="input" maxlength="40" value="${esc(v.sello || '')}" placeholder="Ej.: 💛 Lo más pedido por las mamás"></label>
        <label class="field"><span>Orden</span><select id="veO" class="select">${[['ventas', 'Más vendidos primero'], ['peso', 'Por peso / tamaño (120 g, 340 g, 500 g…)'], ['nombre', 'Por nombre'], ['manual', 'A mano (los agregados, en su orden)']].map(([k, l]) => `<option value="${k}" ${v.orden === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <label class="field"><span>Qué productos entran: palabras (marca, tipo, sabor…), separadas por coma</span><input id="veB" class="input" value="${esc((v.buscar || []).join(', '))}" placeholder="Ej.: salsa, quiero"></label>
      <div class="field"><span>…o categorías completas</span><div class="mk-cats">${cats.map((c) => `<label class="chip-check"><input type="checkbox" data-cat="${esc(c)}" ${v.cats.includes(c) ? 'checked' : ''}> ${esc(c)}</label>`).join('')}</div></div>
      <div class="field mk-pick" id="veAdd"><span>Agregar un producto a mano</span><input class="input" placeholder="Buscar producto…" autocomplete="off"><div class="mk-res"></div></div>
      <div class="row wrap" style="gap:8px"><label class="field"><span>📅 Se muestra desde (opcional)</span><input id="veD" type="date" class="input" value="${esc(v.desde || '')}"></label>
        <label class="field"><span>hasta</span><input id="veH" type="date" class="input" value="${esc(v.hasta || '')}"></label><small class="muted" style="align-self:center">Para temporadas: Navidad, Carnaval, Día de las Madres, Regreso a clases…</small></div>
      <label style="display:flex;gap:8px;align-items:center;margin:6px 0"><input type="checkbox" id="veA" ${v.adultos ? 'checked' : ''}> 🔞 Bebidas alcohólicas: «Solo mayores de 18 · Consumo responsable»</label>
      <div class="section-title">Vista previa · <span id="veCnt"></span></div><div id="veList" class="mk-prev"></div>
      <div class="actions">${isNew ? '' : '<button class="btn btn-danger" id="veDel">Eliminar</button>'}<span class="grow"></span><button class="btn btn-primary" id="veOk">Guardar vitrina</button></div>`, { wide: true });
    const q = (s) => sh.el.querySelector(s);
    // Banner: valores en los controles y vista previa en vivo
    v.banner = { ...BN_DEF, ...(v.banner || {}) };
    let newImg = null;
    const bset = () => { const b = v.banner; q('#bnF').value = b.fondo; q('#bnC1').value = b.c1; q('#bnC2').value = b.c2; q('#bnA').value = b.angulo; q('#bnO').value = b.oscurecer; q('#bnT').value = b.texto; q('#bnAl').value = b.alinear; q('#bnV').value = b.vertical; q('#bnTam').value = b.tam; q('#bnCo').checked = b.collage !== false; };
    const bread = () => { Object.assign(v.banner, { fondo: q('#bnF').value, c1: q('#bnC1').value, c2: q('#bnC2').value, angulo: +q('#bnA').value, oscurecer: +q('#bnO').value, texto: q('#bnT').value, alinear: q('#bnAl').value, vertical: q('#bnV').value, tam: q('#bnTam').value, collage: q('#bnCo').checked }); };
    const bprev = () => {
      bread();
      sh.el.querySelectorAll('.bn-col').forEach((x) => { x.style.display = v.banner.fondo === 'colores' ? '' : 'none'; });
      sh.el.querySelectorAll('.bn-img').forEach((x) => { x.style.display = v.banner.fondo === 'imagen' ? '' : 'none'; });
      const S = PV().S, keep = S.banners; if (newImg) S.banners = { ...(keep || {}), ['bn_' + v.id]: { image: newImg } };
      const vv = { ...v, nombre: q('#veN').value.trim() || 'Nombre de la vitrina', frase: q('#veF').value.trim(), icono: q('#veI').value.trim(), banner: { ...v.banner, img: newImg ? 'bn_' + v.id : v.banner.img } };
      q('#veBnPrev').style.setProperty('--h', +v.hue || 0);
      q('#veBnPrev').innerHTML = banner(vv, productsOf(vv));
      if (newImg) S.banners = keep;
    };
    bset();
    q('#bnI').onchange = async (e) => { const f = e.target.files && e.target.files[0]; if (!f) return; try { newImg = await bannerImage(f); if (!newImg) toast('La imagen es muy pesada: prueba con otra más liviana', 'err'); } catch (err) { toast(err.message, 'err'); } bprev(); };
    sh.el.addEventListener('input', (e) => { if (e.target.closest('.mk-bn') || ['veN', 'veF', 'veI'].includes(e.target.id)) bprev(); });
    sh.el.addEventListener('change', (e) => { if (e.target.closest('.mk-bn')) bprev(); });
    sh.el.addEventListener('click', (e) => { if (e.target.closest('[data-hue]')) setTimeout(bprev, 0); });
    setTimeout(bprev, 0);
    const read = () => { v.icono = q('#veI').value.trim(); v.nombre = q('#veN').value.trim(); v.frase = q('#veF').value.trim(); v.sello = q('#veS').value.trim(); v.orden = q('#veO').value; v.adultos = q('#veA').checked; v.desde = q('#veD').value; v.hasta = q('#veH').value;
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
      if (v.desde && v.hasta && v.hasta < v.desde) { toast('La fecha «hasta» es antes de «desde»', 'err'); return; }
      if (!v.desde) delete v.desde; if (!v.hasta) delete v.hasta;
      bread();
      if (v.banner.fondo === 'imagen' && !newImg && !v.banner.img) { toast('Elige la imagen del banner (o cambia el fondo)', 'err'); return; }
      if (newImg) { await P.saveDocs('config', { id: 'bn_' + v.id, image: newImg }); v.banner.img = 'bn_' + v.id; v.banner.imgAt = new Date().toISOString(); }
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

  /** Vista previa de la vitrina tal como la verá el vendedor (sin cliente: solo para mirar). */
  function preview() {
    const P = PV(), sh = P.openSheet(`<div class="row"><h2 class="grow">👁 Vista previa de la vitrina</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Así la verá el vendedor en la tablet. Para probar agregar productos, Gerencia puede usarla en «Tomar pedido».</p><div class="plist vt-mode vt-preview">${renderSeller(null)}</div>`, { wide: true });
    afterRender(sh.el);
    sh.el.addEventListener('click', (e) => { const go = e.target.closest('[data-vgo]'); if (go) { const t = sh.el.querySelector('#vt-' + CSS.escape(go.dataset.vgo)); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } });
  }

  global.Mkt = { enabled, lanzada, preview, data, comboV, comboOk, comboAlloc, comboLive, applyCmb, addCombo, NAV, productsOf, sizeOf, itemProduct, renderSeller, afterRender, onSellerClick, siempreOf, combinaCon, ficha, visible, render, DEF_VITRINAS, DEF_MEZCLAS };
})(window);
