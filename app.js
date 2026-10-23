'use strict';

// Data sources (all free, no key, callable from the browser)
const ERGAST = 'https://api.jolpi.ca/ergast/f1';   // schedule, results, standings
const OPENF1 = 'https://api.openf1.org/v1';        // timing, race control, weather
const RSS2JSON = 'https://api.rss2json.com/v1/api.json?rss_url=';
const ALLORIGINS = 'https://api.allorigins.win/raw?url=';

const FEEDS = [
  { id: 'f1', name: 'Formula1.com', url: 'https://www.formula1.com/en/latest/all.xml' },
  { id: 'motorsport', name: 'Motorsport.com', url: 'https://www.motorsport.com/rss/f1/news/' },
  { id: 'autosport', name: 'Autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { id: 'bbc', name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
  { id: 'therace', name: 'The Race', url: 'https://www.the-race.com/formula-1/feed/' },
];

const TEAM_COLORS = {
  red_bull: '#3671C6', ferrari: '#E8002D', mercedes: '#27F4D2', mclaren: '#FF8000',
  aston_martin: '#229971', alpine: '#FF87BC', williams: '#64C4FF', rb: '#6692FF',
  haas: '#B6BABD', sauber: '#52E252', audi: '#BB0A30', cadillac: '#C8A45C',
};
const teamColor = id => TEAM_COLORS[id] || '#8b95a7';

const SESSION_LABELS = {
  FirstPractice: 'Practice 1', SecondPractice: 'Practice 2', ThirdPractice: 'Practice 3',
  SprintQualifying: 'Sprint Qualifying', SprintShootout: 'Sprint Shootout',
  Sprint: 'Sprint', Qualifying: 'Qualifying', Race: 'Grand Prix',
};
const SESSION_LENGTH_MIN = { FirstPractice: 60, SecondPractice: 60, ThirdPractice: 60, SprintQualifying: 45, SprintShootout: 45, Sprint: 60, Qualifying: 60, Race: 120 };

// ---------- helpers ----------
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return JSON.parse(localStorage.getItem('pw:' + k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem('pw:' + k, JSON.stringify(v)); } catch {} },
};

async function getJSON(url, { timeout = 15000 } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.status = r.status; throw e; }
    return await r.json();
  } finally { clearTimeout(t); }
}

const fmtTime = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const fmtDay = d => d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShortDate = d => d.toLocaleDateString([], { day: 'numeric', month: 'short' });
function fmtLap(sec) {
  if (sec == null || isNaN(sec)) return '—';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  return (m ? m + ':' + s.toFixed(3).padStart(6, '0') : s.toFixed(3));
}
function ago(d) {
  const s = Math.round((Date.now() - d) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}
function countdown(ms) {
  if (ms <= 0) return '00:00:00';
  const s = Math.floor(ms / 1000), d = Math.floor(s / 86400);
  const hh = String(Math.floor(s % 86400 / 3600)).padStart(2, '0');
  const mm = String(Math.floor(s % 3600 / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return (d ? d + 'd ' : '') + `${hh}:${mm}:${ss}`;
}
const toDate = (date, time) => new Date(date + 'T' + (time || '12:00:00Z'));

// ---------- state ----------
const S = {
  tab: store.get('tab') || 'live',
  standTab: store.get('standTab') || 'drivers',
  newsSource: store.get('newsSource') || 'all',
  races: store.get('races') || null,
  winners: store.get('winners') || {},
  drivers: store.get('drivers') || null,
  teams: store.get('teams') || null,
  last: store.get('last') || null,
  news: store.get('news') || null,
  live: null,        // OpenF1 session state
  liveError: null,
  updatedAt: null,
};

// ---------- tabs ----------
function setTab(t) {
  S.tab = t; store.set('tab', t);
  document.querySelectorAll('nav.tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => v.hidden = v.dataset.view !== t);
  document.getElementById('scroller').scrollTop = 0;
  if (t === 'news' && (!S.news || Date.now() - S.news.at > 10 * 60e3)) loadNews();
}
document.querySelectorAll('nav.tabs button').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));
document.querySelectorAll('.seg button').forEach(b => b.addEventListener('click', () => {
  S.standTab = b.dataset.st; store.set('standTab', S.standTab); renderStandings();
}));

// ---------- schedule / weekend ----------
function raceSessions(race) {
  const out = [];
  for (const key of ['FirstPractice', 'SecondPractice', 'ThirdPractice', 'SprintQualifying', 'SprintShootout', 'Sprint', 'Qualifying']) {
    if (race[key]) out.push({ key, name: SESSION_LABELS[key], start: toDate(race[key].date, race[key].time) });
  }
  out.push({ key: 'Race', name: SESSION_LABELS.Race, start: toDate(race.date, race.time) });
  out.sort((a, b) => a.start - b.start);
  out.forEach(s => s.end = new Date(+s.start + SESSION_LENGTH_MIN[s.key] * 60e3));
  return out;
}
function currentRace() {
  if (!S.races) return null;
  const now = Date.now();
  return S.races.find(r => +toDate(r.date, r.time) + 4 * 3600e3 > now) || S.races[S.races.length - 1];
}

async function loadSchedule() {
  const [sched, wins] = await Promise.all([
    getJSON(`${ERGAST}/current.json?limit=100`),
    getJSON(`${ERGAST}/current/results/1.json?limit=100`).catch(() => null),
  ]);
  S.races = sched.MRData.RaceTable.Races;
  store.set('races', S.races);
  if (wins) {
    S.winners = {};
    for (const r of wins.MRData.RaceTable.Races) {
      const w = r.Results[0];
      S.winners[r.round] = { name: w.Driver.familyName, code: w.Driver.code, team: w.Constructor.constructorId };
    }
    store.set('winners', S.winners);
  }
  renderWeekend(); renderCalendar();
}

function renderWeekend() {
  const el = $('#weekend');
  const race = currentRace();
  if (!race) return;
  const sessions = raceSessions(race);
  const now = Date.now();
  const live = sessions.find(s => now >= s.start && now <= s.end);
  const next = sessions.find(s => s.start > now);
  const loc = race.Circuit.Location;
  const isThisWeek = sessions[0].start - now < 5 * 86400e3;

  let cd = '';
  if (live) cd = `<div class="countdown"><span class="pill live"><span class="dot"></span>Live now</span><span class="t">${esc(live.name)}</span></div>`;
  else if (next) cd = `<div class="countdown"><span class="lbl">${esc(next.name)} starts in</span><span class="t" data-countdown="${+next.start}">${countdown(next.start - now)}</span></div>`;
  else cd = `<div class="countdown"><span class="lbl">Weekend complete</span></div>`;

  el.innerHTML = `
    <div>
      <div class="eyebrow">Round ${esc(race.round)} of ${S.races.length} · ${isThisWeek ? 'This weekend' : 'Next up'}</div>
      <h1>${esc(race.raceName)}</h1>
      <div class="where">${esc(race.Circuit.circuitName)} · ${esc(loc.locality)}, ${esc(loc.country)}</div>
    </div>
    ${cd}
    <div class="sessions">
      ${sessions.map(s => {
        const st = (now >= s.start && now <= s.end) ? 'live' : s === next ? 'next' : s.end < now ? 'done' : '';
        const label = st === 'live' ? '<span class="dot"></span>Live' : st === 'next' ? 'Next' : st === 'done' ? 'Done' : '';
        return `<div class="srow"><span class="n">${esc(s.name)}</span><span class="d">${fmtDay(s.start)} · ${fmtTime(s.start)}</span>${label ? `<span class="pill ${st}">${label}</span>` : '<span></span>'}</div>`;
      }).join('')}
    </div>
    <div class="muted" style="font-size:12px">Times shown in your local time zone.</div>`;
  $('#liveDot').hidden = !live && !(S.live && S.live.status === 'live');
}

function renderCalendar() {
  const el = $('#cal');
  if (!S.races) return;
  const cur = currentRace();
  const now = Date.now();
  el.innerHTML = S.races.map(r => {
    const d = toDate(r.date, r.time);
    const start = new Date(+d - 2 * 86400e3);
    const past = +d + 4 * 3600e3 < now;
    const w = S.winners[r.round];
    const right = w
      ? `<div class="w"><b style="color:${teamColor(w.team)}">${esc(w.code || w.name)}</b><small>Winner</small></div>`
      : `<div class="w mono">${fmtShortDate(start)}–${fmtShortDate(d)}</div>`;
    return `<div class="rnd ${past ? 'past' : ''} ${r === cur ? 'cur' : ''}">
      <span class="r">R${esc(r.round)}</span>
      <div style="min-width:0"><b>${esc(r.raceName.replace(' Grand Prix', ' GP'))}${r.Sprint ? '<span class="sprint">SPRINT</span>' : ''}</b><small>${esc(r.Circuit.Location.locality)}, ${esc(r.Circuit.Location.country)}</small></div>
      ${right}</div>`;
  }).join('');
}

// ---------- standings ----------
async function loadStandings() {
  const [d, t, l] = await Promise.all([
    getJSON(`${ERGAST}/current/driverStandings.json`),
    getJSON(`${ERGAST}/current/constructorStandings.json`),
    getJSON(`${ERGAST}/current/last/results.json`),
  ]);
  S.drivers = d.MRData.StandingsTable.StandingsLists[0]?.DriverStandings || [];
  S.teams = t.MRData.StandingsTable.StandingsLists[0]?.ConstructorStandings || [];
  S.last = l.MRData.RaceTable.Races[0] || null;
  store.set('drivers', S.drivers); store.set('teams', S.teams); store.set('last', S.last);
  renderStandings();
}

function renderStandings() {
  document.querySelectorAll('.seg button').forEach(b => b.setAttribute('aria-pressed', b.dataset.st === S.standTab));
  const el = $('#stand');
  if (S.standTab === 'drivers') {
    if (!S.drivers) return;
    const top = +S.drivers[0]?.points || 1;
    el.innerHTML = S.drivers.map(x => {
      const c = teamColor(x.Constructors.at(-1)?.constructorId);
      return `<div class="st"><span class="p">${esc(x.positionText)}</span><span class="c" style="background:${c}"></span>
        <div class="nm"><b>${esc(x.Driver.givenName)} ${esc(x.Driver.familyName)}</b><small>${esc(x.Constructors.at(-1)?.name)} · ${esc(x.wins)} win${x.wins === '1' ? '' : 's'}</small>
        <div class="meter"><i style="width:${(+x.points / top * 100).toFixed(1)}%;background:${c}"></i></div></div>
        <span class="pts">${esc(x.points)}<small>PTS</small></span></div>`;
    }).join('') || '<div class="note">No standings yet this season.</div>';
  } else if (S.standTab === 'teams') {
    if (!S.teams) return;
    const top = +S.teams[0]?.points || 1;
    el.innerHTML = S.teams.map(x => {
      const c = teamColor(x.Constructor.constructorId);
      return `<div class="st"><span class="p">${esc(x.positionText)}</span><span class="c" style="background:${c}"></span>
        <div class="nm"><b>${esc(x.Constructor.name)}</b><small>${esc(x.wins)} win${x.wins === '1' ? '' : 's'}</small>
        <div class="meter"><i style="width:${(+x.points / top * 100).toFixed(1)}%;background:${c}"></i></div></div>
        <span class="pts">${esc(x.points)}<small>PTS</small></span></div>`;
    }).join('') || '<div class="note">No standings yet this season.</div>';
  } else {
    const r = S.last;
    if (!r) { el.innerHTML = '<div class="note">No race results yet.</div>'; return; }
    el.innerHTML = `<div class="note"><b style="color:var(--fg)">${esc(r.raceName)}</b> · Round ${esc(r.round)} · ${fmtShortDate(toDate(r.date, r.time))}</div>` +
      r.Results.map(x => {
        const c = teamColor(x.Constructor.constructorId);
        const fl = x.FastestLap?.rank === '1' ? ' · <span style="color:var(--purple)">Fastest lap</span>' : '';
        const res = x.Time?.time || x.status;
        return `<div class="st"><span class="p">${esc(x.positionText)}</span><span class="c" style="background:${c}"></span>
          <div class="nm"><b>${esc(x.Driver.givenName)} ${esc(x.Driver.familyName)}</b><small>${esc(x.Constructor.name)} · ${esc(res)}${fl}</small></div>
          <span class="pts">${x.points === '0' ? '' : '+' + esc(x.points)}<small>${x.points === '0' ? '' : 'PTS'}</small></span></div>`;
      }).join('');
  }
}

// ---------- live timing (OpenF1) ----------
function newLiveState(session) {
  return { session, key: session.session_key, drivers: {}, pos: {}, ints: {}, laps: {}, stints: {}, rc: [], wx: null,
           lastPos: null, lastInt: null, lastRc: null, lastWx: null, maxLap: 0, status: 'upcoming' };
}
const maxDate = (rows, cur) => rows.reduce((m, r) => (r.date > m ? r.date : m), cur || '');
const since = (field, d) => d ? `&${field}>${encodeURIComponent(d)}` : '';

// OpenF1 free tier allows ~3 requests/second, so calls go out one at a time with a gap,
// and a "too many requests" answer is retried after a pause.
let of1Chain = Promise.resolve();
const sleep = ms => new Promise(r => setTimeout(r, ms));
function of1(path) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      try { const j = await getJSON(OPENF1 + path); await sleep(400); return j; }
      catch (e) {
        if (e.status === 404) { await sleep(400); return []; }   // OpenF1 answers 404 when there are no rows
        if (e.status !== 429 || attempt >= 3) { await sleep(400); throw e; }
        await sleep(1500 * (attempt + 1));
      }
    }
  };
  const p = of1Chain.then(run, run);
  of1Chain = p.catch(() => {});
  return p;
}
const LOCKED_MSG = 'The free live timing feed is locked while a session is running. Positions appear here a few minutes after the chequered flag.';

let liveLoading = false;
async function loadLive() {
  if (liveLoading) return; liveLoading = true;
  try { await loadLiveInner(); } finally { liveLoading = false; }
}
async function loadLiveInner() {
  let session;
  try {
    [session] = await of1(`/sessions?session_key=latest`);
  } catch (e) {
    S.liveError = e.status === 401 || e.status === 403 ? LOCKED_MSG : 'Live timing is unavailable right now. Tap refresh in a moment.';
    renderLive(); return;
  }
  if (!session) return;
  if (!S.live || S.live.key !== session.session_key) {
    S.live = newLiveState(session);
    const [meeting] = await of1(`/meetings?meeting_key=${session.meeting_key}`).catch(() => []);
    S.live.meeting = meeting;
  }
  const L = S.live, k = L.key;
  L.session = session;
  const now = Date.now(), start = Date.parse(session.date_start), end = Date.parse(session.date_end);
  L.status = now < start ? 'upcoming' : now <= end + 10 * 60e3 ? 'live' : 'finished';
  if (L.status === 'upcoming' || L.complete) { renderLive(); renderWeekend(); return; }

  const isRace = /race/i.test(session.session_type);
  const step = async (fn) => { try { await fn(); return true; } catch (e) { if (e.status === 401 || e.status === 403) throw e; return false; } };
  let ok = true;
  try {
    if (!Object.keys(L.drivers).length) ok &= await step(async () => { for (const d of await of1(`/drivers?session_key=${k}`)) L.drivers[d.driver_number] = d; });

    if (L.status === 'finished') {
      // Final classification in one small request
      ok &= await step(async () => {
        const res = await of1(`/session_result?session_key=${k}`);
        if (res.length) { L.result = {}; for (const r of res) { L.result[r.driver_number] = r; if (r.position) L.pos[r.driver_number] = r.position; } }
      });
    }
    if (!L.result) {
      ok &= await step(async () => {
        const pos = await of1(`/position?session_key=${k}${since('date', L.lastPos)}`);
        for (const p of pos) L.pos[p.driver_number] = p.position;
        L.lastPos = maxDate(pos, L.lastPos);
      });
      if (isRace && L.status === 'live') ok &= await step(async () => {
        // Only recent intervals: the full history of a race is several megabytes
        const from = L.lastInt || new Date(Date.now() - 90e3).toISOString();
        const ints = await of1(`/intervals?session_key=${k}${since('date', from)}`);
        for (const i of ints) L.ints[i.driver_number] = i;
        L.lastInt = maxDate(ints, from);
      });
    }
    ok &= await step(async () => {
      const lapFrom = Math.max(1, L.maxLap - 1);
      const laps = await of1(`/laps?session_key=${k}${L.maxLap ? '&lap_number>=' + lapFrom : ''}`);
      for (const l of laps) { (L.laps[l.driver_number] ||= {})[l.lap_number] = l; if (l.lap_number > L.maxLap) L.maxLap = l.lap_number; }
    });
    ok &= await step(async () => {
      for (const s of await of1(`/stints?session_key=${k}`)) { const cur = L.stints[s.driver_number]; if (!cur || s.stint_number >= cur.stint_number) L.stints[s.driver_number] = s; }
    });
    ok &= await step(async () => {
      const rc = await of1(`/race_control?session_key=${k}${since('date', L.lastRc)}`);
      if (rc.length) { L.rc.push(...rc); L.lastRc = maxDate(rc, L.lastRc); }
    });
    ok &= await step(async () => {
      const wx = await of1(`/weather?session_key=${k}${since('date', L.lastWx)}`);
      if (wx.length) { L.wx = wx[wx.length - 1]; L.lastWx = maxDate(wx, L.lastWx); }
    });
    S.liveError = ok ? null : 'Some timing data could not be updated. Retrying shortly.';
    if (ok && L.status === 'finished') L.complete = true;   // final data loaded, no need to fetch it again
  } catch (e) {
    S.liveError = LOCKED_MSG;
  }
  renderLive(); renderWeekend();
}

function trackStatus(rc) {
  let s = { cls: 'green', text: 'Track clear' };
  for (const m of rc) {
    const msg = (m.message || '').toUpperCase();
    if (m.category === 'SafetyCar') {
      if (msg.includes('VIRTUAL SAFETY CAR DEPLOYED')) s = { cls: 'vsc', text: 'Virtual Safety Car' };
      else if (msg.includes('SAFETY CAR DEPLOYED')) s = { cls: 'sc', text: 'Safety Car' };
    } else if (m.category === 'Flag' && (m.scope === 'Track' || !m.scope)) {
      if (m.flag === 'RED') s = { cls: 'red', text: 'Red flag' };
      else if (m.flag === 'GREEN' || m.flag === 'CLEAR') s = { cls: 'green', text: 'Green flag' };
      else if (m.flag === 'CHEQUERED') s = { cls: 'chequered', text: 'Chequered flag' };
    }
  }
  return s;
}

function renderLive() {
  const el = $('#live'), rcEl = $('#rc');
  const L = S.live;
  if (!L) {
    el.innerHTML = `<div class="err">${esc(S.liveError || 'Loading live timing…')}</div>`;
    return;
  }
  const ses = L.session, isRace = /race/i.test(ses.session_type);
  const start = new Date(ses.date_start);
  const meetingName = L.meeting?.meeting_name || ses.country_name;
  const statusPill = L.status === 'live' ? '<span class="pill live"><span class="dot"></span>Live</span>'
    : L.status === 'finished' ? '<span class="pill done">Final</span>' : '<span class="pill next">Upcoming</span>';

  // best laps
  const best = {};
  for (const [n, laps] of Object.entries(L.laps)) {
    let b = null;
    for (const l of Object.values(laps)) if (l.lap_duration && !l.is_pit_out_lap && (b == null || l.lap_duration < b)) b = l.lap_duration;
    best[n] = b;
  }
  const lapsDone = n => { const ls = Object.values(L.laps[n] || {}); return ls.filter(l => l.lap_duration).length; };
  const lastOf = v => Array.isArray(v) ? [...v].reverse().find(x => x != null) : v;
  const shown = {};
  for (const n of Object.keys(L.drivers)) shown[n] = (L.result?.[n] && lastOf(L.result[n].duration)) || best[n];
  const fastest = Math.min(...Object.values(shown).filter(Boolean));

  let nums = Object.keys(L.drivers);
  nums.sort((a, b) => {
    const pa = L.pos[a], pb = L.pos[b];
    if (pa && pb) return pa - pb;
    if (pa || pb) return pa ? -1 : 1;
    return (best[a] ?? 1e9) - (best[b] ?? 1e9);
  });

  const flag = L.status === 'finished' ? { cls: 'chequered', text: 'Session finished' } : trackStatus(L.rc);
  const wx = L.wx;
  const rows = nums.map((n, i) => {
    const d = L.drivers[n];
    const color = d.team_colour ? '#' + d.team_colour : 'var(--muted)';
    let gap;
    const R = L.result?.[n];
    const out = R && (R.dsq ? 'DSQ' : R.dns ? 'DNS' : R.dnf ? 'DNF' : '');
    if (R && isRace) {
      const g = R.gap_to_leader;
      gap = out ? `<td class="gap">${out}<small>${R.number_of_laps ?? ''} laps</small></td>`
        : i === 0 ? `<td class="gap">Winner<small>${R.number_of_laps ?? ''} laps</small></td>`
        : `<td class="gap">${typeof g === 'number' ? '+' + g.toFixed(3) : esc(g ?? '—')}<small>${R.number_of_laps ?? ''} laps</small></td>`;
    } else if (isRace) {
      const iv = L.ints[n];
      const g = iv?.gap_to_leader, it = iv?.interval;
      const f = v => v == null ? '' : typeof v === 'number' ? '+' + v.toFixed(3) : esc(v);
      gap = i === 0 ? `<td class="gap">Leader<small>${lapsDone(n) ? 'Lap ' + lapsDone(n) : ''}</small></td>`
        : `<td class="gap">${f(g) || '—'}<small>${it != null ? 'Int ' + f(it) : ''}</small></td>`;
    } else {
      const b = shown[n];
      const delta = b && b !== fastest && b > fastest ? '+' + (b - fastest).toFixed(3) : '';
      gap = `<td class="gap ${b && b <= fastest ? 'fast' : ''}">${out || fmtLap(b)}<small>${delta}${delta ? ' · ' : ''}${R?.number_of_laps ?? lapsDone(n)} laps</small></td>`;
    }
    const st = L.stints[n];
    const cmp = st?.compound || '';
    const tyre = cmp ? `<span class="tyre ${esc(cmp)}" title="${esc(cmp)}">${esc(cmp[0])}</span>` : '';
    return `<tr><td class="p">${L.pos[n] || i + 1}</td><td class="bar"><i style="background:${color}"></i></td>
      <td class="drv"><b>${esc(d.name_acronym)}</b><small>${esc(d.full_name ? d.full_name.split(' ').map(w => w[0] + w.slice(1).toLowerCase()).join(' ') : '')} · ${esc(d.team_name || '')}</small></td>
      ${gap}<td style="width:30px">${tyre}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="livehead">
      <div class="title">${esc(ses.session_name)}</div>${statusPill}
      <div class="sub">${esc(meetingName)} · ${esc(ses.circuit_short_name)} · ${fmtDay(start)} ${fmtTime(start)}</div>
    </div>
    ${L.status !== 'upcoming' ? `<div class="flag ${flag.cls}"><span>${flag.text}</span>${isRace && L.maxLap ? `<span class="lap">LAP ${L.maxLap}</span>` : ''}</div>` : ''}
    ${wx ? `<div class="wx"><span>Air <b>${wx.air_temperature}°C</b></span><span>Track <b>${wx.track_temperature}°C</b></span><span>Humidity <b>${wx.humidity}%</b></span><span>Wind <b>${wx.wind_speed} m/s</b></span><span>${wx.rainfall ? '<b style="color:var(--vsc)">Rain</b>' : 'Dry'}</span></div>` : ''}
    ${S.liveError ? `<div class="note">${esc(S.liveError)}</div>` : ''}
    ${rows ? `<div style="overflow-x:auto"><table class="tower">${rows}</table></div>`
      : `<div class="note">${L.status === 'upcoming' ? 'Timing appears when the session starts.' : 'Waiting for timing data…'}</div>`}`;

  const msgs = L.rc.slice(-20).reverse();
  rcEl.innerHTML = msgs.length
    ? msgs.map(m => `<div><time>${fmtTime(new Date(m.date))}</time><span>${m.lap_number ? `<b class="mono">L${m.lap_number}</b> ` : ''}${esc(m.message)}</span></div>`).join('')
    : '<div class="note">No race control messages for this session yet.</div>';
}

// ---------- news ----------
function parseRSS(xml, feed) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  return [...doc.querySelectorAll('item')].slice(0, 20).map(it => {
    const q = s => it.querySelector(s)?.textContent?.trim() || '';
    const media = it.getElementsByTagName('media:content')[0] || it.getElementsByTagName('media:thumbnail')[0] || it.querySelector('enclosure');
    return { title: q('title'), link: q('link'), date: Date.parse(q('pubDate')) || 0, img: media?.getAttribute('url') || '',
             desc: stripHTML(q('description')), source: feed.id };
  });
}
function stripHTML(h) { const d = document.createElement('div'); d.innerHTML = h; return (d.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220); }

async function loadFeed(feed) {
  try {
    const j = await getJSON(RSS2JSON + encodeURIComponent(feed.url), { timeout: 10000 });
    if (j.status !== 'ok') throw new Error(j.message);
    return j.items.map(i => ({
      title: i.title, link: i.link, date: Date.parse(i.pubDate.replace(' ', 'T') + 'Z') || 0,
      img: i.thumbnail || i.enclosure?.link || '', desc: stripHTML(i.description || ''), source: feed.id,
    }));
  } catch {
    const r = await fetch(ALLORIGINS + encodeURIComponent(feed.url));
    if (!r.ok) throw new Error('feed failed');
    return parseRSS(await r.text(), feed);
  }
}

let newsLoading = false;
async function loadNews() {
  if (newsLoading) return; newsLoading = true;
  try {
    const results = await Promise.allSettled(FEEDS.map(loadFeed));
    const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    if (!items.length) throw new Error('no news');
    const seen = new Set();
    const list = items.filter(i => i.title && i.link && !seen.has(i.title.toLowerCase()) && seen.add(i.title.toLowerCase()))
      .sort((a, b) => b.date - a.date).slice(0, 80);
    S.news = { at: Date.now(), items: list };
    store.set('news', S.news);
  } catch {
    if (!S.news) $('#news').innerHTML = '<div class="err">Could not load news right now. Tap refresh to try again.</div>';
  } finally { newsLoading = false; renderNews(); }
}

function renderNews() {
  const chips = [{ id: 'all', name: 'All' }, ...FEEDS];
  $('#newsChips').innerHTML = chips.map(c => `<button class="chip" data-src="${c.id}" aria-pressed="${S.newsSource === c.id}">${esc(c.name)}</button>`).join('');
  if (!S.news) return;
  const items = S.news.items.filter(i => S.newsSource === 'all' || i.source === S.newsSource);
  const name = id => FEEDS.find(f => f.id === id)?.name || '';
  $('#news').innerHTML = items.length ? items.map(i => `
    <a class="card story ${i.img ? '' : 'noimg'}" href="${esc(i.link)}" target="_blank" rel="noopener">
      <div style="min-width:0"><h3>${esc(i.title)}</h3>${i.desc ? `<p>${esc(i.desc)}</p>` : ''}
        <div class="meta"><b>${esc(name(i.source))}</b><span>·</span><span>${i.date ? ago(i.date) : ''}</span></div></div>
      ${i.img ? `<img src="${esc(i.img)}" alt="" loading="lazy" onerror="this.remove();this.parentNode&&this.parentNode.classList.add('noimg')">` : ''}
    </a>`).join('') : '<div class="note">No stories from this source right now.</div>';
}
$('#newsChips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  S.newsSource = b.dataset.src; store.set('newsSource', S.newsSource); renderNews();
});

// ---------- refresh loop ----------
function stamp() {
  S.updatedAt = Date.now();
  $('#updated').textContent = 'Updated ' + fmtTime(new Date());
}
async function refreshAll() {
  const btn = $('#refresh'); btn.classList.add('spin');
  const jobs = [loadSchedule(), loadStandings(), loadLive()];
  if (S.tab === 'news') jobs.push(loadNews());
  const res = await Promise.allSettled(jobs);
  btn.classList.remove('spin');
  if (res.every(r => r.status === 'rejected')) $('#updated').textContent = navigator.onLine ? 'Could not reach data' : 'Offline';
  else stamp();
}
$('#refresh').addEventListener('click', refreshAll);

// live polling: fast while a session runs, slow otherwise
let liveTimer;
function scheduleLive() {
  clearTimeout(liveTimer);
  const fast = S.live?.status === 'live';
  liveTimer = setTimeout(async () => {
    if (document.visibilityState === 'visible') { await loadLive(); stamp(); }
    scheduleLive();
  }, fast ? 8000 : 120000);
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.updatedAt && Date.now() - S.updatedAt > 60e3) refreshAll();
});
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach(el => {
    const ms = +el.dataset.countdown - Date.now();
    if (ms <= 0) renderWeekend(); else el.textContent = countdown(ms);
  });
}, 1000);

// ---------- boot ----------
setTab(S.tab);
if (S.races) { renderWeekend(); renderCalendar(); }
renderStandings(); renderNews();
refreshAll().then(scheduleLive);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
