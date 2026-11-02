import { SOURCES, FRED } from './sources.js';
import { analyse, borrowing } from './analysis.js';
import { fmt, signed, last, changeOver, yoySeries } from './util.js';

const KEY = 'ep_cache_v1';
const PREV = 'ep_prev_gauges_v1';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let cache = {};
try { cache = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (_) { cache = {}; }
let prevGauges = null;
try { prevGauges = JSON.parse(localStorage.getItem(PREV)); } catch (_) { /* none */ }
const running = new Set();
let tab = 'pulse';

function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) { /* storage full */ } }
function data() { const d = {}; for (const s of SOURCES) d[s.id] = cache[s.id]?.data; return d; }
const stale = (s) => !cache[s.id]?.at || (Date.now() - cache[s.id].at) > s.ttlH * 3600e3;

async function refresh(force = false) {
  const todo = SOURCES.filter((s) => force || stale(s));
  if (!todo.length) { render(); return; }
  todo.forEach((s) => running.add(s.id));
  status(); render();
  await Promise.all(todo.map(async (s) => {
    try {
      const res = await s.fn();
      const prev = cache[s.id]?.data;
      // keep previously-saved values for any field this fetch couldn't read (partial page loads)
      const merged = prev && res && !Array.isArray(res) ? { ...prev, ...Object.fromEntries(Object.entries(res).filter(([, v]) => v != null)) } : res;
      cache[s.id] = { data: merged, at: Date.now() };
    } catch (e) {
      cache[s.id] = { ...(cache[s.id] || {}), error: String(e.message || e), errorAt: Date.now() };
    } finally {
      running.delete(s.id); save(); status(); render(false);
    }
  }));
  const a = analyse(data());
  try {
    const old = JSON.parse(localStorage.getItem(PREV) || 'null');
    if (!old || old.day !== new Date().toDateString()) {
      prevGauges = old;
      localStorage.setItem(PREV, JSON.stringify({ day: new Date().toDateString(), g: a.gauges }));
    }
  } catch (_) { /* ignore */ }
}

function status() {
  const el = $('#status');
  if (running.size) { el.innerHTML = `<span class="spin"></span>Fetching ${running.size} source${running.size > 1 ? 's' : ''}…`; return; }
  const times = SOURCES.map((s) => cache[s.id]?.at).filter(Boolean);
  const fails = SOURCES.filter((s) => cache[s.id]?.error && (!cache[s.id].at || cache[s.id].errorAt > cache[s.id].at));
  const newest = times.length ? new Date(Math.max(...times)) : null;
  el.innerHTML = newest
    ? `Updated ${ago(newest)}${fails.length ? ` · <button class="linkish" data-goto="sources">${fails.length} source${fails.length > 1 ? 's' : ''} unreachable</button>` : ' · all sources live'}`
    : 'No data yet — tap refresh';
}

const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fd(iso, day = true) { if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || ''; const [y, m, d] = iso.split('-'); return `${day ? `${+d} ` : ''}${MON[+m - 1]} ${y}`; }

function ago(d) {
  const m = Math.round((Date.now() - d) / 60000);
  if (m < 1) return 'just now'; if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
  return d.toLocaleDateString('en-JM', { day: 'numeric', month: 'short' });
}

// ---------- small visual pieces ----------
function spark(points, { w = 150, h = 40, proj = null, fmtX = (p) => fd(p.date), unit = '' } = {}) {
  if (!points || points.length < 2) return '';
  const vs = points.map((p) => p.value); const mn = Math.min(...vs); const mx = Math.max(...vs);
  const pad = 4; const sx = (i) => pad + (i / (points.length - 1)) * (w - pad * 2);
  const sy = (v) => mx === mn ? h / 2 : h - pad - ((v - mn) / (mx - mn)) * (h - pad * 2);
  const xy = points.map((p, i) => [sx(i), sy(p.value)]);
  const split = proj != null ? points.findIndex((p) => p.year >= proj) : -1;
  const path = (arr) => arr.map((q, i) => `${i ? 'L' : 'M'}${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('');
  let lines;
  if (split > 0) lines = `<path d="${path(xy.slice(0, split))}" class="sl"/><path d="${path(xy.slice(split - 1))}" class="sl proj"/>`;
  else lines = `<path d="${path(xy)}" class="sl"/>`;
  const lp = xy[split > 0 ? split - 1 : xy.length - 1];
  const payload = esc(JSON.stringify(points.map((p) => [fmtX(p), p.value])));
  return `<div class="spark" data-pts="${payload}" data-unit="${esc(unit)}">
    <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" role="img" aria-label="trend">${lines}
      <circle cx="${lp[0]}" cy="${lp[1]}" r="3.2" class="sd"/><line class="cross" x1="0" x2="0" y1="0" y2="${h}" style="display:none"/></svg>
    <div class="readout">${esc(fmtX(points[0]).replace(/^\d+ /, ''))} → ${esc(fmtX(points[points.length - 1]).replace(/^\d+ /, ''))}</div></div>`;
}

const LEVEL = { pressure: ['Pressure', '▲'], watch: ['Watch', '◆'], easing: ['Relief', '▼'], neutral: ['Steady', '●'] };
const STEP_CLASS = ['good', 'ok', 'warn', 'bad'];
const STEP_ICON = ['✓', '•', '!', '‼'];

function gaugeCard(name, gauge, prev, blurb) {
  const segs = [0, 1, 2, 3].map((i) => `<i class="${i <= gauge.step ? STEP_CLASS[gauge.step] : ''}"></i>`).join('');
  const moved = prev && prev.label !== gauge.label ? `<span class="moved">was ${esc(prev.label)}</span>` : '';
  return `<div class="gauge"><div class="gname">${name}</div>
    <div class="glabel ${STEP_CLASS[gauge.step]}"><span class="gi">${STEP_ICON[gauge.step]}</span>${gauge.label}</div>
    <div class="segs">${segs}</div><div class="gblurb">${blurb}${moved}</div></div>`;
}

function insightCard(x, i) {
  const [lab, ic] = LEVEL[x.level];
  return `<article class="ins ${x.level}">
    <div class="ins-h"><span class="chip ${x.level}">${ic} ${lab}</span><span class="scope">${x.scope}</span></div>
    <h3>${esc(x.title)}</h3>
    <p class="sig">${esc(x.signal)}</p>
    <details ${i < 2 ? 'open' : ''}><summary>How it could affect Jamaica</summary>
      <ul>${x.effects.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>
      <p class="watch"><b>Watch:</b> ${esc(x.watch)}</p>
      <p class="src">Data: ${x.sources.map((s) => esc(SOURCES.find((z) => z.id === s)?.name || s)).join(' · ')}</p>
    </details></article>`;
}

function empty(msg) { return `<div class="empty">${msg}</div>`; }

// ---------- views ----------
function viewPulse(d, a) {
  if (!a.insights.length) return empty(running.size ? 'Gathering the latest numbers…' : 'No data yet. Check your connection and tap refresh.');
  const pg = prevGauges?.g || {};
  const c = a.consider;
  return `
  <section class="lede"><p>${esc(a.headline)}</p></section>
  <section class="gauges">
    ${gaugeCard('Inflation pressure', a.gauges.inflation, pg.inflation, 'Prices & cost of living')}
    ${gaugeCard('Growth momentum', a.gauges.growth, pg.growth, 'Output, jobs, demand')}
    ${gaugeCard('External pressure', a.gauges.external, pg.external, 'JMD, oil, US rates, flows')}
    ${gaugeCard('Shock risk', a.gauges.shock, pg.shock, 'Storms & disruptions')}
  </section>
  <h2 class="sec">What’s moving the economy</h2>
  ${a.insights.map(insightCard).join('')}
  <h2 class="sec">Things to consider</h2>
  <section class="consider">
    ${[['Households', c.households], ['Businesses', c.businesses], ['Investors', c.investors]].map(([t, l]) => `
      <div><h4>${t}</h4><ul>${l.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`).join('')}
    <p class="fine">Rule-based readings of public data, not forecasts or financial advice.</p>
  </section>`;
}

function stat(label, value, sub, extra = '') {
  return `<div class="stat"><div class="sl-l">${label}</div><div class="sv">${value}</div><div class="ss">${sub || ''}</div>${extra}</div>`;
}

function targetBar(v, lo, hi) {
  const max = Math.max(12, Math.ceil(v + 1)); const p = (x) => `${(Math.max(0, x) / max) * 100}%`;
  return `<div class="tbar" aria-label="inflation versus target"><span class="band" style="left:${p(lo)};width:calc(${p(hi)} - ${p(lo)})"></span>
    <span class="mk" style="left:${p(v)}"></span></div><div class="tlab"><span>0%</span><span>target ${lo}–${hi}%</span><span>${max}%</span></div>`;
}

function viewJamaica(d) {
  const b = d.boj || {}; const s = d.statin || {}; const fx = d.fx; const imf = d.imf?.series || {}; const wb = d.worldbank;
  const out = [];
  const infl = b.inflation ?? s.cpiPtp?.value;
  out.push('<h2 class="sec">Prices & policy</h2><div class="grid">');
  if (infl != null) out.push(stat('Inflation (12-month)', `${fmt(infl)}%`, b.inflationPeriod || s.cpiPtp?.period, targetBar(infl, ...(b.target || [4, 6]))));
  if (b.policyRate != null) out.push(stat('BOJ policy rate', `${fmt(b.policyRate, 2)}%`, `Set ${b.policyDate || '—'}${b.nextPolicyDate ? `<br>Next: <b>${b.nextPolicyDate}</b>` : ''}`));
  if (s.cpiMonthly) out.push(stat('Monthly inflation', `${fmt(s.cpiMonthly.value)}%`, s.cpiMonthly.period));
  if (s.cpiCalYtd) out.push(stat('Calendar-YTD inflation', `${fmt(s.cpiCalYtd.value)}%`, s.cpiCalYtd.period));
  if (s.ppiManufacturing) out.push(stat('PPI manufacturing', fmt(s.ppiManufacturing.value), s.ppiManufacturing.period));
  if (s.ppiMining) out.push(stat('PPI mining & quarrying', fmt(s.ppiMining.value), s.ppiMining.period));
  out.push('</div>');

  out.push('<h2 class="sec">Exchange rate</h2><div class="grid">');
  if (b.fx?.USD) out.push(stat('US$ (BOJ)', `J$${fmt(b.fx.USD.sell, 2)}`, `buy ${fmt(b.fx.USD.buy, 2)} · ${fd(b.fxDate)}`));
  if (fx?.now) {
    const pts = [...(fx.history || [])].sort((x, y) => y.daysAgo - x.daysAgo).map((h) => ({ date: h.date, value: h.jmd }));
    pts.push({ date: fx.now.date, value: fx.now.jmd });
    const h = (n) => fx.history.find((z) => z.daysAgo === n);
    const ch = (n) => h(n) ? signed((fx.now.jmd / h(n).jmd - 1) * 100) : '—';
    out.push(stat('US$ market mid', `J$${fmt(fx.now.jmd, 2)}`, `1m ${ch(30)} · 3m ${ch(90)} · 12m ${ch(365)}`, spark(pts, { unit: ' JMD' })));
  }
  for (const c of ['CAD', 'GBP', 'EUR']) if (b.fx?.[c]) out.push(stat(`${c} (BOJ)`, `J$${fmt(b.fx[c].sell, 2)}`, `buy ${fmt(b.fx[c].buy, 2)}`));
  out.push('</div>');

  out.push('<h2 class="sec">Jobs, output & trade</h2><div class="grid">');
  if (s.gdpGrowth) out.push(stat('GDP growth (y/y)', signed(s.gdpGrowth.value), s.gdpGrowth.period));
  if (s.unemployment) out.push(stat('Unemployment', `${fmt(s.unemployment.value)}%`, s.unemployment.period));
  if (s.youthUnemployment) out.push(stat('Youth unemployment', `${fmt(s.youthUnemployment.value)}%`, s.youthUnemployment.period));
  if (s.participation) out.push(stat('Labour force participation', `${fmt(s.participation.value)}%`, s.participation.period));
  if (s.exports && s.imports) out.push(stat('Goods trade (month)', `−US$${fmt(s.imports.value - s.exports.value)}M`, `exports ${fmt(s.exports.value)} · imports ${fmt(s.imports.value)} · ${s.imports.period || ''}`));
  out.push('</div>');

  const rm = d.remit; const tr = d.tourism; const pj = d.petrojam?.weeks;
  if (rm || tr || pj) {
    out.push('<h2 class="sec">Dollars coming in & fuel</h2><div class="grid">');
    if (rm) out.push(stat('Net remittances', `US$${fmt(rm.net)}M`, `${rm.month} · ${signed(rm.yoy)} y/y${rm.usShare ? ` · US ${fmt(rm.usShare)}%` : ''}`));
    if (tr?.stopovers) out.push(stat('Stopover visitors (y/y)', signed(tr.stopovers.change), tr.stopovers.month));
    if (tr?.mbj) out.push(stat('Montego Bay airport passengers', signed(tr.mbj.change), `${tr.mbj.month} · y/y`));
    if (pj?.[0]) for (const f of ['Gasolene 87', 'Auto Diesel']) {
      const v = pj[0].prices[f]; const p1 = pj[1]?.prices[f];
      if (v) out.push(stat(`${f} (Petrojam)`, `J$${fmt(v, 2)}`, `per litre · ${p1 ? `${signed((v / p1 - 1) * 100)} w/w · ` : ''}${fd(pj[0].date)}`));
    }
    out.push('</div>');
  }
  const yr = new Date().getFullYear();
  const imfTiles = ['NGDP_RPCH', 'PCPIPCH', 'LUR', 'GGXWDG_NGDP', 'BCA_NGDPD', 'GGXCNL_NGDP'].filter((k) => imf[`${k}:JAM`]);
  if (imfTiles.length) {
    out.push(`<h2 class="sec">IMF outlook <small>solid = actual · dashed = projection</small></h2><div class="grid">`);
    for (const k of imfTiles) {
      const sr = imf[`${k}:JAM`]; const cur = sr.find((p) => p.year === yr) || [...sr].reverse().find((p) => p.year < yr); const nx = sr.find((p) => p.year === yr + 1);
      out.push(stat(d.imf.labels[k], cur ? `${fmt(cur.value)}` : '—', `${cur ? cur.year : yr}${nx ? ` · ${yr + 1}: ${fmt(nx.value)}` : ''}`, spark(sr, { proj: yr, fmtX: (p) => String(p.year), unit: '' })));
    }
    out.push('</div>');
  }
  if (wb?.latest && Object.keys(wb.latest).length) {
    out.push('<h2 class="sec">How exposed Jamaica is <small>World Bank, latest year</small></h2><div class="grid">');
    for (const [k, v] of Object.entries(wb.latest)) out.push(stat(wb.labels[k], fmt(v.value), String(v.year)));
    out.push('</div>');
  }
  return out.length > 8 ? out.join('') : empty('Jamaican sources haven’t loaded yet.');
}

function viewWorld(d) {
  const f = d.fred?.series || {}; const imf = d.imf?.series || {}; const n = d.nhc;
  const out = [];
  if (n) {
    out.push('<h2 class="sec">Atlantic hurricanes</h2><div class="grid one">');
    out.push(stat('NOAA National Hurricane Center',
      n.storms.length ? n.storms.map((s) => `${esc(s.name)}${s.jamaica ? ' <b class="bad">· mentions Jamaica</b>' : ''}`).join('<br>') : 'No active storms',
      n.outlook ? esc(n.outlook.slice(0, 260)) : ''));
    out.push('</div>');
  }
  const groups = [
    ['Energy', ['DCOILBRENTEU', 'DHHNGSP']],
    ['US money & markets', ['FEDFUNDS', 'DGS10', 'DTWEXBGS']],
    ['Where visitors & remittances come from', ['UNRATE', 'CPIAUCSL', 'UMCSENT', 'LRUNTTTTCAM156S']],
    ['Food import costs', ['PFOODINDEXM', 'PWHEAMTUSDM', 'PMAIZMTUSDM']],
    ['Exports & shipping', ['PALUMUSDM', 'PCU483111483111']],
    ['Global risk mood', ['VIXCLS', 'BAMLEMHBHYCRPIOAS']],
  ];
  for (const [g, ids] of groups) {
    const tiles = ids.filter((id) => f[id]?.length).map((id) => {
      let s = f[id]; let label = FRED[id].label; let unit = FRED[id].unit;
      if (id === 'CPIAUCSL') { s = yoySeries(s); label = 'US inflation (y/y)'; unit = '%'; }
      const l = last(s); const pp = unit === '%';
      const ch = pp ? changeOver(s, 183, 'pp') : changeOver(s, 90);
      const val = unit === '%' ? `${fmt(l.value, 2)}%` : unit.startsWith('US$') ? `$${fmt(l.value, 2)}` : fmt(l.value, 1);
      const sub = `${pp ? `${signed(ch, 2, ' pts')} in 6m` : `${signed(ch)} in 3m`} · ${fd(l.date, !/^(UNRATE|CPIAUCSL|UMCSENT|FEDFUNDS|PFOOD|PWHEA|PMAIZ|PALUM|PCU|LRUN)/.test(id))}`;
      const thin = s.length > 260 ? s.filter((_, i) => i % Math.ceil(s.length / 260) === 0 || i === s.length - 1) : s;
      return stat(`${label}${unit !== '%' && unit !== 'index' ? ` <small>${unit}</small>` : ''}`, val, sub, spark(thin, { unit: unit === '%' ? '%' : '' }));
    });
    if (tiles.length) out.push(`<h2 class="sec">${g}</h2><div class="grid">${tiles.join('')}</div>`);
  }
  const yr = new Date().getFullYear();
  const partners = [['USA', 'United States'], ['CAN', 'Canada'], ['GBR', 'United Kingdom']].filter(([c]) => imf[`NGDP_RPCH:${c}`]);
  if (partners.length) {
    out.push('<h2 class="sec">Partner growth <small>IMF, % real GDP</small></h2><div class="grid">');
    for (const [c, name] of partners) {
      const sr = imf[`NGDP_RPCH:${c}`]; const nx = sr.find((p) => p.year === yr + 1); const cu = sr.find((p) => p.year === yr);
      out.push(stat(name, cu ? `${fmt(cu.value)}%` : '—', `${yr}${nx ? ` · ${yr + 1}: ${fmt(nx.value)}%` : ''}`, spark(sr, { proj: yr, fmtX: (p) => String(p.year), unit: '%' })));
    }
    out.push('</div>');
  }
  return out.length ? out.join('') : empty('World data hasn’t loaded yet.');
}


const CALC_KEY = 'ep_calc_v1';
function calcState(defRate) {
  let c = {}; try { c = JSON.parse(localStorage.getItem(CALC_KEY)) || {}; } catch (_) { /* none */ }
  return { price: c.price ?? 4500000, deposit: c.deposit ?? 900000, rate: c.rate ?? (defRate ? +defRate.toFixed(2) : 11.5), years: c.years ?? 5, km: c.km ?? 250, kml: c.kml ?? 13, pump: c.pump ?? '' };
}
const pmt = (P, ratePct, years) => { const r = ratePct / 1200; const n = years * 12; return r ? (P * r) / (1 - (1 + r) ** -n) : P / n; };
const J = (v) => `J$${Math.round(v).toLocaleString('en-US')}`;

function rateTile(label, series, sub) {
  if (!series?.length) return '';
  const l = last(series); const c = changeOver(series, 183, 'pp');
  return stat(label, `${fmt(l.value, 2)}%`, `${fd(l.date, false)}${c != null ? ` · ${signed(c, 2, ' pts')} 6m` : ''}${sub ? `<br>${sub}` : ''}`, spark(series.map((p) => ({ date: p.date, value: p.value })), { unit: '%', fmtX: (p) => fd(p.date, false) }));
}

function viewBorrow(d) {
  const b = borrowing(d); const r = d.bojrates || {}; const boj = d.boj || {};
  const inst = r.loans?.instalment; const defRate = inst?.length ? last(inst).value : null;
  const c = calcState(defRate);
  const infl = boj.inflation ?? d.statin?.cpiPtp?.value;
  const t12 = r.deposits?.time12?.length ? last(r.deposits.time12).value : null;
  const out = [];
  out.push(`<section class="hero-b">
    <div class="gname">Loan rates outlook · next 3–6 months</div>
    <div class="glabel ${STEP_CLASS[b.step]}"><span class="gi">${STEP_ICON[b.step]}</span>${b.label}</div>
    <div class="segs">${[0, 1, 2, 3].map((i) => `<i class="${i <= b.step ? STEP_CLASS[b.step] : ''}"></i>`).join('')}</div>
    ${boj.nextPolicyDate ? `<div class="gblurb">Next BOJ rate decision: <b>${boj.nextPolicyDate}</b></div>` : ''}
    <ul class="why">${b.reasons.map((x) => `<li class="${x.pts > 0 ? 'up' : x.pts < 0 ? 'down' : ''}"><span>${x.pts > 0 ? '▲' : x.pts < 0 ? '▼' : '●'}</span>${esc(x.txt)}</li>`).join('')}</ul>
    <div class="advice">${b.advice.map((x) => `<p>${esc(x)}</p>`).join('')}</div>
  </section>`);

  out.push('<h2 class="sec">What borrowing costs right now <small>BOJ, commercial-bank averages</small></h2><div class="grid">');
  out.push(rateTile('Vehicle / instalment loans', inst, 'avg rate actually charged'));
  out.push(rateTile('Personal loans', r.loans?.personal));
  out.push(rateTile('Mortgages', r.loans?.mortgage));
  out.push(rateTile('All loans (avg)', r.loans?.overall));
  out.push('</div><h2 class="sec">What saving earns</h2><div class="grid">');
  out.push(rateTile('Time deposit, 12m+', r.deposits?.time12));
  out.push(rateTile('Savings account', r.deposits?.savings));
  out.push(rateTile('3-month T-bill', r.tbills?.m3));
  out.push(rateTile('6-month T-bill', r.tbills?.m6));
  out.push('</div>');
  if (t12 != null && infl != null) {
    const real = t12 - infl;
    out.push(`<p class="note">${real < 0
      ? `A 12-month deposit pays about ${fmt(t12, 2)}% while prices rise ${fmt(infl)}% — savings are losing about ${fmt(-real, 1)}% a year in buying power. ${defRate ? `Paying down a ${fmt(defRate, 1)}% loan is worth more than saving at ${fmt(t12, 1)}%.` : ''}`
      : `A 12-month deposit (${fmt(t12, 2)}%) is beating inflation (${fmt(infl)}%) by ${fmt(real, 1)} points.`}</p>`);
  }

  out.push(`<h2 class="sec">Car loan calculator</h2>
  <section class="calc">
    <label>Car price (J$)<input id="c-price" inputmode="numeric" value="${c.price}"></label>
    <label>Deposit (J$)<input id="c-deposit" inputmode="numeric" value="${c.deposit}"></label>
    <label>Interest rate (%)<input id="c-rate" inputmode="decimal" value="${c.rate}"></label>
    <label>Term (years)<input id="c-years" inputmode="numeric" value="${c.years}"></label>
    <label>Km driven per week<input id="c-km" inputmode="numeric" value="${c.km}"></label>
    <label>Fuel economy (km/L)<input id="c-kml" inputmode="decimal" value="${c.kml}"></label>
    <label class="wide">Pump price you pay (J$/L)<input id="c-pump" inputmode="decimal" value="${c.pump}" placeholder="enter today’s pump price"></label>
    <div id="c-out" class="wide"></div>
    <p class="fine wide">${defRate ? `Rate starts at the current average vehicle-loan rate (${fmt(defRate, 2)}%). ` : ''}Your actual offer depends on lender, credit history and deposit.</p>
  </section>`);

  if (b.car.length) {
    out.push(`<h2 class="sec">Car import cost signals <small>${b.carLabel}</small></h2><ul class="carsig">${b.car.map((x) => `
      <li><div class="cs-h"><b>${x.name}</b><span class="cs-v">${x.value} <em class="${x.dir}">${x.dir === 'up' ? '▲' : x.dir === 'down' ? '▼' : '●'} ${x.change}</em></span></div><div class="fine">${x.note}</div></li>`).join('')}</ul>`);
  }
  out.push('<p class="fine">Rule-based readings of public data to help you time and size a decision — not financial advice.</p>');
  return out.join('');
}

function updateCalc() {
  const el = document.getElementById('c-out'); if (!el) return;
  const g = (id) => parseFloat(String(document.getElementById(id).value).replace(/[,\s$J]/g, ''));
  const st = { price: g('c-price') || 0, deposit: g('c-deposit') || 0, rate: g('c-rate') || 0, years: g('c-years') || 1, km: g('c-km') || 0, kml: g('c-kml') || 0, pump: document.getElementById('c-pump').value };
  try { localStorage.setItem(CALC_KEY, JSON.stringify(st)); } catch (_) { /* ignore */ }
  const P = Math.max(0, st.price - st.deposit); const m = pmt(P, st.rate, st.years); const total = m * st.years * 12;
  const litres = st.kml ? (st.km * 52 / 12) / st.kml : 0; const pump = parseFloat(st.pump);
  const rows = [-1, 0, 1, 2].map((dlt) => { const rr = st.rate + dlt; if (rr <= 0) return ''; const mm = pmt(P, rr, st.years);
    return `<tr${dlt === 0 ? ' class="cur"' : ''}><td>${fmt(rr, 2)}%</td><td>${J(mm)}</td><td>${J(mm * st.years * 12 - P)}</td></tr>`; }).join('');
  el.innerHTML = `<div class="c-big"><span>Monthly payment</span><b>${J(m)}</b></div>
    <div class="c-row"><span>Amount borrowed</span><b>${J(P)}</b></div>
    <div class="c-row"><span>Total interest over ${st.years} yrs</span><b>${J(total - P)}</b></div>
    <div class="c-row"><span>Fuel per month</span><b>${fmt(litres, 0)} L${pump ? ` · ${J(litres * pump)}` : ''}</b></div>
    ${pump ? `<div class="c-row"><span>Payment + fuel</span><b>${J(m + litres * pump)}/mo</b></div>` : ''}
    <table class="sens"><thead><tr><th>Rate</th><th>Monthly</th><th>Total interest</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const TAGS = [
  ['Inflation', /inflation|price|cost of living|cpi/i], ['BOJ & rates', /\bBOJ\b|bank of jamaica|interest rate|policy rate|monetary/i],
  ['FX', /exchange rate|forex|\bFX\b|US\$|dollar|currency/i], ['Tourism', /touris|hotel|cruise|visitor|airline|arrivals/i],
  ['Remittances', /remittance|diaspora/i], ['Energy', /\bJPS\b|electric|fuel|oil|gas\b|energy|petrojam/i],
  ['Fiscal', /budget|tax|\bIMF\b|debt|bond|ministry of finance|fiscal/i], ['Markets', /\bJSE\b|stock|shares|ipo|dividend|investor/i],
  ['Jobs', /jobs|employ|labour|wage|BPO|layoff/i], ['Trade', /export|import|port|shipping|trade/i], ['Weather', /hurricane|storm|drought|flood|melissa/i],
];
let newsFilter = true;
function viewNews(d) {
  const items = d.news?.items || [];
  if (!items.length) return empty('Headlines haven’t loaded yet.');
  const tagged = items.map((it) => ({ ...it, tags: TAGS.filter(([, re]) => re.test(it.title)).map(([t]) => t) }));
  const shown = newsFilter ? tagged.filter((x) => x.tags.length) : tagged;
  const counts = {}; tagged.forEach((x) => x.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t} (${c})`).join(' · ');
  return `<div class="newsbar"><label><input type="checkbox" id="nf" ${newsFilter ? 'checked' : ''}> Economy-related only</label>
    <span class="fine">${top ? `In the news: ${top}` : ''}</span></div>
    <ul class="news">${shown.slice(0, 60).map((x) => `<li><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>
      <div class="nmeta">${x.source}${x.ts ? ` · ${ago(new Date(x.ts))}` : ''}${x.tags.map((t) => `<span class="tag">${t}</span>`).join('')}</div></li>`).join('')}</ul>`;
}

function viewSources() {
  return `<h2 class="sec">Where the numbers come from</h2>
  <p class="fine">Everything is fetched directly from these publishers by your phone — no middleman server, no AI. Each source refreshes on its own schedule; tap refresh to force all.</p>
  <ul class="srcs">${SOURCES.map((s) => {
    const c = cache[s.id] || {}; const bad = c.error && (!c.at || c.errorAt > c.at);
    const st = running.has(s.id) ? '<span class="dot run"></span>fetching' : bad ? `<span class="dot bad"></span>${c.at ? 'using saved copy' : 'unreachable'}` : c.at ? '<span class="dot good"></span>live' : '<span class="dot"></span>not yet fetched';
    return `<li><div class="srow"><b>${s.name}</b><span class="sst">${st}</span></div>
      <div class="fine">${s.scope} — ${s.what}</div>
      <div class="fine">${c.at ? `Last success ${ago(new Date(c.at))}` : ''}${bad ? ` · <span class="bad">${esc(c.error)}</span>` : ''} · refreshes every ${s.ttlH < 24 ? `${s.ttlH} h` : `${s.ttlH / 24} days`}</div>
      <a href="${s.home}" target="_blank" rel="noopener" class="fine">${s.home.replace('https://', '')}</a></li>`;
  }).join('')}</ul>
  <h2 class="sec">How the readings work</h2>
  <p class="fine">Each card applies a fixed rule to the live numbers — for example, Brent oil up more than 10% in three months counts as pressure, because fuel is a large share of Jamaica’s imports and feeds into electricity, transport and the exchange rate. The four gauges add up those signals. Rules describe the usual direction of impact; they are not forecasts, and real outcomes depend on policy and timing.</p>
  <p class="fine">Version 1.1</p>`;
}

function render(force = true) {
  const v = $('#view');
  if (!force && tab === 'borrow' && v.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const d = data(); const a = analyse(d);
  const openIds = [...v.querySelectorAll('details')].map((x) => x.open);
  v.innerHTML = tab === 'pulse' ? viewPulse(d, a) : tab === 'jamaica' ? viewJamaica(d) : tab === 'world' ? viewWorld(d) : tab === 'borrow' ? viewBorrow(d) : tab === 'news' ? viewNews(d) : viewSources();
  if (tab === 'pulse' && openIds.length) v.querySelectorAll('details').forEach((x, i) => { if (openIds[i] !== undefined) x.open = openIds[i]; });
  const nf = $('#nf'); if (nf) nf.onchange = () => { newsFilter = nf.checked; render(); };
  if (tab === 'borrow') { v.querySelectorAll('.calc input').forEach((i) => i.addEventListener('input', updateCalc)); updateCalc(); }
}

// sparkline scrubbing (touch + mouse)
document.addEventListener('pointermove', scrub); document.addEventListener('pointerdown', scrub);
function scrub(e) {
  const sp = e.target.closest?.('.spark'); if (!sp) return;
  const pts = JSON.parse(sp.dataset.pts); const svg = sp.querySelector('svg'); const r = svg.getBoundingClientRect();
  const i = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (pts.length - 1));
  const vb = svg.viewBox.baseVal; const x = 4 + (i / (pts.length - 1)) * (vb.width - 8);
  const cr = svg.querySelector('.cross'); cr.setAttribute('x1', x); cr.setAttribute('x2', x); cr.style.display = '';
  sp.querySelector('.readout').textContent = `${pts[i][0]}: ${fmt(pts[i][1], 2)}${sp.dataset.unit}`;
}

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  tab = b.dataset.tab; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  window.scrollTo(0, 0); render();
});
$('#status').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) document.querySelector(`#tabs [data-tab="${g.dataset.goto}"]`).click(); });
$('#refresh').addEventListener('click', () => refresh(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
$('#today').textContent = new Date().toLocaleDateString('en-JM', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

status(); render(); refresh(false);
setInterval(status, 60000);
