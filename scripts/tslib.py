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


def forecast(ctx_list, h, max_ctx=1024):
    """ctx_list: list of 1-D price arrays (may differ in length). Returns quantiles (n, h, 21) in price units."""
    L = min(max(len(c) for c in ctx_list), max_ctx)
    arr = np.full((len(ctx_list), 1, L), np.nan, dtype=np.float32)
    for i, c in enumerate(ctx_list):
        c = np.asarray(c, dtype=np.float32)[-L:]
        arr[i, 0, L - len(c):] = c
    mask = ~np.isnan(arr)
    out = []
    for i in range(0, len(arr), 64):
        f = model().forecast(np.nan_to_num(arr[i:i + 64]), prediction_length=h, observation_mask=mask[i:i + 64])
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
