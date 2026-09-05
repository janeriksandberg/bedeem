/* Bedeem service worker – gjør at siden og bufferen virker uten nett.
   - Selve siden (navigasjon): nett først med kort tidsavbrudd, ellers cache, så nye versjoner vises straks.
   - Øvrige appfiler: cache først, oppdateres i bakgrunnen (alltid forbi HTTP-cachen).
   - Data (data/…): nett først med tidsavbrudd, ellers cache. */
const VERSION = 'bedeem-v8';
const SHELL = ['./', 'index.html', 'styles.css?v=8', 'app.js?v=8', 'sources.json', 'books.json', 'books-ledelse.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
const NET_TIMEOUT = 12000;
const NAV_TIMEOUT = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    // cache: 'reload' går forbi nettleserens HTTP-cache, så vi ikke lagrer gamle filer i ny versjon.
    await Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => null)));
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
  if (url.pathname.includes('/data/')) event.respondWith(networkFirst(req, NET_TIMEOUT, true));
  else if (req.mode === 'navigate') event.respondWith(networkFirst(req, NAV_TIMEOUT, false));
  else event.respondWith(staleWhileRevalidate(req));
});

function fetchWithTimeout(req, ms, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function networkFirst(req, timeout, ignoreSearch) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetchWithTimeout(req, timeout, { cache: 'no-cache' });
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(() => null);
      return res;
    }
    const cached = await cache.match(req, { ignoreSearch });
    return cached || res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch });
    if (cached) return cached;
    if (req.mode === 'navigate') {
      const shell = await cache.match('./') || await cache.match('index.html');
      if (shell) return shell;
    }
    return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  const network = fetch(req, { cache: 'no-cache' }).then((res) => {
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
