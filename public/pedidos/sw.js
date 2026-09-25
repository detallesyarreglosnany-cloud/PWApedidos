/* =========================================================================
 * Service Worker — app shell offline-first
 *  - Precarga todos los archivos estáticos (la app abre sin señal).
 *  - Estáticos: cache-first con revalidación en segundo plano.
 *  - /api/*: siempre red (los datos viven en IndexedDB, no en caché HTTP).
 * Subir CACHE_VERSION en cada despliegue para forzar la actualización.
 * ========================================================================= */
const CACHE_VERSION = 'pedidos-v15';
const SHELL = [
  './index.html', './styles.css', './manifest.webmanifest',
  './js/db.js', './js/seed.js', './js/matrix.js', './js/sync.js', './js/loads.js', './js/print.js',
  './js/importer.js', './js/app.js', './js/office.js', './js/supervisor.js', './js/main.js',
  './icons/icon-192.png', './icons/icon-512.png', './icons/logo-white.png', './icons/logo-print.png', './icons/mark-white.png',
  './fonts/oswald-latin-600-normal.woff2', './fonts/oswald-latin-700-normal.woff2',
  // vendor/xlsx.full.min.js (lector de Excel) se cachea la primera vez que se usa
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pedidos-') && k !== CACHE_VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return; // red directa

  // Navegación: devuelve el shell aunque no haya red
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }

  e.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req).then((res) => {
        if (res && res.ok) { const copy = res.clone(); caches.open(CACHE_VERSION).then((c) => c.put(req, copy)); }
        return res;
      }).catch(() => hit);
      return hit || net;
    })
  );
});

// ---- Notificaciones push (llegan con la app cerrada o la pantalla bloqueada) ----
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (err) { m = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Puerto Venado', {
    body: m.body || '', tag: m.tag || undefined, icon: './icons/icon-192.png', badge: './icons/icon-192.png',
    renotify: !!m.tag, data: { url: './index.html' },
  }));
  // Avisa a las pestañas abiertas para que sincronicen ya
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ type: 'push' }))));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    const open = cs.find((c) => c.url.includes('/pedidos/'));
    return open ? open.focus() : self.clients.openWindow('./index.html');
  }));
});
