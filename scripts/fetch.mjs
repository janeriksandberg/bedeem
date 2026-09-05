#!/usr/bin/env node
// Bedeem – henter innhold fra kildene i sources.json og skriver
// normaliserte dagsfiler til data/days/YYYY-MM-DD.json samt data/index.json.
// Kjøres av GitHub Actions (se .github/workflows/fetch.yml). Ingen avhengigheter.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DATA_DIR = path.join(ROOT, 'data');
const DAYS_DIR = path.join(DATA_DIR, 'days');
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 60);
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// Grenser som holder datamengden nede (alt lastes ned til mobil).
const LIMITS = {
  bodyChars: 6000,
  commentChars: 900,
  commentsPerItem: 25,
  commentDepth: 5,
  redditCommentBudget: Number(process.env.REDDIT_COMMENT_BUDGET || 10),
  redditDelayMs: 10000,
  invisionTopicBudget: Number(process.env.INVISION_TOPIC_BUDGET || 20),
  invisionDelayMs: 1500,
};

const now = new Date();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- HTTP
async function fetchText(url, { headers = {}, timeout = 25000, method = 'GET', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, 'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.7', ...headers },
      });
      const text = await res.text();
      return { status: res.status, text, ok: res.ok, url: res.url };
    } catch (e) {
      lastErr = e;
      await sleep(1500);
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------- Tekst
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', shy: '', laquo: '«', raquo: '»',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bdquo: '„', hellip: '…', ndash: '–', mdash: '—',
  aring: 'å', Aring: 'Å', oslash: 'ø', Oslash: 'Ø', aelig: 'æ', AElig: 'Æ', eacute: 'é', Eacute: 'É',
  egrave: 'è', agrave: 'à', aacute: 'á', ouml: 'ö', Ouml: 'Ö', auml: 'ä', Auml: 'Ä', uuml: 'ü', Uuml: 'Ü',
  ccedil: 'ç', ntilde: 'ñ', copy: '©', reg: '®', trade: '™', euro: '€', pound: '£', deg: '°', middot: '·',
  bull: '•', times: '×', divide: '÷', frac12: '½', frac14: '¼', frac34: '¾', sect: '§', para: '¶',
  iexcl: '¡', iquest: '¿', szlig: 'ß', larr: '←', rarr: '→', uarr: '↑', darr: '↓', hearts: '♥', zwj: '', zwnj: '',
};
export function decodeEntities(s) {
  if (!s) return '';
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0) return '';
      try { return String.fromCodePoint(code); } catch { return ''; }
    }
    return e in ENTITIES ? ENTITIES[e] : m;
  });
}

export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|noscript|svg|figure|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<li\b[^>]*>/gi, '\n• ');
  s = s.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|table|ul|ol|pre|section|article|header|footer)\s*>/gi, '\n\n');
  s = s.replace(/<(p|div|h[1-6]|blockquote|tr|table|pre|section|article)\b[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  // Noen feeder (f.eks. SANS ISC) er dobbelt-escapet.
  for (let i = 0; i < 2 && /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(s); i++) s = decodeEntities(s);
  s = s.replace(/ /g, ' ');
  s = s.split('\n').map((l) => l.replace(/[ \t\r\f]+/g, ' ').trim()).join('\n');
  s = s.replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

export function truncate(s, n) {
  if (!s || s.length <= n) return s || '';
  const cut = s.slice(0, n);
  const at = Math.max(cut.lastIndexOf('\n'), cut.lastIndexOf('. '), cut.lastIndexOf(' '));
  return (at > n * 0.6 ? cut.slice(0, at + 1) : cut).trimEnd() + ' …';
}

function stripTracking(u) {
  try {
    const url = new URL(u);
    for (const k of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$|ref_src)/i.test(k)) url.searchParams.delete(k);
    return url.toString();
  } catch { return u; }
}

// ---------------------------------------------------------------- XML (enkel, tilstrekkelig for RSS/Atom)
function unwrapCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}
function tagText(block, name) {
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  const inner = m[1];
  // CDATA-innhold er allerede rå HTML; annet innhold er XML-escapet.
  return /<!\[CDATA\[/.test(inner) ? unwrapCdata(inner) : decodeEntities(inner);
}
function tagAttr(block, name, attr) {
  const re = new RegExp(`<${name}\\b[^>]*?\\s${attr}=["']([^"']*)["'][^>]*\\/?>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1]) : '';
}
function splitBlocks(xml, name) {
  const out = [];
  const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}\\s*>`, 'gi');
  let m;
  while ((m = re.exec(xml))) out.push(m[1]);
  return out;
}
function parseDate(s) {
  if (!s) return null;
  let d = new Date(s.trim());
  if (Number.isNaN(d.getTime())) d = new Date(s.trim().replace(/\sZ$/, ' GMT')); // f.eks. MSRC: "Fri, 04 Sep 2026 22:11:22 Z"
  return Number.isNaN(d.getTime()) ? null : d;
}
function iso(d) { return (d || now).toISOString(); }

// ---------------------------------------------------------------- Kilder
async function fetchRss(src) {
  const { text, status } = await fetchText(src.url, { headers: { Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const items = [];
  const isAtom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = isAtom ? splitBlocks(text, 'entry') : splitBlocks(text, 'item');
  for (const b of blocks) {
    const title = htmlToText(tagText(b, 'title'));
    let link = isAtom ? tagAttr(b, 'link', 'href') : tagText(b, 'link');
    if (!link && isAtom) link = tagText(b, 'link');
    const guid = tagText(b, 'guid') || tagText(b, 'id') || link;
    const date = parseDate(tagText(b, 'pubDate') || tagText(b, 'published') || tagText(b, 'updated') || tagText(b, 'dc:date'));
    const encoded = tagText(b, 'content:encoded') || tagText(b, 'content');
    const desc = tagText(b, 'description') || tagText(b, 'summary');
    let body = htmlToText(encoded || desc);
    const lead = htmlToText(desc);
    if (encoded && lead && !body.startsWith(lead.slice(0, 40))) body = lead + '\n\n' + body;
    if (title && body.startsWith(title)) body = body.slice(title.length).trim();
    const author = htmlToText(tagText(b, 'dc:creator') || tagText(b, 'author') || '');
    const category = htmlToText(tagText(b, 'category'));
    if (!title && !body) continue;
    items.push({
      id: `${src.id}:${hash(guid || link || title)}`,
      source: src.id,
      title: title || '(uten tittel)',
      url: stripTracking(link),
      time: iso(date),
      author: author && !/@/.test(author) ? author : undefined,
      category: category || undefined,
      body: truncate(body, LIMITS.bodyChars),
    });
  }
  // Noen feeder (f.eks. MSRC) inneholder tusenvis av poster – behold bare de nyeste.
  items.sort((a, b) => (a.time < b.time ? 1 : -1));
  return { items: items.slice(0, src.maxItems || 200) };
}

// --- Reddit: liste via RSS, kommentarer via shreddit-HTML (med dybde).
const reddit = {
  lastRequest: 0,
  blocked: false,
  commentBudget: LIMITS.redditCommentBudget,
  // Samlet tidsbudsjett for Reddit per kjøring, så jobben aldri drar ut.
  deadline: Date.now() + Number(process.env.REDDIT_MAX_MS || 7 * 60000),
};
// Valgfritt: med REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET (Reddit-app av typen «script») brukes
// Reddits offisielle API, som gir hele kommentartreet og langt høyere kvote.
const REDDIT_OAUTH = process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET
  ? { id: process.env.REDDIT_CLIENT_ID, secret: process.env.REDDIT_CLIENT_SECRET, token: null }
  : null;
if (REDDIT_OAUTH) LIMITS.redditDelayMs = 1200;

async function redditToken() {
  if (REDDIT_OAUTH.token) return REDDIT_OAUTH.token;
  const basic = Buffer.from(`${REDDIT_OAUTH.id}:${REDDIT_OAUTH.secret}`).toString('base64');
  const res = await fetchText('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'bedeem-reader/1.0 (github.com/janeriksandberg/bedeem)' },
    body: 'grant_type=client_credentials',
  });
  if (res.status !== 200) throw new Error(`Reddit OAuth HTTP ${res.status}: ${res.text.slice(0, 120)}`);
  const j = JSON.parse(res.text);
  if (!j.access_token) throw new Error('Reddit OAuth: fikk ikke token');
  REDDIT_OAUTH.token = j.access_token;
  return j.access_token;
}

async function redditGet(url, { soft403 = false, oauth = false } = {}) {
  if (reddit.blocked) throw new Error('Reddit har svart 429/403 tidligere i denne kjøringen');
  if (Date.now() > reddit.deadline) throw new Error('Reddit: tidsbudsjettet for denne kjøringen er brukt opp');
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = reddit.lastRequest + LIMITS.redditDelayMs - Date.now();
    if (wait > 0) await sleep(wait);
    reddit.lastRequest = Date.now();
    const headers = { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' };
    if (oauth) {
      headers.Authorization = `bearer ${await redditToken()}`;
      headers['User-Agent'] = 'bedeem-reader/1.0 (github.com/janeriksandberg/bedeem)';
      headers.Accept = 'application/json';
    }
    const res = await fetchText(url, { headers });
    if (res.status === 429 && attempt === 0) {
      log('Reddit 429 – venter 65 s og prøver igjen');
      await sleep(65000);
      continue;
    }
    if (res.status === 403 && soft403) throw new Error('Reddit HTTP 403');
    if (res.status === 429 || res.status === 403) {
      reddit.blocked = true;
      throw new Error(`Reddit HTTP ${res.status}`);
    }
    if (res.status !== 200) throw new Error(`Reddit HTTP ${res.status}`);
    return res.text;
  }
  throw new Error('Reddit: ga opp');
}

// Kommentartre fra det offisielle API-et (krever OAuth).
function parseRedditJsonComments(json) {
  const out = [];
  const walk = (children, depth) => {
    for (const ch of children || []) {
      if (ch.kind !== 't1') continue;
      const d = ch.data;
      out.push({
        id: `t1_${d.id}`,
        author: d.author || '[slettet]',
        time: iso(new Date((d.created_utc || 0) * 1000)),
        body: truncate(decodeEntities(d.body || '[fjernet]').trim(), LIMITS.commentChars),
        depth,
        score: Number(d.score || 0),
      });
      if (d.replies && d.replies.data) walk(d.replies.data.children, depth + 1);
    }
  };
  walk(json?.[1]?.data?.children, 0);
  return out;
}

// Reserveløsning: kommentar-RSS gir svarene flatt (uten trådstruktur).
function parseRedditRssComments(xml) {
  const out = [];
  for (const b of splitBlocks(xml, 'entry')) {
    const id = tagText(b, 'id');
    if (!id.startsWith('t1_')) continue;
    out.push({
      id,
      author: htmlToText(tagText(tagText(b, 'author'), 'name')).replace(/^\/u\//, '') || '[slettet]',
      time: iso(parseDate(tagText(b, 'updated') || tagText(b, 'published'))),
      body: truncate(htmlToText(tagText(b, 'content')) || '[fjernet]', LIMITS.commentChars),
      depth: 0,
      score: 0,
    });
  }
  return out;
}

// Prøver i rekkefølge: offisielt API (om konfigurert) → shreddit-HTML (tråd) → RSS (flatt).
async function fetchRedditThread(sub, t3) {
  const id36 = t3.replace(/^t3_/, '');
  if (REDDIT_OAUTH) {
    const text = await redditGet(`https://oauth.reddit.com/comments/${id36}?sort=top&limit=100&depth=${LIMITS.commentDepth + 1}&raw_json=1`, { oauth: true });
    return { comments: parseRedditJsonComments(JSON.parse(text)), flat: false };
  }
  if (!reddit.svcBlocked) {
    try {
      const html = await redditGet(`https://www.reddit.com/svc/shreddit/comments/r/${sub}/${t3}?sort=top`, { soft403: true });
      return { comments: parseShredditComments(html), flat: false };
    } catch (e) {
      if (!/403/.test(e.message)) throw e;
      reddit.svcBlocked = true;
      log('Reddit: tråd-endepunktet er blokkert herfra, bruker RSS (flatt)');
    }
  }
  const xml = await redditGet(`https://www.reddit.com/r/${sub}/comments/${id36}/.rss?sort=top&limit=100`);
  return { comments: parseRedditRssComments(xml), flat: true };
}

async function fetchReddit(src, existing) {
  const listing = src.listing || 'new';
  const xml = await redditGet(`https://www.reddit.com/r/${src.subreddit}/${listing}.rss?limit=100${src.t ? '&t=' + encodeURIComponent(src.t) : ''}`);
  const items = [];
  for (const b of splitBlocks(xml, 'entry')) {
    const fullId = tagText(b, 'id'); // t3_xxxx
    if (!fullId) continue;
    const title = htmlToText(tagText(b, 'title'));
    const permalink = tagAttr(b, 'link', 'href');
    const author = htmlToText(tagText(tagText(b, 'author'), 'name')).replace(/^\/u\//, '');
    const date = parseDate(tagText(b, 'published') || tagText(b, 'updated'));
    const contentHtml = tagText(b, 'content');
    let bodyHtml = contentHtml;
    let externalUrl;
    const submittedAt = bodyHtml.search(/submitted by/i);
    if (submittedAt >= 0) {
      const tail = bodyHtml.slice(submittedAt);
      const m = tail.match(/<a href="([^"]+)">\s*\[link\]/i);
      if (m) {
        const l = decodeEntities(m[1]);
        if (l && !/reddit\.com\/r\/[^/]+\/comments\//i.test(l)) externalUrl = stripTracking(l);
      }
      bodyHtml = bodyHtml.slice(0, submittedAt);
    }
    bodyHtml = bodyHtml.replace(/<a href="[^"]+">\s*<img[^>]*>\s*<\/a>/gi, ' ').replace(/<table>[\s\S]*?<\/table>/gi, ' ');
    let body = htmlToText(bodyHtml);
    if (/^\[link\]\s*\[comments\]$/.test(body.replace(/\s+/g, ' ').trim())) body = '';
    const prev = existing.get(`${src.id}:${fullId}`);
    items.push({
      id: `${src.id}:${fullId}`,
      source: src.id,
      title,
      url: permalink,
      externalUrl,
      time: prev?.time || iso(date),
      author: author || undefined,
      body: truncate(body, LIMITS.bodyChars),
      comments: prev?.comments,
      commentCount: prev?.commentCount,
      commentsAt: prev?.commentsAt,
      _redditSub: src.subreddit,
      _t3: fullId,
    });
  }
  return { items };
}

function extractBalancedDiv(html, startIdx) {
  // startIdx peker på '<div' – returner innholdet fram til matchende </div>
  let depth = 0;
  const re = /<div\b|<\/div\s*>/gi;
  re.lastIndex = startIdx;
  let m;
  let contentStart = html.indexOf('>', startIdx) + 1;
  while ((m = re.exec(html))) {
    if (m[0][1] === '/') {
      depth--;
      if (depth === 0) return html.slice(contentStart, m.index);
    } else depth++;
  }
  return html.slice(contentStart);
}

function parseShredditComments(html) {
  const out = [];
  const re = /<shreddit-comment\b([^>]*)>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1];
    const get = (n) => {
      const a = attrs.match(new RegExp(`\\s${n}="([^"]*)"`, 'i'));
      return a ? decodeEntities(a[1]) : '';
    };
    const thingId = get('thingId');
    if (!thingId) continue;
    const depth = Number(get('depth') || 0);
    const idx = html.indexOf(`id="${thingId}-post-rtjson-content"`, m.index);
    let body = '';
    if (idx > 0) {
      const divStart = html.lastIndexOf('<div', idx);
      body = htmlToText(extractBalancedDiv(html, divStart));
    }
    const author = get('author') || '[slettet]';
    out.push({
      id: thingId,
      author,
      time: iso(parseDate(get('created'))),
      body: truncate(body || '[fjernet]', LIMITS.commentChars),
      depth,
      score: Number(get('score') || 0),
    });
  }
  return out;
}

function pruneThread(comments) {
  // Behold tråd-struktur men begrens antall: velg toppkommentarer etter score,
  // ta med svar i rekkefølge til budsjettet er brukt opp.
  const roots = [];
  let cur = null;
  for (const c of comments) {
    if (c.depth > LIMITS.commentDepth) continue;
    if (c.depth === 0) { cur = { c, kids: [] }; roots.push(cur); }
    else if (cur) cur.kids.push(c);
  }
  roots.sort((a, b) => b.c.score - a.c.score);
  const out = [];
  for (const r of roots) {
    if (out.length >= LIMITS.commentsPerItem) break;
    out.push(r.c);
    for (const k of r.kids) {
      if (out.length >= LIMITS.commentsPerItem) break;
      out.push(k);
    }
  }
  return out;
}

function needsCommentRefresh(item) {
  const age = now - new Date(item.time);
  if (age > 48 * 3600e3) return false;
  if (!item.commentsAt) return true;
  const since = now - new Date(item.commentsAt);
  return since > (age < 6 * 3600e3 ? 1 : 4) * 3600e3;
}
function pickForRefresh(items, budget) {
  return items
    .filter(needsCommentRefresh)
    .sort((a, b) => {
      if (!a.commentsAt !== !b.commentsAt) return a.commentsAt ? 1 : -1;
      if (!a.commentsAt) return new Date(b.time) - new Date(a.time);
      return new Date(a.commentsAt) - new Date(b.commentsAt);
    })
    .slice(0, budget);
}

// Kjøres etter at alle Reddit-lister er hentet, med felles budsjett på tvers av subreddits.
async function refreshRedditComments(sources, all, statusFile) {
  const items = [];
  for (const src of sources) {
    for (const it of all.values()) {
      if (it.source !== src.id) continue;
      it._redditSub = src.subreddit;
      it._t3 = it.id.slice(src.id.length + 1);
      items.push(it);
    }
  }
  const picks = pickForRefresh(items, reddit.commentBudget);
  const done = {};
  for (const it of picks) {
    try {
      const { comments: list, flat } = await fetchRedditThread(it._redditSub, it._t3);
      it.comments = pruneThread(list);
      it.commentCount = Math.max(list.length, it.commentCount || 0);
      it.commentsAt = iso();
      if (flat) it.commentsNote = 'Svar vist i tidsrekkefølge (uten trådstruktur)';
      else delete it.commentsNote;
      done[it.source] = (done[it.source] || 0) + 1;
    } catch (e) {
      const st = statusFile.sources[it.source];
      if (st) st.warn = `Kommentarer: ${e.message}`;
      log(`Reddit-kommentarer stoppet: ${e.message}`);
      break;
    }
  }
  for (const [id, n] of Object.entries(done)) {
    if (statusFile.sources[id]) statusFile.sources[id].lastRefreshed = n;
  }
  return Object.values(done).reduce((a, b) => a + b, 0);
}

// --- Invision Community (Kvinneguiden): aktivitetsstrøm + emnesider med JSON-LD.
async function fetchInvision(src, existing) {
  const { text, status } = await fetchText(src.url);
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const chunks = text.split(/<li class='ipsStreamItem ipsStreamItem_contentBlock/).slice(1);
  const byTopic = new Map();
  for (const c of chunks) {
    const link = c.match(/<a href='(https:\/\/forum\.kvinneguiden\.no\/topic\/(\d+)-[^'?#]*)[^']*'[^>]*data-searchable>\s*([\s\S]*?)<\/a>/);
    if (!link) continue;
    const topicUrl = link[1].replace(/\/?$/, '/');
    const topicId = link[2];
    const title = htmlToText(link[3]);
    const ts = c.match(/data-timestamp='(\d+)'/);
    const time = ts ? new Date(Number(ts[1]) * 1000) : now;
    const snippetM = c.match(/data-ipsTruncate[^>]*>([\s\S]*?)<\/div>\s*<\/div>/);
    const snippet = snippetM ? htmlToText(snippetM[1]) : '';
    const statusM = c.match(/ipsStreamItem_status[^>]*>([\s\S]*?)<\/p>/);
    const statusText = statusM ? htmlToText(statusM[1]) : '';
    const repliesM = c.match(/(\d+)\s+svar/);
    const forumM = c.match(/<a href='https:\/\/forum\.kvinneguiden\.no\/forum\/[^']+'>([^<]+)<\/a>/);
    const author = (statusText.match(/^(.+?)\s+(svarte|opprettet|startet|la ut|postet)/) || [])[1];
    const isNewTopic = /opprettet|startet/i.test(statusText);
    const id = `${src.id}:${topicId}`;
    const prev = existing.get(id) || byTopic.get(id);
    // 'time' er siste aktivitet (slik strømmen sorterer), 'created' er når emnet ble opprettet.
    const item = prev ? { ...prev } : {
      id, source: src.id, title, url: topicUrl, time: iso(time), body: snippet,
    };
    item.title = title || item.title;
    if (isNewTopic) { item.created = iso(time); item.author = author || item.author; }
    item.category = forumM ? htmlToText(forumM[1]) : item.category;
    if (repliesM) item.commentCount = Number(repliesM[1]);
    if (!item.time || new Date(item.time) < time) item.time = iso(time);
    item.activity = iso(time);
    if (!item.topicFetched && snippet && (!item.body || item.body.length < snippet.length)) item.body = snippet;
    byTopic.set(id, item);
  }
  return { items: [...byTopic.values()] };
}

function parseLdJson(html) {
  const out = [];
  const re = /<script type=["']application\/ld\+json["']>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    try { out.push(JSON.parse(m[1])); } catch { /* ignorer */ }
  }
  return out;
}

async function refreshInvisionTopics(items, status) {
  const candidates = items
    .filter((it) => {
      if (!it.topicFetched) return true;
      const since = now - new Date(it.commentsAt || 0);
      const idle = now - new Date(it.activity || it.time);
      if (idle > 72 * 3600e3) return false;
      // Har det kommet nye svar siden sist? Da haster det mer.
      return since > (idle < 3600e3 ? 1.5 : 6) * 3600e3;
    })
    .sort((a, b) => {
      if (!a.topicFetched !== !b.topicFetched) return a.topicFetched ? 1 : -1;
      return new Date(b.activity || b.time) - new Date(a.activity || a.time);
    })
    .slice(0, LIMITS.invisionTopicBudget);
  let done = 0;
  for (const it of candidates) {
    try {
      await sleep(LIMITS.invisionDelayMs);
      // getLastComment sender oss til siden med de nyeste svarene.
      const { text, status: st } = await fetchText(it.url + '?do=getLastComment');
      if (st !== 200) throw new Error(`HTTP ${st}`);
      const ld = parseLdJson(text).find((j) => j && j['@type'] === 'DiscussionForumPosting');
      if (!ld) throw new Error('Fant ikke JSON-LD på emnesiden');
      const created = parseDate(ld.dateCreated || ld.datePublished);
      if (created) it.created = iso(created);
      if (ld.author?.name) it.author = ld.author.name;
      if (ld.text) it.body = truncate(cleanInvisionText(ld.text), LIMITS.bodyChars);
      const comments = (ld.comment || []).map((c) => ({
        id: (c['@id'] || '').split('#')[1] || undefined,
        author: c.author?.name || 'Anonym',
        time: iso(parseDate(c.dateCreated)),
        body: truncate(cleanInvisionText(c.text || ''), LIMITS.commentChars),
        depth: 0,
        score: c.upvoteCount || 0,
      }));
      it.comments = comments.slice(-LIMITS.commentsPerItem);
      const cc = (ld.interactionStatistic || []).find((s) => /CommentAction/.test(s.interactionType));
      if (cc) it.commentCount = cc.userInteractionCount;
      if (ld.pageEnd > 1) it.commentsNote = `Nyeste svar (side ${ld.pageStart || ld.pageEnd} av ${ld.pageEnd})`;
      else delete it.commentsNote;
      it.topicFetched = true;
      it.commentsAt = iso();
      done++;
    } catch (e) {
      status.warn = `Emner: ${e.message}`;
      if (/HTTP (403|429|5)/.test(e.message)) break;
    }
  }
  return done;
}
function cleanInvisionText(t) {
  return String(t).replace(/\r/g, '').replace(/[ \t]*\n[ \t\n]*\n[ \t\n]*/g, '\n\n').replace(/^[ \t]+|[ \t]+$/gm, '').replace(/Anonymkode:\s*\S+\s*$/i, '').trim();
}

// --- Entur (tog-avvik). Slår sammen situasjoner for stoppested, linjer og operatør.
async function fetchEntur(src, existing) {
  const sitFields = `id situationNumber summary { value language } description { value language } advice { value language }
    severity creationTime versionedAtTime reportType validityPeriod { startTime endTime } infoLinks { uri label }
    affects { __typename ... on AffectedLine { line { id publicCode name } } ... on AffectedStopPlace { stopPlace { id name } }
      ... on AffectedServiceJourney { serviceJourney { line { id publicCode } } operatingDay }
      ... on AffectedStopPlaceOnLine { line { id publicCode } stopPlace { id name } }
      ... on AffectedStopPlaceOnServiceJourney { stopPlace { id name } serviceJourney { line { id publicCode } } } }`;
  const parts = [];
  (src.stopPlaces || []).forEach((id, i) => parts.push(`sp${i}: stopPlace(id:"${id}") { id name situations { ${sitFields} } }`));
  (src.lines || []).forEach((id, i) => parts.push(`ln${i}: line(id:"${id}") { id publicCode situations { ${sitFields} } }`));
  (src.authorities || []).forEach((id, i) => parts.push(`au${i}: authority(id:"${id}") { id name situations { ${sitFields} } }`));
  const query = `{ ${parts.join('\n')} }`;
  const { text, status } = await fetchText('https://api.entur.io/journey-planner/v3/graphql', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'ET-Client-Name': 'bedeem-reader', Accept: 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 200)}`);
  const json = JSON.parse(text);
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join('; '));

  const wantedLines = new Set(src.lines || []);
  const wantedStops = new Set(src.stopPlaces || []);
  const keywords = (src.keywords || []).map((k) => k.toLowerCase());
  const seen = new Map();
  for (const [key, val] of Object.entries(json.data || {})) {
    for (const s of val?.situations || []) {
      const affLines = new Set(); const affStops = new Set(); const names = new Set();
      for (const a of s.affects || []) {
        const line = a.line || a.serviceJourney?.line;
        if (line) { affLines.add(line.id); if (line.publicCode) names.add(line.publicCode); }
        if (a.stopPlace) { affStops.add(a.stopPlace.id); names.add(a.stopPlace.name); }
      }
      const txt = [pick(s.summary), pick(s.description), pick(s.advice)].join(' ').toLowerCase();
      let relevant = !key.startsWith('au');
      if (!relevant) {
        relevant = [...affLines].some((l) => wantedLines.has(l)) || [...affStops].some((l) => wantedStops.has(l))
          || (affLines.size === 0 && affStops.size === 0 && keywords.some((k) => txt.includes(k)));
      }
      if (!relevant) continue;
      const num = s.situationNumber || s.id;
      if (seen.has(num)) continue;
      const summary = pick(s.summary) || 'Avvik';
      const parts = [];
      const desc = pick(s.description); if (desc && desc !== summary) parts.push(desc);
      const advice = pick(s.advice); if (advice) parts.push('Råd: ' + advice);
      const vp = s.validityPeriod;
      if (vp?.startTime) parts.push(`Gjelder: ${fmtNo(vp.startTime)}${vp.endTime ? ' – ' + fmtNo(vp.endTime) : ' →'}`);
      if (names.size) parts.push('Berører: ' + [...names].join(', '));
      for (const l of s.infoLinks || []) parts.push(`${l.label || 'Mer info'}: ${l.uri}`);
      const prev = existing.get(`${src.id}:${num}`);
      seen.set(num, {
        id: `${src.id}:${num}`,
        source: src.id,
        title: summary,
        url: s.infoLinks?.[0]?.uri || src.url || 'https://www.vy.no/',
        time: prev?.time || iso(parseDate(s.creationTime) || parseDate(vp?.startTime)),
        updated: iso(parseDate(s.versionedAtTime)),
        severity: s.severity,
        category: s.reportType,
        body: truncate(parts.join('\n\n'), LIMITS.bodyChars),
      });
    }
  }
  // Situasjoner som var aktive men er borte nå: merk som avsluttet.
  for (const it of existing.values()) {
    if (it.source === src.id && !seen.has(it.id.slice(src.id.length + 1)) && !it.ended) {
      seen.set(it.id, { ...it, ended: iso() });
    }
  }
  return { items: [...seen.values()] };
}
// --- Politiloggen (politiet.no). Én tråd per hendelse; oppdateringer vises som svar.
async function fetchPolitiloggen(src, existing) {
  const take = 50; // API-et godtar maks 50 per side; 'skip' blar videre
  const pages = src.pages || (src.municipalities?.length ? 4 : 2);
  const raw = [];
  for (let p = 0; p < pages; p++) {
    const params = new URLSearchParams();
    for (const d of src.districts || []) params.append('districts', d);
    params.set('take', String(take));
    params.set('skip', String(p * take));
    const { text, status } = await fetchText(`https://api.politiloggen.politiet.no/messages/?${params}`, { headers: { Accept: 'application/json' } });
    if (status !== 200) throw new Error(`HTTP ${status}: ${text.slice(0, 160)}`);
    const json = JSON.parse(text);
    raw.push(...(json.messages || []));
    if (!json.hasMoreResults) break;
    await sleep(300);
  }
  const wanted = (src.municipalities || []).map((m) => m.toLowerCase());
  const msgs = raw.filter((m) => !wanted.length || wanted.includes(String(m.municipality || '').toLowerCase()));
  const byThread = new Map();
  for (const m of msgs) {
    if (!byThread.has(m.threadId)) byThread.set(m.threadId, []);
    byThread.get(m.threadId).push(m);
  }
  const items = [];
  for (const [threadId, list] of byThread) {
    const id = `${src.id}:${threadId}`;
    const prev = existing.get(id);
    // Slå sammen med meldinger vi har fra før (API-et gir bare de nyeste).
    const all = new Map();
    if (prev) {
      all.set(prev.firstId || `${threadId}-0`, { id: prev.firstId || `${threadId}-0`, text: prev.body, createdOn: prev.time });
      for (const c of prev.comments || []) all.set(c.id, { id: c.id, text: c.body, createdOn: c.time });
    }
    for (const m of list) all.set(m.id, { id: m.id, text: m.text, createdOn: m.createdOn });
    const sorted = [...all.values()].sort((a, b) => (a.createdOn < b.createdOn ? -1 : 1));
    const first = sorted[0];
    const latest = list.sort((a, b) => (a.createdOn < b.createdOn ? 1 : -1))[0];
    const place = latest.area && latest.area !== latest.municipality ? `${latest.area} (${latest.municipality})` : latest.municipality;
    items.push({
      id,
      source: src.id,
      title: `${latest.category || 'Melding'} · ${place}`,
      url: src.url || 'https://www.politiet.no/politiloggen/',
      time: iso(parseDate(first.createdOn)),
      updated: iso(parseDate(latest.createdOn)),
      author: (latest.district || '').replace(/ Politidistrikt$/i, ' politidistrikt'),
      category: latest.category,
      body: truncate((first.text || '').trim(), LIMITS.bodyChars),
      firstId: first.id,
      comments: sorted.slice(1).map((m) => ({ id: m.id, author: 'Politiet', time: iso(parseDate(m.createdOn)), body: truncate((m.text || '').trim(), LIMITS.commentChars), depth: 0 })),
      commentCount: sorted.length - 1,
      active: !!latest.isActive,
    });
  }
  return { items };
}

// --- CISA Known Exploited Vulnerabilities (JSON-katalog).
async function fetchCisaKev(src) {
  const { text, status } = await fetchText(src.url, { headers: { Accept: 'application/json' } });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  const json = JSON.parse(text);
  const vulns = (json.vulnerabilities || [])
    .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1))
    .slice(0, 150);
  const items = vulns.map((v) => {
    const parts = [];
    if (v.shortDescription) parts.push(v.shortDescription);
    if (v.requiredAction) parts.push('Tiltak: ' + v.requiredAction);
    if (v.dueDate) parts.push('Frist (US federal): ' + v.dueDate);
    if (v.knownRansomwareCampaignUse && v.knownRansomwareCampaignUse !== 'Unknown') parts.push('Brukt i løsepengevirus-kampanjer: ' + v.knownRansomwareCampaignUse);
    if (v.notes) parts.push(v.notes.split(/\s*;\s*/).filter(Boolean).join('\n'));
    return {
      id: `${src.id}:${v.cveID}`,
      source: src.id,
      title: `${v.cveID} · ${v.vendorProject} ${v.product}: ${v.vulnerabilityName}`,
      url: `https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.cveID)}`,
      time: iso(parseDate(v.dateAdded + 'T12:00:00Z')),
      category: v.vendorProject,
      body: truncate(parts.join('\n\n'), LIMITS.bodyChars),
    };
  });
  return { items };
}

function pick(arr) {
  if (!arr?.length) return '';
  return (arr.find((x) => /^(no|nb|nn)/i.test(x.language || '')) || arr[0]).value?.trim() || '';
}
function fmtNo(isoStr) {
  const d = parseDate(isoStr);
  if (!d) return isoStr;
  return d.toLocaleString('nb-NO', { timeZone: 'Europe/Oslo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------- Lagring
async function loadExisting() {
  await fs.mkdir(DAYS_DIR, { recursive: true });
  const map = new Map();
  for (const f of (await fs.readdir(DAYS_DIR)).filter((f) => f.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(DAYS_DIR, f), 'utf8'));
      for (const it of j.items || []) map.set(it.id, it);
    } catch (e) { log('Kunne ikke lese', f, e.message); }
  }
  return map;
}
async function loadStatus() {
  try { return JSON.parse(await fs.readFile(path.join(DATA_DIR, 'status.json'), 'utf8')); } catch { return { sources: {} }; }
}
const dayKey = (isoStr) => isoStr.slice(0, 10);

async function main() {
  const cfg = JSON.parse(await fs.readFile(path.join(ROOT, 'sources.json'), 'utf8'));
  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null; // til lokal testing
  const sources = cfg.sources.filter((s) => s.enabled !== false && (!only || only.has(s.id)));
  const existing = await loadExisting();
  const statusFile = await loadStatus();
  log(`Har ${existing.size} innlegg fra før. Kilder: ${sources.map((s) => s.id).join(', ')}`);

  const cutoff = new Date(now - RETENTION_DAYS * 86400e3);
  const all = new Map([...existing].filter(([, it]) => new Date(it.time) >= cutoff));

  for (const src of sources) {
    const st = statusFile.sources[src.id] || {};
    st.name = src.name; st.type = src.type; st.lastRun = iso();
    delete st.error; delete st.warn;
    try {
      let result;
      if (src.type === 'rss') result = await fetchRss(src);
      else if (src.type === 'reddit') result = await fetchReddit(src, all);
      else if (src.type === 'invision') result = await fetchInvision(src, all);
      else if (src.type === 'entur') result = await fetchEntur(src, all);
      else if (src.type === 'cisa-kev') result = await fetchCisaKev(src);
      else if (src.type === 'politiloggen') result = await fetchPolitiloggen(src, all);
      else throw new Error(`Ukjent kildetype ${src.type}`);

      let added = 0;
      for (const it of result.items) {
        if (!all.has(it.id)) added++;
        const prev = all.get(it.id);
        all.set(it.id, { ...prev, ...stripUndefined(it) });
      }
      const mine = [...all.values()].filter((it) => it.source === src.id);
      let refreshed = 0;
      if (src.type === 'invision') refreshed = await refreshInvisionTopics(mine, st);
      st.ok = true; st.lastOk = iso(); st.count = mine.length; st.lastAdded = added; st.lastRefreshed = refreshed;
      log(`${src.id}: ${result.items.length} hentet, ${added} nye, ${refreshed} tråder oppdatert${st.warn ? ' – ' + st.warn : ''}`);
    } catch (e) {
      st.ok = false; st.error = String(e.message || e).slice(0, 300);
      log(`${src.id}: FEIL ${st.error}`);
    }
    statusFile.sources[src.id] = st;
  }

  const redditSources = sources.filter((s) => s.type === 'reddit');
  if (redditSources.length) {
    const n = await refreshRedditComments(redditSources, all, statusFile);
    log(`Reddit: ${n} kommentartråder oppdatert`);
  }

  // Rens interne felter og skriv dagsfiler. Innlegg eldre enn oppbevaringstiden droppes.
  const byDay = new Map();
  for (const it of all.values()) {
    if (new Date(it.time) < cutoff) continue;
    const clean = { ...it };
    for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];
    const d = dayKey(clean.time);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d).push(clean);
  }
  const days = [];
  for (const [d, items] of [...byDay].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    items.sort((a, b) => (a.time < b.time ? 1 : -1));
    const json = JSON.stringify({ day: d, generated: iso(), items });
    const file = path.join(DAYS_DIR, `${d}.json`);
    const old = await fs.readFile(file, 'utf8').catch(() => '');
    // Ikke skriv om bare 'generated' er endret.
    if (old.replace(/"generated":"[^"]*"/, '') !== json.replace(/"generated":"[^"]*"/, '')) await fs.writeFile(file, json);
    days.push({ day: d, count: items.length, bytes: Buffer.byteLength(json) });
  }
  for (const f of await fs.readdir(DAYS_DIR)) {
    if (f.endsWith('.json') && !byDay.has(f.slice(0, 10))) await fs.unlink(path.join(DAYS_DIR, f));
  }
  statusFile.generated = iso();
  await fs.writeFile(path.join(DATA_DIR, 'status.json'), JSON.stringify(statusFile, null, 1));
  // Publiseringsrate per kilde – brukes av appen til å løfte sjeldne kilder. Telles over siste
  // 7 dager, men for kilder vi nettopp har begynt å følge skaleres tallet opp fra den perioden
  // vi faktisk har observert (minst én dag), så nye kilder ikke feilaktig framstår som sjeldne.
  const weekAgo = new Date(now - 7 * 86400e3);
  const counts = {};
  for (const it of all.values()) {
    if (new Date(it.time) >= weekAgo) counts[it.source] = (counts[it.source] || 0) + 1;
  }
  const perWeek = {};
  for (const s of sources) {
    const st = statusFile.sources[s.id] || {};
    if (!st.firstSeen) { st.firstSeen = iso(); statusFile.sources[s.id] = st; }
    const observedDays = Math.min(7, Math.max(1, (now - new Date(st.firstSeen)) / 86400e3));
    perWeek[s.id] = Math.round(((counts[s.id] || 0) / observedDays) * 7 * 10) / 10;
  }
  await fs.writeFile(path.join(DATA_DIR, 'status.json'), JSON.stringify(statusFile, null, 1));
  const index = {
    generated: iso(),
    total: days.reduce((n, d) => n + d.count, 0),
    days,
    sources: sources.map((s) => {
      const st = statusFile.sources[s.id] || {};
      return { id: s.id, name: s.name, short: s.short || s.name, group: s.group, type: s.type, ok: !!st.ok, lastOk: st.lastOk, error: st.error, warn: st.warn, count: st.count || 0, perWeek: perWeek[s.id] || 0 };
    }),
  };
  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index));
  log(`Ferdig: ${index.total} innlegg fordelt på ${days.length} dager.`);
}
function stripUndefined(o) {
  const r = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) r[k] = v;
  return r;
}

main().catch((e) => { console.error(e); process.exit(1); });
