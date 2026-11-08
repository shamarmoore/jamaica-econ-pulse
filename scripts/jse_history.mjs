// Builds/updates data/jse_history.json: daily JSE closing price and volume for every quoted stock.
// Runs on GitHub Actions (nightly). Fetches only trading days not yet stored, politely (3 at a time).
// Usage: node scripts/jse_history.mjs [startDate=2023-01-02] [maxDays=400]
import fs from 'node:fs';
import { parseQuotes } from '../www/js/markets.js';
import { getText } from '../www/js/util.js';

const FILE = 'data/jse_history.json';
const start = process.argv[2] || '2023-01-02';
const maxDays = +(process.argv[3] || 400);
const iso = (d) => d.toISOString().slice(0, 10);

let H = { dates: {}, empty: [] };
try { H = JSON.parse(fs.readFileSync(FILE, 'utf8')); H.empty ||= []; } catch (_) { /* new file */ }

// weekdays from start to today (Jamaica time) not yet fetched; holidays are remembered in H.empty
const todo = [];
const today = new Date(Date.now() - 5 * 3600e3);
for (let d = new Date(`${start}T12:00:00Z`); d <= today; d = new Date(+d + 864e5)) {
  const k = iso(d); const wd = d.getUTCDay();
  if (wd === 0 || wd === 6 || H.dates[k]) continue;
  // retry "empty" days only if they are within the last 4 days (quotes may post late)
  if (H.empty.includes(k) && (today - d) > 4 * 864e5) continue;
  todo.push(k);
}
todo.reverse(); // newest first, so a capped run always keeps the recent data fresh
const batch = todo.slice(0, maxDays);
console.log(`stored ${Object.keys(H.dates).length} days; fetching ${batch.length} of ${todo.length} missing`);

let i = 0; let got = 0; let fail = 0;
async function worker() {
  while (i < batch.length) {
    const k = batch[i++];
    try {
      const q = parseQuotes(await getText(`https://www.jamstockex.com/trading/trade-quotes/?market=50&date=${k}`, 40000));
      const syms = Object.keys(q);
      if (syms.length > 20) {
        // the page shows the last trading day's prices for holidays — store only if it isn't a copy of an earlier day
        H.dates[k] = Object.fromEntries(syms.map((s) => [s, [q[s].close, q[s].vol || 0]]));
        H.empty = H.empty.filter((x) => x !== k); got++;
      } else if (!H.empty.includes(k)) H.empty.push(k);
    } catch (e) { fail++; if (fail < 5) console.log('fail', k, String(e.message || e).slice(0, 80)); }
    await new Promise((r) => setTimeout(r, 400));
  }
}
await Promise.all([worker(), worker(), worker()]);

// drop holiday duplicates: a day whose every close+volume equals the previous stored day
const keys = Object.keys(H.dates).sort(); let dup = 0;
for (let j = 1; j < keys.length; j++) {
  const a = H.dates[keys[j - 1]]; const b = H.dates[keys[j]];
  const same = Object.keys(b).length === Object.keys(a).length && Object.keys(b).every((s) => a[s] && a[s][0] === b[s][0] && a[s][1] === b[s][1]);
  if (same) { delete H.dates[keys[j]]; if (!H.empty.includes(keys[j])) H.empty.push(keys[j]); dup++; }
}
H.updated = new Date().toISOString();
const sorted = {}; for (const k of Object.keys(H.dates).sort()) sorted[k] = H.dates[k];
H.dates = sorted; H.empty.sort();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(H));
const ks = Object.keys(H.dates);
console.log(`HIST got ${got}, failed ${fail}, holiday-dups ${dup}; now ${ks.length} days ${ks[0]} → ${ks[ks.length - 1]}; ${(fs.statSync(FILE).size / 1e6).toFixed(1)} MB`);
