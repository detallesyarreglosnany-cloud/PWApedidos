// Respaldo automático del servidor (lo corre GitHub Actions; también se puede correr a mano).
//
// Baja TODO por la misma ruta que el botón «Respaldo del servidor» de la oficina
// (POST /api/pedidos/backup, por páginas) y arma el MISMO archivo: se restaura en
// la app con Oficina → Ajustes → «Cargar paquete».
//
// Variables: PEDIDOS_URL (ej: https://mi-app.vercel.app), PEDIDOS_SYNC_KEY, PEDIDOS_ADMIN_KEY
// Uso: node scripts/respaldo.mjs <carpeta-de-salida>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const base = String(process.env.PEDIDOS_URL || '').replace(/\/+$/, '');
const syncKey = process.env.PEDIDOS_SYNC_KEY || '';
const adminKey = process.env.PEDIDOS_ADMIN_KEY || '';
const outDir = process.argv[2] || 'respaldo';
if (!base || !adminKey) { console.error('Faltan PEDIDOS_URL y/o PEDIDOS_ADMIN_KEY'); process.exit(1); }

const KINDS = ['orders', 'clients', 'products', 'sellers', 'loads', 'config', 'events'];
async function page(after) {
  for (let i = 1; ; i++) {
    try {
      const r = await fetch(base + '/api/pedidos/backup', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sync-key': syncKey, 'x-admin-key': adminKey },
        body: JSON.stringify({ after }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${j.error || 'sin detalle'}`);
      return j;
    } catch (e) {
      if (i >= 4 || /HTTP 40[13]/.test(String(e.message))) throw e; // clave mala: no reintentar
      console.warn(`Intento ${i} falló (${e.message}); reintento…`);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** i));
    }
  }
}

const bundle = { format: 'distribuidora-pedidos/v1', kind: 'respaldo-servidor', exportedAt: new Date().toISOString(), deviceId: 'github-actions' };
KINDS.forEach((k) => { bundle[k] = []; });
const images = new Map();
let after = null, n = 0;
for (;;) {
  const r = await page(after);
  for (const { kind, doc } of r.docs || []) {
    if (kind === 'images') images.set(doc.id, doc.image);
    else (bundle[kind] = bundle[kind] || []).push(doc);
  }
  n += (r.docs || []).length;
  if (!r.next) { bundle.counters = r.counters || {}; bundle.vacmovs = r.vacmovs || []; break; }
  after = r.next;
}
// Las fotos (guardadas aparte en el servidor) vuelven dentro de su producto
for (const p of bundle.products) if (!p.image && images.get(p.id)) p.image = images.get(p.id);

const count = Object.fromEntries([...KINDS.map((k) => [k, bundle[k].length]), ['fotos', images.size], ['vacios', bundle.vacmovs.length]]);
if (!bundle.config.length || !bundle.products.length) {
  // Un respaldo vacío nunca reemplaza en silencio a uno bueno: falla y avisa
  console.error('El respaldo vino vacío (sin ajustes o sin catálogo):', JSON.stringify(count));
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const day = bundle.exportedAt.slice(0, 10);
const file = join(outDir, `respaldo_puerto_venado_${day}.json`);
writeFileSync(file, JSON.stringify(bundle));
writeFileSync(join(outDir, 'resumen.json'), JSON.stringify({ exportedAt: bundle.exportedAt, documentos: n, ...count }, null, 2));
console.log(`Respaldo listo: ${file}`);
console.log(JSON.stringify(count));
