/* Bedeem service worker – gjør at siden og bufferen virker uten nett.
   - Appfiler: cache først, oppdateres i bakgrunnen.
   - Data (data/…): nett først med tidsavbrudd, ellers cache. */
const VERSION = 'bedeem-v1';
const SHELL = ['./', 'index.html', 'styles.css', 'app.js', 'sources.json', 'manifest.webmanifest', 'icon.svg'];
const NET_TIMEOUT = 12000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await Promise.all(SHELL.map((u) => cache.add(u).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== VERSION) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.includes('/data/')) event.respondWith(networkFirst(req));
  else event.respondWith(staleWhileRevalidate(req));
});

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), NET_TIMEOUT);
  try {
    const res = await fetch(req, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(() => null);
      return res;
    }
    const cached = await cache.match(req, { ignoreSearch: true });
    return cached || res;
  } catch (e) {
    clearTimeout(timer);
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => null);
    return res;
  }).catch(() => null);
  if (cached) {
    network.catch(() => null);
    return cached;
  }
  const res = await network;
  return res || new Response('Frakoblet', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
