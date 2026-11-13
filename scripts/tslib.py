"""Shared helpers for JSE forecasting: load history, run Timestral, hype score, target-hit odds."""
import json
import numpy as np
import pandas as pd

MODEL_ID = 'mistralai/Timestral-209M'
LEVELS = np.array([0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.99])


def load_history(path='data/jse_history.json'):
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
PREF_RE = r'\d\.\d|PREF|\d{2}$'


def is_pref(sym):
    import re as _re
    return bool(_re.search(PREF_RE, sym))


FX_TO_JMD = {'JMD': 1.0, 'USD': 157.0, 'TTD': 23.2}
FEATS = ['ey', 'growth', 'dy', 'lossq']
FEAT_NAMES = {'ey': 'Earnings yield (profit ÷ market value)', 'growth': 'Profit growth vs a year earlier', 'dy': 'Dividend yield (last 12 months)', 'lossq': 'Loss-making quarters (last 4)'}


def load_fundamentals(path='data/jse_fundamentals.json'):
    try:
        F = json.load(open(path))['stocks']
    except Exception:
        return {}
    # month each company's financial year ends, learned from its own reports (scripts/balance.py); without it the
    # quarters are dated as if every year ended in December, which is late (never early) for other year-ends
    try:
        for s, m in json.load(open('data/fiscal_years.json')).items():
            if s in F and not (F[s].get('fye') or {}).get('month'):
                F[s]['fye'] = {'month': int(m)}
    except Exception:
        pass
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


def _quarter_events(f):
    """[(available_date, profit)] in time order. Quarter ends come from the fiscal year-end month (December if unknown);
    each quarter counts only 45 days after it ends (90 for the year-end quarter) so tests never peek early.
    The JSE table shows 0 for quarters not reported separately: a 0 is treated as missing, except that a missing 4th
    quarter is filled as annual profit minus the first three quarters when all of those are known."""
    m = (f.get('fye') or {}).get('month') or 12
    annual = {str(k): v for k, v in (f.get('annual') or {}).items()}
    ev = []
    for fy, qs in sorted(f.get('quarters', {}).items()):
        fyi = int(fy)
        qs = list(qs) + [None] * (4 - len(qs))
        if (qs[3] in (0, None)) and all(q not in (0, None) for q in qs[:3]) and annual.get(str(fy)) not in (0, None):
            qs[3] = annual[str(fy)] - sum(qs[:3])
        for qi, v in enumerate(qs[:4]):
            if v in (0, None):
                continue
            end = (pd.Timestamp(year=fyi, month=m, day=1) + pd.offsets.MonthEnd(0)) - pd.DateOffset(months=3 * (3 - qi))
            end = end + pd.offsets.MonthEnd(0)
            avail = end + pd.Timedelta(days=90 if qi == 3 else 45)
            ev.append((avail, float(v)))
    ev.sort()
    return ev


def fundamental_series(f, price, index):
    """Daily point-in-time features for one stock aligned to `index` (NaN before data exists)."""
    out = pd.DataFrame(np.nan, index=index, columns=FEATS)
    if not f:
        return out
    fx = fx_rate(f, price)
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
        out['ey'] = (ttm_d * fx / mcap).clip(-0.5, 0.5)
        out['growth'] = ((ttm_d - prev_d) / prev_d.abs().replace(0, np.nan)).clip(-1, 2)
        out['lossq'] = loss_d
    divs = [(pd.Timestamp(d['ex']), d['amt'] * (fx if d['cur'] != 'JMD' else 1.0)) for d in f.get('dividends', []) if d.get('ex')]
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
