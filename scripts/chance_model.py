"""'Chance up': probability a stock is higher 3 months after you buy (next day's close, dividends included).
'Chance +20%' (plus20): probability it is 20% or more higher over the same 3 months, built the same way.
Both are fitted on past back-test cases from two inputs that were tested: the Edge-score percentile and Timestral's
middle forecast. Each fits on the first half, reports how it did on the second half, then refits on everything.
The app shows per-stock +20% odds only if they beat the plain base rate on the second half (lower Brier score).
Needs data/forecast_backtest_rows.csv (made by backtest_ts.py). Writes data/chance_model.json."""
import json, sys
import numpy as np
import pandas as pd
sys.path.insert(0, 'scripts')
sys.argv = sys.argv[:1]
import factor_study as fs


def logit_fit(X, y, iters=50):
    X = np.column_stack([np.ones(len(X)), X]); w = np.zeros(X.shape[1])
    for _ in range(iters):  # Newton–Raphson
        p = 1 / (1 + np.exp(-X @ w)); W = p * (1 - p)
        H = X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(w)); w -= np.linalg.solve(H, X.T @ (p - y))
    return w


def predict(w, X):
    return 1 / (1 + np.exp(-(w[0] + np.asarray(X) @ w[1:])))


def auc(y, p):
    order = np.argsort(p); r = np.empty(len(p)); r[order] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0))


study = json.load(open('data/factor_study.json')); chosen = study['h63']['chosen']
bt = pd.read_csv('data/forecast_backtest_rows.csv'); bt['date'] = pd.to_datetime(bt.date)
rows = []
for d, g in bt.groupby('date'):
    if d not in fs.idx:
        continue
    t = fs.idx.get_loc(d)
    if t + 64 >= fs.N or t < 260:
        continue
    f = fs.features(t)
    edge = sum(fs.z(f[k]) * v for k, v in chosen.items()).rank(pct=True)
    ok = [s for s in g.sym if s in fs.syms and pd.notna(fs.P[s].iloc[t])]
    fwd = fs.TRI[ok].iloc[t + 64] / fs.TRI[ok].iloc[t + 1] - 1
    med = g.set_index('sym')['p1_63']
    for s in ok:
        rows.append({'date': d, 'edge': edge[s], 'med': float(np.clip(med[s], -0.5, 0.5)), 'up': float(fwd[s] > 0), 'fwd': float(fwd[s])})
df = pd.DataFrame(rows).dropna()
df['big'] = (df.fwd >= 0.20).astype(float)
dates = sorted(df.date.unique()); half = dates[len(dates) // 2]
tr, te = df[df.date < half], df[df.date >= half]
X = ['edge', 'med']


def fit(label):
    """(weights refit on every case, test half with p = odds from a fit on the first half only)."""
    w_first = logit_fit(tr[X].values, tr[label].values)
    return logit_fit(df[X].values, df[label].values), te.assign(p=predict(w_first, te[X].values))


def calib(t, label):
    return [[round(float(g.p.mean()) * 100), round(float(g[label].mean()) * 100), len(g)] for _, g in t.groupby(pd.qcut(t.p, 5, duplicates='drop'))]


def top10(t):
    return t.groupby('date', group_keys=False).apply(lambda g: g.nlargest(10, 'p'))


w, te_up = fit('up')
top = top10(te_up)
out = {'w': [round(float(x), 4) for x in w], 'inputs': ['edge percentile (0–1)', 'Timestral middle forecast (fraction)'],
       'cases': len(df), 'from': str(df.date.min().date()), 'to': str(df.date.max().date()), 'split': str(pd.Timestamp(half).date()),
       'baseUp': round(float(df.up.mean()) * 100, 1), 'testAUC': round(auc(te_up.up.values, te_up.p.values), 3),
       'testCalib': calib(te_up, 'up'),
       'top10UpRate': round(float(top.up.mean()) * 100, 1), 'top10Mean': round(float(top.fwd.clip(upper=1).mean()) * 100, 1), 'allMean': round(float(te.fwd.clip(upper=1).mean()) * 100, 1)}

w20, te20 = fit('big')
brier = float(((te20.p - te20.big) ** 2).mean())
brier_base = float(((tr.big.mean() - te20.big) ** 2).mean())   # the first half's base rate, the best guess without the model
out['plus20'] = {'w': [round(float(x), 4) for x in w20], 'inputs': out['inputs'], 'threshold': 20,
                 'cases': len(df), 'from': out['from'], 'to': out['to'], 'split': out['split'],
                 'baseRate': round(float(df.big.mean()) * 100, 1), 'testAUC': round(auc(te20.big.values, te20.p.values), 3),
                 'testBrier': round(brier, 4), 'testBrierBase': round(brier_base, 4), 'skill': round(1 - brier / brier_base, 3),
                 'show': bool(brier < brier_base), 'testCalib': calib(te20, 'big'),
                 'top10Rate': round(float(top10(te20).big.mean()) * 100, 1), 'allRate': round(float(te20.big.mean()) * 100, 1)}
json.dump(out, open('data/chance_model.json', 'w'), indent=1)
print('CHANCE', json.dumps(out))
