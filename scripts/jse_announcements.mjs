// JSE company announcements from the exchange's public WordPress feed.
//  - data/insiders.json : every "Trading in shares" notice (directors, officers, connected parties, buybacks) since 2019,
//                         kept forever so insider trades can be back-tested; parsed in scripts/insiders.py
//  - data/news.json     : all announcements from the last 120 days (results, dividends, notices…) for the app,
//                         which summarises them on the phone with Gemini Nano when it's available
// One request every 2.5 s; stops politely if the site pushes back.
// Usage: node scripts/jse_announcements.mjs [maxPages=80]
import fs from 'node:fs';
import { getText, htmlToText } from '../www/js/util.js';

const API = 'https://www.jamstockex.com/wp-json/wp/v2/posts';
const maxPages = +(process.argv[2] || 80);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const CAT = { 1161: 'insider', 8: 'results', 1158: 'dividend', 1159: 'dividend' };
const clean = (h) => htmlToText(String(h || '')).replace(/\s+/g, ' ').trim();
const slim = (p, n) => ({ id: p.id, date: p.date, title: clean(p.title?.rendered), text: clean(p.content?.rendered).slice(0, n), link: p.link, cats: p.categories });
let pages = 0;
async function page(q, n) {
  if (pages >= maxPages) throw new Error('page budget used');
  pages++;
  const t = await getText(`${API}?${q}&per_page=100&page=${n}&_fields=id,date,title,content,link,categories`, 60000);
  await sleep(2500);
  return JSON.parse(t);
}

// ---- insider trades: newest first until we reach notices we already have (or 2019 on the first run)
const ins = load('data/insiders.json', { posts: [] });
const have = new Set(ins.posts.map((p) => p.id));
let added = 0;
try {
  for (let n = 1; n < 200; n++) {
    const L = await page('categories=1161', n); if (!L.length) break;
    let fresh = 0;
    for (const p of L) if (!have.has(p.id)) { ins.posts.push(slim(p, 1200)); have.add(p.id); fresh++; added++; }
    if (!fresh || L[L.length - 1].date < '2019-01-01') break;
  }
} catch (e) { console.log('insiders stopped:', String(e.message || e).slice(0, 120)); }
ins.posts.sort((a, b) => (a.date < b.date ? 1 : -1));
ins.updated = new Date().toISOString();
fs.writeFileSync('data/insiders.json', JSON.stringify(ins));
console.log(`INSIDERS added ${added}; total ${ins.posts.length}; oldest ${ins.posts[ins.posts.length - 1]?.date}`);

// ---- recent announcements of every kind (last 120 days) for the app
const since = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
const old = load('data/news.json', { posts: [] });
const byId = new Map(old.posts.filter((p) => p.date >= since).map((p) => [p.id, p]));
try {
  for (let n = 1; n < 40; n++) {
    const L = await page('orderby=date&order=desc', n); if (!L.length) break;
    let fresh = 0;
    for (const p of L) if (p.date >= since && !byId.has(p.id)) { const s = slim(p, 1500); s.kind = Object.entries(CAT).find(([c]) => p.categories.includes(+c))?.[1] || 'notice'; byId.set(p.id, s); fresh++; }
    if (L[L.length - 1].date < since || (!fresh && old.posts.length)) break;
  }
} catch (e) { console.log('news stopped:', String(e.message || e).slice(0, 120)); }
const news = { updated: new Date().toISOString(), posts: [...byId.values()].sort((a, b) => (a.date < b.date ? 1 : -1)) };
fs.writeFileSync('data/news.json', JSON.stringify(news));
console.log(`NEWS ${news.posts.length} announcements since ${since}`);
