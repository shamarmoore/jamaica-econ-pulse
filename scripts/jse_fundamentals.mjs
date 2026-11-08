// Weekly: company financials from the JSE's own instrument pages → data/jse_fundamentals.json
// Per stock: quarterly net profit by fiscal year, annual profit, dividends (ex-date, currency, amount),
// shares outstanding, market value, fiscal year-end month. One page at a time, 2.5 s apart; stops if the site pushes back.
import fs from 'node:fs';
import { getText, htmlToText } from '../www/js/util.js';

const FILE = 'data/jse_fundamentals.json';
const MAX_AGE_D = +(process.argv[2] || 6);
let F = { stocks: {} };
try { F = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { /* new */ }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => { const v = parseFloat(String(s).replace(/[^\d.\-]/g, '')); return Number.isFinite(v) ? v : null; };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// symbol → instrument id from the latest trade-quotes page
async function instrumentIds() {
  for (let back = 0; back < 7; back++) {
    const d = new Date(Date.now() - 5 * 3600e3 - back * 864e5); if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    const html = await getText(`https://www.jamstockex.com/trading/trade-quotes/?market=50&date=${d.toISOString().slice(0, 10)}`, 40000);
    const out = {};
    for (const tr of html.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const id = (tr.match(/instrument=(\d+)/) || [])[1]; if (!id) continue;
      const cells = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => htmlToText(c));
      const sym = cells.find((c) => /^[A-Z0-9.]{2,12}$/.test(c));
      if (sym && !out[sym]) out[sym] = id;
    }
    if (Object.keys(out).length > 20) return out;
    await sleep(2500);
  }
  throw new Error('could not map symbols to instrument pages');
}

function parseTables(html) {
  return html.split(/<table/i).slice(1).map((tb) => (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []).map((tr) => (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map((c) => htmlToText(c))));
}
export function parseInstrument(html) {
  const text = htmlToText(html);
  const tabs = parseTables(html);
  const q = tabs.find((t) => /financial year/i.test(t[0]?.[0] || '') && t[0].length >= 5);
  const a = tabs.find((t) => /^year$/i.test(t[0]?.[0] || '') && /annual/i.test(t[0]?.[1] || ''));
  const dv = tabs.find((t) => /record date/i.test(t[0]?.[0] || ''));
  const quarters = {}; for (const r of (q || []).slice(1)) if (/^\d{4}$/.test(r[0])) quarters[r[0]] = r.slice(1, 5).map(num);
  const annual = {}; for (const r of (a || []).slice(1)) if (/^\d{4}$/.test(r[0])) annual[r[0]] = num(r[1]);
  const dividends = []; for (const r of (dv || []).slice(1)) {
    const m = (r[4] || '').match(/([A-Z]{3})\s*([\d.]+)/); if (!m || !/dividend/i.test(r[1] || '')) continue;
    dividends.push({ ex: r[2] || r[0], cur: m[1], amt: +m[2] });
  }
  const shares = num((text.match(/Shares Outstanding:\s*([\d,]+)/i) || [])[1]);
  const mval = num((text.match(/Market Value of Shares Outstanding:\s*\$?([\d,.]+)/i) || [])[1]);
  // fiscal year end, from report titles like "...year-ended-march-31-2026"
  let fye = null; const ye = html.match(/year-ended-([a-z]+)-\d{1,2}-(\d{4})/i) || text.match(/year ended ([A-Za-z]+) \d{1,2},? (\d{4})/i);
  if (ye) { const mi = MONTHS.indexOf(ye[1].toLowerCase()); if (mi >= 0) fye = { month: mi + 1, label: +ye[2] }; }
  if (!fye) { const qe = html.match(/(first|second|third|fourth)-quarter-ended-([a-z]+)-\d{1,2}-(\d{4})/i);
    if (qe) { const qi = ['first', 'second', 'third', 'fourth'].indexOf(qe[1].toLowerCase()); const mi = MONTHS.indexOf(qe[2].toLowerCase()); if (mi >= 0) fye = { month: ((mi + (3 - qi) * 3) % 12) + 1, fromQuarter: true }; } }
  const name = (text.match(/Instrument Summary\s+(?:Instrument Summary\s+)?([A-Z0-9 .&'()-]{4,80}?)\s+\(/) || [])[1] || null;
  return { name, quarters, annual, dividends, shares, mval, fye };
}

const ids = await instrumentIds();
console.log('instruments mapped:', Object.keys(ids).length);
let got = 0; let skipped = 0;
for (const [sym, id] of Object.entries(ids)) {
  const old = F.stocks[sym];
  if (old?.at && (Date.now() - Date.parse(old.at)) / 864e5 < MAX_AGE_D) { skipped++; continue; }
  try {
    const p = parseInstrument(await getText(`https://www.jamstockex.com/trading/instruments/?instrument=${id}`, 40000));
    if (Object.keys(p.quarters).length || p.dividends.length || p.shares) { F.stocks[sym] = { ...p, id, at: new Date().toISOString() }; got++; }
  } catch (e) {
    const msg = String(e.message || e); console.log('fail', sym, msg.slice(0, 80));
    if (/HTTP (403|429|503)/.test(msg)) { console.log('JSE site is rate-limiting; stopping politely'); break; }
  }
  await sleep(2500);
}
F.updated = new Date().toISOString();
fs.mkdirSync('data', { recursive: true });
fs.writeFileSync(FILE, JSON.stringify(F));
const withQ = Object.values(F.stocks).filter((s) => Object.keys(s.quarters).length).length;
const withF = Object.values(F.stocks).filter((s) => s.fye).length;
console.log(`FUND updated ${got}, fresh ${skipped}; ${Object.keys(F.stocks).length} stocks, ${withQ} with quarterly profit, ${withF} with fiscal year-end`);
