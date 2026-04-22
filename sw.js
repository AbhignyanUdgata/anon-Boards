// ANON·BOARDS Service Worker
// Provides offline fallback and asset caching for PWA support

const CACHE_NAME = 'anonboards-v1';
const OFFLINE_URL = '/offline.html';

// Assets to pre-cache on install
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/offline.html',
];

// ── INSTALL ──────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch(() => {
        // Silently fail if some assets aren't available yet
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ─────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keyList) => {
      return Promise.all(
        keyList
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// ── FETCH ─────────────────────────────────────────────────────────────────
// Strategy: Network-first for HTML, Cache-first for static assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only handle same-origin GET requests
  if (request.method !== 'GET' || url.origin !== self.location.origin) {
    return;
  }

  // Network-first for navigations (HTML pages)
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Cache-first for static assets (fonts, scripts, styles)
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        // Cache successful responses for CDN assets
        if (response.ok && (url.hostname.includes('cloudflare') || url.hostname.includes('googleapis'))) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      });
    })
  );
});
