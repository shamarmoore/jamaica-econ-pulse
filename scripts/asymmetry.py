"""Upside vs downside: which stocks have historically given lopsided results in your favour?

For every month-end-ish date, every stock is ranked by the Edge score using only what was known that day, bought at the
next day's close and held 6 months (dividends included, 1.5% costs each side). We then count how often stocks in each
Edge-rank band ended +25% or better ("big win") against −15% or worse ("big loss"), and the same for groups people
usually expect to be lopsided (volatile, lottery-like, beaten-down, small). The Edge signals were chosen on the first
half of history only, so the second half is the honest check. Used by idea_tests.py (→ data/idea_tests.json) and
forecast.py (per-stock odds)."""
import json
import numpy as np
import pandas as pd

H = 126
WIN, LOSS = 0.25, -0.15
COST = 0.015
BANDS = [('1-5', 1, 5), ('6-10', 6, 10), ('11-20', 11, 20), ('21-40', 21, 40), ('41+', 41, 9999)]


def band_of(rank):
    for k, lo, hi in BANDS:
        if lo <= rank <= hi:
            return k
    return None


def _stat(g):
    if len(g) < 30:
        return None
    r = g.fwd
    return {'n': int(len(g)), 'win': round(float((r >= WIN).mean()) * 100, 1), 'loss': round(float((r <= LOSS).mean()) * 100, 1),
            'avg': round(float(r.mean()) * 100, 1), 'median': round(float(r.median()) * 100, 1),
            'p10': round(float(r.quantile(0.1)) * 100), 'p90': round(float(r.quantile(0.9)) * 100)}


def rows(fs, chosen):
    P, TRI, V, idx, N, syms = fs.P, fs.TRI, fs.V, fs.idx, fs.N, fs.syms
    out = []
    for off in (0, 7, 14):
        for t in range(260 + off, N - H - 2, 21):
            live = [s for s in syms if fs.first[s] is not None and idx.get_loc(fs.first[s]) <= t - 130 and P[s].iloc[t] > 0
                    and (V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2 and TRI[s].iloc[t + 1] > 0]
            if len(live) < 30:
                continue
            f = fs.features(t).loc[live]
            edge = sum(fs.z(f[k]) * v for k, v in chosen.items())
            fwd = ((TRI.iloc[t + 1 + H][live] / TRI.iloc[t + 1][live]).clip(0.05, 4) * (1 - COST) ** 2 - 1)
            d = pd.DataFrame({'t': t, 'fwd': fwd, 'rank': edge.rank(ascending=False), 'vol': -f['lowvol'], 'lottery': -f['lottery'], 'hi52': f['hi52'], 'small': f['small'],
                              'mom126': f['mom126'], 'dy': f['dy']}).dropna(subset=['fwd'])
            for c in ('vol', 'lottery', 'hi52', 'small', 'mom126', 'dy'):
                d['q_' + c] = d[c].rank(pct=True)
            out.append(d)
    df = pd.concat(out).rename_axis('sym').reset_index()
    df['flag'] = (df.q_vol >= 2 / 3) | (df.q_lottery >= 2 / 3) | (df.q_hi52 <= 1 / 3)      # the same tags traps_today() gives
    return df


def build(fs, chosen=None):
    chosen = chosen or json.load(open('data/factor_study.json'))['h63']['chosen']
    df = rows(fs, chosen)
    ts = sorted(df.t.unique()); half = ts[len(ts) // 2]
    first, second = df[df.t < half], df[df.t >= half]
    res = {'horizonDays': H, 'win': int(WIN * 100), 'loss': int(LOSS * 100), 'cost': COST, 'from': str(fs.idx[ts[0]].date()), 'to': str(fs.idx[ts[-1]].date()),
           'split': str(fs.idx[half].date()), 'dates': len(ts), 'all': _stat(df), 'allSecond': _stat(second), 'bands': {}, 'groups': {}}
    for k, lo, hi in BANDS:
        sel = lambda g: g[(g['rank'] >= lo) & (g['rank'] <= hi)]
        res['bands'][k] = {'all': _stat(sel(df)), 'first': _stat(sel(first)), 'second': _stat(sel(second))}
    groups = {'volatile': ('q_vol', True, 'Most volatile third'), 'lottery': ('q_lottery', True, 'Biggest one-day jumps (lottery-like)'),
              'beaten': ('q_hi52', False, 'Furthest below their 52-week high'), 'small': ('q_small', True, 'Smallest third'),
              'steady': ('q_vol', False, 'Steadiest third (low volatility)'), 'nearhigh': ('q_hi52', True, 'Closest to their 52-week high'),
              'momentum': ('q_mom126', True, 'Best 6-month price run'), 'yield': ('q_dy', True, 'Highest dividend yield')}
    for k, (col, hi, label) in groups.items():
        sel = lambda g: g[g[col] >= 2 / 3] if hi else g[g[col] <= 1 / 3]
        res['groups'][k] = {'label': label, 'all': _stat(sel(df)), 'second': _stat(sel(second))}
    # does a "risky" tag still matter inside the Edge top 20? (it decides whether per-stock odds need adjusting)
    t20 = lambda g: g[g['rank'] <= 20]
    res['top20'] = {'volatile': _stat(t20(df)[t20(df).q_vol >= 2 / 3]), 'notVolatile': _stat(t20(df)[t20(df).q_vol < 2 / 3]),
                    'flagged': _stat(t20(df)[t20(df).flag]), 'clean': _stat(t20(df)[~t20(df).flag]),
                    'flaggedSecond': _stat(t20(second)[t20(second).flag]), 'cleanSecond': _stat(t20(second)[~t20(second).flag])}
    rest = df[df['rank'] > 20]
    res['rest'] = {'flagged': _stat(rest[rest.flag]), 'clean': _stat(rest[~rest.flag])}
    return res


def traps_today(fs):
    """Stocks that sit today in the groups history shows carry about three times the downside with no extra upside."""
    t = fs.N - 1
    live = [s for s in fs.syms if fs.first[s] is not None and fs.P[s].iloc[t] > 0 and (fs.V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2]
    f = fs.features(t).loc[live]
    vol = (-f['lowvol']).rank(pct=True); lot = (-f['lottery']).rank(pct=True); hi = f['hi52'].rank(pct=True)
    out = {}
    for s in live:
        tags = [k for k, on in (('volatile', vol[s] >= 2 / 3), ('lottery', lot[s] >= 2 / 3), ('beaten', hi[s] <= 1 / 3)) if on]
        if tags:
            out[s] = tags
    return out


if __name__ == '__main__':
    import sys, time
    sys.path.insert(0, 'scripts'); sys.argv = sys.argv[:1]
    import factor_study as fs
    t0 = time.time(); r = build(fs)
    print(f'{time.time() - t0:.0f}s', json.dumps(r, indent=1))
