// Orchard SprayWise — Service Worker
// ─────────────────────────────────────────────────────────────────────────
// PURPOSE: Provide offline support without blocking app updates.
//
// STRATEGY: Network-first for the app shell (index.html, manifest), with
// cache as a fallback when the user is offline. This guarantees that every
// time a user opens the app with internet access, they get the latest
// version pushed to GitHub Pages — no stale cached HTML, no manual cache
// busting, no version bumping required for future updates.
//
// localStorage and IndexedDB are NEVER touched by this file. User data
// (orchards, varieties, products, spray log, notes) lives in localStorage
// under the eo5_ prefix and is completely separate from the Cache API
// that this service worker manages.
// ─────────────────────────────────────────────────────────────────────────

const CACHE_NAME = 'spraywise-v2';
const URLS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest'
];

// On install: pre-cache the app shell so the app works offline immediately
// after first load. Wrapped in try/catch via .catch() so a single failed
// resource (e.g., transient network error) doesn't break SW installation.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(URLS_TO_CACHE))
      .catch(err => {
        // Non-fatal: SW still installs, fetch handler will populate cache
        // organically as user navigates.
        console.warn('[SW] Pre-cache failed, will fill on demand:', err);
      })
  );
  self.skipWaiting();
});

// On activate: delete any caches that aren't the current version. This
// runs once when a new SW takes over and cleans up old cache buckets.
// Does NOT touch localStorage or IndexedDB.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// Fetch handler: network-first for the app shell, with cache fallback
// only when offline. This is the key change from v1 — it ensures users
// always get the latest index.html when they have a working connection.
self.addEventListener('fetch', event => {
  const req = event.request;

  // Only handle GET requests. POST/PUT/etc. go straight to network.
  if (req.method !== 'GET') return;

  const url = req.url;

  // External APIs (weather, geocoding, fonts) — always network-first,
  // fall back to cache if offline. Same as the original v1 behavior.
  if (
    url.includes('api.') ||
    url.includes('weather') ||
    url.includes('open-meteo') ||
    url.includes('fonts.googleapis.com') ||
    url.includes('fonts.gstatic.com')
  ) {
    event.respondWith(
      fetch(req).catch(() => caches.match(req))
    );
    return;
  }

  // App shell (HTML, JS, CSS, icons, manifest) — NETWORK-FIRST.
  // This guarantees fresh updates whenever the user is online.
  // If the network fetch succeeds, we update the cache in the background
  // so the freshest version is available offline next time.
  event.respondWith(
    fetch(req)
      .then(response => {
        // Only cache successful, non-opaque responses
        if (response && response.status === 200 && response.type === 'basic') {
          const responseClone = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(req, responseClone))
            .catch(() => { /* cache write failure is non-fatal */ });
        }
        return response;
      })
      .catch(() => {
        // Network failed — user is offline. Serve from cache.
        return caches.match(req).then(cached => {
          if (cached) return cached;
          // Last resort: if requesting a navigation and no cache, serve index.html
          if (req.mode === 'navigate') {
            return caches.match('/index.html');
          }
          // Nothing we can do — let the browser show its offline error.
          return new Response('Offline and not cached', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({ 'Content-Type': 'text/plain' })
          });
        });
      })
  );
});
