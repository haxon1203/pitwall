// Collects everything the app shows from BBC Sport's Formula 1 pages and
// publishes it as two JSON files on the "data" branch:
//   bbc.json  – news, standings, calendar, last race (updated every run)
//   live.json – this weekend's sessions, timing and BBC live commentary
// While a session is running the script keeps going and refreshes live.json
// every 30 seconds until shortly after the session ends.
import { XMLParser } from 'fast-xml-parser';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';

const BBC = 'https://www.bbc.co.uk';
const RSS = 'https://feeds.bbci.co.uk/sport/formula1/rss.xml';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const OUT = process.env.OUT_DIR || 'out';
const PUBLISH = !!process.env.PUBLISH_URL;           // git remote to force-push the data branch to
const LIVE_EVERY_MS = 30e3;
const MAX_RUN_MS = 5.5 * 3600e3;                      // GitHub stops jobs at 6 hours
const DURATION_MIN = { p1: 60, p2: 60, p3: 60, sq: 45, sprint: 60, q: 60, race: 120 };
const started = Date.now();

// ---------- fetching ----------
async function get(path) {
  const r = await fetch(path.startsWith('http') ? path : BBC + path, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(25000) });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.text();
}
// BBC pages embed their data as window.__INITIAL_DATA__ = "<json string>"
function initialData(html) {
  const i = html.indexOf('window.__INITIAL_DATA__');
  if (i < 0) throw new Error('no __INITIAL_DATA__');
  let j = html.indexOf('=', i) + 1;
  while (html[j] === ' ') j++;
  let v;
  if (html[j] === '"') {
    let k = j + 1;
    while (html[k] !== '"') k += html[k] === '\\' ? 2 : 1;
    v = JSON.parse(JSON.parse(html.slice(j, k + 1)));
  } else {
    // plain object literal: find the matching brace
    let depth = 0, k = j, inStr = false;
    for (; k < html.length; k++) {
      const c = html[k];
      if (inStr) { if (c === '\\') k++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++; else if (c === '}' && --depth === 0) break;
    }
    v = JSON.parse(html.slice(j, k + 1));
  }
  return v.data;
}
const block = (data, prefix) => Object.entries(data).find(([k]) => k.startsWith(prefix))?.[1]?.data;
const val = x => (x && typeof x === 'object' && 'value' in x ? x.value : x) ?? '';
const clean = x => { const v = String(val(x)).trim(); return v === '-' ? '' : v; };
const teamId = urn => (urn || '').split(':').pop();

// ---------- times: BBC lists sessions in UK time ----------
function londonOffsetMin(t) {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t));
  const g = k => +p.find(x => x.type === k).value;
  return (Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute')) - t) / 60e3;
}
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function ukToUtc(year, dateStr, timeStr) {
  const [d, m] = dateStr.trim().split(/\s+/);
  const mon = MONTHS.indexOf(m.toLowerCase());
  const [hh, mm] = timeStr.split(':').map(Number);
  const naive = Date.UTC(year, mon, +d, hh, mm);
  let t = naive - londonOffsetMin(naive) * 60e3;
  t = naive - londonOffsetMin(t) * 60e3;
  return t;
}

// ---------- sessions ----------
function sessionKey(name) {
  const n = name.toLowerCase();
  if (n.includes('sprint') && (n.includes('qual') || n.includes('shootout'))) return 'sq';
  if (n.includes('sprint')) return 'sprint';
  if (n.includes('qual')) return 'q';
  if (n.includes('race')) return 'race';
  if (n.includes('first') || n.includes('1')) return 'p1';
  if (n.includes('second') || n.includes('2')) return 'p2';
  if (n.includes('third') || n.includes('3')) return 'p3';
  return n;
}
const SESSION_LABEL = { p1: 'Practice 1', p2: 'Practice 2', p3: 'Practice 3', sq: 'Sprint Qualifying', sprint: 'Sprint', q: 'Qualifying', race: 'Grand Prix' };

function driverBase(p) {
  return { pos: clean(p.rank), abbr: p.abbreviatedName, name: p.fullName, num: clean(p.number), team: p.team?.fullName || '', teamId: teamId(p.team?.urn) };
}
function rowsFor(key, participants = []) {
  return participants.map(p => {
    const b = driverBase(p);
    if (key === 'q' || key === 'sq') {
      return { ...b, q1: clean(p.qualifying1Time), q2: clean(p.qualifying2Time), q3: clean(p.qualifying3Time) };
    }
    if (key === 'race' || key === 'sprint') {
      return { ...b, grid: clean(p.gridPosition), pits: clean(p.pitStops), fastest: clean(p.fastestLap), time: clean(p.duration), points: clean(p.points), fl: !!p.hasFastestLap };
    }
    return { ...b, time: clean(p.practiceTime), laps: clean(p.practiceLaps) };
  }).sort((a, b) => (+a.pos || 99) - (+b.pos || 99));
}

// ---------- pages ----------
async function seasonResults() {
  const data = initialData(await get('/sport/formula1/results'));
  return block(data, 'formula1-season-results');
}

async function weekend(season) {
  const stage = season.stages.find(s => s.status !== 'PostEvent') || season.stages[0];
  if (!stage) return null;
  const year = season.year;
  const [name, circuit] = stage.heading.split(/,\s*/);
  const schedule = (stage.schedule || []).map(s => {
    const key = sessionKey(s.session);
    const start = ukToUtc(year, s.date, s.time);
    return { key, name: SESSION_LABEL[key] || s.session, start, end: start + (DURATION_MIN[key] || 60) * 60e3 };
  });
  let detail = null;
  try { detail = block(initialData(await get(stage.stageResultUri)), 'formula1-stage-results'); } catch (e) { console.warn('stage results:', e.message); }
  const bySession = {};
  if (detail) {
    for (const sec of ['practice', 'sprintQualifying', 'sprint', 'qualifying', 'race']) {
      for (const s of [].concat(detail[sec] || [])) {
        if (!s?.name) continue;
        const key = sessionKey(s.name);
        bySession[key] = { status: s.status, isLive: !!s.isLive, lastUpdated: s.lastUpdated || '', rows: rowsFor(key, s.participants).filter(r => r.pos || r.time || r.q1) };
      }
    }
  }
  const sessions = schedule.length ? schedule : Object.keys(bySession).map(key => ({ key, name: SESSION_LABEL[key] || key, start: null, end: null }));
  for (const s of sessions) Object.assign(s, bySession[s.key] || { status: 'PreEvent', isLive: false, lastUpdated: '', rows: [] });
  return {
    name, circuit: circuit || detail?.venue?.circuit || '', status: stage.status, isLive: !!detail?.isStageLive,
    raceTime: Date.parse(stage.raceDateTime) || null, sessions,
    url: BBC + stage.stageResultUri,
  };
}

function lastRace(season) {
  const s = season.stages.find(x => x.status === 'PostEvent' && x.result?.participants?.length);
  if (!s) return null;
  const [name, circuit] = s.heading.split(/,\s*/);
  return { name, circuit, date: Date.parse(s.raceDateTime) || null, rows: rowsFor('race', s.result.participants), url: BBC + s.stageResultUri };
}

async function standings() {
  const d = block(initialData(await get('/sport/formula1/standings')), 'formula1-standings');
  const n = x => clean(x);
  return {
    updated: d.drivers?.lastUpdated || '',
    drivers: (d.drivers?.entries || []).map(e => ({ pos: n(e.rank), name: e.driverDetails?.fullName, abbr: e.driverDetails?.abbreviatedName, team: e.team?.fullName, teamId: teamId(e.team?.urn), points: n(e.points), wins: n(e.wins), podiums: n(e.podiums) })),
    teams: (d.constructors?.entries || []).map(e => ({ pos: n(e.rank), name: e.team?.fullName, teamId: teamId(e.team?.urn), points: n(e.points), wins: n(e.wins), podiums: n(e.podiums) })),
  };
}

async function calendar(season) {
  const year = season.year;
  const months = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => get(`/sport/formula1/calendar/${year}-${String(i + 1).padStart(2, '0')}`)));
  const events = [];
  for (const m of months) {
    if (m.status !== 'fulfilled') continue;
    try {
      const c = block(initialData(m.value), 'sport-calendar');
      for (const g of c?.eventGroups || []) for (const e of g.events || []) events.push(e);
    } catch {}
  }
  const seen = new Set();
  return events.filter(e => !seen.has(e.eventUrn) && seen.add(e.eventUrn)).map(e => {
    const stage = season.stages.find(s => s.heading.toLowerCase().startsWith(e.eventName.toLowerCase()));
    const w = stage?.result?.participants?.find(p => clean(p.rank) === '1');
    return {
      name: e.eventName, venue: e.venueName, start: e.startDate, end: e.endDate, cancelled: !!e.isCancelled,
      status: stage?.status || (Date.parse(e.endDate) + 86400e3 < Date.now() ? 'PostEvent' : 'PreEvent'),
      winner: w ? { name: w.fullName, abbr: w.abbreviatedName, teamId: teamId(w.team?.urn) } : null,
    };
  }).sort((a, b) => a.start.localeCompare(b.start));
}

async function news() {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
  const xml = parser.parse(await get(RSS));
  const text = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v)).trim();
  return [].concat(xml?.rss?.channel?.item ?? []).slice(0, 40).map(it => {
    const m = [].concat(it['media:thumbnail'] || it['media:content'] || [])[0];
    return {
      title: text(it.title), link: text(it.link).split('?')[0], date: Date.parse(text(it.pubDate)) || 0,
      desc: text(it.description), img: (m?.['@url'] || '').replace('/standard/240/', '/standard/480/'),
    };
  }).filter(i => i.title && i.link);
}

// ---------- BBC live text commentary ----------
const textOf = blocks => (blocks || []).flatMap(b => {
  if (!b) return [];
  if (b.type === 'paragraph') return [b.model?.text?.trim()].filter(Boolean);
  if (b.type === 'unorderedList' || b.type === 'orderedList' || b.type === 'listItem') return textOf(b.model?.blocks).map(t => '• ' + t.replace(/^•\s*/, ''));
  if (b.type === 'text') return textOf(b.model?.blocks);
  return [];
});
async function commentary() {
  const home = await get('/sport/formula1');
  const ids = [...new Set([...home.matchAll(/\/sport\/formula1\/live\/([a-z0-9]+)/g)].map(m => m[1]))].slice(0, 3);
  let best = null;
  for (const id of ids) {
    const data = initialData(await get(`/sport/formula1/live/${id}`));
    const h = block(data, 'live-header');
    const st = block(data, 'stream');
    const sp = block(data, 'summary-points');
    const c = {
      id, url: `${BBC}/sport/formula1/live/${id}`, title: h?.title || '', live: !!h?.live,
      start: Date.parse(h?.startDateTime) || null, updated: Date.parse(h?.seoTimestamps?.lastModified) || null,
      summary: textOf(Array.isArray(sp) ? sp : sp?.blocks || []).map(t => t.replace(/^•\s*/, '')).slice(0, 6),
      posts: (st?.results || []).map(p => {
        const blocks = p.content?.model?.blocks || [];
        const img = blocks.find(b => b.type === 'image')?.model;
        return {
          id: p.urn, time: Date.parse(p.unformattedTime) || null,
          title: textOf(p.headline?.model?.blocks).join(' '),
          text: textOf(blocks).slice(0, 8),
          img: img?.imageSrc ? { src: img.imageSrc, alt: img.altText || '' } : null,
        };
      }).filter(p => p.title || p.text.length),
    };
    if (c.live) return c;
    if (!best || (c.updated || 0) > (best.updated || 0)) best = c;
  }
  return best;
}

// ---------- publishing ----------
function write(name, obj) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, JSON.stringify(obj));
}
function publish(message) {
  if (!PUBLISH) return;
  const env = { ...process.env, GIT_AUTHOR_NAME: 'github-actions', GIT_AUTHOR_EMAIL: 'github-actions@users.noreply.github.com', GIT_COMMITTER_NAME: 'github-actions', GIT_COMMITTER_EMAIL: 'github-actions@users.noreply.github.com' };
  const git = (...a) => execFileSync('git', ['-C', OUT, ...a], { stdio: 'pipe', env }).toString().trim();
  if (!existsSync(`${OUT}/.git`)) git('init', '-q', '-b', 'data');
  git('add', '-A');
  // A single parentless commit each time, so the data branch never grows
  const commit = git('commit-tree', git('write-tree'), '-m', message);
  git('update-ref', 'HEAD', commit);
  git('push', '-qf', process.env.PUBLISH_URL, 'HEAD:data');
}

// ---------- main ----------
async function liveSnapshot(season) {
  const [wk, com] = await Promise.allSettled([weekend(season), commentary()]);
  if (wk.status === 'rejected') console.warn('weekend:', wk.reason.message);
  if (com.status === 'rejected') console.warn('commentary:', com.reason.message);
  return { at: Date.now(), weekend: wk.value || null, commentary: com.value || null };
}
const inLiveWindow = wk => {
  const now = Date.now();
  return !!wk && (wk.isLive || wk.sessions.some(s => s.isLive || (s.start && now >= s.start - 10 * 60e3 && now <= s.end + 30 * 60e3)));
};

const season = await seasonResults();
const [st, cal, nw] = await Promise.allSettled([standings(), calendar(season), news()]);
for (const [n, r] of [['standings', st], ['calendar', cal], ['news', nw]]) if (r.status === 'rejected') console.warn(n + ':', r.reason.message);
write('bbc.json', {
  at: Date.now(), season: season.year,
  standings: st.value || null, calendar: cal.value || [], news: nw.value || [], lastRace: lastRace(season),
});
let live = await liveSnapshot(season);
write('live.json', live);
publish('Update BBC data');
console.log(`Published: ${nw.value?.length ?? 0} stories, ${cal.value?.length ?? 0} events, weekend ${live.weekend?.name} (${live.weekend?.sessions.map(s => s.key + ':' + s.status).join(' ')}), commentary "${live.commentary?.title}" live=${live.commentary?.live}`);

// Keep refreshing while a session is on
let lastJson = JSON.stringify({ ...live, at: 0 });
while (inLiveWindow(live.weekend) && Date.now() - started < MAX_RUN_MS && PUBLISH) {
  await new Promise(r => setTimeout(r, LIVE_EVERY_MS));
  try {
    const s = await seasonResults();
    live = await liveSnapshot(s);
    const j = JSON.stringify({ ...live, at: 0 });
    if (j !== lastJson) {
      write('live.json', live); publish('Live update'); lastJson = j;
      const cur = live.weekend?.sessions.find(x => x.isLive);
      console.log(new Date().toISOString(), 'live update', cur ? `${cur.key} leader ${cur.rows[0]?.abbr}` : '');
    }
  } catch (e) { console.warn('live loop:', e.message); }
}
