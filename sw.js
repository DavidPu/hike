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

// ─── Install: precache app shell + all assets ───

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
          .filter((k) => k.startsWith('gpx-viewer-static-') && k !== CACHE_STATIC)
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

function isManifestFile(url) {
  const path = url.pathname;
  return path.endsWith('gpx-manifest.json') || path.endsWith('pics-manifest.json');
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;

  // Map tiles: stale-while-revalidate — serve cached, refresh in background
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

  // Manifest JSONs: network-first with cache fallback
  if (isManifestFile(url)) {
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

  // Everything else: cache-first
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
