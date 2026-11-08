"""'Chance up': probability a stock is higher 3 months after you buy (next day's close, dividends included).
Fitted on past back-test cases from two inputs that were tested: the Edge-score percentile and Timestral's
middle forecast. Fits on the first half, reports how it did on the second half, then refits on everything.
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
dates = sorted(df.date.unique()); half = dates[len(dates) // 2]
tr, te = df[df.date < half], df[df.date >= half]
w1 = logit_fit(tr[['edge', 'med']].values, tr.up.values)
pt = predict(w1, te[['edge', 'med']].values)
te = te.assign(p=pt)
top = te.groupby('date', group_keys=False).apply(lambda g: g.nlargest(10, 'p'))
w = logit_fit(df[['edge', 'med']].values, df.up.values)
out = {'w': [round(float(x), 4) for x in w], 'inputs': ['edge percentile (0–1)', 'Timestral middle forecast (fraction)'],
       'cases': len(df), 'from': str(df.date.min().date()), 'to': str(df.date.max().date()), 'split': str(pd.Timestamp(half).date()),
       'baseUp': round(float(df.up.mean()) * 100, 1), 'testAUC': round(auc(te.up.values, pt), 3),
       'testCalib': [[round(float(g.p.mean()) * 100), round(float(g.up.mean()) * 100), len(g)] for _, g in te.groupby(pd.qcut(te.p, 5, duplicates='drop'))],
       'top10UpRate': round(float(top.up.mean()) * 100, 1), 'top10Mean': round(float(top.fwd.clip(upper=1).mean()) * 100, 1), 'allMean': round(float(te.fwd.clip(upper=1).mean()) * 100, 1)}
json.dump(out, open('data/chance_model.json', 'w'), indent=1)
print('CHANCE', json.dumps(out))
