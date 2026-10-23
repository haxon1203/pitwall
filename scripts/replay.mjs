// Builds track-map replays from OpenF1's free data once each session has ended.
// Each replay holds the track outline, every car's position once per second,
// running order, lap times, gaps (races) and race control messages.
// Output: <OUT_DIR>/replay-<session_key>.json plus index.json listing them.
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs';

const API = 'https://api.openf1.org/v1';
const OUT = process.env.OUT_DIR || 'replays';
const KEEP = 14;                       // replays to keep (about two race weekends)
const sleep = ms => new Promise(r => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// Free tier: a few requests per second, so space them out and retry when told to slow down
async function api(path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await fetch(API + path, { signal: AbortSignal.timeout(120000) });
    await sleep(1200);
    if (r.status === 429) { await sleep(5000 * (attempt + 1)); continue; }
    if (r.status === 404) return [];
    if (!r.ok) { const e = new Error(`${path}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`); e.status = r.status; throw e; }
    return r.json();
  }
  throw new Error(`${path}: rate limited`);
}
const ms = d => Date.parse(String(d).replace(/(\.\d{3})\d+/, '$1'));

const indexPath = `${OUT}/index.json`;
const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, 'utf8')) : { replays: [] };
const have = new Set(index.replays.map(r => r.key));

const year = new Date().getUTCFullYear();
let sessions;
try { sessions = await api(`/sessions?year=${year}`); }
catch (e) { if (e.status === 401) { console.log('A session is live; OpenF1 is locked until it ends.'); process.exit(0); } throw e; }
const now = Date.now();
const todo = sessions
  .filter(s => ms(s.date_end) < now - 3 * 60e3 && ms(s.date_end) > now - 8 * 86400e3 && !have.has(s.session_key))
  .sort((a, b) => ms(a.date_start) - ms(b.date_start));
console.log(`${todo.length} session(s) to build`);

const meetings = {};
for (const s of todo) {
  try {
    const r = await build(s);
    if (!r) continue;
    writeFileSync(`${OUT}/replay-${s.session_key}.json`, JSON.stringify(r.data));
    index.replays.push(r.entry);
    console.log(`Built ${r.entry.meeting} ${r.entry.name}: ${r.entry.drivers} cars, ${r.entry.seconds}s, ${(JSON.stringify(r.data).length / 1e6).toFixed(1)} MB`);
  } catch (e) {
    console.warn(`Skipped ${s.session_key} ${s.session_name}: ${e.message}`);
    if (e.status === 401) break;
  }
}

index.replays.sort((a, b) => b.start - a.start);
for (const old of index.replays.splice(KEEP)) {
  try { unlinkSync(`${OUT}/replay-${old.key}.json`); } catch {}
}
index.at = Date.now();
writeFileSync(indexPath, JSON.stringify(index));

async function build(s) {
  const k = s.session_key;
  meetings[s.meeting_key] ||= (await api(`/meetings?meeting_key=${s.meeting_key}`))[0];
  const meeting = meetings[s.meeting_key];
  const drivers = await api(`/drivers?session_key=${k}`);
  if (!drivers.length) return null;
  const t0 = Math.floor(ms(s.date_start) / 1000) * 1000;
  const t1 = ms(s.date_end) + 5 * 60e3;              // a few minutes past the flag for the in-lap
  const N = Math.ceil((t1 - t0) / 1000);
  const sec = d => Math.round((ms(d) - t0) / 1000);
  const isRace = /race/i.test(s.session_type);

  const laps = await api(`/laps?session_key=${k}`);
  const position = await api(`/position?session_key=${k}`);
  const rc = await api(`/race_control?session_key=${k}`);
  const intervals = isRace ? await api(`/intervals?session_key=${k}`) : [];

  // Car positions: one point per second, delta-encoded to keep the file small
  const pos = {};
  let fastest = null;
  for (const l of laps) if (l.lap_duration && !l.is_pit_out_lap && l.date_start && (!fastest || l.lap_duration < fastest.lap_duration)) fastest = l;
  let track = [];
  for (const d of drivers) {
    const rows = await api(`/location?session_key=${k}&driver_number=${d.driver_number}`);
    if (!rows.length) continue;
    const xs = new Array(N).fill(null);
    let j = 0;
    for (let i = 0; i < N; i++) {
      const t = t0 + i * 1000;
      while (j + 1 < rows.length && ms(rows[j + 1].date) <= t) j++;
      const r = rows[j];
      const age = t - ms(r.date);
      if (age >= 0 && age < 3000 && !(r.x === 0 && r.y === 0)) xs[i] = [Math.round(r.x), Math.round(r.y)];
    }
    // Encode as [startIndex, x, y, dx, dy, ...] runs; null gaps split runs
    const runs = [];
    let cur = null, px = 0, py = 0;
    xs.forEach((p, i) => {
      if (!p) { cur = null; return; }
      if (!cur) { cur = [i, p[0], p[1]]; runs.push(cur); }
      else cur.push(p[0] - px, p[1] - py);
      px = p[0]; py = p[1];
    });
    if (runs.length) pos[d.driver_number] = runs;
    if (fastest && d.driver_number === fastest.driver_number) {
      const a = ms(fastest.date_start), b = a + fastest.lap_duration * 1000;
      track = rows.filter(r => { const t = ms(r.date); return t >= a && t <= b && !(r.x === 0 && r.y === 0); }).map(r => [Math.round(r.x), Math.round(r.y)]);
    }
  }
  if (Object.keys(pos).length < drivers.length / 2) throw new Error('location data not ready yet');
  if (track.length < 50) {
    // Fallback outline: two minutes of the car with the most data
    const best = Object.entries(pos).sort((a, b) => b[1].reduce((n, r) => n + r.length, 0) - a[1].reduce((n, r) => n + r.length, 0))[0];
    const run = best[1].slice().sort((a, b) => b.length - a.length)[0];
    let x = run[1], y = run[2]; track = [[x, y]];
    for (let i = 3; i < Math.min(run.length, 240); i += 2) { x += run[i]; y += run[i + 1]; track.push([x, y]); }
  }

  // Intervals: keep at most one sample per car every 4 seconds
  const lastInt = {};
  const ints = [];
  for (const r of intervals) {
    const t = sec(r.date);
    if (lastInt[r.driver_number] != null && t - lastInt[r.driver_number] < 4) continue;
    lastInt[r.driver_number] = t;
    ints.push([t, r.driver_number, r.gap_to_leader, r.interval]);
  }

  const data = {
    v: 1,
    session: { key: k, name: s.session_name, type: s.session_type, meeting: meeting?.meeting_name || s.country_name, circuit: s.circuit_short_name, location: s.location, start: ms(s.date_start), end: ms(s.date_end) },
    t0, seconds: N,
    drivers: drivers.map(d => ({ num: d.driver_number, abbr: d.name_acronym, name: d.full_name, team: d.team_name, color: d.team_colour ? '#' + d.team_colour : null })),
    track,
    pos,
    order: position.map(p => [sec(p.date), p.driver_number, p.position]).sort((a, b) => a[0] - b[0]),
    laps: laps.filter(l => l.date_start).map(l => [l.driver_number, l.lap_number, sec(l.date_start), l.lap_duration, l.is_pit_out_lap ? 1 : 0]),
    ints,
    rc: rc.map(m => [sec(m.date), m.category, m.flag || '', m.message, m.lap_number || null, m.scope || '']).sort((a, b) => a[0] - b[0]),
  };
  return {
    data,
    entry: { key: k, name: s.session_name, type: s.session_type, meeting: data.session.meeting, circuit: s.circuit_short_name, start: data.session.start, end: data.session.end, drivers: Object.keys(pos).length, seconds: N },
  };
}
