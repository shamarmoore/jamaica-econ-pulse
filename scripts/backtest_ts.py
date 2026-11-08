"""Walk-forward test of Timestral on JSE daily closes. Honest checks before the app relies on it:
1) direction of the median forecast, 2) ranking stocks (vs plain 6-month momentum),
3) whether the forecast ranges are the right width, 4) whether 'chance of hitting target' is calibrated,
5) whether high speculation (hype) scores precede weak returns.
Writes data/forecast_backtest.json (summary + calibration tables the app uses)."""
import json, sys, time
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
sys.path.insert(0, 'scripts')
from tslib import load_history, forecast, hit_odds, hype, LEVELS

close, vol = load_history()
idx = close.index
N = len(idx)
H = 63
STEP = int(sys.argv[1]) if len(sys.argv) > 1 else 21
MIN_CTX = int(sys.argv[2]) if len(sys.argv) > 2 else 250
first_valid = close.apply(lambda s: s.first_valid_index())
ff = close.ffill()
print(f'{N} trading days {idx[0].date()} → {idx[-1].date()}, {close.shape[1]} symbols')

rows = []
t0 = time.time()
origins = list(range(max(MIN_CTX, 130), N - H, STEP))
for o in origins:
    d0 = idx[o]
    syms = [s for s in close.columns if first_valid[s] is not None and idx.get_loc(first_valid[s]) <= o - MIN_CTX
            and not np.isnan(ff[s].iloc[o]) and ff[s].iloc[o] > 0 and vol[s].iloc[o - 60:o + 1].gt(0).mean() > 0.2]
    if len(syms) < 10:
        continue
    ctx = [ff[s].iloc[idx.get_loc(first_valid[s]):o + 1].values for s in syms]
    Q = forecast(ctx, H)
    for i, s in enumerate(syms):
        c0 = ff[s].iloc[o]
        path = ff[s].iloc[o + 1:o + H + 1].values
        q = Q[i]
        hy = hype(close, vol, s, d0)
        mom = c0 / ff[s].iloc[o - 126] - 1 if o >= 126 and ff[s].iloc[o - 126] > 0 else np.nan
        rec = {'o': o, 'date': str(d0.date()), 'sym': s, 'c0': c0, 'mom6': mom, 'hype': hy['score'] if hy else np.nan}
        for h in (21, 63):
            rec[f'pred{h}'] = q[h - 1, 10] / c0 - 1
            rec[f'act{h}'] = path[h - 1] / c0 - 1
            rec[f'in80_{h}'] = q[h - 1, 2] <= path[h - 1] <= q[h - 1, 18]
            rec[f'in90_{h}'] = q[h - 1, 1] <= path[h - 1] <= q[h - 1, 19]
            rec[f'in50_{h}'] = q[h - 1, 5] <= path[h - 1] <= q[h - 1, 15]
        for tp in (0.10, 0.20, 0.30):
            p, first, _ = hit_odds(q, c0 * (1 + tp))
            hit = np.nonzero(path >= c0 * (1 + tp))[0]
            rec[f'p{int(tp*100)}'] = p
            rec[f'hit{int(tp*100)}'] = len(hit) > 0
            rec[f'day{int(tp*100)}'] = first
            rec[f'aday{int(tp*100)}'] = int(hit[0]) + 1 if len(hit) else None
        rows.append(rec)
    print(f'origin {d0.date()}: {len(syms)} stocks, {time.time()-t0:.0f}s', flush=True)

df = pd.DataFrame(rows)
df.to_csv('data/forecast_backtest_rows.csv', index=False)
out = {'origins': int(df.o.nunique()), 'cases': len(df), 'from': df.date.min(), 'to': df.date.max(), 'model': 'Timestral-209M', 'horizons': {}}

for h in (21, 63):
    a, p = df[f'act{h}'], df[f'pred{h}']
    conf = p.abs() > 0.01
    dir_acc = float((np.sign(p[conf]) == np.sign(a[conf])).mean())
    up_base = float((a > 0).mean())
    mom_ok = df.mom6.notna()
    mom_acc = float((np.sign(df.mom6[mom_ok]) == np.sign(a[mom_ok])).mean())
    ics, mics, top, mtop, bot = [], [], [], [], []
    for o, g in df.groupby('o'):
        if len(g) < 15:
            continue
        ics.append(spearmanr(g[f'pred{h}'], g[f'act{h}']).correlation)
        gm = g[g.mom6.notna()]
        if len(gm) >= 15:
            mics.append(spearmanr(gm.mom6, gm[f'act{h}']).correlation)
            k = len(gm) // 3
            mtop.append(gm.nlargest(k, 'mom6')[f'act{h}'].mean() - gm[f'act{h}'].mean())
        k = len(g) // 3
        top.append(g.nlargest(k, f'pred{h}')[f'act{h}'].mean() - g[f'act{h}'].mean())
        bot.append(g.nsmallest(k, f'pred{h}')[f'act{h}'].mean() - g[f'act{h}'].mean())
    ics, mics = np.array(ics), np.array(mics)
    out['horizons'][h] = {
        'directionAcc': round(dir_acc * 100, 1), 'directionCases': int(conf.sum()), 'alwaysUpAcc': round(up_base * 100, 1), 'momentumDirAcc': round(mom_acc * 100, 1),
        'ic': round(float(np.nanmean(ics)), 3), 'icT': round(float(np.nanmean(ics) / (np.nanstd(ics) / np.sqrt(len(ics)))), 2), 'icPositivePct': round(float((ics > 0).mean() * 100)),
        'momIc': round(float(np.nanmean(mics)), 3), 'momIcT': round(float(np.nanmean(mics) / (np.nanstd(mics) / np.sqrt(len(mics)))), 2),
        'topThirdExcess': round(float(np.mean(top)) * 100, 2), 'topThirdBeatPct': round(float((np.array(top) > 0).mean() * 100)),
        'bottomThirdExcess': round(float(np.mean(bot)) * 100, 2), 'momTopThirdExcess': round(float(np.mean(mtop)) * 100, 2),
        'coverage50': round(float(df[f'in50_{h}'].mean() * 100), 1), 'coverage80': round(float(df[f'in80_{h}'].mean() * 100), 1), 'coverage90': round(float(df[f'in90_{h}'].mean() * 100), 1),
    }

# calibration of "chance of hitting +X% within 3 months"
bins = [0, 0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.65, 1.0]
cal = []
allp, allh = [], []
for tp in (10, 20, 30):
    p, hit = df[f'p{tp}'], df[f'hit{tp}'].astype(float)
    allp += list(p); allh += list(hit)
    base = hit.mean()
    brier = float(((p - hit) ** 2).mean()); brier0 = float(((base - hit) ** 2).mean())
    tab = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        m = (p >= lo) & (p < hi)
        if m.sum() >= 20:
            tab.append({'lo': lo, 'hi': hi, 'n': int(m.sum()), 'pred': round(float(p[m].mean()), 3), 'actual': round(float(hit[m].mean()), 3)})
    dd = df[df[f'day{tp}'].notna() & df[f'aday{tp}'].notna()]
    out[f'target{tp}'] = {'baseRate': round(float(base), 3), 'brier': round(brier, 4), 'brierBaseRate': round(brier0, 4), 'table': tab,
                          'dateCases': len(dd), 'dateMedianErrDays': float(np.median(np.abs(dd[f'day{tp}'] - dd[f'aday{tp}']))) if len(dd) else None}
# pooled calibration map the app applies to raw odds (monotone, via bucket averages)
allp, allh = np.array(allp), np.array(allh)
cmap = []
for lo, hi in zip(bins[:-1], bins[1:]):
    m = (allp >= lo) & (allp < hi)
    if m.sum() >= 30:
        cmap.append([round(float(allp[m].mean()), 3), round(float(allh[m].mean()), 3)])
for i in range(1, len(cmap)):
    cmap[i][1] = max(cmap[i][1], cmap[i - 1][1])
out['calibration'] = cmap

# hype: do speculative-looking stocks do worse afterwards?
hh = df[df.hype.notna()]
for h in (21, 63):
    hi_ = hh[hh.hype >= 50][f'act{h}']; lo_ = hh[hh.hype < 20][f'act{h}']
    ex = []
    for o, g in hh.groupby('o'):
        if (g.hype >= 50).sum() >= 2:
            ex.append(g[g.hype >= 50][f'act{h}'].mean() - g[f'act{h}'].mean())
    out.setdefault('hype', {})[h] = {'nHigh': int(len(hi_)), 'highMean': round(float(hi_.mean()) * 100, 2), 'lowMean': round(float(lo_.mean()) * 100, 2),
                                     'highExcessVsMarket': round(float(np.mean(ex)) * 100, 2) if ex else None, 'highWorsePct': round(float((np.array(ex) < 0).mean() * 100)) if ex else None,
                                     'highSd': round(float(hi_.std()) * 100, 1), 'lowSd': round(float(lo_.std()) * 100, 1),
                                     'ic': round(float(spearmanr(hh.hype, hh[f'act{h}']).correlation), 3)}

json.dump(out, open('data/forecast_backtest.json', 'w'), indent=1)
print('BACKTEST', json.dumps(out, indent=1))
