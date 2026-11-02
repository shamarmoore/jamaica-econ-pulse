// Every data source the app scrapes, straight from the publisher. Each fetcher returns plain JSON
// so results can be cached on the phone. If a publisher changes its page, only that card goes stale.
import { getText, getJSON, htmlToText, after, firstNumber, parseRSS, MONTH_YEAR, DAY_MONTH_YEAR, isoDaysAgo } from './util.js';

// ---------- Bank of Jamaica ----------
async function boj() {
  const out = { fx: {} };
  // FX: BOJ's own daily rates feed (most stable), homepage as fallback.
  try {
    const xml = await getText('https://boj.org.jm/feed/?feed=fxrates');
    const item = parseRSS(xml)[0];
    if (item) {
      const txt = htmlToText(item.description);
      for (const c of ['USD', 'CAD', 'GBP', 'EUR']) {
        const m = new RegExp(`${c}[^0-9]{0,60}?(\\d+\\.\\d+)[^0-9]{1,60}?(\\d+\\.\\d+)`).exec(txt);
        if (m) out.fx[c] = { buy: +m[1], sell: +m[2] };
      }
      const d = /(\d{4}-\d{2}-\d{2})/.exec(item.title);
      out.fxDate = d ? d[1] : null;
    }
  } catch (e) { out.fxError = String(e.message || e); }

  const html = await getText('https://boj.org.jm/');
  const t = htmlToText(html);

  const inf = after(t, /Inflation Rate/i, 120);
  out.inflation = firstNumber(inf, { percent: true });
  out.inflationPeriod = inf && (MONTH_YEAR.exec(inf) || [null])[0];

  const pr = after(t, /Policy Interest Rate/i, 160);
  out.policyRate = firstNumber(pr, { percent: true });
  out.policyDate = pr && (DAY_MONTH_YEAR.exec(pr) || [null])[0];
  const nx = pr && /Next:?\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/i.exec(pr);
  out.nextPolicyDate = nx ? nx[1] : null;

  const tg = after(t, /Inflation Target/i, 60);
  const tm = tg && /(\d+(?:\.\d+)?)\s*[–-]\s*(\d+(?:\.\d+)?)\s*%/.exec(tg);
  out.target = tm ? [+tm[1], +tm[2]] : [4, 6];

  if (!out.fx.USD) {
    for (const c of ['USD', 'CAD', 'GBP', 'EUR']) {
      const w = after(t, new RegExp(`\\b${c}\\b`), 60);
      const nums = w && w.match(/\d+\.\d+/g);
      if (nums && nums.length >= 2) out.fx[c] = { buy: +nums[0], sell: +nums[1] };
    }
  }
  if (out.inflation == null && out.policyRate == null && !out.fx.USD) throw new Error('BOJ page layout not recognised');
  return out;
}

// ---------- STATIN ----------
const STATIN_FIELDS = [
  ['cpiPtp', /CPI Point to Point Rate(?:\s*\(%\))?/i, true],
  ['cpiMonthly', /CPI Monthly Inflation Rate(?:\s*\(%\))?/i, true],
  ['cpiCalYtd', /CPI Calendar Year-to-Date Inflation Rate(?:\s*\(%\))?/i, true],
  ['cpiFisYtd', /CPI Fiscal Year-to-Date Inflation Rate(?:\s*\(%\))?/i, true],
  ['cpiIndex', /\bCPI(?=\s+\d)/, false],
  ['participation', /Labour Force Participation Rate/i, true],
  ['employmentRatio', /Employment to Population Ratio/i, true],
  ['unemployment', /Unemployment Rate\s*\(LU1\)/i, true],
  ['lu4', /labour underutilization\s*\(LU4\)/i, true],
  ['youthUnemployment', /Youth Unemployment Rate/i, true],
  ['neet', /\(NEET\) Rate/i, true],
  ['ppiMining', /PPI Mining\s*&?\s*(?:and\s*)?Quarrying/i, false],
  ['ppiManufacturing', /PPI Manufacturing/i, false],
  ['exports', /IMTS Exports(?:\s*\(US\$\s*000\))?/i, false],
  ['imports', /IMTS Imports(?:\s*\(US\$\s*000\))?/i, false],
  ['gdpGrowth', /GDP Rate of Growth[^%]*?Prices(?:\s*Seasonally\s*Unadjusted)?(?:\s*\(%\))?/i, true],
];
async function statin() {
  const t = htmlToText(await getText('https://statinja.gov.jm/'));
  const out = {};
  for (const [key, re, pct] of STATIN_FIELDS) {
    const w = after(t, re, 90);
    if (!w) continue;
    const v = firstNumber(w, { percent: pct }) ?? (pct ? firstNumber(w) : null);
    if (v == null) continue;
    const per = /(?:[A-Z][a-z]{2,8}\s*[-–]\s*[A-Z][a-z]{2,8}\s+\d{4})/.exec(w) || MONTH_YEAR.exec(w);
    out[key] = { value: v, period: per ? per[0] : null };
  }
  if (Object.keys(out).length < 3) throw new Error('STATIN page layout not recognised');
  return out;
}

// ---------- IMF World Economic Outlook (DataMapper API) ----------
const IMF_IND = {
  NGDP_RPCH: 'Real GDP growth (%)',
  PCPIPCH: 'Inflation, avg (%)',
  LUR: 'Unemployment (%)',
  GGXWDG_NGDP: 'Govt debt (% of GDP)',
  BCA_NGDPD: 'Current account (% of GDP)',
  GGXCNL_NGDP: 'Fiscal balance (% of GDP)',
};
async function imf() {
  const out = { labels: IMF_IND, series: {} };
  const ids = Object.keys(IMF_IND);
  const results = await Promise.allSettled(ids.map((id) =>
    getJSON(`https://www.imf.org/external/datamapper/api/v1/${id}/JAM/USA/CAN/GBR`)));
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const vals = r.value?.values?.[ids[i]] || {};
    for (const c of ['JAM', 'USA', 'CAN', 'GBR']) {
      if (!vals[c]) continue;
      out.series[`${ids[i]}:${c}`] = Object.entries(vals[c])
        .map(([y, v]) => ({ year: +y, value: +v })).filter((p) => p.year >= 2015).sort((a, b) => a.year - b.year);
    }
  });
  if (!Object.keys(out.series).length) throw new Error('IMF API returned nothing');
  return out;
}

// ---------- World Bank (structural exposure of Jamaica) ----------
const WB_IND = {
  'BX.TRF.PWKR.DT.GD.ZS': 'Remittances received (% of GDP)',
  'ST.INT.RCPT.XP.ZS': 'Tourism receipts (% of exports)',
  'FI.RES.TOTL.MO': 'Reserves (months of imports)',
  'TM.VAL.FUEL.ZS.UN': 'Fuel (% of merchandise imports)',
  'TM.VAL.FOOD.ZS.UN': 'Food (% of merchandise imports)',
  'NE.IMP.GNFS.ZS': 'Imports (% of GDP)',
  'BX.KLT.DINV.WD.GD.ZS': 'FDI net inflows (% of GDP)',
  'GC.DOD.TOTL.GD.ZS': 'Central govt debt (% of GDP)',
};
async function worldbank() {
  const out = { labels: WB_IND, latest: {} };
  const ids = Object.keys(WB_IND);
  const results = await Promise.allSettled(ids.map((id) =>
    getJSON(`https://api.worldbank.org/v2/country/JM/indicator/${id}?format=json&per_page=15`)));
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled' || !Array.isArray(r.value) || !Array.isArray(r.value[1])) return;
    const rows = r.value[1].filter((x) => x.value != null);
    if (rows.length) out.latest[ids[i]] = { value: +rows[0].value, year: +rows[0].date };
  });
  if (!Object.keys(out.latest).length) throw new Error('World Bank API returned nothing');
  return out;
}

// ---------- FRED (external drivers) ----------
export const FRED = {
  DCOILBRENTEU: { label: 'Brent crude', unit: 'US$/bbl', years: 2 },
  DHHNGSP: { label: 'US natural gas (Henry Hub)', unit: 'US$/MMBtu', years: 2 },
  FEDFUNDS: { label: 'US Fed funds rate', unit: '%', years: 4 },
  DGS10: { label: 'US 10-yr Treasury yield', unit: '%', years: 2 },
  UNRATE: { label: 'US unemployment', unit: '%', years: 4 },
  CPIAUCSL: { label: 'US CPI index', unit: 'index', years: 5 },
  UMCSENT: { label: 'US consumer sentiment', unit: 'index', years: 4 },
  DTWEXBGS: { label: 'US dollar index (broad)', unit: 'index', years: 2 },
  PFOODINDEXM: { label: 'Global food price index', unit: 'index', years: 4 },
  PWHEAMTUSDM: { label: 'Wheat', unit: 'US$/t', years: 4 },
  PMAIZMTUSDM: { label: 'Maize (corn)', unit: 'US$/t', years: 4 },
};
function parseFredCSV(csv) {
  const lines = String(csv).trim().split(/\r?\n/);
  const pts = [];
  for (let i = 1; i < lines.length; i++) {
    const [d, v] = lines[i].split(',');
    const n = parseFloat(v);
    if (d && !Number.isNaN(n)) pts.push({ date: d.trim(), value: n });
  }
  return pts;
}
async function fred() {
  const out = { series: {}, failed: [] };
  const ids = Object.keys(FRED);
  const results = await Promise.allSettled(ids.map((id) =>
    getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${isoDaysAgo(365 * FRED[id].years)}`)));
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const s = parseFredCSV(r.value);
      if (s.length) { out.series[ids[i]] = s; return; }
    }
    out.failed.push(ids[i]);
  });
  if (!Object.keys(out.series).length) throw new Error('FRED returned nothing');
  return out;
}

// ---------- Exchange rate history (USD→JMD, plus crosses) ----------
async function fxRate(date) {
  const tag = date || 'latest';
  const urls = [
    `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/usd.min.json`,
    `https://${tag}.currency-api.pages.dev/v1/currencies/usd.min.json`,
  ];
  for (const u of urls) {
    try { const j = await getJSON(u); if (j?.usd?.jmd) return { date: j.date, jmd: j.usd.jmd, cad: j.usd.cad, gbp: j.usd.gbp, eur: j.usd.eur }; } catch (_) { /* try next */ }
  }
  return null;
}
async function fx() {
  const out = { history: [] };
  try {
    const j = await getJSON('https://open.er-api.com/v6/latest/USD');
    if (j?.rates?.JMD) out.now = { date: new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10), jmd: j.rates.JMD, cad: j.rates.CAD, gbp: j.rates.GBP, eur: j.rates.EUR };
  } catch (_) { /* fall back below */ }
  const back = [30, 90, 180, 365];
  const hist = await Promise.all(back.map((d) => fxRate(isoDaysAgo(d))));
  hist.forEach((h, i) => { if (h) out.history.push({ daysAgo: back[i], ...h }); });
  if (!out.now) out.now = await fxRate(null);
  if (!out.now) throw new Error('No exchange-rate source responded');
  return out;
}

// ---------- NOAA National Hurricane Center ----------
async function hurricanes() {
  const items = parseRSS(await getText('https://www.nhc.noaa.gov/index-at.xml'));
  const storms = new Map();
  let outlook = null; let maxChance = 0; let jamaicaMention = false;
  for (const it of items) {
    const desc = htmlToText(it.description);
    if (/Tropical Weather Outlook/i.test(it.title)) {
      outlook = desc.replace(/^.*?(For the North Atlantic)/i, '$1').slice(0, 600);
      for (const m of desc.matchAll(/(\d{1,3})\s*percent/gi)) maxChance = Math.max(maxChance, +m[1]);
      continue;
    }
    if (/no tropical cyclones/i.test(it.title)) continue;
    const m = /(Hurricane|Tropical Storm|Tropical Depression|Potential Tropical Cyclone|Subtropical Storm|Post-Tropical Cyclone)\s+([A-Za-z-]+(?:\s+[A-Z][a-z]+)?)/.exec(it.title);
    if (m) {
      const key = `${m[1]} ${m[2]}`.replace(/\s+(Public|Forecast|Intermediate|Graphics|Wind|Advisory|Discussion|Summary).*$/i, '');
      const mentions = /jamaica/i.test(desc) || /jamaica/i.test(it.title);
      jamaicaMention = jamaicaMention || mentions;
      const prev = storms.get(key) || { name: key, link: it.link, jamaica: false };
      prev.jamaica = prev.jamaica || mentions;
      storms.set(key, prev);
    }
  }
  return { storms: [...storms.values()], outlook, maxChance, jamaicaMention, checked: new Date().toISOString() };
}

// ---------- Local business news ----------
async function news() {
  const feeds = [
    ['Gleaner', 'https://jamaica-gleaner.com/feed/business.xml'],
    ['Observer', 'https://www.jamaicaobserver.com/category/business/feed/'],
  ];
  const res = await Promise.allSettled(feeds.map(([, u]) => getText(u)));
  const items = [];
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const it of parseRSS(r.value).slice(0, 30)) {
      const t = Date.parse(it.pubDate);
      items.push({ source: feeds[i][0], title: it.title, link: it.link.replace(/^http:/, 'https:'), ts: Number.isNaN(t) ? 0 : t });
    }
  });
  if (!items.length) throw new Error('No news feeds responded');
  items.sort((a, b) => b.ts - a.ts);
  return { items };
}

export const SOURCES = [
  { id: 'boj', name: 'Bank of Jamaica', home: 'https://boj.org.jm/', scope: 'Jamaica', what: 'Inflation, policy rate, official FX rates', fn: boj, ttlH: 6 },
  { id: 'statin', name: 'STATIN', home: 'https://statinja.gov.jm/', scope: 'Jamaica', what: 'CPI, labour force, GDP, trade, PPI', fn: statin, ttlH: 12 },
  { id: 'imf', name: 'IMF World Economic Outlook', home: 'https://www.imf.org/external/datamapper/profile/JAM', scope: 'Jamaica + partners', what: 'Growth, inflation, debt, current account — history & projections', fn: imf, ttlH: 72 },
  { id: 'worldbank', name: 'World Bank', home: 'https://data.worldbank.org/country/jamaica', scope: 'Jamaica', what: 'Structural exposure: remittances, tourism, reserves, import mix', fn: worldbank, ttlH: 168 },
  { id: 'fred', name: 'FRED (St. Louis Fed)', home: 'https://fred.stlouisfed.org/', scope: 'World', what: 'Oil, gas, US rates & jobs, US inflation, food & grain prices', fn: fred, ttlH: 12 },
  { id: 'fx', name: 'Exchange-rate APIs', home: 'https://www.exchangerate-api.com/', scope: 'Jamaica', what: 'USD/JMD now and 1–12 months ago', fn: fx, ttlH: 6 },
  { id: 'nhc', name: 'NOAA Hurricane Center', home: 'https://www.nhc.noaa.gov/', scope: 'World', what: 'Active Atlantic storms & 7-day outlook', fn: hurricanes, ttlH: 1 },
  { id: 'news', name: 'Gleaner & Observer', home: 'https://jamaica-gleaner.com/business', scope: 'Jamaica', what: 'Business headlines', fn: news, ttlH: 2 },
];
