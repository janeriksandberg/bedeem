/* Bedeem – lesestrøm som fungerer med sporadisk nett.
   Data lages av scripts/fetch.mjs (GitHub Actions) og ligger i data/. */
(() => {
  'use strict';

  const FONT_STEPS = [14, 16, 18, 20, 23, 26, 30];
  const BUFFERS = [500, 1000, 10000];
  const BOOK_FILES = ['books.json'];   // filer med bok-påminnelser (books.json kan peke videre med "include")
  const DEFAULT_BOOK_MAX = 10;         // maks bokkort per 100 innlegg
  const DEFAULT_BOOK_MIN = 3;          // minst bokkort per 100 innlegg
  const BATCH = 20;
  const SETTINGS_KEY = 'bedeem:settings';
  const VISIT_KEY = 'bedeem:lastVisit';

  const $ = (sel) => document.querySelector(sel);
  const feedEl = $('#feed');
  const statusEl = $('#status');
  const footEl = $('#foot');
  const bannerEl = $('#banner');
  const panelEl = $('#sourcesPanel');

  // ---------- Innstillinger per enhet (ingen pålogging) ----------
  const settings = loadSettings();
  function loadSettings() {
    let s = {};
    try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { /* tom */ }
    if (!s.device) s.device = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)).slice(0, 8);
    if (!Number.isInteger(s.font)) s.font = 2;
    if (!BUFFERS.includes(s.buffer)) s.buffer = 1000;
    if (!Array.isArray(s.hidden)) s.hidden = [];
    if (!(Number.isFinite(s.bookMax) && s.bookMax >= 0)) s.bookMax = DEFAULT_BOOK_MAX;
    if (!(Number.isFinite(s.bookMin) && s.bookMin >= 0)) s.bookMin = DEFAULT_BOOK_MIN;
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* privat modus e.l. */ }
  }
  let lastVisit = 0;
  try { lastVisit = Number(localStorage.getItem(VISIT_KEY) || 0); } catch { /* ignorer */ }

  // ---------- Tilstand ----------
  const state = {
    sources: [],          // fra sources.json / index.json
    index: null,          // data/index.json
    items: [],            // sortert nyest først, filtrert på skjulte kilder, kuttet til buffer
    books: [],            // bok-påminnelser fra books.json
    display: [],          // items med bokkort flettet inn
    rendered: 0,
    offline: !navigator.onLine,
    loading: false,
    loadedDays: 0,
    extraDays: 0,         // "Last inn eldre" utover bufferen
  };

  // ---------- Hjelpere ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const URL_RE = /(https?:\/\/[^\s<>"'()\[\]]+[^\s<>"'()\[\].,;:!?])/g;
  function linkify(text) {
    return esc(text).replace(URL_RE, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${shortUrl(u)}</a>`);
  }
  function shortUrl(u) {
    try { const x = new URL(u); return x.host.replace(/^www\./, '') + (x.pathname.length > 1 ? x.pathname.replace(/\/$/, '').slice(0, 24) + (x.pathname.length > 25 ? '…' : '') : ''); } catch { return u; }
  }
  function paragraphs(text) {
    return String(text || '').split(/\n{2,}/).filter((p) => p.trim()).map((p) => `<p>${linkify(p.trim()).replace(/\n/g, '<br>')}</p>`).join('');
  }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'mai', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'des'];
  function fmtTime(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const hm = d.toLocaleTimeString('nb-NO', { hour: '2-digit', minute: '2-digit' });
    const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    if (sameDay(d, now)) return `i dag ${hm}`;
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (sameDay(d, y)) return `i går ${hm}`;
    const date = `${d.getDate()}. ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === now.getFullYear() ? `${date} ${hm}` : `${date} ${d.getFullYear()}`;
  }
  function fmtRel(iso) {
    if (!iso) return '–';
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return 'nå';
    if (m < 60) return `${m} min siden`;
    const h = Math.round(m / 60);
    if (h < 36) return `${h} t siden`;
    return `${Math.round(h / 24)} d siden`;
  }
  const sourceById = (id) => state.sources.find((s) => s.id === id) || { id, name: id, short: id };

  // ---------- Skriftstørrelse ----------
  function applyFont() {
    document.documentElement.style.fontSize = FONT_STEPS[settings.font] + 'px';
    $('#fontDown').disabled = settings.font === 0;
    $('#fontUp').disabled = settings.font === FONT_STEPS.length - 1;
    requestAnimationFrame(measureClamps);
  }
  $('#fontDown').addEventListener('click', () => { settings.font = Math.max(0, settings.font - 1); saveSettings(); applyFont(); });
  $('#fontUp').addEventListener('click', () => { settings.font = Math.min(FONT_STEPS.length - 1, settings.font + 1); saveSettings(); applyFont(); });

  // ---------- Buffer ----------
  function applyBufferButtons() {
    document.querySelectorAll('.btn.buf').forEach((b) => {
      const on = Number(b.dataset.n) === settings.buffer;
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  // ---------- Hopp tilbake til det lengste du har scrollet ----------
  const jumpBtn = $('#jump');
  let maxScroll = 0;
  function updateJump() {
    const y = window.scrollY;
    if (y > maxScroll) maxScroll = y;
    jumpBtn.hidden = !(maxScroll - y > window.innerHeight * 0.8);
  }
  window.addEventListener('scroll', updateJump, { passive: true });
  jumpBtn.addEventListener('click', () => {
    window.scrollTo({ top: Math.min(maxScroll, document.documentElement.scrollHeight), behavior: 'smooth' });
  });
  document.querySelectorAll('.btn.buf').forEach((b) => b.addEventListener('click', () => {
    settings.buffer = Number(b.dataset.n);
    saveSettings();
    applyBufferButtons();
    state.extraDays = 0;
    loadFeed({ keepScroll: true });
  }));

  // ---------- Status ----------
  function setStatus(text, offline) {
    statusEl.textContent = text;
    statusEl.classList.toggle('offline', !!offline);
  }
  function statusText() {
    const n = state.items.length;
    const gen = state.index?.generated;
    if (state.offline) return `Frakoblet · ${n} innlegg i buffer${gen ? ' · fra ' + fmtTime(gen) : ''}`;
    return `${n} innlegg${gen ? ' · oppdatert ' + fmtTime(gen) : ''}`;
  }

  // ---------- Data ----------
  async function fetchJson(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.json();
  }
  const BOOK_GROUP = 'Bok-påminnelser';
  const bookSourceId = (bookId) => `book:${bookId}`;
  async function loadSources() {
    try {
      const cfg = await fetchJson('sources.json', { cache: 'no-cache' });
      state.sources = cfg.sources || [];
    } catch { /* faller tilbake til index.sources */ }
    state.books = [];
    const queue = BOOK_FILES.slice();
    const seenFiles = new Set();
    while (queue.length) {
      const file = queue.shift();
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);
      try {
        const b = await fetchJson(file, { cache: 'no-cache' });
        for (const inc of b.include || []) queue.push(inc);
        for (const book of b.books || []) {
          const sid = bookSourceId(book.id);
          (book.cards || []).forEach((c, i) => state.books.push({
            id: `${sid}:${i}`, _book: true, source: sid, title: c.title, body: c.body,
            bookTitle: book.title, authors: book.authors,
          }));
          if (!state.sources.some((s) => s.id === sid)) {
            state.sources.push({ id: sid, name: book.title, short: 'Bok', authors: book.authors, group: BOOK_GROUP, type: 'book', ok: true, count: (book.cards || []).length });
          }
        }
      } catch { /* filen mangler eller er ugyldig */ }
    }
  }

  // Flett inn bokkort mellom innleggene. Frekvens styres av bookMax/bookMin (kort per 100 innlegg).
  // Tilfeldig rekkefølge, ingen gjentak før alle kort er vist. Har strømmen få innlegg, fyller
  // resten av kortene på etter innleggene, slik at vanlige kilder alltid kommer først.
  function buildDisplay() {
    const items = state.items;
    const hidden = new Set(settings.hidden);
    const deck = state.books.filter((b) => !hidden.has(b.source));
    if (!deck.length) return items.slice();
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    const max = Math.min(100, settings.bookMax);
    const min = Math.min(max, settings.bookMin);
    const minGap = max > 0 ? Math.max(1, Math.ceil(100 / max)) : Infinity;   // færrest innlegg mellom to kort
    const forceGap = min > 0 ? Math.max(minGap, Math.floor(100 / min)) : Infinity; // tving inn kort senest her
    const p = max > 0 ? max / 100 : 0;
    let di = 0;
    const out = [];
    let gap = Math.floor(Math.random() * Math.min(10, minGap));
    for (const it of items) {
      out.push(it);
      gap++;
      if (di < deck.length * 50 && (gap >= forceGap || (gap >= minGap && Math.random() < p))) {
        out.push(deck[di++ % deck.length]);
        gap = 0;
      }
    }
    // Fyll på med ubrukte kort når det er lite annet å vise (kortene kommer etter innleggene).
    if (items.length < 100) {
      while (di < deck.length) out.push(deck[di++]);
    }
    return out;
  }
  async function loadFeed({ keepScroll = false } = {}) {
    if (state.loading) return;
    state.loading = true;
    setStatus('Laster …');
    let index;
    try {
      index = await fetchJson('data/index.json', { cache: 'no-store' });
      state.offline = false;
    } catch (e) {
      state.offline = true;
      if (!state.index) {
        // Service worker gir oss bufret index om den finnes; hvis ikke, prøv uansett.
        try { index = await fetchJson('data/index.json'); } catch { index = null; }
      } else index = state.index;
    }
    if (!index) {
      state.loading = false;
      setStatus('Ingen data tilgjengelig', true);
      feedEl.innerHTML = '<p class="empty">Fikk ikke kontakt med nettet, og det finnes ikke noe bufret innhold ennå. Prøv igjen når du har dekning.</p>';
      return;
    }
    state.index = index;
    if (!state.sources.length && index.sources) state.sources = index.sources;
    // Slå sammen status fra index inn i kildelisten.
    for (const s of index.sources || []) {
      const t = state.sources.find((x) => x.id === s.id);
      if (t) Object.assign(t, { ok: s.ok, lastOk: s.lastOk, error: s.error, warn: s.warn, count: s.count });
      else state.sources.push(s);
    }

    const hidden = new Set(settings.hidden);
    const want = settings.buffer;
    const items = [];
    let loadedDays = 0;
    let failed = 0;
    const days = [...(index.days || [])].sort((a, b) => (a.day < b.day ? 1 : -1));
    for (const d of days) {
      const enough = items.filter((it) => !hidden.has(it.source)).length >= want;
      if (enough && loadedDays >= state.extraDays + 1) break;
      try {
        const j = await fetchJson(`data/days/${d.day}.json`, { cache: 'no-cache' });
        items.push(...(j.items || []));
        loadedDays++;
        if (loadedDays === 1 || loadedDays % 2 === 0) setStatus(`Laster … ${items.length}`);
      } catch (e) {
        failed++;
        state.offline = true;
      }
    }
    // Dedupliser (samme innlegg kan i sjeldne tilfeller ligge i to dagsfiler under flytting).
    const seen = new Set();
    const uniq = items.filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)));
    uniq.sort((a, b) => (a.time < b.time ? 1 : a.time > b.time ? -1 : 0));
    const visible = uniq.filter((it) => !hidden.has(it.source));
    const limit = want + (state.extraDays ? Infinity : 0);
    state.items = Number.isFinite(limit) ? visible.slice(0, limit) : visible;
    state.loadedDays = loadedDays;
    state.loading = false;

    const y = window.scrollY;
    renderReset();
    if (keepScroll) window.scrollTo(0, Math.min(y, document.body.scrollHeight));
    setStatus(statusText(), state.offline);
    if (failed && uniq.length) showBanner(`Nettet forsvant underveis – viser ${state.items.length} bufrede innlegg.`);
    else hideBanner();
    renderPanel();
  }

  // ---------- Rendering ----------
  function renderReset() {
    feedEl.innerHTML = '';
    state.rendered = 0;
    state.display = buildDisplay();
    if (!state.items.length) {
      feedEl.innerHTML = `<p class="empty">Ingen innlegg å vise${settings.hidden.length ? ' – sjekk hvilke kilder som er skrudd av under «Kilder»' : ''}.</p>`;
    }
    renderMore();
  }
  function renderMore() {
    const end = Math.min(state.display.length, state.rendered + BATCH);
    if (state.rendered >= end) { renderFoot(); return; }
    const frag = document.createDocumentFragment();
    for (let i = state.rendered; i < end; i++) frag.appendChild(renderPost(state.display[i]));
    feedEl.appendChild(frag);
    state.rendered = end;
    renderFoot();
    requestAnimationFrame(() => {
      measureClamps();
      // IntersectionObserver varsler bare ved endring; er sentinel fortsatt synlig, fortsett å fylle.
      if (state.rendered < state.display.length && sentinelNear()) renderMore();
    });
  }
  function sentinelNear() {
    return $('#sentinel').getBoundingClientRect().top < window.innerHeight + 1200;
  }
  function renderFoot() {
    const total = state.display.length;
    if (!total) { footEl.innerHTML = ''; return; }
    if (state.rendered < total) { footEl.textContent = `${state.rendered} av ${total} vist – bla videre`; return; }
    const more = document.createElement('button');
    more.className = 'btn';
    more.type = 'button';
    more.textContent = state.offline ? 'Prøv å laste eldre innlegg' : 'Last inn eldre innlegg';
    more.addEventListener('click', () => { state.extraDays += 2; loadFeed({ keepScroll: true }); });
    footEl.innerHTML = `<div>Alle ${total} innlegg i bufferen er vist.</div>`;
    if (state.loadedDays < (state.index?.days?.length || 0)) footEl.appendChild(more);
    else footEl.insertAdjacentHTML('beforeend', '<div>Det finnes ikke eldre innlegg i arkivet.</div>');
  }

  function renderBookCard(it) {
    const art = document.createElement('article');
    art.className = 'post book';
    art.dataset.id = it.id;
    art.innerHTML = `
      <div class="meta"><span class="tag">Bok</span><span>${esc(it.bookTitle)}</span><span>${esc(it.authors || '')}</span></div>
      <h2 class="title">${esc(it.title)}</h2>
      <div class="body clamp">${paragraphs(it.body)}</div>`;
    return art;
  }

  function renderPost(it) {
    if (it._book) return renderBookCard(it);
    const src = sourceById(it.source);
    const art = document.createElement('article');
    art.className = 'post' + (lastVisit && new Date(it.time).getTime() > lastVisit ? ' unread' : '');
    art.dataset.id = it.id;

    const meta = [];
    meta.push(`<span class="tag${it.severity ? ' sev-' + esc(it.severity) : ''}">${esc(src.short || src.name)}</span>`);
    meta.push(`<time datetime="${esc(it.time)}" title="${new Date(it.time).toLocaleString('nb-NO')}">${fmtTime(it.time)}</time>`);
    if (it.author) meta.push(`<span>${esc(it.author)}</span>`);
    if (it.category && src.type !== 'reddit') meta.push(`<span>${esc(it.category)}</span>`);
    if (it.ended) meta.push('<span class="tag ended">Avsluttet</span>');
    if (it.updated && it.updated !== it.time && !it.ended) meta.push(`<span>oppdatert ${fmtTime(it.updated)}</span>`);

    const hasBody = it.body && it.body.trim();
    const actions = [];
    actions.push(`<a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Åpne kilde ↗</a>`);
    if (it.externalUrl) actions.push(`<a href="${esc(it.externalUrl)}" target="_blank" rel="noopener noreferrer">${esc(shortUrl(it.externalUrl))} ↗</a>`);
    const nc = it.commentCount ?? (it.comments ? it.comments.length : 0);
    if (it.comments && it.comments.length) {
      actions.push(`<button type="button" class="thr" aria-expanded="false">${nc} svar</button>`);
    } else if (nc > 0) {
      actions.push(`<span class="note">${nc} svar (ikke hentet ennå)</span>`);
    }

    art.innerHTML = `
      <div class="meta">${meta.join('')}</div>
      <h2 class="title"><a href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a></h2>
      ${hasBody ? `<div class="body clamp">${paragraphs(it.body)}</div>` : ''}
      <div class="actions">${actions.join('')}</div>`;

    const thr = art.querySelector('.thr');
    if (thr) thr.addEventListener('click', () => toggleThread(art, it, thr));
    return art;
  }

  function toggleThread(art, it, btn) {
    let th = art.querySelector('.thread');
    if (th) {
      const open = th.hidden;
      th.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) requestAnimationFrame(measureClamps);
      return;
    }
    th = document.createElement('div');
    th.className = 'thread';
    const parts = [];
    if (it.commentsNote) parts.push(`<div class="cnote">${esc(it.commentsNote)}</div>`);
    else if (it.commentCount > it.comments.length) parts.push(`<div class="cnote">Viser ${it.comments.length} av ${it.commentCount} svar</div>`);
    for (const c of it.comments) {
      const d = Math.min(Number(c.depth) || 0, 6);
      const score = typeof c.score === 'number' && c.score !== 0 ? ` · ${c.score > 0 ? '+' : ''}${c.score}` : '';
      parts.push(`<div class="comment" style="--d:${d}">
        <div class="cmeta"><b>${esc(c.author)}</b> · ${fmtTime(c.time)}${score}</div>
        <div class="body clamp">${paragraphs(c.body)}</div>
      </div>`);
    }
    th.innerHTML = parts.join('');
    art.appendChild(th);
    btn.setAttribute('aria-expanded', 'true');
    requestAnimationFrame(measureClamps);
  }

  // Legg på «Vis mer» der teksten er lengre enn fem linjer.
  function measureClamps() {
    document.querySelectorAll('.body.clamp:not([data-measured])').forEach((el) => {
      el.dataset.measured = '1';
      if (el.scrollHeight <= el.clientHeight + 2) {
        el.classList.remove('clamp'); // kort tekst: vis avsnittene normalt
        return;
      }
      {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'more';
        b.textContent = 'Vis mer';
        b.addEventListener('click', () => {
          const clamped = el.classList.toggle('clamp');
          b.textContent = clamped ? 'Vis mer' : 'Vis mindre';
          if (clamped) el.scrollIntoView({ block: 'nearest' });
        });
        el.after(b);
      }
    });
  }
  // Ved endret skriftstørrelse må målingene gjøres på nytt.
  const fontObserver = new MutationObserver(() => {
    document.querySelectorAll('.body[data-measured]').forEach((el) => {
      const b = el.nextElementSibling;
      if (el.classList.contains('clamp')) {
        delete el.dataset.measured;
        if (b && b.classList.contains('more')) b.remove();
      }
    });
    requestAnimationFrame(measureClamps);
  });
  fontObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

  // ---------- Uendelig rulling ----------
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMore();
  }, { rootMargin: '1200px 0px' });
  io.observe($('#sentinel'));

  // ---------- Banner ----------
  function showBanner(text, action) {
    bannerEl.innerHTML = esc(text);
    if (action) {
      const b = document.createElement('button');
      b.className = 'btn'; b.type = 'button'; b.textContent = action.label;
      b.addEventListener('click', action.fn);
      bannerEl.appendChild(b);
    }
    bannerEl.hidden = false;
  }
  function hideBanner() { bannerEl.hidden = true; bannerEl.innerHTML = ''; }

  // ---------- Kilder-panel ----------
  let hiddenSnapshot = null; // kildevalg før «alle»/«ingen» ble trykket
  function setHidden(list) {
    settings.hidden = [...new Set(list)];
    saveSettings();
    renderPanel();
    loadFeed({ keepScroll: true });
  }
  function renderPanel() {
    if (panelEl.hidden) return;
    const hidden = new Set(settings.hidden);
    const groups = new Map();
    for (const s of state.sources) {
      const g = s.group || 'Andre';
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const sections = [...groups].map(([g, list]) => {
      const rows = list.map((s) => {
        const dot = s.ok === false ? 'err' : s.warn ? 'warn' : s.ok ? 'ok' : '';
        let info;
        if (s.type === 'book') info = `${esc(s.authors || '')} · ${s.count} kort`;
        else info = s.error ? `Feil: ${s.error}` : s.warn ? s.warn : s.lastOk ? `Hentet ${fmtRel(s.lastOk)}${s.count ? ` · ${s.count} innlegg` : ''}` : 'Ikke hentet ennå';
        return `<li>
          <label><input type="checkbox" data-src="${esc(s.id)}" ${hidden.has(s.id) ? '' : 'checked'}>
            <span><span class="tag">${esc(s.short || s.name)}</span> ${esc(s.name)}<br><span class="meta">${esc(info)}</span></span></label>
          <span class="dot ${dot}" title="${esc(info)}"></span>
        </li>`;
      });
      const extra = g === BOOK_GROUP ? `
        <div class="bookfreq">
          <label>Maks kort per 100 innlegg <input type="number" id="bookMax" min="0" max="100" step="1" inputmode="numeric" value="${settings.bookMax}"></label>
          <label>Minst kort per 100 innlegg <input type="number" id="bookMin" min="0" max="100" step="1" inputmode="numeric" value="${settings.bookMin}"></label>
        </div>` : '';
      return `<h3>${esc(g)}</h3>${extra}<ul>${rows.join('')}</ul>`;
    });
    panelEl.innerHTML = `
      <div class="panel-inner">
      <div class="panel-head">
        <h2>Kilder</h2>
        <div class="group">
          <button type="button" class="btn" id="selNone" title="Velg bort alle kilder" aria-label="Velg bort alle kilder">☐</button>
          <button type="button" class="btn" id="selAll" title="Velg alle kilder" aria-label="Velg alle kilder">☑</button>
          <button type="button" class="btn" id="selReset" title="Tilbake til valgene før du trykket alle/ingen" aria-label="Tilbake til forrige valg" ${hiddenSnapshot ? '' : 'disabled'}>↺</button>
          <button type="button" class="btn" id="panelClose" title="Lukk" aria-label="Lukk kilder">✕</button>
        </div>
      </div>
      ${sections.join('')}
      <div class="small">Valgene lagres på denne enheten (enhets-id ${esc(settings.device)}). Ingen pålogging.
      Innholdet hentes hvert 10. minutt og alt i bufferen kan leses uten nett.
      Nye kilder legges til i <code>sources.json</code>, bøker i <code>books.json</code>, i GitHub-repoet.</div>
      </div>`;
    panelEl.querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
      const id = cb.dataset.src;
      const list = settings.hidden.filter((x) => x !== id);
      if (!cb.checked) list.push(id);
      settings.hidden = list;
      saveSettings();
      loadFeed({ keepScroll: true });
    }));
    const snap = () => { if (!hiddenSnapshot) hiddenSnapshot = settings.hidden.slice(); };
    $('#selNone').addEventListener('click', () => { snap(); setHidden(state.sources.map((s) => s.id)); });
    $('#selAll').addEventListener('click', () => { snap(); setHidden([]); });
    $('#selReset').addEventListener('click', () => { if (hiddenSnapshot) { const s = hiddenSnapshot; hiddenSnapshot = null; setHidden(s); } });
    $('#panelClose').addEventListener('click', closePanel);
    const onFreq = () => {
      let max = Math.max(0, Math.min(100, Number($('#bookMax').value) || 0));
      let min = Math.max(0, Math.min(100, Number($('#bookMin').value) || 0));
      if (min > max) min = max;
      settings.bookMax = max; settings.bookMin = min;
      $('#bookMax').value = max; $('#bookMin').value = min;
      saveSettings();
      renderReset();
    };
    $('#bookMax').addEventListener('change', onFreq);
    $('#bookMin').addEventListener('change', onFreq);
  }
  function positionPanel() {
    panelEl.style.top = $('#top').offsetHeight + 'px';
  }
  function openPanel() {
    hiddenSnapshot = null;
    positionPanel();
    panelEl.hidden = false;
    $('#sourcesBtn').setAttribute('aria-expanded', 'true');
    $('#sourcesBtn').classList.add('active');
    renderPanel();
    panelEl.scrollTop = 0;
  }
  function closePanel() {
    panelEl.hidden = true;
    $('#sourcesBtn').setAttribute('aria-expanded', 'false');
    $('#sourcesBtn').classList.remove('active');
  }
  $('#sourcesBtn').addEventListener('click', () => (panelEl.hidden ? openPanel() : closePanel()));
  window.addEventListener('resize', () => { if (!panelEl.hidden) positionPanel(); });

  // ---------- Oppdater / nett ----------
  $('#refresh').addEventListener('click', async () => {
    const before = state.index?.generated;
    await loadFeed();
    if (before && state.index?.generated === before && !state.offline) setStatus(statusText() + ' · ingenting nytt');
  });
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  window.addEventListener('online', () => { state.offline = false; setStatus(statusText()); checkForNew(); });
  window.addEventListener('offline', () => { state.offline = true; setStatus(statusText(), true); });

  async function checkForNew() {
    if (!navigator.onLine || state.loading) return;
    try {
      const idx = await fetchJson('data/index.json', { cache: 'no-store' });
      if (idx.generated !== state.index?.generated) {
        showBanner('Det finnes nytt innhold.', { label: 'Hent', fn: () => { hideBanner(); loadFeed(); window.scrollTo(0, 0); } });
      }
    } catch { /* fortsatt frakoblet */ }
  }
  setInterval(checkForNew, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkForNew(); });

  // ---------- Service worker ----------
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* fungerer også uten */ });
    // Når en ny versjon av appen tar over, last siden på nytt én gang så den vises straks.
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (hadController && !sessionStorage.getItem('bedeem:reloaded')) {
        sessionStorage.setItem('bedeem:reloaded', '1');
        location.reload();
      }
      hadController = true;
    });
    setTimeout(() => sessionStorage.removeItem('bedeem:reloaded'), 10000);
  }

  // ---------- Start ----------
  applyFont();
  applyBufferButtons();
  (async () => {
    await loadSources();
    await loadFeed();
    try { localStorage.setItem(VISIT_KEY, String(Date.now())); } catch { /* ignorer */ }
  })();
})();
