/**
 * Comparar el reporte quincenal con uno impreso antes (Reporte → 🕒 Comparar con un reporte anterior).
 * SOLO LEE. Reconstruye, cliente por cliente, lo que había liquidado a una hora (la del reporte impreso) y lo compara
 * con lo de hoy, por vendedor y por despachador:
 *   ya estaba   → su pedido ya contaba a esa hora (aunque la hoja se haya vuelto a liquidar después)
 *   agregado    → entró después: su hoja se liquidó por primera vez después, o lo metieron en la hoja después
 *   sacado      → contaba a esa hora y hoy no (lo movieron, lo pusieron en espera o la hoja ya no cuenta)
 * Fuentes: el historial (cada «Liquidó» y «Reabrió» con su hora, clientes y monto), la hora en que cada pedido cambió de
 * hoja y lo liquidado hoy. Al reabrir una liquidación se borra la entrega de sus pedidos: de un cliente sacado se toma su
 * pedido original. Cada hoja reabierta se cuadra contra el monto que guardó su «Liquidó» de antes de esa hora.
 */
(function (global) {
  'use strict';
  const num = (v) => Number(v) || 0;
  const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const loadDay = (l) => (/^\d{4}-\d{2}-\d{2}$/.test(String(l.date || '')) ? l.date : String(l.closedAt || '').slice(0, 10));
  // Hora en que cambió un campo, si fue después del corte. Si el servidor marcó TODOS los campos con la misma hora
  // (documento de antes de esa marca), no se sabe qué cambió: no se cuenta.
  const fvAfter = (doc, k, t) => {
    const fv = doc && doc.fv, v = fv && fv[k];
    if (typeof v !== 'string' || !(Date.parse(v) > t)) return '';
    const bulk = ['route', 'number', 'sellerName', 'label', 'clientName', 'routeDate'].filter((x) => fv[x] === v).length >= 2;
    return bulk ? '' : v;
  };
  // «Liquidó X (despachador) · 18 clientes · $ 4.250,00 · …» → { clientes, monto }
  const parseLiq = (txt) => {
    const c = /·\s*(\d+)\s*clientes/.exec(txt || ''), m = /·\s*\$\s*([\d.]+(?:,\d+)?)/.exec(txt || '');
    return { clientes: c ? +c[1] : null, monto: m ? +m[1].replace(/\./g, '').replace(',', '.') : null };
  };

  function prepare(S, events, from, to, cats) {
    const set = new Set(cats), pById = new Map(S.products.map((p) => [p.id, p]));
    const catOf = (pid, ln) => String((pById.get(pid) || {}).category || ln.category || 'Sin categoría');
    const qty = (lines) => { let c = 0, u = 0, m = 0; Object.entries(lines || {}).forEach(([pid, ln]) => { if (!set.has(catOf(pid, ln))) return; c += num(ln.cajas); u += num(ln.unidades); m += global.Matrix.lineTotals(ln).monto; }); return { cajas: c, unidades: u, monto: r2(m) }; };
    const money = (lines) => r2(Object.values(lines || {}).reduce((a, ln) => a + global.Matrix.lineTotals(ln).monto, 0));
    const ev = (events || []).map((e) => ({ ...e, t: Date.parse(e.at) })).filter((e) => e.t).sort((a, b) => a.t - b.t);
    const liqEv = new Map(); ev.filter((e) => e.type === 'liquidacion' && e.loadId).forEach((e) => (liqEv.get(e.loadId) || liqEv.set(e.loadId, []).get(e.loadId)).push({ ...e, close: /^Liquidó/.test(e.text || ''), reopen: /^Reabrió/.test(e.text || '') }));
    const loads = S.loads.filter((l) => !l.deleted || liqEv.has(l.id));
    const lById = new Map(S.loads.map((l) => [l.id, l]));
    const lab = (l) => (l ? `${Loads.labelOf(l)}${l.number ? ' ' + Loads.loadCode(l) : ''}` : '—');
    const inRange = (l) => !!l && loadDay(l) >= from && loadDay(l) <= to;
    const closedNow = (l) => !!l && !l.deleted && l.liq && l.liq.status === 'cerrada' && !!l.liq.closedAt && inRange(l);
    return { S, set, qty, money, ev, liqEv, loads, lById, lab, inRange, closedNow };
  }

  /** Reconstrucción a la hora cut (ISO). */
  function run(S, events, from, to, cats, cut, P0) {
    const P = P0 || prepare(S, events, from, to, cats), t = Date.parse(cut);
    const { qty, money, liqEv, loads, lById, lab, inRange, closedNow } = P;
    // ¿La hoja estaba liquidada a esa hora? Por el historial; sin historial de esa hoja, por la hora de su cierre actual
    const atCut = (l) => {
      const ev = (liqEv.get(l.id) || []).filter((e) => e.t <= t), last = ev[ev.length - 1];
      if (last) return last.close ? last : null;
      return l.liq && l.liq.closedAt && Date.parse(l.liq.closedAt) <= t ? { at: l.liq.closedAt, text: '', close: true, t: Date.parse(l.liq.closedAt) } : null;
    };
    const dispOf = (o, l) => (o.delivery && o.delivery.viaOficina ? (o.delivery.oficinaDispatcherName || 'Retiro en oficina') : (l && l.dispatcherName) || 'Sin despachador');
    const rows = []; // { o, l, kind: 'estaba'|'agregado'|'sacado', q, when, why }
    const counted = new Set();
    // 1 · Lo que cuenta HOY
    loads.filter(closedNow).forEach((l) => {
      const cut0 = atCut(l);
      S.orders.forEach((o) => {
        if (o.deleted || !o.delivery || o.delivery.loadId !== l.id || o.delivery.at !== l.liq.closedAt) return;
        counted.add(o.id);
        const q = qty(o.delivery.lines);
        let kind = 'estaba', why = '';
        if (Date.parse(l.liq.closedAt) > t) {
          if (!cut0) { kind = 'agregado'; why = `la hoja se liquidó después (${new Date(Date.parse(l.liq.closedAt)).toLocaleString('es-VE')})`; }
          else if (fvAfter(o, 'loadId', t)) { kind = 'agregado'; why = `lo metieron en la hoja después (${new Date(Date.parse(fvAfter(o, 'loadId', t))).toLocaleString('es-VE')})`; }
          else why = 'la hoja se volvió a liquidar después';
        }
        rows.push({ o, l, kind, q, why, disp: dispOf(o, l), monto: num(o.delivery.monto) });
      });
    });
    // 2 · Lo que contaba a esa hora y hoy no: pedidos que salieron de una hoja liquidada a esa hora
    const espera = P.ev.filter((e) => e.t > t && e.type === 'espera' && e.orderId);
    const movido = P.ev.filter((e) => e.t > t && (e.type === 'movido' || e.type === 'pedido_eliminado') && e.orderId);
    const closedAtCutByLabel = new Map(loads.filter((l) => atCut(l) && inRange(l)).map((l) => [Loads.labelOf(l), l]));
    S.orders.forEach((o) => {
      if (counted.has(o.id)) return;
      // ¿De qué hoja salió? La hoja en que está (si se volvió a liquidar sin él o ya no cuenta), la que dice «Puso en espera», o la que tenía
      let src = null, why = '', when = '';
      const es = espera.find((e) => e.orderId === o.id), mv = movido.find((e) => e.orderId === o.id);
      if (es) { const m = /sacándolo de la hoja (.+)$/.exec(es.text || ''); src = m ? closedAtCutByLabel.get(m[1].trim()) : null; why = 'lo pusieron en espera'; when = es.at; }
      if (!src && o.loadId && lById.get(o.loadId)) { const l = lById.get(o.loadId); if (inRange(l) && atCut(l) && !fvAfter(o, 'loadId', t)) { src = l; why = closedNow(l) ? 'su hoja se volvió a liquidar sin él' : 'su hoja ya no cuenta (reabierta o fuera del período)'; } }
      if (!src && mv) { why = mv.type === 'pedido_eliminado' ? 'se eliminó el pedido' : 'lo movieron a otra hoja'; when = mv.at; }
      if (!src && !(mv && o.routeDate >= from && o.routeDate <= to)) return;
      const q = qty(o.lines);
      if (!src && !q.cajas && !q.unidades) return; // un sacado cuenta siempre (su monto entra al cuadre de su hoja)
      rows.push({ o, l: src, kind: src ? 'sacado' : 'posible', q, why, when, disp: dispOf(o, src), monto: money(o.lines) });
    });
    // 3 · Cuadre de cada hoja reabierta contra su «Liquidó» de antes de esa hora
    const hojas = [];
    loads.filter((l) => inRange(l) || closedNow(l)).forEach((l) => {
      const c0 = atCut(l), evAfter = (liqEv.get(l.id) || []).filter((e) => e.t > t);
      if (!c0 && !closedNow(l)) return;
      const mine = rows.filter((r) => r.l === l);
      const at = mine.filter((r) => r.kind === 'estaba' || r.kind === 'sacado'), now = mine.filter((r) => r.kind === 'estaba' || r.kind === 'agregado');
      const sum = (a) => a.reduce((x, r) => ({ cajas: x.cajas + r.q.cajas, unidades: x.unidades + r.q.unidades, monto: r2(x.monto + r.monto), n: x.n + 1 }), { cajas: 0, unidades: 0, monto: 0, n: 0 });
      const ev0 = c0 && c0.text ? parseLiq(c0.text) : { clientes: null, monto: null };
      const sAt = sum(at);
      hojas.push({ id: l.id, label: lab(l), date: loadDay(l), disp: l.dispatcherName || '', estaba: !!c0, ahora: closedNow(l), reabierta: evAfter.some((e) => e.reopen), cambios: evAfter.map((e) => `${e.close ? 'Liquidó' : 'Reabrió'} ${new Date(e.t).toLocaleString('es-VE')}${e.reopen ? ' · ' + String(e.text || '').replace(/^.*motivo:\s*/, 'motivo: ') : ''}`),
        at: sAt, now: sum(now), ev: ev0, cuadra: ev0.monto == null ? null : Math.abs(sAt.monto - ev0.monto) < 1 });
    });
    // 4 · Por persona: al corte (estaba + sacado) y hoy (estaba + agregado)
    const people = (key) => {
      const m = new Map(), get = (n) => m.get(n) || m.set(n, { name: n, at: 0, now: 0, atU: 0, nowU: 0 }).get(n);
      rows.forEach((r) => { if (r.kind === 'posible') return; const p = get(key(r)); if (r.kind !== 'agregado') { p.at += r.q.cajas; p.atU += r.q.unidades; } if (r.kind !== 'sacado') { p.now += r.q.cajas; p.nowU += r.q.unidades; } });
      return [...m.values()].map((p) => ({ ...p, diff: p.now - p.at })).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff) || a.name.localeCompare(b.name, 'es'));
    };
    const tot = (k) => rows.filter((r) => k.includes(r.kind)).reduce((a, r) => a + r.q.cajas, 0);
    return { rows, hojas, sellers: people((r) => r.o.sellerName || '—'), disps: people((r) => r.disp),
      at: tot(['estaba', 'sacado']), now: tot(['estaba', 'agregado']), agregado: tot(['agregado']), sacado: tot(['sacado']),
      eventos: P.ev.length, desde: P.ev.length ? P.ev[0].at : '' };
  }

  /** ¿A qué hora el reporte daba ese total? Prueba cada liquidación y reapertura (el total solo cambia ahí). */
  function findCut(S, events, from, to, cats, target, day) {
    const P = prepare(S, events, from, to, cats);
    const times = [...new Set(P.ev.filter((e) => e.type === 'liquidacion' && (!day || String(e.at).slice(0, 10) === day || new Date(e.t).toLocaleDateString('sv') === day)).map((e) => e.t))].sort((a, b) => a - b);
    return times.map((tt) => { const r = run(S, events, from, to, cats, new Date(tt + 1000).toISOString(), P); return { at: new Date(tt + 1000).toISOString(), total: r.at }; })
      .map((x) => ({ ...x, off: Math.abs(x.total - target) }));
  }

  async function sheet(d) {
    const P = global.PV, { S, esc, nf0, usd, openSheet, fmtDate } = P;
    const all = d.byCategory.map((c) => c.category);
    let cats; try { cats = (JSON.parse(localStorage.getItem('pv_rq') || '{}') || {}).cats; } catch (e) { cats = null; }
    cats = Array.isArray(cats) && cats.length ? cats.filter((c) => all.includes(c)) : all.slice();
    const events = await global.DB.getAll('events').catch(() => []);
    const local = (iso) => { const x = new Date(iso), p = (n) => String(n).padStart(2, '0'); return `${x.getFullYear()}-${p(x.getMonth() + 1)}-${p(x.getDate())}T${p(x.getHours())}:${p(x.getMinutes())}`; };
    const sh = openSheet(`<div class="row"><h2 class="grow">🕒 Comparar con un reporte anterior</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <p class="muted">Solo revisa: <b>no cambia nada</b>. Reconstruye, cliente por cliente, lo que estaba liquidado a la hora en que imprimiste el reporte (${esc(fmtDate(d.from))} al ${esc(fmtDate(d.to))}) y lo compara con lo de hoy.</p>
      <div class="row wrap" style="gap:8px;align-items:flex-end">
        <label class="field"><span>Hora del reporte impreso</span><input id="cqT" type="datetime-local" class="input" value="2026-10-30T14:50"></label>
        <label class="field"><span>Cajas del reporte impreso</span><input id="cqP" class="input" inputmode="numeric" placeholder="ej. 30300" style="max-width:140px"></label>
        <button class="btn btn-primary" id="cqGo">Comparar</button><button class="btn" id="cqFind" title="Busca la hora en que el reporte daba el total impreso">🔎 Buscar la hora por el total</button></div>
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0">${all.map((c) => `<label class="chip"><input type="checkbox" data-cq="${esc(c)}"${cats.includes(c) ? ' checked' : ''}> ${esc(c)}</label>`).join('')}</div>
      <div id="cqFound"></div><div id="cqOut"></div>`, { wide: true });
    const labOf = (l) => `${Loads.labelOf(l)}${l.number ? ' ' + Loads.loadCode(l) : ''}`;
    const $q = (s) => sh.el.querySelector(s), cj = (c, u) => `${nf0.format(c)}${u ? ' + ' + nf0.format(u) + ' un' : ''}`;
    const pick = () => { cats = [...sh.el.querySelectorAll('[data-cq]')].filter((i) => i.checked).map((i) => i.dataset.cq); };
    // Hora exacta elegida con «Buscar la hora» (el campo solo guarda minutos); se olvida si se cambia el campo a mano
    let exact = null;
    const go = () => {
      const tv = $q('#cqT').value; if (!tv) return; pick();
      const cutIso = exact && exact.v === tv ? exact.at : new Date(tv).toISOString();
      const r = run(S, events, d.from, d.to, cats, cutIso), printed = num(String($q('#cqP').value).replace(/\D/g, ''));
      const ppl = (title, arr) => `<h3>${esc(title)}</h3><div style="overflow:auto"><table class="inv"><thead><tr><th>${esc(title.includes('ende') ? 'Vendedor' : 'Despachador')}</th><th class="n">Al imprimir</th><th class="n">Hoy</th><th class="n">Diferencia</th></tr></thead><tbody>
        ${arr.map((p) => `<tr><td><b>${esc(p.name)}</b></td><td class="n">${cj(p.at, p.atU)}</td><td class="n">${cj(p.now, p.nowU)}</td><td class="n ${p.diff ? 'warn-txt' : 'muted'}"><b>${p.diff > 0 ? '+' : ''}${nf0.format(p.diff)}</b></td></tr>`).join('')}</tbody>
        <tfoot><tr><td>TOTAL</td><td class="n">${nf0.format(r.at)}</td><td class="n">${nf0.format(r.now)}</td><td class="n"><b>${r.now - r.at > 0 ? '+' : ''}${nf0.format(r.now - r.at)}</b></td></tr></tfoot></table></div>`;
      const list = (kind, title) => { const rs = r.rows.filter((x) => x.kind === kind).sort((a, b) => (a.l ? a.l.label || '' : '').localeCompare(b.l ? b.l.label || '' : '') || a.o.clientName.localeCompare(b.o.clientName, 'es'));
        return `<h3>${title} (${rs.length}) · ${nf0.format(rs.reduce((a, x) => a + x.q.cajas, 0))} cajas</h3>${rs.length ? `<div style="overflow:auto"><table class="inv"><thead><tr><th>Cliente</th><th>Vendedor</th><th>Hoja</th><th>Despachador</th><th class="n">Cajas</th><th>Por qué</th><th></th></tr></thead><tbody>
          ${rs.map((x) => `<tr><td><b>${esc(x.o.clientName)}</b>${x.o.valeryNote ? ` <span class="muted mono">${esc(x.o.valeryNote)}</span>` : ''}</td><td>${esc(x.o.sellerName || '')}</td><td>${esc(x.l ? labOf(x.l) : '—')}</td><td>${esc(x.disp)}</td><td class="n"><b>${cj(x.q.cajas, x.q.unidades)}</b></td><td class="muted" style="font-size:12px">${esc(x.why)}${x.when ? ' · ' + esc(new Date(x.when).toLocaleString('es-VE')) : ''}</td><td>${x.l ? `<button class="btn btn-sm" data-goto="${esc(x.l.id)}">Abrir</button>` : ''}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Ninguno.</p>'}`; };
      const hojas = r.hojas.filter((h) => h.reabierta || !h.estaba || !h.ahora);
      $q('#cqOut').innerHTML = `
        ${r.eventos ? '' : '<div class="hint warn">Este equipo no tiene el historial de liquidaciones: el resultado es menos exacto. Usa la PC de oficina de siempre y toca «Actualizar».</div>'}
        <div class="kpi-row"><div class="kpi"><small>Al imprimir (reconstruido)</small><b>${nf0.format(r.at)}</b><small>cajas</small></div>
          <div class="kpi"><small>Hoy</small><b>${nf0.format(r.now)}</b><small>cajas</small></div>
          <div class="kpi"><small>Diferencia</small><b class="warn-txt">${r.now - r.at > 0 ? '+' : ''}${nf0.format(r.now - r.at)}</b><small>+${nf0.format(r.agregado)} agregadas · −${nf0.format(r.sacado)} sacadas</small></div>
          ${printed ? `<div class="kpi"><small>Tu reporte impreso</small><b>${nf0.format(printed)}</b><small>${r.at === printed ? '✓ coincide con la reconstrucción' : `reconstrucción ${r.at > printed ? '+' : ''}${nf0.format(r.at - printed)} — prueba otra hora o «Buscar la hora»`}</small></div>` : ''}</div>
        ${ppl('Por vendedor', r.sellers)}${ppl('Por despachador', r.disps)}
        ${list('agregado', '🆕 Clientes AGREGADOS después de imprimir')}
        ${list('sacado', '➖ Clientes que contaban al imprimir y hoy NO')}
        ${r.rows.some((x) => x.kind === 'posible') ? list('posible', '❔ Movidos después de imprimir (no se sabe de qué hoja salieron: revísalos)') : ''}
        <h3>Hojas que cambiaron (${hojas.length})</h3>${hojas.length ? `<div style="overflow:auto"><table class="inv"><thead><tr><th>Hoja</th><th>Fecha</th><th>Al imprimir</th><th>Hoy</th><th>Cuadre con el «Liquidó» de esa hora</th><th>Qué pasó después</th><th></th></tr></thead><tbody>
          ${hojas.map((h) => `<tr><td><b>${esc(h.label)}</b><div class="muted">${esc(h.disp)}</div></td><td>${esc(fmtDate(h.date))}</td><td>${h.estaba ? `${h.at.n} clientes · ${cj(h.at.cajas, h.at.unidades)}` : '<span class="muted">no estaba liquidada</span>'}</td><td>${h.ahora ? `${h.now.n} clientes · ${cj(h.now.cajas, h.now.unidades)}` : '<span class="warn-txt">no cuenta</span>'}</td>
            <td>${h.cuadra === null ? '<span class="muted">—</span>' : h.cuadra ? `✓ ${usd(h.ev.monto)}` : `<span class="warn-txt">⚠ ese cierre fue de ${usd(h.ev.monto)} (${h.ev.clientes} clientes); lo reconstruido da ${usd(h.at.monto)} (${h.at.n}): se editaron cantidades</span>`}</td>
            <td class="muted" style="font-size:12px">${h.cambios.map(esc).join('<br>') || (h.estaba ? '' : 'se liquidó por primera vez después')}</td><td><button class="btn btn-sm" data-goto="${esc(h.id)}">Abrir</button></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Ninguna.</p>'}
        <p class="muted" style="font-size:12px">Categorías: ${esc(cats.join(', ') || '—')}. Historial en este equipo desde ${esc(r.desde ? new Date(r.desde).toLocaleString('es-VE') : '—')}. De los clientes sacados se toma su pedido original (al reabrir se borra la entrega).</p>`;
    };
    const find = () => {
      pick(); const target = num(String($q('#cqP').value).replace(/\D/g, ''));
      if (!target) { $q('#cqFound').innerHTML = '<div class="hint warn">Escribe las cajas del reporte impreso para buscar la hora.</div>'; return; }
      const day = $q('#cqT').value.slice(0, 10);
      const xs = findCut(S, events, d.from, d.to, cats, target, day);
      if (!xs.length) { $q('#cqFound').innerHTML = `<div class="hint warn">No hay liquidaciones el ${esc(fmtDate(day))} en el historial de este equipo.</div>`; return; }
      const best = xs.reduce((a, x) => (x.off < a.off ? x : a), xs[0]);
      $q('#cqFound').innerHTML = `<div class="card card-pad" style="margin-bottom:8px"><b>Total del reporte después de cada liquidación del ${esc(fmtDate(day))}</b> <span class="muted">(toca una hora para usarla)</span>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${xs.map((x) => `<button class="btn btn-sm ${x === best ? 'btn-primary' : ''}" data-cut="${esc(x.at)}">${esc(new Date(x.at).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' }))} → ${nf0.format(x.total)}${x === best ? (x.off ? ` (la más cercana, ${x.total > target ? '+' : ''}${nf0.format(x.total - target)})` : ' ✓') : ''}</button>`).join('')}</div></div>`;
      $q('#cqT').value = local(best.at); exact = { v: local(best.at), at: best.at }; go();
    };
    sh.el.addEventListener('click', (e) => {
      if (e.target.closest('#cqGo')) go();
      if (e.target.closest('#cqFind')) find();
      const c = e.target.closest('[data-cut]'); if (c) { $q('#cqT').value = local(c.dataset.cut); exact = { v: local(c.dataset.cut), at: c.dataset.cut }; go(); }
      const g = e.target.closest('[data-goto]'); if (g) { sh.close(); P.openLoad(g.dataset.goto, true); }
    });
    sh.el.addEventListener('change', (e) => { if (e.target.closest('[data-cq]')) go(); });
    go();
  }

  global.CuadreQ = { run, findCut, sheet };
})(window);
