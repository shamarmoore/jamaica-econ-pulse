import { SOURCES, FRED } from './sources.js';
import { analyse, borrowing } from './analysis.js';
import { decide, PROFILES, ASSETS } from './decisions.js';
import { NHT_DEFAULTS, FIN_DEFAULTS, scenario, bestScenario, geocode, driveTimes, pmt as pmt2, MODES, JOINT } from './homes.js';
import { EXPLAIN } from './explain.js';
import { fredKey, ghToken } from './sources.js';
import { MODELS, jacarsLinks } from './cars.js';
import { quotesOn, rankStocks, TV_SYMBOLS, tvUrl, GLOBAL_TAGS, targetOdds, fcAt, fcChange, hypeLabel, calibrate } from './markets.js';
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
const UI_KEY = 'ep_ui_v1';
let ui = {}; try { ui = JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch (_) { /* none */ }
let tab = ui.tab || 'pulse';
const saveUi = () => { try { localStorage.setItem(UI_KEY, JSON.stringify({ tab, sub })); } catch (_) { /* ignore */ } };

function save() { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (_) { /* storage full */ } }
function data() { const d = {}; for (const s of SOURCES) d[s.id] = cache[s.id]?.data; return d; }
const stale = (s) => !cache[s.id]?.at || (Date.now() - cache[s.id].at) > s.ttlH * 3600e3 || !!(s.outdated && cache[s.id]?.data && s.outdated(cache[s.id].data));

async function refresh(force = false) {
  const todo = SOURCES.filter((s) => force || stale(s));
  if (!todo.length) return;
  todo.forEach((s) => running.add(s.id));
  status(); bgRender();
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
      running.delete(s.id); save(); status(); bgRender();
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
  const fails = SOURCES.filter((s) => !(s.optional && !ghToken.get()) && cache[s.id]?.error && (!cache[s.id].at || cache[s.id].errorAt > cache[s.id].at));
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

function gaugeCard(name, gauge, prev, blurb, key = '') {
  const segs = [0, 1, 2, 3].map((i) => `<i class="${i <= gauge.step ? STEP_CLASS[gauge.step] : ''}"></i>`).join('');
  const moved = prev && prev.label !== gauge.label ? `<span class="moved">was ${esc(prev.label)}</span>` : '';
  return `<div class="gauge"${key ? ` data-x="${key}"` : ''}><div class="gname">${name}</div>
    <div class="glabel ${STEP_CLASS[gauge.step]}"><span class="gi">${STEP_ICON[gauge.step]}</span>${gauge.label}</div>
    <div class="segs">${segs}</div><div class="gblurb">${blurb}${moved}</div></div>`;
}

function insightCard(x, i) {
  const [lab, ic] = LEVEL[x.level];
  return `<article class="ins ${x.level}">
    <div class="ins-h"><span class="chip ${x.level}">${ic} ${lab}</span><span class="scope">${x.scope}</span></div>
    <h3>${esc(x.title)}</h3>
    <p class="sig">${esc(x.signal)}</p>
    <details data-k="ins-${esc(x.title.slice(0, 30))}" ${i < 2 ? 'open' : ''}><summary>How it could affect Jamaica</summary>
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
    ${gaugeCard('Inflation pressure', a.gauges.inflation, pg.inflation, 'Prices & cost of living', 'g_inflation')}
    ${gaugeCard('Growth momentum', a.gauges.growth, pg.growth, 'Output, jobs, demand', 'g_growth')}
    ${gaugeCard('External pressure', a.gauges.external, pg.external, 'JMD, oil, US rates, flows', 'g_external')}
    ${gaugeCard('Shock risk', a.gauges.shock, pg.shock, 'Storms & disruptions', 'g_shock')}
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

function stat(label, value, sub, extra = '', key = '') {
  return `<div class="stat"${key ? ` data-x="${esc(key)}"` : ''}><div class="sl-l">${label}</div><div class="sv">${value}</div><div class="ss">${sub || ''}</div>${extra}</div>`;
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
  if (infl != null) out.push(stat('Inflation (12-month)', `${fmt(infl)}%`, b.inflationPeriod || s.cpiPtp?.period, targetBar(infl, ...(b.target || [4, 6])), 'infl'));
  if (b.policyRate != null) out.push(stat('BOJ policy rate', `${fmt(b.policyRate, 2)}%`, `Set ${b.policyDate || '—'}${b.nextPolicyDate ? `<br>Next: <b>${b.nextPolicyDate}</b>` : ''}`, '', 'policy'));
  if (s.cpiMonthly) out.push(stat('Monthly inflation', `${fmt(s.cpiMonthly.value)}%`, s.cpiMonthly.period, '', 'cpiM'));
  if (s.cpiCalYtd) out.push(stat('Calendar-YTD inflation', `${fmt(s.cpiCalYtd.value)}%`, s.cpiCalYtd.period, '', 'cpiYtd'));
  if (s.ppiManufacturing) out.push(stat('PPI manufacturing', fmt(s.ppiManufacturing.value), s.ppiManufacturing.period, '', 'ppiMan'));
  if (s.ppiMining) out.push(stat('PPI mining & quarrying', fmt(s.ppiMining.value), s.ppiMining.period, '', 'ppiMin'));
  out.push('</div>');

  out.push('<h2 class="sec">Exchange rate</h2><div class="grid">');
  if (b.fx?.USD) out.push(stat('US$ (BOJ)', `J$${fmt(b.fx.USD.sell, 2)}`, `buy ${fmt(b.fx.USD.buy, 2)} · ${fd(b.fxDate)}`, '', 'usdBoj'));
  if (fx?.now) {
    const pts = [...(fx.history || [])].sort((x, y) => y.daysAgo - x.daysAgo).map((h) => ({ date: h.date, value: h.jmd }));
    pts.push({ date: fx.now.date, value: fx.now.jmd });
    const h = (n) => fx.history.find((z) => z.daysAgo === n);
    const ch = (n) => h(n) ? signed((fx.now.jmd / h(n).jmd - 1) * 100) : '—';
    out.push(stat('US$ market mid', `J$${fmt(fx.now.jmd, 2)}`, `1m ${ch(30)} · 3m ${ch(90)} · 12m ${ch(365)}`, spark(pts, { unit: ' JMD' }), 'usdMid'));
  }
  for (const c of ['CAD', 'GBP', 'EUR']) if (b.fx?.[c]) out.push(stat(`${c} (BOJ)`, `J$${fmt(b.fx[c].sell, 2)}`, `buy ${fmt(b.fx[c].buy, 2)}`, '', 'fxCross'));
  out.push('</div>');

  out.push('<h2 class="sec">Jobs, output & trade</h2><div class="grid">');
  if (s.gdpGrowth) out.push(stat('GDP growth (y/y)', signed(s.gdpGrowth.value), s.gdpGrowth.period, '', 'gdp'));
  if (s.unemployment) out.push(stat('Unemployment', `${fmt(s.unemployment.value)}%`, s.unemployment.period, '', 'unemp'));
  if (s.youthUnemployment) out.push(stat('Youth unemployment', `${fmt(s.youthUnemployment.value)}%`, s.youthUnemployment.period, '', 'youth'));
  if (s.participation) out.push(stat('Labour force participation', `${fmt(s.participation.value)}%`, s.participation.period, '', 'partic'));
  if (s.exports && s.imports) out.push(stat('Goods trade (month)', `−US$${fmt(s.imports.value - s.exports.value)}M`, `exports ${fmt(s.exports.value)} · imports ${fmt(s.imports.value)} · ${s.imports.period || ''}`, '', 'trade'));
  out.push('</div>');

  const rm = d.remit; const tr = d.tourism; const pj = d.petrojam?.weeks;
  if (rm || tr || pj) {
    out.push('<h2 class="sec">Dollars coming in & fuel</h2><div class="grid">');
    if (rm) out.push(stat('Net remittances', `US$${fmt(rm.net)}M`, `${rm.month} · ${signed(rm.yoy)} y/y${rm.usShare ? ` · US ${fmt(rm.usShare)}%` : ''}`, '', 'remit'));
    if (tr?.stopovers) out.push(stat('Stopover visitors (y/y)', signed(tr.stopovers.change), tr.stopovers.month, '', 'stopovers'));
    if (tr?.mbj) out.push(stat('Montego Bay airport passengers', signed(tr.mbj.change), `${tr.mbj.month} · y/y`, '', 'mbj'));
    if (pj?.[0]) for (const f of ['Gasolene 87', 'Auto Diesel']) {
      const v = pj[0].prices[f]; const p1 = pj[1]?.prices[f];
      if (v) out.push(stat(`${f} (Petrojam)`, `J$${fmt(v, 2)}`, `per litre · ${p1 ? `${signed((v / p1 - 1) * 100)} w/w · ` : ''}${fd(pj[0].date)}`, '', 'fuel'));
    }
    out.push('</div>');
  }
  const yr = new Date().getFullYear();
  const imfTiles = ['NGDP_RPCH', 'PCPIPCH', 'LUR', 'GGXWDG_NGDP', 'BCA_NGDPD', 'GGXCNL_NGDP'].filter((k) => imf[`${k}:JAM`]);
  if (imfTiles.length) {
    out.push(`<h2 class="sec">IMF outlook <small>${d.imf.edition ? `WEO ${fd(`${d.imf.edition}-01`, false)} · ` : ''}solid = actual · dashed = projection</small></h2><div class="grid">`);
    for (const k of imfTiles) {
      const sr = imf[`${k}:JAM`]; const cur = sr.find((p) => p.year === yr) || [...sr].reverse().find((p) => p.year < yr); const nx = sr.find((p) => p.year === yr + 1);
      out.push(stat(d.imf.labels[k], cur ? `${fmt(cur.value)}` : '—', `${cur ? cur.year : yr}${nx ? ` · ${yr + 1}: ${fmt(nx.value)}` : ''}`, spark(sr, { proj: yr, fmtX: (p) => String(p.year), unit: '' }), `imf_${k}`));
    }
    out.push('</div>');
  }
  if (wb?.latest && Object.keys(wb.latest).length) {
    out.push('<h2 class="sec">How exposed Jamaica is <small>World Bank, latest year</small></h2><div class="grid">');
    for (const [k, v] of Object.entries(wb.latest)) out.push(stat(wb.labels[k], fmt(v.value), String(v.year), '', `wb_${k}`));
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
      n.outlook ? esc(n.outlook.slice(0, 260)) : '', '', 'nhc'));
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
      return stat(`${label}${unit !== '%' && unit !== 'index' ? ` <small>${unit}</small>` : ''}`, val, sub, spark(thin, { unit: unit === '%' ? '%' : '' }), id);
    });
    if (tiles.length) out.push(`<h2 class="sec">${g}</h2><div class="grid">${tiles.join('')}</div>`);
  }
  const yr = new Date().getFullYear();
  const partners = [['USA', 'United States'], ['CAN', 'Canada'], ['GBR', 'United Kingdom']].filter(([c]) => imf[`NGDP_RPCH:${c}`]);
  if (partners.length) {
    out.push('<h2 class="sec">Partner growth <small>IMF, % real GDP</small></h2><div class="grid">');
    for (const [c, name] of partners) {
      const sr = imf[`NGDP_RPCH:${c}`]; const nx = sr.find((p) => p.year === yr + 1); const cu = sr.find((p) => p.year === yr);
      out.push(stat(name, cu ? `${fmt(cu.value)}%` : '—', `${yr}${nx ? ` · ${yr + 1}: ${fmt(nx.value)}%` : ''}`, spark(sr, { proj: yr, fmtX: (p) => String(p.year), unit: '%' }), 'pgrowth'));
    }
    out.push('</div>');
  }
  return out.length ? out.join('') : empty('World data hasn’t loaded yet.');
}



// ---------- Decide tab ----------
let sub = ui.sub || 'overview';
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
  return `<section class="hero-b"><div class="gname">${title}${dec.key ? `<button class="ib" data-x="d_${dec.key}" aria-label="What this means">i</button>` : ''}</div>
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
        return `<article class="dcard ${STEP_CLASS[dec.step]}"><div class="dc-h"><h3>${dec.title}<button class="ib" data-x="d_${k}" aria-label="What this means">i</button></h3>${chip(dec)}</div>
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
const MODE_NAME = { bank: 'Bank only · you', nht: 'NHT + bank · you', bankco: 'Bank only · joint', nhtco: 'NHT + bank · joint' };
const MODE_SHORT = { bank: 'Bank only', nht: 'NHT + bank', bankco: 'Bank only', nhtco: 'NHT + bank' };
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
        <label>NHT house-lot limit, single (J$)<input data-nht="lotSingle" inputmode="numeric" value="${nhtCfg.lotSingle}"></label>
        <label>NHT house-lot limit, two applicants (J$)<input data-nht="lotJoint" inputmode="numeric" value="${nhtCfg.lotJoint}"></label>
        <label>NHT max financing, % of price<input data-nht="ltv" inputmode="numeric" value="${nhtCfg.ltv}"></label>
        <label>NHT max term (years)<input data-nht="maxTerm" inputmode="numeric" value="${nhtCfg.maxTerm}"></label>
        <label>Repay by age<input data-nht="maxAge" inputmode="numeric" value="${nhtCfg.maxAge}"></label>
        ${['≤ J$30,000/wk', 'J$30,001–42,000/wk', 'J$42,001–100,000/wk', 'over J$100,000/wk'].map((l, i) => `<label>NHT rate % (${l})<input data-nhtband="${i}" inputmode="decimal" value="${nhtCfg.bands[i]}"></label>`).join('')}
      </div><p class="fine">Defaults: NHT loan limits from NHT’s June/July 2025 changes (open market J$9M single, J$12M if the home is ≤ J$14M, J$17M for two; house lots J$5M / J$7M). NHT lends at most 95% of the price (98% for contributors earning under J$30,000 a week buying at or below J$14M), so there is always a deposit; income-band rates from NHT’s published table (July 2023 — confirm with your eligibility letter). Closing costs (buyer’s side): attorney fees usually 1.5–3% of price plus GCT; registration is 0.5% of price shared with the seller; stamp duty is a J$5,000 flat fee shared; the seller pays the 2% transfer tax; bank commitment fees vary (about 1–3.5% of the loan). All-in, buyers typically pay 4–8% with a mortgage. NHT sets your rate from the average weekly income of the NHT contributors on the loan, and your term from the youngest applicant’s age.</p></details>
    </section>
    <h2 class="sec">Mortgage rates <small>BOJ averages actually charged</small></h2><div class="grid">
      ${rateTile('Bank mortgages (avg)', r.loans?.mortgage, 'used for the bank portion', 'r_mortgage')}${rateTile('6-month T-bill', r.tbills?.m6, 'where rates are heading', 'r_tb6')}</div>` + tipsBlock(h.tips);
}

function maxAffordable(f, mode, opts) {
  let lo = 0; let hi = 200e6;
  for (let i = 0; i < 32; i++) { const mid = (lo + hi) / 2; const v = scenario(mid, f, mode, opts).verdict; if (v === 'yes' || v === 'check') lo = mid; else hi = mid; }
  return lo;
}
// Cost breakdown table used by the Home calculator and the listing detail sheet.
function finTable(P, modes, opts) {
  const rows = modes.map((m) => ({ m, s: scenario(P, fin, m, opts) }));
  const pctP = (v) => `<small>${fmt((v / Math.max(1, P)) * 100, 1)}% of price</small>`;
  return `<table class="scn"><thead><tr><th></th>${rows.map((r) => `<th>${MODE_SHORT[r.m]}</th>`).join('')}</tr></thead><tbody>
      <tr><td>NHT loan</td>${rows.map((r) => `<td>${r.s.nhtLoan ? `${J(r.s.nhtLoan)}<small>${r.s.nhtRatePct}% · ${r.s.nhtTerm} yrs</small>` : '—'}</td>`).join('')}</tr>
      <tr><td>Bank loan</td>${rows.map((r) => `<td>${r.s.bankLoan ? `${J(r.s.bankLoan)}<small>${fmt(r.s.bankRate, 2)}% · ${r.s.bankTerm} yrs</small>` : '—'}</td>`).join('')}</tr>
      <tr><td>Deposit</td>${rows.map((r) => `<td>${J(r.s.deposit)}${pctP(r.s.deposit)}</td>`).join('')}</tr>
      <tr><td>Legal fees (attorney + GCT)</td>${rows.map((r) => `<td>${J(r.s.legal)}</td>`).join('')}</tr>
      <tr><td>Govt fees (registration, stamp duty)</td>${rows.map((r) => `<td>${J(r.s.govt)}</td>`).join('')}</tr>
      <tr><td>Lender & valuation fees</td>${rows.map((r) => `<td>${J(r.s.lender)}</td>`).join('')}</tr>
      <tr><td>Closing costs total</td>${rows.map((r) => `<td>${J(r.s.closing)}${pctP(r.s.closing)}</td>`).join('')}</tr>
      <tr class="em"><td>Cash needed</td>${rows.map((r) => `<td>${J(r.s.cash)}</td>`).join('')}</tr>
      <tr class="em"><td>Monthly payment</td>${rows.map((r) => `<td>${J(r.s.monthly)}<small>${r.s.share != null ? `${fmt(r.s.share, 0)}% of ${JOINT(r.m) ? 'joint ' : ''}income` : ''}</small></td>`).join('')}</tr>
      <tr><td>Total interest</td>${rows.map((r) => `<td>${J(r.s.totalInterest)}</td>`).join('')}</tr>
      <tr><td>Verdict</td>${rows.map((r) => `<td><b class="${VERDICT[r.s.verdict][0]}">${VERDICT[r.s.verdict][1]}</b></td>`).join('')}</tr>
      ${opts.maxRow ? `<tr><td>Max price you can afford</td>${rows.map((r) => `<td>${J(maxAffordable(fin, r.m, opts))}</td>`).join('')}</tr>` : ''}
    </tbody></table>
    ${rows.flatMap((r) => r.s.notes.map((n) => `<p class="fine">${MODE_NAME[r.m]}: ${esc(n)}</p>`)).join('')}`;
}
const apSeg = () => (fin.coOn ? `<div class="seg-ap" role="tablist"><button data-ap="me" class="${fin.view !== 'co' ? 'on' : ''}">Just me</button><button data-ap="co" class="${fin.view === 'co' ? 'on' : ''}">Me + co-applicant</button></div>` : '');
const apModes = () => (fin.coOn && fin.view === 'co' ? ['bankco', 'nhtco'] : ['bank', 'nht']);
function bindAp(root, redraw) { root.querySelectorAll('[data-ap]').forEach((b) => b.addEventListener('click', () => { fin.view = b.dataset.ap; try { localStorage.setItem(FIN_KEY, JSON.stringify(fin)); } catch (_) { /* ignore */ } redraw(); })); }
function updateFin() {
  const el = document.getElementById('fin-out'); if (!el) return;
  const d = data(); const opts = { nht: nhtOpts(), bankRateLive: liveMort(d), maxRow: true };
  const P = +String(fin.target).replace(/[,\s$J]/g, '') || 0;
  const hasInc = +String(fin.myIncome).replace(/[,\s$J]/g, '') > 0;
  el.innerHTML = !hasInc ? '<p class="note">Enter your gross monthly income to see what you can afford.</p>' : `${apSeg()}
    <p class="fine">${fin.coOn && fin.view === 'co' ? 'Both incomes count toward the loan; NHT rate uses the average weekly income of the NHT contributors, term uses the younger applicant’s age.' : 'Only your income counts.'}${fin.coOn ? ' Switch above to compare.' : ''}</p>
    ${finTable(P, apModes(), opts)}`;
  bindAp(el, updateFin);
}
function bindFin(v) {
  v.querySelectorAll('[data-fin]').forEach((i) => i.addEventListener(i.type === 'checkbox' ? 'change' : 'input', () => {
    fin[i.dataset.fin] = i.type === 'checkbox' ? i.checked : i.value;
    if (i.dataset.fin === 'coOn') { v.querySelector('.co')?.classList.toggle('hide', !i.checked); if (i.checked) fin.view = 'co'; }
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
let listShown = [];
function listingSheet(i) {
  const r = listShown[i]; if (!r) return; const x = r.x; const land = x.type === 'land';
  const d = data(); const traffic = +fin.traffic || 1.4;
  let P = x.price || 0;
  const hasInc = +String(fin.myIncome).replace(/[,\s$J]/g, '') > 0;
  const draw = (root) => {
    const out = root.querySelector('#ls-out'); const opts = { nht: nhtOpts(), bankRateLive: liveMort(d), land };
    out.innerHTML = !P ? '<p class="note">No price in the ad — enter the asking price above to see the costs.</p>'
      : !hasInc ? '<p class="note">Add your income under Decide → Home to see loans and monthly payments.</p>'
      : `${apSeg()}${finTable(P, apModes(), opts)}`;
    bindAp(out, () => draw(root));
  };
  openSheet(`<h3>${esc(x.title)}</h3>
    <p class="l-p">${x.price ? J(x.price) : 'Price not listed'} <span class="tag">${x.type}</span>${x.preferred ? ' <span class="star">★ Top pick area</span>' : ''}</p>
    <p class="fine">${esc(x.where || x.loc?.place || '')}${x.loc?.parish && !(x.where || '').includes(x.loc.parish) ? ` · ${esc(x.loc.parish)}` : ''} · ${esc(x.src)}${x.date ? ` · posted ${fd(x.date)}` : ''}</p>
    ${r.min != null ? `<p class="l-d">🚗 ≈ ${fmt(r.min, 0)} min to work without traffic · ~${fmt(r.min * traffic, 0)} min at rush hour · ${fmt(r.km, 1)} km</p>` : ''}
    <div class="calc2"><label>Price to test (J$)<input id="ls-price" inputmode="numeric" value="${P || ''}" placeholder="asking price"></label></div>
    <p class="tap-hint">Try your offer price — everything below updates.</p>
    <div id="ls-out"></div>
    ${land ? '<p class="fine">Land: bank lot loans usually finance less (your Land settings), cost more and run shorter; NHT house-lot limits apply. Building later needs a separate construction loan.</p>' : ''}
    <div class="btnrow"><a class="btn pri" href="${esc(x.url)}" target="_blank" rel="noopener">Open the ad ↗</a><button class="btn" data-close>Close</button></div>`,
  (root) => { draw(root); root.querySelector('#ls-price').addEventListener('input', (e) => { P = +String(e.target.value).replace(/[,\s$J]/g, '') || 0; draw(root); }); });
}

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
      enrich.done++; if (enrich.done % 5 === 0) save2(); enrichUi();
      await new Promise((r) => setTimeout(r, 1100)); // OpenStreetMap usage policy: max 1 request/second
    }
    const need = [...new Set(Object.entries(geoCache).filter(([k, g]) => !k.startsWith('@') && g && !(ck(g) in drvCache)).map(([, g]) => ck(g)))];
    if (need.length) {
      const pts = need.map((k) => k.split(',').map(Number));
      const res = await driveTimes(geoCache['@work'], pts);
      need.forEach((k, i) => { drvCache[k] = res[i]; });
    }
  } catch (e) { enrich.error = String(e.message || e); }
  enrich.running = false; save2(); enrichUi(); if (tab === 'decide' && sub === 'listings') bgRender();
}
// progress is updated in place so the list doesn't jump while you browse it
function enrichUi() { const el = document.getElementById('enrich-prog'); if (!el) return; el.innerHTML = enrich.running ? `<span class="spin"></span>Finding commute times… ${enrich.done}/${enrich.total}` : ''; }
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
  listShown = [];
  const card = (r) => {
    const v = r.best ? VERDICT[r.best.verdict] : ['ok', 'No price'];
    const idx = listShown.push(r) - 1;
    return `<li class="lst v-${v[0]}" data-li="${idx}"><div class="l-h"><span class="vchip ${v[0]}">${v[1]}</span>${r.x.preferred ? '<span class="star">★ Top pick area</span>' : ''}</div>
      <b class="l-t">${esc(r.x.title)}</b>
      <div class="l-p">${r.x.price ? J(r.x.price) : /\d[1-9]|[1-9]/.test(r.x.priceText || '') ? esc(r.x.priceText) : r.x.src === 'PropertyAdsJa' ? 'Price on request' : 'Price not listed'} <span class="tag">${r.x.type}</span></div>
      <div class="fine">${esc(r.x.where || r.x.loc?.place || '')}${r.x.loc?.parish && !(r.x.where || '').includes(r.x.loc.parish) ? ` · ${esc(r.x.loc.parish)}` : ''}</div>
      ${r.min != null ? `<div class="l-d">🚗 ≈ ${fmt(r.min, 0)} min to work (no traffic) · ~${fmt(r.min * traffic, 0)} min rush hour · ${fmt(r.km, 1)} km</div>` : `<div class="l-d fine">Commute unknown — ${r.x.loc?.precision === 'parish' ? 'only the parish is given' : 'no location in the ad'}</div>`}
      ${r.best && r.best.income ? `<div class="l-f">Best option: <b>${MODE_NAME[r.best.mode]}</b> · ${J(r.best.monthly)}/mo · cash needed ${J(r.best.cash)}</div>` : ''}
      <div class="fine">${esc(r.x.src)}${r.x.date ? ` · posted ${fd(r.x.date)}` : ''} · <u>tap for cost breakdown</u></div></li>`;
  };
  const group = (title, list, open = true) => list.length ? `<details class="grp" data-k="lg-${title.slice(0, 12)}" ${(openState[`lg-${title.slice(0, 12)}`] ?? open) ? 'open' : ''}><summary>${title} <span class="cnt">${list.length}</span></summary><ul class="lsts">${list.sort(sorter).map(card).join('')}</ul></details>` : '';
  const hasInc = +String(fin.myIncome).replace(/[,\s$J]/g, '') > 0;
  return `<section class="hero-b"><div class="gname">Houses & land near work</div>
      <p class="lede-s">${inRange.length} listing${inRange.length === 1 ? '' : 's'} within ${minM}–${maxM} min of ${esc((fin.work || FIN_DEFAULTS.work).split(',')[0])}${inRange.filter((r) => r.x.preferred).length ? ` · ${inRange.filter((r) => r.x.preferred).length} in St. Thomas / Bull Bay` : ''}</p>
      <div class="calc2">${field('minMin', 'Min drive (min)', fin.minMin)}${field('maxMin', 'Max drive (min)', fin.maxMin)}
        ${field('work', 'Work address', fin.work)}${field('traffic', 'Rush-hour factor', fin.traffic)}</div>
      <div class="chips">${[['all', 'All'], ['house', 'Houses'], ['land', 'Land']].map(([k, l]) => `<button data-ltype="${k}" class="${listFilter.type === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${!hasInc ? '<p class="note">Add your income and savings under Home → Your buying power to sort listings by what you can afford.</p>' : ''}
      <p class="fine prog" id="enrich-prog">${enrich.running ? `<span class="spin"></span>Finding commute times… ${enrich.done}/${enrich.total}` : ''}</p>
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
    return `<li class="lst v-${cls}" data-ci="${esc(x.id)}"><div class="l-h"><span class="tag">${x.model === 'gt86' ? 'GT86' : 'Civic'}</span>${isNew ? '<span class="star">● New this week</span>' : ''}${x.lhd ? '<span class="bad">⚠ Left-hand drive</span>' : ''}</div>
      <b class="l-t">${esc(x.title)}</b>
      <div class="l-p">${x.price ? J(x.price) : 'Price not listed'}${x.year ? ` · ${x.year}` : ''}</div>
      ${x.price ? `<div class="l-f">${fmt(carCfg.depositPct, 0)}% down = ${J(x.price * dep)} · loan ${J(loan)} → <b>${J(m)}/mo</b> for ${yrs} yrs at ${fmt(rate, 2)}%${share != null ? ` · ${fmt(share, 0)}% of gross income` : ''}</div>` : ''}
      <div class="fine">${esc(x.where || '')}${x.where ? ' · ' : ''}${esc(x.src)}${x.date ? ` · posted ${fd(x.date)}` : firstSeen(x) > 1 ? ` · first seen ${fd(new Date(firstSeen(x)).toISOString().slice(0, 10))}` : ''} · <u>tap for cost breakdown</u></div></li>`;
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

function carSheet(id) {
  const d = data(); const x = (d.cars?.items || []).find((c) => c.id === id); if (!x) return;
  const instAvg = d.bojrates?.loans?.instalment?.length ? last(d.bojrates.loans.instalment).value : 11.5;
  const inc = +String(fin.myIncome).replace(/[,\s$J]/g, '') || 0;
  const cs = calcState(instAvg);
  const st = { price: x.price || 0, dep: +carCfg.depositPct || 20, yrs: +carCfg.years || 5, rate: +carCfg.rate || instAvg };
  const draw = (root) => {
    const out = root.querySelector('#cs-out'); const P = st.price;
    if (!P) { out.innerHTML = '<p class="note">No price in the ad — enter the asking price above.</p>'; return; }
    const depJ = P * st.dep / 100; const loan = P - depJ; const m = pmt(loan, st.rate, st.yrs); const interest = m * st.yrs * 12 - loan;
    const litres = cs.kml ? (cs.km * 52 / 12) / cs.kml : 0; const pump = parseFloat(cs.pump); const fuel = pump ? litres * pump : null;
    const share = inc ? (m / inc) * 100 : null; const shareAll = inc && fuel != null ? ((m + fuel) / inc) * 100 : null;
    const deps = [10, 20, 30, 40]; const terms = [3, 5, 7];
    out.innerHTML = `<div class="c-big"><span>Monthly payment</span><b>${J(m)}</b></div>
      <div class="c-row"><span>Down payment (${fmt(st.dep, 0)}%)</span><b>${J(depJ)}</b></div>
      <div class="c-row"><span>Amount borrowed</span><b>${J(loan)}</b></div>
      <div class="c-row"><span>Total interest over ${st.yrs} yrs at ${fmt(st.rate, 2)}%</span><b>${J(interest)}</b></div>
      <div class="c-row"><span>Total you pay for the car</span><b>${J(P + interest)}</b></div>
      <div class="c-row"><span>Fuel per month (${fmt(cs.km, 0)} km/wk at ${fmt(cs.kml, 0)} km/L)</span><b>${fmt(litres, 0)} L${fuel != null ? ` · ${J(fuel)}` : ''}</b></div>
      ${fuel != null ? `<div class="c-row"><span>Payment + fuel</span><b>${J(m + fuel)}/mo</b></div>` : '<p class="fine">Add your pump price in Decide → Borrow → Car loan calculator to include fuel cost.</p>'}
      ${share != null ? `<p class="fine">Payment is <b class="${share <= 15 ? 'good' : share <= 22 ? 'warn' : 'bad'}">${fmt(share, 0)}%</b> of your gross income${shareAll != null ? ` (${fmt(shareAll, 0)}% with fuel)` : ''}. A common rule of thumb keeps the car payment under about 15%.</p>` : ''}
      <h4>Monthly payment by down payment and term</h4>
      <div class="tblwrap"><table class="mx"><thead><tr><th>Down</th>${terms.map((t) => `<th>${t} yrs</th>`).join('')}</tr></thead><tbody>
      ${deps.map((dp) => `<tr><td>${dp}% · ${J(P * dp / 100)}</td>${terms.map((t) => `<td class="${dp === st.dep && t === st.yrs ? 'cur' : ''}">${J(pmt(P * (1 - dp / 100), st.rate, t))}</td>`).join('')}</tr>`).join('')}
      </tbody></table></div>
      <p class="fine">Not included: insurance (often required comprehensive cover on a financed car), licence and registration, fitness, and maintenance.</p>`;
  };
  openSheet(`<h3>${esc(x.title)}</h3>
    <p class="l-p">${x.price ? J(x.price) : 'Price not listed'}${x.year ? ` · ${x.year}` : ''}${x.lhd ? ' <span class="bad">⚠ Left-hand drive</span>' : ''}</p>
    <p class="fine">${esc(x.where || '')}${x.where ? ' · ' : ''}${esc(x.src)}${x.date ? ` · posted ${fd(x.date)}` : ''}</p>
    <div class="calc2">
      <label>Price (J$)<input data-cs="price" inputmode="numeric" value="${st.price || ''}" placeholder="asking price"></label>
      <label>Down payment (%)<input data-cs="dep" inputmode="decimal" value="${st.dep}"></label>
      <label>Term (years)<input data-cs="yrs" inputmode="numeric" value="${st.yrs}"></label>
      <label>Rate (%)<input data-cs="rate" inputmode="decimal" value="${fmt(st.rate, 2)}"></label></div>
    <div id="cs-out"></div>
    <div class="btnrow"><a class="btn pri" href="${esc(x.url)}" target="_blank" rel="noopener">Open the ad ↗</a><button class="btn" data-close>Close</button></div>`,
  (root) => { draw(root); root.querySelectorAll('[data-cs]').forEach((i) => i.addEventListener('input', () => { st[i.dataset.cs] = +String(i.value).replace(/[,\s$J]/g, '') || 0; if (!st.yrs) st.yrs = 1; draw(root); })); });
}

// ---------- Trade: TradingView charts + live JSE trend picker ----------
const JH_KEY = 'ep_jsehist_v1';
let jseHist = load(JH_KEY, {});
let tvSym = 'AMEX:SPY';
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
    jseFill.msg = `Fetching JSE closes from ${days === 365 ? '12' : days === 182 ? '6' : '3'} months ago…`; { const el = document.getElementById('jse-prog'); if (el) el.innerHTML = `<span class="spin"></span>${esc(jseFill.msg)}`; }
    try {
      const t = new Date(new Date(`${L.date}T12:00:00Z`) - days * 864e5).toISOString().slice(0, 10);
      const q = await quotesOn(t);
      if (q) { jseHist[q.date] = Object.fromEntries(Object.entries(q.q).map(([k, x]) => [k, x.close])); try { localStorage.setItem(JH_KEY, JSON.stringify(jseHist)); } catch (_) { /* ignore */ } }
    } catch (e) { jseFill.msg = `Couldn’t fetch history: ${e.message}`; }
  }
  jseFill.running = false; jseFill.msg = ''; if (tab === 'decide' && sub === 'trade') bgRender();
}
const JSE_SORTS = [['up', 'Chance up'], ['edge', 'Edge score'], ['fc', '3-mo forecast'], ['health', 'Financial health'], ['hype', 'Speculation'], ['m6', '6-month trend'], ['m3', '3-month'], ['m12', '12-month'], ['offHigh', 'Near 52-wk high'], ['chg', 'Today'], ['vol', 'Most traded'], ['az', 'A–Z']];
let jseSort = 'edge'; let jseQuery = ''; let jseAll = false;
const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
function jseRows(d) {
  const L = d.jsequotes; const r = rankStocks(L, jseHist);
  let key = jseSort === 'm6' && !r.dates?.d6 ? (r.dates?.d3 ? 'm3' : 'offHigh') : jseSort;
  if (['fc', 'hype', 'health', 'edge', 'up'].includes(key) && !d.forecasts?.edgeInfo) key = r.dates?.d6 ? 'm6' : 'offHigh';
  const F = d.forecasts;
  let rows = (r.all || []).map((x) => ({ ...x, fc: fcChange(F, x.sym), hype: F?.stocks?.[x.sym]?.hype?.score ?? null, health: F?.stocks?.[x.sym]?.health?.score ?? null, edge: F?.stocks?.[x.sym]?.edge?.score ?? null, up: F?.stocks?.[x.sym]?.chanceUp ?? null }));
  if (jseQuery) rows = rows.filter((x) => x.sym.includes(jseQuery.toUpperCase()));
  if (key === 'az') rows.sort((a, b) => a.sym.localeCompare(b.sym));
  else rows.sort((a, b) => ((b[key] ?? -1e9) - (a[key] ?? -1e9)));
  return { L, r, rows, key };
}
function viewTrade(d) {
  const L = d.jsequotes; if (L && !jseHist[L.date]) addJseToHist();
  const { r, rows, key } = jseRows(d); const F = d.forecasts;
  if (L && !jseFill.running && (!r.dates?.d3 || !r.dates?.d6 || !r.dates?.d12) && !jseTried) { jseTried = true; setTimeout(jseBackfill, 50); }
  const pct = (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'good' : 'bad'}">${signed(v, 1)}</span>`);
  const all = r.all || []; const up = all.filter((x) => x.chg > 0).length; const dn = all.filter((x) => x.chg < 0).length;
  const leaders = (r.rows || []).filter((x) => x.vol > 0).slice(0, 3).map((x) => x.sym);
  const shown = jseAll || jseQuery ? rows : rows.slice(0, 20);
  const extra = key === 'health' ? [['health', 'Health']] : key === 'hype' ? [['hype', 'Spec.']] : key === 'up' ? [['up', 'Chance up'], ['edge', 'Edge']] : [['edge', 'Edge']];
  const cols = [...extra, ...(F ? [['fc', 'Fcst 3m']] : []), ['m6', '6m'], ['m12', '12m'], ['offHigh', 'vs high']].filter(([k]) => k === 'edge' || k === 'up' || rows.some((x) => x[k] != null)).slice(0, 4);
  const cell = (x, k) => (k === 'up' ? (x.up == null ? '—' : `<b class="${x.up >= 52 ? 'good' : x.up >= 42 ? 'ok' : 'bad'}">${x.up}%</b>`) : ['health', 'hype', 'edge'].includes(k) ? (x[k] == null ? '—' : `<b class="${k === 'hype' ? hypeLabel(x[k])[1] : HEALTH_LABEL(x[k])[1]}">${x[k]}</b>`) : pct(x[k]));
  return `<section class="hero-b"><div class="gname">JSE stocks · ${L ? fd(L.date) : '—'}</div>
    ${L ? `<p class="lede-s">${all.length} stocks quoted · ${up} up, ${dn} down on the day${leaders.length ? ` · strongest ${r.basis === 'm6' ? '6-month' : r.basis === 'm3' ? '3-month' : ''} trends: ${leaders.join(', ')}` : ''}</p>` : ''}
    <p class="fine prog" id="jse-prog">${jseFill.running ? `<span class="spin"></span>${esc(jseFill.msg)}` : ''}</p>
    ${L ? `<input class="search" id="jse-q" placeholder="Find a stock symbol (e.g. NCBFG)" value="${esc(jseQuery)}" autocomplete="off" autocapitalize="characters">
    <div class="sorts">${JSE_SORTS.map(([k, l]) => `<button data-jsort="${k}" class="${jseSort === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
    </section>
    ${!L ? empty(running.has('jsequotes') ? 'Loading JSE quotes…' : 'JSE quotes haven’t loaded yet — tap refresh.') : `
    ${!F?.edgeInfo ? `<div class="note"><b>Edge score, forecasts and target odds aren’t loaded.</b> ${!ghToken.get()
      ? 'They come from the nightly file in your private GitHub repo, which needs a read-only token: add it under <button class="linkish" data-goto="sources">Sources → Stock forecasts</button> (or build it into the app with the FORECAST_TOKEN secret).'
      : running.has('forecasts') ? '<span class="spin"></span>Loading now…'
      : `Last attempt: ${esc(cache.forecasts?.error || (F ? 'saved copy is from before the Edge score existed' : 'not loaded yet'))}. <button class="linkish" id="fc-reload">Load now</button>`}</div>`
      : `<p class="fine">Edge scores & forecasts as of ${fd(F.asof)} (made nightly). ⚡ = speculative trading pattern · ▼ = just reported weak results (a tested warning).${tradeLesson(F)}</p>`}
    <p class="tap-hint">Sorted by ${esc(JSE_SORTS.find(([k]) => k === key)?.[1] || 'trend')}${key !== jseSort ? ' (longer history still loading)' : ''}. Tap a stock for details.</p>
    <div class="tblwrap"><table class="yt pick"><thead><tr><th>Stock</th><th>Close</th><th>Day</th>${cols.map(([, l]) => `<th>${l}</th>`).join('')}</tr></thead><tbody>
      ${shown.map((x) => `<tr data-sym="${esc(x.sym)}"><td><b>${esc(x.sym)}</b>${x.offHigh != null && x.offHigh < -35 ? ' <span class="bad">⚠</span>' : ''}${x.hype != null && x.hype >= 55 ? ' <span class="bad" title="Speculative trading">⚡</span>' : ''}${F?.stocks?.[x.sym]?.signals?.results?.kind === 'weak' ? ' <span class="bad" title="Just reported weak results">▼</span>' : ''}${!x.vol ? ' <small class="fine">no trades</small>' : ''}</td><td>${fmt(x.close, 2)}</td><td>${x.chg != null && x.close ? pct((x.chg / (x.close - x.chg)) * 100) : '—'}</td>${cols.map(([k]) => `<td>${cell(x, k)}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    ${!jseAll && !jseQuery && rows.length > 20 ? `<button class="more" id="jse-all">Show all ${rows.length} stocks ›</button>` : ''}
    <p class="fine">Trend columns compare today’s close with saved closes (prices exclude dividends). In the latest tests (Mar 2023–Nov 2026, dividends included, buying the next day), 3- and 6-month trends on their own gave no reliable edge; being near the 52-week high and a positive 12-month trend helped a little and are part of the Edge score. ⚠ = more than 35% below its 52-week high. Thinly traded stocks can be hard to buy at the quoted close. Research shortlist, not advice.</p>`}
    ${regimeCard(F)}
    ${sizingCard(F)}
    ${F?.ideas ? '<button class="more" id="ideas-btn">Every idea we tested — results & explanations ›</button>' : ''}
    <h2 class="sec">US & global stocks <small>live TradingView chart</small></h2>
    <div class="chips wrap">${TV_SYMBOLS.map(([l, sy]) => `<button data-tv="${sy}" class="${tvSym === sy ? 'on' : ''}">${l}</button>`).join('')}</div>
    <div class="calc2"><label>Any ticker (e.g. NASDAQ:AMD or NYSE:KO)<input id="tv-sym" value="${esc(tvSym)}" autocapitalize="characters" autocomplete="off"></label></div>
    <iframe class="tv" src="${tvUrl(tvSym, 'D', dark() ? 'dark' : 'light')}" title="TradingView chart" loading="lazy" allowtransparency="true"></iframe>
    <p class="fine">Daily candles with RSI and an exponential moving average, streamed live from TradingView (needs data). JSE stocks aren’t on TradingView, so the table above uses the JSE’s own quotes.</p>`;
}
const pts = (v) => `${v >= 0.05 ? '+' : v <= -0.05 ? '−' : ''}${fmt(Math.abs(v), 1)} pts`;
function tradeLesson(F) {
  const E = F?.edgeInfo; const t5 = E?.top5?.oos; if (!E) return '';
  const C = F.chanceInfo;
  return `${C ? ` <b>Chance up</b> = chance the stock is higher 3 months after you buy, dividends included. A typical JSE stock was up only ${fmt(C.baseUp, 0)}% of the time; on data the model hadn’t seen, its top 10 were up ${fmt(C.top10UpRate, 0)}% of the time (average ${signed(C.top10Mean, 1)} vs ${signed(C.allMean, 1)} for all stocks). It’s built from the Edge score plus a small nudge from the Timestral forecast.` : ''} <b>Edge score</b> blends ${Object.keys(E.labels).length} signals that held up in testing (cheap vs profits, dividends, steady profits, no losses, strong latest quarter, steady price, liquidity…).${t5 ? ` On data the model hadn’t seen (${fd(E.split, false)}–${fd(E.period[1], false)}), buying the <b>top 5</b>, holding 3 months and re-picking returned <b>${signed(t5.annNet, 0)}/yr</b> after trading costs vs ${signed(t5.annMarket, 0)}/yr for the market, ahead in ${t5.beatPct}% of quarters. A single pick beat the market only ${t5.singlePickBeatPct}% of the time — spread money over the top 5–10.` : ''}`;
}
function bindTrade(v) {
  const ib = v.querySelector('#ideas-btn'); if (ib) ib.addEventListener('click', () => ideasSheet(data().forecasts));
  const cap = v.querySelector('#sz-cap'); if (cap) cap.addEventListener('change', () => { sizeCap = +String(cap.value).replace(/[^\d.]/g, '') || 0; render({ keepScroll: true }); });
  v.querySelectorAll('[data-szn]').forEach((b) => b.addEventListener('click', () => { sizeN = +b.dataset.szn; render({ keepScroll: true }); }));
  v.querySelectorAll('[data-szm]').forEach((b) => b.addEventListener('click', () => { sizeMode = b.dataset.szm; render({ keepScroll: true }); }));
  const rl = v.querySelector('#fc-reload'); if (rl) rl.addEventListener('click', () => { delete cache.forecasts?.at; refresh(false); });
  v.querySelectorAll('[data-tv]').forEach((b) => b.addEventListener('click', () => { tvSym = b.dataset.tv; render({ keepScroll: true }); }));
  const ts = v.querySelector('#tv-sym'); if (ts) ts.addEventListener('change', () => { const t = ts.value.trim().toUpperCase(); if (t) { tvSym = t; render({ keepScroll: true }); } });
  v.querySelectorAll('[data-jsort]').forEach((b) => b.addEventListener('click', () => { jseSort = b.dataset.jsort; render({ keepScroll: true }); }));
  const all = v.querySelector('#jse-all'); if (all) all.addEventListener('click', () => { jseAll = true; render({ keepScroll: true }); });
  const q = v.querySelector('#jse-q');
  if (q) q.addEventListener('input', () => {
    jseQuery = q.value.trim(); const pos = q.selectionStart; render({ keepScroll: true });
    const q2 = document.getElementById('jse-q'); if (q2) { q2.focus(); try { q2.setSelectionRange(pos, pos); } catch (_) { /* ignore */ } }
  });
}
function stockSheet(sym) {
  const d = data(); const { L, r } = jseRows(d); const x = (r.all || []).find((z) => z.sym === sym); if (!x) return;
  const pts = Object.keys(jseHist).sort().filter((k) => jseHist[k]?.[sym] != null).map((k) => ({ date: k, value: jseHist[k][sym] }));
  const rankList = (r.rows || []); const pos = rankList.findIndex((z) => z.sym === sym);
  const third = pos >= 0 ? (pos < rankList.length / 3 ? 'top third' : pos < (2 * rankList.length) / 3 ? 'middle third' : 'bottom third') : null;
  const pctS = (v) => (v == null ? '—' : `<span class="${v >= 0 ? 'good' : 'bad'}">${signed(v, 1)}</span>`);
  const dayPct = x.chg != null && x.close ? (x.chg / (x.close - x.chg)) * 100 : null;
  const rangePos = x.lo52 != null && x.hi52 > x.lo52 ? Math.max(0, Math.min(100, ((x.close - x.lo52) / (x.hi52 - x.lo52)) * 100)) : null;
  openSheet(`<h3>${esc(sym)} <small class="fine">JSE · ${fd(L.date)}</small></h3>
    <div class="stat"><div class="sl-l">Closing price</div><div class="sv">J$${fmt(x.close, 2)}</div>
      <div class="ss">Day ${pctS(dayPct)} · volume ${(x.vol || 0).toLocaleString('en-US')}</div>${pts.length >= 2 ? spark(pts, { unit: '' }) : ''}</div>
    ${rangePos != null ? `<h4>52-week range</h4><div class="rng"><i style="left:calc(${rangePos}% - 1px)"></i></div><div class="tlab2"><span>J$${fmt(x.lo52, 2)}</span><span>${fmt(x.offHigh, 1)}% vs high</span><span>J$${fmt(x.hi52, 2)}</span></div>` : ''}
    <h4>Price change</h4><table class="yt"><tr><td>3 months</td><td>${pctS(x.m3)}</td></tr><tr><td>6 months</td><td>${pctS(x.m6)}</td></tr><tr><td>12 months</td><td>${pctS(x.m12)}</td></tr></table>
    ${third ? `<p class="fine">Ranks #${pos + 1} of ${rankList.length} by ${r.basis === 'm6' ? '6-month' : r.basis === 'm3' ? '3-month' : '52-week-high'} trend (${third}). Trend alone wasn’t a reliable signal in testing — see the Edge score.</p>` : ''}
    ${x.offHigh != null && x.offHigh < -35 ? '<p class="fine bad">⚠ More than 35% below its 52-week high — stocks like this kept lagging in our tests.</p>' : ''}
    ${!x.vol ? '<p class="fine">No shares traded on this day — the quoted price may be stale and hard to buy or sell at.</p>' : ''}
    ${edgeBlock(d.forecasts, sym)}
    ${signalsBlock(d.forecasts, sym)}
    ${forecastBlock(d.forecasts, sym)}
    <h4>How to read this</h4><p class="fine">The trend figures compare today’s close with closes saved on your phone from 3, 6 and 12 months ago (prices exclude dividends). The 52-week bar shows where today’s price sits between the year’s low and high. This is a research shortlist, not a recommendation — check company results and news before buying.</p>
    <div class="btnrow"><a class="btn pri" href="https://www.jamstockex.com/trading/trade-quotes/?market=50&date=${L.date}" target="_blank" rel="noopener">JSE quotes ↗</a><button class="btn" data-close>Close</button></div>`,
  (root) => bindForecast(root, d.forecasts, sym));
}

// ---------- Timestral forecast: fan chart, target odds, speculation ----------
function edgeBlock(F, sym) {
  const e = F?.stocks?.[sym]?.edge; const E = F?.edgeInfo; if (!e || !E) return '';
  const lab = HEALTH_LABEL(e.score); const sig = Object.entries(e.signals).sort((a, b) => b[1] - a[1]);
  const good = sig.filter(([, v]) => v >= 70).slice(0, 4); const bad = sig.filter(([, v]) => v <= 30).slice(-3).reverse();
  const t5 = E.top5?.oos;
  return `<h4>Edge score · <b class="${lab[1]}">${e.score}/100</b> · #${e.rank} of ${e.of}</h4>
    ${good.length ? `<p><b>Strengths:</b> ${good.map(([k, v]) => `${esc(E.labels[k] || k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}
    ${bad.length ? `<p><b>Weak spots:</b> ${bad.map(([k, v]) => `${esc(E.labels[k] || k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}
    ${F.stocks[sym].chanceUp != null ? `<p class="now">Chance it’s higher in 3 months (dividends included): <b>${F.stocks[sym].chanceUp}%</b> — a typical JSE stock: ${fmt(F.chanceInfo?.baseUp ?? 43, 0)}%.</p>` : ''}
    <p class="fine">${e.rank <= 5 ? 'In today’s top 5. ' : e.rank <= 10 ? 'In today’s top 10. ' : ''}Tested approach: hold the top 5–10 for about 3 months, then re-pick.${t5 ? ` On unseen data that returned ${signed(t5.annNet, 0)}/yr after costs (market ${signed(t5.annMarket, 0)}/yr); its worst quarter was ${signed(t5.worstPeriod, 1)}.` : ''}</p>`;
}
// ---------- tested ideas: per-stock signals, market regime, sizing ----------
const g2 = (o, ...ks) => ks.reduce((a, k) => (a == null ? a : a[k] ?? a[String(k)]), o);
const VCHIP = (v) => {
  const t = String(v || '');
  const [cls, lab] = /negative|avoid/.test(t) ? ['bad', 'Avoid / negative'] : /^edge/.test(t) ? ['good', 'Edge'] : /weak edge/.test(t) ? ['ok', 'Weak edge'] : /too few/.test(t) ? ['ok', 'Too few cases'] : ['ok', 'No edge'];
  return `<span class="vchip ${cls}">${lab}</span>`;
};
const ptsTxt = (x, unit = 'pts') => (x == null ? '—' : `${x >= 0 ? '+' : '−'}${fmt(Math.abs(x), 1)}${unit.startsWith('%') ? '' : ' '}${unit}`);
function signalsBlock(F, sym) {
  const s = F?.stocks?.[sym]; const x = s?.signals; const I = F?.ideas; if (!x) return '';
  const rows = [];
  const iv = x.intrinsic; const ivT = g2(I, 'intrinsic_value', 'blend');
  if (iv) rows.push(['Intrinsic value', `Fair value ≈ <b>J$${fmt(iv.fair, 2)}</b> (earnings power ${iv.epv != null ? `J$${fmt(iv.epv, 2)}` : '—'}, dividends ${iv.ddm != null ? `J$${fmt(iv.ddm, 2)}` : '—'}) · price is <b class="${iv.mos >= 0 ? 'good' : 'bad'}">${iv.mos >= 0 ? `${fmt(iv.mos, 0)}% below` : `${fmt(-iv.mos, 0)}% above`}</b> it`,
    ivT, `Stocks priced furthest below value (top third) beat the market by ${ptsTxt(ivT?.avgExcess)} per 3 months, ahead ${ivT?.winRate}% of the time. Uses a ${fmt(iv.reqReturn, 1)}% required return (T-bill + 6%).`]);
  const rs = x.results;
  if (rs) {
    const T_ = rs.kind === 'weak' ? g2(I, 'post_earnings_drift', 'weakResults63') : g2(I, 'post_earnings_drift', 'strongPullback63');
    rows.push(['Latest results', `Profit ${rs.yoy >= 0 ? 'up' : 'down'} ${Math.abs(rs.yoy)}% on the year (public ~${rs.daysAgo} days ago)`, T_,
      rs.kind === 'weak' ? `After weak results, stocks trailed the market by ${ptsTxt(T_?.avgExcess)} over 3 months (after costs). Strong warning.` : `Buying after strong results (even on a pullback) didn’t beat the market after costs: ${ptsTxt(T_?.avgExcess)}. The good news is usually priced in.`]);
  }
  if (x.breakout) { const T_ = g2(I, 'volume_breakout', 'tight_2x', 'hold63'); rows.push(['Volume breakout', `Broke above its 60-day high ${x.breakout.daysAgo ? `${x.breakout.daysAgo} days ago` : 'today'} on ${fmt(x.breakout.volMult, 1)}× normal volume`, T_, `Breakouts like this trailed the market by ${ptsTxt(T_?.avgExcess)} over 3 months after costs (won ${T_?.winRate}%). On the JSE they tend to fade — don’t chase.`]); }
  if (x.channel) { const T_ = g2(I, 'support_resistance', 'withVolume'); rows.push(['Trading channel', `Range J$${fmt(x.channel.support, 2)}–${fmt(x.channel.resistance, 2)}; price is ${x.channel.pos}% of the way up`, T_, `Buying near the floor of a channel trailed the market by ${ptsTxt(T_?.avgExcess)} after costs; only ${T_?.reachedResistancePct ?? '—'}% reached the ceiling. Floors often break.`]); }
  const lq = x.liquidity;
  if (lq?.turnoverZ != null) { const T_ = g2(I, 'liquidity', 'turnoverSurge'); rows.push(['Turnover vs normal', `${lq.turnoverZ >= 0 ? '+' : ''}${fmt(lq.turnoverZ, 1)} standard deviations vs its 6-month norm`, T_, `High-turnover stocks (top third) beat the market by ${ptsTxt(T_?.avgExcess)} per 3 months — small but consistent; part of the Edge score.`]); }
  if (x.spread) { const T_ = g2(I, 'bid_ask_spread', 'tighterThanUsual_factor'); rows.push(['Bid–ask spread', `${fmt(x.spread.pct, 1)}% (z ${x.spread.z >= 0 ? '+' : ''}${fmt(x.spread.z, 1)} vs its 20-day norm)`, T_, T_ ? `Stocks with spreads tighter than usual: ${ptsTxt(T_.avgExcess)} vs the market over the next month.` : 'Spread history is still being collected.']); }
  if (x.sector) { const T_ = g2(I, 'sector_strength', 'relativeStrength'); rows.push(['Sector strength', `Moves with the ${esc(x.sector.name)} index${x.sector.rs63 != null ? ` · ${ptsTxt(x.sector.rs63, 'pts')} vs its sector over 3 months` : ''}`, T_, T_ ? `Stocks beating their sector (top third) went on to ${ptsTxt(T_.avgExcess)} vs the market per 3 months.` : 'Sector history is still being collected.']); }
  if (lq) rows.push(['Liquidity', `Trades ${lq.tradedPct}% of days · about J$${(lq.adv20 / 1e6).toFixed(lq.adv20 >= 1e7 ? 0 : 1)}M a day`, null, 'Used for position sizing: a position you can build in a few days without pushing the price.']);
  return `<h4>Signals & what testing showed</h4><div class="sigs">${rows.map(([t, state, T_, why]) => `<div class="sig"><div class="sig-h"><b>${t}</b>${T_ ? VCHIP(T_.verdict) : ''}</div><div>${state}</div><div class="fine">${why}</div></div>`).join('')}</div>`;
}
function regimeCard(F) {
  const R_ = F?.regime; const I = F?.ideas; if (!R_) return '';
  const out = [];
  const me = g2(I, 'calendar', 'monthEnd');
  if (R_.monthEnd && me) {
    const w = R_.monthEnd;
    out.push(`<div class="sig"><div class="sig-h"><b>Month-end timing</b>${VCHIP(me.verdict)}</div><div>${w.inWindow ? '<b>In the month-end window now</b> — prices usually firm up into the close of the month.' : w.earlyMonth ? '<b>Early in the month</b> — prices have usually just dipped; a better time to buy.' : `${w.tradingDaysLeft} trading days left this month.`}</div>
      <div class="fine">Last 3 trading days of a month: market ${ptsTxt(me.last3Days, '%')} on average vs ${ptsTxt(me.typical3Days, '%')} for a typical 3 days; first 3 days of the next month: ${ptsTxt(me.first3DaysNextMonth, '%')}. Too small to trade on its own after costs (${ptsTxt(me.tradeAfterCosts, '%')}), but useful for timing: buy early in the month, sell into month end.</div></div>`);
  }
  const rt = R_.rates; const RT = I?.rates;
  if (rt) {
    const r = RT?.byRegime?.[rt.regime];
    out.push(`<div class="sig"><div class="sig-h"><b>Interest rates</b><span class="vchip ok">${esc(rt.regime)}</span></div><div>3-month T-bill ${fmt(rt.tbill3m, 2)}% (${rt.chg3m >= 0 ? '+' : ''}${fmt(rt.chg3m, 2)} pts over 3 months)</div>
      <div class="fine">${r ? `In past “${rt.regime}” periods the market returned ${ptsTxt(r.market3m * 1, '%')} over the next 3 months; financial stocks ${ptsTxt(r.financialsVsMarket3m)} vs the market; Junior Market ${ptsTxt(r.juniorVsMarket3m)}.` : ''} ${RT?.stocksVsTbills ? `Switching to T-bills when yields rise: ${ptsTxt(RT.stocksVsTbills.switchOnRisingYields.ann, '%/yr')} (worst fall ${fmt(RT.stocksVsTbills.switchOnRisingYields.maxDD, 0)}%) vs always stocks ${ptsTxt(RT.stocksVsTbills.alwaysStocks.ann, '%/yr')} (${fmt(RT.stocksVsTbills.alwaysStocks.maxDD, 0)}%) and always T-bills ${ptsTxt(RT.stocksVsTbills.alwaysTbills.ann, '%/yr')}.` : ''} Only ${RT?.monthsTested ?? 'a few dozen'} months of history — indicative, not proof.</div></div>`);
  }
  const fx = R_.fx; const FX = I?.fx;
  if (fx) {
    const r = FX?.byRegime?.[fx.regime];
    out.push(`<div class="sig"><div class="sig-h"><b>US$ / J$</b><span class="vchip ok">${esc(fx.regime)}</span></div><div>J$${fmt(fx.usdjmd, 2)} per US$ · ${fx.chg20d >= 0 ? '+' : ''}${fmt(fx.chg20d, 2)}% in 20 days, ${fx.chg5d >= 0 ? '+' : ''}${fmt(fx.chg5d, 2)}% in 5</div>
      <div class="fine">${r ? `In past “${fx.regime}” stretches the market returned ${ptsTxt(r.market1m, '%')} the next month; US$-linked stocks ${ptsTxt(r.usdLinkedVsMarket1m)} vs the market.` : ''} Daily rates only go back to ${FX?.period?.[0] ? fd(FX.period[0], false) : 'March 2024'}.</div></div>`);
  }
  const SV = RT?.stocksVsTbills; const E10 = F.edgeInfo?.all;
  if (SV) out.push(`<div class="sig"><div class="sig-h"><b>Stocks or T-bills?</b><span class="vchip ${E10 && E10.annNet > SV.alwaysTbills.ann ? 'good' : 'ok'}">${E10 && E10.annNet > SV.alwaysTbills.ann ? 'Selective stocks' : 'T-bills competitive'}</span></div>
    <div>Over the test period T-bills earned ${ptsTxt(SV.alwaysTbills.ann, '%/yr')} with no losses; the whole JSE ${ptsTxt(SV.alwaysStocks.ann, '%/yr')} (worst fall ${fmt(SV.alwaysStocks.maxDD, 0)}%)${E10 ? `; the Edge top 10 ${ptsTxt(E10.annNet, '%/yr')} after costs` : ''}.</div>
    <div class="fine">Owning “the market” hasn’t paid on the JSE lately — only a selective, tested approach beat risk-free T-bills. Keep money you need within a year in T-bills or a money-market fund.</div></div>`);
  if (R_.sectors) out.push(`<div class="sig"><div class="sig-h"><b>Sector indices, last 3 months</b></div><div>${Object.entries(R_.sectors).map(([k, v]) => `${esc(k)} <b class="${v >= 0 ? 'good' : 'bad'}">${ptsTxt(v, '%')}</b>`).join(' · ')}</div></div>`);
  return out.length ? `<h2 class="sec">Market conditions <small>with what testing showed</small></h2><div class="sigs">${out.join('')}</div>` : '';
}
function sizingVerdict(S) {
  const names = { equal: 'equal-weight top 10', scoreWeighted: 'top 10 weighted by Edge', top5equal: 'top 5', equalKeepTop20: 'top 10, keeping a holding while it stays in the top 20', inverseVol: 'top 10 weighted toward steadier stocks' };
  const best = Object.keys(names).filter((k) => S[k]).sort((a, b) => (S[b].returnPerRisk ?? -9) - (S[a].returnPerRisk ?? -9))[0];
  return `Tested (3-month holds, 1.5% costs charged only on what changes): ${Object.keys(names).filter((k) => S[k]).map((k) => `${names[k]} ${ptsTxt(S[k].annReturn, '%/yr')}`).join(' · ')}; market ${ptsTxt(S.market?.annReturn, '%/yr')}. Best return for the risk: <b>${names[best]}</b> (worst drop ${fmt(S[best].maxDrawdown, 1)}%, ahead of the market ${S[best].beatMarketPct}% of quarters).`;
}
let sizeCap = 1000000; let sizeN = 10; let sizeMode = 'edge';
function sizingCard(F) {
  if (!F?.stocks) return '';
  const S = g2(F, 'ideas', 'position_sizing');
  const ranked = Object.entries(F.stocks).filter(([, v]) => v.edge && !v.pref).sort((a, b) => a[1].edge.rank - b[1].edge.rank).slice(0, sizeN);
  if (!ranked.length) return '';
  const w = ranked.map(([, v]) => (sizeMode === 'edge' ? Math.max(0.5, v.edge.score - 50) : 1)); const ws = w.reduce((a, b) => a + b, 0);
  const rows = ranked.map(([sym, v], i) => {
    const amt = (sizeCap * w[i]) / ws; const px = v.close; const sh = Math.floor(amt / px);
    const adv = v.signals?.liquidity?.adv20 || 0; const days = adv > 0 ? amt / (adv * 0.2) : Infinity;
    return `<tr><td><b>${esc(sym)}</b></td><td>${fmt((w[i] / ws) * 100, 0)}%</td><td>J$${Math.round(amt).toLocaleString('en-US')}</td><td>${sh.toLocaleString('en-US')}</td><td class="${days > 10 ? 'bad' : days > 3 ? 'warn' : 'good'}">${days === Infinity ? 'no trades' : days < 1 ? '<1' : fmt(days, 0)}</td></tr>`;
  }).join('');
  return `<h2 class="sec">Position sizing <small>Edge top ${sizeN}</small></h2>
    <section class="calc"><label>Money to invest (J$)<input id="sz-cap" inputmode="numeric" value="${sizeCap}"></label>
      <div class="sorts"><button data-szn="5" class="${sizeN === 5 ? 'on' : ''}">Top 5</button><button data-szn="10" class="${sizeN === 10 ? 'on' : ''}">Top 10</button>
      <button data-szm="edge" class="${sizeMode === 'edge' ? 'on' : ''}">Weight by Edge</button><button data-szm="equal" class="${sizeMode === 'equal' ? 'on' : ''}">Equal</button></div></section>
    <div class="tblwrap"><table class="yt"><thead><tr><th>Stock</th><th>Weight</th><th>Amount</th><th>Shares</th><th>Days to buy*</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="fine">*Days to build the position without being more than 20% of the stock’s normal daily trading — more than ~3 days means use limit orders over several days. ${S ? sizingVerdict(S) : ''}</p>`;
}
const IDEA_ROWS = [
  ['Intrinsic value (earnings power + dividends)', (I) => g2(I, 'intrinsic_value', 'blend'), (T_) => `top third ${ptsTxt(T_?.avgExcess)} / 3 mo`, (I) => I?.intrinsic_value?.explain],
  ['Post-earnings drift: buy strong results at once', (I) => g2(I, 'post_earnings_drift', 'strongImmediate63'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo after costs`, (I) => I?.post_earnings_drift?.explain],
  ['Post-earnings drift: buy the first pullback', (I) => g2(I, 'post_earnings_drift', 'strongPullback63'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo after costs`, () => ''],
  ['Avoid stocks that just reported weak results', (I) => g2(I, 'post_earnings_drift', 'weakResults63'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo — a real warning`, () => ''],
  ['Support & resistance channels (volume-confirmed)', (I) => g2(I, 'support_resistance', 'withVolume'), (T_) => `${ptsTxt(T_?.avgExcess)} per trade after costs`, (I) => I?.support_resistance?.explain],
  ['Volume-backed breakouts (2×, tight base)', (I) => g2(I, 'volume_breakout', 'tight_2x', 'hold63'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo after costs`, (I) => I?.volume_breakout?.explain],
  ['Pre-results run-up (10 days)', (I) => g2(I, 'calendar', 'preResults10d'), (T_) => `${ptsTxt(T_?.avgExcess)} before costs`, (I) => I?.calendar?.explain],
  ['Pre-ex-dividend run-up (10 days)', (I) => g2(I, 'calendar', 'preExDividend10d'), (T_) => `${ptsTxt(T_?.avgExcess)} before costs (fading: ${ptsTxt(T_?.firstHalf)} → ${ptsTxt(T_?.secondHalf)})`, () => ''],
  ['Drop after ex-dividend (5 days)', (I) => g2(I, 'calendar', 'postExDividend5d'), (T_) => `${ptsTxt(T_?.avgExcess)} beyond the dividend`, () => ''],
  ['Month-end flows (last 3 trading days)', (I) => g2(I, 'calendar', 'monthEnd'), (T_) => `${ptsTxt(T_?.last3Days, '%')} vs ${ptsTxt(T_?.typical3Days, '%')} typical`, () => 'Useful for timing buys and sells, not as a trade by itself.'],
  ['Accumulation (J$ traded on up vs down days)', (I) => g2(I, 'liquidity', 'accumulation'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo`, (I) => I?.liquidity?.explain],
  ['Turnover surge vs its norm', (I) => g2(I, 'liquidity', 'turnoverSurge'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo`, () => 'Added to the Edge score.'],
  ['Zero-volume masking for momentum', (I) => g2(I, 'liquidity', 'momentumTradedDaysOnly'), (T_) => `same result as unmasked (${ptsTxt(T_?.avgExcess)})`, () => 'Ignoring no-trade days changed nothing measurable for 12-month signals.'],
  ['Sector relative strength', (I) => g2(I, 'sector_strength', 'relativeStrength'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo`, (I) => I?.sector_strength?.explain],
  ['…when its sector is flat or falling', (I) => g2(I, 'sector_strength', 'relativeStrengthWhenSectorFlatOrDown'), (T_) => `${ptsTxt(T_?.avgExcess)} / 3 mo`, () => ''],
  ['Bid–ask spread tightening', (I) => g2(I, 'bid_ask_spread', 'tighterThanUsual_factor'), (T_) => `${ptsTxt(T_?.avgExcess)} / 1 mo`, (I) => I?.bid_ask_spread?.explain],
  ['Sudden spread tightening + up close', (I) => g2(I, 'bid_ask_spread', 'suddenTighteningWithUpClose_trade21'), (T_) => `${ptsTxt(T_?.avgExcess)} / 1 mo after costs`, () => ''],
];
function ideasSheet(F) {
  const I = F?.ideas; if (!I) return;
  const rows = IDEA_ROWS.map(([title, pick, metric, ex]) => { const T_ = pick(I); if (!T_) return ''; return `<div class="sig"><div class="sig-h"><b>${title}</b>${VCHIP(T_.verdict)}</div><div>${metric(T_)}${T_.winRate != null ? ` · won ${T_.winRate}% of ${T_.n} cases` : ''}</div>${ex(I) ? `<div class="fine">${esc(ex(I))}</div>` : ''}</div>`; }).join('');
  const RT = I.rates; const FX = I.fx;
  openSheet(`<h3>Every idea we tested</h3>
    <p class="fine">JSE daily prices since 2021 with dividends included; you buy at the next day’s close; “vs the market” = average buy-and-hold return of all ordinary shares over the same days; trade-style ideas pay 1.5% per side. “Edge” needs a consistent result in both halves of the period.</p>
    <div class="sigs">${rows}</div>
    ${RT ? `<div class="sig"><div class="sig-h"><b>Rate regimes & bank sensitivity</b><span class="vchip ok">Indicative</span></div><div>${Object.entries(RT.byRegime).map(([k, v]) => `${k}: market ${ptsTxt(v.market3m, '%')} · financials ${ptsTxt(v.financialsVsMarket3m)} · junior ${ptsTxt(v.juniorVsMarket3m)} (${v.months} mo)`).join('<br>')}</div>${RT.breakoutsByRegime ? `<div>Breakouts by rate regime (3 months, before costs): ${Object.entries(RT.breakoutsByRegime).filter(([, v]) => v.n).map(([k, v]) => `${k}: won ${v.winRate}% (${ptsTxt(v.avgExcessBeforeCosts)}, ${v.n} cases)`).join(' · ')}</div>` : ''}<div class="fine">${esc(RT.explain)} Bank net-interest-margin data isn’t published in a usable form, so financial stocks’ returns stand in for it.</div></div>` : ''}
    ${FX ? `<div class="sig"><div class="sig-h"><b>USD/JMD momentum</b><span class="vchip ok">Indicative</span></div><div>${Object.entries(FX.byRegime).map(([k, v]) => `${k}: market ${ptsTxt(v.market1m, '%')} next month · US$-linked ${ptsTxt(v.usdLinkedVsMarket1m)} (${v.cases} weeks)`).join('<br>')}</div><div class="fine">${esc(FX.explain)}</div></div>` : ''}
    <div class="sig"><div class="sig-h"><b>Not testable with public data</b></div><div class="fine">Pre-open auction imbalance (needs a live broker feed) · cross-listed arbitrage with Trinidad/Barbados (no free price history yet) · broker VWAP/TWAP execution (the sizing table’s “days to buy” is the practical version) · trading US markets (see the TradingView chart).</div></div>
    <div class="btnrow"><button class="btn" data-close>Close</button></div>`);
}
const LV = (F, l) => F.levels.indexOf(l);
function fanChart(F, sym, target) {
  const s = F.stocks[sym]; const W = 340; const Hh = 190; const padL = 4; const padR = 92; const padT = 10; const padB = 22;
  const hist = s.hist.slice(-120); const n = hist.length; const total = n - 1 + F.horizon;
  const iq = { a: LV(F, 0.1), b: LV(F, 0.25), m: LV(F, 0.5), c: LV(F, 0.75), e: LV(F, 0.9) };
  const vals = [...hist.map((h) => h[1]), ...s.q.flatMap((q) => [q[iq.a], q[iq.e]]), ...(target ? [target] : [])];
  let lo = Math.min(...vals); let hi = Math.max(...vals); const span = hi - lo || hi * 0.1 || 1; lo -= span * 0.06; hi += span * 0.06;
  const X = (i) => padL + (i / total) * (W - padL - padR); const Y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (Hh - padT - padB);
  const fx = (k) => n - 1 + F.steps[k];
  const band = (ia, ib) => { const top = s.q.map((q, k) => `L${X(fx(k)).toFixed(1)},${Y(q[ib]).toFixed(1)}`).join(''); const bot = s.q.map((q, k) => `L${X(fx(k)).toFixed(1)},${Y(q[ia]).toFixed(1)}`).reverse().join('');
    return `M${X(n - 1).toFixed(1)},${Y(s.close).toFixed(1)}${top}${bot}Z`; };
  const hp = hist.map((h, i) => `${i ? 'L' : 'M'}${X(i).toFixed(1)},${Y(h[1]).toFixed(1)}`).join('');
  const mp = `M${X(n - 1).toFixed(1)},${Y(s.close).toFixed(1)}${s.q.map((q, k) => `L${X(fx(k)).toFixed(1)},${Y(q[iq.m]).toFixed(1)}`).join('')}`;
  const last = s.q[s.q.length - 1];
  // right-edge labels, nudged apart so they never overlap
  const labs = [[last[iq.e], ''], [last[iq.m], 'md'], [last[iq.a], ''], ...(target ? [[target, 'tg']] : [])].map(([v, c]) => ({ v, c, y: Y(v) + 3.5 })).sort((p, q) => p.y - q.y);
  for (let k = 1; k < labs.length; k++) if (labs[k].y - labs[k - 1].y < 11) labs[k].y = labs[k - 1].y + 11;
  const pc = (v) => { const p = (v / s.close - 1) * 100; return `${p >= 0 ? '+' : '−'}${fmt(Math.abs(p), Math.abs(p) < 10 ? 1 : 0)}%`; };
  const labHtml = labs.map((l) => `<text x="${W - padR + 4}" y="${l.y.toFixed(1)}" class="fc-t ${l.c}">${fmt(l.v, l.v < 10 ? 2 : 1)} <tspan class="fc-p">${pc(l.v)}</tspan>${l.c === 'tg' ? ' target' : ''}</text>`).join('');
  return `<div class="fan" data-sym="${esc(sym)}"><svg viewBox="0 0 ${W} ${Hh}" width="100%" role="img" aria-label="Price history and 3-month forecast range">
    <path d="${band(iq.a, iq.e)}" class="fc-b1"/><path d="${band(iq.b, iq.c)}" class="fc-b2"/>
    <line x1="${X(n - 1)}" x2="${X(n - 1)}" y1="${padT}" y2="${Hh - padB}" class="fc-now"/>
    <path d="${hp}" class="fc-h"/><path d="${mp}" class="fc-m"/>
    ${target ? `<line x1="${padL}" x2="${W - padR}" y1="${Y(target)}" y2="${Y(target)}" class="fc-tg"/>` : ''}${labHtml}
    <text x="${padL}" y="${Hh - 6}" class="fc-t">${fd(hist[0][0], false)}</text><text x="${X(n - 1)}" y="${Hh - 6}" class="fc-t" text-anchor="middle">today</text>
    <text x="${W - padR}" y="${Hh - 6}" class="fc-t" text-anchor="end">${fd(F.dates[F.dates.length - 1])}</text>
    <line class="fc-x" x1="0" x2="0" y1="${padT}" y2="${Hh - padB}" style="display:none"/></svg>
    <div class="fan-key fine"><span><i class="k1"></i>80% range ${fmt(last[iq.a], 2)}–${fmt(last[iq.e], 2)} (${pc(last[iq.a])} to ${pc(last[iq.e])})</span>
      <span><i class="k2"></i>middle ${fmt(last[iq.m], 2)} (${pc(last[iq.m])})</span>${target ? `<span><i class="k3"></i>target ${fmt(target, 2)} (${pc(target)})</span>` : ''}</div>
    <div class="fan-read fine">Drag across the chart to read values</div></div>`;
}
function forecastBlock(F, sym) {
  const s = F?.stocks?.[sym];
  if (!F) return `<h4>3-month forecast</h4><p class="fine">${ghToken.get() ? 'Forecasts haven’t loaded yet.' : 'Add your read-only GitHub token under Sources to see the Timestral forecast and target odds for this stock.'}</p>`;
  if (!s) return '<h4>3-month forecast</h4><p class="fine">Not enough trading history to forecast this stock yet (needs about 6 months).</p>';
  const m = fcAt(F, sym, 0.5); const a = fcAt(F, sym, 0.1); const e = fcAt(F, sym, 0.9);
  const bt = F.backtest?.horizons?.['63'] || F.backtest?.horizons?.[63];
  const h = s.hype; const hl = hypeLabel(h?.score);
  const t0 = Math.round(s.close * 1.2 * 100) / 100;
  return `<h4>3-month forecast · Timestral ${esc(F.model?.replace('Timestral-', '') || '')} · as of ${fd(F.asof)}</h4>
    <div id="fan-wrap">${fanChart(F, sym, t0)}</div>
    <p>Middle estimate for ${fd(F.dates[F.dates.length - 1])}: <b>J$${fmt(m, 2)}</b> (${signed((m / s.close - 1) * 100, 1)}). The model gives an 80% range of J$${fmt(a, 2)}–J$${fmt(e, 2)}${bt ? `; in back-testing, real prices ended inside that range ${fmt(bt.coverage80, 0)}% of the time` : ''}.</p>
    <h4>Your target</h4>
    <div class="calc2"><label>Target price (J$)<input id="fc-target" inputmode="decimal" value="${t0}"></label></div>
    <div class="sorts">${[10, 20, 30, 50].map((p) => `<button data-tp="${p}">+${p}%</button>`).join('')}<button data-tp="-10">−10%</button></div>
    <div id="fc-odds"></div>
    ${healthBlock(s)}
    ${h ? `<h4>Speculation</h4><p><b class="${hl[1]}">${hl[0]}</b> · ${h.score}/100</p>
    <table class="yt"><tr><td>Volume, last 5 days vs normal</td><td>${fmt(h.volRatio, 1)}×</td></tr><tr><td>Price move, last 10 days</td><td>${signed(h.move10, 1)}</td></tr>
      <tr><td>Above its 50-day average</td><td>${signed(h.above50, 1)}</td></tr><tr><td>Days with no trades (last 60)</td><td>${h.thinPct}%</td></tr></table>
    ${speculationNote(F)}` : ''}
    ${backtestNote(F)}`;
}
const HEALTH_LABEL = (v) => (v == null ? null : v >= 65 ? ['Strong', 'good'] : v >= 45 ? ['Fair', 'ok'] : v >= 25 ? ['Weak', 'warn'] : ['Poor', 'bad']);
function healthBlock(s) {
  const hl = s.health; const f = s.fund;
  if (s.pref) return '<h4>Financial health</h4><p class="fine">This is a preference share: it pays a fixed dividend and its price barely moves with company profits, so it isn’t scored or ranked on financial health.</p>';
  if (!hl && !f) return '<h4>Financial health</h4><p class="fine">No financial results on the JSE page for this stock yet.</p>';
  const lab = HEALTH_LABEL(hl?.score);
  const pe = hl?.ey > 0 ? fmt(100 / hl.ey, 1) : null;
  const big = (v) => (v == null ? '—' : Math.abs(v) >= 1e9 ? `${fmt(v / 1e9, 2)}B` : Math.abs(v) >= 1e6 ? `${fmt(v / 1e6, 1)}M` : fmt(v, 0));
  const qs = (f?.lastQuarters || []).slice(-6);
  return `<h4>Financial health${hl ? ` · <b class="${lab[1]}">${lab[0]}</b> ${hl.score}/100` : ''}</h4>
    ${hl ? `<table class="yt">
      <tr><td>Earnings yield${pe ? ` (P/E ${pe})` : ''}</td><td class="${hl.ey == null ? '' : hl.ey > 0 ? 'good' : 'bad'}">${hl.ey == null ? '—' : `${fmt(hl.ey, 1)}%`}</td></tr>
      <tr><td>Profit, last 12 months vs year before</td><td class="${hl.growth == null ? '' : hl.growth >= 0 ? 'good' : 'bad'}">${hl.growth == null ? '—' : signed(hl.growth, 0)}</td></tr>
      <tr><td>Dividend yield, last 12 months</td><td>${hl.dy == null ? '—' : `${fmt(hl.dy, 1)}%`}</td></tr>
      <tr><td>Loss-making quarters (last 4)</td><td class="${hl.lossq ? 'bad' : 'good'}">${hl.lossq ?? '—'}</td></tr></table>` : ''}
    ${qs.length ? `<p class="fine">Net profit by quarter (reported currency): ${qs.map(([q, v]) => `${esc(q)} <b class="${v < 0 ? 'bad' : ''}">${big(v)}</b>`).join(' · ')}</p>` : ''}
    <p class="fine">From the company’s results on the JSE website. These figures also feed into the forecast above, counted only from about 45 days after each quarter ends (when results are usually out).</p>`;
}
function speculationNote(F) {
  const b = F.backtest?.hype?.['63'] || F.backtest?.hype?.[63];
  const base = 'High scores mean sudden volume and price jumps the stock’s usual behaviour doesn’t explain — often buzz-driven buying. Prices can keep running, but swings both ways are bigger.';
  if (!b || b.highExcessVsMarket == null) return `<p class="fine">${base}</p>`;
  return `<p class="fine">${base} On past JSE data, stocks scoring 50+ then ${b.highExcessVsMarket >= 0 ? 'beat' : 'trailed'} the market by ${fmt(Math.abs(b.highExcessVsMarket), 1)} points over 3 months on average${b.highWorsePct != null ? ` — but did worse than the market in ${b.highWorsePct}% of periods` : ''}, with returns ${fmt(b.highSd / Math.max(1, b.lowSd), 1)}× as spread out as calm stocks. A few big winners drive the average, so treat it like a lottery ticket.</p>`;
}
function backtestNote(F) {
  const B = F.backtest; const g = (o, h) => o?.[String(h)] ?? o?.[h];
  const m1 = g(B?.horizons, 21); const m3 = g(B?.horizons, 63); if (!m3) return '';
  const c3 = g(B?.compare, 63); const c1 = g(B?.compare, 21);
  const ex = (v) => `${v >= 0 ? 'beat' : 'trailed'} the market by ${fmt(Math.abs(v), 1)} pts`;
  const cmp = (c) => (c?.priceOnly && c?.withFinancials ? `price only ${pts(c.priceOnly.topThirdExcess)} → with financial health ${pts(c.withFinancials.topThirdExcess)}` : '');
  return `<h4>How much to trust it</h4>
    <p class="fine">Tested on ${(B.cases || 0).toLocaleString('en-US')} past JSE forecasts (${fd(B.from, false)}–${fd(B.to, false)}), buying at the next day’s close the way you realistically would.</p>
    <table class="yt">
      ${m1 ? `<tr><td>1 month: top third of forecasts</td><td>${ex(m1.topThirdExcess)} (${m1.topThirdBeatPct}% of months)</td></tr>` : ''}
      <tr><td>3 months: top third of forecasts</td><td>${ex(m3.topThirdExcess)} (${m3.topThirdBeatPct}% of periods)</td></tr>
      <tr><td>80% range held the actual price</td><td>${fmt(m3.coverage80, 0)}% of the time</td></tr>
      ${c3 ? `<tr><td>Adding financial health (3 months)</td><td>${cmp(c3)}</td></tr>` : ''}
      ${c3?.healthScoreAlone ? `<tr><td>Financial-health score alone (3 months)</td><td>top third ${ex(c3.healthScoreAlone.topThirdExcess)} (${c3.healthScoreAlone.topThirdBeatPct}% of periods)</td></tr>` : ''}
      ${c1 ? `<tr><td>Adding financial health (1 month)</td><td>${cmp(c1)}</td></tr>` : ''}
    </table>
    <p class="fine">Target odds are adjusted using how the model’s past odds actually turned out. Thinly traded stocks can be hard to buy at the quoted price. Use this as one input next to company news — not a promise.</p>`;
}
// chance of having touched the target by ~1, 2 and 3 months (running maximum of the per-day odds, then calibrated)
function byMonth(F, o) {
  const marks = [21, 42, 63].map((t) => F.steps.findIndex((st) => st >= t)).map((i) => (i < 0 ? F.steps.length - 1 : i));
  return marks.map((i) => { const raw = Math.max(...o.probs.slice(0, i + 1)); const p = o.up ? calibrate(raw, F.calibration) : raw; return [F.dates[i], Math.max(1, Math.min(99, Math.round(p * 100)))]; });
}
function bindForecast(root, F, sym) {
  const s = F?.stocks?.[sym]; if (!s) return;
  const inp = root.querySelector('#fc-target'); const out = root.querySelector('#fc-odds');
  const draw = () => {
    const t = parseFloat(String(inp.value).replace(/[,\s$J]/g, ''));
    root.querySelector('#fan-wrap').innerHTML = fanChart(F, sym, t > 0 ? t : null); bindFan(root, F, sym);
    if (!(t > 0)) { out.innerHTML = ''; return; }
    const o = targetOdds(F, sym, t); const pct = (t / s.close - 1) * 100;
    const word = o.up ? 'reaching' : 'dropping to';
    const pp = Math.round(o.p * 100);
    out.innerHTML = `<div class="c-big"><span>Chance of ${word} J$${fmt(t, 2)} (${signed(pct, 1)}) by ${fd(F.dates[F.dates.length - 1])}</span><b class="${o.up ? (pp >= 50 ? 'good' : pp >= 25 ? 'warn' : 'bad') : ''}">${pp < 2 ? '<2' : pp > 97 ? '>97' : pp}%</b></div>
      <table class="yt">${byMonth(F, o).map(([dt, p]) => `<tr><td>${o.up ? 'Reached' : 'Dropped to it'} by ${fd(dt)}</td><td>${p}%</td></tr>`).join('')}</table>
      <p class="fine">${o.likelyDate ? `More likely than not from about <b>${fd(o.likelyDate)}</b>.` : 'Not more likely than not within 3 months.'}${o.up ? '' : ' Downside odds aren’t adjusted by the back-test.'}
      ${o.up && o.raw !== o.p ? ` Model’s raw estimate was ${Math.round(o.raw * 100)}%; adjusted for how its past odds turned out.` : ''} Dates count trading days only, so they may run a day or two early around holidays.</p>`;
  };
  inp.addEventListener('input', draw);
  root.querySelectorAll('[data-tp]').forEach((b) => b.addEventListener('click', () => { inp.value = (Math.round(s.close * (1 + +b.dataset.tp / 100) * 100) / 100).toFixed(2); draw(); }));
  draw();
}
function bindFan(root, F, sym) {
  const fan = root.querySelector('.fan'); if (!fan) return; const svg = fan.querySelector('svg'); const ln = svg.querySelector('.fc-x'); const rd = fan.querySelector('.fan-read');
  const s = F.stocks[sym]; const hist = s.hist.slice(-120); const n = hist.length; const total = n - 1 + F.horizon; const W = 340; const padL = 4; const padR = 92;
  const move = (ev) => {
    const r = svg.getBoundingClientRect(); const x = ((ev.clientX - r.left) / r.width) * W; const i = Math.round(((x - padL) / (W - padL - padR)) * total);
    let txt; let xi;
    if (i <= n - 1) { const k = Math.max(0, i); xi = k; txt = `${fd(hist[k][0])}: J$${fmt(hist[k][1], 2)}`; }
    else { let k = F.steps.findIndex((st) => st >= i - (n - 1)); if (k < 0) k = F.steps.length - 1; xi = n - 1 + F.steps[k]; const q = s.q[k];
      const pp = (v) => signed((v / s.close - 1) * 100, 1);
      txt = `${fd(F.dates[k])}: middle J$${fmt(q[LV(F, 0.5)], 2)} (${pp(q[LV(F, 0.5)])}) · 80% range J$${fmt(q[LV(F, 0.1)], 2)}–${fmt(q[LV(F, 0.9)], 2)} (${pp(q[LV(F, 0.1)])} to ${pp(q[LV(F, 0.9)])})`; }
    const px = padL + (xi / total) * (W - padL - padR); ln.setAttribute('x1', px); ln.setAttribute('x2', px); ln.style.display = ''; rd.textContent = txt;
  };
  svg.addEventListener('pointerdown', move); svg.addEventListener('pointermove', (e) => { if (e.buttons || e.pointerType !== 'mouse') move(e); });
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

function rateTile(label, series, sub, key = '') {
  if (!series?.length) return '';
  const l = last(series); const c = changeOver(series, 183, 'pp');
  return stat(label, `${fmt(l.value, 2)}%`, `${fd(l.date, false)}${c != null ? ` · ${signed(c, 2, ' pts')} 6m` : ''}${sub ? `<br>${sub}` : ''}`, spark(series.map((p) => ({ date: p.date, value: p.value })), { unit: '%', fmtX: (p) => fd(p.date, false) }), key);
}

function viewBorrow(d) {
  const b = borrowing(d); const r = d.bojrates || {}; const boj = d.boj || {};
  const inst = r.loans?.instalment; const defRate = inst?.length ? last(inst).value : null;
  const c = calcState(defRate);
  const infl = boj.inflation ?? d.statin?.cpiPtp?.value;
  const t12 = r.deposits?.time12?.length ? last(r.deposits.time12).value : null;
  const out = [];
  out.push(`<section class="hero-b">
    <div class="gname">Loan rates outlook · next 3–6 months<button class="ib" data-x="d_borrow" aria-label="What this means">i</button></div>
    <div class="glabel ${STEP_CLASS[b.step]}"><span class="gi">${STEP_ICON[b.step]}</span>${b.label}</div>
    <div class="segs">${[0, 1, 2, 3].map((i) => `<i class="${i <= b.step ? STEP_CLASS[b.step] : ''}"></i>`).join('')}</div>
    ${boj.nextPolicyDate ? `<div class="gblurb">Next BOJ rate decision: <b>${boj.nextPolicyDate}</b></div>` : ''}
    <ul class="why">${b.reasons.map((x) => `<li class="${x.pts > 0 ? 'up' : x.pts < 0 ? 'down' : ''}"><span>${x.pts > 0 ? '▲' : x.pts < 0 ? '▼' : '●'}</span>${esc(x.txt)}</li>`).join('')}</ul>
    <div class="advice">${b.advice.map((x) => `<p>${esc(x)}</p>`).join('')}</div>
  </section>`);

  out.push('<h2 class="sec">What borrowing costs right now <small>BOJ, commercial-bank averages</small></h2><div class="grid">');
  out.push(rateTile('Vehicle / instalment loans', inst, 'avg rate actually charged', 'r_instalment'));
  out.push(rateTile('Personal loans', r.loans?.personal, '', 'r_personal'));
  out.push(rateTile('Mortgages', r.loans?.mortgage, '', 'r_mortgage'));
  out.push(rateTile('All loans (avg)', r.loans?.overall, '', 'r_overall'));
  out.push('</div><h2 class="sec">What saving earns</h2><div class="grid">');
  out.push(rateTile('Time deposit, 12m+', r.deposits?.time12, '', 'r_time12'));
  out.push(rateTile('Savings account', r.deposits?.savings, '', 'r_savings'));
  out.push(rateTile('3-month T-bill', r.tbills?.m3, '', 'r_tb3'));
  out.push(rateTile('6-month T-bill', r.tbills?.m6, '', 'r_tb6'));
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
  const seg = `<div class="seg3"><button data-nscope="local" class="${newsScope === 'local' ? 'on' : ''}">Jamaica</button><button data-nscope="global" class="${newsScope === 'global' ? 'on' : ''}">Global</button><button data-nscope="research" class="${newsScope === 'research' ? 'on' : ''}">Research</button></div>`;
  if (newsScope === 'global') return seg + viewGlobal(d);
  if (newsScope === 'research') return seg + viewResearch(d);
  return seg + viewLocal(d);
}
// ---------- Research papers ----------
let rTopic = 'airesearch'; let rSort = 'best'; let rOA = false; let rShown = [];
const R_LABEL = { airesearch: 'AI research', fmcg: 'FMCG forecasting', markets: 'Market forecasting', logistics: 'Logistics', sales: 'Sales innovation' };
function viewResearch(d) {
  const R = d.research;
  const chips = `<div class="sorts">${Object.entries(R_LABEL).map(([k, l]) => `<button data-rtopic="${k}" class="${rTopic === k ? 'on' : ''}">${l}${R?.topics?.[k] ? ` · ${R.topics[k].length}` : ''}</button>`).join('')}</div>`;
  if (!R?.topics) return chips + empty(running.has('research') ? 'Finding recent papers…' : `Papers haven’t loaded yet${cache.research?.error ? ` (${esc(cache.research.error)})` : ''} — tap refresh.`);
  let list = (R.topics[rTopic] || []).slice();
  if (rOA) list = list.filter((p) => p.oa);
  list.sort(rSort === 'cited' ? (a, b) => (b.cites ?? -1) - (a.cites ?? -1) || (b.date || '').localeCompare(a.date || '')
    : rSort === 'new' ? (a, b) => (b.date || '').localeCompare(a.date || '') : (a, b) => (a.rank ?? 99) - (b.rank ?? 99));
  rShown = list;
  const yr = (p) => (p.date ? fd(p.date.length === 4 ? `${p.date}-01-01` : p.date, p.date.length > 4) : '');
  return `${chips}
    <div class="newsbar"><label><input type="checkbox" id="roa" ${rOA ? 'checked' : ''}> Free to read only</label>
      <span class="sorts" style="margin:0"><button data-rsort="best" class="${rSort === 'best' ? 'on' : ''}">Best match</button><button data-rsort="new" class="${rSort === 'new' ? 'on' : ''}">Newest</button><button data-rsort="cited" class="${rSort === 'cited' ? 'on' : ''}">Most cited</button></span></div>
    <p class="fine">From arXiv (preprints, not yet peer-reviewed) and OpenAlex (English-language articles and reviews from the last 1–2 years). Refreshes daily. Tap a paper for its summary.</p>
    ${list.length ? `<ul class="news papers">${list.map((p, i) => `<li data-paper="${i}"><b class="l-t">${esc(p.title)}</b>
      <div class="nmeta">${esc(p.authors || 'Unknown authors')} · ${esc(p.venue)}${p.date ? ` · ${yr(p)}` : ''}</div>
      <div class="nmeta">${p.preprint ? '<span class="tag">Preprint</span>' : ''}${p.oa ? '<span class="tag good">Free to read</span>' : ''}${p.cites != null ? `<span class="tag">${p.cites} citation${p.cites === 1 ? '' : 's'}</span>` : ''}</div>
      ${p.abstract ? `<div class="why1">${esc(p.abstract.slice(0, 180))}${p.abstract.length > 180 ? '…' : ''}</div>` : ''}</li>`).join('')}</ul>` : empty('No papers match — try turning off “Free to read only”.')}
    ${R.errors?.length ? `<p class="fine">Some searches didn’t load: ${esc(R.errors.join('; '))}</p>` : ''}`;
}
function paperSheet(i) {
  const p = rShown[i]; if (!p) return;
  openSheet(`<h3>${esc(p.title)}</h3>
    <p class="fine">${esc(p.authors || 'Unknown authors')}<br>${esc(p.venue)}${p.date ? ` · ${esc(p.date)}` : ''}${p.cites != null ? ` · cited ${p.cites} time${p.cites === 1 ? '' : 's'}` : ''}</p>
    <p class="nmeta">${p.preprint ? '<span class="tag">Preprint — not yet peer-reviewed</span>' : '<span class="tag">Journal article</span>'}${p.oa ? '<span class="tag good">Free to read</span>' : '<span class="tag">May need access</span>'}</p>
    <h4>Summary (from the authors)</h4><p>${esc(p.abstract || 'No abstract available.')}</p>
    <div class="btnrow"><a class="btn pri" href="${esc(p.url)}" target="_blank" rel="noopener">Read paper ↗</a>${p.pdf && p.pdf !== p.url ? `<a class="btn" href="${esc(p.pdf)}" target="_blank" rel="noopener">PDF ↗</a>` : ''}<button class="btn" data-close>Close</button></div>
    <p class="fine">Source: ${esc(p.src)}${p.doi ? ` · DOI ${esc(p.doi)}` : ''}</p>`);
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
  <h2 class="sec">Stock forecasts <small>GitHub token, read-only</small></h2>
  <p class="fine">Every weekday evening your GitHub runs Mistral’s Timestral model and the Edge score on all JSE stocks and saves the results in your private repo. ${ghToken.builtIn() ? '<b class="good">A read-only token is built into this app</b> — nothing to do. You can paste a different one below to override it.' : 'To let this phone read them, make a token that can only read that one repo:'}</p>
  <ol class="fine steps"><li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">github.com/settings/personal-access-tokens/new</a> (fine-grained token).</li>
  <li>Name it “JA Econ Pulse”, expiration up to 1 year.</li><li>Repository access → <b>Only select repositories</b> → <b>jamaica-econ-pulse</b>.</li>
  <li>Permissions → Repository permissions → <b>Contents: Read-only</b>. Nothing else.</li><li>Generate, copy, and paste it here. It stays on this phone.</li></ol>
  <section class="calc"><label class="wide">GitHub token<input id="gh-token" value="${esc(ghToken.get())}" placeholder="github_pat_…" autocomplete="off" autocapitalize="none" spellcheck="false"></label></section>
  <h2 class="sec">FRED API key <small>optional, free</small></h2>
  <p class="fine">FRED (oil, US rates, food and grain prices on the World tab) refuses some phone connections to its public download. Its official API always works but needs a free personal key: sign in at <a href="https://fredaccount.stlouisfed.org/apikeys" target="_blank" rel="noopener">fredaccount.stlouisfed.org/apikeys</a>, tap “Request API Key”, and paste the 32-character key here. It stays on this phone.</p>
  <section class="calc"><label class="wide">FRED API key<input id="fred-key" value="${esc(fredKey.get())}" placeholder="Paste key (optional)" autocomplete="off" autocapitalize="none" spellcheck="false"></label></section>
  <h2 class="sec">How the readings work</h2>
  <p class="fine">Each card applies a fixed rule to the live numbers — for example, Brent oil up more than 10% in three months counts as pressure, because fuel is a large share of Jamaica’s imports and feeds into electricity, transport and the exchange rate. The four gauges add up those signals. Rules describe the usual direction of impact; they are not forecasts, and real outcomes depend on policy and timing.</p>
  <p class="fine">Version 1.5</p>`;
}

// ---------- rendering that doesn't yank the page while you read ----------
let pending = false;
const openState = {}; // details open/closed by data-k, kept across re-renders
function showPending(on) { pending = on; $('#pending').classList.toggle('hide', !on); }
// Background updates (a source finished, commute times arrived): apply right away only if it can't
// disturb what you're looking at; otherwise offer a "tap to update" pill.
function bgRender() {
  if (tab === 'sources') { render({ keepScroll: true }); return; }
  const busyInput = $('#view').contains(document.activeElement) && /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName);
  if (sheetOpen() || busyInput || window.scrollY > 120) { showPending(true); return; }
  render({ keepScroll: true });
}
function render(opts = {}) {
  if (opts === false) { bgRender(); return; } // legacy callers
  const v = $('#view');
  const y = window.scrollY; const nav = v.querySelector('.subnav'); const navX = nav ? nav.scrollLeft : 0;
  const d = data(); const a = analyse(d);
  showPending(false);
  v.innerHTML = tab === 'pulse' ? viewPulse(d, a) : tab === 'jamaica' ? viewJamaica(d) : tab === 'world' ? viewWorld(d) : tab === 'decide' ? viewDecide(d) : tab === 'news' ? viewNews(d) : viewSources();
  v.querySelectorAll('details[data-k]').forEach((x) => { if (x.dataset.k in openState) x.open = openState[x.dataset.k]; x.addEventListener('toggle', () => { openState[x.dataset.k] = x.open; }); });
  const nav2 = v.querySelector('.subnav');
  if (nav2) {
    nav2.scrollLeft = navX; const on = nav2.querySelector('.on');
    if (on) { const n = nav2.getBoundingClientRect(); const o = on.getBoundingClientRect(); if (o.left < n.left || o.right > n.right) nav2.scrollLeft += o.left - n.left - (n.width - o.width) / 2; }
  }
  if (opts.keepScroll) window.scrollTo(0, y);
  const nf = $('#nf'); if (nf) nf.onchange = () => { newsFilter = nf.checked; render({ keepScroll: true }); };
  const gf = $('#gf'); if (gf) gf.onchange = () => { gFilter = gf.checked; render({ keepScroll: true }); };
  v.querySelectorAll('[data-nscope]').forEach((b) => b.addEventListener('click', () => { newsScope = b.dataset.nscope; render(); }));
  v.querySelectorAll('[data-rtopic]').forEach((b) => b.addEventListener('click', () => { rTopic = b.dataset.rtopic; render({ keepScroll: true }); }));
  v.querySelectorAll('[data-rsort]').forEach((b) => b.addEventListener('click', () => { rSort = b.dataset.rsort; render({ keepScroll: true }); }));
  const roa = v.querySelector('#roa'); if (roa) roa.onchange = () => { rOA = roa.checked; render({ keepScroll: true }); };
  if (tab === 'decide' && sub === 'borrow') { v.querySelectorAll('.calc input').forEach((i) => i.addEventListener('input', updateCalc)); updateCalc(); }
  if (tab === 'decide' && sub === 'home') bindFin(v);
  if (tab === 'decide' && sub === 'listings') {
    v.querySelectorAll('[data-fin]').forEach((i) => i.addEventListener('change', () => { fin[i.dataset.fin] = i.value; try { localStorage.setItem(FIN_KEY, JSON.stringify(fin)); } catch (_) { /* ignore */ } if (i.dataset.fin === 'work') { delete geoCache['@work']; enrichListings(); } render({ keepScroll: true }); }));
    v.querySelectorAll('[data-ltype]').forEach((b) => b.addEventListener('click', () => { listFilter.type = b.dataset.ltype; render({ keepScroll: true }); }));
  }
  if (tab === 'decide' && sub === 'car') {
    v.querySelectorAll('[data-cmodel]').forEach((b) => b.addEventListener('click', () => { carCfg.model = b.dataset.cmodel; try { localStorage.setItem(CAR_KEY, JSON.stringify(carCfg)); } catch (_) { /* ignore */ } render({ keepScroll: true }); }));
    v.querySelectorAll('[data-car]').forEach((i) => i.addEventListener('change', () => { carCfg[i.dataset.car] = i.type === 'checkbox' ? i.checked : i.value; try { localStorage.setItem(CAR_KEY, JSON.stringify(carCfg)); } catch (_) { /* ignore */ } render({ keepScroll: true }); }));
  }
  if (tab === 'decide' && sub === 'trade') bindTrade(v);
  if (tab === 'decide' && sub === 'jobs') { const c = document.getElementById('jobs-ja'); if (c) c.onchange = () => { jobsJamaica = c.checked; render({ keepScroll: true }); }; }
  if (tab === 'sources') { const g = document.getElementById('gh-token'); if (g) g.onchange = () => { ghToken.set(g.value); delete cache.forecasts?.at; refresh(false); }; }
  if (tab === 'sources') { const k = document.getElementById('fred-key'); if (k) k.onchange = () => { fredKey.set(k.value); delete cache.fred?.at; refresh(false); }; }
}

// ---------- bottom sheet ----------
const sheetOpen = () => !$('#sheet').classList.contains('hide');
function openSheet(html, bind) {
  $('#sheet-body').innerHTML = html; $('#sheet').classList.remove('hide'); $('#sheet .sheet-card').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  if (!history.state?.sheet) history.pushState({ sheet: 1 }, '');
  if (bind) bind($('#sheet-body'));
}
function closeSheet(fromPop = false) {
  if (!sheetOpen()) return;
  $('#sheet').classList.add('hide'); document.body.style.overflow = '';
  if (!fromPop && history.state?.sheet) history.back();
  if (pending) showPending(true);
}
window.addEventListener('popstate', () => closeSheet(true)); // Android back button closes the sheet
$('#sheet').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeSheet(); });

function explainSheet(key, el) {
  const x = EXPLAIN[key] || EXPLAIN[key.replace(/^wb_/, '')]; if (!x) return;
  const title = x.t || el?.querySelector('.sl-l, .gname, h3')?.textContent.trim() || 'About this number';
  let tile = '';
  if (el && (el.classList.contains('stat') || el.classList.contains('gauge'))) { const c = el.cloneNode(true); c.removeAttribute('data-x'); tile = c.outerHTML; }
  let now = null; try { now = x.now?.(data()); } catch (_) { /* ignore */ }
  openSheet(`<h3>${esc(title)}</h3>${tile}${now ? `<p class="now">${esc(now)}</p>` : ''}
    <h4>What it is</h4><p>${esc(x.what)}</p><h4>How to read it</h4><p>${esc(x.read)}</p><h4>What it means for you</h4><p>${esc(x.you)}</p>`);
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

function setTab(t) {
  tab = t; document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === t));
  saveUi(); window.scrollTo(0, 0); render();
}
$('#tabs').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setTab(b.dataset.tab); });
$('#status').addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) setTab(g.dataset.goto); });
$('#refresh').addEventListener('click', () => refresh(true));
$('#pending').addEventListener('click', () => render({ keepScroll: true }));
$('#view').addEventListener('click', (e) => {
  const sb = e.target.closest('[data-sub]');
  if (sb) { sub = sb.dataset.sub; saveUi(); if (tab !== 'decide') { setTab('decide'); return; } window.scrollTo(0, 0); render(); return; }
  const pf = e.target.closest('[data-profile]');
  if (pf) { profile = pf.dataset.profile; try { localStorage.setItem(PROFILE_KEY, profile); } catch (_) { /* ignore */ } render({ keepScroll: true }); return; }
  const gt = e.target.closest('[data-goto]'); if (gt) { setTab(gt.dataset.goto); return; }
  if (e.target.closest('a, input, select, textarea, summary, label')) return;
  const li = e.target.closest('[data-li]'); if (li) { listingSheet(+li.dataset.li); return; }
  const ci = e.target.closest('[data-ci]'); if (ci) { carSheet(ci.dataset.ci); return; }
  const sy = e.target.closest('[data-sym]'); if (sy) { stockSheet(sy.dataset.sym); return; }
  const pp = e.target.closest('[data-paper]'); if (pp) { paperSheet(+pp.dataset.paper); return; }
  const xk = e.target.closest('[data-x]'); if (xk) { explainSheet(xk.dataset.x, xk.classList.contains('ib') ? xk.closest('.dcard, .hero-b') : xk); }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
$('#today').textContent = new Date().toLocaleDateString('en-JM', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === tab));
status(); render(); refresh(false);
setInterval(status, 60000);
