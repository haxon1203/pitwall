// Temporary: checks what F1 live timing and OpenF1 return from GitHub's servers.
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('out', { recursive: true });
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s.slice(0, 400)); log.push(s.slice(0, 3000)); };
const UAS = {
  browser: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', Accept: 'application/json,text/plain,*/*', 'Accept-Language': 'en-GB,en;q=0.9', Origin: 'https://www.formula1.com', Referer: 'https://www.formula1.com/' },
  besthttp: { 'User-Agent': 'BestHTTP', 'Accept-Encoding': 'gzip,identity' },
};
const H = 'https://livetiming.formula1.com';
const cd = encodeURIComponent(JSON.stringify([{ name: 'Streaming' }]));
for (const [name, h] of Object.entries(UAS)) {
  for (const [p, m] of [['/static/StreamingStatus.json', 'GET'], [`/signalr/negotiate?connectionData=${cd}&clientProtocol=1.5`, 'GET'], ['/signalrcore/negotiate?negotiateVersion=1', 'POST']]) {
    try { const r = await fetch(H + p, { method: m, headers: h }); const t = (await r.text()).replace(/^﻿/, ''); L(name, p.split('?')[0], r.status, t.includes('cloudfront') ? 'cloudfront block' : t.slice(0, 400)); }
    catch (e) { L(name, p, 'ERR', e.message); }
  }
}
const O = 'https://api.openf1.org/v1';
const since = new Date(Date.now() - 60e3).toISOString();
for (const p of ['/sessions?session_key=latest', `/location?session_key=latest&date>${since}`, `/position?session_key=latest&date>${new Date(Date.now() - 600e3).toISOString()}`, `/intervals?session_key=latest&date>${since}`]) {
  try { const r = await fetch(O + p); const t = await r.text(); L('OPENF1', p, r.status, t.length, t.slice(0, 600)); } catch (e) { L('OPENF1', p, 'ERR', e.message); }
}
writeFileSync('out/f1probe.txt', log.join('\n'));
