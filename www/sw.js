// Service Worker for R/C Dynamic Chassis Control PWA
const CACHE_NAME = 'rcdcc-v6'; // Bumped for consolidated Lights page (removed Settings tab, all mgmt on main page)
const urlsToCache = [
  '/index.html',
  '/css/app.css',
  '/css/bootstrap.min.css',
  '/css/fonts.css',
  '/css/all.min.css',
  '/css/css2.css',
  '/js/app.js',
  '/js/console.js',
  '/js/bootstrap.bundle.min.js',
  '/site.webmanifest',
  '/sw.js',
  '/toasty/dist/toasty.min.css',
  'https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&displayswap',
  'https://cdn.jsdelivr.net/npm/nouislider@15.7.1/dist/nouislider.min.css'
];

// Install event - cache resources
self.addEventListener('install', event => {
  console.log('[Service Worker] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('[Service Worker] Caching app shell');
        return cache.addAll(urlsToCache.filter(url => !url.startsWith('http'))); // Only cache local files initially
      })
      .catch(err => console.warn('[Service Worker] Cache installation failed:', err))
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', event => {
  console.log('[Service Worker] Activating...');
  event.waitUntil(
    caches.keys().then(cacheNames => {
      return Promise.all(
        cacheNames.filter(cacheName => {
          return cacheName !== CACHE_NAME;
        }).map(cacheName => {
          console.log('[Service Worker] Deleting old cache:', cacheName);
          return caches.delete(cacheName);
        })
      );
    })
  );
  return self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', event => {
  // Skip non-GET requests
  if (event.request.method !== 'GET') {
    return;
  }

  // Only handle cacheable web schemes. This avoids cache.put failures for extension requests.
  const requestUrl = event.request.url;
  if (!(requestUrl.startsWith('http://') || requestUrl.startsWith('https://'))) {
    return;
  }

  // Skip WebSocket requests
  if (event.request.url.startsWith('ws://') || event.request.url.startsWith('wss://')) {
    return;
  }

  // Skip ESP32 API requests (always fetch fresh)
  if (event.request.url.includes('/api/')) {
    return;
  }

  const destination = event.request.destination;

  // Use network-first for app shell assets to avoid stale UI/JS after updates.
  if (destination === 'document' || destination === 'script' || destination === 'style') {
    event.respondWith(
      fetch(event.request)
        .then(fetchResponse => {
          if (fetchResponse && fetchResponse.status === 200) {
            const responseToCache = fetchResponse.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, responseToCache));
          }
          return fetchResponse;
        })
        .catch(() => caches.match(event.request))
        .then(response => {
          if (response) return response;
          if (destination === 'document') {
            return caches.match('/index.html');
          }
          return undefined;
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // Return cached version or fetch from network
        return response || fetch(event.request)
          .then(fetchResponse => {
            // Cache new resources (only http/https schemes)
            if (fetchResponse && fetchResponse.status === 200 && 
                (event.request.url.startsWith('http://') || event.request.url.startsWith('https://'))) {
              const responseToCache = fetchResponse.clone();
              caches.open(CACHE_NAME)
                .then(cache => {
                  cache.put(event.request, responseToCache);
                });
            }
            return fetchResponse;
          });
      })
      .catch(() => {
        // Fallback for offline mode
        if (event.request.destination === 'document') {
          return caches.match('/index.html');
        }
      })
  );
});

console.log('[Service Worker] Loaded');
