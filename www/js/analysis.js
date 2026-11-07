// Rule-based reading of the data: each rule looks at a live indicator, decides whether it is adding
// pressure or relief, and explains the transmission channel into Jamaica's economy.
// Nothing here is hard-coded data — thresholds and channels only. All numbers come from the scrapers.
import { last, changeOver, yoySeries, fmt, signed } from './util.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function analyse(d, now = new Date()) {
  const insights = [];
  const g = { inflation: 0, growth: 0, external: 0, shock: 0 };
  const add = (x) => { insights.push(x); for (const k in (x.gauge || {})) g[k] += x.gauge[k]; };

  const boj = d.boj || {}; const st = d.statin || {}; const imf = d.imf?.series || {};
  const wb = d.worldbank?.latest || {}; const fred = d.fred?.series || {}; const fx = d.fx || {};
  const wbv = (k) => wb[k] ? `${fmt(wb[k].value, 1)}%` : null;
  const remit = wbv('BX.TRF.PWKR.DT.GD.ZS'); const tour = wbv('ST.INT.RCPT.XP.ZS');
  const fuel = wbv('TM.VAL.FUEL.ZS.UN'); const food = wbv('TM.VAL.FOOD.ZS.UN');
  const year = now.getFullYear();
  const imfAt = (k, y) => (imf[k] || []).find((p) => p.year === y)?.value;

  // 1. Domestic inflation vs BOJ target
  const infl = boj.inflation ?? st.cpiPtp?.value;
  const inflPer = boj.inflation != null ? boj.inflationPeriod : st.cpiPtp?.period;
  const [lo, hi] = boj.target || [4, 6];
  if (infl != null) {
    const mon = st.cpiMonthly?.value;
    const spike = mon != null && mon >= 1;
    if (infl > hi) {
      const sev = infl > hi + 2 ? 3 : 2;
      add({ id: 'infl', scope: 'Jamaica', level: 'pressure', severity: sev,
        title: 'Inflation is above the BOJ target',
        signal: `Annual inflation ${fmt(infl)}% (${inflPer || 'latest'}) vs target ${lo}–${hi}%${mon != null ? `; prices rose ${fmt(mon)}% in the latest month` : ''}.`,
        effects: [
          'Real incomes get squeezed — wages usually lag prices, and food and transport take a bigger bite out of lower-income budgets.',
          `BOJ is unlikely to cut rates while inflation sits above ${hi}%; a hold or hike is more likely${boj.nextPolicyDate ? ` at the ${boj.nextPolicyDate} decision` : ''}.`,
          'Loan rates stay higher for longer, which slows credit to households and small firms.',
          spike ? 'A monthly jump of 1%+ usually points to a supply shock (weather, food, utilities) rather than demand — these often fade after a few months.' : 'Watch whether the monthly readings cool; that is the first sign the annual rate will follow.',
        ],
        watch: 'Next STATIN CPI release and the BOJ policy statement.',
        gauge: { inflation: infl > hi + 2 ? 2 : 1 }, sources: ['boj', 'statin'] });
    } else if (infl < lo) {
      add({ id: 'infl', scope: 'Jamaica', level: 'easing', severity: 1, title: 'Inflation is below the BOJ target',
        signal: `Annual inflation ${fmt(infl)}% (${inflPer || 'latest'}) vs target ${lo}–${hi}%.`,
        effects: ['Purchasing power is recovering.', 'Gives the BOJ room to cut its policy rate, which would lower loan rates over time.', 'Very low inflation can also signal weak demand — check growth indicators.'],
        watch: 'BOJ policy decisions.', gauge: { inflation: -1 }, sources: ['boj', 'statin'] });
    } else {
      add({ id: 'infl', scope: 'Jamaica', level: 'neutral', severity: 0, title: 'Inflation is inside the BOJ target',
        signal: `Annual inflation ${fmt(infl)}% (${inflPer || 'latest'}) within ${lo}–${hi}%.`,
        effects: ['Stable prices support predictable interest rates and business planning.'],
        watch: 'Imported price pressures below (oil, food, exchange rate).', gauge: {}, sources: ['boj', 'statin'] });
    }
  }

  // 2. Policy stance (real policy rate)
  if (boj.policyRate != null && infl != null) {
    const real = boj.policyRate - infl;
    const loose = real < 0;
    add({ id: 'policy', scope: 'Jamaica', level: loose ? 'watch' : real > 2 ? 'watch' : 'neutral', severity: loose ? 2 : 1,
      title: loose ? 'Interest rates are below inflation' : real > 2 ? 'Monetary policy is tight' : 'Monetary policy is roughly balanced',
      signal: `Policy rate ${fmt(boj.policyRate, 2)}% minus inflation ${fmt(infl)}% = real rate ${signed(real, 1, ' pts')}.${boj.nextPolicyDate ? ` Next decision: ${boj.nextPolicyDate}.` : ''}`,
      effects: loose ? [
        'Savers earn less than inflation on JMD deposits, which nudges money toward US-dollar assets and can weaken the JMD.',
        'If inflation persists, the BOJ may raise rates or lean on US-dollar sales (FX intervention) to steady the currency.',
        'Borrowers benefit in real terms for now.',
      ] : real > 2 ? [
        'High real rates restrain credit growth and consumer spending.',
        'They also make JMD assets attractive, which supports the currency.',
        'Once inflation is clearly falling, this leaves room for rate cuts — positive for the JSE and borrowers.',
      ] : ['Rates are roughly matching inflation; the BOJ can wait for clearer data.'],
      watch: 'Direction of the next BOJ decision.', gauge: loose ? { inflation: 1 } : real > 2 ? { growth: -1 } : {}, sources: ['boj'] });
  }

  // 3. Exchange rate
  const hist = fx.history || [];
  const now$ = boj.fx?.USD?.sell ?? fx.now?.jmd;
  const h90 = hist.find((h) => h.daysAgo === 90); const h365 = hist.find((h) => h.daysAgo === 365);
  if (fx.now && (h90 || h365)) {
    const c90 = h90 ? (fx.now.jmd / h90.jmd - 1) * 100 : null;
    const c365 = h365 ? (fx.now.jmd / h365.jmd - 1) * 100 : null;
    const key = c90 ?? c365 / 4;
    const dep = key > 1.5; const app = key < -1;
    add({ id: 'fx', scope: 'Jamaica', level: dep ? 'pressure' : app ? 'easing' : 'neutral', severity: dep ? (key > 4 ? 3 : 2) : app ? 1 : 0,
      title: dep ? 'The JMD is weakening' : app ? 'The JMD is strengthening' : 'The JMD is broadly stable',
      signal: `US$1 ≈ J$${fmt(now$, 2)}${boj.fx?.USD ? ' (BOJ selling rate)' : ''}. Change: ${signed(c90)} over 3 months, ${signed(c365)} over 12 months (− means JMD gained).`,
      effects: dep ? [
        'Imported goods priced in US dollars — fuel, food, raw materials, vehicles — cost more in JMD, feeding inflation over the next few months.',
        'Raises the JMD cost of servicing the government’s and companies’ US-dollar debt.',
        'Exporters, tourism operators and remittance-receiving households gain more JMD per US dollar.',
        'The BOJ may sell US dollars (B-FXITT) or keep rates high to steady the currency.',
      ] : app ? [
        'Imported goods get cheaper in JMD, helping bring inflation down.',
        'Remittances and tourism dollars convert into fewer JMD.',
      ] : ['A steady currency keeps imported inflation in check and supports business planning.'],
      watch: 'BOJ FX intervention announcements and the spread between buying and selling rates.',
      gauge: dep ? { external: key > 4 ? 2 : 1, inflation: 1 } : app ? { external: -1 } : {}, sources: ['fx', 'boj'] });
  }

  // 4. Oil
  const brent = fred.DCOILBRENTEU;
  if (brent?.length) {
    const c = changeOver(brent, 90); const lv = last(brent).value;
    const up = c > 10; const dn = c < -10;
    add({ id: 'oil', scope: 'World', level: up ? 'pressure' : dn ? 'easing' : 'neutral', severity: up ? (c > 20 ? 3 : 2) : dn ? 1 : 0,
      title: up ? 'Oil prices are climbing' : dn ? 'Oil prices are falling' : 'Oil prices are steady',
      signal: `Brent at US$${fmt(lv, 2)}/bbl, ${signed(c)} over 3 months.${fuel ? ` Fuel is ${fuel} of Jamaica’s merchandise imports (World Bank, ${wb['TM.VAL.FUEL.ZS.UN'].year}).` : ''}`,
      effects: up ? [
        'Bigger fuel import bill → wider current-account gap and more demand for US dollars, which leans on the JMD.',
        'Pump prices, JPS electricity bills (fuel charge) and transport fares usually follow within 1–2 months, pushing CPI up.',
        'Raises costs for bauxite/alumina, manufacturing, farming and distribution.',
      ] : dn ? [
        'Cheaper fuel imports ease pressure on the current account and the JMD.',
        'Pump prices and electricity bills should ease within 1–2 months, helping inflation fall.',
        'Leaves households with more to spend elsewhere.',
      ] : ['No major oil shock right now; energy costs are not a big swing factor this month.'],
      watch: 'OPEC+ decisions and Middle East supply risks.',
      gauge: up ? { inflation: 1, external: 1 } : dn ? { inflation: -1, external: -1 } : {}, sources: ['fred', 'worldbank'] });
  }

  // 5. Natural gas (LNG for power)
  const hh = fred.DHHNGSP;
  if (hh?.length) {
    const c = changeOver(hh, 90);
    if (c != null && Math.abs(c) > 20) add({ id: 'gas', scope: 'World', level: c > 0 ? 'watch' : 'easing', severity: 1,
      title: c > 0 ? 'Natural gas prices are up sharply' : 'Natural gas prices are down sharply',
      signal: `US Henry Hub gas ${signed(c)} over 3 months (US$${fmt(last(hh).value, 2)}/MMBtu).`,
      effects: [`A growing share of Jamaica’s electricity is generated from LNG, so this ${c > 0 ? 'can add to' : 'can trim'} power costs, with a lag depending on supply contracts.`],
      watch: 'JPS fuel-rate adjustments on bills.', gauge: c > 0 ? { inflation: 0.5 } : { inflation: -0.5 }, sources: ['fred'] });
  }

  // 6. Food & grains
  const fi = fred.PFOODINDEXM; const wh = fred.PWHEAMTUSDM; const mz = fred.PMAIZMTUSDM;
  if (fi?.length) {
    const c = changeOver(fi, 180); const cw = wh?.length ? changeOver(wh, 180) : null; const cm = mz?.length ? changeOver(mz, 180) : null;
    const up = c > 5 || cw > 10 || cm > 10; const dn = c < -5;
    add({ id: 'food', scope: 'World', level: up ? 'pressure' : dn ? 'easing' : 'neutral', severity: up ? 2 : dn ? 1 : 0,
      title: up ? 'World food prices are rising' : dn ? 'World food prices are easing' : 'World food prices are steady',
      signal: `Global food index ${signed(c)} over 6 months; wheat ${signed(cw)}, maize ${signed(cm)}.${food ? ` Food is ${food} of merchandise imports (World Bank).` : ''}`,
      effects: up ? [
        'Jamaica imports most of its grain, so flour, bread and cooking-oil prices tend to follow with a 2–4 month lag.',
        'Maize and soy feed the poultry industry — higher grain costs flow into chicken prices.',
        'Food is a large share of the CPI basket, so this lifts headline inflation and hits low-income households most.',
      ] : dn ? ['Lower import costs for staples should gradually ease food inflation.', 'Poultry and baking costs fall as feed and flour cheapen.'] : ['No major world food shock; local food prices will be driven more by weather and the exchange rate.'],
      watch: 'Local weather/drought conditions, which matter as much as world prices for fresh produce.',
      gauge: up ? { inflation: 1 } : dn ? { inflation: -0.5 } : {}, sources: ['fred', 'worldbank'] });
  }

  // 7. US interest rates
  const ff = fred.FEDFUNDS; const t10 = fred.DGS10;
  if (ff?.length) {
    const c = changeOver(ff, 183, 'pp'); const lv = last(ff).value; const y10 = t10?.length ? last(t10).value : null;
    const cut = c < -0.2; const hike = c > 0.2;
    add({ id: 'fed', scope: 'World', level: cut ? 'easing' : hike ? 'pressure' : 'neutral', severity: cut || hike ? 2 : 0,
      title: cut ? 'The US Fed is cutting rates' : hike ? 'The US Fed is raising rates' : 'US interest rates are on hold',
      signal: `Fed funds ${fmt(lv, 2)}% (${signed(c, 2, ' pts')} over 6 months)${y10 != null ? `; US 10-year yield ${fmt(y10, 2)}%` : ''}.`,
      effects: cut ? [
        'Narrows the gap between US and Jamaican rates, reducing the pull of money out of JMD assets — eases pressure on the currency.',
        'Gives the BOJ more room to cut its own rate without destabilising the JMD.',
        'Lowers borrowing costs on global markets for the government and large Jamaican firms.',
        'Falling rates have historically supported JSE stock prices.',
      ] : hike ? [
        'US dollar assets become more attractive — more pressure on the JMD and on BOJ reserves.',
        'The BOJ is likely to keep rates high to defend the currency.',
        'Refinancing US-dollar debt gets more expensive.',
      ] : ['Steady US rates mean no new external push on the JMD from this channel.'],
      watch: 'Next FOMC meeting and US inflation prints.',
      gauge: cut ? { external: -1 } : hike ? { external: 1, growth: -0.5 } : {}, sources: ['fred'] });
  }

  // 8. US jobs → remittances & tourism
  const ur = fred.UNRATE;
  if (ur?.length) {
    const lv = last(ur).value; const yr = ur.slice(-13, -1).map((p) => p.value);
    const rise = yr.length ? lv - Math.min(...yr) : 0; const c6 = changeOver(ur, 183, 'pp');
    const warn = rise >= 0.5; const soft = rise >= 0.3;
    add({ id: 'usjobs', scope: 'World', level: warn ? 'pressure' : soft ? 'watch' : 'easing', severity: warn ? 2 : soft ? 1 : 0,
      title: warn ? 'US job market is weakening' : soft ? 'US job market is softening' : 'US job market is holding up',
      signal: `US unemployment ${fmt(lv)}% (${signed(c6, 1, ' pts')} over 6 months; ${signed(rise, 1, ' pts')} above its 12-month low).${remit ? ` Remittances are about ${remit} of Jamaica’s GDP (World Bank, ${wb['BX.TRF.PWKR.DT.GD.ZS'].year}).` : ''}`,
      effects: warn || soft ? [
        'The US is the largest source of remittances — job losses among the diaspora mean smaller or less frequent transfers.',
        'Remittances fund household spending, school fees and home construction, so retail and hardware sales feel it first.',
        'Fewer US jobs also means fewer US holidays booked to Jamaica.',
        'Lower remittance inflows reduce US-dollar supply in the local FX market.',
      ] : ['A healthy US job market supports steady remittance flows and tourism demand.'],
      watch: 'Monthly US jobs report (first Friday) and BOJ remittance data.',
      gauge: warn ? { growth: -1, external: 1 } : soft ? { growth: -0.5 } : { growth: 0.5 }, sources: ['fred', 'worldbank'] });
  }

  // 9. US consumer sentiment → tourism
  const cs = fred.UMCSENT;
  if (cs?.length) {
    const lv = last(cs).value; const avg = cs.slice(-13, -1).reduce((a, p) => a + p.value, 0) / Math.max(1, cs.slice(-13, -1).length);
    const low = lv < 60 || lv < avg - 5; const high = lv > avg + 5 && lv >= 70;
    add({ id: 'tourism', scope: 'World', level: low ? 'watch' : high ? 'easing' : 'neutral', severity: low ? 1 : 0,
      title: low ? 'US consumers are gloomy — a tourism risk' : high ? 'US consumers are upbeat' : 'US consumer mood is average',
      signal: `US consumer sentiment ${fmt(lv)} vs 12-month average ${fmt(avg)}.${tour ? ` Tourism earns about ${tour} of Jamaica’s exports (World Bank).` : ''}`,
      effects: low ? [
        'Americans are the majority of Jamaica’s stopover visitors; when they feel squeezed, discretionary travel is among the first things cut.',
        'Softer bookings would hit hotels, attractions, transport operators, craft vendors and farm suppliers to hotels.',
        'Tourism is the main source of US dollars, so weaker arrivals also weigh on the JMD.',
      ] : ['Confident US consumers support travel demand and US-dollar inflows from tourism.'],
      watch: 'JTB arrival figures and airline seat capacity.',
      gauge: low ? { growth: -0.5 } : high ? { growth: 0.5 } : {}, sources: ['fred', 'worldbank'] });
  }

  // 10. US inflation → imported inflation
  const cpi = fred.CPIAUCSL;
  if (cpi?.length > 13) {
    const yoy = last(yoySeries(cpi)).value;
    if (yoy > 3) add({ id: 'usinfl', scope: 'World', level: 'watch', severity: 1, title: 'US inflation is elevated',
      signal: `US consumer prices up ${fmt(yoy)}% over the last year.`,
      effects: ['The US is Jamaica’s largest trading partner, so higher US prices feed into the cost of imported goods.', 'Keeps the Fed cautious about cutting rates, which limits relief on the JMD.'],
      watch: 'Monthly US CPI release.', gauge: { inflation: 0.5 }, sources: ['fred'] });
  }

  // 11. Broad US dollar
  const usd = fred.DTWEXBGS;
  if (usd?.length) {
    const c = changeOver(usd, 90);
    if (c != null && Math.abs(c) > 3) add({ id: 'usd', scope: 'World', level: c > 0 ? 'watch' : 'easing', severity: 1,
      title: c > 0 ? 'The US dollar is strengthening globally' : 'The US dollar is weakening globally',
      signal: `Broad US dollar index ${signed(c)} over 3 months.`,
      effects: c > 0 ? ['Adds general pressure on currencies like the JMD.', 'Remittances and visitor spending from the UK and Canada are worth less in US-dollar terms; Jamaica gets pricier for those visitors.']
        : ['Takes pressure off emerging-market currencies, including the JMD.', 'UK and Canadian visitors and remitters get more for their money.'],
      watch: 'Fed policy and global risk sentiment.', gauge: c > 0 ? { external: 0.5 } : { external: -0.5 }, sources: ['fred'] });
  }

  // 12. Partner economies (IMF)
  const us1 = imfAt('NGDP_RPCH:USA', year); const us2 = imfAt('NGDP_RPCH:USA', year + 1);
  if (us2 != null) {
    const ca2 = imfAt('NGDP_RPCH:CAN', year + 1); const uk2 = imfAt('NGDP_RPCH:GBR', year + 1);
    const weak = us2 < 1.2;
    add({ id: 'partners', scope: 'World', level: weak ? 'watch' : 'neutral', severity: weak ? 1 : 0,
      title: weak ? 'Main partner economies are slowing' : 'Main partner economies are growing',
      signal: `IMF growth forecasts for ${year + 1}: US ${fmt(us2)}%${ca2 != null ? `, Canada ${fmt(ca2)}%` : ''}${uk2 != null ? `, UK ${fmt(uk2)}%` : ''}${us1 != null ? ` (US ${year}: ${fmt(us1)}%)` : ''}.`,
      effects: ['These three countries supply most of Jamaica’s visitors, remittances and import goods.', weak ? 'Slower growth there usually shows up here 6–12 months later through tourism and remittances.' : 'Steady growth there supports demand for Jamaican tourism and steady remittances.'],
      watch: 'IMF WEO updates (April & October).', gauge: weak ? { growth: -0.5 } : { growth: 0.5 }, sources: ['imf'] });
  }

  // 13. Jamaica growth
  const q = st.gdpGrowth; const j1 = imfAt('NGDP_RPCH:JAM', year); const j2 = imfAt('NGDP_RPCH:JAM', year + 1);
  if (q || j2 != null) {
    const contracting = q && q.value < 0; const rec = j2 != null && j2 > (j1 ?? 0) + 1;
    add({ id: 'growth', scope: 'Jamaica', level: contracting ? 'pressure' : rec ? 'easing' : 'neutral', severity: contracting ? (q.value < -2 ? 3 : 2) : 1,
      title: contracting ? 'The economy is contracting' : rec ? 'A recovery is forecast' : 'Growth is modest',
      signal: `${q ? `GDP ${signed(q.value)} year-on-year (${q.period || 'latest quarter'}, STATIN). ` : ''}${j1 != null ? `IMF forecast: ${fmt(j1)}% in ${year}` : ''}${j2 != null ? `, ${fmt(j2)}% in ${year + 1}.` : ''}`,
      effects: contracting ? [
        'Lower output means weaker business sales and tax revenue, and pressure on hiring.',
        'Government may need to borrow more or trim spending, which matters for the debt path.',
        'Rebuilding/reconstruction activity (construction, hardware, insurance payouts) can partly offset the drag.',
      ] : rec ? ['Forecast pickup suggests rising demand — good for retail, construction and lending.', 'Recovery years often see faster import growth too, adding some pressure on the JMD.'] : ['Low growth limits job creation and wage gains; productivity is the long-run constraint.'],
      watch: 'Next STATIN quarterly GDP and PIOJ estimates.',
      gauge: { growth: contracting ? (q.value < -2 ? -2 : -1) : rec ? 1 : 0 }, sources: ['statin', 'imf'] });
  }

  // 14. Labour market
  const u = st.unemployment;
  if (u) {
    const tight = u.value < 5.5;
    add({ id: 'jobs', scope: 'Jamaica', level: tight ? 'easing' : u.value > 8 ? 'pressure' : 'neutral', severity: 0,
      title: tight ? 'Jamaica’s labour market is tight' : 'Unemployment is elevated',
      signal: `Unemployment ${fmt(u.value)}% (${u.period || 'latest'})${st.youthUnemployment ? `; youth ${fmt(st.youthUnemployment.value)}%` : ''}${st.lu4 ? `; broad underutilisation ${fmt(st.lu4.value)}%` : ''}.`,
      effects: tight ? ['Near-record-low unemployment supports household spending.', 'Employers in tourism, BPO and construction compete for workers, pushing wages — and some prices — up.', 'Growth now depends more on productivity than on adding workers.'] : ['Slack in the job market caps wage growth and spending.'],
      watch: 'STATIN Labour Force Survey (quarterly).', gauge: tight ? { growth: 0.5, inflation: 0.25 } : { growth: -0.5 }, sources: ['statin'] });
  }

  // 15. Trade
  if (st.exports && st.imports) {
    const ratio = st.imports.value / st.exports.value;
    add({ id: 'trade', scope: 'Jamaica', level: 'neutral', severity: 0, title: 'Goods trade deficit',
      signal: `Imports US$${fmt(st.imports.value)}M vs exports US$${fmt(st.exports.value)}M (${st.imports.period || 'latest month'}) — about ${fmt(ratio, 1)}× more bought than sold.`,
      effects: ['The gap is financed by tourism, remittances and BPO services; when those dip, the JMD feels it.', 'Rising imports during rebuilding or strong consumer demand adds to US-dollar demand.'],
      watch: 'Monthly STATIN trade bulletin.', gauge: {}, sources: ['statin'] });
  }

  // 16. Public debt
  const dk = 'GGXWDG_NGDP:JAM'; const dNow = imfAt(dk, year); const dNext = imfAt(dk, year + 1); const dPrev = imfAt(dk, year - 1);
  if (dNow != null && dNext != null) {
    const rising = dNext > dNow + 0.5 || (dPrev != null && dNow > dPrev + 2);
    add({ id: 'debt', scope: 'Jamaica', level: rising ? 'watch' : 'easing', severity: rising ? 1 : 0,
      title: rising ? 'Public debt ratio is rising' : 'Public debt is on a downward path',
      signal: `IMF: government debt ${dPrev != null ? `${fmt(dPrev)}% (${year - 1}) → ` : ''}${fmt(dNow)}% (${year}) → ${fmt(dNext)}% of GDP (${year + 1}).`,
      effects: rising ? ['Higher debt means more of the budget goes to interest instead of services.', 'Credit-rating agencies watch this closely; a credible path back down keeps borrowing costs in check.']
        : ['Falling debt frees budget space and supports credit-rating upgrades, lowering borrowing costs.'],
      watch: 'Fiscal Policy Paper and rating-agency reviews.', gauge: rising ? { external: 0.5 } : { external: -0.5 }, sources: ['imf'] });
  }

  // 17. Reserve buffer
  const res = wb['FI.RES.TOTL.MO'];
  if (res) add({ id: 'reserves', scope: 'Jamaica', level: res.value >= 3 ? 'easing' : 'pressure', severity: res.value >= 3 ? 0 : 2,
    title: res.value >= 3 ? 'FX reserves provide a buffer' : 'FX reserves are thin',
    signal: `Reserves cover about ${fmt(res.value)} months of imports (World Bank, ${res.year}); 3 months is the common minimum benchmark.`,
    effects: res.value >= 3 ? ['Gives the BOJ firepower to smooth sharp JMD moves after shocks.'] : ['Limits the BOJ’s ability to defend the JMD during shocks.'],
    watch: 'BOJ monthly NIR announcements.', gauge: res.value >= 3 ? { external: -0.5 } : { external: 1 }, sources: ['worldbank'] });

  // 18. Hurricanes
  const n = d.nhc;
  if (n) {
    const m = now.getMonth(); const season = m >= 5 && m <= 10;
    if (n.jamaicaMention) add({ id: 'storm', scope: 'World', level: 'pressure', severity: 3, title: 'Active storm advisories mention Jamaica',
      signal: `Active: ${n.storms.map((s) => s.name).join(', ')}.`,
      effects: ['Expect tourism cancellations, farm losses (pushing up local food prices) and possible power and road outages.', 'Rebuilding costs strain the budget; Jamaica’s catastrophe bond and contingent credit lines are designed to cushion this.', 'Insurance claims and reconstruction later boost construction and hardware demand.'],
      watch: 'NHC advisories and ODPEM bulletins.', gauge: { shock: 3 }, sources: ['nhc'] });
    else if (n.storms.length) add({ id: 'storm', scope: 'World', level: 'watch', severity: 1, title: 'Active Atlantic storm(s)',
      signal: `Active: ${n.storms.map((s) => s.name).join(', ')} — no Jamaica mention in current advisories.`,
      effects: ['No direct threat flagged, but tracks can shift; tourism bookings can still be disrupted.'],
      watch: 'NHC advisories.', gauge: { shock: 1 }, sources: ['nhc'] });
    else if (n.maxChance >= 40) add({ id: 'storm', scope: 'World', level: 'watch', severity: 1, title: 'Tropical development possible',
      signal: `NHC gives up to a ${n.maxChance}% chance of formation in the next 7 days.`,
      effects: ['Nothing named yet; worth watching if the area is in the Caribbean.'], watch: 'NHC outlook.', gauge: { shock: 0.5 }, sources: ['nhc'] });
    else if (season) add({ id: 'storm', scope: 'World', level: 'easing', severity: 0, title: 'No active Atlantic storms',
      signal: 'NHC reports no tropical cyclones and no significant development expected.',
      effects: ['No weather shock on the horizon this week.'], watch: 'Hurricane season runs June–November.', gauge: {}, sources: ['nhc'] });
  }

  // 19. Remittances — actual BOJ figures
  const rm = d.remit;
  if (rm?.yoy != null) {
    const down = rm.yoy < 0; const strong = rm.yoy >= 5;
    add({ id: 'remit', scope: 'Jamaica', level: down ? 'pressure' : strong ? 'easing' : 'neutral', severity: down ? (rm.yoy < -5 ? 3 : 2) : 0,
      title: down ? 'Remittances are falling' : strong ? 'Remittances are growing strongly' : 'Remittances are steady',
      signal: `Net remittances US$${fmt(rm.net)}M in ${rm.month} (${signed(rm.yoy)} vs a year earlier)${rm.usShare ? `; ${fmt(rm.usShare)}% came from the US` : ''}${rm.fytd ? `. Fiscal year to date ${signed(rm.fytd.yoy)}.` : '.'}`,
      effects: down ? ['Less household income for spending, school fees and home building — retail and hardware feel it first.', 'Fewer US dollars flowing in through cambios puts pressure on the JMD.']
        : ['Diaspora money is cushioning household budgets and supporting spending.', 'Steady US-dollar inflows help keep the JMD stable.'],
      watch: 'Next BOJ Remittance Bulletin (about 7 weeks after month-end).',
      gauge: down ? { growth: -0.5, external: 1 } : strong ? { growth: 0.5, external: -0.5 } : {}, sources: ['remit'] });
  }

  // 20. Tourism — actual arrivals
  const tr = d.tourism;
  if (tr?.stopovers || tr?.mbj) {
    const s0 = tr.stopovers; const mb = tr.mbj;
    const ch = s0?.change ?? mb?.change; const weak = ch < -5; const strong = ch > 5;
    add({ id: 'arrivals', scope: 'Jamaica', level: weak ? 'pressure' : strong ? 'easing' : 'neutral', severity: weak ? (ch < -15 ? 3 : 2) : 0,
      title: weak ? 'Tourist arrivals are down' : strong ? 'Tourist arrivals are up' : 'Tourist arrivals are flat',
      signal: `${s0 ? `Stopover visitors ${signed(s0.change)} year-on-year (${s0.month})` : ''}${s0 && mb ? '; ' : ''}${mb ? `Montego Bay airport passengers ${signed(mb.change)} (${mb.month})` : ''}.`,
      effects: weak ? [
        'Tourism is Jamaica’s biggest earner of US dollars — fewer visitors means less FX inflow and more pressure on the JMD.',
        'Hotel, attraction, transport and craft jobs and hours are at risk, especially on the north coast.',
        'Farmers, manufacturers and distributors who supply hotels see weaker orders.',
      ] : ['More visitors bring in US dollars, support jobs on the north coast and lift suppliers to the industry.'],
      watch: 'Monthly JTB and airport figures; winter season bookings.',
      gauge: weak ? { growth: ch < -15 ? -1.5 : -1, external: 1 } : strong ? { growth: 1, external: -0.5 } : {}, sources: ['tourism'] });
  }

  // 21. Aluminium → bauxite/alumina export earnings
  const al = fred.PALUMUSDM;
  if (al?.length) {
    const c = changeOver(al, 183);
    if (c != null && Math.abs(c) > 8) add({ id: 'alum', scope: 'World', level: c > 0 ? 'easing' : 'watch', severity: 1,
      title: c > 0 ? 'Aluminium prices are rising' : 'Aluminium prices are falling',
      signal: `Aluminium US$${fmt(last(al).value, 0)}/t, ${signed(c)} over 6 months.`,
      effects: [c > 0 ? 'Bauxite and alumina are Jamaica’s largest goods exports; firmer metal prices improve export earnings and plant viability.' : 'Weaker metal prices squeeze bauxite/alumina earnings and can put plant operations and jobs at risk.', 'Mining also pays royalties and levies to the government.'],
      watch: 'Alumina plant operating announcements.', gauge: c > 0 ? { external: -0.5, growth: 0.25 } : { external: 0.5, growth: -0.25 }, sources: ['fred'] });
  }

  // 22. Shipping costs
  const fr = fred.PCU483111483111;
  if (fr?.length) {
    const c = changeOver(fr, 183);
    if (c != null && Math.abs(c) > 7) add({ id: 'freight', scope: 'World', level: c > 0 ? 'pressure' : 'easing', severity: c > 15 ? 2 : 1,
      title: c > 0 ? 'Ocean shipping costs are rising' : 'Ocean shipping costs are falling',
      signal: `Deep-sea freight cost index ${signed(c)} over 6 months.`,
      effects: [c > 0 ? 'Almost everything Jamaica imports arrives by container, so higher freight adds to shelf prices, car landing costs and building materials within a few months.' : 'Cheaper freight trims the landed cost of imported goods, from groceries to vehicles.'],
      watch: 'Shipping-line surcharges and port fees.', gauge: c > 0 ? { inflation: 0.5 } : { inflation: -0.5 }, sources: ['fred'] });
  }

  // 23. Global risk mood
  const vix = fred.VIXCLS; const em = fred.BAMLEMHBHYCRPIOAS;
  if (vix?.length || em?.length) {
    const v = vix?.length ? last(vix).value : null; const ce = em?.length ? changeOver(em, 90, 'pp') : null;
    const stress = (v != null && v > 25) || (ce != null && ce > 0.75); const calm = (v != null && v < 16) && (ce == null || ce < 0);
    add({ id: 'risk', scope: 'World', level: stress ? 'pressure' : calm ? 'easing' : 'neutral', severity: stress ? 2 : 0,
      title: stress ? 'Global investors are nervous' : calm ? 'Global markets are calm' : 'Global risk mood is normal',
      signal: `${v != null ? `VIX fear gauge ${fmt(v)}` : ''}${v != null && em?.length ? '; ' : ''}${em?.length ? `emerging-market high-yield spread ${fmt(last(em).value, 2)}% (${signed(ce, 2, ' pts')} in 3 months)` : ''}.`,
      effects: stress ? ['When investors flee risk, borrowing costs rise for countries like Jamaica and money tends to leave smaller markets.', 'Expect pressure on the JMD, JSE prices and government bond yields.']
        : ['Calm markets keep Jamaica’s overseas borrowing costs lower and support investment flows.'],
      watch: 'Jamaica’s credit-rating reviews and global market sell-offs.', gauge: stress ? { external: 1 } : calm ? { external: -0.5 } : {}, sources: ['fred'] });
  }

  // 24. Canada jobs
  const cu = fred.LRUNTTTTCAM156S;
  if (cu?.length) {
    const c6 = changeOver(cu, 183, 'pp');
    if (c6 != null && Math.abs(c6) >= 0.4) add({ id: 'canada', scope: 'World', level: c6 > 0 ? 'watch' : 'easing', severity: 1,
      title: c6 > 0 ? 'Canada’s job market is weakening' : 'Canada’s job market is improving',
      signal: `Canada unemployment ${fmt(last(cu).value)}% (${signed(c6, 1, ' pts')} over 6 months).`,
      effects: ['Canada sends roughly a tenth of Jamaica’s remittances and many winter visitors.', c6 > 0 ? 'A weaker Canadian job market trims both.' : 'Stronger Canadian jobs support both.'],
      watch: 'Canadian jobs report.', gauge: c6 > 0 ? { growth: -0.25 } : { growth: 0.25 }, sources: ['fred'] });
  }

  // 25. Pump prices (Petrojam)
  const pj = d.petrojam?.weeks;
  if (pj?.length >= 2 && pj[0].prices['Gasolene 87'] && pj[1].prices['Gasolene 87']) {
    const g0 = pj[0].prices['Gasolene 87']; const g1 = pj[1].prices['Gasolene 87']; const c = (g0 / g1 - 1) * 100;
    const dz0 = pj[0].prices['Auto Diesel']; const dz1 = pj[1].prices['Auto Diesel']; const cd = dz0 && dz1 ? (dz0 / dz1 - 1) * 100 : null;
    add({ id: 'fuel', scope: 'Jamaica', level: c > 1.5 ? 'pressure' : c < -1.5 ? 'easing' : 'neutral', severity: c > 3 ? 2 : c > 1.5 ? 1 : 0,
      title: c > 1.5 ? 'Fuel prices went up this week' : c < -1.5 ? 'Fuel prices went down this week' : 'Fuel prices little changed this week',
      signal: `Petrojam gasolene 87 J$${fmt(g0, 2)}/L (${signed(c)} w/w)${cd != null ? `, diesel J$${fmt(dz0, 2)} (${signed(cd)})` : ''} — week of ${new Date(pj[0].date + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}. Pump prices add taxes and margins on top.`,
      effects: ['Weekly refinery prices pass to the pump within days, and to taxi/bus fares and delivery costs over weeks.', 'Compare with Brent: world oil moves usually reach Petrojam prices within 1–3 weeks.'],
      watch: 'Petrojam’s weekly price update.', gauge: c > 1.5 ? { inflation: 0.25 } : c < -1.5 ? { inflation: -0.25 } : {}, sources: ['petrojam'] });
  }

  // Gauges → labels
  const gauges = {
    inflation: gaugeOf(g.inflation, ['Easing', 'Contained', 'Building', 'Hot'], [-0.75, 0.75, 1.75]),
    growth: gaugeOf(-g.growth, ['Firm', 'Steady', 'Soft', 'Weak'], [-0.75, 0.75, 1.75]),
    external: gaugeOf(g.external, ['Supportive', 'Balanced', 'Strained', 'Stressed'], [-0.75, 0.75, 1.75]),
    shock: gaugeOf(g.shock, ['Quiet', 'Quiet', 'Watch', 'Active'], [-99, 0.25, 2]),
  };

  const order = { pressure: 0, watch: 1, easing: 2, neutral: 3 };
  insights.sort((a, b) => (order[a.level] - order[b.level]) || (b.severity - a.severity));

  return { insights, gauges, headline: headline(gauges), consider: consider(gauges, insights) };
}

function gaugeOf(score, labels, cuts) {
  let i = 0; while (i < cuts.length && score > cuts[i]) i++;
  return { score: clamp(score, -3, 3), label: labels[i], step: i }; // step 0 good … 3 bad
}

function headline(gs) {
  const p = [];
  p.push({ Hot: 'Prices are running hot', Building: 'Price pressure is building', Contained: 'Prices are broadly contained', Easing: 'Price pressure is easing' }[gs.inflation.label]);
  p.push({ Weak: 'growth is weak', Soft: 'growth is soft', Steady: 'growth is steady', Firm: 'growth is firm' }[gs.growth.label]);
  p.push({ Stressed: 'the external backdrop is stressed', Strained: 'outside forces are adding strain', Balanced: 'outside forces are balanced', Supportive: 'outside forces are supportive' }[gs.external.label]);
  let s = `${p[0]}, ${p[1]}, and ${p[2]}.`;
  if (gs.shock.label === 'Active') s += ' A weather shock is in play.';
  else if (gs.shock.label === 'Watch') s += ' Keep an eye on the tropics.';
  return s;
}

function consider(gs, ins) {
  const has = (id, lvl) => ins.some((i) => i.id === id && (!lvl || i.level === lvl));
  const h = []; const b = []; const inv = [];
  if (gs.inflation.step >= 2) {
    h.push('Budget for higher food, fuel and electricity bills over the next few months.');
    b.push('Review pricing and lock in supplier prices or contracts where possible.');
    inv.push('High-inflation periods usually keep local rates up — fixed-income yields stay attractive, rate-sensitive stocks tend to lag.');
  } else if (gs.inflation.step === 0) {
    inv.push('Easing inflation opens the door to BOJ rate cuts — historically supportive for JSE equities and bond prices.');
  }
  if (has('fx', 'pressure') || gs.external.step >= 2) {
    h.push('If you have US-dollar costs (tuition, travel, imported goods), consider buying US$ in tranches rather than all at once.');
    b.push('Importers: plan US-dollar needs early; exporters and tourism earners benefit from a weaker JMD.');
    inv.push('Some US-dollar exposure can hedge JMD weakness.');
  }
  if (gs.growth.step >= 2) {
    b.push('Keep inventory lean and protect cash flow; demand may stay soft.');
    h.push('Build an emergency buffer — slower growth can mean fewer hours or overtime.');
  } else if (gs.growth.step === 0) {
    b.push('Demand looks supportive — a reasonable window for planned expansion.');
  }
  if (has('fed', 'easing')) inv.push('Falling US rates ease pressure on the JMD and on global borrowing costs.');
  if (gs.shock.step >= 2) h.push('Check hurricane supplies, insurance and documents now.');
  if (!h.length) h.push('No urgent adjustments signalled — keep an eye on the pressure cards.');
  if (!b.length) b.push('Conditions are mixed; watch exchange rate and input costs.');
  if (!inv.length) inv.push('No strong rate or currency signal right now.');
  return { households: h, businesses: b, investors: inv };
}


// ---------- Borrowing & big-purchase outlook ----------
export function borrowing(d, now = new Date()) {
  const boj = d.boj || {}; const r = d.bojrates || {}; const fred = d.fred?.series || {}; const fx = d.fx || {};
  const reasons = []; let score = 0;
  const push = (pts, txt) => { score += pts; reasons.push({ pts, txt }); };
  const infl = boj.inflation ?? d.statin?.cpiPtp?.value; const [lo, hi] = boj.target || [4, 6];
  if (infl != null) {
    if (infl > hi + 1.5) push(2, `Inflation (${fmt(infl)}%) is well above the BOJ’s ${lo}–${hi}% target — the BOJ won’t cut while that lasts.`);
    else if (infl > hi) push(1, `Inflation (${fmt(infl)}%) is above the target range.`);
    else if (infl < lo) push(-2, `Inflation (${fmt(infl)}%) is below target — room for rate cuts.`);
    else push(-1, `Inflation (${fmt(infl)}%) is inside the target range.`);
  }
  if (boj.policyRate != null && infl != null) {
    const real = boj.policyRate - infl;
    if (real < 0) push(1, `The policy rate (${fmt(boj.policyRate, 2)}%) is below inflation — pressure to raise it, not cut.`);
    else if (real > 2.5) push(-1, `The policy rate is well above inflation — tight enough to allow cuts later.`);
  }
  const tb = r.tbills?.m3;
  if (tb?.length >= 4) {
    const c = changeOver(tb, 95, 'pp');
    if (c > 0.25) push(1, `3-month T-bill yields rose ${signed(c, 2, ' pts')} in 3 months — markets expect higher rates.`);
    else if (c < -0.25) push(-1, `3-month T-bill yields fell ${signed(c, 2, ' pts')} in 3 months — markets expect lower rates.`);
    else push(0, `3-month T-bill yields are flat (${fmt(last(tb).value, 2)}%).`);
  }
  const inst = r.loans?.instalment;
  if (inst?.length >= 7) {
    const c = changeOver(inst, 183, 'pp');
    if (c > 0.2) push(1, `Average vehicle (instalment) loan rates rose ${signed(c, 2, ' pts')} in 6 months.`);
    else if (c < -0.2) push(-1, `Average vehicle (instalment) loan rates fell ${signed(c, 2, ' pts')} in 6 months.`);
  }
  const h90 = fx.history?.find((h) => h.daysAgo === 90);
  if (fx.now && h90) { const c = (fx.now.jmd / h90.jmd - 1) * 100; if (c > 1.5) push(1, `The JMD weakened ${signed(c)} in 3 months — the BOJ may keep rates high to defend it.`); }
  const brent = fred.DCOILBRENTEU; if (brent?.length) { const c = changeOver(brent, 90); if (c > 10) push(1, `Oil is up ${signed(c)} in 3 months, adding to inflation.`); else if (c < -10) push(-1, `Oil is down ${signed(c)} in 3 months, easing inflation.`); }
  const ff = fred.FEDFUNDS; if (ff?.length) { const c = changeOver(ff, 183, 'pp'); if (c < -0.2) push(-1, 'The US Fed is cutting, which gives the BOJ more room.'); else if (c > 0.2) push(1, 'The US Fed is hiking, which limits the BOJ.'); }

  const label = score >= 5 ? 'Likely to rise' : score >= 2 ? 'Staying high' : score >= -1 ? 'Holding steady' : 'Likely to ease';
  const step = score >= 5 ? 3 : score >= 2 ? 2 : score >= -1 ? 1 : 0;
  const advice = score >= 2 ? [
    'Rate cuts look unlikely in the next few months, so waiting for cheaper loans probably won’t pay off soon.',
    'If you borrow now, a fixed rate protects you if rates rise further.',
    'Shop around — the average is a guide; individual offers vary with credit history, deposit and the lender.',
  ] : score <= -2 ? [
    'Rates look more likely to fall than rise; a variable rate or a shorter wait could save interest.',
    'Watch the next BOJ decision — cuts usually reach loan offers with a lag of a few months.',
  ] : ['No strong signal either way; compare offers and focus on what fits your budget.'];

  // Car-cost signals
  const car = [];
  const hist = (n) => fx.history?.find((h) => h.daysAgo === n);
  if (fx.now?.jpy && hist(90)?.jpy) {
    const jmdPerYenNow = fx.now.jmd / fx.now.jpy; const ago = hist(90).jmd / hist(90).jpy; const ago12 = hist(365)?.jpy ? hist(365).jmd / hist(365).jpy : null;
    const c = (jmdPerYenNow / ago - 1) * 100; const c12 = ago12 ? (jmdPerYenNow / ago12 - 1) * 100 : null;
    car.push({ name: 'Yen vs JMD', value: `J$${fmt(jmdPerYenNow * 100, 2)} per ¥100`, change: `${signed(c)} 3m${c12 != null ? ` · ${signed(c12)} 12m` : ''}`, dir: c > 2 ? 'up' : c < -2 ? 'down' : 'flat',
      note: 'Most used cars are imported from Japan — a stronger yen makes them dearer to land.' });
  }
  if (fx.now && h90) {
    const c = (fx.now.jmd / h90.jmd - 1) * 100;
    car.push({ name: 'US$ vs JMD', value: `J$${fmt(fx.now.jmd, 2)}`, change: `${signed(c)} 3m`, dir: c > 1.5 ? 'up' : c < -1.5 ? 'down' : 'flat', note: 'New cars, parts and many fees are priced in US dollars.' });
  }
  const fr = fred.PCU483111483111;
  if (fr?.length) { const c = changeOver(fr, 183); car.push({ name: 'Ocean freight', value: fmt(last(fr).value, 0), change: `${signed(c)} 6m`, dir: c > 7 ? 'up' : c < -7 ? 'down' : 'flat', note: 'Shipping is part of every imported car’s landed cost.' }); }
  const pj = d.petrojam?.weeks;
  if (pj?.[0]?.prices['Gasolene 87']) {
    const g = pj[0].prices['Gasolene 87']; const g1 = pj[1]?.prices['Gasolene 87'];
    const c = g1 ? (g / g1 - 1) * 100 : null;
    car.push({ name: 'Gasolene 87 (Petrojam)', value: `J$${fmt(g, 2)}/L`, change: c != null ? `${signed(c)} w/w` : '', dir: c > 1.5 ? 'up' : c < -1.5 ? 'down' : 'flat', note: 'Refinery price before taxes and retail margin — tracks what you’ll pay at the pump.' });
  }
  const ups = car.filter((x) => x.dir === 'up').length; const downs = car.filter((x) => x.dir === 'down').length;
  const carLabel = ups >= 2 ? 'Import costs rising' : downs >= 2 ? 'Import costs easing' : 'Import costs mixed/steady';

  return { score, label, step, reasons, advice, car, carLabel };
}
