"""Price picker: for each stock and origin day, choose one of Timestral's 21 quantile prices (or "no change") as the
single best guess, trained only on cases whose real price was already known on the decision date.
Walk-forward, scored against middle / noChange / bestFixed baselines.
Usage: python scripts/price_picker.py [cases=data/picker_cases.csv.gz] [min_train=2000]  -> data/price_picker.json"""
import json, sys
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier

sys.path.insert(0, 'scripts')
from tslib import LEVELS

HS = (21, 63)
MIN_TRAIN = 2000
NK = len(LEVELS) + 1  # the 21 quantiles plus "no change"
NOCHANGE, MIDDLE = NK - 1, int(np.flatnonzero(LEVELS == 0.5)[0])
NAMES = [f'{l:g}' for l in LEVELS] + ['noChange']
BASELINES = ('middle', 'bestFixed', 'noChange')
FEATS = ['traded', 'stale', 'vol60', 'mom21', 'mom126', 'hype', 'health']


def train_mask(known, d):
    """The only place that decides who may train for decision date d: outcome known strictly before d."""
    return (pd.to_datetime(known) < d).to_numpy()


def case_arrays(df, h):
    q = df[[f'q{h}_{k}' for k in range(len(LEVELS))]].to_numpy(float)
    c0 = df['c0'].to_numpy(float)
    R = np.column_stack([np.sort(q / c0[:, None], axis=1), np.ones(len(df))])
    y = df[f'act{h}'].to_numpy(float) / c0
    with np.errstate(divide='ignore', invalid='ignore'):
        X = np.column_stack([df[FEATS].to_numpy(float), np.log(q[:, 18] / q[:, 2]), np.log(q[:, MIDDLE] / c0)])
    X[~np.isfinite(X)] = np.nan  # a 0 quantile makes the width infinite; the model takes NaN, not inf
    return R, X, y


def closest(R, y):
    return np.abs(R - y[:, None]).argmin(axis=1)


def fit_picker(R, X, y):
    dead = np.isnan(X).all(axis=0)  # sklearn's binning crashes on a column with no values at all
    X = np.where(dead, 0.0, X)
    clf = HistGradientBoostingClassifier(max_iter=200, learning_rate=0.05, max_leaf_nodes=15,
                                         min_samples_leaf=50, random_state=0).fit(X, closest(R, y))

    def pick(R, X):
        P = np.zeros((len(R), NK))
        if len(clf.classes_) == 1:  # sklearn returns a malformed probability array for one class
            P[:, clf.classes_] = 1.0
        else:
            P[:, clf.classes_] = clf.predict_proba(np.where(dead, 0.0, X))
        cost = np.abs(R[:, :, None] - R[:, None, :])  # cost[n, k, j] = |R_k - R_j|
        return np.einsum('nkj,nj->nk', cost, P).argmin(axis=1)
    return pick


def walk_forward(df, h, min_train=MIN_TRAIN):
    """Test rows with each method's picked slot and error. Refits per origin date on cases known before that date."""
    R, X, y = case_arrays(df, h)
    dates = pd.to_datetime(df['date'])
    known = df[f'known{h}']
    has_y = np.isfinite(y)
    out = []
    for d in sorted(dates.unique()):
        tr = train_mask(known, d) & has_y
        te = (dates == d).to_numpy() & has_y
        if tr.sum() < min_train or not te.any():
            continue
        slots = {'picker': fit_picker(R[tr], X[tr], y[tr])(R[te], X[te]),
                 'middle': np.full(te.sum(), MIDDLE), 'noChange': np.full(te.sum(), NOCHANGE),
                 'bestFixed': np.full(te.sum(), np.abs(R[tr] - y[tr, None]).mean(axis=0).argmin()),
                 'closest': closest(R[te], y[te])}
        res = pd.DataFrame({'date': d, 'traded': df['traded'].to_numpy()[te], 'y': y[te]})
        for m, s in slots.items():
            res[m] = s
            res[f'{m}_err'] = np.abs(R[te][np.arange(te.sum()), s] - y[te]) * 100
        out.append(res)
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def metrics(t, m):
    return {'mean': float(t[f'{m}_err'].mean()), 'median': float(t[f'{m}_err'].median()),
            'hit': float((t[f'{m}_err'] <= t['closest_err'] + 1e-9).mean() * 100),
            'n': len(t), 'origins': int(t['date'].nunique())}


def versus_best_baseline(t, h):
    base = min(BASELINES, key=lambda m: t[f'{m}_err'].mean())
    diff = (t['picker_err'] - t[f'{base}_err']).groupby(t['date']).mean()  # negative = picker closer
    half = len(diff) // 2
    # Origins sit 10 days apart but outcomes span h days, so neighbours overlap: shrink t by sqrt(h/10).
    t_stat = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) / np.sqrt(h / 10) if len(diff) > 2 else np.nan
    halves = (float(diff.iloc[:half].mean()), float(diff.iloc[half:].mean()))
    if abs(t_stat) >= 2 and t_stat < 0 and all(x < 0 for x in halves):
        verdict = 'picker closer'
    elif abs(t_stat) >= 2 and t_stat > 0 and all(x > 0 for x in halves):
        verdict = 'worse'
    else:
        verdict = 'no better'
    return {'baseline': base, 'meanDiff': float(diff.mean()), 't': float(t_stat),
            'firstHalf': halves[0], 'secondHalf': halves[1], 'verdict': verdict}


def summarize(t, h):
    d = pd.to_datetime(t['date'])
    splits = {'all': np.ones(len(t), bool), 'pre2026': (d < '2026-01-01').to_numpy(),
              'y2026': (d >= '2026-01-01').to_numpy(), 'liquid': (t['traded'] >= 0.7).to_numpy()}
    out = {}
    for name, mask in splits.items():
        s = t[mask]
        if s.empty:
            continue
        out[name] = {**{m: metrics(s, m) for m in ('picker', *BASELINES, 'closest')},
                     'vsBestBaseline': versus_best_baseline(s, h)}
    share = t['picker'].value_counts(normalize=True)
    out['pickerLevelShare'] = {NAMES[k]: float(v) for k, v in share.sort_index().items()}
    out['closestNote'] = 'closest is the best candidate in hindsight, a floor that cannot be achieved'
    return out


def run(df, min_train=MIN_TRAIN, horizons=HS):
    result = {}
    for h in horizons:
        t = walk_forward(df, h, min_train)
        result[str(h)] = summarize(t, h) if len(t) else {'note': 'no origin reached min_train'}
    return result


if __name__ == '__main__':
    cases = pd.read_csv(sys.argv[1] if len(sys.argv) > 1 else 'data/picker_cases.csv.gz')
    res = run(cases, int(sys.argv[2]) if len(sys.argv) > 2 else MIN_TRAIN)
    json.dump(res, open('data/price_picker.json', 'w'), indent=1)
    print(json.dumps(res, indent=1))
