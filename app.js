'use strict';
// Shelf Reader — local-only reader for light novels, manga and manhwa, with bookmarks, text-to-speech and offline support.

const $ = s => document.querySelector(s);

// ---------- Storage (IndexedDB) ----------
// meta: small per-book info for the library list; books: chapters + images; progress: bookmarks.
let dbPromise;
function db() {
  return dbPromise ??= new Promise((res, rej) => {
    const r = indexedDB.open('shelf', 1);
    r.onupgradeneeded = () => {
      for (const s of ['meta', 'books', 'progress']) r.result.createObjectStore(s, { keyPath: 'id' });
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((res, rej) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => res(req?.result);
    t.onerror = () => rej(t.error);
  });
}
const get = (s, k) => tx(s, 'readonly', st => st.get(k));
const all = s => tx(s, 'readonly', st => st.getAll());
const put = (s, v) => tx(s, 'readwrite', st => st.put(v));
const del = (s, k) => tx(s, 'readwrite', st => st.delete(k));

// ---------- Settings ----------
const defaults = { theme: 'dark', fontSize: 19, lineHeight: 1.7, rate: 1, voiceURI: '' };
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem('shelf-settings') || '{}')); } catch {}
function saveSettings() {
  try { localStorage.setItem('shelf-settings', JSON.stringify(settings)); } catch {}
  applySettings();
}
function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  document.documentElement.style.setProperty('--lh', settings.lineHeight);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}

// ---------- Parsing ----------
// A chapter is { title, paras } where each item is a string (text) or { img: n } (index into book.images).

// Stable id from title/author/length so bookmarks can be moved between devices.
function bookId(title, author, n) {
  let h = 2166136261;
  for (const c of `${title}|${author}|${n}`) h = Math.imul(h ^ c.codePointAt(0), 16777619);
  return 'b' + (h >>> 0).toString(36);
}
const clean = s => s.replace(/[ \t ​]+/g, ' ').trim();
const splitText = t => t.split('\n').map(clean).filter(Boolean);
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
const IMG_RE = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;
const MIME = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml' };
const mimeOf = p => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';

// Width/height stored at import so pages keep their place while images load.
async function dims(blob) {
  try {
    const b = await createImageBitmap(blob);
    const d = { w: b.width, h: b.height };
    b.close();
    return d;
  } catch { return { w: 0, h: 0 }; }
}

function resolvePath(base, href) {
  const parts = (base + decodeURIComponent(href.split('#')[0])).split('/');
  const out = [];
  for (const p of parts) p === '..' ? out.pop() : p !== '.' && out.push(p);
  return out.join('/');
}
const dirOf = p => p.slice(0, p.lastIndexOf('/') + 1);

const BLOCK = 'p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,div,dt,dd,td';
const isImg = el => /^(img|image)$/i.test(el.tagName);
async function extractItems(body, addImage) {
  if (!body) return [];
  body.querySelectorAll('script,style').forEach(e => e.remove());
  body.querySelectorAll('br').forEach(b => b.replaceWith('\n'));
  const nodes = [...body.querySelectorAll(BLOCK + ',img,image')].filter(el => isImg(el) || !el.querySelector(BLOCK));
  if (!nodes.length) return splitText(body.textContent);
  const out = [];
  for (const el of nodes) {
    if (isImg(el)) {
      const src = el.getAttribute('src') || el.getAttribute('href') || el.getAttribute('xlink:href');
      if (!src || src.startsWith('data:')) continue;
      const n = await addImage(src);
      if (n >= 0) out.push({ img: n });
    } else out.push(...splitText(el.textContent));
  }
  return out;
}

async function parseEpub(file) {
  const zip = await JSZip.loadAsync(file);
  const read = p => zip.file(p)?.async('string');
  const xml = s => new DOMParser().parseFromString(s, 'application/xml');
  const tags = (doc, name) => [...doc.getElementsByTagNameNS('*', name)];

  const container = xml(await read('META-INF/container.xml'));
  const opfPath = tags(container, 'rootfile')[0].getAttribute('full-path');
  const base = dirOf(opfPath);
  const opf = xml(await read(opfPath));
  const title = clean(tags(opf, 'title')[0]?.textContent || '') || file.name.replace(/\.epub$/i, '');
  const author = clean(tags(opf, 'creator')[0]?.textContent || '');

  const manifest = {};
  for (const it of tags(opf, 'item')) {
    manifest[it.getAttribute('id')] = { href: it.getAttribute('href'), type: it.getAttribute('media-type') || '', props: it.getAttribute('properties') || '' };
  }

  // Images are stored once each, in reading order; tiny decorative ones are skipped.
  const images = [], imgIndex = {};
  async function addImage(path) {
    if (path in imgIndex) return imgIndex[path];
    const f = zip.file(path);
    if (!f) return (imgIndex[path] = -1);
    const blob = new Blob([await f.async('arraybuffer')], { type: mimeOf(path) });
    const { w, h } = await dims(blob);
    if (w && w < 40 && h < 40) return (imgIndex[path] = -1);
    images.push({ blob, w, h });
    return (imgIndex[path] = images.length - 1);
  }

  // Chapter titles from the table of contents (EPUB3 nav, falling back to EPUB2 NCX).
  const tocTitles = {};
  const nav = Object.values(manifest).find(i => i.props.includes('nav'));
  const ncxId = tags(opf, 'spine')[0]?.getAttribute('toc');
  const ncx = ncxId && manifest[ncxId] || Object.values(manifest).find(i => i.type.includes('ncx'));
  try {
    if (nav) {
      const navPath = resolvePath(base, nav.href);
      const doc = new DOMParser().parseFromString(await read(navPath), 'text/html');
      for (const a of doc.querySelectorAll('nav a[href]')) tocTitles[resolvePath(dirOf(navPath), a.getAttribute('href'))] ??= clean(a.textContent);
    } else if (ncx) {
      const ncxPath = resolvePath(base, ncx.href);
      const doc = xml(await read(ncxPath));
      for (const np of tags(doc, 'navPoint')) {
        const label = tags(np, 'text')[0]?.textContent;
        const src = tags(np, 'content')[0]?.getAttribute('src');
        if (label && src) tocTitles[resolvePath(dirOf(ncxPath), src)] ??= clean(label);
      }
    }
  } catch (e) { console.warn('TOC unreadable', e); }

  const chapters = [];
  for (const ref of tags(opf, 'itemref')) {
    const item = manifest[ref.getAttribute('idref')];
    if (!item || !/html/.test(item.type)) continue;
    const path = resolvePath(base, item.href);
    const html = await read(path);
    if (!html) continue;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const heading = clean(doc.querySelector('h1,h2,h3')?.textContent || '');
    const paras = await extractItems(doc.body, src => addImage(resolvePath(dirOf(path), src)));
    if (!paras.length) continue;
    chapters.push({ title: tocTitles[path] || heading || `Section ${chapters.length + 1}`, paras });
  }

  const coverId = tags(opf, 'meta').find(m => m.getAttribute('name') === 'cover')?.getAttribute('content');
  const coverItem = Object.values(manifest).find(i => i.props.includes('cover-image')) || manifest[coverId];
  const coverN = coverItem ? await addImage(resolvePath(base, coverItem.href)) : -1;
  const hasText = chapters.some(c => c.paras.some(x => typeof x === 'string'));
  return { title, author, chapters, images, kind: hasText ? 'novel' : 'comic', cover: images[coverN]?.blob || images[0]?.blob };
}

const CHAPTER_RE = /^(chapter|ch\.|prologue|epilogue|interlude|side story|afterword|extra|volume|vol\.|book|part)\b|^第.{1,8}[章話]/i;
async function parseTxt(file) {
  const text = (await file.text()).replace(/\r\n?/g, '\n');
  const blankSplit = text.split(/\n\s*\n/);
  const paras = (blankSplit.length > 20 ? blankSplit : text.split('\n')).map(p => clean(p.replace(/\n/g, ' '))).filter(Boolean);
  const chapters = [];
  for (const p of paras) {
    if (p.length < 100 && CHAPTER_RE.test(p)) chapters.push({ title: p, paras: [p] });
    else if (chapters.length) chapters.at(-1).paras.push(p);
    else chapters.push({ title: 'Start', paras: [p] });
  }
  // No chapter headings found: split into parts of ~150 paragraphs.
  if (chapters.length < 2) {
    chapters.length = 0;
    for (let i = 0; i < paras.length; i += 150) chapters.push({ title: `Part ${chapters.length + 1}`, paras: paras.slice(i, i + 150) });
  }
  return { title: file.name.replace(/\.txt$/i, ''), author: '', chapters, images: [], kind: 'novel' };
}

// Manga/manhwa from a list of [name, getBlob] pages. Folders inside an archive become chapters.
async function buildComic(title, pages) {
  pages.sort((a, b) => natural(a[0], b[0]));
  const images = [], groups = new Map();
  for (const [name, getBlob] of pages) {
    $('#status').textContent = `Adding “${title}” — page ${images.length + 1} of ${pages.length}…`;
    const blob = await getBlob();
    images.push({ blob, ...(await dims(blob)) });
    const dir = name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '';
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push({ img: images.length - 1 });
  }
  const chapters = [...groups].map(([dir, paras], i) => ({ title: dir.split('/').pop() || (groups.size > 1 ? `Chapter ${i + 1}` : title), paras }));
  return { title, author: '', chapters, images, kind: 'comic', cover: images[0]?.blob };
}
async function parseComicZip(file) {
  const zip = await JSZip.loadAsync(file);
  const names = Object.keys(zip.files).filter(p => !zip.files[p].dir && IMG_RE.test(p) && !/(^|\/)(__MACOSX|\.)/.test(p));
  if (!names.length) throw new Error('no images found in this archive');
  return buildComic(file.name.replace(/\.(cbz|zip)$/i, ''), names.map(n => [n, async () => new Blob([await zip.file(n).async('arraybuffer')], { type: mimeOf(n) })]));
}
const parseImageFiles = files => buildComic(files[0].name.replace(/[-_ ]*\d*\.\w+$/, '') || 'Comic', files.map(f => [f.name, async () => f]));

async function saveBook(book) {
  const id = bookId(book.title, book.author, book.chapters.length);
  await put('books', { id, chapters: book.chapters, images: book.images });
  await put('meta', {
    id, title: book.title, author: book.author, kind: book.kind, cover: book.cover || null,
    layout: book.kind === 'comic' ? 'vertical' : undefined,
    chapterTitles: book.chapters.map(c => c.title), addedAt: Date.now(),
  });
}

async function addFiles(files) {
  const status = $('#status');
  status.hidden = false;
  const pics = files.filter(f => f.type.startsWith('image/') || IMG_RE.test(f.name));
  const jobs = files.filter(f => !pics.includes(f)).map(f => [f.name, () => {
    if (/\.epub$/i.test(f.name) || f.type === 'application/epub+zip') return parseEpub(f);
    if (/\.(cbz|zip)$/i.test(f.name)) return parseComicZip(f);
    if (/\.cbr$/i.test(f.name)) throw new Error('CBR (RAR) files are not supported yet — convert to CBZ');
    return parseTxt(f);
  }]);
  if (pics.length) jobs.push([`${pics.length} images`, () => parseImageFiles(pics)]);
  for (const [name, parse] of jobs) {
    status.textContent = `Adding “${name}”…`;
    try {
      const book = await parse();
      if (!book.chapters.length) throw new Error('nothing readable found');
      await saveBook(book);
    } catch (e) {
      console.error(e);
      alert(`Couldn't add “${name}”: ${e.message}`);
    }
  }
  status.hidden = true;
  renderLibrary();
}

// ---------- Library ----------
let libUrls = [];
function coverEl(m) {
  const el = document.createElement('div');
  el.className = 'cover';
  if (m.cover) {
    const u = URL.createObjectURL(m.cover);
    libUrls.push(u);
    el.style.backgroundImage = `url("${u}")`;
  } else {
    // Generated cover: colours derived from the book so each one looks distinct.
    const h = parseInt(m.id.slice(1), 36) % 360;
    el.style.background = `linear-gradient(150deg, hsl(${h} 55% 48%), hsl(${(h + 60) % 360} 60% 22%))`;
    el.textContent = [...m.title.trim()][0]?.toUpperCase() || '?';
  }
  return el;
}
function pctText(pr, meta) {
  if (!pr) return 'Not started';
  return `Ch ${pr.ch + 1} of ${meta.chapterTitles.length} · ${Math.round(pr.pct * 100)}%`;
}
async function renderLibrary() {
  libUrls.forEach(URL.revokeObjectURL);
  libUrls = [];
  const [metas, progress] = await Promise.all([all('meta'), all('progress')]);
  const prog = Object.fromEntries(progress.map(p => [p.id, p]));
  metas.sort((a, b) => (prog[b.id]?.updatedAt || b.addedAt) - (prog[a.id]?.updatedAt || a.addedAt));
  $('#empty').hidden = metas.length > 0;

  const last = metas.find(m => prog[m.id]);
  const cont = $('#continue');
  cont.innerHTML = '';
  if (last) {
    const pr = prog[last.id];
    const el = document.createElement('div');
    el.className = 'continue';
    el.innerHTML = `<div class="info"><div class="k">Continue reading</div><div class="t"></div><div class="small"></div></div>`;
    el.prepend(coverEl(last));
    el.querySelector('.t').textContent = last.title;
    el.querySelector('.small').textContent = `${last.chapterTitles[pr.ch] || ''} · ${Math.round(pr.pct * 100)}%`;
    el.onclick = () => openBook(last.id);
    cont.append(el);
  }

  const ul = $('#books');
  ul.innerHTML = '';
  for (const m of metas) {
    const li = document.createElement('li');
    li.className = 'book';
    li.innerHTML = `<div class="info"><div class="t"></div><div class="muted small"></div><div class="bar-mini"><div></div></div></div><button class="icon" aria-label="Remove book">✕</button>`;
    li.prepend(coverEl(m));
    li.querySelector('.t').textContent = m.title;
    li.querySelector('.small').textContent = [m.kind === 'comic' ? 'Comic' : m.author, pctText(prog[m.id], m)].filter(Boolean).join(' · ');
    li.querySelector('.bar-mini div').style.width = ((prog[m.id]?.pct || 0) * 100) + '%';
    li.onclick = () => openBook(m.id);
    li.querySelector('button').onclick = async e => {
      e.stopPropagation();
      if (!confirm(`Remove “${m.title}” from this device? Your bookmark is kept if you add it again.`)) return;
      await del('books', m.id);
      await del('meta', m.id);
      renderLibrary();
    };
    ul.append(li);
  }
}

// ---------- Reader ----------
let book = null;   // { id, meta, chapters, images }
let cur = { ch: 0, p: 0 };
let pageUrls = [];
const isComic = () => book?.meta.kind === 'comic';
const pagedMode = () => isComic() && book.meta.layout !== 'vertical';

async function openBook(id) {
  const [data, meta, pr] = await Promise.all([get('books', id), get('meta', id), get('progress', id)]);
  if (!data) return;
  book = { id, meta, chapters: data.chapters, images: data.images || [] };
  $('#bookTitle').textContent = meta.title;
  for (const el of ['#playBtn', '#rate', '#sleep']) $(el).hidden = isComic();
  $('#pageInfo').hidden = !isComic();
  $('#library').hidden = true;
  $('#reader').hidden = false;
  history.pushState({ reader: true }, '');
  showChapter(pr?.ch ?? 0, pr?.p ?? 0);
}

function closeBook() {
  stopSpeaking();
  saveProgress();
  pageUrls.forEach(URL.revokeObjectURL);
  pageUrls = [];
  book = null;
  $('#reader').hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}

function imgEl(n) {
  const im = book.images[n];
  const el = document.createElement('img');
  if (!im) return el;
  const u = URL.createObjectURL(im.blob);
  pageUrls.push(u);
  el.src = u;
  el.alt = '';
  el.decoding = 'async';
  if (im.w) { el.width = im.w; el.height = im.h; }
  return el;
}

function showChapter(ch, p = 0) {
  ch = Math.max(0, Math.min(ch, book.chapters.length - 1));
  const chapter = book.chapters[ch];
  cur = { ch, p: Math.max(0, Math.min(p, chapter.paras.length - 1)) };
  pageUrls.forEach(URL.revokeObjectURL);
  pageUrls = [];
  const art = $('#text');
  art.className = isComic() ? (pagedMode() ? 'comic paged' : 'comic') : '';
  art.innerHTML = '';
  const frag = document.createDocumentFragment();
  chapter.paras.forEach((item, i) => {
    let el;
    if (typeof item === 'string') {
      el = document.createElement('p');
      el.textContent = item;
    } else {
      el = imgEl(item.img);
      if (i > 2 && !pagedMode()) el.loading = 'lazy';
    }
    el.dataset.i = i;
    frag.append(el);
  });
  art.append(frag);
  $('#chapTitle').textContent = `${chapter.title} · ${ch + 1}/${book.chapters.length}`;
  $('#prevChap').disabled = ch === 0;
  $('#nextChap').disabled = ch === book.chapters.length - 1;
  if (pagedMode()) { art.children[cur.p].classList.add('on'); window.scrollTo(0, 0); }
  else if (cur.p > 0) art.children[cur.p].scrollIntoView({ block: 'start' }), window.scrollBy(0, -80);
  else window.scrollTo(0, 0);
  saveProgress();
}

// Manga page turning: past the last page goes to the next chapter, before the first to the previous one.
function turnPage(d) {
  const art = $('#text'), n = art.children.length;
  const p = cur.p + d;
  if (p >= n) { if (cur.ch + 1 < book.chapters.length) showChapter(cur.ch + 1, 0); return; }
  if (p < 0) { if (cur.ch > 0) showChapter(cur.ch - 1, book.chapters[cur.ch - 1].paras.length - 1); return; }
  art.children[cur.p].classList.remove('on');
  art.children[p].classList.add('on');
  cur.p = p;
  window.scrollTo(0, 0);
  saveProgress();
}

function headerBottom() { return $('#progress').getBoundingClientRect().bottom; }
function firstVisiblePara() {
  if (pagedMode()) return cur.p;
  const ps = $('#text').children, top = headerBottom();
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    ps[mid].getBoundingClientRect().bottom <= top ? lo = mid + 1 : hi = mid;
  }
  return lo;
}

async function saveProgress() {
  if (!book) return;
  const n = book.chapters.length, paras = book.chapters[cur.ch].paras.length;
  const pct = (cur.ch + cur.p / paras) / n;
  $('#progressFill').style.width = (pct * 100) + '%';
  $('#pageInfo').textContent = `Page ${cur.p + 1} / ${paras}`;
  await put('progress', { id: book.id, ch: cur.ch, p: cur.p, pct, updatedAt: Date.now() });
}

let scrollTimer;
window.addEventListener('scroll', () => {
  if (!book || tts.on || pagedMode()) return;
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => { cur.p = firstVisiblePara(); saveProgress(); }, 400);
}, { passive: true });

// ---------- Text to speech ----------
const tts = { on: false, gen: 0, p: 0, sleepTimer: null, wakeLock: null };
const synth = window.speechSynthesis;

function chunk(text) {
  // Short pieces avoid the browser cutting off long utterances.
  const sentences = text.match(/[^.!?…]+[.!?…]+["'”’)\]]*\s*|.+$/g) || [text];
  const out = [];
  for (const s of sentences) {
    if (out.length && (out.at(-1) + s).length < 220) out[out.length - 1] += s;
    else out.push(s);
  }
  return out.map(s => s.trim()).filter(Boolean);
}

function currentVoice() {
  return synth?.getVoices().find(v => v.voiceURI === settings.voiceURI) || null;
}

function startSpeaking(fromP) {
  if (!synth) return alert('Text-to-speech is not supported in this browser.');
  synth.cancel();
  tts.on = true;
  tts.gen++;
  tts.p = fromP;
  $('#playBtn').textContent = '❚❚ Pause';
  requestWakeLock();
  speakPara(tts.gen);
}

function stopSpeaking() {
  tts.on = false;
  tts.gen++;
  synth?.cancel();
  clearTimeout(tts.sleepTimer);
  $('#sleep').value = '';
  $('#playBtn').textContent = '▶ Listen';
  document.querySelector('#text .speaking')?.classList.remove('speaking');
  tts.wakeLock?.release().catch(() => {});
  tts.wakeLock = null;
}

function speakPara(gen) {
  if (!tts.on || gen !== tts.gen) return;
  // Skip pictures; at the end of a chapter carry on into the next one.
  for (;;) {
    const paras = book.chapters[cur.ch].paras;
    while (tts.p < paras.length && typeof paras[tts.p] !== 'string') tts.p++;
    if (tts.p < paras.length) break;
    if ($('#sleep').value === 'chapter' || cur.ch + 1 >= book.chapters.length) return stopSpeaking();
    showChapter(cur.ch + 1, 0);
    tts.p = 0;
  }
  const el = $('#text').children[tts.p];
  document.querySelector('#text .speaking')?.classList.remove('speaking');
  el.classList.add('speaking');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  cur.p = tts.p;
  saveProgress();

  const pieces = chunk(book.chapters[cur.ch].paras[tts.p]);
  let k = 0;
  const next = () => {
    if (!tts.on || gen !== tts.gen) return;
    if (k >= pieces.length) { tts.p++; return speakPara(gen); }
    const u = new SpeechSynthesisUtterance(pieces[k++]);
    u.rate = settings.rate;
    const v = currentVoice();
    if (v) { u.voice = v; u.lang = v.lang; }
    u.onend = next;
    u.onerror = e => { if (e.error !== 'interrupted' && e.error !== 'canceled') next(); };
    synth.speak(u);
  };
  next();
}

async function requestWakeLock() {
  try { tts.wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && tts.on && !tts.wakeLock) requestWakeLock();
  if (document.visibilityState === 'hidden') saveProgress();
});

function fillVoices() {
  if (!synth) return;
  const voices = synth.getVoices();
  const lang = (navigator.language || 'en').slice(0, 2);
  voices.sort((a, b) => (b.lang.startsWith(lang) - a.lang.startsWith(lang)) || a.name.localeCompare(b.name));
  const sel = $('#voice');
  sel.innerHTML = '<option value="">Default voice</option>';
  for (const v of voices) sel.add(new Option(`${v.name} (${v.lang})`, v.voiceURI));
  sel.value = settings.voiceURI;
}

// ---------- Progress export / import (to move bookmarks between devices) ----------
async function exportProgress() {
  const [progress, metas] = await Promise.all([all('progress'), all('meta')]);
  const titles = Object.fromEntries(metas.map(m => [m.id, m.title]));
  const data = { app: 'shelf-reader', exported: new Date().toISOString(), progress: progress.map(p => ({ ...p, title: titles[p.id] })) };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `shelf-progress-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function importProgress(file) {
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'shelf-reader') throw new Error('not a Shelf progress file');
    let updated = 0;
    for (const p of data.progress) {
      const local = await get('progress', p.id);
      if (!local || p.updatedAt > local.updatedAt) {
        const { title, ...rest } = p;
        await put('progress', rest);
        updated++;
      }
    }
    alert(`Updated ${updated} bookmark${updated === 1 ? '' : 's'}.`);
    renderLibrary();
  } catch (e) { alert(`Couldn't import: ${e.message}`); }
}

// ---------- Wiring ----------
function jumpChapter(ch) {
  const on = tts.on;
  stopSpeaking();
  showChapter(ch);
  if (on) startSpeaking(0);
}
$('#file').onchange = e => { addFiles([...e.target.files]); e.target.value = ''; };
$('#exportBtn').onclick = exportProgress;
$('#importFile').onchange = e => { if (e.target.files[0]) importProgress(e.target.files[0]); e.target.value = ''; };
$('#backBtn').onclick = () => history.back();
window.addEventListener('popstate', () => { if (book) closeBook(); });
$('#prevChap').onclick = () => jumpChapter(cur.ch - 1);
$('#nextChap').onclick = () => jumpChapter(cur.ch + 1);
$('#playBtn').onclick = () => tts.on ? stopSpeaking() : startSpeaking(firstVisiblePara());
$('#text').onclick = e => {
  if (pagedMode()) {
    // Tap the left or right third to turn the page (flipped for right-to-left manga).
    const x = e.clientX / window.innerWidth;
    const dir = book.meta.layout === 'rtl' ? -1 : 1;
    if (x < 0.35) turnPage(-dir);
    else if (x > 0.65) turnPage(dir);
    return;
  }
  const p = e.target.closest('p');
  if (p && tts.on) startSpeaking(+p.dataset.i);
};
document.addEventListener('keydown', e => {
  if (!pagedMode() || document.querySelector('dialog[open]')) return;
  const dir = book.meta.layout === 'rtl' ? -1 : 1;
  if (e.key === 'ArrowRight') turnPage(dir);
  if (e.key === 'ArrowLeft') turnPage(-dir);
});
$('#rate').onchange = e => {
  settings.rate = +e.target.value;
  saveSettings();
  if (tts.on) startSpeaking(tts.p);
};
$('#sleep').onchange = e => {
  clearTimeout(tts.sleepTimer);
  const min = +e.target.value;
  if (min) tts.sleepTimer = setTimeout(stopSpeaking, min * 60000);
};

$('#tocBtn').onclick = () => {
  const ol = $('#tocList');
  ol.innerHTML = '';
  book.chapters.forEach((c, i) => {
    const li = document.createElement('li');
    li.textContent = c.title;
    if (i === cur.ch) li.className = 'current';
    li.onclick = () => { $('#toc').close(); jumpChapter(i); };
    ol.append(li);
  });
  $('#toc').showModal();
  ol.querySelector('.current')?.scrollIntoView({ block: 'center' });
};
$('#settingsBtn').onclick = () => {
  fillVoices();
  $('#layoutRow').hidden = !isComic();
  $('#layout').value = book.meta.layout || 'vertical';
  $('#settings').showModal();
};
document.querySelectorAll('dialog .close').forEach(b => b.onclick = () => b.closest('dialog').close());
document.querySelectorAll('dialog').forEach(d => d.onclick = e => { if (e.target === d) d.close(); });

$('#theme').onchange = e => { settings.theme = e.target.value; saveSettings(); };
$('#fontSize').oninput = e => { settings.fontSize = +e.target.value; saveSettings(); };
$('#lineHeight').oninput = e => { settings.lineHeight = +e.target.value; saveSettings(); };
$('#voice').onchange = e => { settings.voiceURI = e.target.value; saveSettings(); if (tts.on) startSpeaking(tts.p); };
$('#layout').onchange = async e => {
  book.meta.layout = e.target.value;
  await put('meta', book.meta);
  showChapter(cur.ch, cur.p);
};
if (synth) synth.onvoiceschanged = fillVoices;

$('#theme').value = settings.theme;
$('#fontSize').value = settings.fontSize;
$('#lineHeight').value = settings.lineHeight;
$('#rate').value = String(settings.rate);
applySettings();
renderLibrary();
navigator.storage?.persist?.();
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
