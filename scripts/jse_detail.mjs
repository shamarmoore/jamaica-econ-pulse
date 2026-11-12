// Richer daily JSE data from the same trade-quotes pages: index values (incl. Financial, Manufacturing &
// Distribution, Junior Market) and each stock's closing bid, closing ask, day high and day low.
// Stored in monthly files data/detail/YYYY-MM.json so nightly commits stay small.
// One page at a time, 2.5 s apart; stops for the day if the site pushes back.
// Usage: node scripts/jse_detail.mjs [maxPages=300]
import fs from 'node:fs';
import { getText, htmlToText } from '../www/js/util.js';

const DIR = 'data/detail';
const maxPages = +(process.argv[2] || 300);
fs.mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const v = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return Number.isFinite(v) ? v : null; };

// trading days we have prices for (from the price history)
const hist = JSON.parse(fs.readFileSync('data/jse_history.json', 'utf8'));
const days = Object.keys(hist.dates).sort();
const shards = {};
const shard = (m) => (shards[m] ||= (() => { try { return JSON.parse(fs.readFileSync(`${DIR}/${m}.json`, 'utf8')); } catch (_) { return {}; } })());
const todo = days.filter((d) => !shard(d.slice(0, 7))[d]).reverse(); // newest first
console.log(`detail: ${days.length - todo.length} of ${days.length} days stored; fetching up to ${maxPages}`);

export function parseDetail(html) {
  const tables = html.split(/<table/i).slice(1).map((tb) => (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) => (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map((c) => htmlToText(c).trim())));
  const out = { i: {}, b: {} };
  const idx = tables.find((t) => /^index$/i.test(t[0]?.[0] || ''));
  for (const r of (idx || []).slice(1)) if (r[0] && num(r[1]) != null) out.i[r[0].replace(/^JSE /, '')] = num(r[1]);
  // first ordinary-shares table (the page repeats each table for mobile)
  const ord = tables.find((t) => t[0]?.some((h) => /closing bid/i.test(h)));
  if (ord) {
    const h = ord[0]; const c = (re) => h.findIndex((x) => re.test(x));
    const iS = c(/^symbol/i); const iB = c(/closing bid/i); const iA = c(/closing ask/i); const iR = c(/today.?s range/i);
    for (const r of ord.slice(1)) {
      const sym = (r[iS] || '').replace(/\s*\(.*\)$/, ''); if (!sym) continue;
      const [lo, hi] = String(r[iR] || '').split(/\s+-\s+/).map(num);
      out.b[sym] = [num(r[iB]), num(r[iA]), hi ?? null, lo ?? null];
    }
  }
  return out;
}

let got = 0;
for (const d of todo.slice(0, maxPages)) {
  try {
    const p = parseDetail(await getText(`https://www.jamstockex.com/trading/trade-quotes/?market=50&date=${d}`, 40000));
    if (Object.keys(p.i).length || Object.keys(p.b).length) { shard(d.slice(0, 7))[d] = p; got++; }
  } catch (e) {
    const msg = String(e.message || e); console.log('fail', d, msg.slice(0, 80));
    if (/HTTP (403|429|503)/.test(msg)) { console.log('JSE site is rate-limiting; stopping politely'); break; }
  }
  await sleep(2500);
}
for (const [m, v] of Object.entries(shards)) if (Object.keys(v).length) fs.writeFileSync(`${DIR}/${m}.json`, JSON.stringify(v));
console.log(`DETAIL fetched ${got}; remaining ${Math.max(0, todo.length - got)}`);
