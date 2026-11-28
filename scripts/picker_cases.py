"""Rebuild Timestral's past forecasts as picker cases: one row per (origin day, stock) with the 21 candidate prices
for 21 and 63 trading days ahead, facts known that day, the real price later, and the day that price became known.
Timestral only sees prices and financials up to the origin. Slow (one Timestral run per origin).
Writes data/picker_cases.csv.gz. Usage: python scripts/picker_cases.py [step=10] [min_ctx=120]"""
import sys, time
import numpy as np
import pandas as pd
sys.path.insert(0, 'scripts')
from tslib import load_history, load_fundamentals, fundamental_series, forecast, hype, health, FEATS, is_pref, LEVELS

HS = (21, 63)
STEP = int(sys.argv[1]) if len(sys.argv) > 1 else 10
MIN_CTX = int(sys.argv[2]) if len(sys.argv) > 2 else 120
close, vol = load_history()
FUND = load_fundamentals()
idx = close.index
N = len(idx)
ff = close.ffill()
lr = np.log(ff).diff()
first_valid = close.apply(lambda s: s.first_valid_index())
feats = {s: fundamental_series(FUND.get(s), ff[s], idx) for s in close.columns}

rows = []
t0 = time.time()
for o in range(max(MIN_CTX, 130), N - 1, STEP):
    d0 = idx[o]
    syms = [s for s in close.columns if not is_pref(s) and first_valid[s] is not None and idx.get_loc(first_valid[s]) <= o - MIN_CTX
            and ff[s].iloc[o] > 0 and vol[s].iloc[o - 60:o + 1].gt(0).mean() > 0.2]
    if len(syms) < 12:
        continue
    starts = [idx.get_loc(first_valid[s]) for s in syms]
    ctx = [ff[s].iloc[a:o + 1].values for s, a in zip(syms, starts)]
    covs = []
    for s, a in zip(syms, starts):
        cv = feats[s].iloc[a:o + 1][FEATS].values.T.copy()
        cv[3] = cv[3] / 4.0  # loss quarters → 0..1, as forecast.py feeds it
        covs.append(cv)
    Q = forecast(ctx, max(HS), cov_list=covs)
    for i, s in enumerate(syms):
        c0 = ff[s].iloc[o]
        traded = vol[s].iloc[o - 59:o + 1].gt(0)
        hy, hl = hype(close, vol, s, d0), health(feats[s].iloc[o])
        rec = {'o': o, 'date': str(d0.date()), 'sym': s, 'c0': c0, 'traded': float(traded.mean()),
               'stale': int(len(traded) - 1 - np.flatnonzero(traded.values)[-1]) if traded.any() else 60,
               'vol60': float(lr[s].iloc[o - 59:o + 1].std()), 'mom21': c0 / ff[s].iloc[o - 21] - 1,
               'mom126': c0 / ff[s].iloc[o - 126] - 1 if ff[s].iloc[o - 126] > 0 else np.nan,
               'hype': hy['score'] if hy else np.nan, 'health': hl['score'] if hl else np.nan}
        for h in HS:
            done = o + h < N
            rec[f'known{h}'] = str(idx[o + h].date()) if done else None
            rec[f'act{h}'] = ff[s].iloc[o + h] if done else np.nan
            rec.update({f'q{h}_{k}': Q[i][h - 1, k] for k in range(len(LEVELS))})
        rows.append(rec)
    print(f'origin {d0.date()}: {len(syms)} stocks, {time.time() - t0:.0f}s', flush=True)

pd.DataFrame(rows).to_csv('data/picker_cases.csv.gz', index=False, float_format='%.6g')
print(f'{len(rows)} cases → data/picker_cases.csv.gz')
