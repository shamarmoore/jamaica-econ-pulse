import { SOURCES, FRED } from './sources.js';
import { analyse, borrowing } from './analysis.js';
import { decide, PROFILES, ASSETS } from './decisions.js';
import { NHT_DEFAULTS, FIN_DEFAULTS, scenario, bestScenario, geocode, driveTimes, pmt as pmt2 } from './homes.js';
import { MODELS, jacarsLinks } from './cars.js';
import { quotesOn, rankStocks, TV_SYMBOLS, tvUrl, GLOBAL_TAGS } from './markets.js';
import { fmt, signed, last, changeOver, yoySeries } from './util.js';

const KEY = 'ep_cache_v1';
const PREV = 'ep_prev_gauges_v1';
const HIST = 'ep_hist_v1';
let hist = {};
try { hist = JSON.parse(localStorage.getItem(HIST)) || {}; } catch (_) { hist = {}; }
function recordHistory() {
  const d = data(); const day = new Date().toISOString().slice(0, 10);
  const e = hist[day] || {};
  if (d.jse?.indices?.main) { e.jseMain = d.jse.indices.main.value; e.jseCombined = d.jse.indices.combined?.value; }
  if (d.statin?.unemployment) e.unemp = d.statin.unemployment.value;
  const g = d.petrojam?.weeks?.[0]?.prices['Gasolene 87']; if (g) e.g87 = g;
  if (Object.keys(e).length) hist[day] = e;
  addJseToHist();
  const keys = Object.keys(hist).sort(); while (keys.length > 800) delete hist[keys.shift()];
  try { localStorage.setItem(HIST, JSON.stringify(hist)); } catch (_) { /* ignore */ }
}
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
  recordHistory();
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
  ${movesStrip(d)}
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



// ---------- Decide tab ----------
let sub = 'overview';
const PROFILE_KEY = 'ep_profile_v1';
let profile = 'balanced';
try { profile = localStorage.getItem(PROFILE_KEY) || 'balanced'; } catch (_) { /* default */ }
const SUBS = [['overview', 'Overview'], ['spend', 'Spend'], ['borrow', 'Borrow'], ['home', 'Home'], ['listings', 'Listings'], ['car', 'Car'], ['invest', 'Invest'], ['trade', 'Trade'], ['work', 'Work'], ['jobs', 'Jobs']];

function chip(dec) { return `<span class="vchip ${STEP_CLASS[dec.step]}"><span class="gi">${STEP_ICON[dec.step]}</span>${esc(dec.label)}</span>`; }

function movesStrip(d) {
  const x = decide(d, hist); if (!x.spend.why.length && !x.home.why.length) return '';
  return `<section class="moves"><div class="gname">Your moves right now</div>
    ${['spend', 'borrow', 'home', 'invest', 'work'].map((k) => `<button class="move" data-sub="${k}"><span class="mt">${x[k].title}</span>${chip(x[k])}</button>`).join('')}</section>`;
}

function hero(title, dec, extra = '') {
  return `<section class="hero-b"><div class="gname">${title}</div>
    <div class="glabel ${STEP_CLASS[dec.step]}"><span class="gi">${STEP_ICON[dec.step]}</span>${esc(dec.label)}</div>
    <div class="segs">${[0, 1, 2, 3].map((i) => `<i class="${i <= dec.step ? STEP_CLASS[dec.step] : ''}"></i>`).join('')}</div>${extra}
    ${dec.why?.length ? `<ul class="why">${dec.why.map((w) => { const good = dec.pol === 'pos' ? w.pts > 0 : w.pts < 0; const ic = w.pts === 0 ? '●' : dec.pol === 'pos' ? (w.pts > 0 ? '+' : '−') : (w.pts > 0 ? '▲' : '▼');
      return `<li class="${w.pts === 0 ? '' : good ? 'down' : 'up'}"><span>${ic}</span>${esc(w.t)}</li>`; }).join('')}</ul>` : ''}
  </section>`;
}
function tipsBlock(t) { return t?.length ? `<h2 class="sec">What to do</h2><ul class="tips">${t.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''; }

function viewDecide(d) {
  const x = decide(d, hist);
  const nav = `<nav class="subnav">${SUBS.map(([k, l]) => `<button data-sub="${k}" class="${sub === k ? 'on' : ''}">${l}</button>`).join('')}</nav>`;
  let body = '';
  if (!x.spend.why.length && !x.home.why.length) body = empty(running.size ? 'Gathering the latest numbers…' : 'No data yet. Check your connection and tap refresh.');
  else if (sub === 'overview') {
    const a = analyse(d);
    body = `<p class="lede-s">${esc(a.headline)}</p>
      ${['spend', 'borrow', 'home', 'invest', 'work'].map((k) => {
        const dec = x[k]; const top = (dec.why || []).filter((w) => w.pts !== 0).slice(0, 2);
        const firstWhy = k === 'borrow' ? x.ctx.b.reasons.slice(0, 2).map((r) => ({ t: r.txt, pts: r.pts })) : top.length ? top : (dec.why || []).slice(0, 1);
        return `<article class="dcard ${STEP_CLASS[dec.step]}"><div class="dc-h"><h3>${dec.title}</h3>${chip(dec)}</div>
          <ul>${firstWhy.map((w) => `<li>${esc(w.t)}</li>`).join('')}</ul>
          <button class="more" data-sub="${k}">Details ›</button></article>`;
      }).join('')}
      <p class="fine">General, rule-based guidance from public data — not personal financial advice. Your own income, debts and goals come first.</p>`;
  } else if (sub === 'spend') body = hero('Household spending · now', x.spend) + tipsBlock(x.spend.tips);
  else if (sub === 'borrow') body = viewBorrow(d);
  else if (sub === 'home') body = viewHome(d, x);
  else if (sub === 'invest') body = viewInvest(d, x);
  else if (sub === 'work') body = viewWork(d, x);
  else if (sub === 'listings') body = viewListings(d);
  else if (sub === 'jobs') body = viewJobs(d);
  else if (sub === 'car') body = viewCar(d);
  else if (sub === 'trade') body = viewTrade(d);
  return nav + body;
}


// ---------- Home: buying power with NHT + co-applicant ----------
const FIN_KEY = 'ep_fin_v1'; const NHT_KEY = 'ep_nht_v1';
const load = (k, def) => { try { return { ...def, ...(JSON.parse(localStorage.getItem(k)) || {}) }; } catch (_) { return { ...def }; } };
let fin = load(FIN_KEY, { ...FIN_DEFAULTS, target: 20000000 });
delete fin.closingPct;
let nhtCfg = load(NHT_KEY, { ...NHT_DEFAULTS, bands: NHT_DEFAULTS.bands.map((b) => b[1]) });
const nhtOpts = () => ({ ...nhtCfg, bands: NHT_DEFAULTS.bands.map((b, i) => [b[0], +nhtCfg.bands[i]]) });
const liveMort = (d) => { const m = d.bojrates?.loans?.mortgage; return m?.length ? last(m).value : 7.6; };
const MODE_NAME = { bank: 'Bank only', nht: 'NHT (you) + bank', nhtco: 'NHT + co-applicant + bank' };
const VERDICT = { yes: ['good', 'Can afford'], check: ['ok', 'Payment OK — add savings'], stretch: ['warn', 'Stretch'], no: ['bad', 'Out of reach'], unknown: ['ok', 'Enter income'] };

function field(id, label, val, extra = '') { return `<label>${label}<input data-fin="${id}" inputmode="decimal" value="${esc(val ?? '')}" ${extra}></label>`; }
function check(id, label, on, scope = 'fin') { return `<label class="chk"><input type="checkbox" data-${scope}="${id}" ${on ? 'checked' : ''}> ${label}</label>`; }

function viewHome(d, x) {
  const h = x.home; const r = d.bojrates || {};
  return hero('Buying a home · now', h) +
    `<h2 class="sec">Your buying power <small>NHT + co-applicant</small></h2>
    <section class="calc fin">
      ${field('target', 'Home price to test (J$)', fin.target)}
      ${field('savings', 'Savings for deposit + closing (J$)', fin.savings, 'placeholder="e.g. 3000000"')}
      ${field('myIncome', 'Your gross monthly income (J$)', fin.myIncome, 'placeholder="before tax"')}
      ${field('myAge', 'Your age', fin.myAge)}
      <div class="wide">${check('myNht', 'I am an NHT contributor', fin.myNht)}</div>
      <div class="wide">${check('coOn', 'Add a co-applicant', fin.coOn)}</div>
      <div class="wide co ${fin.coOn ? '' : 'hide'}"><div class="calc2">
        ${field('coIncome', 'Co-applicant gross monthly income (J$)', fin.coIncome)}
        ${field('coAge', 'Co-applicant age', fin.coAge)}
        <div class="wide">${check('coNht', 'Co-applicant is an NHT contributor', fin.coNht)}</div></div></div>
      <div id="fin-out" class="wide"></div>
      <details class="wide adv"><summary>Assumptions (edit if your lender or NHT letter differs)</summary><div class="calc2">
        ${field('ratio', 'Max payment, % of gross income', fin.ratio)}${field('legalPct', 'Attorney fee, % of price', fin.legalPct ?? 2)}
        ${field('gctPct', 'GCT on attorney fee, %', fin.gctPct ?? 15)}${field('regPct', 'Registration fee (your half), % of price', fin.regPct ?? 0.25)}
        ${field('stampJ', 'Stamp duty, your share (J$)', fin.stampJ ?? 2500)}${field('lenderPct', 'Bank commitment/processing fee, % of bank loan', fin.lenderPct ?? 2)}
        ${field('otherJ', 'Valuation, survey & misc. (J$)', fin.otherJ ?? 100000)}
        ${field('bankRate', 'Bank mortgage rate % (blank = BOJ avg)', fin.bankRate ?? '', `placeholder="${fmt(liveMort(d), 2)}"`)}${field('bankLTV', 'Bank max financing, % of price', fin.bankLTV)}
        ${field('bankTerm', 'Bank max term (years)', fin.bankTerm)}${field('landLTV', 'Land loan max, % of price', fin.landLTV)}
        ${field('landRateAdd', 'Land loan rate premium (pts)', fin.landRateAdd)}${field('landTerm', 'Land loan term (years)', fin.landTerm)}
        <label>NHT limit, single (J$)<input data-nht="limitSingle" inputmode="numeric" value="${nhtCfg.limitSingle}"></label>
        <label>NHT limit, single if price ≤ J$${fmt(nhtCfg.specialPriceCap / 1e6, 0)}M<input data-nht="limitSingleSpecial" inputmode="numeric" value="${nhtCfg.limitSingleSpecial}"></label>
        <label>NHT limit, two applicants (J$)<input data-nht="limitJoint" inputmode="numeric" value="${nhtCfg.limitJoint}"></label>
        <label>NHT lot-loan limit per applicant (J$)<input data-nht="lotLimitPer" inputmode="numeric" value="${nhtCfg.lotLimitPer}"></label>
        <label>NHT max term (years)<input data-nht="maxTerm" inputmode="numeric" value="${nhtCfg.maxTerm}"></label>
        <label>Repay by age<input data-nht="maxAge" inputmode="numeric" value="${nhtCfg.maxAge}"></label>
        ${['≤ J$30,000/wk', 'J$30,001–42,000/wk', 'J$42,001–100,000/wk', 'over J$100,000/wk'].map((l, i) => `<label>NHT rate % (${l})<input data-nhtband="${i}" inputmode="decimal" value="${nhtCfg.bands[i]}"></label>`).join('')}
      </div><p class="fine">Defaults: NHT loan limits from NHT’s July 2025 booklet; income-band rates from NHT’s published table (July 2023 — confirm with your eligibility letter). Closing costs (buyer’s side): attorney fees usually 1.5–3% of price plus GCT; registration is 0.5% of price shared with the seller; stamp duty is a J$5,000 flat fee shared; the seller pays the 2% transfer tax; bank commitment fees vary (about 1–3.5% of the loan). All-in, buyers typically pay 4–8% with a mortgage. NHT sets your rate from the average weekly income of the NHT contributors on the loan, and your term from the youngest applicant’s age.</p></details>
    </section>
    <h2 class="sec">Mortgage rates <small>BOJ averages actually charged</small></h2><div class="grid">
      ${rateTile('Bank mortgages (avg)', r.loans?.mortgage, 'used for the bank portion')}${rateTile('6-month T-bill', r.tbills?.m6, 'where rates are heading')}</div>` + tipsBlock(h.tips);
}

function maxAffordable(f, mode, opts) {
  let lo = 0; let hi = 200e6;
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; const v = scenario(mid, f, mode, opts).verdict; if (v === 'yes' || v === 'check') lo = mid; else hi = mid; }
  return lo;
}
function updateFin() {
  const el = document.getElementById('fin-out'); if (!el) return;
  const d = data(); const opts = { nht: nhtOpts(), bankRateLive: liveMort(d) };
  const P = +String(fin.target).replace(/[,\s$J]/g, '') || 0;
  const modes = ['bank', 'nht'].concat(fin.coOn ? ['nhtco'] : []);
  const rows = modes.map((m) => ({ m, s: scenario(P, fin, m, opts) }));
  const hasInc = +String(fin.myIncome).replace(/[,\s$J]/g, '') > 0;
  el.innerHTML = !hasInc ? '<p class="note">Enter your gross monthly income to see what you can afford.</p>' : `
    <table class="scn"><thead><tr><th></th>${rows.map((r) => `<th>${MODE_NAME[r.m]}</th>`).join('')}</tr></thead><tbody>
      <tr><td>NHT loan</td>${rows.map((r) => `<td>${r.s.nhtLoan ? `${J(r.s.nhtLoan)}<small>${r.s.nhtRatePct}% · ${r.s.nhtTerm} yrs</small>` : '—'}</td>`).join('')}</tr>
      <tr><td>Bank loan</td>${rows.map((r) => `<td>${r.s.bankLoan ? `${J(r.s.bankLoan)}<small>${fmt(r.s.bankRate, 2)}% · ${r.s.bankTerm} yrs</small>` : '—'}</td>`).join('')}</tr>
      <tr><td>Deposit</td>${rows.map((r) => `<td>${J(r.s.deposit)}</td>`).join('')}</tr>
      <tr><td>Legal fees (attorney + GCT)</td>${rows.map((r) => `<td>${J(r.s.legal)}</td>`).join('')}</tr>
      <tr><td>Govt fees (registration, stamp duty)</td>${rows.map((r) => `<td>${J(r.s.govt)}</td>`).join('')}</tr>
      <tr><td>Lender & valuation fees</td>${rows.map((r) => `<td>${J(r.s.lender)}</td>`).join('')}</tr>
      <tr><td>Closing costs total</td>${rows.map((r) => `<td>${J(r.s.closing)}<small>${fmt((r.s.closing / Math.max(1, r.s.P)) * 100, 1)}% of price</small></td>`).join('')}</tr>
      <tr class="em"><td>Cash needed</td>${rows.map((r) => `<td>${J(r.s.cash)}</td>`).join('')}</tr>
      <tr class="em"><td>Monthly payment</td>${rows.map((r) => `<td>${J(r.s.monthly)}<small>${r.s.share != null ? `${fmt(r.s.share, 0)}% of income` : ''}</small></td>`).join('')}</tr>
      <tr><td>Total interest</td>${rows.map((r) => `<td>${J(r.s.totalInterest)}</td>`).join('')}</tr>
      <tr><td>Verdict</td>${rows.map((r) => `<td><b class="${VERDICT[r.s.verdict][0]}">${VERDICT[r.s.verdict][1]}</b></td>`).join('')}</tr>
      <tr><td>Max price you can afford</td>${rows.map((r) => `<td>${J(maxAffordable(fin, r.m, opts))}</td>`).join('')}</tr>
    </tbody></table>
    ${rows.flatMap((r) => r.s.notes.map((n) => `<p class="fine">${MODE_NAME[r.m]}: ${esc(n)}</p>`)).join('')}`;
}
function bindFin(v) {
  v.querySelectorAll('[data-fin]').forEach((i) => i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', () => {
    fin[i.dataset.fin] = i.type === 'checkbox' ? i.checked : i.value;
    if (i.dataset.fin === 'coOn') v.querySelector('.co')?.classList.toggle('hide', !i.checked);
    try { localStorage.setItem(FIN_KEY, JSON.stringify(fin)); } catch (_) { /* ignore */ }
    updateFin();
  }));
  v.querySelectorAll('[data-nht],[data-nhtband]').forEach((i) => i.addEventListener('input', () => {
    if (i.dataset.nhtband != null) nhtCfg.bands[+i.dataset.nhtband] = +i.value || 0; else nhtCfg[i.dataset.nht] = +String(i.value).replace(/[,\s$J]/g, '') || 0;
    try { localStorage.setItem(NHT_KEY, JSON.stringify(nhtCfg)); } catch (_) { /* ignore */ }
    updateFin();
  }));
  updateFin();
}

// ---------- Listings near work ----------
const GEO_KEY = 'ep_geo_v1'; const DRV_KEY = 'ep_drive_v1';
let geoCache = load(GEO_KEY, {}); let drvCache = load(DRV_KEY, {});
let listFilter = { type: 'all', outside: false };
let enrich = { running: false, done: 0, total: 0, error: null };
const WORK_FALLBACK = [18.0061, -76.7942]; // Half Way Tree Road (OpenStreetMap)
const ck = (g) => `${g[0].toFixed(4)},${g[1].toFixed(4)}`;

async function enrichListings() {
  const L = data().listings?.items; if (!L || enrich.running) return;
  enrich = { running: true, done: 0, total: 0, error: null };
  try {
    const wq = fin.work || FIN_DEFAULTS.work;
    if (!geoCache['@work'] || geoCache['@workq'] !== wq) {
      let w = null; try { w = await geocode(wq); } catch (_) { /* fallback */ }
      geoCache['@work'] = w || WORK_FALLBACK; geoCache['@workq'] = wq; drvCache = {};
    }
    const qs = [...new Set(L.map((x) => x.loc?.query).filter((q) => q && !(q in geoCache)))].slice(0, 80);
    enrich.total = qs.length;
    for (const q of qs) {
      try { geoCache[q] = (await geocode(q)) || 0; } catch (_) { geoCache[q] = 0; }
      enrich.done++; if (enrich.done % 5 === 0) { save2(); if (sub === 'listings') render(false); }
      await new Promise((r) => setTimeout(r, 1100)); // OpenStreetMap usage policy: max 1 request/second
    }
    const need = [...new Set(Object.entries(geoCache).filter(([k, g]) => !k.startsWith('@') && g && !(ck(g) in drvCache)).map(([, g]) => ck(g)))];
    if (need.length) {
      const pts = need.map((k) => k.split(',').map(Number));
      const res = await driveTimes(geoCache['@work'], pts);
      need.forEach((k, i) => { drvCache[k] = res[i]; });
    }
  } catch (e) { enrich.error = String(e.message || e); }
  enrich.running = false; save2(); if (tab === 'decide' && sub === 'listings') render(false);
}
function save2() { try { localStorage.setItem(GEO_KEY, JSON.stringify(geoCache)); localStorage.setItem(DRV_KEY, JSON.stringify(drvCache)); } catch (_) { /* ignore */ } }

function viewListings(d) {
  const L = d.listings?.items;
  if (!L) return empty(running.has('listings') ? 'Searching listings…' : 'Listings haven’t loaded yet — tap refresh.');
  if (!enrich.running && L.some((x) => x.loc?.query && !(x.loc.query in geoCache))) setTimeout(enrichListings, 50);
  const opts = { nht: nhtOpts(), bankRateLive: liveMort(d) };
  const minM = +fin.minMin || 0; const maxM = +fin.maxMin || 999; const traffic = +fin.traffic || 1.4;
  const rows = L.filter((x) => listFilter.type === 'all' || x.type === listFilter.type).map((x) => {
    const g = x.loc?.query ? geoCache[x.loc.query] : null; const dr = g ? drvCache[ck(g)] : null;
    const best = x.price ? bestScenario(x.price, fin, { ...opts, land: x.type === 'land' }) : null;
    return { x, min: dr?.min ?? null, km: dr?.km ?? null, best };
  });
  const inRange = rows.filter((r) => r.min != null && r.min >= minM && r.min <= maxM);
  const outRange = rows.filter((r) => r.min != null && (r.min < minM || r.min > maxM));
  const unclear = rows.filter((r) => r.min == null);
  const rank = { yes: 0, check: 1, stretch: 2, no: 3, unknown: 4 };
  const sorter = (a, b) => ((rank[a.best?.verdict ?? 'unknown']) - (rank[b.best?.verdict ?? 'unknown'])) || ((b.x.preferred ? 1 : 0) - (a.x.preferred ? 1 : 0)) || ((a.x.price || 9e12) - (b.x.price || 9e12));
  const card = (r) => {
    const v = r.best ? VERDICT[r.best.verdict] : ['ok', 'No price'];
    return `<li class="lst v-${v[0]}"><div class="l-h"><span class="vchip ${v[0]}">${v[1]}</span>${r.x.preferred ? '<span class="star">★ Top pick area</span>' : ''}</div>
      <a href="${esc(r.x.url)}" target="_blank" rel="noopener"><b>${esc(r.x.title)}</b></a>
      <div class="l-p">${r.x.price ? J(r.x.price) : /\d[1-9]|[1-9]/.test(r.x.priceText || '') ? esc(r.x.priceText) : r.x.src === 'PropertyAdsJa' ? 'Price on request' : 'Price not listed'} <span class="tag">${r.x.type}</span></div>
      <div class="fine">${esc(r.x.where || r.x.loc?.place || '')}${r.x.loc?.parish && !(r.x.where || '').includes(r.x.loc.parish) ? ` · ${esc(r.x.loc.parish)}` : ''}</div>
      ${r.min != null ? `<div class="l-d">🚗 ≈ ${fmt(r.min, 0)} min to work (no traffic) · ~${fmt(r.min * traffic, 0)} min rush hour · ${fmt(r.km, 1)} km</div>` : `<div class="l-d fine">Commute unknown — ${r.x.loc?.precision === 'parish' ? 'only the parish is given' : 'no location in the ad'}</div>`}
      ${r.best && r.best.income ? `<div class="l-f">Best option: <b>${MODE_NAME[r.best.mode]}</b> · ${J(r.best.monthly)}/mo · cash needed ${J(r.best.cash)}</div>` : ''}
      <div class="fine">${esc(r.x.src)}${r.x.date ? ` · posted ${fd(r.x.date)}` : ''}</div></li>`;
  };
  const group = (title, list, open = true) => list.length ? `<details class="grp" ${open ? 'open' : ''}><summary>${title} <span class="cnt">${list.length}</span></summary><ul class="lsts">${list.sort(sorter).map(card).join('')}</ul></details>` : '';
  const hasInc = +String(fin.myIncome).replace(/[,\s$J]/g, '') > 0;
  return `<section class="hero-b"><div class="gname">Houses & land near work</div>
      <p class="lede-s">${inRange.length} listing${inRange.length === 1 ? '' : 's'} within ${minM}–${maxM} min of ${esc((fin.work || FIN_DEFAULTS.work).split(',')[0])}${inRange.filter((r) => r.x.preferred).length ? ` · ${inRange.filter((r) => r.x.preferred).length} in St. Thomas / Bull Bay` : ''}</p>
      <div class="calc2">${field('minMin', 'Min drive (min)', fin.minMin)}${field('maxMin', 'Max drive (min)', fin.maxMin)}
        ${field('work', 'Work address', fin.work)}${field('traffic', 'Rush-hour factor', fin.traffic)}</div>
      <div class="chips">${[['all', 'All'], ['house', 'Houses'], ['land', 'Land']].map(([k, l]) => `<button data-ltype="${k}" class="${listFilter.type === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${!hasInc ? '<p class="note">Add your income and savings under Home → Your buying power to sort listings by what you can afford.</p>' : ''}
      ${enrich.running ? `<p class="fine"><span class="spin"></span>Locating listings on the map… ${enrich.done}/${enrich.total}</p>` : ''}
      ${enrich.error ? `<p class="fine bad">Commute lookup failed: ${esc(enrich.error)}</p>` : ''}
    </section>
    ${group('Within your commute range', inRange)}
    ${group('Commute unknown — check the ad', unclear, false)}
    ${group('Outside your commute range', outRange, false)}
    <p class="fine">Listings come from PropertyAdsJa and Gleaner Classifieds (most agency MLS listings aren’t public). Locations are matched from the ad text and placed with OpenStreetMap; drive times are OSRM no-traffic estimates. Affordability uses your Home settings — always confirm with the lender and NHT.</p>`;
}


// ---------- Car shopping ----------
const CAR_KEY = 'ep_car_v1'; const SEEN_KEY = 'ep_carseen_v1';
let carCfg = load(CAR_KEY, { model: 'all', depositPct: 20, years: 5, rate: '', showLhd: false });
let carSeen = load(SEEN_KEY, {});
function viewCar(d) {
  const C = d.cars?.items; const b = borrowing(d);
  const instAvg = d.bojrates?.loans?.instalment?.length ? last(d.bojrates.loans.instalment).value : 11.5;
  const rate = +carCfg.rate || instAvg; const dep = (+carCfg.depositPct || 0) / 100; const yrs = +carCfg.years || 5;
  const inc = +String(fin.myIncome).replace(/[,\s$J]/g, '') || 0;
  if (C) { const first = !Object.keys(carSeen).length; const now = Date.now(); let ch = false; for (const x of C) if (!carSeen[x.id]) { carSeen[x.id] = first ? 1 : now; ch = true; } if (ch) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(carSeen)); } catch (_) { /* ignore */ } } }
  const list = (C || []).filter((x) => (carCfg.model === 'all' || x.model === carCfg.model) && (carCfg.showLhd || !x.lhd));
  const firstSeen = (x) => carSeen[x.id] || 0;
  list.sort((a, b2) => (b2.date || '').localeCompare(a.date || '') || (firstSeen(b2) - firstSeen(a)) || ((a.rank ?? 99) - (b2.rank ?? 99)));
  const lhdCount = (C || []).filter((x) => x.lhd).length;
  const card = (x) => {
    const loan = x.price ? x.price * (1 - dep) : 0; const m = x.price ? pmt2(loan, rate, yrs) : 0;
    const share = inc && m ? (m / inc) * 100 : null; const cls = share == null ? 'ok' : share <= 15 ? 'good' : share <= 22 ? 'warn' : 'bad';
    const isNew = (x.date && Date.now() - Date.parse(x.date) < 7 * 864e5) || (firstSeen(x) > 1 && Date.now() - firstSeen(x) < 7 * 864e5);
    return `<li class="lst v-${cls}"><div class="l-h"><span class="tag">${x.model === 'gt86' ? 'GT86' : 'Civic'}</span>${isNew ? '<span class="star">● New this week</span>' : ''}${x.lhd ? '<span class="bad">⚠ Left-hand drive</span>' : ''}</div>
      <a href="${esc(x.url)}" target="_blank" rel="noopener"><b>${esc(x.title)}</b></a>
      <div class="l-p">${x.price ? J(x.price) : 'Price not listed'}${x.year ? ` · ${x.year}` : ''}</div>
      ${x.price ? `<div class="l-f">${fmt(carCfg.depositPct, 0)}% down = ${J(x.price * dep)} · loan ${J(loan)} → <b>${J(m)}/mo</b> for ${yrs} yrs at ${fmt(rate, 2)}%${share != null ? ` · ${fmt(share, 0)}% of gross income` : ''}</div>` : ''}
      <div class="fine">${esc(x.where || '')}${x.where ? ' · ' : ''}${esc(x.src)}${x.date ? ` · posted ${fd(x.date)}` : firstSeen(x) > 1 ? ` · first seen ${fd(new Date(firstSeen(x)).toISOString().slice(0, 10))}` : ''}</div></li>`;
  };
  return `<section class="hero-b"><div class="gname">Car shopping · right-hand drive Civic & GT86</div>
      <div class="glabel ${STEP_CLASS[b.step]}"><span class="gi">${STEP_ICON[b.step]}</span>Loan rates: ${esc(b.label)}</div>
      <p class="fine">Average vehicle (instalment) loan rate ${fmt(instAvg, 2)}% (BOJ). ${esc(b.carLabel)}: ${b.car.map((c) => `${esc(c.name)} ${esc(c.change)}`).join(' · ')}</p>
      <div class="chips">${[['all', 'All'], ...MODELS.map((m) => [m.key, m.label])].map(([k, l]) => `<button data-cmodel="${k}" class="${carCfg.model === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <div class="calc2">
        <label>Down payment (%)<input data-car="depositPct" inputmode="decimal" value="${esc(carCfg.depositPct)}"></label>
        <label>Loan term (years)<input data-car="years" inputmode="numeric" value="${esc(carCfg.years)}"></label>
        <label>Loan rate % (blank = BOJ avg)<input data-car="rate" inputmode="decimal" value="${esc(carCfg.rate)}" placeholder="${fmt(instAvg, 2)}"></label>
        <label class="chk" style="align-self:end"><input type="checkbox" data-car="showLhd" ${carCfg.showLhd ? 'checked' : ''}> Show LHD${lhdCount ? ` (${lhdCount})` : ''}</label>
      </div>
      ${inc ? '' : '<p class="fine">Add your income under Home → Your buying power to see each payment as a share of income.</p>'}
    </section>
    ${C ? `<h2 class="sec">Recently posted <small>${list.length} listing${list.length === 1 ? '' : 's'}</small></h2><ul class="lsts">${list.map(card).join('') || '<li class="fine">None posted right now — check back; new ads are picked up every 6 hours.</li>'}</ul>` : empty(running.has('cars') ? 'Searching car ads…' : 'Car ads haven’t loaded yet — tap refresh.')}
    <h2 class="sec">Also check</h2><ul class="tips">${jacarsLinks.map(([l, u]) => `<li><a href="${u}" target="_blank" rel="noopener">${l}</a> — JaCars blocks automated reading, so open it directly.</li>`).join('')}</ul>
    <p class="fine">Listings from AutoAdsJa and Gleaner Classifieds. Jamaican cars are right-hand drive by default; ads that mention left-hand drive are hidden unless you switch them on — always confirm the steering side, import status and title before paying. Payment colours: green ≤15% of gross income, amber ≤22%, red above.</p>`;
}

// ---------- Trade: TradingView charts + live JSE trend picker ----------
const JH_KEY = 'ep_jsehist_v1';
let jseHist = load(JH_KEY, {});
let tvSym = 'BITSTAMP:BTCUSD';
let jseFill = { running: false, msg: '' }; let jseTried = false;
function addJseToHist() {
  const L = data().jsequotes; if (!L) return;
  jseHist[L.date] = Object.fromEntries(Object.entries(L.q).map(([k, x]) => [k, x.close]));
  const ks = Object.keys(jseHist).sort(); while (ks.length > 420) delete jseHist[ks.shift()];
  try { localStorage.setItem(JH_KEY, JSON.stringify(jseHist)); } catch (_) { /* ignore */ }
}
async function jseBackfill() {
  const L = data().jsequotes; if (!L || jseFill.running) return;
  jseFill = { running: true, msg: '' };
  for (const days of [91, 182, 365]) {
    const r = rankStocks(L, jseHist); const have = { 91: r.dates?.d3, 182: r.dates?.d6, 365: r.dates?.d12 }[days];
    if (have) continue;
    jseFill.msg = `Fetching JSE closes from ${days === 365 ? '12' : days === 182 ? '6' : '3'} months ago…`; if (sub === 'trade') render(false);
    try {
      const t = new Date(new Date(`${L.date}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
      const q = await quotesOn(t);
      if (q) { jseHist[q.date] = Object.fromEntries(Object.entries(q.q).map(([k, x]) => [k, x.close])); try { localStorage.setItem(JH_KEY, JSON.stringify(jseHist)); } catch (_) { /* ignore */ } }
    } catch (e) { jseFill.msg = `Couldn’t fetch history: ${e.message}`; }
  }
  jseFill.running = false; if (tab === 'decide' && sub === 'trade') render(false);
}
function viewTrade(d) {
  const L = d.jsequotes; if (L && !jseHist[L.date]) addJseToHist();
  const r = rankStocks(L, jseHist);
  if (L && !jseFill.running && (!r.dates?.d3 || !r.dates?.d6 || !r.dates?.d12) && !jseTried) { jseTried = true; setTimeout(jseBackfill, 50); }
  const pct = (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'good' : 'bad'}">${signed(v, 1)}</span>`);
  const top = r.rows.filter((x) => x.vol > 0 || x.m6 != null).slice(0, 15);
  return `<section class="hero-b"><div class="gname">Live charts · TradingView</div>
      <div class="chips wrap">${TV_SYMBOLS.map(([l, sy]) => `<button data-tv="${sy}" class="${tvSym === sy ? 'on' : ''}">${l}</button>`).join('')}</div>
      <iframe class="tv" src="${tvUrl(tvSym)}" title="TradingView chart" loading="lazy" allowtransparency="true"></iframe>
      <p class="fine">Charts stream live from TradingView inside the app (needs data). Use the symbol box on the chart to switch to anything TradingView covers. Embedded charts can’t load your saved Pine Script indicators or alerts — open TradingView itself for those. JSE stocks aren’t on TradingView, so the picker below uses the JSE’s own data.</p></section>
    <h2 class="sec">JSE trend picker <small>live from JSE Trade Quotes · ${L ? fd(L.date) : '—'}</small></h2>
    ${jseFill.running || jseFill.msg ? `<p class="fine">${jseFill.running ? '<span class="spin"></span>' : ''}${esc(jseFill.msg)}</p>` : ''}
    ${!L ? empty(running.has('jsequotes') ? 'Loading JSE quotes…' : 'JSE quotes haven’t loaded yet — tap refresh.') : `
    <p class="fine">Ranked by ${r.basis === 'm6' ? '6-month' : r.basis === 'm3' ? '3-month' : 'distance from 52-week high (history still loading)'} price change. In our earlier JSE tests, the top third by 6-month trend beat the market by about 1.9 points per 3 months (3 of 4 marks) — a lead, not a promise. Cheapness on earnings passed all 4 marks but needs company earnings data that the JSE quote page doesn’t publish, so it isn’t live here.</p>
    ${(() => { const cols = [['m3', '3m'], ['m6', '6m'], ['m12', '12m'], ['offHigh', 'vs high']].filter(([k]) => top.some((x) => x[k] != null));
      return `<div class="tblwrap"><table class="yt pick"><thead><tr><th>Stock</th><th>Close</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${top.map((x) => `<tr><td><b>${esc(x.sym)}</b>${x.offHigh != null && x.offHigh < -35 ? ' <span class="bad" title="Far below 52-week high — lagged in tests">⚠</span>' : ''}${!x.vol ? ' <small class="fine">no trades</small>' : ''}</td><td>${fmt(x.close, 2)}</td>${cols.map(([k]) => `<td>${pct(x[k])}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>`; })()}
    <p class="fine">⚠ = more than 35% below its 52-week high (in the earlier tests these kept lagging). Prices exclude dividends; thinly traded stocks can be hard to buy at the quoted close. The app adds each day’s closes to its own history on your phone. Research shortlist, not advice.</p>`}`;
}

// ---------- Analyst jobs ----------
let jobsJamaica = true;
function viewJobs(d) {
  const J0 = d.jobs?.jobs; if (!J0) return empty(running.has('jobs') ? 'Searching CaribbeanJobs…' : 'Jobs haven’t loaded yet — tap refresh.');
  const list = J0.filter((j) => !jobsJamaica || /jamaica/i.test(j.country));
  const parseD = (s) => { const m = /(\d{2})\/(\d{2})\/(\d{4})/.exec(s || ''); return m ? `${m[3]}-${m[2]}-${m[1]}` : ''; };
  list.sort((a, b) => (parseD(b.updated) > parseD(a.updated) ? 1 : -1));
  return `<section class="hero-b"><div class="gname">Analyst openings · CaribbeanJobs</div>
      <p class="lede-s">${list.length} role${list.length === 1 ? '' : 's'} with “analyst” in the title${jobsJamaica ? ' in Jamaica' : ' across the Caribbean'}</p>
      <label class="chk"><input type="checkbox" id="jobs-ja" ${jobsJamaica ? 'checked' : ''}> Jamaica only</label></section>
    <ul class="lsts">${list.map((j) => `<li class="lst"><a href="${esc(j.url)}" target="_blank" rel="noopener"><b>${esc(j.title)}</b></a>
      <div class="l-p">${esc(j.company || 'Company not disclosed')}</div>
      <div class="fine">${esc(j.location)}${j.country && !/jamaica/i.test(j.country) ? `, ${esc(j.country)}` : ''} · updated ${esc(fd(parseD(j.updated)) || j.updated)} · ${esc(j.salary || 'Salary not disclosed')}</div>
      ${j.desc ? `<p class="j-d">${esc(j.desc.slice(0, 180))}${j.desc.length > 180 ? '…' : ''}</p>` : ''}</li>`).join('')}</ul>
    <p class="fine">Refreshes every 8 hours from caribbeanjobs.com. Open a listing to apply on the site.</p>`;
}

function viewInvest(d, x) {
  const iv = x.invest; const c = x.ctx; const m = iv.mixes[profile];
  const bar = `<div class="alloc" role="img" aria-label="example allocation">${Object.entries(m).filter(([, v]) => v > 0).map(([k, v]) => `<span class="${ASSETS[k].color}" style="flex:${v}" title="${ASSETS[k].name} ${v}%">${v >= 10 ? `${v}%` : ''}</span>`).join('')}</div>`;
  const legend = `<table class="leg">${Object.entries(m).map(([k, v]) => `<tr><td><i class="sw ${ASSETS[k].color}"></i>${ASSETS[k].name}</td><td>${v}%</td><td class="tl">${iv.tilt[k] >= 2 ? '<span class="good">▲ lean in</span>' : iv.tilt[k] <= -2 ? '<span class="bad">▼ lean out</span>' : ''}</td></tr>`).join('')}</table>`;
  const yields = [
    ['Inflation (Jamaica)', c.infl, '%'], ['6-month T-bill (JMD)', c.tb6, '%'], ['12-month deposit (JMD)', c.dep12, '%'],
    ['12-month deposit (USD)', c.usdDep12, '%'], ['US 3-month T-bill (USD)', c.usTbill, '%'],
  ].filter((y) => y[1] != null);
  return `<section class="hero-b"><div class="gname">Investing · example mix by risk level</div>
      <div class="seg3">${Object.entries(PROFILES).map(([k, p]) => `<button data-profile="${k}" class="${profile === k ? 'on' : ''}">${p.name}</button>`).join('')}</div>
      <p class="fine">${PROFILES[profile].blurb}</p>${bar}${legend}
      <div class="advice"><p><b>${esc(iv.label)}.</b>${iv.away.length ? ` Go lighter on ${esc(iv.away.slice(0, 2).join(' & '))}.` : ''}</p></div></section>
    <h2 class="sec">Why the mix leans this way</h2><ul class="why plain">${iv.why.map((w) => `<li class="${w.pts > 0 ? 'down' : w.pts < 0 ? 'up' : ''}"><span>${w.pts > 0 ? '▲' : w.pts < 0 ? '▼' : '●'}</span>${esc(w.t)}</li>`).join('')}</ul>
    <h2 class="sec">What safe money earns</h2><table class="yt">${yields.map(([n, v, u]) => `<tr><td>${n}</td><td>${fmt(v, 2)}${u}</td><td>${n.startsWith('Inflation') ? '' : c.infl != null && !n.includes('USD') ? `<span class="${v - c.infl < 0 ? 'bad' : 'good'}">${signed(v - c.infl, 1, ' real')}</span>` : ''}</td></tr>`).join('')}</table>
    <p class="fine">Example asset-class mixes adjusted by today’s data — not recommendations of specific products. Fees, taxes and your timeline matter. For specific investments, speak with an FSC-licensed adviser. USD returns also gain or lose with the exchange rate.</p>`;
}

function viewWork(d, x) {
  const w = x.work;
  return hero('Job moves · now', w) +
    (w.sectors.length ? `<h2 class="sec">Sector temperature <small>from live data</small></h2><ul class="carsig">${w.sectors.map((s) => `
      <li><div class="cs-h"><b>${esc(s.name)}</b><span class="cs-v"><em class="${s.dir === 'warm' ? 'down' : s.dir === 'cool' ? 'up' : ''}">${s.dir === 'warm' ? '▲ warming' : s.dir === 'cool' ? '▼ cooling' : '● steady'}</em></span></div><div class="fine">${esc(s.why)}</div></li>`).join('')}</ul>` : '') +
    tipsBlock(w.tips);
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
let newsFilter = true; let newsScope = 'local'; let gFilter = true;
function viewNews(d) {
  const seg = `<div class="seg3 two"><button data-nscope="local" class="${newsScope === 'local' ? 'on' : ''}">Jamaica</button><button data-nscope="global" class="${newsScope === 'global' ? 'on' : ''}">Global</button></div>`;
  if (newsScope === 'global') return seg + viewGlobal(d);
  return seg + viewLocal(d);
}
function viewGlobal(d) {
  const items = d.gnews?.items || []; if (!items.length) return empty(running.has('gnews') ? 'Loading world headlines…' : 'Global headlines haven’t loaded yet.');
  const shown = gFilter ? items.filter((x) => x.tags.length) : items;
  const note = Object.fromEntries(GLOBAL_TAGS.map(([n, , w]) => [n, w]));
  const counts = {}; shown.forEach((x) => x.tags.forEach((t) => { counts[t] = (counts[t] || 0) + 1; }));
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([t, c]) => `${t} (${c})`).join(' · ');
  return `<div class="newsbar"><label><input type="checkbox" id="gf" ${gFilter ? 'checked' : ''}> Relevant to Jamaica only</label><span class="fine">${top ? `Global themes: ${top}` : ''}</span></div>
    <ul class="news">${shown.slice(0, 70).map((x) => `<li><a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title)}</a>
      <div class="nmeta">${esc(x.source)}${x.ts ? ` · ${ago(new Date(x.ts))}` : ''}${x.tags.slice(0, 3).map((t) => `<span class="tag">${t}</span>`).join('')}</div>
      ${x.tags[0] ? `<div class="why1">Why it matters: ${esc(note[x.tags[0]])}</div>` : ''}</li>`).join('')}</ul>`;
}
function viewLocal(d) {
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
  <p class="fine">Version 1.4</p>`;
}

function render(force = true) {
  const v = $('#view');
  if (!force && tab === 'decide' && v.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  const d = data(); const a = analyse(d);
  const openIds = [...v.querySelectorAll('details')].map((x) => x.open);
  v.innerHTML = tab === 'pulse' ? viewPulse(d, a) : tab === 'jamaica' ? viewJamaica(d) : tab === 'world' ? viewWorld(d) : tab === 'decide' ? viewDecide(d) : tab === 'news' ? viewNews(d) : viewSources();
  if (tab === 'pulse' && openIds.length) v.querySelectorAll('details').forEach((x, i) => { if (openIds[i] !== undefined) x.open = openIds[i]; });
  const nf = $('#nf'); if (nf) nf.onchange = () => { newsFilter = nf.checked; render(); };
  const gf = $('#gf'); if (gf) gf.onchange = () => { gFilter = gf.checked; render(); };
  v.querySelectorAll('[data-nscope]').forEach((b) => b.addEventListener('click', () => { newsScope = b.dataset.nscope; render(); }));
  if (tab === 'decide' && sub === 'borrow') { v.querySelectorAll('.calc input').forEach((i) => i.addEventListener('input', updateCalc)); updateCalc(); }
  if (tab === 'decide' && sub === 'home') bindFin(v);
  if (tab === 'decide' && sub === 'listings') {
    v.querySelectorAll('[data-fin]').forEach((i) => i.addEventListener('change', () => { fin[i.dataset.fin] = i.value; try { localStorage.setItem(FIN_KEY, JSON.stringify(fin)); } catch (_) { /* ignore */ } if (i.dataset.fin === 'work') { delete geoCache['@work']; enrichListings(); } render(); }));
    v.querySelectorAll('[data-ltype]').forEach((b) => b.addEventListener('click', () => { listFilter.type = b.dataset.ltype; render(); }));
  }
  if (tab === 'decide' && sub === 'car') {
    v.querySelectorAll('[data-cmodel]').forEach((b) => b.addEventListener('click', () => { carCfg.model = b.dataset.cmodel; try { localStorage.setItem(CAR_KEY, JSON.stringify(carCfg)); } catch (_) { /* ignore */ } render(); }));
    v.querySelectorAll('[data-car]').forEach((i) => i.addEventListener('change', () => { carCfg[i.dataset.car] = i.type === 'checkbox' ? i.checked : i.value; try { localStorage.setItem(CAR_KEY, JSON.stringify(carCfg)); } catch (_) { /* ignore */ } render(); }));
  }
  if (tab === 'decide' && sub === 'trade') v.querySelectorAll('[data-tv]').forEach((b) => b.addEventListener('click', () => { tvSym = b.dataset.tv; render(); }));
  if (tab === 'decide' && sub === 'jobs') { const c = document.getElementById('jobs-ja'); if (c) c.onchange = () => { jobsJamaica = c.checked; render(); }; }
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
$('#view').addEventListener('click', (e) => {
  const sb = e.target.closest('[data-sub]');
  if (sb) { sub = sb.dataset.sub; if (tab !== 'decide') { document.querySelector('#tabs [data-tab="decide"]').click(); return; } window.scrollTo(0, 0); render(); return; }
  const pf = e.target.closest('[data-profile]');
  if (pf) { profile = pf.dataset.profile; try { localStorage.setItem(PROFILE_KEY, profile); } catch (_) { /* ignore */ } render(); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
$('#today').textContent = new Date().toLocaleDateString('en-JM', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

status(); render(); refresh(false);
setInterval(status, 60000);
