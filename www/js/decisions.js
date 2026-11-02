// Personal-decision layer: turns the economic readings into plain verdicts with the reasons shown.
// These are rule-based, general readings for an individual in Jamaica — not personalised financial advice.
import { last, changeOver, fmt, signed } from './util.js';
import { analyse, borrowing } from './analysis.js';

const STEPS = ['good', 'ok', 'warn', 'bad'];

function ctx(d) {
  const a = analyse(d); const b = borrowing(d);
  const boj = d.boj || {}; const r = d.bojrates || {}; const fred = d.fred?.series || {}; const fx = d.fx || {};
  const infl = boj.inflation ?? d.statin?.cpiPtp?.value;
  const lv = (s) => (s?.length ? last(s).value : null);
  const h = (n) => fx.history?.find((x) => x.daysAgo === n);
  const jmd12 = fx.now && h(365) ? (fx.now.jmd / h(365).jmd - 1) * 100 : null;
  const jmd3 = fx.now && h(90) ? (fx.now.jmd / h(90).jmd - 1) * 100 : null;
  return {
    a, b, boj, r, fred, fx, infl, jmd12, jmd3,
    tb6: lv(r.tbills?.m6) ?? lv(r.tbills?.m3), dep12: lv(r.deposits?.time12), sav: lv(r.deposits?.savings),
    usdDep12: lv(r.usdDeposits?.time12), usTbill: lv(fred.DTB3), personal: lv(r.loans?.personal), inst: lv(r.loans?.instalment),
    mortCB: lv(r.loans?.mortgage),
    has: (id, level) => a.insights.some((i) => i.id === id && (!level || i.level === level)),
  };
}

// ---------- Household spending ----------
export function spending(d, c = ctx(d)) {
  const why = []; let s = 0;
  const add = (pts, t) => { s += pts; why.push({ pts, t }); };
  const g = c.a.gauges;
  if (g.inflation.step >= 3) add(1.5, `Prices are rising fast (${fmt(c.infl)}% a year) — every dollar buys less each month.`);
  else if (g.inflation.step === 2) add(1, 'Price pressure is building.');
  else add(-0.5, 'Inflation is under control.');
  const bestSave = Math.max(c.dep12 ?? -99, c.tb6 ?? -99);
  if (c.infl != null && bestSave > -99) {
    const real = bestSave - c.infl;
    if (real < 0) add(1, `Even the best common JMD savings rate (~${fmt(bestSave, 1)}%) is below inflation, so cash on hand is losing value — spend it on priorities, not impulse buys.`);
  }
  if (g.growth.step >= 2) add(1, 'The economy is soft — hours, bonuses and side income are less certain.');
  if (c.b.step >= 2) add(0.5, 'Borrowing costs are staying high, so financing purchases on credit is expensive.');
  if (c.has('fuel', 'pressure') || c.has('oil', 'pressure')) add(0.5, 'Fuel costs are trending up.');
  if (c.has('food', 'pressure')) add(0.5, 'World grain and food prices are up — grocery bills follow within months.');
  if (c.has('jobs', 'easing')) add(-0.5, 'Jobs are plentiful, which cushions household income.');
  if (c.has('remit', 'easing')) add(-0.25, 'Remittances are growing, supporting many household budgets.');
  const label = s >= 3 ? 'Trim & build a buffer' : s >= 1.5 ? 'Spend carefully' : 'Normal spending is fine';
  const step = s >= 3 ? 3 : s >= 1.5 ? 2 : s >= 0 ? 1 : 0;
  const tips = [];
  if (c.personal) tips.push(`Clear high-interest debt first — personal loans average ${fmt(c.personal, 1)}% and credit cards cost more; that beats any savings rate.`);
  tips.push(step >= 2 ? 'Aim for 3–6 months of essential expenses in an emergency fund before big discretionary purchases.' : 'Keep topping up an emergency fund of 3–6 months of essentials.');
  if (c.jmd3 != null && c.jmd3 > 1.5) tips.push('The JMD is weakening — if you need an imported item (appliance, parts, electronics), buying sooner may beat later price rises.');
  else tips.push('The JMD is stable, so there’s no currency reason to rush imported purchases.');
  if (c.has('food', 'pressure')) tips.push('Buy non-perishable staples (rice, flour, oil) when on sale; avoid over-stocking perishables.');
  if (c.has('fuel', 'pressure') || c.has('oil', 'pressure')) tips.push('Combine errands and keep tyres inflated — fuel is one of the fastest-moving costs right now.');
  if (step >= 2) tips.push('Delay non-essential big-ticket spending (holidays, upgrades) until price pressure eases or your buffer is built.');
  return { key: 'spend', title: 'Household spending', label, step, why, tips, pol: 'neg' };
}

// ---------- Buying a home ----------
export function home(d, c = ctx(d)) {
  const why = []; let s = 0; // positive = favourable to buy now (if personally ready)
  const add = (pts, t) => { s += pts; why.push({ pts, t }); };
  const mort = c.mortCB;
  if (c.b.step >= 2) add(1, 'Mortgage rates are unlikely to fall soon, so waiting is unlikely to get you a cheaper loan.');
  else if (c.b.step === 0) add(-1, 'Rates look likely to ease — waiting a few months could lower your mortgage rate.');
  if (mort != null && c.infl != null) {
    if (mort < c.infl) add(0.5, `Average mortgage rates (~${fmt(mort, 1)}%) are below today’s inflation (${fmt(c.infl)}%) — helpful while it lasts, though inflation should fall back over a 20–30 year loan.`);
    else if (mort - c.infl > 4) add(-0.5, `Mortgage rates (~${fmt(mort, 1)}%) are well above inflation — borrowing is expensive in real terms.`);
  }
  if (c.a.gauges.inflation.step >= 2) add(0.5, 'High inflation tends to push up property and building-material prices in JMD, so delays can cost more.');
  if (c.has('freight', 'pressure') || (c.jmd3 != null && c.jmd3 > 1.5)) add(0.25, 'Imported building materials are getting dearer (freight/JMD) — relevant if you plan to build or renovate.');
  if (c.a.gauges.growth.step >= 3) add(-1, 'The economy is weak — make sure your income is secure before taking on a 20–30 year commitment.');
  else if (c.a.gauges.growth.step === 2) add(-0.5, 'Growth is soft; stress-test your budget for a dip in income.');
  if (c.has('jobs', 'easing')) add(0.5, 'A tight job market supports income security.');
  if (c.has('remit', 'easing')) add(0.25, 'Strong remittances support housing demand (and prices) across the island.');
  const label = s >= 2.5 ? 'Favourable — if you’re ready' : s >= 1 ? 'Reasonable — if you’re ready' : s > -1 ? 'Neutral — buy only when ready' : 'Consider waiting';
  const step = s >= 2.5 ? 0 : s >= 1 ? 1 : s > -1 ? 2 : 3;
  const tips = [
    'Market timing matters less than readiness: a stable income, a deposit plus money for closing costs (legal fees, stamp duty, registration), and an emergency fund left over afterwards.',
    'Keep the monthly mortgage payment to roughly a third of take-home pay or less; lenders also cap total debt payments.',
    'If you contribute to the NHT, combining an NHT loan with a bank or building-society loan usually lowers the blended rate — check your NHT eligibility and income band.',
    'Prefer a fixed rate while the rate outlook is “staying high” or “rising”.',
  ];
  return { key: 'home', title: 'Buying a home', label, step, why, tips, mortCB: c.mortCB, pol: 'pos' };
}

// ---------- Investing by risk profile ----------
export const PROFILES = {
  conservative: { name: 'Conservative', blurb: 'Protect what you have; you may need the money within 1–3 years.', base: { jmdCash: 40, usdCash: 30, bonds: 20, jse: 5, global: 5, gold: 0 } },
  balanced: { name: 'Balanced', blurb: 'Grow steadily over 3–7 years and accept some ups and downs.', base: { jmdCash: 20, usdCash: 20, bonds: 20, jse: 15, global: 20, gold: 5 } },
  growth: { name: 'Growth', blurb: 'Long horizon (7+ years); can ride out big drops.', base: { jmdCash: 5, usdCash: 10, bonds: 10, jse: 30, global: 35, gold: 10 } },
};
export const ASSETS = {
  jmdCash: { short: 'JMD cash', name: 'JMD cash, T-bills & money market', color: 'a1' },
  usdCash: { short: 'USD savings', name: 'USD savings & short-term (US T-bills, USD deposits)', color: 'a2' },
  bonds: { short: 'bonds', name: 'Bonds (GOJ & corporate, short–medium term)', color: 'a3' },
  jse: { short: 'JSE stocks', name: 'Jamaican stocks (JSE)', color: 'a4' },
  global: { short: 'global stocks', name: 'Global stocks (index funds/ETFs)', color: 'a5' },
  gold: { short: 'gold & real assets', name: 'Gold & real assets (incl. property funds)', color: 'a6' },
};

export function invest(d, c = ctx(d), hist = {}) {
  const tilt = { jmdCash: 0, usdCash: 0, bonds: 0, jse: 0, global: 0, gold: 0 };
  const why = [];
  const t = (k, v) => { tilt[k] += v; };
  const realJmd = c.infl != null && c.tb6 != null ? c.tb6 - c.infl : null;
  if (realJmd != null && realJmd < 0) { t('jmdCash', -5); t('usdCash', 3); t('gold', 2); why.push({ pts: -1, t: `JMD T-bills (~${fmt(c.tb6, 2)}%) pay less than inflation (${fmt(c.infl)}%): real return ≈ ${signed(realJmd, 1, ' pts')}. Hold JMD cash for near-term needs only.` }); }
  else if (realJmd != null && realJmd > 2) { t('jmdCash', 5); why.push({ pts: 1, t: `JMD T-bills pay ${signed(realJmd, 1, ' pts')} above inflation — attractive for low-risk money.` }); }
  const ext = c.a.gauges.external.step;
  if (ext >= 2 || (c.jmd3 != null && c.jmd3 > 1.5)) { t('usdCash', 5); t('jmdCash', -3); t('global', 2); why.push({ pts: -1, t: 'Pressure on the JMD — some US-dollar exposure protects your purchasing power.' }); }
  else why.push({ pts: 0, t: `The JMD is broadly stable (${signed(c.jmd12)} over 12 months); USD holdings are diversification rather than urgent protection.` });
  if (c.usTbill != null) why.push({ pts: 0, t: `US 3-month T-bills yield ${fmt(c.usTbill, 2)}%${c.usdDep12 != null ? ` vs ~${fmt(c.usdDep12, 2)}% on 12-month USD deposits at local banks` : ''} — compare before parking US dollars.` });
  if (c.b.step >= 2) { t('bonds', -3); t('jmdCash', 1); t('usdCash', 2); why.push({ pts: 0, t: 'Rates look set to stay high — favour short-term bonds and instruments you can roll over; long-dated bonds lose value if rates rise.' }); }
  else if (c.b.step === 0) { t('bonds', 4); t('jse', 2); why.push({ pts: 1, t: 'Rates look likely to ease — bonds and rate-sensitive JSE stocks usually benefit.' }); }
  const risk = c.has('risk', 'pressure');
  if (risk) { t('global', -4); t('jse', -2); t('usdCash', 3); t('gold', 3); why.push({ pts: -1, t: 'Global investors are nervous — trim stock exposure and keep dry powder.' }); }
  const sp = c.fred.SP500; const spc = sp?.length ? changeOver(sp, 183) : null;
  if (spc != null) why.push({ pts: 0, t: `US stocks ${signed(spc)} over 6 months — strong runs raise the odds of a pullback; add gradually rather than all at once.` });
  const jseIdx = d.jse?.indices?.main; const jh = Object.entries(hist).filter(([, v]) => v.jseMain).sort();
  if (jh.length >= 20) {
    const first = jh[0][1].jseMain; const pct = (jseIdx?.value ?? jh.at(-1)[1].jseMain) / first * 100 - 100;
    why.push({ pts: 0, t: `JSE Main Index ${signed(pct)} since ${jh[0][0]} (tracked on this phone).` });
  } else if (jseIdx) why.push({ pts: 0, t: `JSE Main Index ${fmt(jseIdx.value, 0)} (${signed(jseIdx.pct, 2)} on the day). The app builds its own JSE trend as you use it.` });
  if (c.infl != null && c.infl > 7) { t('gold', 2); t('jmdCash', -2); why.push({ pts: 0, t: 'High inflation: a small slice of real assets (gold, property funds) can hedge purchasing power.' }); }
  const xau = c.fx.now?.xau; const xh = c.fx.history?.find((x) => x.daysAgo === 180)?.xau;
  if (xau && xh) why.push({ pts: 0, t: `Gold ≈ US$${fmt(1 / xau, 0)}/oz (${signed((xh / xau - 1) * 100)} over 6 months).` });

  const mixes = {};
  for (const [k, p] of Object.entries(PROFILES)) {
    const m = {}; let tot = 0;
    for (const a of Object.keys(ASSETS)) { const scale = k === 'conservative' ? 0.6 : k === 'growth' ? 1.2 : 1; m[a] = Math.max(0, p.base[a] + tilt[a] * scale); if (k === 'conservative' && (a === 'jse' || a === 'global')) m[a] = Math.min(m[a], 10); tot += m[a]; }
    for (const a of Object.keys(m)) m[a] = Math.round((m[a] / tot) * 100 / 5) * 5;
    const diff = 100 - Object.values(m).reduce((x, y) => x + y, 0);
    const big = Object.keys(m).sort((x, y) => m[y] - m[x])[0]; m[big] += diff;
    mixes[k] = m;
  }
  const lean = Object.entries(tilt).filter(([, v]) => Math.abs(v) >= 2).sort((x, y) => y[1] - x[1]);
  const toward = lean.filter(([, v]) => v > 0).map(([k]) => ASSETS[k].short);
  const away = lean.filter(([, v]) => v < 0).map(([k]) => ASSETS[k].short);
  const label = toward.length ? `Lean toward ${toward.slice(0, 2).join(' & ')}` : 'Stay balanced';
  return { key: 'invest', title: 'Investing', label, step: 1, why, mixes, tilt, toward, away };
}

// ---------- Job moves ----------
export function work(d, c = ctx(d), hist = {}) {
  const why = []; let s = 0; // positive = good time to look / negotiate
  const add = (pts, t) => { s += pts; why.push({ pts, t }); };
  const u = d.statin?.unemployment;
  if (u) {
    if (u.value < 4.5) add(2, `Unemployment is very low (${fmt(u.value)}%, ${u.period}) — employers compete for staff.`);
    else if (u.value < 6.5) add(1, `Unemployment is moderate (${fmt(u.value)}%).`);
    else add(-1, `Unemployment is elevated (${fmt(u.value)}%) — more competition for each opening.`);
    const uh = Object.values(hist).filter((v) => v.unemp != null).map((v) => v.unemp);
    if (uh.length >= 2 && u.value - Math.min(...uh) >= 0.5) add(-1, 'Unemployment has started rising since you began tracking.');
  }
  if (c.infl != null && c.infl > 6) add(1, `Inflation is ${fmt(c.infl)}% — a raise below that is a pay cut in real terms, so it’s a fair time to negotiate or test the market.`);
  const g = c.a.gauges.growth.step;
  if (g >= 3) add(-1, 'The economy is contracting — many employers freeze hiring; secure an offer before resigning.');
  else if (g === 2) add(-0.5, 'Growth is soft — be selective and favour financially strong employers.');
  if (c.b.step >= 2) why.push({ pts: 0, t: 'High interest rates slow business expansion, so hiring tends to hold up best in essential, export-earning and rebuilding-related work.' });
  const sectors = [];
  const tr = d.tourism?.stopovers;
  if (tr) sectors.push({ name: 'Tourism & hospitality', dir: tr.change < -5 ? 'cool' : tr.change > 5 ? 'warm' : 'flat', why: `Stopovers ${signed(tr.change)} y/y (${tr.month})` });
  const al = c.fred.PALUMUSDM; if (al?.length) { const ch = changeOver(al, 183); sectors.push({ name: 'Bauxite & alumina', dir: ch > 8 ? 'warm' : ch < -8 ? 'cool' : 'flat', why: `Aluminium ${signed(ch)} over 6 months` }); }
  const news = d.news?.items || [];
  const bpo = news.filter((n) => /BPO|call cent|outsourc/i.test(n.title));
  if (bpo.length) sectors.push({ name: 'BPO / outsourcing', dir: bpo.some((n) => /contract|cut|layoff|clos|pivot|decline/i.test(n.title)) ? 'cool' : 'flat', why: `${bpo.length} recent headline${bpo.length > 1 ? 's' : ''}: “${bpo[0].title.slice(0, 70)}”` });
  if (c.b.step >= 2) sectors.push({ name: 'Banking & finance', dir: 'warm', why: 'High interest rates support lenders’ margins' });
  const rem = d.remit; if (rem) sectors.push({ name: 'Retail & construction (remittance-funded)', dir: rem.yoy > 4 ? 'warm' : rem.yoy < 0 ? 'cool' : 'flat', why: `Remittances ${signed(rem.yoy)} y/y (${rem.month})` });
  const label = s >= 2.5 ? 'Strong position to look or negotiate' : s >= 1 ? 'Decent time — be selective' : s > -1 ? 'Proceed carefully' : 'Hold steady for now';
  const step = s >= 2.5 ? 0 : s >= 1 ? 1 : s > -1 ? 2 : 3;
  const tips = [
    'Line up an offer before resigning; aim for a raise that at least beats inflation.',
    'Compare total packages — pension, health insurance and allowances can be worth a lot on top of salary.',
    'Favour employers with steady US-dollar income or essential services when the economy is soft.',
  ];
  return { key: 'work', title: 'Job moves', label, step, why, tips, sectors, pol: 'pos' };
}

export function decide(d, hist = {}) {
  const c = ctx(d);
  return { spend: spending(d, c), borrow: { key: 'borrow', title: 'Borrowing', label: c.b.label, step: c.b.step }, home: home(d, c), invest: invest(d, c, hist), work: work(d, c, hist), ctx: c };
}
export { STEPS };
