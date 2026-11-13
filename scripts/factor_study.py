"""Which signals give a realistic edge on the JSE? Cross-sectional test of many candidate stock features.
Rules that keep it honest:
 - only information available at the close of day t (company results count from each company's usual reporting delay — default 60 days after quarter end, at least 90 for year end — using its real financial year-end)
 - buy at the NEXT day's close, hold 21 trading days (also 63), returns include dividends
 - preference shares excluded; stock must have traded on at least 20% of the last 60 days
 - first half of the period is used to choose signals; the second half is the out-of-sample check
Writes data/factor_study.json. Usage: python scripts/factor_study.py"""
import json, sys, warnings
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
sys.path.insert(0, 'scripts')
from tslib import load_history, load_fundamentals, _quarter_events, is_pref, FX_TO_JMD, fx_rate
warnings.filterwarnings('ignore')

close, vol = load_history()
FUND = load_fundamentals()
idx = close.index; N = len(idx)
syms = [s for s in close.columns if not is_pref(s)]
P = close[syms].ffill()
V = vol[syms].fillna(0)
first = close[syms].apply(lambda s: s.first_valid_index())

# ---- total-return index (dividends added back on the ex-date) ----
D = pd.DataFrame(0.0, index=idx, columns=syms)
FXR = {s: fx_rate(FUND.get(s), P[s]) for s in syms}
for s in syms:
    for d in (FUND.get(s) or {}).get('dividends', []):
        try:
            t = pd.Timestamp(d['ex'])
        except Exception:
            continue
        pos = idx.searchsorted(t)
        if 0 < pos < N:
            D.iat[pos, syms.index(s)] += d['amt'] * (FXR[s] if d['cur'] != 'JMD' else 1.0)
R = ((P + D) / P.shift(1) - 1).where(P.shift(1) > 0)
R = R.clip(-0.6, 1.5)  # guard against bad prints
TRI = (1 + R.fillna(0)).cumprod()

# ---- fundamentals as daily point-in-time series ----
def fund_frames():
    out = {k: pd.DataFrame(np.nan, index=idx, columns=syms) for k in
           ['ttm', 'ttm_prev', 'q_yoy', 'q_yoy_prev', 'cv8', 'lossq', 'days_since', 'div_years']}
    for s in syms:
        f = FUND.get(s)
        if not f:
            continue
        ev = _quarter_events(f)
        if len(ev) < 4:
            continue
        dates = pd.DatetimeIndex([d for d, _ in ev]); vals = np.array([v for _, v in ev])
        ser = pd.Series(vals, index=dates); ser = ser[~ser.index.duplicated(keep='last')]
        ttm = ser.rolling(4).sum(); prev = ttm.shift(4)
        yoy = (ser - ser.shift(4)) / ser.shift(4).abs().replace(0, np.nan)
        cv = ser.rolling(8).std() / ser.rolling(8).mean().abs().replace(0, np.nan)
        loss = (ser < 0).astype(float).rolling(4).sum()
        known = pd.Series(ser.index, index=ser.index)
        for k, x in [('ttm', ttm), ('ttm_prev', prev), ('q_yoy', yoy.clip(-3, 5)), ('q_yoy_prev', yoy.shift(1).clip(-3, 5)), ('cv8', cv.clip(0, 5)), ('lossq', loss)]:
            out[k][s] = x.reindex(idx.union(x.index)).ffill().reindex(idx)
        ks = known.reindex(idx.union(known.index)).ffill().reindex(idx)
        out['days_since'][s] = (idx.to_series() - ks).dt.days.values
        divs = [pd.Timestamp(d['ex']) for d in f.get('dividends', []) if d.get('ex')]
        if divs:
            ds = pd.Series(1.0, index=pd.DatetimeIndex(divs)).groupby(level=0).sum()
            daily = ds.reindex(idx.union(ds.index)).fillna(0)
            y1 = daily.rolling('365D').sum().reindex(idx) > 0
            y2 = (daily.rolling('730D').sum().reindex(idx) - daily.rolling('365D').sum().reindex(idx)) > 0
            out['div_years'][s] = y1.astype(float) + y2.astype(float)
        else:
            out['div_years'][s] = 0.0
    return out
FF = fund_frames()
shares = pd.Series({s: (FUND.get(s) or {}).get('shares') for s in syms}, dtype=float)
fx = pd.Series(FXR)
MCAP = P * shares
DIV12 = D.rolling(252, min_periods=1).sum()
JVAL = V * P

# ---- intrinsic value (point-in-time): earnings-power value and dividend-discount value vs price ----
def _required_return():
    try:
        tb = json.load(open('data/macro.json')).get('tbill', {})
    except Exception:
        tb = {}
    per = {pd.Period(k): (v[0] if v[0] is not None else v[1]) for k, v in tb.items() if (v[0] is not None or v[1] is not None)}
    if not per:
        return pd.Series(0.12, index=idx)
    s_ = pd.Series(per).sort_index() / 100
    vals = [s_[s_.index <= p].iloc[-1] if (s_.index <= p).any() else s_.iloc[0] for p in idx.to_period('M')]
    return pd.Series(vals, index=idx) + 0.06   # T-bill + 6% equity risk premium


R_EQ = _required_return()
NORM_E = pd.DataFrame(np.nan, index=idx, columns=syms)
for _s in syms:
    _f = FUND.get(_s)
    if not _f:
        continue
    _ev = _quarter_events(_f)
    if len(_ev) >= 4:
        _ser = pd.Series([v for _, v in _ev], index=pd.DatetimeIndex([d for d, _ in _ev]))
        _ser = _ser[~_ser.index.duplicated(keep='last')]
        _n = _ser.rolling(8, min_periods=4).mean() * 4
        NORM_E[_s] = _n.reindex(idx.union(_n.index)).ffill().reindex(idx)
EPV_PS = NORM_E.mul(fx, axis=1).div(shares, axis=1).div(R_EQ, axis=0)
MOS_EPV = (EPV_PS / P - 1).clip(-1, 3).where(NORM_E > 0)
DDM_PS = DIV12.mul(1.03).div((R_EQ - 0.03).clip(lower=0.04), axis=0)
MOS_DDM = (DDM_PS / P - 1).clip(-1, 3).where(DIV12 > 0)
_TURN = JVAL.rolling(20).mean() / MCAP
TURN_Z = (_TURN - _TURN.rolling(120).mean()) / _TURN.rolling(120).std()


def features(t):
    """All candidate features for each stock at day index t (information up to and including t)."""
    p = P.iloc[t]
    r = R.iloc[max(0, t - 252):t + 1]
    f = pd.DataFrame(index=syms)
    ret = lambda a, b=0: P.iloc[t - b] / P.iloc[t - a] - 1
    f['rev5'] = -ret(5); f['rev21'] = -ret(21)
    f['mom63'] = ret(63); f['mom126'] = ret(126); f['mom12_1'] = ret(252, 21) if t >= 252 else np.nan
    f['hi52'] = p / P.iloc[max(0, t - 252):t + 1].max()
    f['lowvol'] = -r.iloc[-63:].std()
    f['lottery'] = -r.iloc[-21:].max()
    jv = JVAL.iloc[t - 59:t + 1]
    f['illiq'] = (r.iloc[-60:].abs() / jv.replace(0, np.nan)).mean() * 1e6
    f['traded'] = (V.iloc[t - 59:t + 1] > 0).mean()
    f['turnover'] = jv.iloc[-21:].mean() / MCAP.iloc[t]
    f['volsurge'] = V.iloc[t - 4:t + 1].mean() / V.iloc[t - 64:t - 4].replace(0, np.nan).median()
    f['small'] = -np.log(MCAP.iloc[t])
    f['ey'] = (FF['ttm'].iloc[t] * fx / MCAP.iloc[t]).clip(-0.5, 0.5)
    f['dy'] = (DIV12.iloc[t] / p).clip(0, 0.4)
    f['growth'] = ((FF['ttm'].iloc[t] - FF['ttm_prev'].iloc[t]) / FF['ttm_prev'].iloc[t].abs().replace(0, np.nan)).clip(-1, 2)
    f['q_yoy'] = FF['q_yoy'].iloc[t]
    f['accel'] = FF['q_yoy'].iloc[t] - FF['q_yoy_prev'].iloc[t]
    f['stable'] = -FF['cv8'].iloc[t]
    f['noloss'] = -FF['lossq'].iloc[t]
    f['divpayer'] = FF['div_years'].iloc[t]
    # post-results drift: strong latest quarter that became public in the last ~40 days
    f['fresh_beat'] = np.where(FF['days_since'].iloc[t] <= 40, FF['q_yoy'].iloc[t], np.nan)
    f['bm_proxy_pe_low'] = np.where(f['ey'] > 0, f['ey'], np.nan)  # value among profitable firms only
    f['iv_epv'] = MOS_EPV.iloc[t]                 # margin of safety vs earnings-power value
    f['iv_ddm'] = MOS_DDM.iloc[t]                 # margin of safety vs dividend-discount value
    f['turn_surge'] = TURN_Z.iloc[t]              # turnover vs its own 6-month norm
    # recently reported weak results (profit down >25% on the year, public within ~63 days) → negative signal
    f['no_weak_results'] = -np.where((FF['days_since'].iloc[t] <= 63) & (FF['q_yoy'].iloc[t] < -0.25), 1.0, 0.0)
    for k, v in BS.items():   # book value, return on equity, debt, cash-backed profit, cash yields, margin
        f['bs_' + k] = v.iloc[t]
    return f

# balance-sheet features read from the PDF reports (empty until scripts/read_reports.py has run)
try:
    import types, balance
    BS = balance.frames(types.SimpleNamespace(idx=idx, syms=syms, fx=fx, MCAP=MCAP, FUND=FUND))
except Exception as _e:
    print('balance-sheet features skipped:', repr(_e)[:120]); BS = {}

FEATS = None
def run(hold, step, offset=0):
    rows = []
    for t in range(260 + offset, N - hold - 1, step):
        live = [s for s in syms if first[s] is not None and idx.get_loc(first[s]) <= t - 130 and P[s].iloc[t] > 0 and (V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2]
        if len(live) < 20:
            continue
        f = features(t).loc[live]
        fwd = TRI[live].iloc[t + 1 + hold] / TRI[live].iloc[t + 1] - 1  # buy next day's close
        f['fwd'] = fwd.values; f['t'] = t; f['date'] = idx[t]; f['sym'] = live; f['off'] = offset
        rows.append(f)
    return pd.concat(rows)

def ic_table(df, feats):
    out = {}
    dates = sorted(df.t.unique()); half = dates[len(dates) // 2]
    for k in feats:
        res = {}
        for name, d in [('all', df), ('first', df[df.t < half]), ('second', df[df.t >= half])]:
            ics, spread = [], []
            for _, g in d.groupby('t'):
                g = g[[k, 'fwd']].dropna()
                if len(g) < 15 or g[k].nunique() < 5:
                    continue
                ics.append(spearmanr(g[k], g.fwd).correlation)
                n3 = len(g) // 3
                spread.append(g.nlargest(n3, k).fwd.mean() - g.fwd.mean())
            if len(ics) < 5:
                res[name] = None; continue
            ics = np.array(ics); spread = np.array(spread)
            res[name] = {'ic': round(float(np.nanmean(ics)), 3), 't': round(float(np.nanmean(ics) / (np.nanstd(ics) / np.sqrt(len(ics)))), 2),
                         'top3': round(float(np.nanmean(spread)) * 100, 2), 'hit': round(float((spread > 0).mean()) * 100), 'n': len(ics)}
        out[k] = res
    return out, half

def z(x):
    x = x.rank(pct=True)
    return (x - 0.5).fillna(0)

def _portfolio_one(df, score, top, cost, min_traded):
    held = set(); rets = []; mkt = []; tops = []; turns = []
    for t, g in df.groupby('t'):
        g = g[g.traded >= min_traded].dropna(subset=['fwd'])
        if len(g) < top * 2:
            continue
        pick = g.nlargest(top, score)
        new = set(pick.sym)
        turn = len(new - held) / top if held else 1.0
        held = new; turns.append(turn)
        rets.append(pick.fwd.clip(upper=1.0).mean() - 2 * cost * turn); mkt.append(g.fwd.clip(upper=1.0).mean()); tops.append(min(1.0, g.nlargest(1, score).fwd.iloc[0]))
    return np.array(rets), np.array(mkt), np.array(tops), np.array(turns)


def portfolio(df, score, top=10, cost=0.01, min_traded=0.5):
    """Equal-weight top-N by score, rebalanced every holding period (non-overlapping). Each start offset is its own
    sequence; results are averaged across offsets. cost = per-side cost (fees + spread) charged on turnover."""
    per_year = 252 / HOLD
    ann = lambda x: (np.prod(1 + x) ** (per_year / len(x)) - 1) * 100
    outs = []
    for off, d in df.groupby('off'):
        r, m, tp, tn = _portfolio_one(d, score, top, cost, min_traded)
        if len(r) >= 3:
            outs.append((ann(r), ann(m), (r > m).mean(), r.min(), (tp > m).mean(), np.median(tp), tn[1:].mean() if len(tn) > 1 else 1, len(r), ann(tp)))
    o = np.array(outs)
    return {'periodsPerRun': int(o[:, 7].mean()), 'runs': len(o), 'annNet': round(float(o[:, 0].mean()), 1), 'annMarket': round(float(o[:, 1].mean()), 1),
            'beatPct': round(float(o[:, 2].mean() * 100)), 'worstPeriod': round(float(o[:, 3].min() * 100), 1), 'turnover': round(float(o[:, 6].mean() * 100)),
            'singlePickBeatPct': round(float(o[:, 4].mean() * 100)), 'singlePickMedian': round(float(o[:, 5].mean() * 100), 1), 'singlePickAnn': round(float(o[:, 8].mean()), 1)}

FEATURE_LABELS = {
    'rev5': 'Pulled back in the last week', 'rev21': 'Pulled back in the last month', 'mom12_1': '12-month price trend', 'mom63': '3-month trend', 'mom126': '6-month trend',
    'hi52': 'Close to its 52-week high', 'lowvol': 'Steady price (low volatility)', 'lottery': 'No wild one-day spikes', 'illiq': 'Easy to trade (liquid)',
    'traded': 'Trades most days', 'turnover': 'Active trading vs its size', 'volsurge': 'Trading volume picking up', 'small': 'Larger company',
    'ey': 'Cheap relative to profits', 'dy': 'Dividend yield', 'growth': 'Profit growing (12 months)', 'q_yoy': 'Latest quarter beat last year',
    'accel': 'Profit growth speeding up', 'stable': 'Steady profits', 'noloss': 'No recent loss-making quarters', 'divpayer': 'Pays dividends regularly',
    'fresh_beat': 'Fresh strong results (last ~40 days)', 'iv_epv': 'Below earnings-power value', 'iv_ddm': 'Below dividend-discount value',
    'turn_surge': 'Turnover rising vs its norm', 'no_weak_results': 'No weak results just reported',
    'bs_bp': 'Cheap relative to book value', 'bs_roe': 'High return on shareholders’ funds', 'bs_lowdebt': 'Little debt', 'bs_netcash': 'Net cash on the balance sheet', 'bs_cashq': 'Profit backed by cash', 'bs_ocfy': 'Operating cash yield', 'bs_fcfy': 'Free cash flow yield', 'bs_margin': 'High profit margin', 'bs_eq_assets': 'Funded mostly by shareholders'}


def edge_today(chosen):
    """Edge score (0–100 percentile) for every live stock on the latest day, plus each signal's percentile."""
    t = N - 1
    live = [s for s in syms if first[s] is not None and idx.get_loc(first[s]) <= t - 130 and P[s].iloc[t] > 0 and (V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2]
    f = features(t).loc[live]
    pct = pd.DataFrame({k: (f[k] * sgn).rank(pct=True) for k, sgn in chosen.items()})
    blend = sum(z(f[k]) * sgn for k, sgn in chosen.items())
    score = blend.rank(pct=True) * 100
    out = {}
    for s in live:
        sig = {k: round(float(pct.at[s, k]) * 100) for k in chosen if pd.notna(f.at[s, k])}
        out[s] = {'score': round(float(score[s])), 'rank': int((score > score[s]).sum()) + 1, 'of': len(live), 'signals': sig}
    return out


if __name__ == '__main__':
    report = {'period': [str(idx[260].date()), str(idx[-1].date())], 'basis': 'next-day entry, dividends included, prefs excluded, traded ≥20% of days'}
    for HOLD in (21, 63):
        df = pd.concat([run(HOLD, HOLD, off) for off in ([0, 7, 14] if HOLD == 21 else [0, 21, 42])])
        feats = [c for c in df.columns if c not in ('fwd', 't', 'date', 'sym', 'off')]
        tab, half = ic_table(df, feats)
        report[f'h{HOLD}'] = {'features': tab, 'split': str(idx[half].date())}
        print(f'\n=== hold {HOLD} days · {df.t.nunique()} rebalances · split {idx[half].date()} ===')
        print(f"{'feature':16s} {'IC all':>7s} {'t':>6s} {'top3%':>6s} {'hit%':>5s} | {'IC 1st':>7s} {'t':>6s} | {'IC 2nd':>7s} {'t':>6s} {'top3%':>6s}")
        for k, v in sorted(tab.items(), key=lambda kv: -(kv[1]['all'] or {}).get('t', -99) if kv[1]['all'] else 99):
            a, f1, f2 = v['all'], v['first'], v['second']
            if not a:
                continue
            print(f"{k:16s} {a['ic']:7.3f} {a['t']:6.2f} {a['top3']:6.2f} {a['hit']:5d} | {(f1 or {}).get('ic', np.nan):7.3f} {(f1 or {}).get('t', np.nan):6.2f} | {(f2 or {}).get('ic', np.nan):7.3f} {(f2 or {}).get('t', np.nan):6.2f} {(f2 or {}).get('top3', np.nan):6.2f}")
        # choose signals on the FIRST half only: |t| ≥ 2 there, use its sign; test the blend on the SECOND half
        chosen = {k: np.sign(v['first']['ic']) for k, v in tab.items() if v['first'] and abs(v['first']['t']) >= 2 and k not in ('bm_proxy_pe_low',)}
        df['edge'] = sum(df.groupby('t')[k].transform(lambda x: z(x)) * sgn for k, sgn in chosen.items()) if chosen else 0
        df['health_like'] = df.groupby('t')['ey'].transform(z) + 0.6 * df.groupby('t')['growth'].transform(z) + 0.4 * df.groupby('t')['dy'].transform(z) + 0.5 * df.groupby('t')['noloss'].transform(z)
        df['mkt'] = 0.0
        oos = df[df.t >= half]
        report[f'h{HOLD}']['chosen'] = {k: int(v) for k, v in chosen.items()}
        res = {}
        for name in ('edge', 'health_like'):
            ics = [spearmanr(g[name], g.fwd).correlation for _, g in oos.groupby('t') if len(g) > 15]
            res[name] = {'oosIC': round(float(np.nanmean(ics)), 3), 'oosT': round(float(np.nanmean(ics) / (np.nanstd(ics) / np.sqrt(len(ics)))), 2),
                         'portfolio_oos_cost1pct': portfolio(oos, name, 10, 0.01), 'portfolio_oos_cost2pct': portfolio(oos, name, 10, 0.02),
                         'portfolio_all_cost1pct': portfolio(df, name, 10, 0.01)}
        report[f'h{HOLD}']['blends'] = res
        if HOLD == 63:
            report['top5'] = {'all': portfolio(df, 'edge', 5, 0.015), 'oos': portfolio(oos, 'edge', 5, 0.015), 'cost': 0.015}
            df['yr'] = pd.to_datetime(df.date).dt.year
            report['byYear'] = {int(y): round(float(np.mean([gg[gg.traded >= 0.5].nlargest(10, 'edge').fwd.clip(upper=1).mean() - gg.fwd.clip(upper=1).mean()
                                                              for _, gg in g.groupby('t') if len(gg) > 30])) * 100, 1) for y, g in df.groupby('yr')}
        print('chosen on first half:', chosen)
        print(json.dumps(res, indent=1))
    json.dump(report, open('data/factor_study.json', 'w'), indent=1, default=float)
