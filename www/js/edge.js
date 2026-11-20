// Edge: the app's one stock score and the rule it was tested with (made nightly by scripts/edge_v2.py).
import { fmt, signed, esc, fd } from './util.js';

const ABLATION_LABEL = {
  no_forecast: 'Without the Timestral forecast',
  no_events: 'Without company announcements',
  no_spread: 'Ranked by score, ignoring trading costs',
  last_trade_pullback: 'Pullbacks measured on the last trade, not the quote midpoint',
  equal_theme_weights: 'Every theme weighted the same',
  flat_v1_signals: 'No themes: the old score’s signals refit every quarter',
  with_relative_value: 'Adding “below the price similar companies trade at”',
};
const pctCell = (v) => (v == null ? '—' : `<b class="${v >= 0 ? 'good' : 'bad'}">${signed(v, 1)}</b>`);

export const edgeRule = (F) => F?.edgeInfo?.rule || null;
// "a limit order at J$X (the quote midpoint), good for N trading days" — the tested way to buy
export const limitText = (e, R) => (e?.limit ? `limit order at J$${fmt(e.limit, 2)} (the quote midpoint), good for ${R?.limitDays ?? 5} trading days; if it hasn’t filled, buy at the ask` : 'buy at the ask (no recent quotes to set a limit price)');

function compareRows(C, R) {
  const rows = [
    [`<b>Edge · top ${R.top} · limit orders · keep while top ${R.keep}</b> (what the app tells you to do)`, C.ship],
    [`Same, but buying at the ask and selling at the bid`, C.shipAtQuotes],
    ['Edge · top 10 · ask/bid · re-pick every 3 months', C.top10],
    [`Old Edge score · top ${R.top} · limit orders · keep while top ${R.keep}`, C.oldShip],
    ['Old Edge score · top 10 · ask/bid · re-pick every 3 months', C.old],
    [`The app’s rule without its 3 biggest winners (${(R.best || []).map(esc).join(', ')})`, C.withoutBest],
  ].filter(([, r]) => r);
  return `<div class="tblwrap"><table class="yt"><thead><tr><th>Back-test, same quarters</th><th>Per year</th><th>Market</th><th>Beat it</th></tr></thead><tbody>
    ${rows.map(([l, r]) => `<tr><td>${l}</td><td>${pctCell(r.annNet)}</td><td>${signed(r.annMarket, 1)}</td><td>${r.beatPct}%</td></tr>`).join('')}
  </tbody></table></div>`;
}

export function edgeCard(F) {
  const I = F?.edgeInfo; const R = I?.rule; if (!I || !R) return '';
  const C = I.compare || {}; const Rg = I.registry || {}; const fl = R.fills || {};
  const themes = Object.entries(I.themes || {}).filter(([, t]) => t.weight > 0).sort((a, b) => b[1].weight - a[1].weight);
  const ab = Object.entries(I.ablations || {}).filter(([, r]) => r);
  const s = C.ship; const pre = C.pre2026; const post = C.since2026;
  return `<h2 class="sec">How the Edge score works <small>one score for picks, reviews and alerts</small></h2>
    <p class="fine">Edge groups ${themes.reduce((a, [, t]) => a + t.signals.length, 0)} tested signals into themes, refits their weights every quarter from what already happened, and ranks every stock by its expected 3-month gain over the market <b>minus</b> its trading cost (usual bid/ask spread plus 0.5% fees each way). Only stocks that trade on at least half of days get a rank. Model as of ${fd(I.fitTo)}.</p>
    <div class="sigs">
      ${s ? `<div class="sig"><div class="sig-h"><b>The rule behind the buy list</b><span class="vchip ${s.annNet > s.annMarket ? 'good' : 'bad'}">${signed(s.annNet, 0)}/yr in testing</span></div>
        <div>Buy the Edge <b>top ${R.top}</b> with a <b>limit order at the quote midpoint</b>, good for ${R.limitDays} trading days (if it hasn’t filled, buy at the ask). At each 3-month review keep a holding while it ranks in the <b>top ${R.keep}</b>; sell the rest with a limit at the midpoint and buy what’s new in the top ${R.top}.</div>
        ${compareRows(C, R)}
        <div class="fine">${fd(s.from, false)}–${fd(s.to, false)}, about ${s.periods} three-month periods, dividends included, 0.5% fees each way on top of the price paid. A limit order counts as filled only on a day the stock traded <i>below</i> the limit (above it for a sale), so waiting in a queue never counts; in testing ${fl.withinPct ?? '—'}% filled within ${fl.days ?? R.limitDays} days (${fl.firstDayPct ?? '—'}% on the first day). The rule was picked from ${R.tried} tried on buys made before 2026${pre ? ` (${signed(pre.annNet, 0)}/yr there)` : ''}; 2026 buys were kept out of the choice${post ? ` and made ${signed(post.annNet, 0)}/yr, but that is only ${post.periods} period${post.periods === 1 ? '' : 's'}` : ''}. <b>Read the last row:</b> most of the gain came from a few stocks held a long time, so expect lumpy results, and the real-world number will likely be lower.</div></div>` : ''}
      ${themes.length ? `<div class="sig"><div class="sig-h"><b>What Edge weighs now</b></div>
        <div>${themes.map(([, t]) => `${esc(t.label)} <b>${fmt(t.weight * 100, 0)}%</b>`).join(' · ')}</div>
        <div class="fine">Themes whose signals didn’t rank stocks reliably in past data (overlap-adjusted t below 2) get no weight until they do.</div></div>` : ''}
      ${ab.length && C.top10 ? `<div class="sig"><div class="sig-h"><b>What each part adds</b></div>
        <div class="tblwrap"><table class="yt"><tbody>
          <tr><td><b>Full Edge</b> (top 10, ask/bid)</td><td>${pctCell(C.top10.annNet)}</td></tr>
          ${ab.map(([k, r]) => `<tr><td>${esc(ABLATION_LABEL[k] || k)}</td><td>${pctCell(r.annNet)}</td></tr>`).join('')}
        </tbody></table></div>
        <div class="fine">Each row switches one part off (or adds one) and re-runs the same back-test. If a row beats the full model, that part didn’t help over this period.</div></div>` : ''}
      ${Rg.tests ? `<div class="sig"><div class="sig-h"><b>Every test counted</b><span class="vchip ok">${Rg.passStrict} of ${Rg.tests} pass</span></div>
        <div>${Rg.tests} tests have been run on this data, including every trading rule above. ${Rg.passLoose} looked like an edge by each study’s own t ≥ 2 rule, and about ${fmt(Rg.luckExpected, 0)} would pass that by luck alone. ${Rg.passStrict} pass the stricter bar: ${esc(Rg.bar)}.</div></div>` : ''}
    </div>`;
}

// extra: HTML shown under the score line (the chance-up and +20% lines live in app.js)
export function edgeBlock(F, sym, extra = '') {
  const st = F?.stocks?.[sym]; const e = st?.edge; const I = F?.edgeInfo; if (!e || !I?.rule) return '';   // older nightly files had a different edge shape
  const R = I.rule || {};
  const th = Object.entries(e.themes || {}).filter(([k]) => (I.themes?.[k]?.weight || 0) > 0).sort((a, b) => b[1] - a[1]);
  const lab = (k) => esc(I.themes?.[k]?.label || k);
  const good = th.filter(([, v]) => v >= 70); const bad = th.filter(([, v]) => v <= 30).reverse();
  const where = !e.rank ? 'Not ranked: it trades on fewer than half of days, so it can’t be bought reliably.'
    : e.rank <= (R.top ?? 5) ? `<b>On the buy list.</b> Tested way to buy: ${limitText(e, R)}.`
      : e.rank <= (R.keep ?? 20) ? `Not on the buy list (top ${R.top ?? 5}), but inside the top ${R.keep ?? 20}: if you hold it, keep it at the review.`
        : `Outside the top ${R.keep ?? 20}: if you hold it, sell at the 3-month review.`;
  const cls = e.score >= 80 ? 'good' : e.score >= 40 ? 'ok' : 'bad';
  return `<h4>Edge score · <b class="${cls}">${e.score}/100</b>${e.rank ? ` · #${e.rank} of ${e.of}` : ''}</h4>
    <p>Expected 3-month gain over the market <b>${signed(e.exp, 1)}</b>, minus trading cost <b>${fmt(e.cost, 1)}%</b>${e.spread != null ? ` (usual spread ${fmt(e.spread, 1)}% + fees)` : ' (no recent quotes, so a high cost is assumed)'} = <b>${signed(e.net, 1)}</b>.</p>
    <p class="fine">${where}</p>
    ${extra}
    ${good.length ? `<p><b>Strong:</b> ${good.map(([k, v]) => `${lab(k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}
    ${bad.length ? `<p><b>Weak:</b> ${bad.map(([k, v]) => `${lab(k)} <small class="fine">(better than ${v}%)</small>`).join(' · ')}</p>` : ''}`;
}
