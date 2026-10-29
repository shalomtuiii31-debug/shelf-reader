// Caches the app so it opens with no internet. Books themselves live in IndexedDB.
const CACHE = 'shelf-v9';
// Voice engine files and downloaded voices are large and rarely change, so they live in their own cache that survives updates.
const VOICES = 'shelf-voices';
const isVoiceFile = url => url.hostname.endsWith('huggingface.co') || url.hostname === 'cdn.mangaupdates.com' || url.pathname.includes('/vendor/');
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'follow.js', 'jszip.min.js', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== VOICES).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Serve from cache straight away, refresh the cache in the background when online.
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (isVoiceFile(url)) {
    e.respondWith(caches.open(VOICES).then(async cache => {
      const cached = await cache.match(e.request);
      if (cached) return cached;
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin !== location.origin) return;
  // Release dates change hourly: try the network first, fall back to the cached copy offline.
  if (url.pathname.endsWith('/releases.json')) {
    e.respondWith(fetch(e.request).then(res => {
      if (res.ok) caches.open(CACHE).then(c => c.put(e.request, res.clone()));
      return res.clone();
    }).catch(() => caches.match(e.request)));
    return;
  }
  e.respondWith(caches.open(CACHE).then(async cache => {
    const cached = await cache.match(e.request, { ignoreSearch: true });
    // Bypass the browser's HTTP cache so updates arrive straight away.
    const fresh = fetch(e.request.url, { cache: 'no-cache' }).then(res => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => cached);
    return cached || fresh;
  }));
});
