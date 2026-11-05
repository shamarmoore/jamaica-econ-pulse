// Home buying: NHT + co-applicant financing maths, property listing scrapers, and commute estimates.
// Rules and limits are defaults the user can edit in the app (NHT changes them from time to time).
import { getText, getJSON, htmlToText, decodeEntities } from './util.js';

// ---------- NHT defaults (NHT booklet, July 2025; income bands from NHT policy effective July 2023) ----------
export const NHT_DEFAULTS = {
  limitSingle: 9000000, limitSingleSpecial: 12000000, specialPriceCap: 14000000, limitJoint: 17000000,
  bands: [[30000.99, 0], [42000.99, 2], [100000.99, 4], [Infinity, 5]], // weekly income ceiling → rate %
  maxTerm: 40, maxAge: 70, lotLimitPer: 0,
};
export const FIN_DEFAULTS = {
  myIncome: '', myAge: 25, myNht: true,
  coOn: false, coIncome: '', coAge: 25, coNht: true,
  savings: '', ratio: 35, closingPct: 6, bankLTV: 90, bankTerm: 30, bankRate: null,
  landLTV: 70, landRateAdd: 2, landTerm: 15,
  minMin: 25, maxMin: 50, traffic: 1.4, work: '43 Half Way Tree Road, Kingston, Jamaica',
};

export const pmt = (P, ratePct, years) => { if (P <= 0) return 0; const r = ratePct / 1200; const n = years * 12; return r ? (P * r) / (1 - (1 + r) ** -n) : P / n; };
export const pv = (M, ratePct, years) => { if (M <= 0) return 0; const r = ratePct / 1200; const n = years * 12; return r ? (M * (1 - (1 + r) ** -n)) / r : M * n; };
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/[,\s$J]/g, '')); return Number.isFinite(n) ? n : 0; };

export function nhtRate(weeklyIncome, bands = NHT_DEFAULTS.bands) {
  for (const [cap, r] of bands) if (weeklyIncome <= cap) return r;
  return bands[bands.length - 1][1];
}

// One financing scenario for a home or lot at price P.
// mode: 'bank' | 'nht' (you only) | 'nhtco' (you + co-applicant)
export function scenario(P, f, mode, { land = false, nht = NHT_DEFAULTS, bankRateLive = 7.6 } = {}) {
  const me = { inc: num(f.myIncome), age: num(f.myAge) || 25, nht: !!f.myNht };
  const co = { inc: num(f.coIncome), age: num(f.coAge) || 25, nht: !!f.coNht };
  const people = mode === 'nhtco' && f.coOn ? [me, co] : [me];
  const income = people.reduce((s, p) => s + p.inc, 0);
  const cap = (income * num(f.ratio)) / 100; // max total monthly housing payment
  const bankRate = (num(f.bankRate) || bankRateLive) + (land ? num(f.landRateAdd) : 0);
  const oldest = Math.max(...people.map((p) => p.age)); const youngest = Math.min(...people.map((p) => p.age));
  const bankTerm = Math.max(5, Math.min(land ? num(f.landTerm) || 15 : num(f.bankTerm) || 30, num(nht.maxAge) - oldest));
  const ltv = (land ? num(f.landLTV) : num(f.bankLTV)) / 100;
  let nhtLoan = 0; let nhtRatePct = 0; let nhtTerm = 0; const notes = [];
  if (mode !== 'bank') {
    const contributors = people.filter((p) => p.nht);
    if (!contributors.length) notes.push('No NHT contributor selected.');
    else {
      const avgWeekly = (contributors.reduce((s, p) => s + p.inc, 0) / contributors.length) * 12 / 52;
      nhtRatePct = nhtRate(avgWeekly, nht.bands);
      nhtTerm = Math.max(5, Math.min(num(nht.maxTerm), num(nht.maxAge) - youngest));
      let limit;
      if (land) limit = num(nht.lotLimitPer) * contributors.length;
      else if (contributors.length >= 2) limit = num(nht.limitJoint);
      else limit = P <= num(nht.specialPriceCap) ? num(nht.limitSingleSpecial) : num(nht.limitSingle);
      // each contributor borrows what they can afford in their own right (NHT policy)
      const afford = contributors.reduce((s, p) => s + pv((p.inc * num(f.ratio)) / 100, nhtRatePct, nhtTerm), 0);
      nhtLoan = Math.max(0, Math.min(limit, afford, P));
      if (land && !limit) notes.push('Enter your NHT lot-loan limit in settings to include NHT for land.');
      if (nhtLoan === afford && afford < limit) notes.push('NHT amount capped by income affordability.');
    }
  }
  const nhtPay = pmt(nhtLoan, nhtRatePct, nhtTerm || 1);
  let bankLoan = 0;
  if (nhtLoan < P) {
    const room = Math.max(0, P * ltv - nhtLoan);
    const affordBank = pv(Math.max(0, cap - nhtPay), bankRate, bankTerm);
    bankLoan = Math.max(0, Math.min(room, affordBank));
  }
  const bankPay = pmt(bankLoan, bankRate, bankTerm);
  const deposit = Math.max(0, P - nhtLoan - bankLoan);
  const closing = (P * num(f.closingPct)) / 100;
  const cash = deposit + closing;
  const monthly = nhtPay + bankPay;
  const share = income ? (monthly / income) * 100 : null;
  const savings = num(f.savings);
  let verdict = 'unknown';
  if (income) {
    const cashOk = savings ? cash <= savings : null;
    if ((cashOk ?? true) && share <= num(f.ratio) + 0.5) verdict = cashOk === null ? 'check' : 'yes';
    else if (share <= num(f.ratio) + 10 && (savings ? cash <= savings * 1.25 : true)) verdict = 'stretch';
    else verdict = 'no';
  }
  return { mode, P, nhtLoan, nhtRatePct, nhtTerm, nhtPay, bankLoan, bankRate, bankTerm, bankPay, deposit, closing, cash, monthly, share, verdict, notes, income,
    totalInterest: nhtPay * nhtTerm * 12 + bankPay * bankTerm * 12 - nhtLoan - bankLoan };
}

export function bestScenario(P, f, opts) {
  const modes = ['bank', 'nht'].concat(f.coOn ? ['nhtco'] : []);
  const rank = { yes: 0, check: 1, stretch: 2, no: 3, unknown: 4 };
  return modes.map((m) => scenario(P, f, m, opts)).sort((a, b) => (rank[a.verdict] - rank[b.verdict]) || (a.cash - b.cash) || (a.monthly - b.monthly))[0];
}

// ---------- Locality gazetteer (names only; coordinates come from OpenStreetMap at runtime) ----------
export const PREFERRED = /(st\.?\s*thomas|bull\s*bay|seven\s*mile|eight\s*mile|nine\s*mile|ten\s*mile|eleven\s*mile|yallahs|albion|grants\s*pen|cane\s*river|rest\s*haven)/i;
const PLACES = {
  'St. Thomas': ['Yallahs', 'Albion', 'Morant Bay', 'Easington', 'Pamphret', 'Lyssons', 'Llandewey', 'White Horses', 'Poormans Corner', 'Cambridge Hill', 'Golden Grove', 'Bath', 'Seaforth', 'Port Morant', 'Trinityville', 'Spring Garden', 'Mount George', 'Font Hill', 'Heartease', 'Leith Hall', 'Retreat', 'Prospect', 'Lloyds', 'Eleven Mile', 'Grants Pen', 'Bowden', 'Seaforth', 'Hampton Court', 'Pear Tree River'],
  'St. Andrew': ['Bull Bay', 'Seven Mile', 'Eight Mile', 'Nine Mile', 'Ten Mile', 'Harbour View', 'Rest Haven', 'Cane River', 'Papine', 'Mona', 'Hope Pastures', 'Barbican', 'Constant Spring', 'Red Hills', 'Golden Meadows', 'Stony Hill', 'Meadowbrook', 'Duhaney Park', 'Half Way Tree', 'Cherry Gardens', 'Norbrook', 'Jacks Hill', 'Gordon Town', 'Irish Town', 'Kintyre', 'August Town', 'Liguanea', 'Havendale', 'Molynes', 'Washington Gardens', 'Patrick City', 'Pembroke Hall', 'Waterloo', 'New Kingston', 'Forest Hills', 'Lawrence Tavern', 'Mavis Bank', 'Mannings Hill', 'Smokey Vale', 'Shortwood', 'Belmont', 'Graham Heights', 'Plantation Heights', 'Manor Park', 'Hughenden', 'Arcadia', 'Upper Rock Spring', 'Mountain View', 'Elletson Road'],
  Kingston: ['Rockfort', 'Port Royal', 'Rae Town', 'Allman Town', 'Franklyn Town', 'Vineyard Town', 'Downtown Kingston'],
  'St. Catherine': ['Portmore', 'Spanish Town', 'Old Harbour', 'Gregory Park', 'Bridgeport', 'Caymanas', 'Hellshire', 'Waterford', 'Edgewater', 'Greater Portmore', 'Ferry', 'Sligoville', 'Linstead', 'Bog Walk', 'Innswood', 'Angels', 'Lluidas Vale', 'Ewarton', 'Willowdene', 'Twickenham Park', 'Old Harbour Bay', 'Jacks Hall'],
};
const PLACE_LIST = Object.entries(PLACES).flatMap(([parish, names]) => names.map((n) => ({ n, parish, re: new RegExp(`\\b${n.replace(/\s+/g, '\\s*')}\\b`, 'i') })));
const PARISH_RE = [['St. Thomas', /st\.?\s*thomas/i], ['St. Catherine', /st\.?\s*cath|portmore|spanish town/i], ['St. Andrew', /st\.?\s*andrew|kingston\s*\d|kgn\s*\d|corp(orate)?\s*area/i], ['Kingston', /\bkingston\b/i]];

const PARISH_OF = (s) => (/st\.?\s*thomas/i.test(s) ? ['St. Thomas'] : /st\.?\s*cath/i.test(s) ? ['St. Catherine'] : /kingston|st\.?\s*andrew/i.test(s) ? ['St. Andrew', 'Kingston'] : null);
export function locate(text, hintParish, strictParishes = null) {
  for (const p of PLACE_LIST) if ((!strictParishes || strictParishes.includes(p.parish)) && p.re.test(text)) return { place: p.n, parish: p.parish, query: `${p.n}, ${p.parish}, Jamaica`, precision: 'community' };
  const k = /kingston\s*(\d{1,2})/i.exec(text); if (k) return { place: `Kingston ${k[1]}`, parish: 'Kingston/St. Andrew', query: `Kingston ${k[1]}, Jamaica`, precision: 'zone' };
  const parish = hintParish || (PARISH_RE.find(([, re]) => re.test(text)) || [])[0];
  return parish ? { place: parish, parish, query: null, precision: 'parish' } : { place: null, parish: null, query: null, precision: 'none' };
}

// ---------- Listing scrapers ----------
function moneyFrom(text, fx) {
  const t = String(text).replace(/,/g, '');
  const m = /(US\$|USD\s?\$?|J\$|JMD\s?\$?|\$)\s?(\d+(?:\.\d+)?)\s*(K|M|mil|million|B)?\b/i.exec(t);
  if (!m) return null;
  let v = parseFloat(m[2]); const unit = (m[3] || '').toLowerCase();
  if (unit === 'k') v *= 1e3; else if (unit === 'm' || unit.startsWith('mil')) v *= 1e6; else if (unit === 'b') v *= 1e9;
  const usd = /us/i.test(m[1]);
  if (usd) v *= fx || 158;
  return v >= 300000 ? Math.round(v) : null; // ignore implausible values (e.g. "$35.00")
}
const typeOf = (t) => (/\b(lot|land|acre|acres|development land|farm)\b/i.test(t) && !/\b(bed|bdrm|house|townhouse|apartment|apt|villa|cottage)\b/i.test(t) ? 'land' : 'house');

async function propertyAdsJa(fxRate) {
  const out = [];
  for (const parish of [1, 13, 2]) {
    let url = `https://www.propertyadsja.com/search.asp?SearchListingType=1&SearchParish=${parish}`;
    for (let page = 0; page < 6 && url; page++) {
      const h = await getText(url);
      for (const m of h.matchAll(/<a href="(https:\/\/www\.propertyadsja\.com\/[A-Z0-9]{3,6})"[^>]*title="([^"]+)"[\s\S]{0,1200}?<span>\s*((?:JMD|USD)\$[\d.,]+[KMB]?)\s*<\/span>/g)) {
        const title = decodeEntities(m[2]);
        if (!/for sale/i.test(title)) continue;
        const [what, where = ''] = title.split(/\s+For Sale\s+-\s+/i);
        out.push({ src: 'PropertyAdsJa', id: `pa:${m[1].slice(-6)}`, url: m[1], title: what.trim(), where: where.replace(/,\s*Jamaica$/i, '').trim(), price: moneyFrom(m[3], fxRate), priceText: m[3], type: typeOf(what) });
      }
      const next = /<a[^>]+href="([^"]*search\.asp[^"]*)"[^>]*>\s*(?:Next|&raquo;|»)/i.exec(h);
      url = next ? new URL(decodeEntities(next[1]), 'https://www.propertyadsja.com/').href : null;
    }
  }
  return out;
}

const GLEANER_CATS = ['559-sale-house-apts-corp-area', '571-sale-lots-res-comm-kgn', '562-sale-houses-apts-island', '574-sale-lots-res-comm-islan', '560-sale-houses-apts-st-cth', '572-sale-lots-res-comm-st-c'];
async function gleaner(fxRate) {
  const out = [];
  const res = await Promise.allSettled(GLEANER_CATS.map((c) => getText(`https://www.gleanerclassifieds.com/marketplace/category/550-real-estate-for-sale/${c}`)));
  res.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    for (const b of r.value.split('<div id="advert_').slice(1)) {
      const link = /<h4><a href="([^"]+)">([\s\S]*?)<\/a>/.exec(b); if (!link) continue;
      const title = htmlToText(link[2]); const desc = htmlToText((/class="description[^"]*">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
      const priceRaw = htmlToText((/sr_ad_price">([\s\S]*?)<\/span>/.exec(b) || [])[1] || '');
      const date = (/datetime="([^"]+)"/.exec(b) || [])[1];
      const price = moneyFrom(priceRaw, fxRate) ?? moneyFrom(`${title} ${desc}`, fxRate);
      const cat = GLEANER_CATS[i];
      out.push({ src: 'Gleaner Classifieds', id: `gc:${(/_(\d+)$/.exec(link[1]) || [])[1] || link[1]}`, url: link[1], title, desc, where: '', price, priceText: priceRaw || '—',
        type: /lots/.test(cat) ? 'land' : typeOf(`${title} ${desc}`), parishHint: /corp-area|kgn/.test(cat) ? 'St. Andrew' : /st-c/.test(cat) ? 'St. Catherine' : null, date: date ? date.slice(0, 10) : null });
    }
  });
  return out;
}

export async function listings(fxRate) {
  const [a, b] = await Promise.allSettled([propertyAdsJa(fxRate), gleaner(fxRate)]);
  const items = [...(a.status === 'fulfilled' ? a.value : []), ...(b.status === 'fulfilled' ? b.value : [])];
  const errors = [a, b].filter((x) => x.status === 'rejected').map((x) => String(x.reason?.message || x.reason));
  if (!items.length) throw new Error(errors.join('; ') || 'No listings found');
  for (const it of items) {
    const [street, ...rest] = (it.where || '').split(',');
    const parishText = rest.join(',');
    const strict = parishText ? PARISH_OF(parishText) : null;
    const loc = locate(`${it.where} ${it.title} ${it.desc || ''}`, it.parishHint || (strict && strict[0]), strict);
    const streetIsParish = PARISH_OF(street || '') && street.trim().split(/\s+/).length <= 3;
    if (it.where && loc.precision !== 'community' && parishText && !streetIsParish) {
      const parish = parishText.replace(/Kingston\s*\/\s*St\.?\s*Andrew/i, 'Kingston').trim();
      loc.query = `${street.trim()}, ${parish}, Jamaica`; loc.precision = 'street'; loc.place = street.trim();
    }
    if (strict && !loc.parish) loc.parish = strict[0];
    Object.assign(it, { loc, preferred: PREFERRED.test(`${it.where} ${it.title} ${it.desc || ''}`) });
  }
  const seen = new Set();
  return { items: items.filter((x) => (seen.has(x.id) ? false : seen.add(x.id))), errors, fetched: new Date().toISOString() };
}

// ---------- Geocoding (OpenStreetMap Nominatim) + drive time (OSRM) ----------
const NOMINATIM_HEADERS = { 'User-Agent': 'JAEconPulse/1.3 (personal budgeting app)' };
export async function geocode(q) {
  const j = await getJSON(`https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=jm&q=${encodeURIComponent(q)}`, 20000, NOMINATIM_HEADERS);
  return j?.[0] ? [+j[0].lat, +j[0].lon] : null;
}
export async function driveTimes(from, points) {
  // OSRM table: minutes from `from` to each point (free-flow). Batches of 90.
  const out = [];
  for (let i = 0; i < points.length; i += 90) {
    const batch = points.slice(i, i + 90);
    const coords = [from, ...batch].map(([la, lo]) => `${lo.toFixed(5)},${la.toFixed(5)}`).join(';');
    const j = await getJSON(`https://router.project-osrm.org/table/v1/driving/${coords}?sources=0&annotations=duration,distance`, 30000);
    batch.forEach((_, k) => out.push({ min: j.durations?.[0]?.[k + 1] != null ? j.durations[0][k + 1] / 60 : null, km: j.distances?.[0]?.[k + 1] != null ? j.distances[0][k + 1] / 1000 : null }));
  }
  return out;
}

// ---------- Analyst jobs (CaribbeanJobs) ----------
export async function analystJobs() {
  const jobs = []; const seen = new Set();
  for (let page = 1; page <= 3; page++) {
    const h = await getText(`https://www.caribbeanjobs.com/analyst-jobs?PerPage=100${page > 1 ? `&Page=${page}` : ''}`);
    const cards = h.split('class="module job-result').slice(1);
    for (const c of cards) {
      const t = /<h2[^>]*>\s*<a[^>]*href='([^']+)'[^>]*>([\s\S]*?)<\/a>/.exec(c); if (!t) continue;
      const title = htmlToText(t[2]); if (!/analyst/i.test(title)) continue;
      const id = (/-Job-(\d+)\.aspx/.exec(t[1]) || [])[1]; if (!id || seen.has(id)) continue; seen.add(id);
      const company = htmlToText((/itemprop="hiringOrganization"[^>]*>([\s\S]*?)<\/a>/.exec(c) || [])[1] || '');
      const locA = /class="location">\s*<a href="\/([^/"]+)\/[^"]*">([\s\S]*?)<\/a>/.exec(c);
      const updated = htmlToText((/class="updated-time">([\s\S]*?)<\/li>/.exec(c) || [])[1] || '').replace(/^Updated\s*/i, '');
      const salary = htmlToText((/class="salary">([\s\S]*?)<\/li>/.exec(c) || [])[1] || '');
      const desc = htmlToText((/itemprop="description"[^>]*>([\s\S]*?)<\/p>/.exec(c) || [])[1] || '');
      jobs.push({ id, title, company, country: locA ? locA[1].replace(/-/g, ' ') : '', location: locA ? htmlToText(locA[2]) : '', updated, salary, desc, url: `https://www.caribbeanjobs.com${t[1]}` });
    }
    if (!/[?&]Page=\d+/.test(h) || cards.length < 20) break;
  }
  if (!jobs.length) throw new Error('No analyst jobs parsed');
  return { jobs, fetched: new Date().toISOString() };
}
