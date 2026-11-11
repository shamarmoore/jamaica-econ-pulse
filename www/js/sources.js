import { BUILT_IN_GH_TOKEN } from './config.js';
import { research } from './research.js';
// Every data source the app scrapes, straight from the publisher. Each fetcher returns plain JSON
// so results can be cached on the phone. If a publisher changes its page, only that card goes stale.
import { listings as scrapeListings, analystJobs } from './homes.js';
import { carListings } from './cars.js';
import { jseQuotes, globalNews } from './markets.js';
import { getText, getJSON, getBinary, htmlToText, after, firstNumber, parseRSS, MONTH_YEAR, DAY_MONTH_YEAR, isoDaysAgo } from './util.js';

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

  let t = '';
  try { t = htmlToText(await getText('https://boj.org.jm/')); } catch (e) {
    if (!out.fx.USD) throw e;
    out.homeError = String(e.message || e);
  }

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
// Run async jobs a few at a time — phones choke on many parallel requests to one host.
export async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = { ok: true, v: await fn(items[k], k) }; } catch (e) { out[k] = { ok: false, e }; } }
  }));
  return out;
}
const errText = (e) => String(e?.message || e || 'no response').slice(0, 90);

// IMF's official data API (SDMX). The older DataMapper API refuses phone connections (HTTP 403).
const CTRY = ['JAM', 'USA', 'CAN', 'GBR'];
export function parseSdmx(xml) {
  const out = {}; const attr = (s, k) => (new RegExp(`\\b${k}="([^"]*)"`).exec(s) || [])[1];
  const re = /<Series\b([^>]*)>([\s\S]*?)<\/Series>/g; let m;
  while ((m = re.exec(xml))) {
    const c = attr(m[1], 'COUNTRY'); const ind = attr(m[1], 'INDICATOR'); if (!c || !ind) continue;
    const pts = [...m[2].matchAll(/<Obs\b([^>]*)\/?>/g)].map((o) => ({ year: +attr(o[1], 'TIME_PERIOD'), value: parseFloat(attr(o[1], 'OBS_VALUE')) }))
      .filter((p) => p.year >= 2015 && Number.isFinite(p.value)).sort((a, b) => a.year - b.year);
    if (pts.length) out[`${ind}:${c}`] = pts;
  }
  const pub = /PUBLICATION_DATE="(\d{4}-\d{2})/.exec(xml);
  return { series: out, edition: pub ? pub[1] : null };
}
async function imf() {
  const out = { labels: IMF_IND, series: {} };
  const ids = Object.keys(IMF_IND); let why = '';
  try {
    const xml = await getText(`https://api.imf.org/external/sdmx/2.1/data/IMF.RES,WEO/${CTRY.join('+')}.${ids.join('+')}.A?startPeriod=2015`, 30000, { Accept: 'application/xml' });
    const p = parseSdmx(xml); out.series = p.series; out.edition = p.edition;
  } catch (e) { why = `api.imf.org: ${errText(e)}`; }
  if (!Object.keys(out.series).length) {
    // fallback: the DataMapper API (works from some networks)
    const results = await pool(ids, 2, (id) => getJSON(`https://www.imf.org/external/datamapper/api/v1/${id}/${CTRY.join('/')}`, 15000));
    results.forEach((r, i) => {
      if (!r.ok) return;
      const vals = r.v?.values?.[ids[i]] || {};
      for (const c of CTRY) {
        if (!vals[c]) continue;
        out.series[`${ids[i]}:${c}`] = Object.entries(vals[c]).map(([y, v]) => ({ year: +y, value: +v })).filter((p) => p.year >= 2015).sort((a, b) => a.year - b.year);
      }
    });
    if (!Object.keys(out.series).length) throw new Error(`${why || 'api.imf.org returned no series'}; DataMapper: ${errText(results.find((r) => !r.ok)?.e)}`);
  }
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
  PALUMUSDM: { label: 'Aluminium', unit: 'US$/t', years: 4 },
  PCU483111483111: { label: 'Deep-sea freight cost index', unit: 'index', years: 4 },
  VIXCLS: { label: 'Market fear gauge (VIX)', unit: 'index', years: 2 },
  BAMLEMHBHYCRPIOAS: { label: 'Emerging-market high-yield spread', unit: '%', years: 2 },
  SP500: { label: 'US stocks (S&P 500)', unit: 'index', years: 2 },
  DTB3: { label: 'US 3-month T-bill', unit: '%', years: 2 },
  LRUNTTTTCAM156S: { label: 'Canada unemployment', unit: '%', years: 4 },
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
// Nightly JSE forecasts (Timestral) live in the user's private GitHub repo; read with their read-only token.
const GH_KEY = 'ep_ghtoken_v1';
export const ghToken = {
  // a token typed into Sources wins; otherwise the one built into the APK; otherwise (tests) an env variable
  get() { try { return (globalThis.localStorage?.getItem(GH_KEY) || BUILT_IN_GH_TOKEN || globalThis.process?.env?.GH_READ_TOKEN || '').trim(); } catch (_) { return ''; } },
  builtIn: () => !!BUILT_IN_GH_TOKEN,
  set(v) { try { globalThis.localStorage?.setItem(GH_KEY, String(v || '').trim()); } catch (_) { /* ignore */ } },
};
export const FORECAST_REPO = 'shamarmoore/jamaica-econ-pulse';
async function jseForecasts() {
  const tok = ghToken.get();
  if (!tok) throw new Error('Add your read-only GitHub token under Sources to load stock forecasts.');
  const txt = await getText(`https://api.github.com/repos/${FORECAST_REPO}/contents/data/forecasts.json?ref=main`, 30000,
    { Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' });
  const j = JSON.parse(txt);
  if (!j?.stocks || !Object.keys(j.stocks).length) throw new Error('Forecast file is empty — the nightly job may not have run yet.');
  return j;
}

// FRED's official API needs a free personal key (fredaccount.stlouisfed.org/apikeys). Without one we try
// FRED's public CSV download, which works from many networks but is refused on some phone connections.
const FRED_KEY = 'ep_fredkey_v1';
export const fredKey = {
  get() { try { return (globalThis.localStorage?.getItem(FRED_KEY) || globalThis.process?.env?.FRED_API_KEY || '').trim(); } catch (_) { return ''; } },
  set(v) { try { globalThis.localStorage?.setItem(FRED_KEY, String(v || '').trim()); } catch (_) { /* ignore */ } },
};
async function fredApi(id, key) {
  const j = await getJSON(`https://api.stlouisfed.org/fred/series/observations?series_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&observation_start=${isoDaysAgo(365 * FRED[id].years)}`, 20000);
  return (j.observations || []).map((o) => ({ date: o.date, value: parseFloat(o.value) })).filter((p) => Number.isFinite(p.value));
}
async function fred() {
  const out = { series: {}, failed: [] };
  const ids = Object.keys(FRED); const key = fredKey.get();
  const csv = async (id) => parseFredCSV(await getText(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=${isoDaysAgo(365 * FRED[id].years)}`, 12000));
  let results;
  if (key) { results = await pool(ids, 4, (id) => fredApi(id, key)); out.via = 'FRED API'; }
  else {
    // one quick test first so a blocked connection fails in seconds, not minutes
    let first;
    try { first = await csv(ids[0]); } catch (e) { throw new Error(`FRED’s public download didn’t respond on this connection (${errText(e)}). Add a free FRED API key under Sources to use the official API.`); }
    results = [{ ok: true, v: first }, ...await pool(ids.slice(1), 4, csv)];
    out.via = 'FRED CSV';
  }
  results.forEach((r, i) => { if (r.ok && r.v?.length) out.series[ids[i]] = r.v; else out.failed.push(ids[i]); });
  if (!Object.keys(out.series).length) throw new Error(`FRED returned nothing (${errText(results.find((r) => !r.ok)?.e)})${key ? ' — check your API key under Sources' : ''}`);
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
    try { const j = await getJSON(u); if (j?.usd?.jmd) return { date: j.date, jmd: j.usd.jmd, cad: j.usd.cad, gbp: j.usd.gbp, eur: j.usd.eur, jpy: j.usd.jpy, xau: j.usd.xau }; } catch (_) { /* try next */ }
  }
  return null;
}
async function fx() {
  const out = { history: [] };
  try {
    const j = await getJSON('https://open.er-api.com/v6/latest/USD');
    if (j?.rates?.JMD) out.now = { date: new Date(j.time_last_update_unix * 1000).toISOString().slice(0, 10), jmd: j.rates.JMD, cad: j.rates.CAD, gbp: j.rates.GBP, eur: j.rates.EUR, jpy: j.rates.JPY };
  } catch (_) { /* fall back below */ }
  const back = [30, 90, 180, 365];
  const hist = await Promise.all(back.map((d) => fxRate(isoDaysAgo(d))));
  hist.forEach((h, i) => { if (h) out.history.push({ daysAgo: back[i], ...h }); });
  const latest = await fxRate(null);
  if (!out.now) out.now = latest;
  if (out.now && latest?.xau) out.now.xau = latest.xau;
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


// ---------- BOJ interest-rate tables (Excel) ----------
const excelDate = (n) => new Date(Date.UTC(1899, 11, 30) + n * 86400000).toISOString().slice(0, 10);
async function readSheet(path) {
  const X = await import('../vendor/xlsx.mjs');
  const wb = X.read(await getBinary(`https://boj.org.jm/wp-content/uploads/${path}`), { type: 'array' });
  return X.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
}
function columns(rows, wanted, months = 30) {
  const head = rows.slice(0, 20);
  const idx = {};
  for (const [key, re] of Object.entries(wanted)) {
    for (const r of head) { const i = r.findIndex((c) => re.test(String(c))); if (i >= 0) { idx[key] = i; break; } }
  }
  const data = rows.filter((r) => typeof r[0] === 'number' && r[0] > 30000).slice(-months);
  const out = {};
  for (const [key, i] of Object.entries(idx)) {
    out[key] = data.filter((r) => typeof r[i] === 'number').map((r) => ({ date: excelDate(r[0]), value: +r[i].toFixed(3) }));
  }
  return out;
}
async function bojRates() {
  const [loans, deps, bills, usd] = await Promise.allSettled([
    readSheet('2020/10/IR.CB.02.xls'), readSheet('2020/10/IR.CB.00.xls'), readSheet('2020/10/IR.GOJ.00.xlsx'),
    readSheet('2021/06/IR.CB.01-Commercial-Banks-Foreign-Currency-Deposit-Rates.xls')]);
  const out = {};
  if (loans.status === 'fulfilled') out.loans = columns(loans.value, { instalment: /^INSTALMENT/i, mortgage: /^MORTGAGE/i, personal: /^PERSONAL/i, commercial: /^COMMERCIAL/i, overall: /^OVERALL/i });
  if (deps.status === 'fulfilled') out.deposits = columns(deps.value, { savings: /^SAVINGS/i, time12: /^12 MONTHS/i, timeAvg: /^OVERALL TIME/i, overall: /^OVERALL DEPOSIT/i });
  if (bills.status === 'fulfilled') out.tbills = columns(bills.value, { m3: /^3 MONTHS/i, m6: /^6 MONTHS/i, m9: /^9 MONTHS/i });
  if (usd.status === 'fulfilled') out.usdDeposits = columns(usd.value, { time12: /^12 MONTHS/i, savings: /^SAVINGS/i, overall: /^OVERALL DEPOSIT/i });
  if (!out.loans?.instalment?.length && !out.deposits?.overall?.length && !out.tbills?.m3?.length) throw new Error('BOJ rate tables not readable');
  return out;
}

// ---------- BOJ Remittance Bulletin (PDF) ----------
async function remittances() {
  const media = await getJSON('https://boj.org.jm/wp-json/wp/v2/media?search=Remittance-Bulletin&per_page=1&orderby=date&order=desc');
  const url = media?.[0]?.source_url;
  if (!url) throw new Error('No bulletin found');
  const pdfjs = await import('../vendor/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
  const pdf = await pdfjs.getDocument({ data: await getBinary(url), useSystemFonts: true, verbosity: 0, isEvalSupported: false }).promise;
  let txt = '';
  for (let p = 1; p <= Math.min(3, pdf.numPages); p++) { const c = await (await pdf.getPage(p)).getTextContent(); txt += c.items.map((i) => i.str).join(' ') + ' '; }
  const c = txt.replace(/\s+/g, '');
  const m = /NetremittanceinflowsofUS\$([\d,.]+)millionfor([A-Z][a-z]+)(\d{4}),?represent(?:s|ed)?an?(increase|decline|decrease)of([\d.]+)percent/i.exec(c);
  if (!m) throw new Error('Bulletin wording not recognised');
  const us = /accountingfor([\d.]+)percentoftotal/i.exec(c);
  const fy = /FiscalYeartoDate\d{4}(?:\/\d{2})?:NetremittanceinflowsofUS\$([\d,.]+)millionrepresentedan?(increase|decline|decrease)ofUS\$[\d,.]+millionor([\d.]+)percent/i.exec(c);
  const sign = (w) => (/increase/i.test(w) ? 1 : -1);
  return {
    month: `${m[2]} ${m[3]}`, net: parseFloat(m[1].replace(/,/g, '')), yoy: sign(m[4]) * parseFloat(m[5]),
    usShare: us ? +us[1] : null, fytd: fy ? { net: parseFloat(fy[1].replace(/,/g, '')), yoy: sign(fy[2]) * parseFloat(fy[3]) } : null, url,
  };
}

// ---------- Tourism (JTB & airport figures via Tourism Analytics) ----------
async function tourism() {
  const t = htmlToText(await getText('https://www.tourismanalytics.com/jamaica-statistics.html'));
  const latest = (re) => {
    let best = null;
    for (const m of t.matchAll(re)) {
      const ts = Date.parse(`1 ${m[3]}`);
      if (!best || ts > best.ts) best = { ts, month: m[3], change: (/fewer/i.test(m[2]) ? -1 : 1) * parseFloat(m[1]) };
    }
    return best;
  };
  const out = {
    stopovers: latest(/Jamaica received ([\d.]+)% (fewer|more) stopover arrivals in ([A-Z][a-z]+ \d{4})/g),
    mbj: latest(/Montego Bay Airport handled ([\d.]+)% (fewer|more) passenger movements in ([A-Z][a-z]+ \d{4})/g),
    kin: latest(/Kingston Airport,? Jamaica handled ([\d.]+)% (fewer|more) passenger movements in ([A-Z][a-z]+ \d{4})/g),
  };
  if (!out.stopovers && !out.mbj) throw new Error('Tourism figures not found');
  return out;
}

// ---------- Petrojam weekly fuel prices ----------
const FUELS = ['Gasolene 87', 'Gasolene 90', 'Auto Diesel', 'ULSD', 'Propane', 'Butane', 'Kerosene'];
async function petrojam() {
  const t = htmlToText(await getText('https://www.petrojam.com/'));
  const weeks = [];
  for (const m of t.matchAll(/Prices Date:\s*([A-Z][a-z]+ \d{1,2}, \d{4})([\s\S]*?)(?=Prices Date:|Career|$)/g)) {
    const prices = {};
    for (const f of FUELS) { const v = new RegExp(`${f}\\s*\\$\\s*([\\d,.]+)`).exec(m[2]); if (v) prices[f] = parseFloat(v[1].replace(/,/g, '')); }
    if (Object.keys(prices).length) weeks.push({ date: new Date(Date.parse(`${m[1]} 12:00`)).toISOString().slice(0, 10), prices });
  }
  if (!weeks.length) throw new Error('Petrojam prices not found');
  weeks.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { weeks };
}


// ---------- Jamaica Stock Exchange ----------
async function jse() {
  const t = htmlToText(await getText('https://www.jamstockex.com/'));
  const out = { indices: {} };
  const names = { 'Main Index': 'main', 'Junior Market Index': 'junior', 'Combined Index': 'combined', 'JSE Select Index': 'select', 'US Equities': 'usd', 'Financial Index': 'financial' };
  for (const m of t.matchAll(/(Main Index|Junior Market Index|Combined Index|JSE Select Index|US Equities|Financial Index)\s+[\d,]+\s+Vol\s+([\d,]+\.\d+)\s+(-?[\d,]+\.\d+)/g)) {
    const v = parseFloat(m[2].replace(/,/g, '')); const ch = parseFloat(m[3].replace(/,/g, ''));
    out.indices[names[m[1]]] = { value: v, change: ch, pct: (ch / (v - ch)) * 100 };
  }
  const d = /Market (?:Closed|Open)\s+(\d{4}-\d{2}-\d{2})/.exec(t);
  out.date = d ? d[1] : new Date().toISOString().slice(0, 10);
  if (!out.indices.main && !out.indices.combined) throw new Error('JSE index layout not recognised');
  return out;
}

export const SOURCES = [
  { id: 'boj', name: 'Bank of Jamaica', home: 'https://boj.org.jm/', scope: 'Jamaica', what: 'Inflation, policy rate, official FX rates', fn: boj, ttlH: 6 },
  { id: 'statin', name: 'STATIN', home: 'https://statinja.gov.jm/', scope: 'Jamaica', what: 'CPI, labour force, GDP, trade, PPI', fn: statin, ttlH: 12 },
  { id: 'bojrates', name: 'BOJ interest-rate tables', home: 'https://boj.org.jm/statistics/interest-rates/', scope: 'Jamaica', what: 'Loan rates (vehicle, personal, mortgage), JMD & USD deposit rates, T-bill yields', fn: bojRates, ttlH: 24 },
  { id: 'remit', name: 'BOJ Remittance Bulletin', home: 'https://boj.org.jm/', scope: 'Jamaica', what: 'Monthly net remittance inflows and source countries', fn: remittances, ttlH: 24 },
  { id: 'tourism', name: 'Tourism Analytics (JTB & airport data)', home: 'https://www.tourismanalytics.com/jamaica-statistics.html', scope: 'Jamaica', what: 'Stopover arrivals and airport passenger movements, year-on-year', fn: tourism, ttlH: 24 },
  { id: 'jse', name: 'Jamaica Stock Exchange', home: 'https://www.jamstockex.com/', scope: 'Jamaica', what: 'Daily JSE Main, Junior, Combined and USD index closes', fn: jse, ttlH: 6 },
  { id: 'petrojam', name: 'Petrojam', home: 'https://www.petrojam.com/', scope: 'Jamaica', what: 'Weekly ex-refinery fuel prices', fn: petrojam, ttlH: 12 },
  { id: 'listings', name: 'Property listings (PropertyAdsJa, Gleaner Classifieds)', home: 'https://www.propertyadsja.com/', scope: 'Jamaica', what: 'Houses and land for sale in Kingston & St. Andrew, St. Thomas and St. Catherine', fn: async () => { let fx = 158; try { const j = await getJSON('https://open.er-api.com/v6/latest/USD'); fx = j.rates.JMD || fx; } catch (_) { /* default */ } return scrapeListings(fx); }, ttlH: 12 },
  { id: 'jobs', name: 'CaribbeanJobs', home: 'https://www.caribbeanjobs.com/analyst-jobs', scope: 'Jamaica', what: 'Job openings with “analyst” in the title', fn: analystJobs, ttlH: 8 },
  { id: 'cars', name: 'Car listings (AutoAdsJa, Gleaner Classifieds)', home: 'https://www.autoadsja.com/', scope: 'Jamaica', what: 'Recently posted Honda Civics and Toyota GT86s', fn: carListings, ttlH: 6 },
  { id: 'jsequotes', name: 'JSE Trade Quotes', home: 'https://www.jamstockex.com/trading/trade-quotes/', scope: 'Jamaica', what: 'Daily closing prices, volume and 52-week ranges for the stock picker', fn: jseQuotes, ttlH: 8 },
  { id: 'forecasts', name: 'JSE forecasts (Timestral, nightly)', home: `https://github.com/${FORECAST_REPO}/actions`, scope: 'Jamaica', what: '3-month price ranges, target odds and speculation scores for every JSE stock, made nightly on your GitHub', fn: jseForecasts, ttlH: 6, optional: true, outdated: (d) => !d?.edgeInfo },
  { id: 'research', name: 'Research papers (arXiv + OpenAlex)', home: 'https://openalex.org/', scope: 'Research', what: 'Recent papers on AI forecasting, logistics management and sales innovation', fn: research, ttlH: 24 },
  { id: 'gnews', name: 'Global news (BBC, CNBC, FT, Guardian, NPR, MarketWatch, OilPrice)', home: 'https://feeds.bbci.co.uk/news/business/', scope: 'World', what: 'World business & economy headlines tagged by how they reach Jamaica', fn: globalNews, ttlH: 2 },
  { id: 'imf', name: 'IMF World Economic Outlook', home: 'https://www.imf.org/external/datamapper/profile/JAM', scope: 'Jamaica + partners', what: 'Growth, inflation, debt, current account — history & projections', fn: imf, ttlH: 72 },
  { id: 'worldbank', name: 'World Bank', home: 'https://data.worldbank.org/country/jamaica', scope: 'Jamaica', what: 'Structural exposure: remittances, tourism, reserves, import mix', fn: worldbank, ttlH: 168 },
  { id: 'fred', name: 'FRED (St. Louis Fed)', home: 'https://fred.stlouisfed.org/', scope: 'World', what: 'Oil, gas, US rates & jobs, inflation, food & grains, aluminium, freight, global risk, Canada jobs', fn: fred, ttlH: 12 },
  { id: 'fx', name: 'Exchange-rate APIs', home: 'https://www.exchangerate-api.com/', scope: 'Jamaica', what: 'USD/JMD, JPY/JMD and gold, now and 1–12 months ago', fn: fx, ttlH: 6 },
  { id: 'nhc', name: 'NOAA Hurricane Center', home: 'https://www.nhc.noaa.gov/', scope: 'World', what: 'Active Atlantic storms & 7-day outlook', fn: hurricanes, ttlH: 1 },
  { id: 'news', name: 'Gleaner & Observer', home: 'https://jamaica-gleaner.com/business', scope: 'Jamaica', what: 'Business headlines', fn: news, ttlH: 2 },
];
