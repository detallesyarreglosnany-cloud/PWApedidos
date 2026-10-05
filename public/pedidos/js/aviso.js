/* =========================================================================
 * aviso.js — Aviso de suscripción / fin de la prueba gratuita.
 *
 * Una cinta que se desplaza sin parar, pegada arriba en TODAS las pantallas
 * (inicio de sesión, vendedor, oficina y supervisor), y una notificación en la
 * campana una vez al día. La fecha y el texto los entrega el servidor
 * (/api/pedidos/aviso, lo configura el desarrollador); se guarda lo último
 * para que también se vea sin internet. No bloquea la app: solo avisa.
 * ========================================================================= */
(function (global) {
  'use strict';

  const SHOW_FROM_DAYS = 7; // la cinta aparece cuando faltan 7 días o menos
  const SPEED = 70; // px por segundo
  const pad = (n) => String(n).padStart(2, '0');
  const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayNum = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return Date.UTC(y, m - 1, d) / 86400000; };
  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const longDate = (iso) => { const [y, m, d] = String(iso).split('-').map(Number); return `${d} de ${MONTHS[m - 1]} de ${y}`; };
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /**
   * Estado del aviso para una fecha: { show, level, days, badge, segments[], title, notif }.
   * level: 'warn' (2–7 días) · 'urgent' (1 día u hoy) · 'expired'
   */
  function compute(cfg, todayISO) {
    if (!cfg || cfg.active === false || !cfg.endsAt) return { show: false };
    const days = Math.round(dayNum(cfg.endsAt) - dayNum(todayISO));
    if (days > SHOW_FROM_DAYS) return { show: false, days };
    const contact = cfg.contact ? `Contacto: ${cfg.contact}` : '';
    const renew = (cfg.message && cfg.message.trim()) || 'Para seguir usando la app de pedidos debes renovar tu suscripción';
    let level, badge, segments, notif;
    if (days >= 2) {
      level = 'warn'; badge = `${days} DÍAS`;
      segments = [`⏳ Prueba gratuita: te quedan ${days} días`, `Vence el ${longDate(cfg.endsAt)}`, renew, contact];
      notif = `⏳ Tu prueba gratuita vence en ${days} días (${longDate(cfg.endsAt)}). ${renew}.`;
    } else if (days === 1) {
      level = 'urgent'; badge = '1 DÍA';
      segments = ['⚠️ RENUEVA TU SUSCRIPCIÓN', 'Te queda 1 día de prueba gratuita', renew, contact];
      notif = `⚠️ Renueva tu suscripción: te queda 1 día de prueba gratuita. ${renew}.`;
    } else if (days === 0) {
      level = 'urgent'; badge = 'HOY';
      segments = ['⛔ HOY VENCE TU PRUEBA GRATUITA', 'Renueva tu suscripción ahora', renew, contact];
      notif = `⛔ Hoy vence tu prueba gratuita. ${renew}.`;
    } else {
      level = 'expired'; badge = 'VENCIDA';
      const n = -days;
      segments = ['⛔ PRUEBA GRATUITA VENCIDA', `Venció hace ${n} ${n === 1 ? 'día' : 'días'}`, renew, contact];
      notif = `⛔ Tu prueba gratuita venció hace ${n} ${n === 1 ? 'día' : 'días'}. ${renew}.`;
    }
    return { show: true, level, days, badge, segments: segments.filter(Boolean), notif, endsAt: cfg.endsAt, contact: cfg.contact || '', message: renew };
  }

  let cfg = null, fetchedAt = 0, timer = null, bar = null, lastKey = '';
  const todayEff = () => (cfg && cfg.today && Date.now() - fetchedAt < 6 * 3600e3 ? cfg.today : isoOf(new Date()));

  function removeBar() {
    if (bar) { bar.remove(); bar = null; }
    document.documentElement.style.setProperty('--aviso-h', '0px');
    lastKey = '';
  }

  function render() {
    const st = compute(cfg, todayEff());
    if (!st.show) { removeBar(); return st; }
    const key = st.level + '|' + st.segments.join('|') + '|' + st.badge;
    if (bar && key === lastKey) return st; // nada cambió: la animación sigue sin saltos
    lastKey = key;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'avisoBar'; bar.setAttribute('role', 'alert');
      bar.addEventListener('click', () => openDetail(compute(cfg, todayEff())));
      document.body.insertBefore(bar, document.body.firstChild);
    }
    bar.className = 'aviso aviso-' + st.level;
    const block = st.segments.map((x) => `<span class="aviso-seg">${esc(x)}</span><span class="aviso-dot" aria-hidden="true">◆</span>`).join('');
    bar.innerHTML = `<span class="aviso-badge">${esc(st.badge)}</span>
      <div class="aviso-view" aria-label="${esc(st.segments.join('. '))}"><div class="aviso-track" aria-hidden="true"><div class="aviso-seq">${block}</div><div class="aviso-seq">${block}</div></div></div>`;
    // Se repite el bloque hasta que una secuencia llene el ancho; la velocidad es constante
    requestAnimationFrame(() => {
      if (!bar) return;
      const view = bar.querySelector('.aviso-view'), track = bar.querySelector('.aviso-track'), seqs = track.querySelectorAll('.aviso-seq');
      const w1 = seqs[0].scrollWidth || 1, need = Math.max(1, Math.ceil((view.clientWidth + 40) / w1));
      if (need > 1) seqs.forEach((s) => { s.innerHTML = block.repeat(need); });
      const w = seqs[0].scrollWidth || w1;
      track.style.setProperty('--aviso-dur', Math.max(8, Math.round(w / SPEED)) + 's');
      document.documentElement.style.setProperty('--aviso-h', bar.offsetHeight + 'px');
    });
    document.documentElement.style.setProperty('--aviso-h', bar.offsetHeight + 'px');
    return st;
  }

  function openDetail(st) {
    const PV = global.PV;
    if (!st.show || !PV || !PV.openSheet) return;
    PV.openSheet(`
      <div class="row"><h2 class="grow">${st.level === 'warn' ? '⏳' : '⚠️'} Prueba gratuita</h2><button class="icon-btn" data-close aria-label="Cerrar">×</button></div>
      <div class="hint ${st.level === 'warn' ? '' : 'warn'}"><b>${esc(st.segments[0])}</b><br>${esc(st.segments[1])}</div>
      <p>${esc(st.message)}.</p>
      <p class="muted">La prueba gratuita termina el <b>${esc(longDate(st.endsAt))}</b>.${st.contact ? ` Para renovar la suscripción contacta a <b>${esc(st.contact)}</b>.` : ''}</p>
      <div class="actions"><button class="btn btn-primary" data-close>Entendido</button></div>`);
  }

  /** Notificación en la campana (y aviso en pantalla), una vez al día por equipo. */
  async function notifyOnce(st) {
    const PV = global.PV;
    if (!st.show || !PV || !PV.localNotif || !global.DB) return;
    const day = todayEff();
    try {
      if ((await global.DB.getMeta('avisoNotifDay', '')) === day) return;
      await global.DB.setMeta('avisoNotifDay', day);
    } catch (e) { return; }
    PV.localNotif({ kind: 'suscripcion', icon: st.level === 'warn' ? '⏳' : '⚠️', msg: st.notif, warn: true });
    if (PV.toast) PV.toast(st.notif, 'err');
  }

  async function load() {
    let fresh = null;
    try {
      const r = await fetch('/api/pedidos/aviso', { cache: 'no-store', credentials: 'same-origin' });
      if (r.ok) fresh = await r.json();
    } catch (e) { /* sin internet: se usa lo último guardado */ }
    if (fresh && typeof fresh === 'object') {
      cfg = fresh; fetchedAt = Date.now();
      try { await global.DB.setMeta('aviso', { cfg, fetchedAt }); } catch (e) { /* noop */ }
    }
    const st = render();
    notifyOnce(st);
  }

  async function start() {
    try { const c = await global.DB.getMeta('aviso', null); if (c && c.cfg) { cfg = c.cfg; fetchedAt = c.fetchedAt || 0; render(); } } catch (e) { /* noop */ }
    await load();
    clearInterval(timer); timer = setInterval(load, 30 * 60000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
    window.addEventListener('online', load);
    window.addEventListener('resize', () => { if (bar) { lastKey = ''; render(); } });
  }

  global.Aviso = { compute, start, load, longDate, isoOf };
})(window);
