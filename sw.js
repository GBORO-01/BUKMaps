/* ================================================================
   BUK NAVIGATE — SERVICE WORKER
   Strategy:
   - App shell  → Cache First (instant load always)
   - Map tiles  → Cache First, network fallback (offline map)
   - Library    → Network First, cache fallback (fresh content)
   - OSRM route → Network only (routing needs live connection)
================================================================ */

const APP_VERSION   = 'v2.0.0';
const SHELL_CACHE   = `buk-shell-${APP_VERSION}`;
const TILE_CACHE    = `buk-tiles-${APP_VERSION}`;
const DATA_CACHE    = `buk-data-${APP_VERSION}`;

const SHELL_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdn.jsdelivr.net/npm/fuse.js@7.0.0/dist/fuse.min.js',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap',
];

/* ----------------------------------------------------------------
   INSTALL — cache shell assets
---------------------------------------------------------------- */
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell cache failed:', err))
  );
});

/* ----------------------------------------------------------------
   ACTIVATE — purge old caches
---------------------------------------------------------------- */
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => ![SHELL_CACHE, TILE_CACHE, DATA_CACHE].includes(k))
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ----------------------------------------------------------------
   FETCH — route by URL pattern
---------------------------------------------------------------- */
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET and chrome-extension requests
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // OSRM routing — network only (no point caching ephemeral routes)
  if (url.hostname.includes('osrm') || url.hostname.includes('router.project-osrm')) {
    event.respondWith(fetch(request));
    return;
  }

  // Map tiles (ESRI + CartoDB) — cache first
  if (
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('arcgis.com') ||
    url.hostname.includes('cartocdn.com') ||
    url.hostname.includes('basemaps.cartocdn.com')
  ) {
    event.respondWith(tileStrategy(request));
    return;
  }

  // Library PDFs / external data — network first, cache fallback
  if (
    url.hostname.includes('raw.githubusercontent.com') ||
    url.hostname.includes('drive.google.com')
  ) {
    event.respondWith(networkFirst(request, DATA_CACHE));
    return;
  }

  // Google Fonts — cache first (they don't change)
  if (
    url.hostname.includes('fonts.googleapis.com') ||
    url.hostname.includes('fonts.gstatic.com')
  ) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
    return;
  }

  // App shell & CDN assets — cache first
  event.respondWith(cacheFirst(request, SHELL_CACHE));
});

/* ----------------------------------------------------------------
   STRATEGY: Cache First
---------------------------------------------------------------- */
async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

/* ----------------------------------------------------------------
   STRATEGY: Tile Cache (cache first, cap at 3000 entries)
---------------------------------------------------------------- */
async function tileStrategy(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      // Enforce tile cache limit to protect storage quota
      await enforceTileLimit(cache, 3000);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return a 1×1 transparent PNG as offline tile placeholder
    const blank = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    return new Response(
      Uint8Array.from(atob(blank), c => c.charCodeAt(0)),
      { headers: { 'Content-Type': 'image/png' } }
    );
  }
}

async function enforceTileLimit(cache, max) {
  const keys = await cache.keys();
  if (keys.length >= max) {
    // Delete oldest 10% to make room
    const toDelete = keys.slice(0, Math.ceil(max * 0.10));
    await Promise.all(toDelete.map(k => cache.delete(k)));
  }
}

/* ----------------------------------------------------------------
   STRATEGY: Network First, cache fallback
---------------------------------------------------------------- */
async function networkFirst(request, cacheName) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

/* ----------------------------------------------------------------
   PRECACHE TILES message handler
   Receives {type, bounds, zooms} from the main app and
   systematically pre-fetches all tiles within the campus boundary
   at each specified zoom level.
---------------------------------------------------------------- */
self.addEventListener('message', event => {
  if (event.data?.type === 'PRECACHE_TILES') {
    const { bounds, zooms } = event.data;
    precacheTiles(bounds, zooms).catch(err =>
      console.warn('[SW] Tile precache error:', err)
    );
  }
});

async function precacheTiles(bounds, zooms) {
  const cache = await caches.open(TILE_CACHE);
  const [[minLat, minLng], [maxLat, maxLng]] = bounds;

  for (const z of zooms) {
    const tileRange = latLngBoundsToTileRange(minLat, minLng, maxLat, maxLng, z);
    const { minX, maxX, minY, maxY } = tileRange;

    for (let x = minX; x <= maxX; x++) {
      for (let y = minY; y <= maxY; y++) {
        // ESRI: {z}/{y}/{x}  ← note the y/x swap — critical
        const esriUrl = `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;
        const cartoUrl = `https://a.basemaps.cartocdn.com/light_only_labels/${z}/${x}/${y}.png`;

        for (const url of [esriUrl, cartoUrl]) {
          const req = new Request(url);
          const hit = await cache.match(req);
          if (!hit) {
            try {
              const resp = await fetch(req);
              if (resp.ok) cache.put(req, resp);
            } catch { /* silent — tile precache is best-effort */ }
          }
        }
      }
    }
  }
  console.log(`[SW] Tile precache complete for zooms ${zooms.join(',')}`);
}

/* ----------------------------------------------------------------
   TILE MATH — convert lat/lng bounds to x/y tile indices
   Standard Web Mercator tile coordinates (Leaflet default)
---------------------------------------------------------------- */
function latLngToTile(lat, lng, z) {
  const n = Math.pow(2, z);
  const x = Math.floor((lng + 180) / 360 * n);
  const latRad = lat * Math.PI / 180;
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
  return { x, y };
}

function latLngBoundsToTileRange(minLat, minLng, maxLat, maxLng, z) {
  const sw = latLngToTile(minLat, minLng, z);
  const ne = latLngToTile(maxLat, maxLng, z);
  return {
    minX: Math.min(sw.x, ne.x),
    maxX: Math.max(sw.x, ne.x),
    minY: Math.min(sw.y, ne.y),
    maxY: Math.max(sw.y, ne.y),
  };
}
