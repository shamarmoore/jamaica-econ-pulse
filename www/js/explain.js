// Plain-language explanations shown when a card is tapped.
// what = what the number is · read = how to interpret it · you = why it matters for a Jamaican household.
// now(d) (optional) = one line reading today's value.
import { fmt, signed, changeOver } from './util.js';

const last = (s) => s?.[s.length - 1];
const fredNow = (id, good, bad, unit = '') => (d) => {
  const s = d.fred?.series?.[id]; if (!s?.length) return null;
  const c = changeOver(s, 90); if (c == null) return null;
  return `${signed(c)} over the last 3 months${unit} — ${c > 5 ? bad : c < -5 ? good : 'little change, so no strong push either way'}.`;
};

export const EXPLAIN = {
  // ---------- Pulse gauges ----------
  g_inflation: {
    t: 'Inflation pressure',
    what: 'A summary of everything in the app that pushes Jamaican prices up or down: the latest inflation reading against the BOJ’s 4–6% target, oil, food and grain prices, the exchange rate, shipping costs and pump prices.',
    read: 'Easing → Contained → Building → Hot. Each signal adds or subtracts points; the label shows where the total lands. “Building” means more forces are pushing prices up than down, even if today’s inflation figure still looks fine.',
    you: 'When this is Building or Hot, expect grocery, fuel and utility bills to rise over the next few months, and expect the BOJ to keep interest rates high. That’s a reason to lock in fixed prices and fixed-rate loans where you can and keep a bigger cash buffer.',
  },
  g_growth: {
    t: 'Growth momentum',
    what: 'How strongly the economy is expanding: GDP, unemployment, tourism arrivals, remittances, US and Canadian job markets, and the IMF’s forecast.',
    read: 'Firm → Steady → Soft → Weak. Firm means jobs and spending are growing; Weak means the economy is losing steam or shrinking.',
    you: 'Firm growth supports job security, raises and easier job moves. Soft or Weak growth is a signal to protect your income first: build savings, avoid new big commitments, and be careful about leaving a stable job.',
  },
  g_external: {
    t: 'External pressure',
    what: 'How hard the outside world is squeezing Jamaica’s finances: the J$ exchange rate, oil, US interest rates, global market stress, foreign reserves, government debt and the flow of US dollars from tourism and remittances.',
    read: 'Supportive → Balanced → Strained → Stressed. Strained means more forces are pulling US dollars out of Jamaica or making them dearer.',
    you: 'External strain usually shows up later as a weaker J$, higher import prices and higher interest rates. If it’s Strained or Stressed, holding some savings in US dollars and avoiding US$-priced debt you earn J$ to repay makes more sense.',
  },
  g_shock: {
    t: 'Shock risk',
    what: 'Near-term disruption risk, mainly Atlantic storms from the US National Hurricane Center.',
    read: 'Quiet → Watch → Active. Active means a named storm is active or Jamaica is mentioned in advisories.',
    you: 'When Active, stock up early (water, food, fuel, cash), check insurance, and delay big purchases that a storm could disrupt or that depend on shipping.',
  },

  // ---------- Jamaica: prices & policy ----------
  infl: {
    what: 'How much consumer prices rose over the last 12 months (point-to-point CPI from STATIN, as reported by the BOJ).',
    read: 'The BOJ aims for 4–6%. Below 4% is low; inside the band is healthy; above 6% means the cost of living is rising faster than the BOJ wants and rate cuts are unlikely.',
    you: 'Compare it with any raise you get and with what your savings earn. If your savings earn less than this number, they’re losing buying power.',
    now: (d) => { const v = d.boj?.inflation ?? d.statin?.cpiPtp?.value; if (v == null) return null; const [lo, hi] = d.boj?.target || [4, 6];
      return v > hi ? `At ${fmt(v)}% it’s above the ${lo}–${hi}% target — expect rates to stay high.` : v < lo ? `At ${fmt(v)}% it’s below target — room for the BOJ to cut rates.` : `At ${fmt(v)}% it’s inside the ${lo}–${hi}% target.`; },
  },
  policy: {
    what: 'The overnight rate the Bank of Jamaica pays on deposits from banks. It anchors all other J$ interest rates.',
    read: 'When the BOJ raises it, loan and deposit rates follow within months; cuts work the other way. The next decision date shows when it could change.',
    you: 'A cutting cycle is a better time to take a variable-rate loan; a hiking cycle favours fixed rates and saving. Watch the next decision date before signing a big loan.',
  },
  cpiM: {
    what: 'The change in consumer prices in the latest month alone.',
    read: 'About 0.3–0.5% a month adds up to the 4–6% yearly target. A single month above 1% is usually food (weather) or fuel/electricity.',
    you: 'One hot month is noise; two or three in a row usually push the 12-month figure up later.',
  },
  cpiYtd: {
    what: 'How much prices have risen since December of last year.',
    read: 'Useful mid-year: compare it with how far through the year we are. 3% by June is on pace for about 6% for the year.',
    you: 'A quick check on whether this year’s cost of living is running hotter or cooler than last year.',
  },
  ppiMan: {
    what: 'Producer Price Index for manufacturing — what Jamaican factories charge for their goods.',
    read: 'Rising producer prices tend to reach shop shelves a few months later.',
    you: 'An early warning for local goods prices (food processing, drinks, building materials).',
  },
  ppiMin: {
    what: 'Producer Price Index for mining and quarrying, mostly bauxite/alumina and aggregates.',
    read: 'It moves with world aluminium prices and energy costs.',
    you: 'Matters mostly for construction costs and the bauxite sector’s earnings.',
  },

  // ---------- Exchange rate ----------
  usdBoj: {
    what: 'The BOJ’s weighted average selling rate for one US dollar, based on what banks and cambios actually traded.',
    read: 'A higher number means a weaker J$. The J$ normally slides a few percent a year; a slide faster than about 4–5% a year signals pressure.',
    you: 'Most of what Jamaica consumes is imported and priced off the US$, so a faster slide means higher prices for cars, electronics, fuel and food.',
  },
  usdMid: {
    what: 'The market mid-rate for US$1 in J$, with how much it has moved over 1, 3 and 12 months.',
    read: 'Positive changes mean the J$ weakened. Steady or small moves are normal; sharp moves over a month or quarter mean pressure.',
    you: 'If you plan a US$ purchase (a car import, school fees, travel), a quickening slide is a reason to buy or lock the rate sooner.',
    now: (d) => { const fx = d.fx; const h = fx?.history?.find((z) => z.daysAgo === 365); if (!fx?.now || !h) return null; const c = (fx.now.jmd / h.jmd - 1) * 100;
      return `The J$ has ${c >= 0 ? 'weakened' : 'strengthened'} ${fmt(Math.abs(c), 1)}% against the US$ in a year — ${c > 5 ? 'faster than usual' : c > 0 ? 'a normal gradual slide' : 'unusually strong'}.`; },
  },
  fxCross: {
    what: 'The BOJ selling rate for other major currencies.',
    read: 'These move with both the J$ and the US$ against each currency.',
    you: 'Relevant for Canadian and UK remittances, travel and school fees — a stronger CAD or GBP means more J$ for money sent home.',
  },

  // ---------- Jobs, output & trade ----------
  gdp: {
    what: 'How much more (or less) the economy produced than the same quarter a year ago, after inflation (STATIN).',
    read: 'Jamaica’s normal pace is about 1–2%. Negative means the economy is shrinking; above 3% is strong (often a rebound).',
    you: 'Weak growth tends to mean fewer openings and smaller raises; strong growth means more opportunities to switch or negotiate.',
  },
  unemp: {
    what: 'Share of people who want work and are looking but don’t have a job (STATIN Labour Force Survey).',
    read: 'Jamaica is near historic lows (around 3–5%). Rising readings mean the job market is loosening.',
    you: 'A tight job market strengthens your hand when asking for a raise or changing jobs.',
  },
  youth: {
    what: 'Unemployment among people aged 14–24.',
    read: 'It is always higher than the overall rate; watch the direction more than the level.',
    you: 'A sensitive early signal — young workers are often the first hired and first let go.',
  },
  partic: {
    what: 'Share of working-age people who are either working or looking for work.',
    read: 'Rising participation alongside low unemployment means the economy is drawing people into work.',
    you: 'Mostly context: a falling rate can make unemployment look better than it is.',
  },
  trade: {
    what: 'The gap between goods Jamaica imported and exported in the latest month (US$ millions).',
    read: 'Jamaica always imports more goods than it exports; tourism and remittances cover the gap. A widening gap means more US$ demand.',
    you: 'A wider gap adds pressure on the exchange rate unless tourism and remittances keep pace.',
  },
  remit: {
    what: 'Money sent home by Jamaicans abroad, net of outflows, in the latest month (BOJ).',
    read: 'About a fifth of GDP. Growth year-on-year is supportive; a decline means less US$ coming in and less spending.',
    you: 'Strong remittances support the J$ and household spending. Most come from the US, so US jobs matter here too.',
  },
  stopovers: {
    what: 'Change in stopover (overnight) visitors versus the same month last year.',
    read: 'Tourism is Jamaica’s biggest US$ earner. Positive growth is supportive; double-digit declines are a warning.',
    you: 'Strong tourism means more jobs and US$ inflows; weak tourism hits hospitality and related work first.',
  },
  mbj: {
    what: 'Passenger traffic at Sangster International (Montego Bay), versus a year ago.',
    read: 'An early, fast-updating read on tourist arrivals.',
    you: 'Same message as stopovers, often a few weeks sooner.',
  },
  fuel: {
    what: 'Petrojam’s ex-refinery price per litre (before taxes and retail margins), updated weekly.',
    read: 'Pump prices follow this within days. Week-on-week moves above 1–2% are noticeable at the pump.',
    you: 'Use it to anticipate pump prices and taxi/transport fare pressure; it also feeds JPS fuel charges.',
  },

  // ---------- IMF ----------
  imf_NGDP_RPCH: { what: 'IMF estimate and forecast of Jamaica’s real GDP growth (World Economic Outlook, updated April and October).', read: 'Solid line = actual, dashed = projection. Around 1–2% is normal; lower forecasts mean the IMF expects a slowdown.', you: 'A downgrade is an early warning for jobs and business conditions.' },
  imf_PCPIPCH: { what: 'IMF estimate and forecast of average inflation for the year.', read: 'Compare with the BOJ’s 4–6% band. A forecast above 6% means the IMF expects stubborn price pressure.', you: 'If the forecast is high, plan for bills rising and interest rates staying elevated.' },
  imf_LUR: { what: 'IMF estimate and forecast of Jamaica’s unemployment rate.', read: 'Rising projections mean a softer job market ahead.', you: 'A planning signal for job security and raises.' },
  imf_GGXWDG_NGDP: { what: 'Government debt as a share of the economy.', read: 'Jamaica has cut this from about 140% to well under 80%. Falling is good — it means lower borrowing costs and better credit ratings.', you: 'Lower debt gives the government room to respond to shocks (like storms) without big tax rises.' },
  imf_BCA_NGDPD: { what: 'The current account: everything Jamaica earns from abroad (exports, tourism, remittances) minus what it spends abroad, as % of GDP.', read: 'Negative = a deficit. Deficits larger than about 4–5% of GDP leave the J$ more vulnerable.', you: 'Bigger deficits make a weaker J$ more likely.' },
  imf_GGXCNL_NGDP: { what: 'The government’s overall budget balance as % of GDP.', read: 'Positive = surplus. Jamaica has run surpluses to pay down debt; a swing to deficit can mean policy is loosening.', you: 'Surpluses support stability; deficits can mean new taxes or borrowing later.' },

  // ---------- World Bank ----------
  'wb_BX.TRF.PWKR.DT.GD.ZS': { what: 'Remittances as a share of Jamaica’s economy.', read: 'The higher this is, the more the economy depends on jobs in the US, UK and Canada.', you: 'Explains why US job news shows up in this app.' },
  'wb_ST.INT.RCPT.XP.ZS': { what: 'Tourism earnings as a share of all exports.', read: 'A high share means a hit to tourism (storms, US recession) hits US$ inflows hard.', you: 'Explains why visitor numbers matter for the exchange rate.' },
  'wb_FI.RES.TOTL.MO': { what: 'How many months of imports Jamaica’s foreign reserves could pay for.', read: 'Above 3 months is the usual safety line; Jamaica has been well above it.', you: 'Strong reserves let the BOJ steady the J$ during shocks.' },
  'wb_TM.VAL.FUEL.ZS.UN': { what: 'Fuel as a share of goods imports.', read: 'A high share means oil prices swing the import bill and the exchange rate.', you: 'Why oil prices feed into electricity, transport and the J$.' },
  'wb_TM.VAL.FOOD.ZS.UN': { what: 'Food as a share of goods imports.', read: 'A high share means world grain and food prices feed directly into grocery bills.', you: 'Why wheat and corn prices appear in this app.' },
  'wb_NE.IMP.GNFS.ZS': { what: 'Imports of goods and services as a share of GDP.', read: 'Jamaica imports roughly half of what it uses, so world prices and the exchange rate pass through quickly.', you: 'Why a weaker J$ shows up in prices quickly.' },
  'wb_BX.KLT.DINV.WD.GD.ZS': { what: 'Foreign direct investment coming in, as % of GDP.', read: 'Higher inflows mean more foreign money building hotels, plants and BPOs.', you: 'Supports jobs and the J$.' },
  'wb_GC.DOD.TOTL.GD.ZS': { what: 'Central government debt as % of GDP (World Bank measure).', read: 'Falling is good: less of the budget goes to interest.', you: 'Lower debt = more room for public services and less pressure for tax rises.' },

  // ---------- World (FRED) ----------
  DCOILBRENTEU: { what: 'The global benchmark price for crude oil, in US$ per barrel.', read: 'Moves of more than 10% in three months matter. Rising oil is pressure; falling oil is relief.', you: 'Fuel is a big share of Jamaica’s imports, so oil drives pump prices, JPS bills, bus fares and the exchange rate.', now: fredNow('DCOILBRENTEU', 'relief for pump prices and electricity bills', 'expect higher pump prices and JPS fuel charges') },
  DHHNGSP: { what: 'US natural gas price (Henry Hub benchmark).', read: 'Jamaica now generates a large share of its electricity from imported LNG; prices tend to follow US gas with a lag.', you: 'Affects JPS bills over time.', now: fredNow('DHHNGSP', 'helpful for electricity costs later', 'could feed into electricity costs later') },
  FEDFUNDS: { what: 'The US Federal Reserve’s main policy interest rate.', read: 'Higher US rates pull money toward the US dollar and make it harder for the BOJ to cut. Cuts ease that pressure.', you: 'When the Fed cuts, Jamaican rates have more room to fall later — better for borrowers.' },
  DGS10: { what: 'The interest rate on 10-year US government bonds.', read: 'It sets the tone for long-term borrowing worldwide. Rising yields tighten conditions for countries like Jamaica.', you: 'Rising US yields make it costlier for Jamaica to borrow abroad and can weigh on the J$.' },
  UNRATE: { what: 'US unemployment rate.', read: 'Below about 4.5% is healthy. A steady rise often comes before a US recession.', you: 'Most remittances and tourists come from the US — weaker US jobs mean fewer of both.' },
  CPIAUCSL: { what: 'US consumer inflation over 12 months.', read: 'Above 2–3% keeps the Fed cautious about cutting rates.', you: 'High US inflation also means pricier US imports.' },
  UMCSENT: { what: 'University of Michigan survey of how confident US consumers feel.', read: 'Falling sentiment often means Americans cut back on travel and spending.', you: 'A leading signal for tourist bookings.' },
  DTWEXBGS: { what: 'The US dollar against a broad basket of currencies.', read: 'A strong dollar makes US$ debt and imports dearer for many countries and adds pressure on emerging-market currencies.', you: 'A rising dollar often coincides with J$ pressure.' },
  PFOODINDEXM: { what: 'IMF index of world food commodity prices.', read: 'Rising food prices reach Jamaican supermarkets within a few months.', you: 'An early read on grocery bills.', now: fredNow('PFOODINDEXM', 'grocery pressure should ease', 'grocery prices likely to rise') },
  PWHEAMTUSDM: { what: 'World wheat price (US$ per tonne).', read: 'Jamaica imports all its wheat, used for flour, bread and baked goods.', you: 'Rising wheat → higher bread, flour and patty prices a few months later.', now: fredNow('PWHEAMTUSDM', 'flour and bread prices may ease', 'flour and bread prices may rise') },
  PMAIZMTUSDM: { what: 'World maize (corn) price (US$ per tonne).', read: 'Corn is the main animal feed, so it drives chicken, egg and pork costs.', you: 'Rising corn → dearer chicken and eggs a few months later.', now: fredNow('PMAIZMTUSDM', 'chicken and egg costs may ease', 'chicken and egg prices may rise') },
  PALUMUSDM: { what: 'World aluminium price (US$ per tonne).', read: 'Higher aluminium prices help Jamaica’s bauxite/alumina export earnings.', you: 'Good for US$ inflows and jobs in the bauxite parishes.' },
  PCU483111483111: { what: 'US producer price index for deep-sea freight shipping.', read: 'Rising freight costs add to the landed cost of everything imported.', you: 'Shipping costs flow into shelf prices, especially for bulky goods and cars.' },
  VIXCLS: { what: 'Expected volatility in US stocks, often called the “fear gauge”.', read: 'Under 15 is calm, 20–30 is nervous, above 30 is panic.', you: 'Market stress tends to hit riskier investments (including JSE stocks) and can pull money out of small economies.' },
  BAMLEMHBHYCRPIOAS: { what: 'The extra yield investors demand to hold risky emerging-market corporate bonds instead of US Treasuries.', read: 'Widening spreads mean investors are nervous about countries like Jamaica; narrowing spreads mean confidence.', you: 'When spreads widen, borrowing gets dearer for Jamaican companies and the government.' },
  SP500: { what: 'The S&P 500 index of large US companies.', read: 'A broad gauge of US wealth and confidence.', you: 'A strong US market supports US spending, tourism and remittances.' },
  DTB3: { what: 'The interest rate on 3-month US Treasury bills.', read: 'What safe US$ money earns. Compare it with J$ deposit rates.', you: 'If you hold US$ savings, this is roughly what “risk-free” US$ cash earns.' },
  LRUNTTTTCAM156S: { what: 'Canada’s unemployment rate.', read: 'Canada is a major source of remittances and visitors.', you: 'A rising rate means less money sent home from Canada.' },
  nhc: { what: 'Active storms and the 7-day outlook from the US National Hurricane Center.', read: 'Season runs June–November. Watch for any mention of Jamaica or the central Caribbean.', you: 'Prepare early and avoid timing big purchases or travel around an approaching system.' },
  pgrowth: { what: 'IMF growth estimate and forecast for a major partner economy.', read: 'These economies supply Jamaica’s tourists and remittances.', you: 'Slower partner growth usually means fewer visitors and less money sent home.' },

  // ---------- Borrow tab rate tiles ----------
  r_instalment: { what: 'Average interest rate banks actually charge on instalment loans, mostly vehicle loans (BOJ).', read: 'The change shows the direction over 6 months. Individual offers can be 1–3 points above or below.', you: 'Use it as a benchmark when a dealer or bank quotes you a car-loan rate.' },
  r_personal: { what: 'Average rate on unsecured personal loans.', read: 'Usually the most expensive loan type.', you: 'Avoid funding big purchases this way; pay these off first.' },
  r_mortgage: { what: 'Average rate banks charge on residential mortgages.', read: 'Moves slowly and follows the BOJ policy rate.', you: 'Used for the bank portion of the home-buying calculator.' },
  r_overall: { what: 'Average rate across all bank loans.', read: 'A summary of whether credit is getting cheaper or dearer.', you: 'Falling = easier borrowing conditions.' },
  r_time12: { what: 'Average rate paid on J$ fixed deposits of 12 months or more.', read: 'Compare with inflation: if it’s lower, savings lose buying power.', you: 'If deposits pay less than your loans cost, paying debt down is the better “investment”.' },
  r_savings: { what: 'Average rate on regular savings accounts.', read: 'Usually well below inflation.', you: 'Keep only your emergency buffer here; park longer-term money where it earns more.' },
  r_tb3: { what: 'Yield on 3-month Government of Jamaica Treasury bills.', read: 'Moves quickly with BOJ policy — the best early sign of where deposit and loan rates are heading.', you: 'Falling T-bill yields usually mean loan rates fall a few months later.' },
  r_tb6: { what: 'Yield on 6-month Government of Jamaica Treasury bills.', read: 'Like the 3-month bill but looks a little further ahead.', you: 'A falling trend is good news for borrowers; a rising one for savers.' },

  // ---------- Decide cards ----------
  d_spend: { t: 'Household spending', what: 'A rule-based reading of whether now is a time to spend normally or tighten up.', read: 'Built from inflation, interest rates, the job market, the exchange rate and storm risk. Each factor adds or subtracts points; the label shows the total.', you: 'If it says trim, prioritise essentials, delay large discretionary purchases and build three to six months of expenses in savings.' },
  d_borrow: { t: 'Borrowing', what: 'Where loan rates are likely heading over the next 3–6 months.', read: 'Based on the BOJ policy rate and next decision, T-bill yields, inflation, the exchange rate and US rates. “Likely to ease” means waiting could get you a cheaper loan.', you: 'If rates are rising, lock in fixed rates sooner; if easing, a variable rate or waiting may pay off.' },
  d_home: { t: 'Buying a home', what: 'Whether market conditions favour buying a home now.', read: 'Considers mortgage-rate direction, inflation (which erodes fixed debt), the job market and the exchange rate. It doesn’t know your finances — the calculator below does.', you: 'Only buy when you have the deposit, closing costs and an emergency buffer; conditions only change how good the timing is.' },
  d_invest: { t: 'Investing', what: 'Example asset mixes by risk level, tilted by today’s data.', read: 'Lean in/out arrows show which asset classes the current data favours. These are illustrations, not product recommendations.', you: 'Pick the risk level that matches your timeline; adjust gradually rather than all at once.' },
  d_work: { t: 'Job moves', what: 'Whether the job market favours looking for or negotiating a new role.', read: 'Based on unemployment, growth, tourism, remittances and sector signals.', you: 'Strong readings support asking for a raise or switching; weak readings favour staying put and building skills.' },
};
