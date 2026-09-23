/* =========================================================================
 * seed.js — Datos iniciales de Distribuidora de Suministros Puerto Venado
 *
 * - Vendedores con sus rutas y los alias con que aparecen en el sistema
 *   administrativo (para asignar la cartera al importar el Excel de clientes).
 * - Configuración compartida: rutas, despachadores y límites de la hoja de carga.
 * - Sin catálogo de demostración: el catálogo real y la cartera llegan por
 *   sincronización o por el paquete de arranque que importa la oficina.
 * ========================================================================= */
(function (global) {
  'use strict';

  const SEED_VERSION = 3;

  const ROUTES = ['CENTRO', 'BARRIOS', 'EJE NORTE', 'EJE CATANIAPO'];

  const SELLERS = [
    { id: 's_lucas', name: 'Lucas Ch.', routes: ['CENTRO'], aliases: ['LUCAS E CHAVEZ', 'LUCAS CHAVEZ'] },
    { id: 's_fanny', name: 'Fanny A.', routes: ['BARRIOS'], aliases: ['FAANY ARIAS', 'FANNY ARIAS'] },
    { id: 's_luis', name: 'Luis R.', routes: ['BARRIOS', 'EJE NORTE', 'EJE CATANIAPO'], aliases: ['LUIS RODRIGUEZ'] },
    { id: 's_adrian', name: 'Adrián M.', routes: [], aliases: ['ADRIAN MEDINA'] },
  ];

  const DISPATCHERS = [
    { id: 'd_ernesto', name: 'Ernesto Ch.' },
    { id: 'd_luist', name: 'Sr. Luis T.' },
    { id: 'd_douglas', name: 'Douglas Ch.' },
    { id: 'd_aquiles', name: 'Aquiles M.' },
  ];

  /**
   * Categorías = columna REF de la lista de precios de la empresa, agrupada por
   * familia. El orden (y los nombres) se ajustan en Oficina → Ajustes.
   */
  const RUBROS = [
    'REFRESCOS', 'SODA', 'JUGO', 'NECTAR', 'AGUA', 'MALTA', 'CERVEZA', 'SARDINA', 'CONFITERIA', 'GALLETA',
    'ARROZ', 'PASTA', 'MERMELADA', 'GELATINA', 'SALSA', 'MAYONESA', 'MOSTAZA', 'LICOR',
  ];

  function defaultConfig() {
    return {
      id: 'main',
      company: {
        name: 'Distribuidora de Suministros Puerto Venado',
        short: 'Puerto Venado',
        rif: '', phone: '', address: 'Puerto Ayacucho, Amazonas',
      },
      routes: ROUTES.slice(),
      dispatchers: DISPATCHERS.map((d) => ({ ...d })),
      rubros: RUBROS.slice(),
      load: { limit: 900, maxClients: 32, measure: 'bultos' }, // bultos = cajas + unid. sueltas
      priceListDate: '',
      adminName: 'Daniela',
      footer: '© 2026 Distribuidora de Suministros Puerto Venado · Desarrollado por Daniela Silva',
      exchangeRate: 0,
      counters: { load: 0, note: 0 },
      updatedAt: new Date().toISOString(), deleted: false, dirty: true,
    };
  }

  function buildSellers() {
    const ts = new Date().toISOString();
    return SELLERS.map((s) => ({ ...s, active: true, updatedAt: ts, deleted: false, dirty: true }));
  }

  /**
   * Arranque SIN datos de demostración: solo la estructura (vendedores con sus
   * rutas, despachadores, límites de carga). El catálogo y la cartera de
   * clientes llegan por el sync o por el "paquete de arranque" que carga la
   * oficina (así los precios y los datos de clientes no viajan en el código).
   */
  async function ensureSeed() {
    const version = await DB.getMeta('seedVersion', 0);
    if (version >= SEED_VERSION) return false;
    const [products, sellers, config] = await Promise.all([
      DB.getAll('products'), DB.getAll('sellers'), DB.getAll('config'),
    ]);
    if (!config.length) await DB.put('config', defaultConfig());

    // Vendedores: crear o completar rutas/alias sin pisar lo editado
    const byId = new Map(sellers.map((s) => [s.id, s]));
    const upd = buildSellers().map((def) => {
      const cur = byId.get(def.id);
      if (!cur) return def;
      if (Array.isArray(cur.routes) && cur.aliases) return null;
      return { ...cur, routes: cur.routes || def.routes, aliases: cur.aliases || def.aliases, updatedAt: def.updatedAt, dirty: true };
    }).filter(Boolean);
    await DB.putMany('sellers', upd);

    // Borrar productos de demostración de versiones anteriores
    const ts = new Date().toISOString();
    const demo = products.filter((p) => !p.deleted && (p.demo || /^p_(ref|agu|cer|mal|jug|kai|alc|con|gal|snk|pap|sal|viv)-\d{3}$/.test(p.id)));
    await DB.putMany('products', demo.map((p) => ({ ...p, deleted: true, active: false, updatedAt: ts, dirty: true })));
    await DB.setMeta('seedVersion', SEED_VERSION);
    return true;
  }

  global.Seed = { ensureSeed, buildSellers, defaultConfig, RUBROS, ROUTES };
})(window);
