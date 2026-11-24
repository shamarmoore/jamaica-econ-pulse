"""Shared helpers for JSE forecasting: load history, run Timestral, hype score, target-hit odds."""
import json, os, re
import numpy as np
import pandas as pd
import balance

MODEL_ID = 'mistralai/Timestral-209M'
LEVELS = np.array([0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99])


def _raw_history(path='data/jse_history.json'):
    H = json.load(open(path))
    dates = sorted(H['dates'])
    syms = sorted({s for d in dates for s in H['dates'][d]})
    close = pd.DataFrame(np.nan, index=pd.to_datetime(dates), columns=syms)
    vol = pd.DataFrame(0.0, index=close.index, columns=syms)
    for d in dates:
        row = H['dates'][d]
        t = pd.Timestamp(d)
        for s, (c, v) in row.items():
            close.at[t, s] = c
            vol.at[t, s] = v
    return close, vol


JUMP = 0.6            # a close below 60% of the one before is a bad print or a share split
SETTLE = 5            # closes looked at after the jump to tell the two apart
NOTICE_DAYS = 120     # a split announcement can come this many days before the split shows in the prices
MAX_GAP = 10          # calendar days between two trades beyond which an unannounced drop is treated as a real fall
_cleaned = {}


def _split_notices():
    """{sym: [(announcement date, factor)]} from JSE split announcements (events.parse_split)."""
    import events as EV
    out = {}
    try:
        for e in EV.archive_events():
            if e['kind'] == 'split' and e.get('factor'):
                out.setdefault(e['sym'], []).append((pd.Timestamp(e['date']), float(e['factor'])))
        for p in json.load(open('data/news_feed.json', encoding='utf-8')).get('posts', []):
            sp = EV.parse_split(f"{p.get('t', '')}. {p.get('x', '')}") if 'split' in (p.get('t', '') + p.get('x', '')).lower() else None
            if p.get('s') and sp and sp.get('factor'):
                out.setdefault(p['s'], []).append((pd.Timestamp(p['d'][:10]), float(sp['factor'])))
    except Exception as e:
        print('split notices skipped:', repr(e)[:120])
    return out


def _clean(path='data/jse_history.json'):
    """Closes with one-off bad prints removed and share splits adjusted (earlier closes divided, volumes multiplied).
    A close under JUMP x the one before is a bad print if the price is back within SETTLE closes, otherwise a split,
    unless no split was announced and the two trades are more than MAX_GAP days apart: then it is a real fall and stays.
    A split's factor is the announced one when an announcement in the NOTICE_DAYS before it roughly matches the drop
    (the price can move on the day too: SEP's 5:1 split on 2026-11-16 closed 25% above 1/5 of the old price), else the
    drop itself, which assumes no move on the day. Returns (close, vol, splits [(sym, first post-split day, factor)])."""
    if path in _cleaned:
        return _cleaned[path]
    close, vol = _raw_history(path)
    notices = _split_notices()
    splits = []
    for s in close.columns:
        c = close[s].dropna()
        i = 1
        while i < len(c):
            before, now = c.iloc[i - 1], c.iloc[i]
            if not (before > 0 and now < JUMP * before):
                i += 1
                continue
            back = [j for j in range(i + 1, min(i + 1 + SETTLE, len(c))) if c.iloc[j] >= JUMP * before]
            if back:
                close.loc[c.index[i:back[0]], s] = np.nan
                c = c.drop(c.index[i:back[0]])
                continue
            day = c.index[i]
            seen = [k for d, k in notices.get(s, []) if day - pd.Timedelta(days=NOTICE_DAYS) <= d <= day]
            match = next((k for k in reversed(seen) if 0.65 < (before / now) / k < 1.5), None)
            if match is None and (day - c.index[i - 1]).days > MAX_GAP:
                i += 1   # a fall across weeks without a trade, with no split notice, is a real fall: rescaling would erase it
                continue
            k = match or before / now
            close.loc[close.index < day, s] /= k
            vol.loc[vol.index < day, s] *= k
            c = close[s].dropna()
            splits.append((s, day, k))
            i += 1
    _cleaned[path] = (close, vol, splits)
    return _cleaned[path]


def splits(path='data/jse_history.json'):
    return _clean(path)[2]


def load_history(path='data/jse_history.json'):
    close, vol, _ = _clean(path)
    return close.copy(), vol.copy()


_model = None


def model():
    global _model
    if _model is None:
        from timestral import TimestralForecaster
        _model = TimestralForecaster.from_pretrained(MODEL_ID, device='cpu')
    return _model


def forecast(ctx_list, h, max_ctx=1024, cov_list=None):
    """ctx_list: list of 1-D price arrays (may differ in length). cov_list (optional): list of (C, len) arrays of past
    covariates aligned to each context (NaN = unknown). Returns quantiles (n, h, 21) in price units."""
    L = min(max(len(c) for c in ctx_list), max_ctx)
    arr = np.full((len(ctx_list), 1, L), np.nan, dtype=np.float32)
    for i, c in enumerate(ctx_list):
        c = np.asarray(c, dtype=np.float32)[-L:]
        arr[i, 0, L - len(c):] = c
    mask = ~np.isnan(arr)
    cov = None
    if cov_list is not None:
        C = cov_list[0].shape[0]
        cov = np.zeros((len(ctx_list), C, L), dtype=np.float32)
        for i, cv in enumerate(cov_list):
            cv = np.asarray(cv, dtype=np.float32)[:, -L:]
            cv = np.where(np.isnan(cv), 0.0, cv)  # unknown → neutral 0 (features are centred)
            cov[i, :, L - cv.shape[1]:] = cv
    out = []
    for i in range(0, len(arr), 64):
        kw = {'past_covariates': cov[i:i + 64]} if cov is not None else {}
        f = model().forecast(np.nan_to_num(arr[i:i + 64]), prediction_length=h, observation_mask=mask[i:i + 64], **kw)
        out.append(f.quantiles[:, 0].detach().cpu().numpy())
    return np.concatenate(out)  # (n, h, 21)


def exceed_prob(q_step, target):
    """P(price >= target) at one step from its 21 quantiles (linear interpolation, clipped to the 1–99% range)."""
    q = np.maximum.accumulate(q_step)
    if target <= q[0]:
        return 0.99
    if target >= q[-1]:
        return 0.01
    cdf = np.interp(target, q, LEVELS)
    return float(1 - cdf)


def hit_odds(q, target):
    """Chance of touching target at some point within the horizon, and the first step where it is more likely than not.
    Uses the highest single-day exceedance probability (a conservative lower bound for touching)."""
    probs = np.array([exceed_prob(q[t], target) for t in range(q.shape[0])])
    first = int(np.argmax(probs >= 0.5)) + 1 if (probs >= 0.5).any() else None
    return float(probs.max()), first, probs


def hype(close, vol, sym, asof=None):
    """Speculation score 0–100 from recent trading behaviour (no news needed).
    Parts: volume surge, price spike vs the stock's own volatility, distance above its 50-day average, thin trading."""
    c = close[sym].loc[:asof].dropna()
    v = vol[sym].loc[:asof]
    if len(c) < 60:
        return None
    r = np.log(c).diff().dropna()
    sd = r.iloc[-120:].std() or 1e-6
    v5 = v.iloc[-5:].mean()
    v60 = v.iloc[-65:-5]
    base = np.median(v60[v60 > 0]) if (v60 > 0).any() else 0
    vol_ratio = (v5 / base) if base > 0 else (5.0 if v5 > 0 else 0.0)
    move10 = float(np.log(c.iloc[-1] / c.iloc[-11])) if len(c) > 11 else 0.0
    z10 = move10 / (sd * np.sqrt(10))
    above50 = float(c.iloc[-1] / c.iloc[-50:].mean() - 1)
    thin = float((v.iloc[-60:] == 0).mean())
    parts = {
        'volume': float(np.clip((np.log2(max(vol_ratio, 1e-3)) - 0.5) / 2.5, 0, 1)),   # 1.4x → 0, ~8x → 1
        'spike': float(np.clip((abs(z10) - 1) / 2.5, 0, 1)),                          # >1 sd move in 10 days
        'stretch': float(np.clip((above50 - 0.08) / 0.4, 0, 1)),                       # >8% above 50-day average
        'thin': float(np.clip((thin - 0.2) / 0.5, 0, 1)),                              # often no trades
    }
    score = 100 * (0.35 * parts['volume'] + 0.30 * parts['spike'] + 0.20 * parts['stretch'] + 0.15 * parts['thin'])
    return {'score': round(score), 'volRatio': round(float(vol_ratio), 2), 'move10': round(move10 * 100, 1), 'z10': round(float(z10), 2),
            'above50': round(above50 * 100, 1), 'thinPct': round(thin * 100), 'parts': {k: round(x, 2) for k, x in parts.items()}}


# ---------- company financial health (from JSE instrument pages) ----------
PREF_RE = r'\d\.\d|PREF|\d{2}$|^[A-Z]+\d'   # e.g. JMMBGL7.35, JPS5D, TJH8.0 — fixed-income-like shares, not ordinary shares


def is_pref(sym):
    import re as _re
    return bool(_re.search(PREF_RE, sym))


FX_TO_JMD = {'JMD': 1.0, 'USD': 157.0, 'TTD': 23.2, 'BBD': 78.5}   # Barbados dollar is fixed at 2 per US$
FEATS = ['ey', 'growth', 'dy', 'lossq']
FEAT_NAMES = {'ey': 'Earnings yield (profit ÷ market value)', 'growth': 'Profit growth vs a year earlier', 'dy': 'Dividend yield (last 12 months)', 'lossq': 'Loss-making quarters (last 4)'}


def load_fundamentals(path='data/jse_fundamentals.json'):
    try:
        F = json.load(open(path))['stocks']
    except Exception:
        return {}
    # month each company's financial year ends and its usual reporting delay, learned from its own reports
    # (scripts/balance.py); the JSE page's month wins where it gives one. Without a month the quarters are dated as if
    # every year ended in December, which is late (never early) for other year-ends
    if not os.environ.get('FISCAL_OFF'):
        try:
            for s, v in json.load(open('data/fiscal_years.json')).items():
                if s in F:
                    fye = F[s].get('fye') or {}
                    F[s]['fye'] = {**fye, 'month': fye.get('month') or int(v['month']), 'lag': None if os.environ.get('LAG_OFF') else v.get('lag')}
        except Exception:
            pass
    # per-share figures on the same footing as the split-adjusted prices: dividends paid before a split shrink by its
    # factor, and a share count read before a split (its 'at' time) grows by it
    for s, day, k in splits():
        f = F.get(s)
        if not f:
            continue
        for d in f.get('dividends', []):
            if d.get('ex') and d.get('amt') and pd.Timestamp(d['ex']) < day:
                d['amt'] = d['amt'] / k
        if f.get('shares') and f.get('at') and pd.Timestamp(f['at'][:10]) < day:
            f['shares'] = f['shares'] * k
    ytd = {}
    for r in balance.readings():   # oldest first, so each company ends on its latest read report
        s = r['sym']
        if s not in F:
            continue
        F[s]['report'] = r
        fy, month = balance.fy_end(r['period_end'], r['months'])
        if month == ((F[s].get('fye') or {}).get('month') or 12):
            ytd[(s, fy, r['months'])] = r
            F[s].setdefault('filed', {}).setdefault(str(fy), [None] * 4)[r['months'] // 3 - 1] = r['first_pub']
    # the JSE table shows 0 for a quarter not reported separately. A missing 4th quarter is the table's year less its
    # first three, all on the table's basis, so this runs before the statements below replace any of those three
    for f in F.values():
        annual = {str(k): v for k, v in (f.get('annual') or {}).items()}
        for fy, qs in f.get('quarters', {}).items():
            qs = (list(qs) + [None] * 4)[:4]
            if qs[3] in (0, None) and all(q not in (0, None) for q in qs[:3]) and annual.get(fy) not in (0, None):
                f['quarters'][fy] = qs[:3] + [annual[fy] - sum(qs[:3])]
    # where the filed statements give a quarter they beat the JSE table, which lags them and can be wrong (J$ in a US$
    # series, a slipped digit) or on another basis. They give year-to-date figures, so a later quarter is the difference
    # of two, which means something only between two readings in the currency profit_fx applies, and of one kind for a
    # company that files both kinds (elsewhere the reader's consolidated flag flips between identical statements)
    if not os.environ.get('FILL_OFF'):
        dual = balance.dual_filers()
        replaced = set()
        for (s, fy, m), r in ytd.items():
            prev = {**r, 'net_profit': 0, 'net_profit_attributable_to_owners': 0} if m == 3 else ytd.get((s, fy, m - 3))
            if (not prev or r['currency'] != F[s]['report']['currency'] or prev['currency'] != r['currency']
                    or (s in dual and prev.get('consolidated') != r.get('consolidated'))):
                continue
            # earnings yield is the owners' share; net_profit (owners' share and minorities together) only without it
            q = next((r[k] - prev[k] for k in ('net_profit_attributable_to_owners', 'net_profit')
                      if r.get(k) is not None and prev.get(k) is not None), None)
            if q is None:
                continue
            qs = F[s].setdefault('quarters', {}).setdefault(str(fy), [])
            i = m // 3 - 1
            qs.extend([0] * (i + 1 - len(qs)))
            qs[i] = q
            replaced.add((s, str(fy), i))
        # a table quarter the statements could not replace holds the owners' and minorities' profit together, so it is
        # scaled by the owners' share in that year's longest reading. Where the minorities' part outweighs the group's
        # profit (an owners' share outside 0 to 2) a proportional split means nothing and the figure stays as printed
        share = {}
        for (s, fy, m), r in sorted(ytd.items()):
            if r.get('net_profit_attributable_to_owners') is not None and r.get('net_profit'):
                share[(s, str(fy))] = r['net_profit_attributable_to_owners'] / r['net_profit']
        for (s, fy), k in share.items():
            qs = F[s].get('quarters', {}).get(fy, [])
            for i, v in enumerate(qs[:4]):
                if 0 < k < 2 and v not in (0, None) and (s, fy, i) not in replaced:
                    qs[i] = v * k
    return F


def fx_rate(f, price):
    """J$ per unit of the company's reporting/dividend currency, relative to how its SHARE PRICE is quoted.
    If dividends are in USD/TTD but converting them would give an absurd yield, the share itself is quoted in that
    currency (e.g. JSE USD-market stocks), so no conversion applies."""
    divs = [d for d in (f or {}).get('dividends', []) if d.get('ex') and d.get('amt')]
    cur = divs[-1]['cur'] if divs else 'JMD'
    rate = FX_TO_JMD.get(cur, 1.0)
    if rate == 1.0 or price is None:
        return 1.0
    ys = []
    for d in divs[-6:]:
        try:
            px = price.loc[:pd.Timestamp(d['ex'])].dropna()
        except Exception:
            continue
        if len(px) and px.iloc[-1] > 0:
            ys.append(d['amt'] * rate / px.iloc[-1])
    return 1.0 if ys and np.median(ys) > 0.25 else rate


def profit_fx(f, price, mcap, ttm):
    """J$ per unit of the currency the company REPORTS its profits in, relative to how its share price is quoted.
    The dividend currency (fx_rate) is only a guess at this — several companies report in US$ but pay in J$ — so the
    currency printed on the company's latest read report (f['report']) wins. mcap and ttm, the latest market value and
    trailing-year profit, feed two sanity rules."""
    r = (f or {}).get('report')
    rate = balance.bs_fx(r['currency'], r.get('equity_attributable_to_owners') or r.get('total_equity'), mcap) if r else fx_rate(f, price)
    if not (pd.notna(ttm) and mcap and mcap > 0 and ttm > 0):
        return rate
    # a year's profit can't be bigger than the whole company's market value: the conversion must be wrong
    if rate > 1 and ttm * rate / mcap > 1:
        return 1.0
    # no report read yet, and the price is 400+ times the profit unless that profit is in US$: it is in US$
    if rate == 1 and not r and mcap / ttm > 400 and mcap / (ttm * FX_TO_JMD['USD']) < 60:
        return FX_TO_JMD['USD']
    return rate


def _quarter_events(f):
    """[(available_date, profit)] in time order. Quarter ends come from the fiscal year-end month (December if unknown).
    A quarter whose statements have been read counts from the day they were first filed (f['filed']). Any other quarter
    counts from when it was probably public: 60 days after the quarter ends, or the company's own usual reporting delay
    where its reports have been read (scripts/balance.py) and it is longer, and at least 90 for the year-end quarter.
    (Reports show a median delay of 45 days but about 3 in 10 arrive later, so the old flat 45 days peeked early for late
    filers. An own delay under 60 days, learned from reports before 2025, put as many later quarters before their filing as
    60 days did, so it never shortens the wait.) None counts before the day after the quarter ahead of it: callers take
    the last four events as a year.
    A 0 is a missing quarter (load_fundamentals fills a missing 4th one from the table's year total)."""
    m = (f.get('fye') or {}).get('month') or 12
    lag = max(int((f.get('fye') or {}).get('lag') or 0), int(os.environ.get('QLAG') or 60))
    filed = f.get('filed') or {}
    ev = []
    for fy, qs in sorted(f.get('quarters', {}).items()):
        fyi = int(fy)
        qs = list(qs) + [None] * (4 - len(qs))
        for qi, v in enumerate(qs[:4]):
            if v in (0, None):
                continue
            end = (pd.Timestamp(year=fyi, month=m, day=1) + pd.offsets.MonthEnd(0)) - pd.DateOffset(months=3 * (3 - qi))
            end = end + pd.offsets.MonthEnd(0)
            day = (filed.get(fy) or [None] * 4)[qi]
            avail = pd.Timestamp(day) if day else end + pd.Timedelta(days=max(90, lag) if qi == 3 else lag)
            if ev:
                avail = max(avail, ev[-1][0] + pd.Timedelta(days=1))
            ev.append((avail, float(v)))
    return ev


def fundamental_series(f, price, index):
    """Daily point-in-time features for one stock aligned to `index` (NaN before data exists)."""
    out = pd.DataFrame(np.nan, index=index, columns=FEATS)
    if not f:
        return out
    div_fx = fx_rate(f, price)
    shares = f.get('shares')
    ev = _quarter_events(f)
    if ev and shares:
        av = pd.Series([v for _, v in ev], index=pd.DatetimeIndex([d for d, _ in ev]))
        av = av[~av.index.duplicated(keep='last')]
        ttm = av.rolling(4).sum(); prev = ttm.shift(4)
        loss = (av < 0).astype(float).rolling(4).sum()
        ttm_d = ttm.reindex(index.union(ttm.index)).ffill().reindex(index)
        prev_d = prev.reindex(index.union(prev.index)).ffill().reindex(index)
        loss_d = loss.reindex(index.union(loss.index)).ffill().reindex(index)
        mcap = price.reindex(index).ffill() * shares
        out['ey'] = (ttm_d * profit_fx(f, price, mcap.iloc[-1], ttm_d.iloc[-1]) / mcap).clip(-0.5, 0.5)
        out['growth'] = ((ttm_d - prev_d) / prev_d.abs().replace(0, np.nan)).clip(-1, 2)
        out['lossq'] = loss_d
    divs = [(pd.Timestamp(d['ex']), d['amt'] * (div_fx if d['cur'] != 'JMD' else 1.0)) for d in f.get('dividends', []) if d.get('ex')]
    if divs:
        ds = pd.Series([a for _, a in divs], index=pd.DatetimeIndex([d for d, _ in divs])).groupby(level=0).sum()
        daily = ds.reindex(index.union(ds.index)).fillna(0)
        roll = daily.rolling('365D').sum().reindex(index)
        out['dy'] = (roll / price.reindex(index).ffill()).clip(0, 0.4)
    elif ev:
        out['dy'] = 0.0
    return out


def health(feat_row):
    """0–100 financial-health score from the latest features (higher = stronger)."""
    if feat_row is None or feat_row.isna().all():
        return None
    ey, g, dy, lq = (feat_row.get(k) for k in FEATS)
    parts = {}
    if pd.notna(ey):
        parts['profitable'] = float(np.clip((ey + 0.02) / 0.12, 0, 1))      # earnings yield −2% → 0, 10% → 1
    if pd.notna(g):
        parts['growing'] = float(np.clip((g + 0.3) / 0.6, 0, 1))            # −30% → 0, +30% → 1
    if pd.notna(dy):
        parts['dividends'] = float(np.clip(dy / 0.05, 0, 1))                 # 5%+ yield → 1
    if pd.notna(lq):
        parts['steady'] = float(1 - lq / 4)
    if not parts:
        return None
    w = {'profitable': 0.4, 'growing': 0.25, 'dividends': 0.15, 'steady': 0.2}
    tot = sum(w[k] for k in parts)
    return {'score': round(100 * sum(w[k] * v for k, v in parts.items()) / tot), 'parts': {k: round(v, 2) for k, v in parts.items()},
            'ey': None if pd.isna(ey) else round(float(ey) * 100, 1), 'growth': None if pd.isna(g) else round(float(g) * 100, 1),
            'dy': None if pd.isna(dy) else round(float(dy) * 100, 2), 'lossq': None if pd.isna(lq) else int(lq)}


# ---------- hiding a company from the model ----------
GENERIC = {'limited', 'ltd', 'company', 'group', 'holdings', 'jamaica', 'jamaican', 'caribbean', 'the', 'and', 'of', 'co', 'inc', 'plc', 'fund', 'funds'}


def anon(text, sym, name):
    """Company name, symbol and years removed, so the model can't recognise the company or the date.
    `name` is the company's full name from the JSE fundamentals (None if unknown). Free text only: it would also eat
    four-digit numbers out of a price table."""
    words = re.findall(r'[A-Za-z0-9&]+', name or '')
    text = re.sub(rf'^.*?\(\s*{re.escape(sym)}\s*\)', 'The Company', text)
    text = re.sub(rf'\b{re.escape(sym)}\b', 'the Company', text)
    for w in [w for w in words if w.lower() not in GENERIC and len(w) > 2]:
        text = re.sub(rf'\b{re.escape(w)}\b', 'the Company', text, flags=re.I)
    text = re.sub(r'\b(19|20)\d\d\b', '', text)
    text = re.sub(r'(the Company[\s,\-–]*)+(limited|ltd\.?|group|holdings)?', 'the Company ', text, flags=re.I)
    return re.sub(r'\s{2,}', ' ', text).strip()
