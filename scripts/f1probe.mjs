// Temporary: checks what F1's live timing service returns without a login.
import WebSocket from 'ws';
import { writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('out', { recursive: true });
const log = [];
const L = (...a) => { const s = a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' '); console.log(s.slice(0, 500)); log.push(s.slice(0, 20000)); };
const H = 'https://livetiming.formula1.com';
const TOPICS = ['Heartbeat', 'SessionInfo', 'TrackStatus', 'LapCount', 'TimingData', 'DriverList', 'Position.z', 'CarData.z', 'RaceControlMessages', 'WeatherData', 'SessionStatus', 'TimingAppData', 'ExtrapolatedClock'];

async function staticFiles() {
  for (const p of ['/static/StreamingStatus.json', '/static/SessionInfo.json', '/static/2026/Index.json']) {
    try { const r = await fetch(H + p); const t = await r.text(); L('STATIC', p, r.status, t.replace(/^﻿/, '').slice(0, 1500)); } catch (e) { L('STATIC', p, 'ERR', e.message); }
  }
}

async function classic() {
  const cd = encodeURIComponent(JSON.stringify([{ name: 'Streaming' }]));
  const r = await fetch(`${H}/signalr/negotiate?connectionData=${cd}&clientProtocol=1.5`);
  const body = await r.text();
  L('CLASSIC negotiate', r.status, body.slice(0, 300));
  if (!r.ok) return;
  const tok = JSON.parse(body).ConnectionToken;
  const cookie = r.headers.get('set-cookie') || '';
  const url = `wss://livetiming.formula1.com/signalr/connect?clientProtocol=1.5&transport=webSockets&connectionToken=${encodeURIComponent(tok)}&connectionData=${cd}`;
  await listen(url, { 'User-Agent': 'BestHTTP', 'Accept-Encoding': 'gzip,identity', Cookie: cookie }, ws => {
    ws.send(JSON.stringify({ H: 'Streaming', M: 'Subscribe', A: [TOPICS], I: 1 }));
  }, 'CLASSIC');
}

async function core() {
  const r = await fetch(`${H}/signalrcore/negotiate?negotiateVersion=1`, { method: 'POST' });
  const body = await r.text();
  L('CORE negotiate', r.status, body.slice(0, 300));
  if (!r.ok) return;
  const j = JSON.parse(body);
  const cookie = r.headers.get('set-cookie') || '';
  const url = `wss://livetiming.formula1.com/signalrcore?id=${encodeURIComponent(j.connectionToken || j.connectionId)}`;
  await listen(url, { Cookie: cookie }, ws => {
    ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + '\x1e');
    ws.send(JSON.stringify({ type: 1, target: 'Subscribe', arguments: [TOPICS], invocationId: '0' }) + '\x1e');
  }, 'CORE');
}

function listen(url, headers, onOpen, tag) {
  return new Promise(res => {
    const ws = new WebSocket(url, { headers });
    let n = 0;
    const done = () => { try { ws.close(); } catch {} res(); };
    setTimeout(done, 20000);
    ws.on('open', () => { L(tag, 'open'); onOpen(ws); });
    ws.on('unexpected-response', (req, resp) => { L(tag, 'unexpected-response', resp.statusCode); done(); });
    ws.on('message', m => { n++; const s = m.toString(); if (n <= 12) L(tag, 'msg', n, s.length, s.slice(0, 6000)); });
    ws.on('error', e => L(tag, 'error', e.message));
    ws.on('close', (c, r) => { L(tag, 'close', c, r.toString(), 'messages', n); res(); });
  });
}

await staticFiles();
try { await classic(); } catch (e) { L('CLASSIC fail', e.message); }
try { await core(); } catch (e) { L('CORE fail', e.message); }
writeFileSync('out/f1probe.txt', log.join('\n'));
