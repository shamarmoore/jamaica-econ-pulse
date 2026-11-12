// Macro history for back-tests and nightly regime signals → data/macro.json
//  - daily USD/JMD (open-source currency-api on jsDelivr, daily since March 2024)
//  - monthly 3- and 6-month GOJ Treasury-bill yields (Bank of Jamaica spreadsheet, full history)
//  - Junior Market membership (JSE junior-market quotes page)
import fs from 'node:fs';
import { getJSON, getText, htmlToText } from '../www/js/util.js';

const FILE = 'data/macro.json';
let M = { fx: {}, tbill: {}, junior: [] };
try { M = { ...M, ...JSON.parse(fs.readFileSync(FILE, 'utf8')) }; } catch (_) { /* new */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- daily USD/JMD ----
const start = new Date('2024-03-04T12:00:00Z'); const today = new Date();
const want = [];
for (let d = new Date(start); d <= today; d = new Date(+d + 864e5)) { const k = d.toISOString().slice(0, 10); if (d.getUTCDay() % 6 && !M.fx[k]) want.push(k); }
let i = 0; let fxGot = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (i < want.length) {
    const k = want[i++];
    for (const u of [`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${k}/v1/currencies/usd.min.json`, `https://${k}.currency-api.pages.dev/v1/currencies/usd.min.json`]) {
      try { const j = await getJSON(u, 20000); if (j?.usd?.jmd) { M.fx[k] = +j.usd.jmd.toFixed(4); fxGot++; break; } } catch (_) { /* next */ }
    }
  }
}));
console.log(`FX days: +${fxGot}, total ${Object.keys(M.fx).length}`);

// ---- T-bill yields (BOJ spreadsheet) ----
try {
  const { readSheetRows } = await import('./boj_sheet.mjs');
  const rows = await readSheetRows('2020/10/IR.GOJ.00.xlsx');
  const head = rows.slice(0, 20); const col = (re) => { for (const r of head) { const i = r.findIndex((c) => re.test(String(c))); if (i >= 0) return i; } return -1; };
  const c3 = col(/^3 MONTHS/i); const c6 = col(/^6 MONTHS/i);
  for (const r of rows) {
    if (typeof r[0] !== 'number' || r[0] < 30000) continue;
    const key = new Date(Date.UTC(1899, 11, 30) + r[0] * 864e5).toISOString().slice(0, 7);
    const v3 = typeof r[c3] === 'number' ? +r[c3].toFixed(3) : null; const v6 = typeof r[c6] === 'number' ? +r[c6].toFixed(3) : null;
    if (v3 != null || v6 != null) M.tbill[key] = [v3, v6];
  }
  console.log(`T-bill months: ${Object.keys(M.tbill).length}`, Object.entries(M.tbill).slice(-3));
} catch (e) { console.log('tbill failed', String(e.message || e).slice(0, 120)); }

// ---- Junior Market membership ----
for (const id of [52, 51, 53, 54, 49]) {
  try {
    await sleep(2500);
    const html = await getText(`https://www.jamstockex.com/trading/trade-quotes/?market=${id}&date=${new Date(Date.now() - 3 * 864e5).toISOString().slice(0, 10)}`, 40000);
    const title = htmlToText((html.match(/<h[1-3][^>]*>[\s\S]*?Junior[\s\S]*?<\/h[1-3]>/i) || [''])[0]);
    const idxTable = /Junior Market Index/i.test(html) && !/JSE Financial Index/i.test(html);
    if (/junior/i.test(title) || idxTable) {
      const syms = [...new Set([...html.matchAll(/instrument=\d+[^>]*>\s*([A-Z0-9.]{2,12})\s*</g)].map((m) => m[1]))];
      if (syms.length > 20) { M.junior = syms; M.juniorMarketId = id; console.log(`junior market id ${id}: ${syms.length} symbols`); break; }
    }
  } catch (e) { console.log('junior probe', id, String(e.message || e).slice(0, 60)); }
}
M.updated = new Date().toISOString();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(M));
console.log('MACRO saved');
