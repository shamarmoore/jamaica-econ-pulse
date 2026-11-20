"""Pop watch: sudden big rises on the JSE, what was known before them, and what came after.

A pop starting after day t: the total return from close t to close t+21 beats the average stock by 25+ points, the stock
traded on at least half of those days, and where quotes exist the bid/ask midpoint rose 20%+ as well, so a stale last
trade bouncing between bid and ask doesn't count. study() catalogues every pop, tags the news around it, measures the 3
months after it, and fits a pop-odds model on the first half of history that is judged on the second half. None of it
changes the Edge score or the buy list.

  study(fs, summarize) -> dict for idea_tests.json['pops']
  today(out, fs)       -> stocks[sym].pop and popInfo in forecasts.json (uses the model saved by study)"""
import json
import numpy as np
import pandas as pd

H, POP, MID_POP, STEP = 21, 0.25, 0.20, 5
FEATS = ['small', 'lowvol', 'hi52', 'lottery', 'spread', 'turn_surge', 'volsurge', 'q_yoy', 'dy', 'mom63', 'rev21']
# what a high and a low rank on each input means, so a stock's reasons name the side it is on
LABELS = {'small': ('small company', 'large company'), 'lowvol': ('steady price', 'volatile price'), 'hi52': ('near its 52-week high', 'far below its 52-week high'),
          'lottery': ('no wild one-day spikes', 'recent big one-day spikes'), 'spread': ('wide bid/ask spread', 'tight bid/ask spread'),
          'turn_surge': ('turnover rising vs its norm', 'turnover falling vs its norm'), 'volsurge': ('volume picking up', 'volume fading'),
          'q_yoy': ('latest quarter beat last year', 'latest quarter worse than last year'), 'dy': ('pays a dividend', 'little or no dividend'),
          'mom63': ('strong 3-month trend', 'weak 3-month trend'), 'rev21': ('pulled back in the last month', 'rose in the last month')}
DRIVER_LABELS = {'none': 'No announcement', 'results_up': 'Results up', 'results_down': 'Results down', 'results_flat': 'Results flat',
                 'insider_buy': 'Insider buying', 'insider_sell': 'Insider selling', 'divcons': 'Dividend meeting notice', 'dividend': 'Dividend declared',
                 'split': 'Share split', 'raise': 'Rights issue / new shares', 'takeover': 'Take-over', 'suspend': 'Suspension'}
COST_FEE = 0.01         # 0.5% fees each way on top of the stock's quoted spread
UNKNOWN_SPREAD = 0.06
_c = {}


def _frames(fs):
    if 'pops' in _c:
        return _c
    import edge_v2 as E
    P, TRI, V, idx, N = fs.P, fs.TRI, fs.V, fs.idx, fs.N
    D = E.Data(fs)
    TR = (V > 0).astype(float)
    univ = (TR.rolling(60).mean() >= 0.2) & (P > 0)
    fwd = TRI.shift(-H) / TRI - 1
    fwdm = D.MID.shift(-H) / D.MID - 1
    traded_fwd = TR[::-1].rolling(H).mean()[::-1].shift(-1)
    mkt = pd.Series([np.nanmean(np.clip(fwd.iloc[t][univ.iloc[t]].values, -0.9, 3)) if t + H < N else np.nan for t in range(N)], index=idx)
    ex = fwd.sub(mkt, axis=0)
    _c.update(D=D, univ=univ, fwd=fwd, ex=ex, fwdm=fwdm,
              pops=(ex >= POP) & (traded_fwd >= 0.5) & univ & (fwdm.isna() | (fwdm >= MID_POP)), news=_news(fs))
    return _c


def _news(fs):
    """{sym: [(first trading day it could move the price, kind, title, link)]} from the event archive, results and insider trades."""
    import events as EV, insiders as INS
    idx = fs.idx
    day = lambda d: int(idx.searchsorted(pd.Timestamp(d), side='right'))
    out = {}
    links = {}
    try:
        links = {p['id']: p.get('link') for p in json.load(open('data/events_archive.json', encoding='utf-8')).get('posts', [])}
    except Exception:
        pass
    for e in EV.archive_events():
        out.setdefault(e['sym'], []).append((day(e['date']), e['kind'], e.get('title', ''), links.get(e.get('id'))))
    try:
        for p in json.load(open('data/reports_index.json', encoding='utf-8'))['posts']:
            if p.get('sym'):
                out.setdefault(p['sym'], []).append((day(p['date']), 'results', p['title'], (p.get('links') or [[None]])[0][0]))
    except Exception:
        pass
    for e in INS.events():
        if not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell'):
            out.setdefault(e['sym'], []).append((day(e['date']), 'insider_' + e['side'], e.get('title', ''), None))
    for s in out:
        out[s].sort(key=lambda x: x[0])
    return out


def drivers(fs, s, t, end=None):
    """News kinds dated from 5 trading days before t to `end` (default t+21); results tagged by the quarter they reported."""
    end = t + H if end is None else end
    got = set()
    for d, k, _, _ in _frames(fs)['news'].get(s, []):
        if t - 5 <= d <= end:
            if k == 'results':
                q = fs.FF['q_yoy'][s].iloc[min(d + 1, fs.N - 1)]
                k = 'results_up' if pd.notna(q) and q > 0.1 else 'results_down' if pd.notna(q) and q < -0.1 else 'results_flat'
            got.add(k)
    return sorted(got) or ['none']


def features(fs, t, live):
    """Pop-model inputs for day t: each feature's rank among that day's stocks, centred on 0 (missing = middle)."""
    f = pd.concat([fs.features(t).loc[live], _frames(fs)['D'].extra(t, live)], axis=1)
    return pd.DataFrame({k: f[k].rank(pct=True).fillna(0.5) - 0.5 for k in FEATS}, index=live), f


def _live(fs, t):
    U = _frames(fs)['univ']
    return [s for s in fs.syms if U[s].iloc[t] and fs.first[s] is not None and fs.idx.get_loc(fs.first[s]) <= t - 130]


def _logit(X, y, iters=50):
    X = np.column_stack([np.ones(len(X)), X]); w = np.zeros(X.shape[1])
    for _ in range(iters):
        p = 1 / (1 + np.exp(-X @ w)); W = p * (1 - p)
        w -= np.linalg.solve(X.T @ (X * W[:, None]) + 1e-6 * np.eye(len(w)), X.T @ (p - y))
    return w


def _predict(w, X):
    return 1 / (1 + np.exp(-(w[0] + np.asarray(X) @ np.asarray(w[1:]))))


def _auc(y, p):
    order = np.argsort(p); r = np.empty(len(p)); r[order] = np.arange(1, len(p) + 1)
    n1 = y.sum(); n0 = len(y) - n1
    return float((r[y == 1].sum() - n1 * (n1 + 1) / 2) / (n1 * n0)) if n1 and n0 else None


def _keep_band():
    import edge_v2 as E
    return E.RULES[E.SHIP].get('keep', E.TOP)


def _rank_lookup(idx):
    """rank(sym, day index) -> the walk-forward Edge rank on the latest grid day at or before it (0 = not ranked or no history)."""
    import bisect
    try:
        hist = json.load(open('data/edge_hist.json', encoding='utf-8'))['days']
    except Exception:
        hist = {}
    days = sorted(hist)

    def rank(s, t):
        i = bisect.bisect_right(days, str(idx[t].date())) - 1
        return (hist[days[i]].get(s) or [0, 0])[1] if i >= 0 else 0
    return rank


def study(fs, summarize):
    C = _frames(fs)
    P, TRI, idx, N = fs.P, fs.TRI, fs.idx, fs.N
    # 1) catalogue: the first day of each pop, one per run-up
    ev = []
    for s in fs.syms:
        col, t = C['pops'][s].values, 260
        while t < N - H:
            if col[t]:
                a63 = t + H + 63 < N
                ev.append({'sym': s, 't': t, 'gain': float(C['fwd'][s].iloc[t]), 'mid': pd.notna(C['fwdm'][s].iloc[t]), 'drivers': drivers(fs, s, t),
                           'after63': float(TRI[s].iloc[t + H + 63] / TRI[s].iloc[t + H] - 1) if a63 else None,
                           'mkt63': float(np.nanmean(np.clip((TRI.iloc[t + H + 63] / TRI.iloc[t + H] - 1)[C['univ'].iloc[t + H]].values, -0.9, 3))) if a63 else None})
                t += H
            else:
                t += 1
    E = pd.DataFrame(ev)
    any_month, n_month = {}, 0
    for t in range(260, N - H, H):
        for s in fs.syms:
            if C['univ'][s].iloc[t]:
                n_month += 1
                for k in drivers(fs, s, t):
                    any_month[k] = any_month.get(k, 0) + 1
    kinds = pd.Series([k for x in E.drivers for k in x]).value_counts()
    out = {'from': str(idx[int(E.t.min())].date()), 'to': str(idx[int(E.t.max())].date()), 'pops': len(E), 'stocks': int(E.sym.nunique()),
           'medianGain': round(float(E.gain.median()) * 100, 1), 'midConfirmed': round(float(E.mid.mean()) * 100),
           'mostPops': E.sym.value_counts().head(8).to_dict(),
           'drivers': {k: {'label': DRIVER_LABELS.get(k, k), 'pops': round(float(v) / len(E) * 100, 1), 'anyMonth': round(any_month.get(k, 0) / n_month * 100, 1)}
                       for k, v in kinds.items()}}
    # 2) what came after: buying at the close the pop ended, held 63 days (a test the registry counts)
    after = E.dropna(subset=['after63'])
    out['after'] = {'all63': summarize(list(after.after63 - after.mkt63), [idx[int(t) + H] for t in after.t], 0.015)}
    for k in ('none', 'results_up', 'results_down', 'insider_buy'):
        g = after[after.drivers.apply(lambda x: k in x)]
        out['after'][f'{k}63'] = summarize(list(g.after63 - g.mkt63), [idx[int(t) + H] for t in g.t], 0.015)
    # for someone already holding: keep through the next 3 months or sell into the jump? Split by the walk-forward Edge
    # rank when the jump ended, at the keep band of the shipped rule; no costs, since holding costs nothing
    rank = _rank_lookup(idx)
    band = _keep_band()
    rk = after.apply(lambda r: rank(r.sym, int(r.t) + H), axis=1)
    for name, m in (('insideKeepHeld63', rk.between(1, band)), ('outsideKeepHeld63', rk > band)):
        g = after[m]
        out['after'][name] = summarize(list(g.after63 - g.mkt63), [idx[int(t) + H] for t in g.t], 0.0)
    out['after']['keepBand'] = band
    # 3) pop odds: fit on the first half, judge on the second, then refit on everything for the live odds
    rows = []
    for t in range(300, N - H, STEP):
        live = _live(fs, t)
        Z, f = features(fs, t, live)
        Z['y'] = C['pops'].iloc[t][live].astype(float).values
        Z['ex'] = C['ex'].iloc[t][live].values
        Z['cost'] = f['spread'].fillna(UNKNOWN_SPREAD).values + COST_FEE
        Z['t'] = t
        rows.append(Z)
    X = pd.concat(rows).dropna(subset=['ex'])
    dates = sorted(X.t.unique()); half = dates[len(dates) // 2]
    tr, te = X[X.t < half], X[X.t >= half]
    w1 = _logit(tr[FEATS].values, tr.y.values)
    te = te.assign(p=_predict(w1, te[FEATS].values))
    base = float(tr.y.mean())
    months = dates[dates.index(half)::4]                        # every 4th 5-day step: non-overlapping 20-day holds
    book = []
    for t in months:
        g = te[te.t == t]
        if len(g) >= 20:
            pk = g.nlargest(5, 'p')
            book.append({'t': t, 'pop': pk.y.mean(), 'crash': float((pk.ex <= -0.20).mean()), 'ex': float((pk.ex.clip(upper=3) - pk.cost).mean()),
                         'allPop': g.y.mean(), 'allCrash': float((g.ex <= -0.20).mean()), 'allEx': float((g.ex.clip(upper=3) - g.cost).mean())})
    B = pd.DataFrame(book)
    w = _logit(X[FEATS].values, X.y.values)
    out['model'] = {
        'feats': FEATS, 'labels': {k: LABELS[k] for k in FEATS}, 'w': [round(float(x), 4) for x in w], 'baseRate': round(float(X.y.mean()) * 100, 2),
        'split': str(idx[half].date()), 'testAUC': round(_auc(te.y.values, te.p.values), 3),
        'testBrier': round(float(((te.p - te.y) ** 2).mean()), 5), 'testBrierBase': round(float(((base - te.y) ** 2).mean()), 5),
        'top5': {'months': len(B), 'popRate': round(float(B['pop'].mean()) * 100, 1), 'crashRate': round(float(B.crash.mean()) * 100, 1),
                 'allPopRate': round(float(B.allPop.mean()) * 100, 1), 'allCrashRate': round(float(B.allCrash.mean()) * 100, 1),
                 'excessAfterCosts': round(float(B.ex.mean()) * 100, 2), 'allExcessAfterCosts': round(float(B.allEx.mean()) * 100, 2),
                 'monthsAhead': round(float((B.ex > 0).mean()) * 100)},
        'top5Odds21': summarize(list(B.ex + 0.0), [idx[int(t)] for t in B.t], 0.0),
    }
    out['explain'] = ('A pop = a stock beating the average JSE stock by 25+ points within 21 trading days, trading on at least half of those days, '
                      'with the bid/ask midpoint up 20%+ where quotes exist. News = announcements from 5 trading days before the rise to its end. '
                      'Pop odds: a model of the chance of a pop in the next 21 trading days, fitted on the first half of history and judged on the second.')
    return out


def today(out, fs, ideas):
    """Live pop odds for every stock, plus the stocks that popped over the last 21 trading days and the news around them."""
    M = ((ideas or {}).get('pops') or {}).get('model')
    if not M:
        return 0
    C = _frames(fs)
    t = fs.N - 1
    live = [s for s in _live(fs, t) if s in out['stocks']]
    Z, _ = features(fs, t, live)
    p = pd.Series(_predict(M['w'], Z[M['feats']].values), index=live)
    rank = p.rank(ascending=False).astype(int)
    for s in live:
        push = {k: Z.at[s, k] * M['w'][1 + M['feats'].index(k)] for k in M['feats']}
        top = [k for k in sorted(push, key=lambda k: -push[k])[:3] if push[k] > 0]
        out['stocks'][s]['pop'] = {'odds': round(float(p[s]) * 100, 1), 'rank': int(rank[s]), 'of': len(live),
                                   'why': [M['labels'][k][0 if Z.at[s, k] > 0 else 1] for k in top]}
    a = t - H
    import recovery
    for s in live:
        g = fs.TRI[s].iloc[t] / fs.TRI[s].iloc[a] - 1
        m = np.nanmean(np.clip((fs.TRI.iloc[t] / fs.TRI.iloc[a] - 1)[C['univ'].iloc[a]].values, -0.9, 3))
        mid0, mid1 = C['D'].MID[s].iloc[a], C['D'].MID[s].iloc[t]
        if g - m >= POP and (pd.isna(mid0) or pd.isna(mid1) or mid1 / mid0 - 1 >= MID_POP):
            since = str(fs.idx[a].date())
            out['stocks'][s]['pop']['recent'] = {'gain': round(float(g) * 100, 1), 'since': since, 'drivers': drivers(fs, s, a, t),
                                                 'news': recovery._news(s, str(fs.idx[max(0, a - 5)].date()))[:6]}
    out['popInfo'] = {k: ideas['pops'][k] for k in ('from', 'to', 'pops', 'stocks', 'medianGain', 'drivers', 'after', 'explain')} | {'model': {k: v for k, v in M.items() if k != 'w'}}
    return len(live)
