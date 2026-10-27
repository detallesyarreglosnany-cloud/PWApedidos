/* =========================================================================
 * resumen.js — «Mi quincena» del vendedor: lo que ha vendido (liquidado) por categoría
 * y producto en el período que elija, en cajas y unidades, el total de las categorías
 * que marque (para calcular su comisión) y sus metas de la quincena.
 * Los números salen del servidor (/api/pedidos/mis-ventas): solo lo entregado en hojas
 * con la liquidación cerrada. Lo que va en camino se muestra aparte. Sin internet se
 * ve lo último que se pudo bajar.
 * ========================================================================= */
(function (global) {
  'use strict';

  const pad = (n) => String(n).padStart(2, '0');
  const plusDays = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`; };
  const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
  const lastOfMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

  /** Rangos que se pueden elegir. */
  function rangeOf(kind, today, custom) {
    const R = global.Reportes;
    if (kind === 'qprev') { const q = R.prevQuincena(today); return { from: q.from, to: q.to }; }
    if (kind === 'mes') { const [y, m] = today.split('-').map(Number); return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastOfMonth(y, m))}` }; }
    if (kind === '7d') return { from: plusDays(today, -6), to: today };
    if (kind === 'custom' && custom && custom.from && custom.to && custom.from <= custom.to) return { from: custom.from, to: custom.to };
    const q = R.quincenaOf(today); return { from: q.from, to: q.to };
  }
  /** Si el rango es exactamente una quincena, su clave (AAAA-MM-1/2); si no, null (las metas se miden por quincena). */
  function periodKey(from, to) {
    const q = global.Reportes.quincenaOf(from);
    return q.from === from && q.to === to ? `${q.y}-${pad(q.m)}-${q.half}` : null;
  }
  const titleOf = (from, to) => {
    const k = periodKey(from, to);
    if (k) { const [y, m, h] = k.split('-').map(Number); return `${h === 1 ? '1ª' : '2ª'} quincena de ${MONTHS[m - 1]} ${y}`; }
    return `${from.split('-').reverse().join('/')} al ${to.split('-').reverse().join('/')}`;
  };

  /**
   * Mensaje de ánimo para una meta (siempre en positivo).
   * done = cajas liquidadas, proc = cajas en camino, left = días que quedan de la quincena (0 si ya terminó).
   */
  function goalMessage(done, proc, target, left) {
    const faltan = Math.max(0, target - done), pct = target ? Math.round((done / target) * 100) : 0;
    const f = (n) => new Intl.NumberFormat('es-VE').format(n);
    if (done >= target) return { level: 'ok', text: `¡Meta cumplida! 🎉 Llevas ${f(done)} cajas${done > target ? ` y superaste la meta por ${f(done - target)}` : ''}. ¡Excelente trabajo!` };
    if (left <= 0) return { level: 'soft', text: `Cerraste en ${pct}% de tu meta (${f(done)} de ${f(target)} cajas). ¡Buen esfuerzo! La próxima quincena la vas a superar.` };
    const pace = Math.ceil(faltan / left);
    const enCamino = proc > 0 ? ` Además tienes ${f(proc)} cajas en camino que se suman al liquidarse.` : '';
    if (pct >= 80) return { level: 'near', text: `¡Estás muy cerca! Te faltan solo ${f(faltan)} cajas.${enCamino}` };
    if (pct >= 50) return { level: 'mid', text: `¡Vas por muy buen camino! Ya pasaste la mitad: faltan ${f(faltan)} cajas (${pace <= 1 ? 'solo 1' : 'unas ' + f(pace)} por día).${enCamino}` };
    return { level: 'start', text: `¡Cada pedido suma! Llevas ${f(done)} cajas. Con ${pace <= 1 ? 'solo 1 caja' : 'unas ' + f(pace) + ' cajas'} por día llegas a tu meta.${enCamino}` };
  }

  const lsGet = (k) => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* noop */ } };

  function render() {
    const PV = global.PV, { S, $, esc, nf0, usd, toast, openSheet } = PV;
    const app = document.getElementById('app');
    const seller = PV.sellerById(S.session.sellerId), sid = seller.id, today = PV.today();
    const st = S.ui.res || (S.ui.res = { kind: 'q', custom: { from: today, to: today }, cats: lsGet('pv_res_cats'), data: null, goals: null, err: '', loading: false });
    const rg = rangeOf(st.kind, today, st.custom), key = periodKey(rg.from, rg.to);
    const chip = (k, l) => `<button class="chip ${st.kind === k ? 'active' : ''}" data-k="${k}">${l}</button>`;
    app.innerHTML = `
      ${PV.brandHeader(seller.name, 'Mi quincena · ' + titleOf(rg.from, rg.to),
        `<button id="bell" class="bell" type="button" aria-label="Notificaciones">🔔</button><button id="syncPill" class="pill" type="button"></button><a class="btn btn-sm" href="#/ruta">← Pedir</a>`)}
      <div class="container">
        <div class="chips" id="rsRange">${chip('q', 'Quincena actual')}${chip('qprev', 'Quincena anterior')}${chip('mes', 'Este mes')}${chip('7d', 'Últimos 7 días')}${chip('custom', 'Otras fechas')}</div>
        ${st.kind === 'custom' ? `<div class="row wrap" style="gap:8px;margin:8px 0;align-items:flex-end"><label class="field"><span>Desde</span><input id="rsFrom" type="date" class="input" value="${esc(st.custom.from)}"></label>
          <label class="field"><span>Hasta</span><input id="rsTo" type="date" class="input" value="${esc(st.custom.to)}"></label></div>` : ''}
        <div id="rsBody"></div>
      </div>${PV.creditFooter()}`;
    $('#bell').onclick = PV.notifSheet; PV.updateBell();
    $('#syncPill').onclick = () => PV.runSync(true); PV.updateSyncPill();
    $('#rsRange').onclick = (e) => { const b = e.target.closest('[data-k]'); if (!b) return; st.kind = b.dataset.k; st.data = null; st.goals = null; render(); };
    if (st.kind === 'custom') {
      const apply = () => { const f = $('#rsFrom').value, t = $('#rsTo').value; if (f && t && f <= t) { st.custom = { from: f, to: t }; st.data = null; render(); } };
      $('#rsFrom').onchange = apply; $('#rsTo').onchange = apply;
    }
    load();

    async function load() {
      const cacheKey = `pv_res:${sid}:${rg.from}:${rg.to}`;
      const cached = lsGet(cacheKey);
      if (cached && !st.data) { st.data = cached.data; st.asOf = cached.at; st.stale = true; }
      paint();
      const r = await global.Sync.myVentas(sid, rg.from, rg.to);
      if (!$('#rsBody') || S.ui.res !== st) return; // la pantalla cambió mientras llegaba
      if (r && r.ok && r.data && r.data.totals) { st.data = r.data; st.asOf = r.data.asOf; st.stale = false; st.err = ''; lsSet(cacheKey, { data: r.data, at: r.data.asOf }); }
      else st.err = r && r.offline ? 'Sin internet: se muestra lo último que se pudo bajar.' : 'No se pudo actualizar ahora. Se muestra lo último que se pudo bajar.';
      if (key) {
        const g = await global.Sync.metas({ action: 'get', sellerId: sid, period: key });
        if (g && g.ok && g.data && Array.isArray(g.data.goals)) { st.goals = g.data.goals; lsSet(`pv_metas:${sid}:${key}`, g.data.goals); }
        else if (!st.goals) st.goals = lsGet(`pv_metas:${sid}:${key}`) || [];
      }
      paint();
    }

    function paint() {
      const box = $('#rsBody'); if (!box) return;
      const d = st.data;
      if (!d) { box.innerHTML = `<div class="empty card"><strong>Cargando tus ventas…</strong>${st.err ? esc(st.err) : 'Un momento.'}</div>`; return; }
      const cats = [...new Set([...d.byCategory.map((x) => x.category), ...d.enProceso.map((x) => x.category)])];
      const order = PV.rubros ? PV.rubros() : [];
      cats.sort((a, b) => { const ia = order.indexOf(a), ib = order.indexOf(b); return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b, 'es'); });
      if (!st.cats) st.cats = cats.slice();
      const sel = new Set(st.cats);
      const cat = new Map(d.byCategory.map((x) => [x.category, x])), proc = new Map(d.enProceso.map((x) => [x.category, x]));
      const rows = cats.filter((c) => sel.has(c));
      const sum = rows.reduce((a, c) => { const x = cat.get(c) || { cajas: 0, unidades: 0, monto: 0 }, p = proc.get(c) || { cajas: 0 }; return { cajas: a.cajas + x.cajas, unidades: a.unidades + x.unidades, monto: a.monto + x.monto, proc: a.proc + p.cajas }; }, { cajas: 0, unidades: 0, monto: 0, proc: 0 });
      const byProd = (c) => d.byProduct.filter((p) => p.category === c);
      const procTot = d.enProceso.reduce((a, x) => a + x.cajas, 0);
      box.innerHTML = `
        ${st.err ? `<div class="hint warn">${esc(st.err)}</div>` : ''}
        ${st.stale && !st.err ? '<div class="hint">Actualizando…</div>' : ''}
        <div class="kpi-row" style="margin-top:10px">
          <div class="kpi"><small>Cajas liquidadas</small><b>${nf0.format(d.totals.cajas)}</b><small>${nf0.format(d.totals.unidades)} unidades sueltas · ${d.totals.clients} clientes</small></div>
          <div class="kpi"><small>En camino (sin liquidar)</small><b>${nf0.format(procTot)}</b><small>cajas · se suman al liquidar</small></div>
          <div class="kpi"><small>Venta liquidada</small><b>${usd(d.totals.monto)}</b><small>${d.totals.hojas} hojas liquidadas</small></div>
        </div>
        <div class="card card-pad" style="margin-top:8px">
          <h3 style="margin:0 0 6px">Mis categorías <span class="muted" style="font-weight:400;font-size:13px">marca las que cuentan para tu comisión</span></h3>
          <div class="chips" id="rsCats" style="flex-wrap:wrap;overflow:visible">${cats.map((c) => `<button class="chip ${sel.has(c) ? 'active' : ''}" data-c="${esc(c)}">${PV.rubroIcon ? PV.rubroIcon(c) : ''} ${esc(c)}</button>`).join('') || '<span class="muted">Aún no hay ventas liquidadas en este período.</span>'}</div>
          ${cats.length ? `<div class="row" style="gap:8px;margin:6px 0"><button class="btn btn-sm" id="rsAll">Todas</button><button class="btn btn-sm" id="rsNone">Ninguna</button></div>` : ''}
          <div class="kpi" style="margin:8px 0"><small>Total de las categorías marcadas</small><b>${nf0.format(sum.cajas)} cajas${sum.unidades ? ` + ${nf0.format(sum.unidades)} un` : ''}</b><small>${sum.proc ? `${nf0.format(sum.proc)} cajas más en camino · ` : ''}${usd(sum.monto)}</small></div>
          ${rows.length ? `<div style="overflow:auto"><table class="inv"><thead><tr><th>Categoría</th><th class="n">Cajas</th><th class="n">Unidades</th><th class="n">En camino (cj)</th></tr></thead><tbody>
            ${rows.map((c) => { const x = cat.get(c) || { cajas: 0, unidades: 0 }, p = proc.get(c), ps = byProd(c); return `<tr><td><b>${esc(c)}</b>${ps.length ? `<details><summary class="muted" style="cursor:pointer">ver por producto</summary>${ps.map((q) => `<div class="muted" style="font-size:13px">${esc(q.code)} ${esc(q.name)} ${esc(q.presentation)} · <b>${nf0.format(q.cajas)}</b> cj${q.unidades ? ' + ' + nf0.format(q.unidades) + ' un' : ''}</div>`).join('')}</details>` : ''}</td>
              <td class="n" data-l="Cajas"><b>${nf0.format(x.cajas)}</b></td><td class="n" data-l="Unidades">${x.unidades ? nf0.format(x.unidades) : ''}</td><td class="n muted" data-l="En camino (cj)">${p ? nf0.format(p.cajas) : ''}</td></tr>`; }).join('')}
          </tbody><tfoot><tr><td>TOTAL MARCADAS</td><td class="n" data-l="Cajas">${nf0.format(sum.cajas)}</td><td class="n" data-l="Unidades">${nf0.format(sum.unidades)}</td><td class="n" data-l="En camino (cj)">${nf0.format(sum.proc)}</td></tr></tfoot></table></div>` : ''}
        </div>
        <div id="rsGoals"></div>`;
      const saveCats = () => lsSet('pv_res_cats', st.cats);
      const again = () => { saveCats(); paint(); };
      const cc = $('#rsCats'); if (cc) cc.onclick = (e) => { const b = e.target.closest('[data-c]'); if (!b) return; const c = b.dataset.c; st.cats = sel.has(c) ? st.cats.filter((x) => x !== c) : st.cats.concat(c); again(); };
      const ba = $('#rsAll'); if (ba) { ba.onclick = () => { st.cats = cats.slice(); again(); }; $('#rsNone').onclick = () => { st.cats = []; again(); }; }
      paintGoals(cat, proc, cats);
    }

    function paintGoals(cat, proc, cats) {
      const gb = $('#rsGoals'); if (!gb) return;
      if (!key) { gb.innerHTML = '<div class="hint" style="margin-top:12px">🎯 Las metas se miden por quincena: elige «Quincena actual» o «Quincena anterior» para verlas.</div>'; return; }
      const goals = st.goals || [], f = (n) => nf0.format(n);
      const left = Math.max(0, daysBetween(today, rg.to) + 1) * (today <= rg.to ? 1 : 0);
      gb.innerHTML = `<div class="card card-pad" style="margin-top:12px"><div class="row" style="align-items:center;gap:8px"><h3 class="grow" style="margin:0">🎯 Mis metas de esta quincena</h3><button class="btn btn-primary btn-sm" id="gAdd">＋ Meta</button></div>
        ${goals.length ? goals.map((g, i) => {
          const done = (cat.get(g.category) || { cajas: 0 }).cajas, p = (proc.get(g.category) || { cajas: 0 }).cajas, m = goalMessage(done, p, g.target, left);
          const w1 = Math.min(100, Math.round((done / g.target) * 100)), w2 = Math.min(100, Math.round(((done + p) / g.target) * 100));
          return `<div class="goal g-${m.level}" style="margin-top:12px"><div class="row" style="align-items:center;gap:8px"><b class="grow">${PV.rubroIcon ? PV.rubroIcon(g.category) : ''} ${esc(g.category)}</b><span class="muted">${f(done)} / ${f(g.target)} cajas · ${Math.round((done / g.target) * 100)}%</span>
              <button class="btn btn-sm" data-ge="${i}" aria-label="Cambiar la meta">✎</button><button class="btn btn-sm" data-gd="${i}" aria-label="Quitar la meta">✕</button></div>
            <div class="goal-bar"><i class="g2" style="width:${w2}%"></i><i class="g1" style="width:${w1}%"></i></div>
            <div class="goal-msg">${esc(m.text)}</div></div>`;
        }).join('') : '<p class="muted" style="margin:8px 0 0">Todavía no tienes metas. Toca «＋ Meta», elige una categoría y cuántas cajas quieres vender: por ejemplo, Refrescos · 3.000 cajas.</p>'}
      </div>`;
      const persist = async (next) => {
        const r = await global.Sync.metas({ action: 'set', sellerId: sid, period: key, goals: next });
        if (r && r.ok && r.data && Array.isArray(r.data.goals)) { st.goals = r.data.goals; lsSet(`pv_metas:${sid}:${key}`, r.data.goals); toast('Meta guardada', 'ok'); }
        else toast((r && r.error) || 'Sin internet: conéctate para guardar tu meta', 'err');
        paint();
      };
      const allCats = [...new Set([...(PV.rubros ? PV.rubros() : []), ...cats])];
      const goalSheet = (idx) => {
        const cur = idx != null ? goals[idx] : null, free = allCats.filter((c) => !goals.some((g, j) => g.category === c && j !== idx));
        const sh = openSheet(`<div class="row"><h2 class="grow">${cur ? 'Cambiar meta' : 'Nueva meta'}</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
          <label class="field"><span>Categoría</span><select id="gCat" class="select" ${cur ? 'disabled' : ''}>${(cur ? [cur.category] : free).map((c) => `<option>${esc(c)}</option>`).join('')}</select></label>
          <label class="field"><span>Cajas que quiero vender esta quincena</span><input id="gTarget" class="input" inputmode="numeric" value="${cur ? cur.target : ''}" placeholder="Ej: 3000"></label>
          <div class="actions"><button class="btn btn-primary" id="gSave">Guardar meta</button></div>`);
        sh.el.querySelector('#gSave').onclick = async () => {
          const t = Math.round(Number(String(sh.el.querySelector('#gTarget').value).replace(/\./g, '').replace(',', '.')));
          const c = sh.el.querySelector('#gCat').value;
          if (!c || !(t >= 1)) { toast('Escribe cuántas cajas quieres vender', 'err'); return; }
          sh.close();
          await persist(cur ? goals.map((g, j) => (j === idx ? { ...g, target: t } : g)) : goals.concat({ category: c, target: t }));
        };
      };
      $('#gAdd').onclick = () => { if (!allCats.some((c) => !goals.some((g) => g.category === c))) { toast('Ya tienes una meta en cada categoría', 'ok'); return; } goalSheet(null); };
      gb.querySelectorAll('[data-ge]').forEach((b) => { b.onclick = () => goalSheet(+b.dataset.ge); });
      gb.querySelectorAll('[data-gd]').forEach((b) => { b.onclick = async () => { const g = goals[+b.dataset.gd]; if (!confirm(`¿Quitar tu meta de ${g.category}?`)) return; await persist(goals.filter((_, j) => j !== +b.dataset.gd)); }; });
    }
  }

  global.Resumen = { render, goalMessage, rangeOf, periodKey };
})(window);
