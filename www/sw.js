// ══════════════════════════════════════════════════════
// YardiGo Service Worker v1.0
// Strategie: Cache First voor assets, Network First voor data
// ══════════════════════════════════════════════════════

const CACHE_NAME = 'yardigo-v1';
const OFFLINE_URL = '/offline.html';

// Bestanden die altijd gecached worden bij installatie
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
  // Leaflet via CDN — cached bij eerste gebruik
];

// CDN assets die gecached worden
const CDN_CACHE_NAME = 'yardigo-cdn-v1';
const CDN_DOMAINS = [
  'unpkg.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'tile.openstreetmap.org',
];

// Afbeeldingen cache (Unsplash foto's)
const IMG_CACHE_NAME = 'yardigo-images-v1';
const IMG_MAX_AGE = 7 * 24 * 60 * 60; // 7 dagen

// ── INSTALL ──
self.addEventListener('install', function(event) {
  console.log('[SW] Installing YardiGo v1...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_ASSETS.filter(function(url) {
        // Sla bestanden over die mogelijk niet bestaan
        return !url.includes('screenshot');
      }));
    }).then(function() {
      console.log('[SW] Precache complete');
      return self.skipWaiting();
    }).catch(function(err) {
      console.log('[SW] Precache failed (some assets missing, continuing):', err.message);
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ──
self.addEventListener('activate', function(event) {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) {
            // Verwijder oude caches
            return name.startsWith('yardigo-') &&
              name !== CACHE_NAME &&
              name !== CDN_CACHE_NAME &&
              name !== IMG_CACHE_NAME;
          })
          .map(function(name) {
            console.log('[SW] Deleting old cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH ──
self.addEventListener('fetch', function(event) {
  var url = new URL(event.request.url);

  // Negeer niet-GET requests
  if (event.request.method !== 'GET') return;

  // Negeer browser-extensions
  if (!url.protocol.startsWith('http')) return;

  // ── OSM kaart tiles: Cache First (tiles veranderen zelden) ──
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(cacheFirst(event.request, CDN_CACHE_NAME));
    return;
  }

  // ── Unsplash foto's: Cache First met expiry ──
  if (url.hostname.includes('unsplash.com') || url.hostname.includes('images.unsplash.com')) {
    event.respondWith(cacheFirst(event.request, IMG_CACHE_NAME));
    return;
  }

  // ── CDN assets (Leaflet, fonts): Cache First ──
  if (CDN_DOMAINS.some(function(d) { return url.hostname.includes(d); })) {
    event.respondWith(cacheFirst(event.request, CDN_CACHE_NAME));
    return;
  }

  // ── App shell (HTML, manifest): Network First met cache fallback ──
  if (url.origin === self.location.origin) {
    event.respondWith(networkFirst(event.request));
    return;
  }
});

// ── Cache First strategie ──
function cacheFirst(request, cacheName) {
  return caches.open(cacheName).then(function(cache) {
    return cache.match(request).then(function(cached) {
      if (cached) return cached;
      return fetch(request).then(function(response) {
        if (response && response.status === 200) {
          cache.put(request, response.clone());
        }
        return response;
      }).catch(function() {
        return new Response('', { status: 503 });
      });
    });
  });
}

// ── Network First strategie ──
function networkFirst(request) {
  return fetch(request).then(function(response) {
    if (response && response.status === 200) {
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(request, response.clone());
      });
    }
    return response;
  }).catch(function() {
    // Network failed — try cache
    return caches.match(request).then(function(cached) {
      if (cached) return cached;
      // Return offline page for navigation requests
      if (request.mode === 'navigate') {
        return caches.match('/') || new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>YardiGo — Offline</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Poppins,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#F9F5EF;color:#2C2416;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:24px;font-weight:800;margin-bottom:8px}p{color:#7A6E62;margin-bottom:24px}button{background:#E07B39;color:white;border:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body><div style="font-size:52px;margin-bottom:16px">📡</div><h1>Geen verbinding</h1><p>YardiGo heeft internet nodig om verkopen te laden.<br>Controleer je verbinding en probeer opnieuw.</p><button onclick="location.reload()">Opnieuw proberen</button></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      return new Response('', { status: 503 });
    });
  });
}

// ── PUSH NOTIFICATIONS ──
self.addEventListener('push', function(event) {
  if (!event.data) return;
  var data = event.data.json();
  var options = {
    body: data.body || 'Nieuwe verkoop in jouw buurt!',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    image: data.image || null,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/' },
    actions: [
      { action: 'open', title: 'Bekijken' },
      { action: 'dismiss', title: 'Sluiten' }
    ]
  };
  event.waitUntil(
    self.registration.showNotification(data.title || 'YardiGo', options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'dismiss') return;
  var url = event.notification.data && event.notification.data.url ? event.notification.data.url : '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        if (clientList[i].url === url && 'focus' in clientList[i]) {
          return clientList[i].focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
