// Edge v2: a second pick ranking shown next to the original Edge score (made nightly by scripts/edge_v2.py).
import { fmt, signed, esc, fd } from './util.js';

const ABLATION_LABEL = {
  no_forecast: 'Without the Timestral forecast',
  no_events: 'Without company announcements',
  no_spread: 'Ranked by score, ignoring trading costs',
  last_trade_pullback: 'Pullbacks measured on the last trade, not the quote midpoint',
  equal_theme_weights: 'Every theme weighted the same',
  flat_v1_signals: 'No themes: v1’s signals refit every quarter',
};
const pctCell = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'good' : 'bad'}">${signed(v, 1)}</b>`);
const yr = (r) => (r ? `${signed(r.annNet, 1)}/yr` : '—');

export const edge2Ranked = (F) => Object.entries(F?.stocks || {}).filter(([, v]) => v.edge2?.rank).sort((a, b) => a[1].edge2.rank - b[1].edge2.rank);

function compareRows(C) {
  const rows = [
    ['Edge v1, as the app tested it (last price, 1% costs)', C.v1Close],
    ['Edge v1, realistic fills', C.v1],
    ['<b>Edge v2</b>, realistic fills', C.v2],
    ['Edge v2 top 5, realistic fills', C.v2Top5],
    ['Edge v1, buying a day later', C.v1SkipDay],
    ['Edge v2, buying a day later', C.v2SkipDay],
    ['Edge v1, only buys made in 2026', C.v1Since2026],
    ['Edge v2, only buys made in 2026 (no forecast history yet)', C.v2Since2026],
  ].filter(([, r]) => r);
  return `<div class="tblwrap"><table class="yt"><thead><tr><th>Back-test</th><th>Per year</th><th>Market</th><th>Beat it</th></tr></thead><tbody>
    ${rows.map(([l, r]) => `<tr><td>${l}</td><td>${pctCell(r.annNet)}</td><td>${signed(r.annMarket, 1)}</td><td>${r.beatPct}%</td></tr>`).join('')}
  </tbody></table></div>`;
}

export function edge2Card(F, held = new Set()) {
  const I = F?.edge2Info; if (!I) return '';
  const top = edge2Ranked(F).slice(0, 10);
  const C = I.compare || {}; const w = C.v2Walk; const R = I.registry || {}; const T = I.track;
  const themes = Object.entries(I.themes || {}).filter(([, t]) => t.weight > 0).sort((a, b) => b[1].weight - a[1].weight);
  const ab = Object.entries(I.ablations || {}).filter(([, r]) => r);
  const v2 = C.v2; const v1 = C.v1;
  const ahead = v2 && v1 ? v2.annNet - v1.annNet : null;
  const chip = ahead == null ? ['ok', 'Not tested yet'] : ahead >= 1 ? ['good', 'Ahead of v1'] : ahead <= -1 ? ['bad', 'Behind v1'] : ['ok', 'About level with v1'];
  return `<h2 class="sec">Edge v2 <small>picks after trading costs · runs next to the original Edge</small></h2>
    <p class="fine">Edge v2 groups the signals into themes and refits their weights every quarter from what already happened. It measures pullbacks on the bid/ask midpoint instead of the last trade, adds Timestral’s forecast and company announcements, and ranks by the expected 3-month gain over the market <b>minus</b> the cost of buying at the ask and selling at the bid. Model as of ${fd(I.fitTo)}.</p>
    ${top.length ? `<div class="tblwrap"><table class="yt pick"><thead><tr><th>#</th><th>Stock</th><th>Expected</th><th>Cost</th><th>Net</th><th>v1 #</th></tr></thead><tbody>
      ${top.map(([s, v]) => `<tr data-sym="${esc(s)}"><td>${v.edge2.rank}</td><td><b>${esc(s)}</b>${held.has(s) ? ' <span class="tag good">held</span>' : ''}</td><td>${signed(v.edge2.exp, 1)}</td><td>${fmt(v.edge2.cost, 1)}%</td><td>${pctCell(v.edge2.net)}</td><td>${v.edge?.rank ?? '—'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="fine">Expected = average 3-month gain over the market for stocks with a similar v2 score in past quarters. Cost = the stock’s usual bid/ask spread plus 0.5% fees each way. Only stocks that trade on at least half of days are ranked.</p>` : ''}
    <div class="sigs">
      ${v2 ? `<div class="sig"><div class="sig-h"><b>v1 vs v2 on the same quarters</b><span class="vchip ${chip[0]}">${chip[1]}</span></div>
        ${compareRows(C)}
        <div class="fine">${fd(v2.from, false)}–${fd(v2.to, false)}, top 10 held 3 months, dividends included. Realistic fills = buy at the closing ask, sell at the closing bid, 0.5% fees each way. Only about ${v2.periods} three-month periods, so a gap of a few points a year can be luck.${w ? ` Over its full walk-forward test (${fd(w.from, false)}–${fd(w.to, false)}) v2 made ${yr(w)} against ${signed(w.annMarket, 1)}/yr for the market.` : ''}</div></div>` : ''}
      ${ab.length && v2 ? `<div class="sig"><div class="sig-h"><b>What each upgrade adds</b></div>
        <div class="tblwrap"><table class="yt"><tbody>
          <tr><td><b>Full Edge v2</b></td><td>${pctCell(v2.annNet)}</td></tr>
          ${ab.map(([k, r]) => `<tr><td>${esc(ABLATION_LABEL[k] || k)}</td><td>${pctCell(r.annNet)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="fine">Each row switches one upgrade off and re-runs the same realistic back-test. If a row beats the full model, that upgrade didn’t help over this period.</div></div>` : ''}
      ${themes.length ? `<div class="sig"><div class="sig-h"><b>What v2 weighs now</b></div>
        <div>${themes.map(([, t]) => `${esc(t.label)} <b>${fmt(t.weight * 100, 0)}%</b>`).join(' · ')}</div>
        <div class="fine">Themes whose signals didn’t rank stocks reliably in past data (overlap-adjusted t below 2) get no weight until they do.</div></div>` : ''}
      ${R.tests ? `<div class="sig"><div class="sig-h"><b>Every test counted</b><span class="vchip ok">${R.passStrict} of ${R.tests} pass</span></div>
        <div>${R.tests} tests have been run on this data. ${R.passLoose} looked like an edge by each study’s own t ≥ 2 rule, and about ${fmt(R.luckExpected, 0)} would pass that by luck alone. ${R.passStrict} pass the stricter bar: ${esc(R.bar)}.</div></div>` : ''}
      ${T ? `<div class="sig"><div class="sig-h"><b>v2 live record — since ${fd(T.since)}</b><span class="vchip ${T.completed ? (T.completed.avgNetExcessTop5 > 0 ? 'good' : 'bad') : 'ok'}">${T.completed ? (T.completed.avgNetExcessTop5 > 0 ? 'Ahead so far' : 'Behind so far') : 'Too early to judge'}</span></div>
        <div>${T.completed ? `${T.completed.n} completed 3-month results: v2 top 5 ${signed(T.completed.avgNetExcessTop5, 1)} pts vs the market after costs.` : `Each night’s v2 top 10 is logged. The first 3-month result lands around <b>${fd(T.firstFullResult)}</b>.`} ${T.daysLogged} night${T.daysLogged === 1 ? '' : 's'} logged.</div>
        <div class="fine">This is the only test nothing has seen in advance. Judge v2 against v1 here after several completed 3-month results.</div></div>` : ''}
    </div>`;
}

export function edge2Block(F, sym) {
  const e = F?.stocks?.[sym]?.edge2; const I = F?.edge2Info; if (!e || !I) return '';
  const th = Object.entries(e.themes || {}).filter(([k]) => (I.themes?.[k]?.weight || 0) > 0).sort((a, b) => b[1] - a[1]);
  const lab = (k) => esc(I.themes?.[k]?.label || k);
  const good = th.filter(([, v]) => v >= 70); const bad = th.filter(([, v]) => v <= 30).reverse();
  return `<h4>Edge v2 · ${e.rank ? `#${e.rank} of ${e.of}` : 'not ranked (trades on fewer than half of days)'} · net ${pctCell(e.net)}</h4>
    <p>Expected 3-month gain over the market <b>${signed(e.exp, 1)}</b>, minus trading cost <b>${fmt(e.cost, 1)}%</b>${e.spread != null ? ` (usual spread ${fmt(e.spread, 1)}% + fees)` : ' (no recent quotes, so a high cost is assumed)'} = <b>${signed(e.net, 1)}</b>.</p>
    ${good.length ? `<p><b>Strong themes:</b> ${good.map(([k, v]) => `${lab(k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}
    ${bad.length ? `<p><b>Weak themes:</b> ${bad.map(([k, v]) => `${lab(k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}
    <p class="fine">Edge v2 runs next to the original Edge score and doesn’t replace it. See the Edge v2 section on the Trade page for how the two compare.</p>`;
}
