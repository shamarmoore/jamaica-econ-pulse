"""Back-tests of specific trading ideas on the JSE. Each test reports a plain verdict the app can show.
Common rules: information known at the close of day t; buy at the next day's close; returns include dividends;
'excess' = stock return minus the equal-weighted JSE (all ordinary shares that trade at least 20% of days) over the
same days; trade-style ideas pay 1.5% per side (fees + spread); results split into first and second half to check
they hold up. Writes data/idea_tests.json. Usage: python scripts/idea_tests.py"""
import json, sys, warnings
import numpy as np
import pandas as pd
sys.path.insert(0, 'scripts')
sys.argv = sys.argv[:1]
warnings.filterwarnings('ignore')
import factor_study as fs
from tslib import _quarter_events

P, V, R, TRI, idx, N, syms = fs.P, fs.V, fs.R, fs.TRI, fs.idx, fs.N, fs.syms
COST = 0.015
JV = V * P
traded60 = (V > 0).rolling(60).mean()
UNIV = (traded60 >= 0.2) & (P > 0)
MKT_R = R.where(UNIV).mean(axis=1).fillna(0)
MKT = (1 + MKT_R).cumprod()
HALF = idx[len(idx) // 2]
MONTHS = pd.Series(idx.to_period('M'), index=idx)


_BENCH = {}
TRI_NP = TRI.values; UNIV_NP = UNIV.values


def bench(a, b, t0=None):
    """Fair market benchmark: average BUY-AND-HOLD return (dividends included) of every stock in the universe at t0,
    bought at close a and held to close b. (A daily-rebalanced index drifts up on thin stocks' price bounce.)"""
    t0 = a - 1 if t0 is None else t0
    k = (a, b, t0)
    if k not in _BENCH:
        m = UNIV_NP[t0] & (TRI_NP[a] > 0)
        r = np.clip(TRI_NP[b, m] / TRI_NP[a, m] - 1, -0.9, 1.0)
        _BENCH[k] = float(np.nanmean(r)) if len(r) else 0.0
    return _BENCH[k]


def fwd_excess(sym, t, h):
    """Return of buying at close t+1 and holding h trading days, minus the market (buy-and-hold) over the same days."""
    if t + 1 + h >= N:
        return None
    r = TRI[sym].iloc[t + 1 + h] / TRI[sym].iloc[t + 1] - 1
    return float(np.clip(r, -0.9, 1.0) - bench(t + 1, t + 1 + h, t))


def summarize(ex, dates, cost=0.0, label=''):
    """ex: list of excess returns; dates: event dates. Cost is subtracted round-trip. t-stat uses monthly clusters."""
    if len(ex) < 15:
        return {'n': len(ex), 'verdict': 'too few cases to judge'}
    s = pd.Series(np.array(ex) - 2 * cost, index=pd.DatetimeIndex(dates))
    by_m = s.groupby(s.index.to_period('M')).mean()
    t = by_m.mean() / (by_m.std() / np.sqrt(len(by_m))) if len(by_m) > 2 and by_m.std() > 0 else 0
    first, second = s[s.index < HALF], s[s.index >= HALF]
    out = {'n': int(len(s)), 'months': int(len(by_m)), 'avgExcess': round(float(s.mean()) * 100, 2), 'median': round(float(s.median()) * 100, 2),
           'winRate': round(float((s > 0).mean()) * 100), 't': round(float(t), 2),
           'firstHalf': round(float(first.mean()) * 100, 2) if len(first) >= 5 else None, 'secondHalf': round(float(second.mean()) * 100, 2) if len(second) >= 5 else None}
    holds = out['firstHalf'] is not None and out['secondHalf'] is not None and np.sign(out['firstHalf']) == np.sign(out['secondHalf'])
    if abs(t) >= 2 and holds:
        out['verdict'] = 'edge' if s.mean() > 0 else 'negative edge (avoid)'
    elif abs(t) >= 1.5 and holds:
        out['verdict'] = 'weak edge' if s.mean() > 0 else 'weak negative'
    else:
        out['verdict'] = 'no reliable edge'
    return out


RESULTS = {}

# ---------------------------------------------------------------- 1) Intrinsic value
def intrinsic_series():
    """Earnings-power value and dividend-discount value per share vs price → margin of safety (point-in-time)."""
    tb = {}
    try:
        tb = json.load(open('data/macro.json')).get('tbill', {})
    except Exception:
        pass
    rate = pd.Series({pd.Period(k): (v[0] if v[0] is not None else v[1]) for k, v in tb.items() if v[0] is not None or v[1] is not None}, dtype=float) / 100 if tb else None
    r_eq = pd.Series(0.12, index=idx)
    if rate is not None and len(rate):
        rr = rate.reindex(sorted(set(rate.index) | set(idx.to_period('M')))).ffill()
        r_eq = pd.Series([rr.get(p, np.nan) for p in idx.to_period('M')], index=idx).ffill().fillna(0.07) + 0.06  # T-bill + 6% equity premium
    mos_epv = pd.DataFrame(np.nan, index=idx, columns=syms); mos_ddm = mos_epv.copy()
    for s in syms:
        f = fs.FUND.get(s)
        if not f or not f.get('shares'):
            continue
        ev = _quarter_events(f)
        if len(ev) >= 4:
            ser = pd.Series([v for _, v in ev], index=pd.DatetimeIndex([d for d, _ in ev]))
            ser = ser[~ser.index.duplicated(keep='last')]
            norm = ser.rolling(8, min_periods=4).mean() * 4  # normalised annual profit
            nd = norm.reindex(idx.union(norm.index)).ffill().reindex(idx)
            epv = nd * fs.fx[s] / f['shares'] / r_eq
            mos_epv[s] = (epv / P[s] - 1).clip(-1, 3).where(nd > 0)
        d12 = fs.DIV12[s]
        g = 0.03
        ddm = d12 * (1 + g) / (r_eq - g).clip(lower=0.04)
        mos_ddm[s] = (ddm / P[s] - 1).clip(-1, 3).where(d12 > 0)
    return mos_epv, mos_ddm, r_eq


MOS_EPV, MOS_DDM, R_EQ = intrinsic_series()
MOS = pd.concat([MOS_EPV, MOS_DDM]).groupby(level=0).mean()  # average of the two where available


def factor_check(F, name, h=63, step=63):
    """Cross-sectional: top third by F vs market, every `step` days, three start offsets; costs not applied (quarterly)."""
    ex, dts = [], []
    for off in (0, 21, 42):
        for t in range(260 + off, N - h - 1, step):
            live = [s for s in syms if UNIV[s].iloc[t] and pd.notna(F[s].iloc[t])]
            if len(live) < 15:
                continue
            vals = F.iloc[t][live].sort_values(ascending=False)
            top = vals.index[:len(live) // 3]
            for s in top:
                e = fwd_excess(s, t, h)
                if e is not None:
                    ex.append(e); dts.append(idx[t])
    return summarize(ex, dts, 0.0, name)


RESULTS['intrinsic_value'] = {
    'epv': factor_check(MOS_EPV, 'EPV margin of safety'), 'ddm': factor_check(MOS_DDM, 'DDM margin of safety'), 'blend': factor_check(MOS, 'intrinsic blend'),
    'explain': 'Earnings-power value = normalised yearly profit ÷ (T-bill yield + 6% equity premium); dividend-discount value = last-12-month dividends grown 3% ÷ (required return − 3%). Margin of safety = value ÷ price − 1. Top third by margin of safety, held 3 months.'}

# ---------------------------------------------------------------- 2) Post-earnings drift, immediate vs pullback entry
def pead():
    imm21, imm63, pb21, pb63, d_imm, d_pb, weak63, d_weak = [], [], [], [], [], [], [], []
    for s in syms:
        f = fs.FUND.get(s)
        if not f:
            continue
        ev = _quarter_events(f)
        if len(ev) < 6:
            continue
        ser = pd.Series([v for _, v in ev], index=pd.DatetimeIndex([d for d, _ in ev]))
        ser = ser[~ser.index.duplicated(keep='last')]
        yoy = (ser - ser.shift(4)) / ser.shift(4).abs().replace(0, np.nan)
        for d, g in yoy.dropna().items():
            pos = idx.searchsorted(d)
            if pos < 130 or pos + 80 >= N or not UNIV[s].iloc[pos]:
                continue
            strong = g > 0.25 and ser[d] > 0
            weak = g < -0.25
            if strong:
                e1, e3 = fwd_excess(s, pos, 21), fwd_excess(s, pos, 63)
                if e3 is not None:
                    imm21.append(e1); imm63.append(e3); d_imm.append(idx[pos])
                # first pullback: close at least 3% below its 5-day high within 15 trading days
                for k in range(pos + 1, min(pos + 16, N - 70)):
                    hi5 = P[s].iloc[max(pos, k - 5):k + 1].max()
                    if P[s].iloc[k] <= hi5 * 0.97:
                        e1, e3 = fwd_excess(s, k, 21), fwd_excess(s, k, 63)
                        if e3 is not None:
                            pb21.append(e1); pb63.append(e3); d_pb.append(idx[k])
                        break
            elif weak:
                e3 = fwd_excess(s, pos, 63)
                if e3 is not None:
                    weak63.append(e3); d_weak.append(idx[pos])
    return {'strongImmediate21': summarize(imm21, d_imm, COST), 'strongImmediate63': summarize(imm63, d_imm, COST),
            'strongPullback21': summarize(pb21, d_pb, COST), 'strongPullback63': summarize(pb63, d_pb, COST), 'weakResults63': summarize(weak63, d_weak, COST),
            'explain': 'Strong results = latest quarter’s profit up more than 25% on the same quarter last year (and positive). Results are assumed public 45 days after quarter end (90 for year end) because the JSE pages don’t carry release dates. Pullback entry = first close at least 3% below its 5-day high within 15 trading days.'}


RESULTS['post_earnings_drift'] = pead()

# ---------------------------------------------------------------- 3) Support & resistance ranges
def support_resistance(vol_confirm=True):
    ex, dts, hold, hits = [], [], [], 0
    for s in syms:
        p = P[s]; v = V[s]
        for t in range(140, N - 70, 5):
            if not UNIV[s].iloc[t]:
                continue
            w = p.iloc[t - 120:t - 4]
            sup, res = w.min(), w.max()
            if not (sup > 0) or not (0.15 <= res / sup - 1 <= 0.8):
                continue
            # horizontal: no strong trend over the window; at least 3 closes near each edge
            if abs(np.log(w.iloc[-20:].mean() / w.iloc[:20].mean())) > 0.5 * np.log(res / sup):
                continue
            if (w <= sup * 1.04).sum() < 3 or (w >= res * 0.96).sum() < 3:
                continue
            c = p.iloc[t]
            if not (sup <= c <= sup * 1.05 and c > p.iloc[t - 1]):
                continue
            if vol_confirm and not (v.iloc[t] >= 1.5 * v.iloc[t - 20:t].mean() > 0):
                continue
            # trade: buy t+1; sell first close ≥ resistance×0.97, stop below support×0.95, or after 63 days
            entry = TRI[s].iloc[t + 1]; m0 = MKT.iloc[t + 1]
            for k in range(t + 2, min(t + 64, N)):
                if p.iloc[k] >= res * 0.97 or p.iloc[k] < sup * 0.95 or k == min(t + 63, N - 1):
                    r = TRI[s].iloc[k] / entry - 1; m = bench(t + 1, k, t)
                    ex.append(float(np.clip(r, -0.9, 1) - m)); dts.append(idx[t]); hold.append(k - t - 1)
                    hits += p.iloc[k] >= res * 0.97
                    break
    out = summarize(ex, dts, COST)
    out['avgDaysHeld'] = round(float(np.mean(hold)), 1) if hold else None
    out['reachedResistancePct'] = round(hits / len(ex) * 100) if ex else None
    return out


RESULTS['support_resistance'] = {'withVolume': support_resistance(True), 'withoutVolume': support_resistance(False),
                                 'explain': 'Channel = 120-day range 15–80% wide with no strong trend and at least 3 closes near both the floor and the ceiling. Buy when price is within 5% of the floor and closes up (with volume ≥1.5× its 20-day average for the volume version); sell near the ceiling, stop 5% under the floor, or after 3 months.'}

# ---------------------------------------------------------------- 4) Volume-backed breakouts
def breakouts(mult=2.0, need_tight=True):
    ex21, ex63, dts = [], [], []
    last = {}
    for s in syms:
        p = P[s]; v = V[s]
        for t in range(130, N - 70):
            if not UNIV[s].iloc[t] or last.get(s, -99) > t - 20:
                continue
            ceiling = p.iloc[t - 60:t].max()
            if not (p.iloc[t] > ceiling * 1.0):
                continue
            v20 = v.iloc[t - 20:t].mean()
            if not (v20 > 0 and v.iloc[t] >= mult * v20):
                continue
            if need_tight:
                r20 = p.iloc[t - 20:t].max() / p.iloc[t - 20:t].min() - 1
                r120 = p.iloc[t - 120:t].max() / p.iloc[t - 120:t].min() - 1
                if not (r20 < 0.5 * r120 and v20 < v.iloc[t - 80:t - 20].mean()):
                    continue
            e1, e3 = fwd_excess(s, t, 21), fwd_excess(s, t, 63)
            if e3 is None:
                continue
            ex21.append(e1); ex63.append(e3); dts.append(idx[t]); last[s] = t
    return {'hold21': summarize(ex21, dts, COST), 'hold63': summarize(ex63, dts, COST)}


RESULTS['volume_breakout'] = {'tight_2x': breakouts(2.0, True), 'tight_3x': breakouts(3.0, True), 'any_2x': breakouts(2.0, False),
                              'explain': 'Breakout = close above the highest close of the previous 60 days on volume at least 2× (or 3×) the 20-day average. “Tight” also requires the last 20 days’ range to be under half the 120-day range and volume to have dried up beforehand.'}

# ---------------------------------------------------------------- 5) Earnings / dividend timing and month-end flows
def calendar_tests():
    pre, d_pre, post, d_post, exdiv_pre, d_xp, exdiv_post, d_xq = [], [], [], [], [], [], [], []
    for s in syms:
        f = fs.FUND.get(s)
        if not f:
            continue
        for d, _ in _quarter_events(f):
            pos = idx.searchsorted(d)
            if 140 < pos < N - 15 and UNIV[s].iloc[pos - 10]:
                r = TRI[s].iloc[pos] / TRI[s].iloc[pos - 10] - 1; m = bench(pos - 10, pos)
                pre.append(float(r - m)); d_pre.append(idx[pos])
        for dv in f.get('dividends', []):
            try:
                pos = idx.searchsorted(pd.Timestamp(dv['ex']))
            except Exception:
                continue
            if 140 < pos < N - 8 and UNIV[s].iloc[pos - 10]:
                r = TRI[s].iloc[pos - 1] / TRI[s].iloc[pos - 10] - 1; m = bench(pos - 10, pos - 1)
                exdiv_pre.append(float(r - m)); d_xp.append(idx[pos])
                r = TRI[s].iloc[pos + 5] / TRI[s].iloc[pos - 1] - 1; m = bench(pos - 1, pos + 5)
                exdiv_post.append(float(r - m)); d_xq.append(idx[pos])
    # month end: market (buy-and-hold) return over the last 3 trading days of each month vs the first 3 days of the next
    # month vs ordinary 3-day windows. Also a trade test: buy 4 days before month end, sell on the last day (with costs).
    ends = [g.index[-1] for _, g in pd.Series(idx, index=idx).groupby(idx.to_period('M'))]
    endpos = [idx.get_loc(e) for e in ends if 140 < idx.get_loc(e) < N - 4]
    last3 = [bench(e - 3, e) for e in endpos]
    first3 = [bench(e, e + 3) for e in endpos]
    other = [bench(t, t + 3) for t in range(140, N - 4, 3) if all(abs(t - e) > 4 for e in endpos)]
    def tt(a, b):
        a, b = np.array(a), np.array(b); return float((a.mean() - b.mean()) / np.sqrt(a.var() / len(a) + b.var() / len(b)))
    me = {'last3Days': round(float(np.mean(last3)) * 100, 2), 'first3DaysNextMonth': round(float(np.mean(first3)) * 100, 2), 'typical3Days': round(float(np.mean(other)) * 100, 2),
          'tLast3': round(tt(last3, other), 2), 'tFirst3': round(tt(first3, other), 2), 'months': len(endpos)}
    me['verdict'] = ('edge for timing: prices tend to rise into month end' if me['tLast3'] >= 2 else 'no reliable edge') + (' and give some back early next month' if me['tFirst3'] <= -2 else '')
    me['tradeAfterCosts'] = round((float(np.mean(last3)) - 2 * COST) * 100, 2)
    return {'preResults10d': summarize(pre, d_pre, 0.0), 'preExDividend10d': summarize(exdiv_pre, d_xp, 0.0), 'postExDividend5d': summarize(exdiv_post, d_xq, 0.0),
            'monthEnd': me,
            'explain': 'Pre-results = 10 trading days before results are expected to be public (quarter end + 45/90 days). Ex-dividend windows use total return (dividend added back), so a “drop” means a fall beyond the dividend. Month-end = market return on the last 3 trading days of each month vs all other days.'}


RESULTS['calendar'] = calendar_tests()

# ---------------------------------------------------------------- 6) Liquidity / accumulation and zero-volume masking
def liquidity_features():
    mcap = fs.MCAP
    sign = np.sign(R.fillna(0))
    acc = (sign * JV).rolling(20).sum() / mcap  # net value traded on up days minus down days, vs company size
    turn = JV.rolling(20).mean() / mcap
    turn_z = (turn - turn.rolling(120).mean()) / turn.rolling(120).std()
    # zero-volume masking: 12-month momentum measured only on days the stock actually traded
    last_traded = P.where(V > 0).ffill()
    mom_ff = P / P.shift(252) - 1
    mom_mask = last_traded / last_traded.shift(252) - 1
    stale = (V == 0).rolling(20).mean()
    return {'accumulation': factor_check(acc, 'accumulation'), 'turnoverSurge': factor_check(turn_z, 'turnover z'),
            'momentumFilled': factor_check(mom_ff, 'momentum ffill'), 'momentumTradedDaysOnly': factor_check(mom_mask, 'momentum masked'),
            'freshPrices': factor_check(-stale, 'traded recently'),
            'explain': 'Accumulation = J$ value traded on up days minus down days over 20 days ÷ market value (free float isn’t published, so shares outstanding is used). Turnover surge = 20-day J$ turnover ÷ market value vs its own 6-month norm. Masked momentum ignores days with no trades.'}


RESULTS['liquidity'] = liquidity_features()

# ---------------------------------------------------------------- 7) Position sizing for the Edge top 10
def sizing():
    """Top 10 by Edge each quarter; costs charged only on what changes (1.5% per side). Three start dates averaged."""
    study = json.load(open('data/factor_study.json')); chosen = study['h63']['chosen']
    vol63 = R.rolling(63).std()
    variants = ('equal', 'inverseVol', 'scoreWeighted', 'top5equal', 'equalKeepTop20', 'market')
    runs = {k: [] for k in variants}
    for off in (0, 21, 42):
        prev = {k: pd.Series(dtype=float) for k in variants}
        series = {k: [] for k in variants}
        for t in range(260 + off, N - 64, 63):
            live = [s for s in syms if UNIV[s].iloc[t] and traded60[s].iloc[t] >= 0.5]
            if len(live) < 25:
                continue
            f = fs.features(t).loc[live]
            score = sum(fs.z(f[k]) * sgn for k, sgn in chosen.items()).sort_values(ascending=False)
            top = score.index[:10]
            kept = [s for s in prev['equalKeepTop20'].index if s in score.index[:20]]
            keep = (kept + [s for s in top if s not in kept])[:10]
            iv = 1 / vol63.iloc[t][top].clip(lower=0.005); sc = score[top] - score[top].min() + 0.5
            W = {'equal': pd.Series(0.1, index=top), 'inverseVol': iv / iv.sum(), 'scoreWeighted': sc / sc.sum(),
                 'top5equal': pd.Series(0.2, index=top[:5]), 'equalKeepTop20': pd.Series(0.1, index=keep)}
            for k, w in W.items():
                fwd = pd.Series({s: float(np.clip(TRI[s].iloc[t + 64] / TRI[s].iloc[t + 1] - 1, -0.9, 1)) for s in w.index})
                turn = (w.subtract(prev[k], fill_value=0).abs().sum()) / 2 if len(prev[k]) else 1.0
                series[k].append(float((fwd * w).sum()) - 2 * COST * turn)
                prev[k] = w
            series['market'].append(bench(t + 1, t + 64, t))
        for k in variants:
            runs[k].append(np.array(series[k]))
    out = {}
    for k, rs in runs.items():
        ann = np.mean([(np.prod(1 + r) ** (4 / len(r)) - 1) * 100 for r in rs])
        allr = np.concatenate(rs)
        dd = np.mean([(np.cumprod(1 + r) / np.maximum.accumulate(np.cumprod(1 + r)) - 1).min() for r in rs])
        out[k] = {'annReturn': round(float(ann), 1), 'quarterlyVol': round(float(allr.std() * 100), 1), 'returnPerRisk': round(float(allr.mean() / allr.std()), 2),
                  'maxDrawdown': round(float(dd * 100), 1), 'worstQuarter': round(float(allr.min() * 100), 1),
                  'beatMarketPct': None if k == 'market' else round(float(np.mean(np.concatenate([r - m for r, m in zip(rs, runs['market'])]) > 0) * 100))}
    out['explain'] = 'Top 10 by Edge score each quarter among stocks that trade at least half of days; trading costs 1.5% per side, charged only on the part of the portfolio that changes; averaged over three start dates. “Keep while top 20” only sells a holding once it drops out of the top 20.'
    return out


RESULTS['position_sizing'] = sizing()


# ================================================================ Part 2: tests that need index, bid/ask, rates and FX data
import glob, os


def load_detail():
    det = {}
    for f in sorted(glob.glob('data/detail/*.json')):
        det.update(json.load(open(f)))
    return det


DET = load_detail()
MACRO = json.load(open('data/macro.json')) if os.path.exists('data/macro.json') else {}
print('detail days', len(DET), 'fx days', len(MACRO.get('fx', {})), 'tbill months', len(MACRO.get('tbill', {})))

IDXS = pd.DataFrame({d: v.get('i', {}) for d, v in DET.items()}).T if DET else pd.DataFrame()
if len(IDXS):
    IDXS.index = pd.to_datetime(IDXS.index); IDXS = IDXS.sort_index().reindex(idx).ffill()


def sectors():
    """Data-driven sector label: which JSE sector index a stock moves with (a stable property of the company)."""
    out = {}
    if not {'Financial Index', 'Manufacturing & Distribution Index'} <= set(IDXS.columns):
        return out
    fin = IDXS['Financial Index'].pct_change(); md = IDXS['Manufacturing & Distribution Index'].pct_change()
    jr = IDXS['Junior Market Index'].pct_change() if 'Junior Market Index' in IDXS else None
    mn = IDXS['Index'].pct_change() if 'Index' in IDXS else None
    for s in syms:
        r = R[s].where(V[s] > 0)
        m = r.notna() & fin.notna()
        if m.sum() < 80:
            continue
        cf, cm = r[m].corr(fin[m]), r[m].corr(md[m])
        cj = r[m].corr(jr[m]) if jr is not None else -1; cx = r[m].corr(mn[m]) if mn is not None else -1
        out[s] = 'Financial' if cf > max(cm + 0.05, 0.12) else 'Manufacturing & Distribution' if cm > max(cf + 0.05, 0.12) \
            else 'Junior Market' if cj > max(cx + 0.05, 0.1) else 'Other'
    return out


SECTOR = sectors()
SECT_IDX = {'Financial': 'Financial Index', 'Manufacturing & Distribution': 'Manufacturing & Distribution Index', 'Junior Market': 'Junior Market Index', 'Other': 'Index'}

if len(IDXS) and SECTOR:
    # ---------------- sector relative strength
    rs = pd.DataFrame(np.nan, index=idx, columns=syms); rs_flat = rs.copy()
    for s, sec in SECTOR.items():
        col = SECT_IDX.get(sec)
        if col not in IDXS.columns:
            continue
        si = IDXS[col]
        rel = (P[s] / P[s].shift(63) - 1) - (si / si.shift(63) - 1)
        rs[s] = rel
        rs_flat[s] = rel.where((si / si.shift(63) - 1) <= 0.01)
    RESULTS['sector_strength'] = {'relativeStrength': factor_check(rs, 'RS'), 'relativeStrengthWhenSectorFlatOrDown': factor_check(rs_flat, 'RS flat'),
                                  'sectorsFound': {k: int(v) for k, v in pd.Series(SECTOR).value_counts().items()},
                                  'explain': 'Relative strength = stock’s 3-month return minus its sector index (Financial, Manufacturing & Distribution, Junior Market, else the main JSE Index). Sector is assigned by which index the stock moves with most. Top third held 3 months.'}

if DET:
    # ---------------- bid-ask spread tightening
    bid = pd.DataFrame({d: {k: v[0] for k, v in x.get('b', {}).items()} for d, x in DET.items()}).T
    ask = pd.DataFrame({d: {k: v[1] for k, v in x.get('b', {}).items()} for d, x in DET.items()}).T
    for X in (bid, ask):
        X.index = pd.to_datetime(X.index)
    bid = bid.sort_index().reindex(idx).reindex(columns=syms); ask = ask.sort_index().reindex(idx).reindex(columns=syms)
    ok = (bid > 0) & (ask > 0) & (ask >= bid)
    spr = ((ask - bid) / ((ask + bid) / 2)).where(ok)
    z = (spr - spr.rolling(20, min_periods=10).mean()) / spr.rolling(20, min_periods=10).std()
    tight = -z
    ev, dts = [], []
    for s in syms:
        zz = z[s]
        for t in range(140, N - 30):
            if zz.iloc[t] <= -1.5 and P[s].iloc[t] > P[s].iloc[t - 1] and UNIV[s].iloc[t]:
                e = fwd_excess(s, t, 21)
                if e is not None:
                    ev.append(e); dts.append(idx[t])
    RESULTS['bid_ask_spread'] = {'tighterThanUsual_factor': factor_check(tight, 'spread tightening', h=21, step=21), 'suddenTighteningWithUpClose_trade21': summarize(ev, dts, COST),
                                 'coverageDays': int(ok.any(axis=1).sum()),
                                 'explain': 'Spread = (closing ask − closing bid) ÷ mid-price. Z-score compares today’s spread with its own 20-day average; a big negative z means buyers and sellers suddenly agree on price.'}

# ---------------- rates (T-bill) regimes, financial stocks, and stocks-vs-T-bills switching
TB = MACRO.get('tbill', {})
if TB:
    tbm = pd.Series({pd.Period(k): v[0] for k, v in TB.items() if v[0] is not None}).sort_index()
    chg3 = tbm - tbm.shift(3)
    month_end_pos = {p: idx.get_loc(g.index[-1]) for p, g in pd.Series(idx, index=idx).groupby(idx.to_period('M'))}
    rows = []
    for p, e in month_end_pos.items():
        if e < 140 or e + 64 >= N or p not in chg3.index or pd.isna(chg3[p]):
            continue
        mk = bench(e + 1, e + 64, e)
        fin = [s for s, sec in SECTOR.items() if sec == 'Financial' and UNIV[s].iloc[e]]
        jun = [s for s, sec in SECTOR.items() if sec == 'Junior Market' and UNIV[s].iloc[e]]
        fr = np.mean([fwd_excess(s, e, 63) for s in fin]) if fin else np.nan
        jr = np.mean([fwd_excess(s, e, 63) for s in jun]) if jun else np.nan
        rows.append({'p': str(p), 'chg3': float(chg3[p]), 'mkt': mk, 'finEx': fr, 'junEx': jr, 'tb': float(tbm[p])})
    rd = pd.DataFrame(rows)
    rd['regime'] = np.where(rd.chg3 > 0.25, 'rising', np.where(rd.chg3 < -0.25, 'falling', 'steady'))
    reg = {}
    for g, d in rd.groupby('regime'):
        reg[g] = {'months': len(d), 'market3m': round(float(d.mkt.mean()) * 100, 2), 'financialsVsMarket3m': round(float(d.finEx.mean()) * 100, 2) if d.finEx.notna().any() else None,
                  'juniorVsMarket3m': round(float(d.junEx.mean()) * 100, 2) if d.junEx.notna().any() else None}
    corr = float(rd[['chg3', 'mkt']].corr().iloc[0, 1])
    # stocks vs T-bills: hold the market for the next month unless T-bill yields rose >0.25 pts over 3 months
    sw, eq, tbr = [], [], []
    for _, r in rd.iterrows():
        e = month_end_pos[pd.Period(r.p)]
        m1 = bench(e + 1, min(e + 22, N - 1), e)
        tb1 = r.tb / 100 / 12
        eq.append(m1); tbr.append(tb1); sw.append(tb1 if r.regime == 'rising' else m1)
    ann = lambda x: (np.prod(1 + np.array(x)) ** (12 / len(x)) - 1) * 100
    dd = lambda x: float((np.cumprod(1 + np.array(x)) / np.maximum.accumulate(np.cumprod(1 + np.array(x))) - 1).min() * 100)
    # breakouts by rate regime (does a T-bill spike lower the win rate of breakouts?)
    reg_of = {pd.Period(r.p): r.regime for _, r in rd.iterrows()}
    bo = {'rising': [], 'falling': [], 'steady': []}
    for s in syms:
        p_ = P[s]; v_ = V[s]; last = -99
        for t in range(130, N - 70):
            if t - last < 20 or not UNIV[s].iloc[t]:
                continue
            if p_.iloc[t] > p_.iloc[t - 60:t].max() and v_.iloc[t - 20:t].mean() > 0 and v_.iloc[t] >= 2 * v_.iloc[t - 20:t].mean():
                rg = reg_of.get(idx[t].to_period('M') - 1)
                e = fwd_excess(s, t, 63)
                if rg and e is not None:
                    bo[rg].append(e); last = t
    bo_out = {k: {'n': len(v), 'winRate': round(float(np.mean(np.array(v) > 0)) * 100) if v else None, 'avgExcessBeforeCosts': round(float(np.mean(v)) * 100, 2) if v else None} for k, v in bo.items()}
    RESULTS['rates'] = {'byRegime': reg, 'breakoutsByRegime': bo_out, 'corrRateChangeVsNext3mMarket': round(corr, 2), 'monthsTested': len(rd),
                        'stocksVsTbills': {'alwaysStocks': {'ann': round(ann(eq), 1), 'maxDD': round(dd(eq), 1)}, 'alwaysTbills': {'ann': round(ann(tbr), 1), 'maxDD': round(dd(tbr), 1)},
                                           'switchOnRisingYields': {'ann': round(ann(sw), 1), 'maxDD': round(dd(sw), 1)}},
                        'explain': 'Rate regime = change in the 3-month T-bill yield over the previous 3 months (rising > +0.25 pts, falling < −0.25). Financials and Junior Market = average of those stocks vs the whole market over the next 3 months. Switch rule = hold T-bills for the next month when yields are rising, otherwise the market. Few independent periods, so treat as indicative.'}

FXD = MACRO.get('fx', {})
if len(FXD) > 200:
    fxs = pd.Series(FXD); fxs.index = pd.to_datetime(fxs.index); fxs = fxs.sort_index().reindex(idx).ffill()
    f20 = fxs / fxs.shift(20) - 1; f5 = fxs / fxs.shift(5) - 1
    usd_linked = [s for s in syms if any(d.get('cur') == 'USD' for d in (fs.FUND.get(s) or {}).get('dividends', [])) or fs.fx.get(s, 1) != 1]
    rows = []
    for t in range(140, N - 22, 5):
        if pd.isna(f20.iloc[t]):
            continue
        mk = bench(t + 1, t + 22, t)
        ul = [fwd_excess(s, t, 21) for s in usd_linked if UNIV[s].iloc[t]]
        rows.append({'t': t, 'f20': float(f20.iloc[t]), 'f5': float(f5.iloc[t]), 'mkt': mk, 'usdEx': float(np.nanmean([u for u in ul if u is not None])) if ul else np.nan})
    fd_ = pd.DataFrame(rows)
    fd_['regime'] = np.where(fd_.f20 > 0.005, 'J$ weakening fast', np.where(fd_.f20 < -0.005, 'J$ strengthening', 'steady'))
    RESULTS['fx'] = {'byRegime': {g: {'cases': len(d), 'market1m': round(float(d.mkt.mean()) * 100, 2), 'usdLinkedVsMarket1m': round(float(d.usdEx.mean()) * 100, 2) if d.usdEx.notna().any() else None}
                                  for g, d in fd_.groupby('regime')},
                     'corrFx20dVsNextMonthMarket': round(float(fd_[['f20', 'mkt']].corr().iloc[0, 1]), 2), 'usdLinkedStocks': usd_linked[:40],
                     'period': [str(fxs.dropna().index[0].date()), str(idx[-1].date())],
                     'explain': 'USD/JMD 20-day change (daily rates from March 2024). “J$ weakening fast” = more than 0.5% in 20 trading days. USD-linked = stocks quoted in or paying dividends in US dollars.'}

# ---------------------------------------------------------------- insider trades (JSE "Trading in shares" notices)
def insider_tests():
    try:
        import insiders as INS
        EV = INS.events()
    except Exception as e:
        print('insider tests skipped:', e)
        return None
    cats = {k: ([], []) for k in ('buy21', 'buy63', 'directorBuy63', 'connectedBuy63', 'bigBuy63', 'clusterBuy63', 'sell21', 'sell63', 'bigSell63', 'buyback63')}
    last = {}
    recent_buys = {}
    used = 0
    for e in EV:
        s = e['sym']
        if s not in P.columns:
            continue
        t = int(idx.searchsorted(pd.Timestamp(e['date']), side='right')) - 1  # info known by the close of the notice day (most come after 1 pm)
        if t < 130 or t >= N - 2 or not UNIV[s].iloc[t]:
            continue
        used += 1
        px = P[s].iloc[t]; val = (e['shares'] or 0) * px; adv = float(JV[s].iloc[t - 20:t].mean() or 0)
        big = val >= max(1e6, 3 * adv)
        def add(cat, h):
            k = (cat, s)
            if t - last.get(k, -99) < 21:
                return
            r = fwd_excess(s, t, h)
            if r is not None:
                cats[cat][0].append(r); cats[cat][1].append(idx[t]); last[k] = t
        if e['who'] == 'company':
            add('buyback63', 63)
            continue
        if e['side'] == 'buy':
            add('buy21', 21); add('buy63', 63)
            if e['who'] in ('director', 'officer'):
                add('directorBuy63', 63)
            if e['who'] == 'connected':
                add('connectedBuy63', 63)
            if big:
                add('bigBuy63', 63)
            rb = [x for x in recent_buys.get(s, []) if t - x <= 21] + [t]
            recent_buys[s] = rb
            if len(rb) >= 2:
                add('clusterBuy63', 63)
        elif e['side'] == 'sell':
            add('sell21', 21); add('sell63', 63)
            if big:
                add('bigSell63', 63)
    out = {k: summarize(v[0], v[1], COST) for k, v in cats.items()}
    # for someone already holding the stock no trade is needed, so also show the same events without costs
    for k in ('buy63', 'sell63', 'bigSell63'):
        out[k + '_holding'] = summarize(cats[k][0], cats[k][1], 0.0)
    out['eventsParsed'] = len(EV); out['eventsTested'] = used
    out['period'] = [EV[0]['date'], EV[-1]['date']] if EV else None
    out['explain'] = ('Parsed from the JSE’s “Trading in shares” notices (directors, senior officers, connected parties; company buybacks separately). '
                      'Buy at the close of the trading day after the notice (most notices come after the 1 pm close), hold 1 or 3 months, '
                      '1.5% costs each way, compared with the average JSE stock over the same days. Big = at least J$1M and 3× the stock’s normal daily trading. '
                      'Cluster = a second buy notice within a month.')
    return out


_ins = insider_tests()
if _ins:
    RESULTS['insiders'] = _ins

# ---------------------------------------------------------------- corporate events from announcements
def event_tests():
    try:
        import events as EVM
        A = EVM.archive_events()
    except Exception as e:
        print('event tests skipped:', e)
        return None
    def tix(d):
        return int(idx.searchsorted(pd.Timestamp(d), side='right')) - 1   # info known by the close of the notice day
    cats = {k: ([], []) for k in ('capture_high', 'capture_mid', 'capture_low', 'late_high', 'late_mid', 'late_low', 'dividendRaise63', 'dividendCut63', 'dividendSame63',
                                  'dividendConsideration21', 'split21', 'split63', 'raise63', 'takeover63')}
    last = {}
    prev_div = {}
    def add(cat, s, t, r):
        k = (cat, s)
        if r is None or t - last.get(k, -999) < (60 if cat.startswith(('split', 'raise', 'takeover')) else 15):
            return
        cats[cat][0].append(r); cats[cat][1].append(idx[t]); last[k] = t
    for e in A:
        s = e['sym']
        if s not in P.columns:
            continue
        t = tix(e['date'])
        if t < 130 or t >= N - 2 or not UNIV[s].iloc[t]:
            if e['kind'] == 'dividend':
                prev_div.setdefault(s, []).append(e)
            continue
        k = e['kind']
        if k == 'dividend':
            px = P[s].iloc[t]
            fx = 157.0 if e['cur'] == 'USD' else 1.0
            y = e['amt'] * fx / px if px > 0 else None
            if y is not None and y > 0.4 and fx > 1:
                y = e['amt'] / px
            ex = e.get('ex')
            if not ex and e.get('record'):
                ex = (pd.Timestamp(e['record']) - pd.Timedelta(days=1)).strftime('%Y-%m-%d')
            if y and 0 < y < 0.25 and ex and ex > e['date']:
                b = t + 1; xe = int(idx.searchsorted(pd.Timestamp(ex), side='left'))
                if b < xe < N and xe - b <= 45 and P[s].iloc[b] > 0:
                    r = P[s].iloc[xe] / P[s].iloc[b] - 1 + e['amt'] * (fx if y != e['amt'] / px else 1.0) / P[s].iloc[b]
                    r = float(np.clip(r, -0.9, 1.0) - bench(b, xe, t))
                    band = 'high' if y >= 0.03 else 'mid' if y >= 0.015 else 'low'
                    add('capture_' + band, s, t, r)
                    lb = xe - 5  # late buyer: 5 trading days before the ex-date
                    if lb > b and P[s].iloc[lb] > 0:
                        r2 = P[s].iloc[xe] / P[s].iloc[lb] - 1 + e['amt'] * (fx if y != e['amt'] / px else 1.0) / P[s].iloc[lb]
                        add('late_' + band, s, lb, float(np.clip(r2, -0.9, 1.0) - bench(lb, xe, lb - 1)))
            ref = EVM.reference_dividend(prev_div.get(s, []), e)
            if ref:
                ch = e['amt'] / ref - 1
                add('dividendRaise63' if ch >= 0.10 else 'dividendCut63' if ch <= -0.10 else 'dividendSame63', s, t, fwd_excess(s, t, 63))
            prev_div.setdefault(s, []).append(e)
        elif k == 'divcons':
            add('dividendConsideration21', s, t, fwd_excess(s, t, 21))
        elif k == 'split':
            add('split21', s, t, fwd_excess(s, t, 21)); add('split63', s, t, fwd_excess(s, t, 63))
        elif k == 'raise':
            add('raise63', s, t, fwd_excess(s, t, 63))
        elif k == 'takeover':
            add('takeover63', s, t, fwd_excess(s, t, 63))
    out = {}
    for k, (v, d) in cats.items():
        key = k.replace('capture_', '')
        res = summarize(v, d, COST)
        if k.startswith('capture_'):
            out.setdefault('dividendCapture', {})[key] = res
        elif k.startswith('late_'):
            out.setdefault('dividendCaptureLate', {})[k[5:]] = res
        else:
            out[k] = res
    out['dividendCut63_holding'] = summarize(cats['dividendCut63'][0], cats['dividendCut63'][1], 0.0)
    out['explain'] = ('Parsed from the JSE’s dividend, split, take-over and rights-issue notices since 2018. Dividend capture: buy at the close after the declaration, '
                      'sell at the close on the ex-date, dividend included; yield bands high ≥3%, mid 1.5–3%, low <1.5% of the price. Raises/cuts compare the new dividend with the '
                      'same payment a year earlier (±10%, adjusted for share splits). All results after 1.5% costs each way, compared with the average JSE stock over the same days.')
    return out


_ev = event_tests()
if _ev:
    RESULTS['events'] = _ev


# ---------------------------------------------------------------- quiet setups, chart indicators, turnarounds, cheap small caps
def _sched(h=63, step=63):
    for off in (0, 21, 42):
        for t in range(260 + off, N - h - 1, step):
            yield t


def quiet_setups():
    """Strong fundamentals whose price hasn't moved yet vs strong fundamentals already moving."""
    cols = ['ey', 'dy', 'growth', 'q_yoy', 'stable', 'noloss', 'iv_ddm']
    G = {k: ([], []) for k in ('fundTop', 'quiet', 'quietDeep', 'moving', 'nearHigh')}
    for t in _sched():
        f = fs.features(t)
        live = [s for s in syms if UNIV[s].iloc[t]]
        ff = f.loc[live]
        ok = ff[cols].notna().sum(axis=1) >= 4
        fund = ff[cols].rank(pct=True).mean(axis=1)[ok].sort_values(ascending=False)
        top = fund.index[:max(1, len(live) // 3)]
        med = ff['mom63'].median()
        for s in top:
            e = fwd_excess(s, t, 63)
            if e is None:
                continue
            m, hi = ff.loc[s, 'mom63'], ff.loc[s, 'hi52']
            G['fundTop'][0].append(e); G['fundTop'][1].append(idx[t])
            if m <= med and hi < 0.9:
                G['quiet'][0].append(e); G['quiet'][1].append(idx[t])
            if m <= med and hi < 0.75:
                G['quietDeep'][0].append(e); G['quietDeep'][1].append(idx[t])
            if m > med:
                G['moving'][0].append(e); G['moving'][1].append(idx[t])
            if hi >= 0.9:
                G['nearHigh'][0].append(e); G['nearHigh'][1].append(idx[t])
    out = {k: summarize(v[0], v[1], 0.0) for k, v in G.items()}
    # fresh strong results where the price did / didn't run up in the month before they became public
    C = {k: ([], []) for k in ('strongResultsQuiet63', 'strongResultsRanUp63', 'backToProfit63', 'backToProfit126')}
    for s in syms:
        f = fs.FUND.get(s)
        if not f:
            continue
        ev = _quarter_events(f)
        if len(ev) < 6:
            continue
        ser = pd.Series([v for _, v in ev], index=pd.DatetimeIndex([d for d, _ in ev]))
        ser = ser[~ser.index.duplicated(keep='last')]
        yoy = (ser - ser.shift(4)) / ser.shift(4).abs().replace(0, np.nan)
        prev = ser.shift(1)
        for d in ser.index[4:]:
            pos = idx.searchsorted(d)
            if pos < 130 or pos + 130 >= N or not UNIV[s].iloc[pos]:
                continue
            g = yoy.get(d)
            if pd.notna(g) and g > 0.25 and ser[d] > 0:
                run = P[s].iloc[pos] / P[s].iloc[pos - 21] - 1
                e = fwd_excess(s, pos, 63)
                if e is not None:
                    k = 'strongResultsQuiet63' if run <= 0.02 else 'strongResultsRanUp63' if run > 0.05 else None
                    if k:
                        C[k][0].append(e); C[k][1].append(idx[pos])
            if ser[d] > 0 and pd.notna(prev.get(d)) and prev[d] < 0:  # turnaround: a loss-making quarter followed by a profit
                for h, k in ((63, 'backToProfit63'), (126, 'backToProfit126')):
                    e = fwd_excess(s, pos, h)
                    if e is not None:
                        C[k][0].append(e); C[k][1].append(idx[pos])
    out.update({k: summarize(v[0], v[1], COST) for k, v in C.items()})
    out['explain'] = ('“Strong fundamentals” = top third of stocks on the Edge score’s non-price signals (cheap vs profits, dividend yield, profit growth, steady profits, no losses, below dividend value). '
                      'Quiet = 3-month price change at or below the typical stock and more than 10% under its 52-week high; moving = 3-month change above the typical stock. '
                      'Held 3 months vs the average JSE stock. Results-based rows pay 1.5% costs each way; “ran up” = price rose more than 5% in the month before the results.')
    return out


def chart_indicators():
    d = P.diff()
    up = d.clip(lower=0).rolling(14).mean(); dn = (-d.clip(upper=0)).rolling(14).mean()
    rsi = 100 - 100 / (1 + up / dn.replace(0, np.nan))
    ma20, sd20 = P.rolling(20).mean(), P.rolling(20).std()
    z = (P - ma20) / sd20.replace(0, np.nan)
    ma50, ma200 = P.rolling(50).mean(), P.rolling(200).mean()
    obv = (np.sign(d).fillna(0) * V).cumsum()
    obv_s = (obv - obv.shift(63)) / (V.rolling(63).sum() + 1)
    vwap = (P * V).rolling(20).sum() / V.rolling(20).sum().replace(0, np.nan)
    roc = P / P.shift(63) - 1
    out = {
        'rsiOversold21': factor_check(-rsi, 'RSI oversold', 21, 21),
        'rsiStrong63': factor_check(rsi, 'RSI strong', 63, 63),
        'bollingerLow21': factor_check(-z, 'below Bollinger band', 21, 21),
        'goldenCross63': factor_check(ma50 / ma200 - 1, '50-day above 200-day average'),
        'above50dma63': factor_check(P / ma50 - 1, 'price above 50-day average'),
        'roc63': factor_check(roc, '3-month rate of change'),
        'obv63': factor_check(obv_s, 'on-balance volume rising'),
        'belowVwap21': factor_check(-(P / vwap - 1), 'below 20-day VWAP', 21, 21),
        'explain': 'Each indicator ranks all stocks; the top third is held 1 or 3 months (as labelled) against the average JSE stock, before costs. Monthly ideas would pay about 3 points in costs per round trip on top.'}
    return out


def strategy_tests():
    EY = (fs.FF['ttm'] * fs.fx / fs.MCAP).clip(-0.5, 0.5)
    small = fs.MCAP.rank(axis=1, pct=True) <= 0.5
    DY = (fs.DIV12 / P).clip(0, 0.4).where(fs.FF['lossq'] == 0)
    out = {'cheapSmallCaps63': factor_check(EY.where(small & (EY > 0)), 'cheap small caps'),
           'cheapLargeCaps63': factor_check(EY.where(~small & (EY > 0)), 'cheap large caps')}
    lull = MKT.pct_change(126).abs() < 0.05
    G = {'lull': ([], []), 'trending': ([], [])}
    for t in _sched():
        live = [s for s in syms if UNIV[s].iloc[t] and pd.notna(DY[s].iloc[t]) and DY[s].iloc[t] > 0]
        if len(live) < 9:
            continue
        top = DY.iloc[t][live].sort_values(ascending=False).index[:len(live) // 3]
        k = 'lull' if bool(lull.iloc[t]) else 'trending'
        for s in top:
            e = fwd_excess(s, t, 63)
            if e is not None:
                G[k][0].append(e); G[k][1].append(idx[t])
    out['dividendPayersInLull63'] = summarize(G['lull'][0], G['lull'][1], 0.0)
    out['dividendPayersWhenTrending63'] = summarize(G['trending'][0], G['trending'][1], 0.0)
    out['explain'] = ('Cheap = profit ÷ market value, profitable firms only; small = smaller half of the market by value. Dividend payers = top third by yield with no loss-making quarter in the last year; '
                      'a lull = the market moved less than 5% over the previous 6 months. Book value, debt and cash-flow figures aren’t published in a machine-readable form on the JSE site, '
                      'so price-to-book, ROE, leverage and accrual tests need the balance sheets read out of the PDF reports first.')
    return out


def balance_sheet_tests():
    import balance
    R_ = balance.readings()
    out = {'readings': len(R_), 'companies': len({r['sym'] for r in R_}), 'from': min((r['pub'] for r in R_), default=None)}
    # the tests only mean something once the back-catalogue is read (several years of reports, not a few months)
    out['complete'] = bool(len(R_) >= 900 and out['from'] and out['from'] <= '2022-12-31')
    names = {'bp': 'cheap vs book value', 'roe': 'return on equity', 'lowdebt': 'little debt', 'netcash': 'net cash', 'cashq': 'profit backed by cash',
             'ocfy': 'operating cash yield', 'fcfy': 'free cash flow yield', 'margin': 'profit margin', 'eq_assets': 'funded by shareholders'}
    for k, v in fs.BS.items():
        out[k] = factor_check(v, names.get(k, k))
    out['explain'] = ('Figures are read from each company’s PDF reports by an AI model, kept only when the balance sheet adds up and the profit agrees with the JSE’s own figure, '
                      'and used only from the day the report was published. Each row holds the top third of stocks on that measure for 3 months against the average JSE stock. '
                      'Debt and cash measures leave out banks, insurers and investment firms, where they mean something different.')
    return out


for _k, _fn in (('setups', quiet_setups), ('chart', chart_indicators), ('strategies', strategy_tests), ('balance_sheet', balance_sheet_tests)):
    try:
        RESULTS[_k] = _fn()
    except Exception as _e:
        print(_k, 'tests skipped:', repr(_e)[:200])

json.dump(RESULTS, open('data/idea_tests.json', 'w'), indent=1, default=float)
for k, v in RESULTS.items():
    print('\n==', k)
    for kk, vv in v.items():
        if kk != 'explain':
            print('  ', kk, json.dumps(vv))
