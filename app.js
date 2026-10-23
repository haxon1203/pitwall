'use strict';

// All data comes from BBC Sport, collected by .github/workflows/bbc.yml into the "data" branch.
const REPO = 'haxon1203/pitwall';
const LIVE_API = `https://api.github.com/repos/${REPO}/contents/live.json?ref=data`;   // uncached, for live polling
const RAW = `https://raw.githubusercontent.com/${REPO}/data/`;                          // CDN copy, up to 5 minutes old

const TEAM_COLORS = [
  ['red-bull', '#3671C6'], ['ferrari', '#E8002D'], ['mercedes', '#27F4D2'], ['mclaren', '#FF8000'],
  ['aston', '#229971'], ['alpine', '#FF87BC'], ['williams', '#64C4FF'], ['racing-bulls', '#6692FF'], ['rb', '#6692FF'],
  ['haas', '#B6BABD'], ['audi', '#BB0A30'], ['sauber', '#52E252'], ['cadillac', '#C8A45C'],
];
const teamColor = id => (TEAM_COLORS.find(([k]) => (id || '').includes(k)) || [0, '#8b95a7'])[1];

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('pw:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('pw:' + k, JSON.stringify(v)); } catch {} },
};
async function getJSON(url, { timeout = 15000, headers } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers, cache: 'no-cache' });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}
const fmtTime = d => new Date(d).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = d => new Date(d).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = d => new Date(d).toLocaleDateString([], { day: 'numeric', month: 'short' });
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function countdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  const p = n => String(n).padStart(2, '0');
  return (d ? d + 'd ' : '') + `${p(Math.floor(s % 86400 / 3600))}:${p(Math.floor(s % 3600 / 60))}:${p(s % 60)}`;
}
const mins = ms => { const m = Math.max(0, Math.round(ms / 60e3)); return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`; };
// "1:35.291" -> seconds
const secs = t => { if (!t) return null; const p = t.split(':').map(Number); return p.length === 2 ? p[0] * 60 + p[1] : p[0]; };

// ---------- state ----------
const S = {
  tab: store.get('tab') || 'live',
  standTab: store.get('standTab') || 'drivers',
  session: null,                       // session key picked in the timing card
  bbc: store.get('bbc'),               // news, standings, calendar, last race
  live: store.get('live'),             // weekend sessions + commentary
  error: null,
};
if (!['drivers', 'teams', 'last'].includes(S.standTab)) S.standTab = 'drivers';
if (!['live', 'news', 'standings', 'calendar'].includes(S.tab)) S.tab = 'live';

// ---------- tabs ----------
function setTab(t) {
  S.tab = t; store.set('tab', t);
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.dataset.view !== t);
  $('#scroller').scrollTop = 0;
  if (t !== 'live' && typeof pauseMap === 'function') pauseMap();
  if (t === 'live' && typeof sizeMap === 'function') requestAnimationFrame(() => { sizeMap(); drawMap(); });
}
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  S.standTab = b.dataset.st; store.set('standTab', S.standTab); renderStandings();
}));

// ---------- loading ----------
async function loadBBC() {
  const j = await getJSON(RAW + 'bbc.json?t=' + Math.floor(Date.now() / 60e3));
  if (!j.standings && !j.news) throw new Error('empty');
  S.bbc = j; store.set('bbc', j);
  renderStandings(); renderCalendar(); renderNews(); renderWeekend();
}
async function loadLive() {
  let j;
  try {
    // GitHub API: always the newest copy (304 replies don't count towards its hourly limit)
    j = await getJSON(LIVE_API, { headers: { Accept: 'application/vnd.github.raw+json' } });
  } catch {
    j = await getJSON(RAW + 'live.json?t=' + Math.floor(Date.now() / 30e3));
  }
  if (!S.live || !(j.at < S.live.at)) { S.live = j; store.set('live', j); }
  renderWeekend(); renderTiming(); renderCommentary();
  if (M.index) renderMapHead();
}

// ---------- weekend ----------
const sessionState = s => s.isLive ? 'live' : s.status === 'PostEvent' ? 'done' : (s.end && Date.now() > s.end + 30 * 60e3) ? 'done' : 'upcoming';
function roundInfo(name) {
  const cal = (S.bbc?.calendar || []).filter(e => !e.cancelled && !e.test);
  const i = cal.findIndex(e => e.name === name);
  return i >= 0 ? `Round ${i + 1} of ${cal.length}` : '';
}

function renderWeekend() {
  const el = $('#weekend'), w = S.live?.weekend;
  if (!w) return;
  const now = Date.now();
  const sessions = w.sessions;
  const live = sessions.find(s => s.isLive);
  const next = sessions.find(s => sessionState(s) === 'upcoming' && s.start > now);
  let cd;
  if (live) cd = `<div class="countdown"><span class="pill live"><span class="dot"></span>Live now</span><span class="t">${esc(live.name)}</span></div>`;
  else if (next) cd = `<div class="countdown"><span class="lbl">${esc(next.name)} starts in</span><span class="t" data-countdown="${next.start}">${countdown(next.start - now)}</span></div>`;
  else cd = `<div class="countdown"><span class="lbl">Weekend complete</span></div>`;
  const round = roundInfo(w.name);
  const when = w.status === 'PostEvent' ? 'Last weekend' : sessions[0]?.start - now < 5 * 86400e3 ? 'This weekend' : 'Next up';
  el.innerHTML = `
    <div>
      <div class="eyebrow">${esc(round)}${round ? ' · ' : ''}${when}</div>
      <h1>${esc(w.name)}</h1>
      <div class="where">${esc(w.circuit)}</div>
    </div>
    ${cd}
    <div class="sessions">
      ${sessions.map(s => {
        const st = sessionState(s);
        const pill = st === 'live' ? '<span class="pill live"><span class="dot"></span>Live</span>'
          : s === next ? '<span class="pill next">Next</span>' : st === 'done' ? '<span class="pill done">Done</span>' : '<span></span>';
        return `<div class="srow"><span class="n">${esc(s.name)}</span><span class="d">${s.start ? fmtDay(s.start) + ' · ' + fmtTime(s.start) : ''}</span>${pill}</div>`;
      }).join('')}
    </div>
    <div class="muted" style="font-size:12px">Times shown in your local time zone.</div>`;
  $('#liveDot').hidden = !live;
}

// ---------- timing (BBC session results, updated live during a session) ----------
function pickSession(w) {
  if (S.session && w.sessions.some(s => s.key === S.session)) return w.sessions.find(s => s.key === S.session);
  return w.sessions.find(s => s.isLive) || w.sessions.filter(s => s.rows?.length).at(-1) || null;
}
const shortName = s => ({ p1: 'FP1', p2: 'FP2', p3: 'FP3', sq: 'Sprint Quali', sprint: 'Sprint', q: 'Qualifying', race: 'Race' }[s.key] || s.name);
function row(r, gapCell, extra = '') {
  return `<tr><td class="p">${esc(r.pos || '–')}</td><td class="bar"><i style="background:${teamColor(r.teamId)}"></i></td>
    <td class="drv"><b>${esc(r.abbr)}</b><small>${esc(r.name)} · ${esc(r.team)}</small></td>${gapCell}<td class="ex">${extra}</td></tr>`;
}
function liveClock(s) {
  if (!s.start || !s.end) return '';
  const pct = Math.min(100, Math.max(0, (Date.now() - s.start) / (s.end - s.start) * 100));
  return `<div class="liveclock"><div class="clock"><span>Running <b data-elapsed="${s.start}">${mins(Date.now() - s.start)}</b></span><span>About <b data-remaining="${s.end}">${mins(s.end - Date.now())}</b> left</span></div>
    <div class="progress"><i data-progress="${s.start}-${s.end}" style="width:${pct.toFixed(1)}%"></i></div></div>`;
}
function renderTiming() {
  const el = $('#live'), w = S.live?.weekend;
  if (!w) { el.innerHTML = `<div class="err">${esc(S.error || 'Loading timing…')}</div>`; return; }
  const ses = pickSession(w);
  $('#liveHead').textContent = w.sessions.some(s => s.isLive) ? 'Live timing' : 'Session results';
  const chips = w.sessions.filter(s => s.rows?.length || s.isLive).map(s =>
    `<button class="chip" data-ses="${s.key}" aria-pressed="${!!ses && s.key === ses.key}">${s.isLive ? '<span class="dot" style="color:var(--live)"></span>' : ''}${esc(shortName(s))}</button>`).join('');

  if (!ses) {
    const last = S.bbc?.lastRace;
    el.innerHTML = `<div class="note">No sessions have run yet this weekend. Times appear here as soon as first practice starts.</div>` +
      (last ? `<div class="note"><b style="color:var(--fg)">Previous round:</b> ${esc(last.name)}, won by ${esc(last.rows[0]?.name)} (${esc(last.rows[0]?.team)}).</div>` : '');
    return;
  }
  const st = sessionState(ses);
  const pill = st === 'live' ? '<span class="pill live"><span class="dot"></span>Live</span>' : st === 'done' ? '<span class="pill done">Final</span>' : '<span class="pill next">Upcoming</span>';
  const type = ses.key === 'q' || ses.key === 'sq' ? 'quali' : ses.key === 'race' || ses.key === 'sprint' ? 'race' : 'practice';
  const rows = ses.rows || [];
  let body;
  if (type === 'practice') {
    const lead = secs(rows[0]?.time);
    body = rows.map((r, i) => {
      const t = secs(r.time);
      const gap = i && t && lead ? '+' + (t - lead).toFixed(3) : '';
      return row(r, `<td class="gap ${i === 0 && r.time ? 'fast' : ''}">${esc(r.time || '—')}<small>${gap}${gap && r.laps ? ' · ' : ''}${r.laps ? esc(r.laps) + ' laps' : ''}</small></td>`);
    }).join('');
  } else if (type === 'quali') {
    body = rows.map(r => {
      const part = r.q3 ? 'Q3' : r.q2 ? 'Q2' : r.q1 ? 'Q1' : '';
      const best = r.q3 || r.q2 || r.q1;
      const earlier = [r.q1 && part !== 'Q1' && 'Q1 ' + r.q1, r.q2 && part === 'Q3' && 'Q2 ' + r.q2].filter(Boolean).join(' · ');
      return row(r, `<td class="gap ${r.pos === '1' && best ? 'fast' : ''}">${esc(best || '—')}<small>${part}${earlier ? ' · ' + esc(earlier) : ''}</small></td>`);
    }).join('');
  } else {
    body = rows.map(r => row(r, `<td class="gap">${esc(r.time || '—')}<small>${r.grid ? 'Grid ' + esc(r.grid) : ''}${r.pits ? ' · ' + esc(r.pits) + ' stop' + (r.pits === '1' ? '' : 's') : ''}${r.fl ? ' · <span style="color:var(--purple)">FL</span>' : ''}</small></td>`,
      r.points && r.points !== '0' ? `<span class="ptsbadge">+${esc(r.points)}</span>` : '')).join('');
  }
  el.innerHTML = `
    ${chips ? `<div class="chips sesschips">${chips}</div>` : ''}
    <div class="livehead">
      <div class="title">${esc(ses.name)}</div>${pill}
      <div class="sub">${esc(w.name)}${ses.start ? ' · ' + fmtDay(ses.start) + ' ' + fmtTime(ses.start) : ''}</div>
    </div>
    ${st === 'live' ? liveClock(ses) : ''}
    ${rows.length ? `<div style="overflow-x:auto"><table class="tower">${body}</table></div>`
      : `<div class="note">${st === 'upcoming' ? 'Times appear here when the session starts.' : 'Waiting for the first times from BBC Sport…'}</div>`}
    <div class="note">${esc(ses.lastUpdated || '')}${ses.lastUpdated ? ' · ' : ''}From <a href="${esc(w.url)}" target="_blank" rel="noopener">BBC Sport</a>${S.live?.at ? ', collected ' + ago(S.live.at) : ''}</div>`;
}
$('#live').addEventListener('click', e => {
  const b = e.target.closest('[data-ses]'); if (!b) return;
  S.session = b.dataset.ses; renderTiming();
});

// ---------- track map replay (OpenF1 data, built after each session by .github/workflows/replay.yml) ----------
const REPLAYS = `https://raw.githubusercontent.com/${REPO}/replays/`;
const M = { index: null, key: store.get('replayKey'), data: null, t: 0, playing: false, speed: 16, sel: null, last: 0, raf: 0 };

function decodeReplay(d) {
  const N = d.seconds;
  d.xy = {};
  for (const [num, runs] of Object.entries(d.pos)) {
    const X = new Float32Array(N).fill(NaN), Y = new Float32Array(N).fill(NaN);
    for (const run of runs) {
      let i = run[0], x = run[1], y = run[2];
      X[i] = x; Y[i] = y;
      for (let k = 3; k < run.length; k += 2) { i++; x += run[k]; y += run[k + 1]; X[i] = x; Y[i] = y; }
    }
    d.xy[num] = [X, Y];
  }
  // Per-driver timelines for the leaderboard
  d.byDriver = {};
  const D = n => (d.byDriver[n] ||= { order: [], laps: [], ints: [] });
  for (const [t, n, p] of d.order) D(n).order.push([t, p]);
  for (const [n, lap, t, dur, out] of d.laps) D(n).laps.push([t, lap, dur, out]);
  for (const [t, n, g, i] of d.ints) D(n).ints.push([t, g, i]);
  for (const v of Object.values(d.byDriver)) v.laps.sort((a, b) => a[0] - b[0]);
  const lap1 = d.laps.filter(l => l[1] === 1).map(l => l[2]);
  d.firstLap = lap1.length ? Math.min(...lap1) : 0;
  d.totalLaps = Math.max(0, ...d.laps.map(l => l[1]));
  // Map bounds from the track outline plus every recorded point
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const add = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const [x, y] of d.track) add(x, y);
  if (!d.track.length) for (const [X, Y] of Object.values(d.xy)) for (let i = 0; i < N; i += 10) if (!isNaN(X[i])) add(X[i], Y[i]);
  d.bounds = { minX, maxX, minY, maxY };
  return d;
}
// latest entry at or before t in a [t, ...] array sorted by time
function at(arr, t) {
  let lo = 0, hi = arr.length - 1, r = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] <= t) { r = arr[m]; lo = m + 1; } else hi = m - 1; }
  return r;
}

async function loadReplays() {
  const idx = await getJSON(REPLAYS + 'index.json?t=' + Math.floor(Date.now() / 120e3));
  M.index = idx.replays || [];
  if (!M.index.length) { renderMapHead(); return; }
  const want = M.index.find(r => r.key === M.key) ? M.key : M.index[0].key;
  if (!M.data || M.data.session.key !== want) await openReplay(want);
  else renderMapHead();
}
async function openReplay(key) {
  M.key = key; store.set('replayKey', key);
  pauseMap();
  $('#mapHead').innerHTML = '<div class="note">Loading replay…</div>';
  try {
    M.data = decodeReplay(await getJSON(REPLAYS + `replay-${key}.json`, { timeout: 60000 }));
  } catch {
    $('#mapHead').innerHTML = '<div class="err">Could not load this replay. Tap refresh to try again.</div>';
    return;
  }
  const d = M.data;
  M.t = Math.max(0, d.firstLap - 15);
  $('#mapSeek').max = d.seconds - 1;
  $('#mapCtl').hidden = false;
  M.sel = null;
  renderMapHead(); sizeMap(); drawMap();
}

function renderMapHead() {
  const chipsEl = $('#mapChips'), head = $('#mapHead');
  const list = M.index || [];
  const cur = list.find(r => r.key === M.key) || list[0];
  // Sessions from the same weekend as the one showing
  const same = cur ? list.filter(r => r.meeting === cur.meeting).sort((a, b) => a.start - b.start) : [];
  chipsEl.innerHTML = same.map(r => `<button class="chip" data-replay="${r.key}" aria-pressed="${r.key === M.key}">${esc(replayShort(r.name))}</button>`).join('') +
    (list.some(r => r.meeting !== cur?.meeting) ? `<button class="chip" data-replay-older="1">Earlier</button>` : '');
  const liveNow = S.live?.weekend?.sessions.find(s => s.isLive);
  const liveNote = liveNow ? `<div class="live">${esc(liveNow.name)} is live now. Car positions are released for free when it ends, and its replay appears here a few minutes later. Live order is in the timing table below.</div>` : '';
  if (!cur) { head.innerHTML = liveNote + '<div class="note">Replays appear here a few minutes after each session ends.</div>'; return; }
  head.innerHTML = `${liveNote}<div class="t">${esc(cur.meeting)} · ${esc(cur.name)}</div><div class="s">Replay · ${fmtDay(cur.start)} · tap a driver to follow them</div>`;
}
const replayShort = n => ({ 'Practice 1': 'FP1', 'Practice 2': 'FP2', 'Practice 3': 'FP3', 'Sprint Qualifying': 'Sprint Quali', 'Sprint Shootout': 'Sprint Quali' }[n] || n);
$('#mapChips').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.replay) openReplay(+b.dataset.replay);
  else if (b.dataset.replayOlder) {
    const cur = M.index.find(r => r.key === M.key);
    const older = M.index.find(r => r.meeting !== cur?.meeting && r.start < (cur?.start ?? Infinity)) || M.index.find(r => r.meeting !== cur?.meeting);
    if (older) openReplay(older.key);
  }
});

// Canvas
const cv = $('#mapCanvas'), cx = cv.getContext('2d');
let view = null;
function sizeMap() {
  const d = M.data; if (!d) return;
  const w = cv.parentNode.clientWidth - 20;
  const b = d.bounds, bw = b.maxX - b.minX || 1, bh = b.maxY - b.minY || 1;
  const h = Math.min(Math.max(w * bh / bw, w * 0.55), w * 1.1);
  const dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px';
  const pad = 18, sc = Math.min((w - pad * 2) / bw, (h - pad * 2) / bh);
  view = { dpr, sc, ox: (w - bw * sc) / 2 - b.minX * sc, oy: (h - bh * sc) / 2 + b.maxY * sc, w, h };
}
const px = x => view.ox + x * view.sc;
const py = y => view.oy - y * view.sc;          // flip: OpenF1 y grows upwards
function css(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function drawMap() {
  const d = M.data; if (!d || !view) return;
  const { dpr, w, h } = view;
  cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  cx.clearRect(0, 0, w, h);
  // track
  if (d.track.length) {
    cx.lineJoin = cx.lineCap = 'round';
    cx.beginPath(); d.track.forEach(([x, y], i) => i ? cx.lineTo(px(x), py(y)) : cx.moveTo(px(x), py(y))); cx.closePath();
    cx.strokeStyle = css('--line'); cx.lineWidth = 9; cx.stroke();
    cx.strokeStyle = css('--raised'); cx.lineWidth = 5; cx.stroke();
    const [sx, sy] = d.track[0];
    cx.fillStyle = css('--fg'); cx.fillRect(px(sx) - 2, py(sy) - 7, 4, 14);
  }
  // cars, interpolated between whole seconds
  const i0 = Math.floor(M.t), f = M.t - i0;
  const order = boardAt(M.t);
  const drawn = [];
  for (const r of [...order].reverse()) {           // leader drawn last, on top
    const xy = d.xy[r.num]; if (!xy) continue;
    const [X, Y] = xy;
    let x = X[i0], y = Y[i0];
    if (isNaN(x)) continue;
    if (i0 + 1 < d.seconds && !isNaN(X[i0 + 1])) { x += (X[i0 + 1] - x) * f; y += (Y[i0 + 1] - y) * f; }
    drawn.push({ r, x: px(x), y: py(y) });
  }
  const fg = css('--fg'), bg = css('--surface');
  for (const { r, x, y } of drawn) {
    const sel = M.sel === r.num;
    cx.beginPath(); cx.arc(x, y, sel ? 8 : 5.5, 0, Math.PI * 2);
    cx.fillStyle = r.color; cx.fill();
    cx.lineWidth = sel ? 2.5 : 1.5; cx.strokeStyle = sel ? fg : bg; cx.stroke();
    if (sel || r.pos <= 3 || drawn.length <= 6) {
      cx.font = `700 ${sel ? 13 : 11}px "Barlow Condensed", Arial, sans-serif`;
      cx.lineWidth = 3; cx.strokeStyle = bg; cx.strokeText(r.abbr, x + 8, y - 6);
      cx.fillStyle = fg; cx.fillText(r.abbr, x + 8, y - 6);
    }
  }
  renderBoard(order);
}

function boardAt(t) {
  const d = M.data, isRace = /race/i.test(d.session.type);
  const rows = d.drivers.map(dr => {
    const b = d.byDriver[dr.num] || { order: [], laps: [], ints: [] };
    const p = at(b.order, t);
    const lap = at(b.laps, t);
    let best = null, lastDone = null;
    for (const l of b.laps) { if (l[2] && l[0] + l[2] <= t) { lastDone = l; if (!l[3] && (best == null || l[2] < best)) best = l[2]; } }
    const iv = isRace ? at(b.ints, t) : null;
    return { num: dr.num, abbr: dr.abbr, color: dr.color || teamColor(dr.team?.toLowerCase().replace(/\s+/g, '-')), pos: p ? p[1] : 99, lap: lap ? lap[1] : 0, best, last: lastDone?.[2] ?? null, gap: iv?.[1], int: iv?.[2] };
  });
  rows.sort((a, b) => a.pos - b.pos);
  return rows;
}
const fmtLapS = s => s == null ? '' : (s >= 60 ? Math.floor(s / 60) + ':' + (s % 60).toFixed(3).padStart(6, '0') : s.toFixed(3));
let boardKey = '';
function renderBoard(rows) {
  const d = M.data, isRace = /race/i.test(d.session.type);
  const fastest = Math.min(...rows.map(r => r.best ?? Infinity));
  const html = rows.map((r, i) => {
    let g;
    if (isRace) g = i === 0 ? (r.lap ? 'Lap ' + r.lap : '') : r.gap == null ? '' : typeof r.gap === 'number' ? '+' + r.gap.toFixed(1) : esc(r.gap);
    else g = r.best ? `<span style="${r.best === fastest ? 'color:var(--purple)' : ''}">${fmtLapS(r.best)}</span>` : '';
    return `<button class="mb ${M.sel === r.num ? 'sel' : ''}" data-num="${r.num}"><span class="p">${r.pos === 99 ? '–' : r.pos}</span><span class="c" style="background:${r.color}"></span><b>${esc(r.abbr)}</b><span class="g">${g}</span></button>`;
  }).join('');
  if (html !== boardKey) { $('#mapBoard').innerHTML = html; boardKey = html; }
  // time + flag
  const t = M.t, el = Math.max(0, t - d.firstLap);
  const lead = rows[0];
  const hh = n => String(Math.floor(n)).padStart(2, '0');
  $('#mapTime').innerHTML = `<span>${isRace && lead?.lap ? `Lap ${lead.lap}${d.totalLaps ? ' of ' + d.totalLaps : ''}` : 'Session time'} · ${hh(el / 3600)}:${hh(el % 3600 / 60)}:${hh(el % 60)}</span><span>${fmtTime(d.t0 + t * 1000)} local</span>`;
  $('#mapSeek').value = Math.floor(t);
  const flag = flagAt(t);
  const fe = $('#mapFlag');
  fe.hidden = !flag; if (flag) { fe.className = 'mapflag ' + flag.cls; fe.textContent = flag.text; }
}
function flagAt(t) {
  let s = null;
  for (const [mt, cat, flag, msg, , scope] of M.data.rc) {
    if (mt > t) break;
    const m = (msg || '').toUpperCase();
    if (cat === 'SafetyCar') {
      if (m.includes('VIRTUAL SAFETY CAR DEPLOYED')) s = { cls: 'vsc', text: 'Virtual Safety Car' };
      else if (m.includes('SAFETY CAR DEPLOYED')) s = { cls: 'sc', text: 'Safety Car' };
    } else if (cat === 'Flag' && (scope === 'Track' || !scope)) {
      if (flag === 'RED') s = { cls: 'red', text: 'Red flag' };
      else if (flag === 'GREEN' || flag === 'CLEAR') s = null;
      else if (flag === 'CHEQUERED') s = { cls: 'chequered', text: 'Chequered flag' };
    }
  }
  return s;
}

// Playback
function tick(now) {
  if (!M.playing) return;
  const dt = M.last ? (now - M.last) / 1000 : 0;
  M.last = now;
  M.t = Math.min(M.data.seconds - 1.001, M.t + dt * M.speed);
  drawMap();
  if (M.t >= M.data.seconds - 1.001) { pauseMap(); return; }
  M.raf = requestAnimationFrame(tick);
}
function playMap() { if (!M.data) return; M.playing = true; M.last = 0; $('#mapPlay').classList.add('playing'); $('#mapPlay').setAttribute('aria-label', 'Pause'); M.raf = requestAnimationFrame(tick); }
function pauseMap() { M.playing = false; cancelAnimationFrame(M.raf); $('#mapPlay').classList.remove('playing'); $('#mapPlay').setAttribute('aria-label', 'Play'); }
$('#mapPlay').addEventListener('click', () => M.playing ? pauseMap() : playMap());
$('#mapSpeed').addEventListener('change', e => { M.speed = +e.target.value; });
$('#mapSeek').addEventListener('input', e => { M.t = +e.target.value; drawMap(); });
$('#mapBoard').addEventListener('click', e => {
  const b = e.target.closest('[data-num]'); if (!b) return;
  M.sel = M.sel === +b.dataset.num ? null : +b.dataset.num; boardKey = ''; drawMap();
});
window.addEventListener('resize', () => { sizeMap(); drawMap(); });
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', drawMap);

// ---------- BBC live commentary ----------
function renderCommentary() {
  const el = $('#rc'), c = S.live?.commentary;
  const fresh = c && (c.live || (c.updated && Date.now() - c.updated < 18 * 3600e3));
  $('#rcHead').textContent = c?.live ? 'BBC live commentary' : 'Latest BBC commentary';
  if (!fresh) {
    el.innerHTML = `<div class="note">BBC Sport's live text commentary appears here during each session.</div>`;
    return;
  }
  el.innerHTML = `
    <div class="comhead">
      <div class="row">${c.live ? '<span class="pill live"><span class="dot"></span>Live</span>' : '<span class="pill done">Ended</span>'}<b>${esc(c.title)}</b></div>
      ${c.summary?.length ? `<ul>${c.summary.map(t => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    </div>
    ${c.posts.map(p => `
      <article class="post">
        <time>${p.time ? fmtTime(p.time) : ''}</time>
        <div>
          ${p.title ? `<h3>${esc(p.title)}</h3>` : ''}
          ${p.text.map(t => `<p>${esc(t)}</p>`).join('')}
          ${p.img ? `<img src="${esc(p.img.src)}" alt="${esc(p.img.alt)}" loading="lazy" onerror="this.remove()">` : ''}
        </div>
      </article>`).join('')}
    <div class="note"><a href="${esc(c.url)}" target="_blank" rel="noopener">Open the full commentary on BBC Sport</a></div>`;
}

// ---------- standings ----------
function renderStandings() {
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.st === S.standTab));
  const el = $('#stand'), st = S.bbc?.standings;
  const plural = (n, w) => `${esc(n)} ${w}${n === '1' ? '' : 's'}`;
  const line = (pos, color, name, sub, pts, pct) => `<div class="st"><span class="p">${esc(pos)}</span><span class="c" style="background:${color}"></span>
    <div class="nm"><b>${esc(name)}</b><small>${sub}</small>${pct != null ? `<div class="meter"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>` : ''}</div>
    <span class="pts">${pts}</span></div>`;
  if (S.standTab !== 'last') {
    if (!st) return;
    const drivers = S.standTab === 'drivers';
    const list = drivers ? st.drivers : st.teams;
    const top = +list[0]?.points || 1;
    el.innerHTML = list.map(x => line(x.pos, teamColor(x.teamId), x.name,
      `${drivers ? esc(x.team) + ' · ' : ''}${plural(x.wins, 'win')} · ${plural(x.podiums, 'podium')}`,
      `${esc(x.points)}<small>PTS</small>`, +x.points / top * 100)).join('') +
      `<div class="note">${esc(st.updated)} · BBC Sport</div>`;
  } else {
    const r = S.bbc?.lastRace;
    if (!r) { el.innerHTML = '<div class="note">No race results yet.</div>'; return; }
    el.innerHTML = `<div class="note"><b style="color:var(--fg)">${esc(r.name)}</b> · ${esc(r.circuit)}${r.date ? ' · ' + fmtShort(r.date) : ''}</div>` +
      r.rows.map(x => line(x.pos || '–', teamColor(x.teamId), x.name,
        `${esc(x.team)}${x.time ? ' · ' + esc(x.time) : ''}${x.grid ? ' · Grid ' + esc(x.grid) : ''}${x.fl ? ' · <span style="color:var(--purple)">Fastest lap</span>' : ''}`,
        x.points && x.points !== '0' ? `+${esc(x.points)}<small>PTS</small>` : '', null)).join('') +
      `<div class="note"><a href="${esc(r.url)}" target="_blank" rel="noopener">Full results on BBC Sport</a></div>`;
  }
}

// ---------- calendar ----------
function renderCalendar() {
  const el = $('#cal'), cal = S.bbc?.calendar;
  if (!cal?.length) return;
  const current = cal.find(e => !e.cancelled && !e.test && e.status !== 'PostEvent');
  let n = 0;
  el.innerHTML = cal.map(e => {
    const counted = !e.cancelled && !e.test;
    if (counted) n++;
    const right = e.cancelled ? '<div class="w muted">Cancelled</div>' : e.test ? '<div class="w muted">Testing</div>'
      : e.winner ? `<div class="w"><b style="color:${teamColor(e.winner.teamId)}">${esc(e.winner.abbr)}</b><small>Winner</small></div>`
      : `<div class="w mono">${fmtShort(e.start)}–${fmtShort(e.end)}</div>`;
    return `<div class="rnd ${e.status === 'PostEvent' || e.cancelled ? 'past' : ''} ${e === current ? 'cur' : ''}">
      <span class="r">${counted ? 'R' + n : ''}</span>
      <div style="min-width:0"><b>${esc(e.name.replace(' Grand Prix', ' GP'))}</b><small>${esc(e.venue)}</small></div>${right}</div>`;
  }).join('') + `<div class="note">Calendar from BBC Sport</div>`;
}

// ---------- news ----------
function renderNews() {
  const items = S.bbc?.news;
  if (!items) return;
  $('#news').innerHTML = `<div class="newsAge">BBC Sport · ${items.length} stories · collected ${ago(S.bbc.at)}</div>` + (items.length ? items.map(i => `
    <a class="card story ${i.img ? '' : 'noimg'}" href="${esc(i.link)}" target="_blank" rel="noopener">
      <div style="min-width:0"><h3>${esc(i.title)}</h3>${i.desc ? `<p>${esc(i.desc)}</p>` : ''}
        <div class="meta"><span>${i.date ? ago(i.date) : ''}</span></div></div>
      ${i.img ? `<img src="${esc(i.img)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg');this.remove()">` : ''}
    </a>`).join('') : '<div class="note">No stories right now.</div>');
}

// ---------- refresh ----------
function stamp(ok) {
  $('#updated').textContent = ok ? 'Updated ' + fmtTime(Date.now()) : navigator.onLine ? 'Could not reach data' : 'Offline';
}
let lastFull = 0;
async function refreshAll() {
  const btn = $('#refresh'); btn.classList.add('spin');
  const res = await Promise.allSettled([loadBBC(), loadLive(), loadReplays()]);
  btn.classList.remove('spin');
  lastFull = Date.now();
  S.error = res.every(r => r.status === 'rejected') ? 'Could not load data from BBC Sport. Tap refresh to try again.' : null;
  if (S.error && !S.live) renderTiming();
  stamp(!S.error);
}
$('#refresh').addEventListener('click', refreshAll);

// Poll often while a session is live or about to start, slowly otherwise
const isHot = () => {
  const w = S.live?.weekend, now = Date.now();
  return !!w && w.sessions.some(s => s.isLive || (s.start && now > s.start - 15 * 60e3 && now < s.end + 20 * 60e3));
};
let timer;
function schedule() {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (document.visibilityState === 'visible') {
      try { await loadLive(); stamp(true); } catch { stamp(false); }
      if (Date.now() - lastFull > 10 * 60e3) refreshAll();
    }
    schedule();
  }, isHot() ? 45e3 : 3 * 60e3);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastFull > 60e3) refreshAll();
});
setInterval(() => {
  const n = Date.now();
  document.querySelectorAll('[data-elapsed]').forEach(el => el.textContent = mins(n - el.dataset.elapsed));
  document.querySelectorAll('[data-remaining]').forEach(el => el.textContent = mins(el.dataset.remaining - n));
  document.querySelectorAll('[data-progress]').forEach(el => { const [a, b] = el.dataset.progress.split('-').map(Number); el.style.width = Math.min(100, (n - a) / (b - a) * 100).toFixed(1) + '%'; });
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const ms = +el.dataset.countdown - n;
    if (ms <= 0) renderWeekend(); else el.textContent = countdown(ms);
  });
}, 1000);

// ---------- boot ----------
setTab(S.tab);
renderWeekend(); renderTiming(); renderCommentary(); renderStandings(); renderCalendar(); renderNews();
refreshAll().then(schedule);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
