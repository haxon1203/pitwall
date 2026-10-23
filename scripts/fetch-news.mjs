// Collects F1 stories from several RSS feeds into one news.json for the app.
// Runs on GitHub Actions, so the phone never has to fetch the feeds itself.
import { XMLParser } from 'fast-xml-parser';
import { writeFileSync, mkdirSync } from 'node:fs';

const FEEDS = [
  { id: 'f1', url: 'https://www.formula1.com/en/latest/all.xml' },
  { id: 'motorsport', url: 'https://www.motorsport.com/rss/f1/news/' },
  { id: 'autosport', url: 'https://www.autosport.com/rss/f1/news/' },
  { id: 'bbc', url: 'https://feeds.bbci.co.uk/sport/formula1/rss.xml' },
  { id: 'therace', url: 'https://www.the-race.com/formula-1/feed/' },
  { id: 'racefans', url: 'https://www.racefans.net/feed/' },
];

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@' });
const text = v => (v == null ? '' : typeof v === 'object' ? (v['#text'] ?? '') : String(v));
const strip = h => text(h).replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#8217;|&rsquo;/g, '’')
  .replace(/&#8216;|&lsquo;/g, '‘').replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”').replace(/&#8211;|&ndash;/g, '–')
  .replace(/&quot;/g, '"').replace(/&#039;|&#39;/g, "'").replace(/\s+/g, ' ').trim();
const first = v => Array.isArray(v) ? v[0] : v;

function image(it) {
  const m = first(it['media:content']) || first(it['media:thumbnail']) || first(it.enclosure);
  if (m?.['@url'] && !/\.(mp3|mp4)$/i.test(m['@url'])) return m['@url'];
  const html = text(it['content:encoded']) || text(it.description);
  return html.match(/<img[^>]+src="([^"]+)"/i)?.[1] || '';
}

async function load(feed) {
  const r = await fetch(feed.url, { headers: { 'user-agent': 'Mozilla/5.0 (PitWall news reader)' }, signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`${feed.id}: HTTP ${r.status}`);
  const xml = parser.parse(await r.text());
  const items = [].concat(xml?.rss?.channel?.item ?? []);
  return items.slice(0, 25).map(it => ({
    title: strip(it.title), link: text(it.link).trim(), date: Date.parse(text(it.pubDate)) || 0,
    img: image(it), desc: strip(it.description).slice(0, 240), source: feed.id,
  }));
}

const results = await Promise.allSettled(FEEDS.map(load));
results.forEach((r, i) => console.log(FEEDS[i].id, r.status === 'fulfilled' ? `${r.value.length} items` : r.reason.message));
const seen = new Set();
const items = results.flatMap(r => r.status === 'fulfilled' ? r.value : [])
  .filter(i => i.title && i.link && !seen.has(i.title.toLowerCase()) && seen.add(i.title.toLowerCase()))
  .sort((a, b) => b.date - a.date).slice(0, 120);
if (!items.length) { console.error('No stories fetched'); process.exit(1); }
mkdirSync('out', { recursive: true });
writeFileSync('out/news.json', JSON.stringify({ at: Date.now(), items }));
console.log(`Wrote ${items.length} stories`);
