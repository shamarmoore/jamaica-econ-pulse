"""Walk-forward test of Timestral on JSE daily closes, with and without company financial-health inputs.
Realistic scoring: you see the forecast after the close and buy at the NEXT day's close (so stale last-trade prices
can't flatter the result). Checks: ranking power (IC, top-third vs market), range calibration, target-odds calibration,
whether financial health or speculation scores help. Writes data/forecast_backtest.json for the app.
Usage: python scripts/backtest_ts.py [step=10] [min_ctx=120]"""
import json, sys, time
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
sys.path.insert(0, 'scripts')
from tslib import load_history, load_fundamentals, fundamental_series, forecast, hit_odds, hype, health, FEATS

close, vol = load_history()
FUND = load_fundamentals()
idx = close.index
N = len(idx)
H = 63
STEP = int(sys.argv[1]) if len(sys.argv) > 1 else 10
MIN_CTX = int(sys.argv[2]) if len(sys.argv) > 2 else 120
ff = close.ffill()
first_valid = close.apply(lambda s: s.first_valid_index())
feats = {s: fundamental_series(FUND.get(s), ff[s], idx) for s in close.columns}
print(f'{N} trading days {idx[0].date()} → {idx[-1].date()}, {close.shape[1]} symbols, fundamentals for {sum(1 for s in close.columns if s in FUND)}')

rows = []
t0 = time.time()
for o in range(max(MIN_CTX, 130), N - H - 1, STEP):
    d0 = idx[o]
    syms = [s for s in close.columns if first_valid[s] is not None and idx.get_loc(first_valid[s]) <= o - MIN_CTX
            and ff[s].iloc[o] > 0 and vol[s].iloc[o - 60:o + 1].gt(0).mean() > 0.2]
    if len(syms) < 12:
        continue
    starts = [idx.get_loc(first_valid[s]) for s in syms]
    ctx = [ff[s].iloc[a:o + 1].values for s, a in zip(syms, starts)]
    covs = []
    for s, a in zip(syms, starts):
        cv = feats[s].iloc[a:o + 1][FEATS].values.T.copy()
        cv[3] = cv[3] / 4.0  # loss quarters → 0..1
        covs.append(cv)
    Q0 = forecast(ctx, H)
    Q1 = forecast(ctx, H, cov_list=covs)
    for i, s in enumerate(syms):
        c0 = ff[s].iloc[o]; c1 = ff[s].iloc[o + 1]
        path = ff[s].iloc[o + 1:o + H + 2].values  # day o+1 … o+H+1
        hy = hype(close, vol, s, d0)
        fr = feats[s].iloc[o]
        hl = health(fr)
        rec = {'o': o, 'date': str(d0.date()), 'sym': s, 'c0': c0, 'hasFund': bool(fr.notna().any()),
               'traded': float(vol[s].iloc[o - 59:o + 1].gt(0).mean()), 'hype': hy['score'] if hy else np.nan,
               'health': hl['score'] if hl else np.nan, **{f: fr[f] for f in FEATS},
               'mom6': c0 / ff[s].iloc[o - 126] - 1 if o >= 126 and ff[s].iloc[o - 126] > 0 else np.nan}
        for h in (21, 63):
            rec[f'p0_{h}'] = Q0[i][h - 1, 10] / c0 - 1
            rec[f'p1_{h}'] = Q1[i][h - 1, 10] / c0 - 1
            rec[f'act{h}'] = path[h] / c1 - 1          # buy next day, hold h days
            for k, Q in (('0', Q0), ('1', Q1)):
                q = Q[i][h - 1]
                rec[f'in80_{k}_{h}'] = q[2] <= path[h - 1] <= q[18]
                rec[f'in50_{k}_{h}'] = q[5] <= path[h - 1] <= q[15]
        for tp in (10, 20, 30):
            for k, Q in (('0', Q0), ('1', Q1)):
                p, first, _ = hit_odds(Q[i], c0 * (1 + tp / 100))
                rec[f'odds{tp}_{k}'] = p
                rec[f'day{tp}_{k}'] = first
            hit = np.nonzero(path[:H] >= c0 * (1 + tp / 100))[0]
            rec[f'hit{tp}'] = len(hit) > 0
            rec[f'aday{tp}'] = int(hit[0]) + 1 if len(hit) else None
        rows.append(rec)
    print(f'origin {d0.date()}: {len(syms)} stocks, {time.time() - t0:.0f}s', flush=True)

df = pd.DataFrame(rows)
df.to_csv('data/forecast_backtest_rows.csv', index=False)


def rank_stats(d, score, h):
    ics, top, bot = [], [], []
    for _, g in d.groupby('o'):
        g = g.dropna(subset=[score, f'act{h}'])
        if len(g) < 12:
            continue
        ics.append(spearmanr(g[score], g[f'act{h}']).correlation)
        k = len(g) // 3
        top.append(g.nlargest(k, score)[f'act{h}'].mean() - g[f'act{h}'].mean())
        bot.append(g.nsmallest(k, score)[f'act{h}'].mean() - g[f'act{h}'].mean())
    if not ics:
        return None
    ics = np.array(ics); top = np.array(top)
    # origins overlap (step < horizon), so the t-stat is shrunk by sqrt(horizon/step)
    t = np.nanmean(ics) / (np.nanstd(ics) / np.sqrt(len(ics))) / np.sqrt(max(1, h / STEP))
    return {'ic': round(float(np.nanmean(ics)), 3), 'icT': round(float(t), 2), 'icPositivePct': round(float((ics > 0).mean() * 100)),
            'topThirdExcess': round(float(top.mean()) * 100, 2), 'topThirdBeatPct': round(float((top > 0).mean() * 100)),
            'bottomThirdExcess': round(float(np.mean(bot)) * 100, 2), 'origins': int(len(ics))}


def z(s):
    return (s - s.mean()) / (s.std() or 1)


df['combo'] = df.groupby('o', group_keys=False)[['p1_63', 'health']].apply(lambda g: z(g['p1_63']) + 0.5 * z(g['health'].fillna(g['health'].median())))
fd = df[df.hasFund]
out = {'origins': int(df.o.nunique()), 'cases': len(df), 'from': df.date.min(), 'to': df.date.max(), 'model': 'Timestral-209M',
       'basis': 'buy at the next day’s close after the forecast', 'horizons': {}, 'compare': {}}
for h in (21, 63):
    a = df[f'act{h}']
    out['horizons'][h] = {
        **(rank_stats(df, f'p1_{h}', h) or {}),
        'directionAcc': round(float((np.sign(df[f'p1_{h}']) == np.sign(a))[df[f'p1_{h}'].abs() > 0.01].mean() * 100), 1),
        'alwaysUpAcc': round(float((a > 0).mean() * 100), 1),
        'coverage80': round(float(df[f'in80_1_{h}'].mean() * 100), 1), 'coverage50': round(float(df[f'in50_1_{h}'].mean() * 100), 1),
        'momTopThirdExcess': (rank_stats(df, 'mom6', h) or {}).get('topThirdExcess'),
    }
    out['compare'][h] = {name: rank_stats(fd, col, h) for name, col in [
        ('priceOnly', f'p0_{h}'), ('withFinancials', f'p1_{h}'), ('healthScoreAlone', 'health'), ('earningsYieldAlone', 'ey'),
        ('profitGrowthAlone', 'growth'), ('dividendYieldAlone', 'dy'), ('forecastPlusHealth', 'combo'), ('momentum6m', 'mom6')]}
    out['compare'][h]['coverage80'] = {'priceOnly': round(float(fd[f'in80_0_{h}'].mean() * 100), 1), 'withFinancials': round(float(fd[f'in80_1_{h}'].mean() * 100), 1)}
    out['compare'][h]['liquidOnly'] = {name: rank_stats(fd[fd.traded >= 0.7], col, h) for name, col in [('priceOnly', f'p0_{h}'), ('withFinancials', f'p1_{h}'), ('healthScoreAlone', 'health')]}

bins = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 1.0]
allp, allh = [], []
for tp in (10, 20, 30):
    p, hit = df[f'odds{tp}_1'], df[f'hit{tp}'].astype(float)
    allp += list(p); allh += list(hit)
    tab = [{'lo': lo, 'hi': hi, 'n': int(m.sum()), 'pred': round(float(p[m].mean()), 3), 'actual': round(float(hit[m].mean()), 3)}
           for lo, hi in zip(bins[:-1], bins[1:]) for m in [(p >= lo) & (p < hi)] if m.sum() >= 20]
    dd = df[df[f'day{tp}_1'].notna() & df[f'aday{tp}'].notna()]
    out[f'target{tp}'] = {'baseRate': round(float(hit.mean()), 3), 'brier': round(float(((p - hit) ** 2).mean()), 4),
                          'brierBaseRate': round(float(((hit.mean() - hit) ** 2).mean()), 4), 'table': tab,
                          'dateMedianErrDays': float(np.median(np.abs(dd[f'day{tp}_1'] - dd[f'aday{tp}']))) if len(dd) else None}
allp, allh = np.array(allp), np.array(allh)
cmap = [[round(float(allp[m].mean()), 3), round(float(allh[m].mean()), 3)] for lo, hi in zip(bins[:-1], bins[1:]) for m in [(allp >= lo) & (allp < hi)] if m.sum() >= 30]
for i in range(1, len(cmap)):
    cmap[i][1] = max(cmap[i][1], cmap[i - 1][1])
out['calibration'] = cmap

hh = df[df.hype.notna()]
for h in (21, 63):
    ex = [g[g.hype >= 50][f'act{h}'].mean() - g[f'act{h}'].mean() for _, g in hh.groupby('o') if (g.hype >= 50).sum() >= 2]
    hi_, lo_ = hh[hh.hype >= 50][f'act{h}'], hh[hh.hype < 20][f'act{h}']
    out.setdefault('hype', {})[h] = {'nHigh': int(len(hi_)), 'highExcessVsMarket': round(float(np.mean(ex)) * 100, 2) if ex else None,
                                     'highWorsePct': round(float((np.array(ex) < 0).mean() * 100)) if ex else None,
                                     'highSd': round(float(hi_.std()) * 100, 1), 'lowSd': round(float(lo_.std()) * 100, 1)}
json.dump(out, open('data/forecast_backtest.json', 'w'), indent=1)
print('BACKTEST', json.dumps(out, indent=1))
