"""Edge: the app's one stock score. It ranks every JSE stock, drives the buy list, the keep-or-sell review and the
phone alerts. (It began as "Edge v2" next to the original score in factor_study.py, which is now only a baseline.)

Differences from the original score (v1):
 - pullback signals use the bid/ask midpoint, so a last trade that happened to hit the bid does not look like a dip
 - signals are grouped into themes (THEMES); each theme gets one vote, weighted by how well it ranked stocks before
 - signs and weights are refit every quarter from rows whose 3-month outcome was already known (walk-forward)
 - adds Timestral's 3-month forecast and company announcements (dividend changes and notices, share issues, insiders)
 - ranks by expected 3-month excess return minus the stock's round-trip cost (quoted spread + fees)
Back-tests pay the quoted spread (or leave limit orders, RULES), fees on top, and include dividends. RULES holds every
way of trading the ranking that was tried; SHIP is the one the app tells you to follow.

  python scripts/edge_v2.py      -> data/edge_v2.json (live model + back-tests), data/edge_hist.json (walk-forward score
                                    history for chance_model.py and asymmetry.py) and data/test_registry.json
  today(out, fs)                 -> stocks[sym].edge and edgeInfo in forecasts.json (called by forecast.py)
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
LIMIT_DAYS = 5                    # a limit order is left this many trading days before crossing the spread
MIN_TRAIN_DATES = 12
OVERLAP = np.sqrt(HOLD / STEP)    # 63-day outcomes sampled every 21 days overlap, so t-stats shrink by this
SELECT_T = 2.0
TOP = 10
MIN_TRADED = 0.5
OUT = 'data/edge_v2.json'
TS_CACHE = 'data/ts_hist.json'
TS_ROWS = 'data/forecast_backtest_rows.csv'
LOG = 'data/picks_log_v2.json'
HIST = 'data/edge_hist.json'

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
                'share_issue': 'Recent rights issue or new shares', 'insider_net': 'Insiders buying more than selling', 'fcast': 'Timestral 3-month forecast',
                'iv_rel': 'Below the price similar JSE companies trade at', 'ey_avg8': 'Cheap vs normal profits (8-quarter average)'}

# Each variant switches one upgrade off (or adds one). 'full' is the version that ships; the rest show what each part adds.
VARIANTS = {
    'full': {},
    'no_forecast': {'drop': ['forecast']},
    'no_events': {'drop': ['events']},
    'no_spread': {'spread': False},
    'last_trade_pullback': {'pullback': ['rev5', 'rev21']},
    'equal_theme_weights': {'equal': True},
    'flat_v1_signals': {'flat': True},
    'with_relative_value': {'add': {'value': ['iv_rel']}},
    'with_normalized_pe': {'add': {'value': ['ey_avg8']}},
}

# How the top of the ranking is bought, kept and sold. Every rule tried stays listed so the test registry counts it.
# top: how many to hold; keep: a holding stays while it ranks within the top `keep`; fill: see _trade; every: days between reviews
RULES = {
    'top10_cross': {},
    'top10_mid': {'fill': 'mid'},
    'top10_join': {'fill': 'join'},
    'top10_keep20': {'keep': 20},
    'top10_keep30': {'keep': 30},
    'top10_monthly_keep20': {'every': 21, 'keep': 20},
    'top10_mid_keep20': {'fill': 'mid', 'keep': 20},
    'top10_mid_keep30': {'fill': 'mid', 'keep': 30},
    'top7_mid_keep20': {'top': 7, 'fill': 'mid', 'keep': 20},
    'top5_cross': {'top': 5},
    'top5_cross_keep20': {'top': 5, 'keep': 20},
    'top5_mid': {'top': 5, 'fill': 'mid'},
    'top5_mid_keep10': {'top': 5, 'fill': 'mid', 'keep': 10},
    'top5_mid_keep15': {'top': 5, 'fill': 'mid', 'keep': 15},
    'top5_mid_keep20': {'top': 5, 'fill': 'mid', 'keep': 20},
    'top5_mid_keep25': {'top': 5, 'fill': 'mid', 'keep': 25},
    'top5_mid_keep30': {'top': 5, 'fill': 'mid', 'keep': 30},
}
# The best of RULES on buys made before 2026; 2026 is reported on its own. Keep bands 15 to 30 land within a few points
# of it, so the band is not a lucky setting.
SHIP = 'top5_mid_keep20'


class Data:
    """Price, quote, announcement and forecast frames on factor_study's calendar, built once per process."""

    def __init__(self, fs):
        self.fs = fs
        idx, syms = fs.idx, fs.syms
        self.col = {s: i for i, s in enumerate(syms)}
        bid, ask, hi, lo = {}, {}, {}, {}
        for f in sorted(glob.glob('data/detail/*.json')):
            for d, v in json.load(open(f, encoding='utf-8')).items():
                for s, q in (v.get('b') or {}).items():
                    if q and q[0] and q[1] and q[1] >= q[0] > 0:
                        bid.setdefault(s, {})[pd.Timestamp(d)] = q[0]; ask.setdefault(s, {})[pd.Timestamp(d)] = q[1]
                    if q and len(q) > 3 and q[2] and q[3] and q[2] >= q[3] > 0:   # the day's range is only printed on days it traded
                        hi.setdefault(s, {})[pd.Timestamp(d)] = q[2]; lo.setdefault(s, {})[pd.Timestamp(d)] = q[3]
        self.BID = pd.DataFrame(bid).reindex(index=idx, columns=syms)
        self.ASK = pd.DataFrame(ask).reindex(index=idx, columns=syms)
        self.HI = pd.DataFrame(hi).reindex(index=idx, columns=syms)
        self.LO = pd.DataFrame(lo).reindex(index=idx, columns=syms)
        import tslib
        for s, day, k in tslib.splits():   # quotes before a split on the same footing as the split-adjusted closes
            if s in self.col:
                for F in (self.BID, self.ASK, self.HI, self.LO):
                    F.loc[F.index < day, s] /= k
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
        f['iv_rel'] = self.fs.MOS_REL.iloc[t][live]
        f['ey_avg8'] = (self.fs.NORM_E.iloc[t][live] * self.fs.fx[live] / self.fs.MCAP.iloc[t][live]).clip(-0.5, 0.5)
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
    for k, extra in v.get('add', {}).items():
        th[k] = th[k] + extra
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
    """Quarterly walk-forward: at each date the model is the latest one fit on rows whose outcome was already known.
    Returns {day index: that day's scored frame (see score), best first}."""
    v = VARIANTS[variant]; themes = themes_for(variant)
    dates = sorted(df.t.unique())
    scored, model, fit_at = {}, None, None
    for T in dates:
        known = df.t + 1 + HOLD + 1 <= T
        if df[known].t.nunique() < MIN_TRAIN_DATES:
            continue
        if model is None or T - fit_at >= HOLD:
            model, fit_at = fit(df[known], Z, themes, v.get('equal', False)), T
        g = df[df.t == T]
        scored[T] = score(g, Z.loc[g.index], model, themes, v.get('spread', True)).sort_values('key', ascending=False)
    return scored


def order(scored):
    return {t: list(s.sym) for t, s in scored.items()}


def v1_ranks(df, Z, chosen):
    e = sum(Z[k] * s for k, s in chosen.items())
    return {t: list(df.loc[g.index].assign(e=e[g.index]).sort_values('e', ascending=False).sym) for t, g in df.groupby('t')}


def _quote(D, side, d, s):
    """Closing ask (buy) or bid (sell) on day d; when the quote is missing, the close moved by the stock's usual spread."""
    q = (D.ASK if side == 'buy' else D.BID).iat[d, D.col[s]]
    if q > 0:
        return q
    sp = D.SPR20.iat[d, D.col[s]]
    sp = sp if pd.notna(sp) else UNKNOWN_SPREAD
    return D.fs.P.iat[d, D.col[s]] * (1 + sp if side == 'buy' else 1 - sp)


def _limit(D, side, fill, d, s):
    """Limit price set from day d's closing quotes: the midpoint ('mid'), or the bid for a buy and the ask for a sell ('join')."""
    c = D.col[s]; b, a = D.BID.iat[d, c], D.ASK.iat[d, c]
    if not (b > 0 and a >= b):
        return None
    return (b + a) / 2 if fill == 'mid' else (b if side == 'buy' else a)


def _trade(D, side, s, start, quote_day, fill):
    """Multiplier on the close-to-close return for trading s around day `start` (buy: on TRI[x]/TRI[start]; sell: on the
    value at the close of `start`). 'close' trades at the close, 'cross' at the closing ask (buy) or bid (sell). 'mid' and
    'join' leave a limit order for LIMIT_DAYS days; it fills on the first day the stock trades through the limit (strictly
    below it for a buy, above it for a sell, so a queue at the limit price never counts as a fill), otherwise the order
    crosses the spread at the close of the last day."""
    if fill == 'close':
        return 1.0
    P, TRI, N, c = D.fs.P, D.fs.TRI, D.fs.N, D.col[s]
    if fill == 'cross':
        q = _quote(D, side, start, s)
        return P.iat[start, c] / q if side == 'buy' else q / P.iat[start, c]
    L = _limit(D, side, fill, quote_day, s)
    last = min(start + LIMIT_DAYS, N) - 1
    for d in range(start, last + 1):
        if L and ((D.LO.iat[d, c] < L) if side == 'buy' else (D.HI.iat[d, c] > L)):
            px = L
            break
    else:
        d, px = last, _quote(D, side, last, s)
    drift = TRI.iat[d, c] / TRI.iat[start, c]
    return P.iat[d, c] / px / drift if side == 'buy' else drift * px / P.iat[d, c]


def simulate(D, df, ranks, top=TOP, lag=0, fee=FEE, fill='cross', keep=None, every=HOLD, log=None):
    """Hold the top-N in interleaved sequences that re-pick every `every` days (63: three sequences a month apart).
    New names are bought and exits sold per `fill` (see _trade); names kept into the next period are marked at the close.
    keep: a holding stays while it ranks within the top `keep` (default: only while in the top N). Returns one row per period;
    `log`, if given, gets one (day, sym, net return) per holding per period."""
    fs = D.fs; P, TRI, N = fs.P, fs.TRI, fs.N
    keep = keep or top
    dates = sorted(t for t in df.t.unique() if t in ranks)
    elig = {t: set(g[g.traded >= MIN_TRADED].sym) for t, g in df.groupby('t')}
    rows = []
    for k in range(every // STEP):
        seq = [t for t in dates if (t - dates[0]) % every == k * STEP] if dates else []
        picks, held = [], []
        for t in seq:
            e = t + 1 + lag
            ok = [s for s in ranks[t] if s in elig[t] and (fill == 'close' or D.ASK.iat[e, D.col[s]] > 0)] if e + every < N else []
            if len(ok) < top:
                picks.append(None); held = []
                continue
            kept = [s for s in held if s in ok[:keep]]
            held = kept + [s for s in ok if s not in kept][:top - len(kept)]
            picks.append(held)
        for i, t in enumerate(seq):
            pk = picks[i]
            if pk is None:
                continue
            e = t + 1 + lag; x = e + every
            prev = set(picks[i - 1] or []) if i else set()
            nxt = set(picks[i + 1] or []) if i + 1 < len(picks) else set()
            r = []
            for s in pk:
                c = D.col[s]
                gross = TRI.iat[x, c] / TRI.iat[e, c]
                new, leaving = s not in prev, s not in nxt
                if new:
                    gross *= _trade(D, 'buy', s, e, t, fill)
                if leaving:
                    gross *= _trade(D, 'sell', s, x, x - 1, fill)
                r.append(min(gross - 1, 1.0) - fee * new - fee * leaving)
                if log is not None:
                    log.append((t, s, r[-1]))
            g = df[(df.t == t) & df.sym.isin(elig[t])]
            mk = float((TRI.iloc[x][g.sym] / TRI.iloc[e][g.sym] - 1).clip(upper=1.0).mean())
            rows.append({'t': t, 'seq': k, 'days': every, 'ret': float(np.mean(r)), 'mkt': mk,
                         'turn': len(set(pk) - prev) / top})
    return pd.DataFrame(rows)


def summary(sim, idx, frm=None, to=None):
    s = sim if frm is None else sim[sim.t >= frm]
    s = s if to is None else s[s.t < to]
    if len(s) < 3:
        return None
    days = int(s.days.iloc[0]); nseq = s.seq.nunique()
    ann = lambda a: (np.prod(1 + a) ** ((252 / days) / len(a)) - 1) * 100
    per = [(ann(g.ret.values), ann(g.mkt.values)) for _, g in s.groupby('seq') if len(g) >= 2]
    ex = s.ret - s.mkt
    half = sorted(s.t.unique())[len(s.t.unique()) // 2]
    t = ex.mean() / (ex.std() / np.sqrt(len(ex))) / np.sqrt(nseq) if ex.std() > 0 else 0   # interleaved sequences overlap
    return {'from': str(idx[s.t.min()].date()), 'to': str(idx[s.t.max()].date()), 'periods': int(len(s) / nseq + 0.5),
            'turnover': round(float(s.turn.mean()) * 100),
            'annNet': round(float(np.mean([p[0] for p in per])), 1), 'annMarket': round(float(np.mean([p[1] for p in per])), 1),
            'avgExcess': round(float(ex.mean()) * 100, 2), 'beatPct': round(float((ex > 0).mean()) * 100), 't': round(float(t), 2),
            'firstHalf': round(float(ex[s.t < half].mean()) * 100, 2), 'secondHalf': round(float(ex[s.t >= half].mean()) * 100, 2),
            'worstPeriod': round(float(s.ret.min()) * 100, 1)}


def windows(sim, idx, split, y26):
    """The same back-test over the whole walk-forward, the window v1 never saw, and buys before / since 2026."""
    return {'walk': summary(sim, idx), 'common': summary(sim, idx, split),
            'pre2026': summary(sim, idx, split, y26), 'since2026': summary(sim, idx, y26)}


def fill_rates(D, df):
    """How often a limit order at the quote midpoint fills within LIMIT_DAYS, over every buy and sell the grid could make."""
    n = first = filled = 0
    for t, g in df.groupby('t'):
        if t + 1 + HOLD + LIMIT_DAYS >= D.fs.N:
            continue
        for s in g[g.traded >= MIN_TRADED].sym:
            c = D.col[s]
            for side, start, qd in (('buy', t + 1, t), ('sell', t + 1 + HOLD, t + HOLD)):
                L = _limit(D, side, 'mid', qd, s)
                if not L:
                    continue
                n += 1
                hit = next((d - start for d in range(start, start + LIMIT_DAYS)
                            if ((D.LO.iat[d, c] < L) if side == 'buy' else (D.HI.iat[d, c] > L))), None)
                filled += hit is not None
                first += hit == 0
    return {'orders': n, 'firstDayPct': round(first / n * 100) if n else None, 'withinPct': round(filled / n * 100) if n else None, 'days': LIMIT_DAYS}


def history(scored, idx):
    """Walk-forward Edge score (0–100) and buy-list rank (0 = not ranked: trades on fewer than half of days) per grid day."""
    days = {}
    for t, s in scored.items():
        pct = (s.key.rank(pct=True) * 100).round().astype(int)
        ranked = s[s.traded >= MIN_TRADED]
        rank = {k: i + 1 for i, k in enumerate(ranked.sym)}
        days[str(idx[t].date())] = {k: [int(p), rank.get(k, 0)] for k, p in zip(s.sym, pct)}
    return {'made': str(idx[-1].date()), 'hold': HOLD, 'days': days}


def study():
    import factor_study as fs
    D = Data(fs)
    df = build_rows(D)
    feats = sorted({k for ks in THEMES.values() for k in ks} | set(fs.FEATURE_LABELS) | {'rev5', 'rev21', 'iv_rel', 'ey_avg8'})
    Z = zcols(df, feats)
    idx = fs.idx
    v1 = json.load(open('data/factor_study.json', encoding='utf-8'))
    split = idx.get_loc(pd.Timestamp(v1['h63']['split']))
    y26 = int(idx.searchsorted(pd.Timestamp('2026-01-01')))   # no design choice looked at 2026; reported on its own
    r1 = v1_ranks(df, Z, v1['h63']['chosen'])
    s1 = simulate(D, df, r1)
    res = {'v1': {'close': summary(simulate(D, df, r1, fill='close', fee=0.01), idx, split),
                  'honest': summary(s1, idx, split), 'honestSkipDay': summary(simulate(D, df, r1, lag=1), idx, split), 'since2026': summary(s1, idx, y26)}}
    for name in VARIANTS:
        sc = walk(df, Z, name)
        rk = order(sc)
        sim = simulate(D, df, rk)
        res[name] = {'walk': summary(sim, idx), 'common': summary(sim, idx, split)}
        if name == 'full':
            full_scored, full = sc, rk
            res[name]['honestSkipDay'] = summary(simulate(D, df, rk, lag=1), idx, split)
            res[name]['since2026'] = summary(sim, idx, y26)
        print(name, json.dumps(res[name]))
    print('v1', json.dumps(res['v1']))
    res['rules'] = {}
    for name, kw in RULES.items():
        res['rules'][name] = windows(simulate(D, df, full, **kw), idx, split, y26)
        print('rule', name, json.dumps(res['rules'][name]['common']))
    # the shipped rule's gain leans on a few long-held winners: report it without the three that added the most
    log = []
    simulate(D, df, full, log=log, **RULES[SHIP])
    best = pd.DataFrame(log, columns=['t', 'sym', 'r']).groupby('sym').r.sum().sort_values(ascending=False).index[:3].tolist()
    without = {t: [s for s in v if s not in best] for t, v in full.items()}
    top = RULES[SHIP].get('top', TOP)
    ship = {'name': SHIP, 'tried': len(RULES), 'top': top, 'keep': RULES[SHIP].get('keep', top), 'fill': RULES[SHIP].get('fill', 'cross'), 'limitDays': LIMIT_DAYS,
            **res['rules'][SHIP], 'best': best, 'withoutBest': windows(simulate(D, df, without, **RULES[SHIP]), idx, split, y26),
            'oldScore': windows(simulate(D, df, r1, **RULES[SHIP]), idx, split, y26), 'fills': fill_rates(D, df)}
    print('ship', json.dumps({k: ship[k] for k in ('best', 'fills')}), 'without best', json.dumps(ship['withoutBest']['common']))
    json.dump(history(full_scored, idx), open(HIST, 'w'), separators=(',', ':'))
    known = df.t + 1 + HOLD + 1 <= fs.N - 1
    model = fit(df[known], Z, THEMES)
    out = {'made': str(idx[-1].date()), 'hold': HOLD, 'fee': FEE, 'step': STEP, 'selectT': SELECT_T,
           'basis': 'dividends included, 0.5% fees each side on top of the price paid; buys at the ask and sells at the bid unless a rule leaves limit orders',
           'v1Split': str(idx[split].date()), 'model': model, 'themes': THEMES, 'results': res, 'ship': ship,
           'forecastOrigins': int(D.FC.dropna(how='all').index.nunique()) if len(D.FC) else 0}
    json.dump(out, open(OUT, 'w', encoding='utf-8'), indent=1, default=float)
    import test_registry
    test_registry.update(out)
    return out


def today(out, fs):
    """Score every stock with the saved model on the latest close. Writes stocks[sym].edge and edgeInfo into `out` (forecasts.json).
    edge.score is the percentile of the expected gain after costs, so a higher score always means a better buy-list rank."""
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
    pct = s.net.rank(pct=True) * 100
    ranked = s[s.traded >= MIN_TRADED].sort_values('net', ascending=False)
    rank = {k: i + 1 for i, k in enumerate(ranked.index)}
    spread = f.set_index('sym').spread
    for k, r in s.iterrows():
        if k not in out['stocks']:
            continue
        mid = D.MID.iat[t, D.col[k]]
        out['stocks'][k]['edge'] = {'score': round(float(pct[k])), 'rank': rank.get(k), 'of': len(ranked),
                                    'exp': round(float(r.exp) * 100, 1), 'cost': round(float(r.cost) * 100, 1), 'net': round(float(r.net) * 100, 1),
                                    'spread': None if pd.isna(spread[k]) else round(float(spread[k]) * 100, 1),
                                    'limit': None if pd.isna(mid) else round(float(mid), 2),
                                    'themes': {th[3:]: round(float(r[th])) for th in s.columns if th.startswith('th_') and pd.notna(r[th])}}
    labels = {**fs.FEATURE_LABELS, **EXTRA_LABELS}
    R, ship = S['results'], S['ship']
    import test_registry
    reg = test_registry._load(test_registry.PATH, {}).get('summary', {})
    out['edgeInfo'] = {
        'fitTo': S['made'], 'basis': S['basis'], 'v1Split': S['v1Split'],
        'themes': {th: {'label': THEME_LABELS[th], 'weight': model['weights'].get(th, 0),
                        'signals': [{'key': k, 'label': labels.get(k, k), 'sign': model['signs'][k], **model['stats'].get(k, {})} for k in ks if k in model['signs']]}
                   for th, ks in THEMES.items()},
        'calib': model['buckets'], 'slope': model['slope'],
        'rule': ship,
        'compare': {'ship': ship['common'], 'shipAtQuotes': R['rules']['top5_cross_keep20']['common'], 'top10': R['rules']['top10_cross']['common'],
                    'oldShip': ship['oldScore']['common'], 'old': R['v1']['honest'], 'withoutBest': ship['withoutBest']['common'],
                    'pre2026': ship['pre2026'], 'since2026': ship['since2026']},
        'ablations': {k: R[k]['common'] for k in VARIANTS if k != 'full' and k in R},
        'registry': reg,
    }
    import track_record as tr
    out['track'] = tr.update(out, fs, key='edge', log=LOG)
    return out


if __name__ == '__main__':
    study()
