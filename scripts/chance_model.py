"""'Chance up': probability a stock is higher 3 months after you buy (next day's close, dividends included).
'Chance +20%' (plus20): probability it is 20% or more higher over the same 3 months, built the same way.
Both are fitted on past cases from two inputs: the walk-forward Edge score (data/edge_hist.json, made by edge_v2.py)
and Timestral's middle 3-month forecast on the same day (data/ts_hist.json, aligned the way edge_v2 aligns it).
Each fits on the first half, reports how it did on the second half, then refits on everything.
The app shows per-stock +20% odds only if, on the second half, they beat the plain base rate (lower Brier score) and
rank stocks better than chance (AUC above 0.5).
Writes data/chance_model.json."""
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


import edge_v2
FC = edge_v2.Data(fs).FC
hist = json.load(open('data/edge_hist.json'))['days']
rows = []
for day, sc in sorted(hist.items()):
    t = fs.idx.get_loc(pd.Timestamp(day))
    if t + 64 >= fs.N:
        continue
    ok = [s for s in sc if pd.notna(FC.iloc[t].get(s)) and fs.P[s].iloc[t] > 0 and fs.TRI[s].iloc[t + 1] > 0]
    fwd = fs.TRI[ok].iloc[t + 64] / fs.TRI[ok].iloc[t + 1] - 1
    for s in ok:
        rows.append({'date': pd.Timestamp(day), 'edge': sc[s][0] / 100, 'med': float(np.clip(FC.iloc[t][s], -0.5, 0.5)), 'up': float(fwd[s] > 0), 'fwd': float(fwd[s])})
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
out = {'w': [round(float(x), 4) for x in w], 'inputs': ['Edge score (0–1, walk-forward)', 'Timestral middle forecast (fraction)'],
       'cases': len(df), 'from': str(df.date.min().date()), 'to': str(df.date.max().date()), 'split': str(pd.Timestamp(half).date()),
       'baseUp': round(float(df.up.mean()) * 100, 1), 'testAUC': round(auc(te_up.up.values, te_up.p.values), 3),
       'testCalib': calib(te_up, 'up'),
       'top10UpRate': round(float(top.up.mean()) * 100, 1), 'top10Mean': round(float(top.fwd.clip(upper=1).mean()) * 100, 1), 'allMean': round(float(te.fwd.clip(upper=1).mean()) * 100, 1)}

w20, te20 = fit('big')
brier = float(((te20.p - te20.big) ** 2).mean())
brier_base = float(((tr.big.mean() - te20.big) ** 2).mean())   # the first half's base rate, the best guess without the model
test_auc = auc(te20.big.values, te20.p.values)
out['plus20'] = {'w': [round(float(x), 4) for x in w20], 'inputs': out['inputs'], 'threshold': 20,
                 'cases': len(df), 'from': out['from'], 'to': out['to'], 'split': out['split'],
                 'baseRate': round(float(df.big.mean()) * 100, 1), 'testAUC': round(test_auc, 3),
                 'testBrier': round(brier, 4), 'testBrierBase': round(brier_base, 4), 'skill': round(1 - brier / brier_base, 3),
                 'show': bool(brier < brier_base and test_auc > 0.5), 'testCalib': calib(te20, 'big'),
                 'top10Rate': round(float(top10(te20).big.mean()) * 100, 1), 'allRate': round(float(te20.big.mean()) * 100, 1)}
json.dump(out, open('data/chance_model.json', 'w'), indent=1)
print('CHANCE', json.dumps(out))
