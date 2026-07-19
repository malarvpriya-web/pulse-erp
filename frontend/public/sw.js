/* global clients */
/* ─── Pulse ERP Service Worker ─────────────────────────────────
   Strategy:
     • Static assets  → Cache-First  (JS, CSS, images, fonts)
     • API calls      → Network-First (/api/*)
     • Navigation     → Network-First with offline fallback
     • Background sync for failed POST requests
     • Push notification handler
──────────────────────────────────────────────────────────────── */

const CACHE_VERSION = 'pulse-erp-v10';
const STATIC_CACHE  = `${CACHE_VERSION}-static`;
const API_CACHE     = `${CACHE_VERSION}-api`;
const SYNC_QUEUE    = 'pulse-sync-queue';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#7c3aed" />
  <title>Pulse ERP — Offline</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           background: #f5f3ff; display: flex; align-items: center;
           justify-content: center; min-height: 100vh; }
    .card { background: #fff; border: 1px solid #e9e4ff; border-radius: 16px;
            padding: 48px 40px; text-align: center; max-width: 420px; width: 90%; }
    .icon { font-size: 64px; margin-bottom: 24px; }
    h1 { color: #4c1d95; font-size: 22px; margin-bottom: 12px; }
    p { color: #6b7280; font-size: 15px; line-height: 1.6; margin-bottom: 24px; }
    button { background: #7c3aed; color: #fff; border: none; border-radius: 10px;
             padding: 12px 28px; font-size: 15px; font-weight: 700; cursor: pointer; }
    button:hover { background: #6d28d9; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">📡</div>
    <h1>You are offline</h1>
    <p>Pulse ERP needs an internet connection to load. Please check your network and try again.</p>
    <button onclick="window.location.reload()">Retry</button>
  </div>
</body>
</html>`;

/* ─── Install ─────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Ignore cache failures for individual assets at install time
      });
    })
  );
  self.skipWaiting();
});

/* ─── Activate — purge old caches ────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== STATIC_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

/* ─── Fetch ───────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-http(s) requests and browser-extension requests
  if (!url.protocol.startsWith('http')) return;

  // API calls — Network-First
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // CSS & JS — Network-First (always fetch latest code and styles)
  if (/\.(css|js)$/.test(url.pathname)) {
    event.respondWith(networkFirstAPI(request));
    return;
  }

  // Static assets (images, fonts, icons) — Cache-First
  const isStatic = /\.(png|jpg|jpeg|gif|svg|woff|woff2|ttf|ico|webp)$/.test(url.pathname);
  if (isStatic) {
    event.respondWith(cacheFirstStatic(request));
    return;
  }

  // Navigation requests — Network-First with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(navigationHandler(request));
    return;
  }

  // Default — try network, fallback to cache
  event.respondWith(
    fetch(request).catch(() => caches.match(request))
  );
});

/* ─── Strategies ─────────────────────────────────────────────── */
async function networkFirstAPI(request) {
  try {
    const response = await fetch(request.clone());
    if (response.ok) {
      const cache = await caches.open(API_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'Offline — cached data unavailable' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function cacheFirstStatic(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('', { status: 404 });
  }
}

async function navigationHandler(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch {
    const cached = await caches.match(request) || await caches.match('/');
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

/* ─── Background Sync — queue failed POST requests ───────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST') return;
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return;

  // Already handled above — this is a safety net for POST queuing
  event.waitUntil(
    (async () => {
      try {
        await fetch(request.clone());
      } catch {
        // Queue failed POST for retry when back online
        const db = await openSyncDB();
        const cloned = request.clone();
        const body = await cloned.text();
        db.add(SYNC_QUEUE, {
          url: request.url,
          method: request.method,
          headers: Object.fromEntries(request.headers.entries()),
          body,
          timestamp: Date.now(),
        });
      }
    })()
  );
});

self.addEventListener('sync', (event) => {
  if (event.tag === 'pulse-retry-queue') {
    event.waitUntil(retrySyncQueue());
  }
  if (event.tag === 'attendance-sync') {
    event.waitUntil(syncOfflinePunches());
  }
});

// ── Sync offline attendance punches to server ──────────────────────────────
async function syncOfflinePunches() {
  let db;
  try {
    db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('pulse_attendance', 1);
      req.onupgradeneeded = (e) =>
        e.target.result.createObjectStore('offline_punches', { keyPath: 'id', autoIncrement: true });
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = () => reject(req.error);
    });
  } catch { return; }

  const punches = await new Promise((res) => {
    const tx  = db.transaction('offline_punches', 'readonly');
    const req = tx.objectStore('offline_punches').getAll();
    req.onsuccess = () => res(req.result || []);
    req.onerror   = () => res([]);
  });

  if (!punches.length) return;

  // Send batch to the offline sync API
  const batchData = punches.map((p) => p.data);
  const token     = punches[0]?.auth_token || '';

  try {
    const resp = await fetch('/api/v1/attendance/offline/sync', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ punches: batchData }),
    });

    if (resp.ok) {
      const result = await resp.json();
      // Remove successfully processed punches from IDB
      if (result.processed > 0 || result.skipped > 0) {
        const delTx    = db.transaction('offline_punches', 'readwrite');
        const delStore = delTx.objectStore('offline_punches');
        for (const p of punches) delStore.delete(p.id);
      }
    }
  } catch { /* retry on next sync */ }
}

async function retrySyncQueue() {
  const db = await openSyncDB();
  const items = await db.getAll(SYNC_QUEUE);
  for (const item of items) {
    try {
      await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body,
      });
      await db.delete(SYNC_QUEUE, item.id);
    } catch {
      // Leave in queue to retry again later
    }
  }
}

/* tiny IndexedDB wrapper */
function openSyncDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('pulse-sync', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(SYNC_QUEUE)) {
        db.createObjectStore(SYNC_QUEUE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      resolve({
        add:    (store, val) => idbOp(db, store, 'readwrite', s => s.add(val)),
        getAll: (store)      => idbOp(db, store, 'readonly',  s => s.getAll()),
        delete: (store, key) => idbOp(db, store, 'readwrite', s => s.delete(key)),
      });
    };
    req.onerror = () => reject(req.error);
  });
}

function idbOp(db, store, mode, fn) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/* ─── Push Notifications ─────────────────────────────────────── */
self.addEventListener('push', (event) => {
  let data = { title: 'Pulse ERP', body: 'You have a new notification', icon: '/icons/icon-192.png' };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text();
    }
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body:    data.body,
      icon:    data.icon || '/icons/icon-192.png',
      badge:   '/icons/icon-192.png',
      vibrate: [200, 100, 200],
      tag:     data.tag || 'pulse-notification',
      data:    data.url ? { url: data.url } : {},
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

/* ─── Message handler (for applyUpdate from usePWA.js) ────────── */
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
