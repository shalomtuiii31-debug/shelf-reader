'use strict';
// Following: release tracker for series read elsewhere, with countdowns, delay/hiatus labels,
// and a jump from a caught-up manhwa into its novel. Release dates come from releases.json,
// which tracker/fetch.py refreshes hourly via GitHub Actions. Progress here is per device.

const DAY = 86400000;
let releases = null;
let follow = {};
try { follow = JSON.parse(localStorage.getItem('shelf-follow') || '{}'); } catch {}
const saveFollow = () => { try { localStorage.setItem('shelf-follow', JSON.stringify(follow)); } catch {} };
const fstate = id => follow[id] ??= { read: 0, novel: '', anchors: [] };

async function loadReleases() {
  try {
    const res = await fetch('releases.json', { cache: 'no-cache' });
    if (res.ok) releases = await res.json();
  } catch {}
  renderFollowing();
}

const localDate = d => new Date(d + 'T00:00:00');
const median = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : 7; };
function ago(ms) {
  const d = Math.floor(ms / DAY);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : `${d} days ago`;
}
function countdown(ms) {
  const d = Math.floor(ms / DAY), h = Math.floor(ms % DAY / 3600000);
  return d ? `${d}d ${h}h` : h ? `${h}h ${Math.floor(ms % 3600000 / 60000)}m` : `${Math.max(1, Math.floor(ms / 60000))}m`;
}

// Next release from the series' own rhythm: median gap between recent chapters.
function schedule(s) {
  const r = s.releases;
  const last = r.at(-1), lastAt = localDate(last.date).getTime();
  const gaps = r.slice(-13).map((x, i, a) => i && (localDate(x.date) - localDate(a[i - 1].date)) / DAY).slice(1).filter(g => g > 0);
  const interval = Math.max(1, median(gaps));
  const next = lastAt + interval * DAY, now = Date.now(), since = now - lastAt;
  let pill = null;
  if (/hiatus/i.test(s.status)) pill = ['hiatus', 'On hiatus (announced)'];
  else if (since > Math.max(21, interval * 3) * DAY) pill = ['hiatus', `Possible hiatus · last chapter ${ago(since)}`];
  else if (now - next >= 2 * DAY) pill = ['late', `Delayed ${Math.floor((now - next) / DAY)} days`];
  const nextText = now < next
    ? `Next ~${new Date(next).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} · in ${countdown(next - now)}`
    : pill ? 'Waiting for the next chapter' : 'Due any time now';
  return { last, since, interval, nextText, pill };
}

// Novel chapter where manhwa chapter m ends, from the match points (interpolated between them).
function novelChapterFor(m, anchors) {
  if (!anchors.length) return null;
  const a = anchors.filter(x => x[0] <= m).at(-1) || anchors[0];
  if (a[0] === m) return a[1];
  const b = anchors.find(x => x[0] > m) || (anchors.length > 1 && a === anchors.at(-1) ? anchors.at(-2) : null);
  if (b && b[0] !== a[0]) return Math.round(a[1] + (m - a[0]) * (b[1] - a[1]) / (b[0] - a[0]));
  return Math.round(m * a[1] / a[0]);
}

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function renderFollowing() {
  const box = $('#following');
  if (!releases?.series?.length) { box.hidden = true; return; }
  box.hidden = false;
  const list = $('#followList');
  list.innerHTML = '';
  for (const s of releases.series) {
    if (!s.releases.length) continue;
    const st = fstate(s.id), sc = schedule(s), latest = sc.last.ch;
    const card = el('div', 'follow');
    const thumb = el('div', 'cover');
    if (s.cover) thumb.style.backgroundImage = `url("${s.cover}")`;
    card.append(thumb);
    const head = el('div', 'fhead');
    head.append(el('div', 't', s.title), el('span', 'muted small', s.type));
    if (latest > st.read && st.read) head.append(el('span', 'pill new', `${latest - st.read} new`));
    if (sc.pill) head.append(el('span', `pill ${sc.pill[0]}`, sc.pill[1]));
    card.append(head);

    card.append(el('div', 'small', `Latest: Ch ${latest} · ${ago(sc.since)}`));
    card.append(el('div', 'small muted countdown', sc.nextText));

    const row = el('div', 'frow');
    const you = el('span', 'small', st.read ? `You: Ch ${st.read}` : 'Tap to set your chapter');
    you.style.cursor = 'pointer';
    you.onclick = () => {
      const v = prompt(`${s.title}: which chapter have you read up to?`, st.read || latest);
      if (v !== null && +v >= 0) { st.read = Math.floor(+v); saveFollow(); renderFollowing(); }
    };
    const plus = el('button', 'btn', '+1');
    plus.onclick = () => { st.read = (st.read || 0) + 1; saveFollow(); renderFollowing(); };
    row.append(you, plus);
    if (s.url) {
      const a = el('a', 'btn', 'Read official ›');
      a.href = s.url; a.target = '_blank'; a.rel = 'noopener';
      row.append(a);
    }
    card.append(row);

    if (s.novel) card.append(novelBridge(s, st));
    list.append(card);
  }
}

// Manhwa → novel: the novel chapter that picks up where the manhwa is. The novel is complete,
// so there's no countdown; the estimate moves with the manhwa and can be nudged ±1.
function novelBridge(s, st) {
  const wrap = el('div', 'bridge');
  const anchors = st.anchors?.length ? st.anchors : (s.novelAnchors || []);
  if (!st.read || !anchors.length) {
    wrap.append(el('div', 'small muted', '📖 Set your manhwa chapter to see where you are in the novel.'));
    return wrap;
  }
  const n = novelChapterFor(st.read, anchors) + 1 + (st.novelAdjust || 0);
  const row = el('div', 'frow');
  row.append(el('span', 'small novelpos', `📖 Novel (complete): continue at Chapter ${n}`));
  for (const [label, d] of [['−1', -1], ['+1', 1]]) {
    const btn = el('button', 'btn', label);
    btn.onclick = () => { st.novelAdjust = (st.novelAdjust || 0) + d; saveFollow(); renderFollowing(); };
    row.append(btn);
  }
  // Reading link: the reader's own bookmark, kept on this device.
  const links = el('div', 'frow');
  if (st.novelUrl) {
    const a = el('a', 'btn primary', `Read Ch ${n} ›`);
    a.href = st.novelUrl; a.target = '_blank'; a.rel = 'noopener';
    links.append(a);
  }
  const set = el('button', 'btn', st.novelUrl ? 'Change link' : 'Set reading link');
  set.onclick = () => {
    const u = prompt('Web address where you read the novel:', st.novelUrl || '');
    if (u === null) return;
    st.novelUrl = /^https?:\/\//.test(u.trim()) ? u.trim() : '';
    saveFollow(); renderFollowing();
  };
  links.append(set);
  wrap.append(row, links, el('div', 'small muted', `Matches manhwa Ch ${st.read}. Estimated from where Season 1 ends (Ch 109 ≈ novel Ch 159); nudge it if it's a chapter off.`));
  return wrap;
}

// Keep countdowns ticking while the library is showing.
setInterval(() => { if (!$('#library').hidden && releases) renderFollowing(); }, 60000);
loadReleases();
