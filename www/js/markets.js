// Markets: live JSE quotes for an on-device trend picker, TradingView chart symbols, and global news relevant to Jamaica.
import { getText, htmlToText, parseRSS } from './util.js';

// ---------- JSE Trade Quotes ----------
const num = (s) => { const v = parseFloat(String(s).replace(/[,$*\s]/g, '')); return Number.isFinite(v) ? v : null; };
export function parseQuotes(html) {
  const out = {};
  for (const tb of html.split('<table').slice(1)) {
    const head = (tb.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || []).map((h) => htmlToText(h).toLowerCase());
    const iSym = head.findIndex((h) => h === 'symbol'); const iClose = head.findIndex((h) => h.startsWith('closing price'));
    if (iSym < 0 || iClose < 0) continue;
    const iChg = head.findIndex((h) => h.startsWith('price change')); const iVol = head.findIndex((h) => h === 'volume'); const i52 = head.findIndex((h) => h.startsWith('52 week'));
    for (const tr of tb.match(/<tr[\s\S]*?<\/tr>/g) || []) {
      const td = (tr.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || []).map((c) => htmlToText(c));
      if (td.length < head.length - 1) continue;
      const off = td.length === head.length ? 0 : td.length - head.length; // tolerate a leading icon cell
      const sym = td[iSym + off]; const close = num(td[iClose + off]);
      if (!sym || !/^[A-Z0-9.]{2,12}$/.test(sym) || close == null || out[sym]) continue;
      const r52 = (td[i52 + off] || '').match(/[\d.]+/g) || [];
      out[sym] = { close, chg: num(td[iChg + off]), vol: num(td[iVol + off]) || 0, lo52: r52[0] ? +r52[0] : null, hi52: r52[1] ? +r52[1] : null };
    }
  }
  return out;
}
const iso = (d) => d.toISOString().slice(0, 10);
export async function quotesOn(dateIso, maxBack = 5) {
  let d = new Date(`${dateIso}T12:00:00Z`);
  for (let i = 0; i <= maxBack; i++) {
    if (d.getUTCDay() === 0) d = new Date(d - 2 * 864e5); else if (d.getUTCDay() === 6) d = new Date(d - 864e5);
    const q = parseQuotes(await getText(`https://www.jamstockex.com/trading/trade-quotes/?market=50&date=${iso(d)}`, 40000));
    if (Object.keys(q).length > 20) return { date: iso(d), q };
    d = new Date(d - 864e5);
  }
  return null;
}
export async function jseQuotes() {
  const r = await quotesOn(iso(new Date()));
  if (!r) throw new Error('No JSE quotes found for recent days');
  return r;
}

// Rank from accumulated history: { 'YYYY-MM-DD': { SYM: close } }
export function rankStocks(latest, hist) {
  if (!latest) return { rows: [], basis: null };
  const dates = Object.keys(hist).sort();
  const near = (daysAgo) => {
    const target = iso(new Date(new Date(`${latest.date}T12:00:00Z`) - daysAgo * 864e5));
    let best = null; for (const d of dates) { if (d <= target) best = d; }
    if (!best) return null;
    const gap = (new Date(`${target}T12:00:00Z`) - new Date(`${best}T12:00:00Z`)) / 864e5;
    return gap <= 20 ? best : null;
  };
  const d3 = near(91); const d6 = near(182); const d12 = near(365);
  const rows = Object.entries(latest.q).map(([sym, x]) => {
    const p = (d) => (d && hist[d]?.[sym] ? (x.close / hist[d][sym] - 1) * 100 : null);
    const offHigh = x.hi52 ? (x.close / x.hi52 - 1) * 100 : null;
    return { sym, ...x, m3: p(d3), m6: p(d6), m12: p(d12), offHigh };
  });
  const key = d6 ? 'm6' : d3 ? 'm3' : null;
  const ranked = key ? rows.filter((r) => r[key] != null) : rows.filter((r) => r.offHigh != null);
  ranked.sort((a, b) => (key ? b[key] - a[key] : b.offHigh - a.offHigh));
  return { rows: ranked, all: rows, basis: key || 'offHigh', dates: { d3, d6, d12 } };
}

// ---------- TradingView symbols (charts load live from TradingView inside the app) ----------
export const TV_SYMBOLS = [
  ['S&P 500 (SPY)', 'AMEX:SPY'], ['Nasdaq 100 (QQQ)', 'NASDAQ:QQQ'], ['Apple', 'NASDAQ:AAPL'], ['Microsoft', 'NASDAQ:MSFT'], ['Nvidia', 'NASDAQ:NVDA'],
  ['Amazon', 'NASDAQ:AMZN'], ['Alphabet', 'NASDAQ:GOOGL'], ['Meta', 'NASDAQ:META'], ['Tesla', 'NASDAQ:TSLA'], ['Berkshire B', 'NYSE:BRK.B'],
  ['JPMorgan', 'NYSE:JPM'], ['Visa', 'NYSE:V'], ['Royal Caribbean', 'NYSE:RCL'], ['Marriott', 'NASDAQ:MAR'],
];
export function tvUrl(symbol, interval = 'D', theme = 'light') {
  const p = new URLSearchParams({ symbol, interval, hidesidetoolbar: '0', symboledit: '1', saveimage: '0', theme, style: '1', timezone: 'America/Jamaica', locale: 'en',
    studies: JSON.stringify(['RSI@tv-basicstudies', 'MAExp@tv-basicstudies']), withdateranges: '1', allow_symbol_change: '1' });
  return `https://s.tradingview.com/widgetembed/?${p}`;
}

// ---------- Global news with Jamaica-relevance tags ----------
const FEEDS = [
  ['BBC Business', 'https://feeds.bbci.co.uk/news/business/rss.xml'], ['CNBC', 'https://www.cnbc.com/id/100727362/device/rss/rss.html'],
  ['FT', 'https://www.ft.com/world?format=rss'], ['Guardian Economics', 'https://www.theguardian.com/business/economics/rss'],
  ['NPR Economy', 'https://feeds.npr.org/1017/rss.xml'], ['MarketWatch', 'https://feeds.marketwatch.com/marketwatch/topstories/'], ['OilPrice', 'https://oilprice.com/rss/main'],
];
export const GLOBAL_TAGS = [
  ['Oil & energy', /\boil\b|opec|crude|brent|gasoline|natural gas|lng\b|energy price/i, 'Fuel is about a fifth of Jamaica’s imports — moves hit pump prices, JPS bills and the JMD.'],
  ['Interest rates', /\bfed\b|federal reserve|interest rates?|rate (cut|hike|rise)|raise rates|treasury yield|powell|bond yield|central bank|bank of england|ecb\b/i, 'Global rate moves — above all the US Fed — set the pull on money leaving JMD assets and the BOJ’s room to cut.'],
  ['US jobs & consumers', /jobs report|payroll|unemployment|layoff|consumer (spending|confidence|sentiment)|recession|retail sales/i, 'US paycheques fund most remittances and stopover visits to Jamaica.'],
  ['Trade & tariffs', /tariff|trade war|sanction|export ban|import dut/i, 'Tariffs and trade rules change the cost of goods Jamaica imports from the US and China.'],
  ['Travel & tourism', /airline|cruise|tourism|travel|hotel|flights?\b/i, 'Tourism is Jamaica’s biggest earner of US dollars.'],
  ['Migration & remittances', /remittance|migrant|immigration|deport|diaspora|visa/i, 'Diaspora income and US immigration policy shape remittance flows.'],
  ['Food & commodities', /wheat|corn|maize|grain|food price|fertili[sz]er|soy|sugar|coffee|cocoa/i, 'Jamaica imports most staples — world food prices reach shelves in months.'],
  ['Shipping', /shipping|freight|container|\bports?\b|suez|panama canal|red sea/i, 'Freight costs feed into the landed cost of nearly everything imported.'],
  ['Dollar & gold', /\bdollar\b|currency|forex|\bgold\b|yen|euro\b/i, 'A stronger US dollar adds pressure on the JMD.'],
  ['Weather & climate', /hurricane|storm|climate|drought|flood/i, 'Storms and drought hit farming, tourism and insurance costs.'],
  ['China & global growth', /china|global growth|imf|world bank|gdp/i, 'Global growth drives demand for tourism and commodities like alumina.'],
  ['Markets & crypto', /stocks?|s&p|dow|nasdaq|bitcoin|crypto|market (rally|sell)/i, 'Global markets move Jamaican investors’ USD portfolios and risk appetite.'],
];
export async function globalNews() {
  const res = await Promise.allSettled(FEEDS.map(([, u]) => getText(u)));
  const items = [];
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const it of parseRSS(r.value).slice(0, 25)) {
      const t = Date.parse(it.pubDate); const body = htmlToText(it.description || '');
      const inTitle = GLOBAL_TAGS.filter(([, re]) => re.test(it.title)).map(([n]) => n);
      const inBody = GLOBAL_TAGS.filter(([n, re]) => n !== 'Markets & crypto' && n !== 'Dollar & gold' && !inTitle.includes(n) && re.test(body)).map(([n]) => n);
      const tags = [...inTitle, ...inBody];
      items.push({ source: FEEDS[i][0], title: it.title, link: it.link, ts: Number.isNaN(t) ? 0 : t, tags });
    }
  });
  if (!items.length) throw new Error('No global feeds responded');
  const seen = new Set();
  return { items: items.filter((x) => (seen.has(x.title.toLowerCase()) ? false : seen.add(x.title.toLowerCase()))).sort((a, b) => b.ts - a.ts) };
}

// ---------- Timestral forecast helpers (data from the nightly GitHub job) ----------
// P(price >= target) at one forecast step, from that step's quantiles.
export function exceed(qs, levels, target) {
  const q = []; let m = -Infinity; for (const x of qs) { m = Math.max(m, x); q.push(m); }
  if (target <= q[0]) return 1 - levels[0];
  if (target >= q[q.length - 1]) return 1 - levels[levels.length - 1];
  for (let i = 1; i < q.length; i++) {
    if (target <= q[i]) { const f = q[i] === q[i - 1] ? 0 : (target - q[i - 1]) / (q[i] - q[i - 1]); return 1 - (levels[i - 1] + f * (levels[i] - levels[i - 1])); }
  }
  return 0.01;
}
// Apply the back-tested calibration map [[predicted, actual], ...] (piecewise linear, clamped).
export function calibrate(p, map) {
  if (!map?.length) return p;
  const pts = [[0, 0], ...map, [1, Math.max(map[map.length - 1][1], 0.99)]];
  for (let i = 1; i < pts.length; i++) if (p <= pts[i][0]) { const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; return y0 + (x1 === x0 ? 0 : ((p - x0) / (x1 - x0)) * (y1 - y0)); }
  return pts[pts.length - 1][1];
}
// Chance of touching the target within the horizon and the first forecast date it becomes more likely than not.
export function targetOdds(F, sym, target) {
  const s = F?.stocks?.[sym]; if (!s || !target) return null;
  const up = target >= s.close;
  const probs = s.q.map((qs) => (up ? exceed(qs, F.levels, target) : 1 - exceed(qs, F.levels, target)));
  let best = 0; let bestI = 0; probs.forEach((p, i) => { if (p > best) { best = p; bestI = i; } });
  const firstI = probs.findIndex((p) => p >= 0.5);
  return {
    raw: best, p: up ? calibrate(best, F.calibration) : best, bestDate: F.dates[bestI],
    likelyDate: firstI >= 0 ? F.dates[firstI] : null, probs, up,
  };
}
export const fcAt = (F, sym, lvl, step = -1) => { const s = F?.stocks?.[sym]; if (!s) return null; const q = s.q[step < 0 ? s.q.length + step : step]; return q[F.levels.indexOf(lvl)]; };
export const fcChange = (F, sym) => { const s = F?.stocks?.[sym]; const m = fcAt(F, sym, 0.5); return s && m != null ? (m / s.close - 1) * 100 : null; };
export const hypeLabel = (h) => (h == null ? null : h >= 55 ? ['Speculative', 'bad'] : h >= 30 ? ['Heating up', 'warn'] : ['Calm', 'good']);
