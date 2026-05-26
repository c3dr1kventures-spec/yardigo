// ══════════════════════════════════════════════════════
// YardiGo Service Worker v4.0 — 2026-05-27
// ──────────────────────────────────────────────────────
// Strategie: ALLEEN same-origin HTML/JS/CSS via networkFirst.
// Cross-origin requests (Leaflet, Google Fonts, CARTO tiles,
// Supabase, Unsplash) gaan direct via de browser — geen SW
// intercept. De browser-HTTP-cache regelt caching prima en
// op iOS Safari leverde SW-intercept regelmatig kapotte of
// opaque responses op, waardoor Leaflet helemaal niet meer
// laadde en de gebruiker op de fallback-map bleef hangen.
// ══════════════════════════════════════════════════════

const CACHE_NAME = 'yardigo-v4';
const OFFLINE_URL = '/offline.html';

const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

// ── INSTALL ──
self.addEventListener('install', function(event) {
  console.log('[SW v4] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE_ASSETS.filter(function(url) {
        return !url.includes('screenshot');
      }));
    }).then(function() {
      console.log('[SW v4] Precache complete');
      return self.skipWaiting();
    }).catch(function(err) {
      console.log('[SW v4] Precache failed (continuing):', err.message);
      return self.skipWaiting();
    })
  );
});

// ── ACTIVATE ──
// Verwijder ALLE oude YardiGo-caches (v1, v2, v3, cdn-*, images-*).
// We laten cross-origin assets nu door de browser-cache afhandelen.
self.addEventListener('activate', function(event) {
  console.log('[SW v4] Activating — opruimen oude caches...');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) {
            return name.startsWith('yardigo-') && name !== CACHE_NAME;
          })
          .map(function(name) {
            console.log('[SW v4] Verwijder oude cache:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// ── FETCH ──
// REGEL: Alleen same-origin GET requests intercepteren.
// Alles cross-origin (CDN, Supabase, basemap tiles, fonts) gaat
// direct via de browser. Dit voorkomt opaque-response problemen
// op iOS Safari die Leaflet-script-load deden falen.
self.addEventListener('fetch', function(event) {
  if (event.request.method !== 'GET') return;

  var url;
  try { url = new URL(event.request.url); } catch(e) { return; }
  if (!url.protocol.startsWith('http')) return;

  // Cross-origin? Niet aanraken. Browser regelt caching zelf.
  if (url.origin !== self.location.origin) return;

  // Same-origin: networkFirst zodat updates direct landen.
  event.respondWith(networkFirst(event.request));
});

// ── Network First voor same-origin HTML/JS/CSS ──
// Probeert eerst het netwerk (max 4s). Lukt dat niet, dan cache.
// Lukt cache ook niet, dan offline-pagina voor navigatie-requests.
function networkFirst(request) {
  var timeoutId;
  var timeoutPromise = new Promise(function(resolve) {
    timeoutId = setTimeout(function() { resolve(null); }, 4000);
  });
  var fetchPromise = fetch(request).then(function(response) {
    clearTimeout(timeoutId);
    if (response && response.status === 200) {
      var clone = response.clone();
      caches.open(CACHE_NAME).then(function(cache) {
        cache.put(request, clone).catch(function(){});
      });
    }
    return response;
  }).catch(function() { return null; });

  return Promise.race([fetchPromise, timeoutPromise]).then(function(response) {
    if (response) return response;
    return caches.match(request).then(function(cached) {
      if (cached) return cached;
      if (request.mode === 'navigate') {
        return caches.match('/') || new Response(
          '<!DOCTYPE html><html><head><meta charset="utf-8"><title>YardiGo — Offline</title><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:Poppins,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;margin:0;background:#F9F5EF;color:#2C2416;text-align:center;padding:24px;box-sizing:border-box}h1{font-size:24px;font-weight:800;margin-bottom:8px}p{color:#7A6E62;margin-bottom:24px}button{background:#E07B39;color:white;border:none;border-radius:12px;padding:14px 28px;font-size:15px;font-weight:700;cursor:pointer}</style></head><body><div style="font-size:52px;margin-bottom:16px">📡</div><h1>Geen verbinding</h1><p>YardiGo heeft internet nodig om verkopen te laden.<br>Controleer je verbinding en probeer opnieuw.</p><button onclick="location.reload()">Opnieuw proberen</button></body></html>',
          { headers: { 'Content-Type': 'text/html' } }
        );
      }
      // Voor niet-navigatie requests: laat de browser de fout zien
      // i.p.v. een nep-503 te returneren die scripts/css/img kapot maakt.
      return fetch(request).catch(function() {
        return new Response('', { status: 504, statusText: 'Gateway Timeout' });
      });
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
