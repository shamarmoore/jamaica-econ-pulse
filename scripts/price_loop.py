"""Research loop for a better point price than Timestral's middle, in the style of RD-Agent: each hypothesis is a
small predictor, scored walk-forward on data/picker_cases.csv.gz and logged, kept or not, in data/price_loop.json.

A hypothesis is fit(tr, te) -> predicted price / c0 for the te rows. tr holds only cases whose real price was known
before the decision day; te carries no real price at all, so a hypothesis cannot peek even by mistake.
Development scores use origins before 2025-01-01. --final scores the named hypotheses once on origins from 2025.
Usage: python scripts/price_loop.py [name ...] [--final]"""
import json, sys
from types import SimpleNamespace
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingRegressor

sys.path.insert(0, 'scripts')
from tslib import LEVELS
from price_picker import train_mask

HS = (21, 63)
MIN_TRAIN = 2000
HOLDOUT = pd.Timestamp('2025-01-01')
MID = int(np.flatnonzero(LEVELS == 0.5)[0])
FEATS = ['traded', 'stale', 'vol60', 'mom21', 'mom126', 'hype', 'health']
GRID = np.linspace(0, 1.5, 31)


def at_level(Qr, tau):
    """Price ratio at quantile level tau (scalar or per row), interpolated inside each row's range."""
    pos = np.interp(np.broadcast_to(tau, len(Qr)), LEVELS, np.arange(len(LEVELS)))
    lo = np.minimum(pos.astype(int), len(LEVELS) - 2)
    f = pos - lo
    r = np.arange(len(Qr))
    return Qr[r, lo] * (1 - f) + Qr[r, lo + 1] * f


def pit(Qr, y):
    """Where each real price fell inside its range, as a quantile level."""
    return np.array([np.interp(v, q, LEVELS) for q, v in zip(Qr, y)])


def best_grid(errs):
    return GRID[int(np.argmin([e.mean() for e in errs]))]


def h_middle(tr, te):
    return te.m


def h_shrink(tr, te):
    """Thin stocks often don't move: pull the middle toward today's price by a learned power."""
    w = best_grid([np.abs(tr.m ** g - tr.y) for g in GRID])
    return te.m ** w


def h_blend(tr, te):
    """Zero-parameter: halfway between the middle and no change."""
    return np.sqrt(te.m)


def h_pit(tr, te):
    """If the real price sits off-centre in the range, use the level where it typically lands."""
    return at_level(te.Qr, np.median(pit(tr.Qr, tr.y)))


def h_pit_recent(tr, te):
    """Same, from the last ~250 trading days of known outcomes only: the JSE's trend changes by regime."""
    recent = tr.df['o'].to_numpy() >= tr.df['o'].max() - 250
    return at_level(te.Qr, np.median(pit(tr.Qr[recent], tr.y[recent])))


def h_pit_liquidity(tr, te):
    """A separate typical level for each liquidity third: frozen thin stocks land in a different place."""
    cuts = np.quantile(tr.df['traded'], [1 / 3, 2 / 3])
    btr, bte = np.digitize(tr.df['traded'], cuts), np.digitize(te.df['traded'], cuts)
    p = pit(tr.Qr, tr.y)
    lv = {b: np.median(p[btr == b]) for b in range(3)}
    return at_level(te.Qr, np.array([lv[b] for b in bte]))


def h_stock_bias(tr, te):
    """A stock's own past misses persist: shift by its median log(real / middle), shrunk toward 0 by case count."""
    g = pd.DataFrame({'sym': tr.df['sym'].to_numpy(), 'e': np.log(tr.y / tr.m)}).groupby('sym')['e'].agg(['median', 'size'])
    shift = (g['median'] * g['size'] / (g['size'] + 20)).reindex(te.df['sym']).fillna(0).to_numpy()
    return te.m * np.exp(shift)


def h_direct_median(tr, te):
    """Fit the closeness itself: gradient boosting on log(real / today) with absolute error loss, any price, not 22 slots."""
    def X(s):
        return np.column_stack([s.df[FEATS].to_numpy(float), np.log(s.m), np.log(s.Qr[:, 18] / np.maximum(s.Qr[:, 2], 1e-6))])
    reg = HistGradientBoostingRegressor(loss='absolute_error', max_iter=200, learning_rate=0.05, max_leaf_nodes=15,
                                        min_samples_leaf=50, random_state=0).fit(X(tr), np.log(tr.y))
    return np.exp(reg.predict(X(te)))


def h_shrink_liquidity(tr, te):
    """Round 2, from shrink's near-miss: thin stocks freeze more, so each liquidity third gets its own pull."""
    cuts = np.quantile(tr.df['traded'], [1 / 3, 2 / 3])
    btr, bte = np.digitize(tr.df['traded'], cuts), np.digitize(te.df['traded'], cuts)
    w = {b: best_grid([np.abs(tr.m[btr == b] ** g - tr.y[btr == b]) for g in GRID]) for b in range(3)}
    return te.m ** np.array([w[b] for b in bte])


def h_clip_move(tr, te):
    """Round 2: Timestral's big predicted moves are the least reliable, so cap the middle's move at a learned size."""
    caps = np.linspace(0.01, 0.5, 50)
    c = caps[int(np.argmin([np.abs(np.exp(np.clip(np.log(tr.m), -k, k)) - tr.y).mean() for k in caps]))]
    return np.exp(np.clip(np.log(te.m), -c, c))


def h_reversal(tr, te):
    """Round 2: on the JSE a stock tends to give back its last month's move (the only lag effect found), which Timestral may miss."""
    bs = np.linspace(-0.5, 0.5, 41)
    mom = lambda s: np.nan_to_num(np.log1p(s.df['mom21'].to_numpy(float)))
    b = bs[int(np.argmin([np.abs(tr.m * np.exp(-k * mom(tr)) - tr.y).mean() for k in bs]))]
    return te.m * np.exp(-b * mom(te))


def h_dividend(tr, te):
    """Round 3, new information: a dividend announced by the origin day that goes ex inside the window drops the price
    by about its size, and Timestral cannot know it is scheduled. Learn what share of that yield to take off."""
    bs = np.linspace(0, 1.5, 31)
    b = bs[int(np.argmin([np.abs(tr.m * (1 - k * tr.df['divy'].to_numpy()) - tr.y).mean() for k in bs]))]
    return te.m * (1 - b * te.df['divy'].to_numpy())


def h_shrink_dividend(tr, te):
    """Round 3: shrink's pull toward today's price, then the announced dividend, each learned on the same training cases."""
    w = best_grid([np.abs(tr.m ** g - tr.y) for g in GRID])
    tr2 = SimpleNamespace(df=tr.df, m=tr.m ** w, y=tr.y)
    return h_dividend(tr2, SimpleNamespace(df=te.df, m=te.m ** w))


HYPOTHESES = {f.__name__[2:]: f for f in (h_middle, h_shrink, h_blend, h_pit, h_pit_recent, h_pit_liquidity, h_stock_bias, h_direct_median,
                                          h_shrink_liquidity, h_clip_move, h_reversal, h_dividend, h_shrink_dividend)}


def add_dividend_yield(df):
    """Per case and horizon: dividends announced on or before the origin day with an ex-date after it and on or before
    the window's last day, as a share of the origin price (J$, split-adjusted like the prices)."""
    import events
    from tslib import FX_TO_JMD
    divs = [e for e in events.archive_events() if e['kind'] == 'dividend' and e.get('ex') and e.get('amt')]
    by_sym = {}
    for e in divs:
        by_sym.setdefault(e['sym'], []).append(e)
    for h in HS:
        # the window's last trading day is calendar knowledge, not the answer; open windows have no outcome to score
        end = df[f'known{h}'].fillna('9999-12-31')
        y = np.zeros(len(df))
        for i, (sym, d, last, c0) in enumerate(zip(df['sym'], df['date'], end, df['c0'])):
            for e in by_sym.get(sym, []):
                if e['date'] <= d < e['ex'] <= last:
                    amt = e['amt'] / events.split_factor(events.SPLITS, sym, e['ex'], '9999-12-31')
                    fx = FX_TO_JMD.get(e['cur'], 1.0)
                    v = amt * fx / c0
                    y[i] += amt / c0 if v > 0.3 else v  # an absurd J$ yield means the share is quoted in that currency
        df[f'divy{h}'] = y
    return df


def split(df, h, mask, with_y):
    q = df[[f'q{h}_{k}' for k in range(len(LEVELS))]].to_numpy(float)[mask]
    c0 = df['c0'].to_numpy(float)[mask]
    Qr = np.sort(q / c0[:, None], axis=1)
    s = SimpleNamespace(df=df.loc[mask, ['o', 'sym', *FEATS]].assign(divy=df.loc[mask, f'divy{h}']).reset_index(drop=True), Qr=Qr, m=Qr[:, MID])
    if with_y:
        s.y = df[f'act{h}'].to_numpy(float)[mask] / c0
    return s


def walk(df, h, names, final):
    dates = pd.to_datetime(df['date'])
    has_y = df[f'act{h}'].notna().to_numpy()
    rows = []
    for d in sorted(dates.unique()):
        if (d >= HOLDOUT) != final:
            continue
        tr = train_mask(df[f'known{h}'], d) & has_y
        te = (dates == d).to_numpy() & has_y
        if tr.sum() < MIN_TRAIN or not te.any():
            continue
        TR, TE = split(df, h, tr, True), split(df, h, te, False)
        y = df[f'act{h}'].to_numpy(float)[te] / df['c0'].to_numpy(float)[te]
        for n in names:
            err = np.abs(HYPOTHESES[n](TR, TE) - y) * 100
            rows.append({'date': d, 'name': n, 'err': err.mean(), 'n': len(err), 'errs': err})
    return pd.DataFrame(rows)


def score(r, h):
    out = {}
    base = r[r.name == 'middle'].set_index('date')['err']
    for n, g in r.groupby('name'):
        e = np.concatenate(g['errs'].to_list())
        res = {'mean': round(float(e.mean()), 3), 'median': round(float(np.median(e)), 3), 'n': int(len(e)), 'origins': int(len(g))}
        if n != 'middle':
            diff = g.set_index('date')['err'] - base
            half = len(diff) // 2
            t = diff.mean() / (diff.std(ddof=1) / np.sqrt(len(diff))) / np.sqrt(h / 10)  # origins 10 days apart overlap over h days
            fh, sh = diff.iloc[:half].mean(), diff.iloc[half:].mean()
            res.update({'vsMiddle': round(float(diff.mean()), 3), 't': round(float(t), 2), 'firstHalf': round(float(fh), 3), 'secondHalf': round(float(sh), 3),
                        'verdict': 'better' if t <= -3 and fh < 0 and sh < 0 else 'worse' if t >= 3 and fh > 0 and sh > 0 else 'not proven'})
        out[n] = res
    return out


if __name__ == '__main__':
    final = '--final' in sys.argv
    names = [a for a in sys.argv[1:] if not a.startswith('--')] or list(HYPOTHESES)
    names = ['middle'] + [n for n in names if n != 'middle']
    df = add_dividend_yield(pd.read_csv('data/picker_cases.csv.gz'))
    res = {str(h): score(walk(df, h, names, final), h) for h in HS}
    path = 'data/price_loop.json'
    try:
        log = json.load(open(path))
    except FileNotFoundError:
        log = {'holdoutFrom': str(HOLDOUT.date()), 'development': {}, 'final': {}}
    for h, v in res.items():
        log['final' if final else 'development'].setdefault(h, {}).update(v)
    json.dump(log, open(path, 'w'), indent=1)
    for h, v in res.items():
        print(f'== {h} trading days ({"hold-out 2025+" if final else "development, before 2025"})')
        for n, s in v.items():
            print(f"  {n:15} mean {s['mean']:6.2f}  median {s['median']:6.2f}" + (f"  vs middle {s['vsMiddle']:+.2f}  t {s['t']:+.2f}  halves {s['firstHalf']:+.2f}/{s['secondHalf']:+.2f}  {s['verdict']}" if 'verdict' in s else f"  n {s['n']} origins {s['origins']}"))
