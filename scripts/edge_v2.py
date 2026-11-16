"""Edge v2: a second pick ranking that runs next to the original Edge score (factor_study.py) and never replaces it.

Differences from v1:
 - pullback signals use the bid/ask midpoint, so a last trade that happened to hit the bid does not look like a dip
 - signals are grouped into themes (THEMES); each theme gets one vote, weighted by how well it ranked stocks before
 - signs and weights are refit every quarter from rows whose 3-month outcome was already known (walk-forward)
 - adds Timestral's 3-month forecast and company announcements (dividend changes and notices, share issues, insiders)
 - ranks by expected 3-month excess return minus the stock's round-trip cost (quoted spread + fees)
Back-tests buy at the closing ask, sell at the closing bid, pay fees on top and include dividends.

  python scripts/edge_v2.py      -> data/edge_v2.json (live model + back-tests) and data/test_registry.json
  today(out, fs)                 -> stocks[sym].edge2 and edge2Info in forecasts.json (called by forecast.py)
"""
import glob, json, os, sys, warnings
import numpy as np
import pandas as pd
from scipy.stats import spearmanr

sys.path.insert(0, 'scripts')
warnings.filterwarnings('ignore')

HOLD, STEP, OFFSET = 63, 21, 17   # same 21-day grid as backtest_ts.py's forecast origins (130 + 21k)
FEE = 0.005                       # per side, on top of the quoted spread
UNKNOWN_SPREAD = 0.06
MIN_TRAIN_DATES = 12
OVERLAP = np.sqrt(HOLD / STEP)    # 63-day outcomes sampled every 21 days overlap, so t-stats shrink by this
SELECT_T = 2.0
TOP = 10
MIN_TRADED = 0.5
OUT = 'data/edge_v2.json'
TS_CACHE = 'data/ts_hist.json'
TS_ROWS = 'data/forecast_backtest_rows.csv'
LOG = 'data/picks_log_v2.json'

THEMES = {
    'trend': ['mom63', 'mom126', 'mom12_1', 'hi52'],
    'pullback': ['rev5m', 'rev21m', 'bbm'],
    'value': ['ey', 'dy', 'iv_ddm', 'iv_epv', 'bs_bp', 'bs_fcfy', 'bs_ocfy'],
    'earnings': ['growth', 'q_yoy', 'accel', 'fresh_beat', 'no_weak_results'],
    'quality': ['stable', 'noloss', 'divpayer', 'lowvol', 'lottery', 'bs_roe', 'bs_lowdebt', 'bs_netcash', 'bs_cashq', 'bs_margin', 'bs_eq_assets'],
    'trading': ['small', 'turnover', 'turn_surge', 'volsurge', 'illiq'],
    'events': ['div_chg', 'div_notice', 'share_issue', 'insider_net'],
    'forecast': ['fcast'],
}
THEME_LABELS = {'trend': 'Price trend', 'pullback': 'Recent pullback (quote midpoint)', 'value': 'Cheap vs profits & dividends',
                'earnings': 'Profit growth & results', 'quality': 'Steady, sound business', 'trading': 'Size & trading activity',
                'events': 'Company announcements', 'forecast': 'Timestral 3-month forecast'}
EXTRA_LABELS = {'rev5m': 'Pulled back in the last week (midpoint)', 'rev21m': 'Pulled back in the last month (midpoint)',
                'bbm': 'Below its 20-day average (midpoint)', 'div_chg': 'Dividend raised vs a year ago', 'div_notice': 'Board to consider a dividend',
                'share_issue': 'Recent rights issue or new shares', 'insider_net': 'Insiders buying more than selling', 'fcast': 'Timestral 3-month forecast'}

# Each variant switches one upgrade off. 'full' is the version that ships; the rest show what each upgrade adds.
VARIANTS = {
    'full': {},
    'no_forecast': {'drop': ['forecast']},
    'no_events': {'drop': ['events']},
    'no_spread': {'spread': False},
    'last_trade_pullback': {'pullback': ['rev5', 'rev21']},
    'equal_theme_weights': {'equal': True},
    'flat_v1_signals': {'flat': True},
}


class Data:
    """Price, quote, announcement and forecast frames on factor_study's calendar, built once per process."""

    def __init__(self, fs):
        self.fs = fs
        idx, syms = fs.idx, fs.syms
        bid, ask = {}, {}
        for f in sorted(glob.glob('data/detail/*.json')):
            for d, v in json.load(open(f, encoding='utf-8')).items():
                for s, q in (v.get('b') or {}).items():
                    if q and q[0] and q[1] and q[1] >= q[0] > 0:
                        bid.setdefault(s, {})[pd.Timestamp(d)] = q[0]; ask.setdefault(s, {})[pd.Timestamp(d)] = q[1]
        self.BID = pd.DataFrame(bid).reindex(index=idx, columns=syms)
        self.ASK = pd.DataFrame(ask).reindex(index=idx, columns=syms)
        mid = (self.BID + self.ASK) / 2
        self.SPR = (self.ASK - self.BID) / mid
        self.MID = mid.ffill(limit=5)
        self.SPR20 = self.SPR.rolling(20, min_periods=5).median()
        self._events()
        self.FC = self._forecasts()

    def _events(self):
        import events as EV, insiders as INS
        fs = self.fs; idx, syms, N = fs.idx, fs.syms, fs.N
        col = {s: i for i, s in enumerate(syms)}
        chg = np.full((N, len(syms)), np.nan); notice = np.zeros((N, len(syms))); issue = np.zeros((N, len(syms)))
        after = lambda d: int(idx.searchsorted(pd.Timestamp(d), side='right'))   # notices count from the next trading day
        prev = {}
        for e in EV.archive_events():
            s = e['sym']
            if e['kind'] == 'dividend':
                ref = EV.reference_dividend(prev.get(s, []), e) if e.get('amt') else None
                if e.get('amt'):
                    prev.setdefault(s, []).append(e)
                if s in col and ref and ref > 0:
                    a = after(e['date']); chg[a:a + 63, col[s]] = np.clip(e['amt'] / ref - 1, -1, 2)
            elif e['kind'] == 'divcons' and s in col:
                a = after(e['date']); notice[a:a + 21, col[s]] = 1
            elif e['kind'] == 'raise' and s in col:
                a = after(e['date']); issue[a:a + 126, col[s]] = 1
        net = np.zeros((N, len(syms)))
        for e in INS.events():
            if e['sym'] in col and not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell'):
                a = after(e['date'])
                if a < N:
                    net[a, col[e['sym']]] += 1 if e['side'] == 'buy' else -1
        self.EVT = {'div_chg': pd.DataFrame(chg, index=idx, columns=syms), 'div_notice': pd.DataFrame(notice, index=idx, columns=syms),
                    'share_issue': pd.DataFrame(issue, index=idx, columns=syms),
                    'insider_net': pd.DataFrame(net, index=idx, columns=syms).rolling(63, min_periods=1).sum()}

    def _forecasts(self):
        """Timestral's middle 3-month forecast at each back-test origin. The CSV only exists on back-test runs, so a
        compact copy is kept in data/ts_hist.json for the other nights."""
        cache = {}
        if os.path.exists(TS_CACHE):
            cache = json.load(open(TS_CACHE, encoding='utf-8'))
        if os.path.exists(TS_ROWS):
            r = pd.read_csv(TS_ROWS, usecols=['date', 'sym', 'p1_63'])
            for d, g in r.groupby('date'):
                cache[d] = {s: round(float(v), 4) for s, v in zip(g.sym, g.p1_63) if pd.notna(v)}
            json.dump(cache, open(TS_CACHE, 'w'), separators=(',', ':'))
        if not cache:
            return pd.DataFrame(index=self.fs.idx, columns=self.fs.syms, dtype=float)
        fc = pd.DataFrame(cache).T
        fc.index = pd.to_datetime(fc.index)
        return fc.reindex(columns=self.fs.syms).reindex(self.fs.idx).ffill(limit=STEP - 1)

    def extra(self, t, live, fcast=None):
        M = self.MID
        f = pd.DataFrame(index=live)
        f['rev5m'] = -(M.iloc[t][live] / M.iloc[t - 5][live] - 1)
        f['rev21m'] = -(M.iloc[t][live] / M.iloc[t - 21][live] - 1)
        w = M.iloc[t - 19:t + 1][live]
        f['bbm'] = -(M.iloc[t][live] - w.mean()) / w.std().replace(0, np.nan)
        for k, F in self.EVT.items():
            f[k] = F.iloc[t][live]
        f['fcast'] = (fcast.reindex(live) if fcast is not None else self.FC.iloc[t][live]).clip(-0.5, 0.5)
        f['spread'] = self.SPR20.iloc[t][live]
        return f


def build_rows(D):
    fs = D.fs
    df = fs.run(HOLD, STEP, OFFSET)
    parts = []
    for t, g in df.groupby('t'):
        e = D.extra(t, list(g.sym))
        parts.append(pd.concat([g.set_index('sym'), e], axis=1).reset_index().rename(columns={'index': 'sym'}))
    df = pd.concat(parts, ignore_index=True)
    df['ex'] = df.fwd.clip(upper=1.0) - df.groupby('t').fwd.transform(lambda x: x.clip(upper=1.0).mean())
    return df


def zcols(df, feats):
    return pd.DataFrame({k: df.groupby('t')[k].transform(z) for k in feats if k in df}, index=df.index)


def z(x):
    return (x.rank(pct=True) - 0.5).fillna(0)


def themes_for(variant):
    v = VARIANTS[variant]
    th = {k: list(ks) for k, ks in THEMES.items() if k not in v.get('drop', [])}
    if 'pullback' in v:
        th['pullback'] = v['pullback']
    if v.get('flat'):
        import factor_study as fs
        th = {'all': [k for k in fs.FEATURE_LABELS if k != 'bm_proxy_pe_low']}
    return th


def _ic(x, y):
    m = x.notna() & y.notna()
    vc = x[m].value_counts()
    if m.sum() < 15 or len(vc) < 2 or m.sum() - vc.iloc[0] < 3:   # a yes/no flag needs at least 3 stocks off the common value
        return np.nan
    return spearmanr(x[m], y[m]).correlation


def _tstat(ics):
    ics = np.asarray([i for i in ics if pd.notna(i)])
    if len(ics) < 8 or ics.std() == 0:
        return np.nan, len(ics)
    return ics.mean() / (ics.std() / np.sqrt(len(ics))) / OVERLAP, len(ics)


def fit(train, Z, themes, equal=False):
    """Signs, theme weights and a return calibration from rows whose outcome is known."""
    by_t = list(train.groupby('t'))
    signs, stats = {}, {}
    for th, ks in themes.items():
        for k in ks:
            if k not in train:
                continue
            ics = [_ic(g[k], g.fwd) for _, g in by_t]
            tt, n = _tstat(ics)
            if pd.isna(tt):
                continue
            stats[k] = {'ic': round(float(np.nanmean(ics)), 3), 't': round(float(tt), 2), 'n': n}
            if abs(tt) >= SELECT_T:
                signs[k] = int(np.sign(np.nanmean(ics)))
    TS = theme_scores(Z.loc[train.index], themes, signs)
    raw = {}
    for th in TS:
        ics = [_ic(TS.loc[g.index, th], g.fwd) for _, g in by_t]
        m = np.nanmean(ics) if np.isfinite(ics).any() else np.nan
        if pd.notna(m) and m > 0:
            raw[th] = m
    if not raw:
        weights = {}
    elif equal:
        weights = {th: 1 / len(raw) for th in raw}
    else:
        tot = sum(raw.values())
        weights = {th: 0.5 / len(raw) + 0.5 * v / tot for th, v in raw.items()}
    pct = blend(TS, weights).groupby(train.t).rank(pct=True) - 0.5
    ex = train.ex
    m = ex.notna()
    b = float(np.cov(pct[m], ex[m])[0, 1] / pct[m].var()) if weights and pct[m].var() > 0 else 0.0
    buckets = [[int(lo * 100), int(lo * 100 + 20), round(float(ex[(pct + 0.5 > lo) & (pct + 0.5 <= lo + 0.2)].mean()) * 100, 2)] for lo in np.arange(0, 1, 0.2)]
    return {'signs': signs, 'weights': {k: round(float(v), 4) for k, v in weights.items()}, 'slope': round(b, 4), 'buckets': buckets,
            'stats': stats, 'trainDates': len(by_t)}


def theme_scores(Z, themes, signs):
    out = {}
    for th, ks in themes.items():
        sel = [k for k in ks if k in signs and k in Z]
        if sel:
            out[th] = sum(Z[k] * signs[k] for k in sel) / len(sel)
    return pd.DataFrame(out, index=Z.index)


def blend(TS, weights):
    return sum(TS[th] * w for th, w in weights.items() if th in TS) if weights else pd.Series(0.0, index=TS.index)


def score(g, Zg, model, themes, spread=True):
    """Rank one day's stocks. Returns a frame with score (0–100), exp/cost/net (fractions) and theme percentiles."""
    TS = theme_scores(Zg, themes, model['signs'])
    b = blend(TS, model['weights'])
    pct = b.rank(pct=True)
    exp = model['slope'] * (pct - 0.5)
    cost = g.spread.fillna(UNKNOWN_SPREAD) + 2 * FEE
    out = pd.DataFrame({'sym': g.sym.values, 'score': (pct * 100).values, 'exp': exp.values, 'cost': cost.values,
                        'net': (exp - cost).values, 'traded': g.traded.values}, index=g.index)
    out['key'] = out.net if spread else out.score
    for th in TS:
        out['th_' + th] = (TS[th].rank(pct=True) * 100).values
    return out


def walk(df, Z, variant):
    """Quarterly walk-forward: at each date the model is the latest one fit on rows whose outcome was already known."""
    v = VARIANTS[variant]; themes = themes_for(variant)
    dates = sorted(df.t.unique())
    ranks, model, fit_at = {}, None, None
    for T in dates:
        known = df.t + 1 + HOLD + 1 <= T
        if df[known].t.nunique() < MIN_TRAIN_DATES:
            continue
        if model is None or T - fit_at >= HOLD:
            model, fit_at = fit(df[known], Z, themes, v.get('equal', False)), T
        g = df[df.t == T]
        s = score(g, Z.loc[g.index], model, themes, v.get('spread', True))
        ranks[T] = list(s.sort_values('key', ascending=False).sym)
    return ranks


def v1_ranks(df, Z, chosen):
    e = sum(Z[k] * s for k, s in chosen.items())
    return {t: list(df.loc[g.index].assign(e=e[g.index]).sort_values('e', ascending=False).sym) for t, g in df.groupby('t')}


def simulate(D, df, ranks, top=TOP, lag=0, fee=FEE, honest=True):
    """Hold the top-N for 63 days in three interleaved sequences. New names are bought at the closing ask and exits sold
    at the closing bid; names kept into the next period are marked at the close. Returns one row per period."""
    fs = D.fs; P, TRI, N = fs.P, fs.TRI, fs.N
    dates = sorted(t for t in df.t.unique() if t in ranks)
    elig = {t: set(g[g.traded >= MIN_TRADED].sym) for t, g in df.groupby('t')}
    rows = []
    for k in range(3):
        seq = [t for t in dates if (t - dates[0]) % HOLD == k * STEP] if dates else []
        picks = []
        for t in seq:
            e = t + 1 + lag
            ok = [s for s in ranks[t] if s in elig[t] and (not honest or D.ASK.iloc[e][s] > 0)] if e + HOLD < N else []
            picks.append(ok[:top] if len(ok) >= top else None)
        for i, t in enumerate(seq):
            pk = picks[i]
            if pk is None:
                continue
            e = t + 1 + lag; x = e + HOLD
            prev = set(picks[i - 1] or []) if i else set()
            nxt = set(picks[i + 1] or []) if i + 1 < len(picks) else set()
            r = []
            for s in pk:
                gross = TRI.iloc[x][s] / TRI.iloc[e][s]
                new, leaving = s not in prev, s not in nxt
                if honest and new:
                    gross *= P.iloc[e][s] / D.ASK.iloc[e][s]
                if honest and leaving:
                    bid = D.BID.iloc[x][s]
                    if not bid > 0:
                        sp = D.SPR20.iloc[x][s]
                        bid = P.iloc[x][s] * (1 - (sp if pd.notna(sp) else UNKNOWN_SPREAD))
                    gross *= bid / P.iloc[x][s]
                r.append(min(gross - 1, 1.0) - fee * new - fee * leaving)
            g = df[(df.t == t) & df.sym.isin(elig[t])]
            mk = float((TRI.iloc[x][g.sym] / TRI.iloc[e][g.sym] - 1).clip(upper=1.0).mean())
            rows.append({'t': t, 'seq': k, 'ret': float(np.mean(r)), 'mkt': mk})
    return pd.DataFrame(rows)


def summary(sim, idx, frm=None):
    s = sim if frm is None else sim[sim.t >= frm]
    if len(s) < 3:
        return None
    ann = lambda a: (np.prod(1 + a) ** ((252 / HOLD) / len(a)) - 1) * 100
    per = [(ann(g.ret.values), ann(g.mkt.values)) for _, g in s.groupby('seq') if len(g) >= 2]
    ex = s.ret - s.mkt
    half = sorted(s.t.unique())[len(s.t.unique()) // 2]
    t = ex.mean() / (ex.std() / np.sqrt(len(ex))) / np.sqrt(3) if ex.std() > 0 else 0   # the 3 sequences overlap
    return {'from': str(idx[s.t.min()].date()), 'to': str(idx[s.t.max()].date()), 'periods': int(len(s) / 3 + 0.5),
            'annNet': round(float(np.mean([p[0] for p in per])), 1), 'annMarket': round(float(np.mean([p[1] for p in per])), 1),
            'avgExcess': round(float(ex.mean()) * 100, 2), 'beatPct': round(float((ex > 0).mean()) * 100), 't': round(float(t), 2),
            'firstHalf': round(float(ex[s.t < half].mean()) * 100, 2), 'secondHalf': round(float(ex[s.t >= half].mean()) * 100, 2),
            'worstPeriod': round(float(s.ret.min()) * 100, 1)}


def study():
    import factor_study as fs
    D = Data(fs)
    df = build_rows(D)
    feats = sorted({k for ks in THEMES.values() for k in ks} | set(fs.FEATURE_LABELS) | {'rev5', 'rev21'})
    Z = zcols(df, feats)
    idx = fs.idx
    v1 = json.load(open('data/factor_study.json', encoding='utf-8'))
    split = idx.get_loc(pd.Timestamp(v1['h63']['split']))
    r1 = v1_ranks(df, Z, v1['h63']['chosen'])
    res = {'v1': {'close': summary(simulate(D, df, r1, honest=False, fee=0.01), idx, split),
                  'honest': summary(simulate(D, df, r1), idx, split), 'honestSkipDay': summary(simulate(D, df, r1, lag=1), idx, split)}}
    for name in VARIANTS:
        rk = walk(df, Z, name)
        sim = simulate(D, df, rk)
        res[name] = {'walk': summary(sim, idx), 'common': summary(sim, idx, split)}
        if name == 'full':
            res[name]['honestSkipDay'] = summary(simulate(D, df, rk, lag=1), idx, split)
            res[name]['top5'] = summary(simulate(D, df, rk, top=5), idx, split)
        print(name, json.dumps(res[name]))
    print('v1', json.dumps(res['v1']))
    known = df.t + 1 + HOLD + 1 <= fs.N - 1
    model = fit(df[known], Z, THEMES)
    out = {'made': str(idx[-1].date()), 'hold': HOLD, 'fee': FEE, 'step': STEP, 'selectT': SELECT_T,
           'basis': 'buy at the closing ask, sell at the closing bid, 0.5% fees each side, dividends included, top 10 held 3 months',
           'v1Split': str(idx[split].date()), 'model': model, 'themes': THEMES, 'results': res,
           'forecastOrigins': int(D.FC.dropna(how='all').index.nunique()) if len(D.FC) else 0}
    json.dump(out, open(OUT, 'w', encoding='utf-8'), indent=1, default=float)
    import test_registry
    test_registry.update(out)
    return out


def today(out, fs):
    """Score every stock with the saved v2 model on the latest close. Writes into `out` (forecasts.json)."""
    S = json.load(open(OUT, encoding='utf-8'))
    model = S['model']
    D = Data(fs)
    t = fs.N - 1
    live = [s for s in fs.syms if fs.first[s] is not None and fs.idx.get_loc(fs.first[s]) <= t - 130 and fs.P[s].iloc[t] > 0
            and (fs.V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2]
    fc = pd.Series({s: st['q'][-1][10] / st['close'] - 1 for s, st in out.get('stocks', {}).items() if st.get('q') and st.get('close')})
    f = pd.concat([fs.features(t).loc[live], D.extra(t, live, fc)], axis=1)
    f['t'] = t; f['sym'] = live
    f = f.reset_index(drop=True)
    Zt = zcols(f, [k for ks in THEMES.values() for k in ks])
    s = score(f, Zt, model, THEMES).set_index('sym')
    ranked = s[s.traded >= MIN_TRADED].sort_values('net', ascending=False)
    rank = {k: i + 1 for i, k in enumerate(ranked.index)}
    spread = f.set_index('sym').spread
    for k, r in s.iterrows():
        if k not in out['stocks']:
            continue
        out['stocks'][k]['edge2'] = {'score': round(float(r.score)), 'rank': rank.get(k), 'of': len(ranked),
                                     'exp': round(float(r.exp) * 100, 1), 'cost': round(float(r.cost) * 100, 1), 'net': round(float(r.net) * 100, 1),
                                     'spread': None if pd.isna(spread[k]) else round(float(spread[k]) * 100, 1),
                                     'themes': {th[3:]: round(float(r[th])) for th in s.columns if th.startswith('th_') and pd.notna(r[th])}}
    labels = {**fs.FEATURE_LABELS, **EXTRA_LABELS}
    R = S['results']
    import test_registry
    reg = test_registry._load(test_registry.PATH, {}).get('summary', {})
    out['edge2Info'] = {
        'fitTo': S['made'], 'basis': S['basis'], 'v1Split': S['v1Split'],
        'themes': {th: {'label': THEME_LABELS[th], 'weight': model['weights'].get(th, 0),
                        'signals': [{'key': k, 'label': labels.get(k, k), 'sign': model['signs'][k], **model['stats'].get(k, {})} for k in ks if k in model['signs']]}
                   for th, ks in THEMES.items()},
        'calib': model['buckets'], 'slope': model['slope'],
        'compare': {'v1Close': R['v1']['close'], 'v1': R['v1']['honest'], 'v2': R['full']['common'], 'v2Walk': R['full']['walk'],
                    'v1SkipDay': R['v1']['honestSkipDay'], 'v2SkipDay': R['full'].get('honestSkipDay'), 'v2Top5': R['full'].get('top5')},
        'ablations': {k: R[k]['common'] for k in VARIANTS if k != 'full' and k in R},
        'registry': reg,
    }
    import track_record as tr
    out['edge2Info']['track'] = tr.update(out, fs, key='edge2', log=LOG)
    return out


if __name__ == '__main__':
    study()
