/**
 * RESUMEN DE QUINCENA (para pagos): vendedores y despachadores (incluido el depósito / retiro por oficina) con lo
 * liquidado en las categorías elegidas y los vacíos devueltos por tipo. Los totales de vendedores y despachadores
 * tienen que coincidir. Al final, la comparación con el período anterior.
 * Usa los datos de /api/pedidos/quincena (los mismos del reporte); no cambia nada.
 */
(function (global) {
  'use strict';
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const add = (a, x) => { a.cajas += x.cajas || 0; a.unidades += x.unidades || 0; a.monto += x.monto || 0; return a; };
  const zero = () => ({ cajas: 0, unidades: 0, monto: 0 });

  /** Período anterior: la quincena anterior si el rango es una quincena; si no, los mismos días justo antes. */
  function prevRange(from, to) {
    const d = (s) => new Date(s + 'T12:00:00Z'), iso = (x) => x.toISOString().slice(0, 10);
    const f = d(from), t = d(to), last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0, 12)).getUTCDate();
    if (f.getUTCDate() === 16 && t.getUTCDate() === last && f.getUTCMonth() === t.getUTCMonth()) return { from: from.slice(0, 8) + '01', to: from.slice(0, 8) + '15' };
    if (f.getUTCDate() === 1 && t.getUTCDate() === 15 && f.getUTCMonth() === t.getUTCMonth()) {
      const p = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), 0, 12));
      return { from: iso(p).slice(0, 8) + '16', to: iso(p) };
    }
    const n = Math.round((t - f) / 86400000) + 1;
    return { from: iso(new Date(f - n * 86400000)), to: iso(new Date(f - 86400000)) };
  }

  /** Datos del resumen para las categorías elegidas. */
  function model(d, cats, prev) {
    const set = new Set(cats), V = d.vacios || {};
    const types = [...new Set([...(V.bySeller || []), ...(V.byDispatcher || [])].filter((v) => v.recibidos + (v.anteriores || 0) > 0).map((v) => v.type))]
      .sort((a, b) => parseFloat(String(a).replace(',', '.')) - parseFloat(String(b).replace(',', '.')) || String(a).localeCompare(String(b)));
    const side = (catArr, vacArr) => {
      const m = new Map(), get = (name) => m.get(name) || m.set(name, { name, cells: {}, vac: {}, total: zero(), vacTot: 0 }).get(name);
      (catArr || []).forEach((x) => { if (!set.has(x.category)) return; const p = get(x.name); add(p.cells[x.category] || (p.cells[x.category] = zero()), x); add(p.total, x); });
      (vacArr || []).forEach((v) => { const q = v.recibidos + (v.anteriores || 0); if (!q) return; const p = get(v.name); p.vac[v.type] = (p.vac[v.type] || 0) + q; p.vacTot += q; });
      const rows = [...m.values()].filter((p) => p.total.cajas || p.total.unidades || p.total.monto || p.vacTot)
        .sort((a, b) => b.total.monto - a.total.monto || a.name.localeCompare(b.name, 'es'));
      const cols = {}; cats.forEach((c) => { cols[c] = zero(); rows.forEach((p) => p.cells[c] && add(cols[c], p.cells[c])); });
      const vac = {}; types.forEach((t) => { vac[t] = rows.reduce((a, p) => a + (p.vac[t] || 0), 0); });
      const total = rows.reduce((a, p) => add(a, p.total), zero());
      return { rows, cols, vac, total, vacTot: Object.values(vac).reduce((a, x) => a + x, 0) };
    };
    const sellers = side(d.byCategorySeller, V.bySeller), disps = side(d.byCategoryDispatcher, V.byDispatcher);
    // Cuadre: cada categoría y cada tipo de vacío igual en vendedores y despachadores
    const diffs = [];
    cats.forEach((c) => { const a = sellers.cols[c], b = disps.cols[c]; if (a.cajas !== b.cajas || a.unidades !== b.unidades || Math.abs(r2(a.monto) - r2(b.monto)) >= 0.01) diffs.push(c); });
    types.forEach((t) => { if (sellers.vac[t] !== disps.vac[t]) diffs.push('vacíos ' + t); });
    // Comparación con el período anterior (por categoría elegida)
    const catTot = (dd) => { const o = {}; ((dd && dd.byCategory) || []).forEach((x) => { if (set.has(x.category)) o[x.category] = add(zero(), x); }); return o; };
    const now = catTot(d), before = prev ? catTot(prev) : null;
    const compare = before ? cats.map((c) => ({ category: c, now: now[c] || zero(), prev: before[c] || zero() })).filter((x) => x.now.monto || x.prev.monto || x.now.cajas || x.prev.cajas) : null;
    return {
      from: d.from, to: d.to, cats, types,
      kpis: { cargadas: (d.totals.hojas || 0) + (d.pendingLoads || []).length, liquidadas: d.totals.hojas || 0, sinLiquidar: (d.pendingLoads || []).length, clientes: d.totals.clients || 0 },
      sellers, disps, ok: !diffs.length, diffs, compare, prev: prev ? { from: prev.from, to: prev.to } : null,
    };
  }

  /** Nombre del tipo de vacío: un retornable «aparte» se cuenta con su código → se le agrega el nombre. */
  function typeLabel(t, products) {
    const p = (products || []).find((x) => !x.deleted && String(x.code) === String(t) && x.ret && typeof x.ret === 'object' && !x.ret.type);
    return p ? `${t} ${p.name}` : String(t);
  }

  /** Tablas del resumen (pantalla e impresión). */
  function html(m, o) {
    const { esc, nf0, usd } = o, cls = o.print ? 'rq' : 'inv rq';
    const q = (x) => (x && (x.cajas || x.unidades || x.monto) ? `<b class="rq-cj">${nf0.format(x.cajas)}${x.unidades ? ` <small>+${nf0.format(x.unidades)} un</small>` : ''}</b><div class="rq-usd">${usd(x.monto)}</div>` : '<span class="muted">·</span>');
    const tl = (t) => esc(typeLabel(t, o.products));
    const table = (title, who, s) => `<h3 class="rq-h">${esc(title)}</h3><div style="overflow:auto"><table class="${cls}">
      <thead><tr><th rowspan="2">${esc(who)}</th><th colspan="${m.cats.length}">Liquidado por categoría (cajas · $)</th><th rowspan="2" class="rq-tot">TOTAL</th>${m.types.length ? `<th colspan="${m.types.length + 1}">Vacíos devueltos</th>` : ''}</tr>
        <tr>${m.cats.map((c) => `<th>${esc(c)}</th>`).join('')}${m.types.length ? m.types.map((t) => `<th>${tl(t)}</th>`).join('') + '<th>Total vacíos</th>' : ''}</tr></thead>
      <tbody>${s.rows.map((p) => `<tr><td><b>${esc(p.name)}</b></td>${m.cats.map((c) => `<td class="n">${q(p.cells[c])}</td>`).join('')}<td class="n rq-tot">${q(p.total)}</td>${m.types.length ? m.types.map((t) => `<td class="n">${p.vac[t] ? nf0.format(p.vac[t]) : '·'}</td>`).join('') + `<td class="n"><b>${nf0.format(p.vacTot)}</b></td>` : ''}</tr>`).join('') || `<tr><td colspan="${m.cats.length + m.types.length + 3}" class="muted">Sin datos</td></tr>`}</tbody>
      <tfoot><tr class="rq-foot"><td>TOTAL</td>${m.cats.map((c) => `<td class="n">${q(s.cols[c])}</td>`).join('')}<td class="n rq-tot">${q(s.total)}</td>${m.types.length ? m.types.map((t) => `<td class="n">${nf0.format(s.vac[t])}</td>`).join('') + `<td class="n">${nf0.format(s.vacTot)}</td>` : ''}</tr></tfoot></table></div>`;
    const k = m.kpis;
    const pct = (a, b) => (b ? `${a >= b ? '▲' : '▼'} ${Math.abs(Math.round(((a - b) / b) * 1000) / 10).toLocaleString('es-VE')} %` : a ? 'nuevo' : '—');
    const cmp = m.compare ? (() => {
      const tn = m.compare.reduce((a, x) => add(a, x.now), zero()), tp = m.compare.reduce((a, x) => add(a, x.prev), zero());
      return `<h3 class="rq-h">Comparación con el período anterior <small class="muted">(${esc(o.fmtDate(m.prev.from))} al ${esc(o.fmtDate(m.prev.to))})</small></h3>
        <p class="rq-line"><b>${tn.monto >= tp.monto ? '▲ Subió' : '▼ Bajó'} ${usd(Math.abs(r2(tn.monto - tp.monto)))}</b> en las categorías elegidas (${usd(tp.monto)} → ${usd(tn.monto)}, ${pct(tn.monto, tp.monto)}) · cajas ${nf0.format(tp.cajas)} → ${nf0.format(tn.cajas)}.</p>
        <table class="${cls}"><thead><tr><th>Categoría</th><th>Anterior · cajas</th><th>Ahora · cajas</th><th>Anterior · $</th><th>Ahora · $</th><th>Cambio</th></tr></thead>
        <tbody>${m.compare.map((x) => `<tr><td><b>${esc(x.category)}</b></td><td class="n">${nf0.format(x.prev.cajas)}</td><td class="n">${nf0.format(x.now.cajas)}</td><td class="n">${usd(x.prev.monto)}</td><td class="n">${usd(x.now.monto)}</td><td class="n ${x.now.monto < x.prev.monto ? 'warn-txt' : ''}"><b>${pct(x.now.monto, x.prev.monto)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr class="rq-foot"><td>TOTAL</td><td class="n">${nf0.format(tp.cajas)}</td><td class="n">${nf0.format(tn.cajas)}</td><td class="n">${usd(tp.monto)}</td><td class="n">${usd(tn.monto)}</td><td class="n">${pct(tn.monto, tp.monto)}</td></tr></tfoot></table>`;
    })() : (o.prevLoading ? '<p class="muted">Calculando la comparación con el período anterior…</p>' : '');
    return `<div class="rq-kpis"><div><small>Hojas cargadas</small><b>${nf0.format(k.cargadas)}</b></div><div><small>Hojas liquidadas</small><b>${nf0.format(k.liquidadas)}</b>${k.sinLiquidar ? `<small class="warn-txt">${k.sinLiquidar} sin liquidar</small>` : ''}</div><div><small>Clientes atendidos</small><b>${nf0.format(k.clientes)}</b></div><div><small>Total liquidado (categorías elegidas)</small><b>${usd(m.sellers.total.monto)}</b><small>${nf0.format(m.sellers.total.cajas)} cajas${m.sellers.total.unidades ? ' + ' + nf0.format(m.sellers.total.unidades) + ' un' : ''}</small></div></div>
      ${m.ok ? '<p class="rq-ok">✓ Los totales de vendedores y despachadores coinciden.</p>' : `<p class="rq-bad">⚠ No coinciden: ${esc(m.diffs.join(', '))}. Revisa las hojas sin despachador en el reporte.</p>`}
      ${table('Vendedores', 'Vendedor', m.sellers)}
      ${table('Despachadores (incluye depósito / retiro por oficina)', 'Despachador', m.disps)}
      ${cmp}`;
  }

  /** Excel con fórmulas: por persona la suma de sus categorías; abajo la suma de cada columna. */
  function excel(m, o) {
    const X = global.Exporta, S = X.S, col = (i) => { let s = ''; i++; while (i) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };
    const rows = [[{ v: o.title, s: S.title }], [{ v: `Del ${o.fmtDate(m.from)} al ${o.fmtDate(m.to)} · Hojas cargadas ${m.kpis.cargadas} · liquidadas ${m.kpis.liquidadas} · clientes atendidos ${m.kpis.clientes} · categorías: ${m.cats.join(', ')}`, s: S.sub }], []];
    const n = (v, f, b) => ({ v, f, s: { border: true, fmt: 'int', align: 'right', ...(b ? { b: true, fill: '#F3E3E3' } : {}) } });
    const $ = (v, f, b) => ({ v: r2(v), f, s: { border: true, fmt: 'money', align: 'right', ...(b ? { b: true, fill: '#F3E3E3' } : {}) } });
    const block = (title, who, s) => {
      rows.push([{ v: title, s: S.block }]);
      // Por categoría: cajas, unidades y $ (tres columnas); luego totales; luego vacíos por tipo
      const head = [{ v: who, s: S.hdrL }];
      m.cats.forEach((c) => head.push({ v: c + ' · cajas', s: S.hdr }, { v: c + ' · unid.', s: S.hdr }, { v: c + ' · $', s: S.hdr }));
      head.push({ v: 'TOTAL cajas', s: S.hdr }, { v: 'TOTAL unid.', s: S.hdr }, { v: 'TOTAL $', s: S.hdr });
      m.types.forEach((t) => head.push({ v: 'Vacíos devueltos ' + typeLabel(t, o.products), s: S.hdr }));
      if (m.types.length) head.push({ v: 'Total vacíos', s: S.hdr });
      rows.push(head);
      const r0 = rows.length + 1, nc = m.cats.length, tc = 1 + nc * 3;
      s.rows.forEach((p) => {
        const xr = rows.length + 1, line = [{ v: p.name, s: { border: true, b: true } }];
        m.cats.forEach((c) => { const x = p.cells[c] || zero(); line.push(n(x.cajas || null), n(x.unidades || null), $(x.monto)); });
        const sumOf = (k) => m.cats.map((_, i) => `${col(1 + i * 3 + k)}${xr}`).join('+') || '0';
        line.push(n(p.total.cajas, sumOf(0), true), n(p.total.unidades, sumOf(1), true), $(p.total.monto, sumOf(2), true));
        m.types.forEach((t) => line.push(n(p.vac[t] || null)));
        if (m.types.length) line.push(n(p.vacTot, `SUM(${col(tc + 3)}${xr}:${col(tc + 2 + m.types.length)}${xr})`, true));
        rows.push(line);
      });
      // TOTAL de cada columna: el valor calculado y la fórmula SUM de la columna
      const r1 = rows.length, vals = [];
      m.cats.forEach((c) => vals.push(s.cols[c].cajas, s.cols[c].unidades, r2(s.cols[c].monto)));
      vals.push(s.total.cajas, s.total.unidades, r2(s.total.monto));
      m.types.forEach((t) => vals.push(s.vac[t])); if (m.types.length) vals.push(s.vacTot);
      rows.push([{ v: 'TOTAL', s: S.tot }, ...vals.map((v, k) => {
        const i = k + 1, isMoney = (i < tc && (i - 1) % 3 === 2) || i === tc + 2;
        return { v, f: s.rows.length ? `SUM(${col(i)}${r0}:${col(i)}${r1})` : undefined, s: { ...S.tot, fmt: isMoney ? 'money' : 'int', align: 'right', size: 12 } };
      })]);
      rows.push([]);
    };
    block('VENDEDORES', 'Vendedor', m.sellers);
    block('DESPACHADORES (incluye depósito / retiro por oficina)', 'Despachador', m.disps);
    rows.push([{ v: m.ok ? '✓ Los totales de vendedores y despachadores coinciden.' : '⚠ No coinciden: ' + m.diffs.join(', '), s: S.note }]);
    if (m.compare) {
      rows.push([], [{ v: `COMPARACIÓN CON EL PERÍODO ANTERIOR (${o.fmtDate(m.prev.from)} al ${o.fmtDate(m.prev.to)})`, s: S.block }],
        ['Categoría', 'Anterior · cajas', 'Ahora · cajas', 'Anterior · $', 'Ahora · $', 'Cambio %'].map((h, k) => ({ v: h, s: k ? S.hdr : S.hdrL })));
      m.compare.forEach((x) => { const xr = rows.length + 1; rows.push([{ v: x.category, s: { border: true, b: true } }, n(x.prev.cajas), n(x.now.cajas), $(x.prev.monto), $(x.now.monto),
        { v: x.prev.monto ? r2((x.now.monto - x.prev.monto) / x.prev.monto) : null, f: `IF(D${xr}=0,"",(E${xr}-D${xr})/D${xr})`, s: { border: true, fmt: 'pct', align: 'right', b: true } }]); });
    }
    const widths = [26]; for (let i = 1; i < 1 + m.cats.length * 3 + 3 + m.types.length + 1; i++) widths.push(11);
    return { name: 'Resumen quincena', rows, widths, freeze: { r: 0, c: 1 }, landscape: true, tab: '730101' };
  }

  /* ---------------- Pantalla (dentro del reporte quincenal) ---------------- */
  function mount(box, d, ctx) {
    if (!box) return;
    const P = global.PV, { esc, nf0, usd, fmtDate, toast, S } = P;
    const all = d.byCategory.map((c) => c.category);
    let st = {}; try { st = JSON.parse(localStorage.getItem('pv_rq') || '{}') || {}; } catch (e) { st = {}; }
    let cats = Array.isArray(st.cats) ? st.cats.filter((c) => all.includes(c)) : all.slice();
    if (!cats.length && !Array.isArray(st.cats)) cats = all.slice();
    const ord = (a) => { const r = (P.rubros ? P.rubros() : []); return a.slice().sort((x, y) => { const i = r.indexOf(x), j = r.indexOf(y); return (i < 0 ? 999 : i) - (j < 0 ? 999 : j) || x.localeCompare(y, 'es'); }); };
    let prev = ctx.prevData || null, loading = false;
    const opts = () => ({ esc, nf0, usd, fmtDate, products: S.products });
    const draw = () => {
      const m = model(d, ord(cats), prev);
      box.innerHTML = `<div class="row" style="align-items:center;gap:8px;flex-wrap:wrap"><h3 class="grow" style="margin:0">📋 Resumen de quincena · listo para pagos</h3>
          <button class="btn btn-primary" id="rqPrint">🖨 Imprimir</button><button class="btn" id="rqXls">⇩ Excel</button></div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0"><button class="btn btn-sm" id="rqAll">Todas</button><button class="btn btn-sm" id="rqNone">Ninguna</button>
          ${ord(all).map((c) => `<label class="chip"><input type="checkbox" data-rq="${esc(c)}"${cats.includes(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('')}</div>
        ${html(m, { ...opts(), prevLoading: loading })}`;
      const save = () => { try { localStorage.setItem('pv_rq', JSON.stringify({ cats })); } catch (e) { /* noop */ } };
      box.querySelectorAll('[data-rq]').forEach((i) => { i.onchange = () => { const c = i.dataset.rq; cats = i.checked ? [...new Set([...cats, c])] : cats.filter((x) => x !== c); save(); draw(); }; });
      box.querySelector('#rqAll').onclick = () => { cats = all.slice(); save(); draw(); };
      box.querySelector('#rqNone').onclick = () => { cats = []; save(); draw(); };
      box.querySelector('#rqPrint').onclick = () => global.Print.printResumenQ(html(m, { ...opts(), print: true }), { config: S.config, title: ctx.title, from: d.from, to: d.to });
      box.querySelector('#rqXls').onclick = () => global.Exporta.save(`resumen_quincena_${d.from}_a_${d.to}.xlsx`, [excel(m, { ...opts(), title: 'RESUMEN DE QUINCENA · ' + (ctx.title || '') })]).catch(() => toast('No se pudo descargar', 'err'));
    };
    draw();
    // Comparación: se pide el período anterior al servidor (solo lectura)
    if (!prev && ctx.loadPrev) {
      loading = true; draw();
      const pr = prevRange(d.from, d.to);
      ctx.loadPrev(pr).then((x) => { loading = false; prev = x || null; if (box.isConnected) draw(); }, () => { loading = false; if (box.isConnected) draw(); });
    }
  }

  global.ResumenQ = { prevRange, model, typeLabel, html, excel, mount };
})(window);
