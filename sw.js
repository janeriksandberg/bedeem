/* Bedeem service worker – gjør at siden, bufferen og bildene virker uten nett.
   - Selve siden (navigasjon): nett først med kort tidsavbrudd, ellers cache, så nye versjoner vises straks.
   - Øvrige appfiler: cache først, oppdateres i bakgrunnen (alltid forbi HTTP-cachen).
   - Data (data/…): håndteres av app.js, som laster ned alt til en egen cache og bytter atomisk
     (se «Synk» i app.js). Service workeren slipper slike forespørsler rett gjennom.
   - Bilder fra kildene: cache først fra en egen bildecache som overlever nye app-versjoner.
     Appen ber om forhåndsnedlasting av bildene i bufferen (melding «prefetch-images»).
   Ingenting lagret slettes før det nye er ferdig lastet ned. */
const VERSION = 'bedeem-v11';
const SHELL_PREFIX = 'bedeem-v';
const DATA_CACHE = 'bedeem-data';      // samme navn i app.js
const IMG_CACHE = 'bedeem-img';
const SHELL = ['./', 'index.html', 'styles.css?v=11', 'app.js?v=11', 'sources.json', 'books.json', 'books-ledelse.json', 'manifest.webmanifest', 'icon.svg', 'icon-192.png'];
const NAV_TIMEOUT = 4000;
const IMG_IDLE_TIMEOUT = 20000;        // avbryt et bilde som ikke har fått nye bytes på 20 s
const IMG_PARALLEL = 3;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    // Alt eller ingenting: mangler én appfil, feiler installasjonen og den gamle versjonen
    // fortsetter å virke (nettleseren prøver igjen senere). cache: 'reload' går forbi HTTP-cachen.
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Tidligere versjoner lagret data i app-cachen. Flytt dem over før den gamle cachen slettes.
    const data = await caches.open(DATA_CACHE);
    for (const k of await caches.keys()) {
      if (!k.startsWith(SHELL_PREFIX) || k === VERSION) continue;
      const old = await caches.open(k);
      for (const req of await old.keys()) {
        if (!new URL(req.url).pathname.includes('/data/')) continue;
        if (await data.match(req, { ignoreSearch: true })) continue;
        const res = await old.match(req);
        if (res && res.ok) await data.put(new URL(req.url).origin + new URL(req.url).pathname, res);
      }
      await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (req.destination === 'image' && url.protocol === 'https:') event.respondWith(imageCacheFirst(req));
    return;
  }
  if (url.pathname.includes('/data/')) return; // app.js styrer data selv
  if (req.mode === 'navigate') event.respondWith(navigation(req));
  else event.respondWith(staleWhileRevalidate(req));
});

function fetchWithTimeout(req, ms, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(req, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

async function navigation(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetchWithTimeout(req, NAV_TIMEOUT, { cache: 'no-cache' });
    if (res && res.ok) {
      cache.put(req, res.clone()).catch(() => null);
      return res;
    }
    return (await cache.match(req, { ignoreSearch: true })) || res;
  } catch (e) {
    const cached = await cache.match(req, { ignoreSearch: true }) || await cache.match('./') || await cache.match('index.html');
    return cached || new Response('Frakoblet', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
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

// ---------- Bilder ----------
// Bildene ligger hos kildene. Vi prøver CORS først (gir vanlige svar som tar lite plass i
// lagringskvoten); svarer verten uten CORS-hoder, hentes bildet «opaque» (no-cors), som også
// kan lagres og vises. Hvilken modus som virker, huskes per vert.
const hostMode = new Map();

// Laster ned hele bildet og lagrer det i bildecachen. cache.put lagrer først når hele svaret er
// mottatt, så et halvt nedlastet bilde blir aldri liggende. Står nedlastingen stille i
// IMG_IDLE_TIMEOUT, avbrytes den. Returnerer svaret som skal vises (eller kaster ved nettfeil).
async function downloadImage(url, cache) {
  const host = new URL(url).host;
  const modes = hostMode.get(host) === 'no-cors' ? ['no-cors'] : ['cors', 'no-cors'];
  let lastErr;
  for (const mode of modes) {
    const ctrl = new AbortController();
    let timer;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), IMG_IDLE_TIMEOUT); };
    arm();
    try {
      const res = await fetch(url, { mode, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      if (res.type === 'opaque') {
        // Innholdet kan ikke leses, men cache.put venter til alt er mottatt (avbrytes av tidsavbruddet).
        clearTimeout(timer);
        timer = setTimeout(() => ctrl.abort(), IMG_IDLE_TIMEOUT * 3);
        await cache.put(url, res);
        clearTimeout(timer);
        hostMode.set(host, 'no-cors');
        return cache.match(url);
      }
      if (!res.ok) { clearTimeout(timer); return res; } // f.eks. 404: ikke lagre, ikke nettfeil
      const parts = [];
      if (res.body && res.body.getReader) {
        const reader = res.body.getReader();
        for (;;) {
          arm();
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
        }
      } else parts.push(new Uint8Array(await res.arrayBuffer()));
      clearTimeout(timer);
      hostMode.set(host, 'cors');
      const headers = { 'Content-Type': res.headers.get('Content-Type') || 'image/jpeg' };
      const blob = new Blob(parts, { type: headers['Content-Type'] });
      await cache.put(url, new Response(blob, { status: 200, headers })).catch(() => null);
      return new Response(blob, { status: 200, headers });
    } catch (e) {
      clearTimeout(timer);
      lastErr = e;
      if (ctrl.signal.aborted) break; // tidsavbrudd: ikke prøv en annen modus på dårlig nett
    }
  }
  throw lastErr || new Error('bilde feilet');
}

// Samme bilde lastes aldri ned to ganger samtidig (visning og forhåndsnedlasting deler jobben).
const inflight = new Map();
function getImage(url) {
  if (!inflight.has(url)) {
    const p = caches.open(IMG_CACHE).then((cache) => downloadImage(url, cache)).finally(() => inflight.delete(url));
    inflight.set(url, p);
  }
  return inflight.get(url);
}

async function imageCacheFirst(req) {
  const cache = await caches.open(IMG_CACHE);
  const cached = await cache.match(req.url);
  if (cached) return cached;
  try {
    await getImage(req.url);
    return (await cache.match(req.url)) || fetch(req);
  } catch (e) {
    return Response.error();
  }
}

// Forhåndsnedlasting: appen sender listen over bilder i bufferen (viktigste først).
// Når alle er forsøkt uten nettfeil, ryddes bilder som ikke lenger trengs – aldri før.
let prefetchRun = null;
let prefetchNext = null;
async function prefetch(urls, keep) {
  const cache = await caches.open(IMG_CACHE);
  const have = new Set((await cache.keys()).map((r) => r.url));
  const todo = urls.filter((u) => !have.has(u));
  let netErrors = 0;
  let done = 0;
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      if (prefetchNext) return; // ny liste kom inn: avbryt denne runden
      const u = todo[i++];
      try { await getImage(u); done++; } catch { netErrors++; }
      if (netErrors >= 6 && done === 0) return; // nettet er borte: prøv igjen neste gang
    }
  };
  await Promise.all(Array.from({ length: IMG_PARALLEL }, worker));
  const complete = !prefetchNext && i >= todo.length && netErrors === 0;
  if (complete) {
    const keepSet = new Set([...urls, ...keep]);
    for (const req of await cache.keys()) if (!keepSet.has(req.url)) await cache.delete(req);
  }
  const count = (await cache.keys()).length;
  await broadcast({ type: 'images', count, fetched: done, missing: todo.length - done, complete });
}
async function runPrefetch(job) {
  if (prefetchRun) { prefetchNext = job; return prefetchRun; }
  prefetchRun = (async () => {
    let j = job;
    while (j) {
      prefetchNext = null;
      try { await prefetch(j.urls, j.keep); } catch { /* prøv igjen neste gang */ }
      j = prefetchNext;
    }
  })().finally(() => { prefetchRun = null; });
  return prefetchRun;
}
async function broadcast(msg) {
  for (const c of await self.clients.matchAll({ includeUncontrolled: true })) c.postMessage(msg);
}

self.addEventListener('message', (event) => {
  const m = event.data || {};
  if (m.type === 'prefetch-images' && Array.isArray(m.urls)) {
    const ok = (u) => typeof u === 'string' && /^https:\/\//i.test(u);
    event.waitUntil(runPrefetch({ urls: m.urls.filter(ok), keep: (m.keep || []).filter(ok) }));
  }
});
