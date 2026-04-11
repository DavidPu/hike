importScripts('sw-filelist.js');

const CACHE_VERSION = 'v5';
const CACHE_STATIC = `gpx-viewer-static-${CACHE_VERSION}`;
const CACHE_TILES = 'gpx-viewer-tiles';
const CACHE_RUNTIME = 'gpx-viewer-runtime';

const TILE_HOSTS = [
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
  'server.arcgisonline.com',
];

const APP_SHELL_FILES = ['index.html', 'app.js', 'style.css', 'manifest.json',
  'gpx-manifest.json', 'pics-manifest.json', 'sw-filelist.js'];

// ─── Install: precache all assets ───

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(async (cache) => {
      await cache.addAll(PRECACHE_LOCAL);
      await cache.addAll(PRECACHE_CDN);
      console.log(`[SW] Precached ${PRECACHE_LOCAL.length + PRECACHE_CDN.length} assets`);
    })
  );
  self.skipWaiting();
});

// ─── Activate: clean old caches ───

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('gpx-viewer-') && k !== CACHE_STATIC && k !== CACHE_TILES && k !== CACHE_RUNTIME)
          .map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ─── Fetch strategies ───

function isMapTile(url) {
  return TILE_HOSTS.some((host) => url.hostname.includes(host));
}

function isAppShell(url) {
  const path = url.pathname;
  return APP_SHELL_FILES.some((f) => path.endsWith('/' + f) || path === '/' + f || path.endsWith(f));
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Map tiles: stale-while-revalidate
  if (isMapTile(url)) {
    event.respondWith(
      caches.open(CACHE_TILES).then(async (cache) => {
        const cached = await cache.match(event.request);
        const fetchPromise = fetch(event.request)
          .then((response) => {
            if (response.ok) cache.put(event.request, response.clone());
            return response;
          })
          .catch(() => cached);
        return cached || fetchPromise;
      })
    );
    return;
  }

  // App shell files (HTML, JS, CSS, manifests): network-first
  if (isAppShell(url)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE_STATIC).then((c) => c.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Everything else (GPX, images, CDN libs): cache-first
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_RUNTIME).then((c) => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
