"""Next quarter's profit for each company, forecast by Timestral from the company's own quarterly profits, and how the
same one-quarter-ahead forecast did on every past quarter. forecast.py passes tslib.forecast; tests pass a stand-in.

  estimates(F, forecast, asof) -> {sym: {'end', 'label', 'cur', 'lo', 'mid', 'hi', 'lastYear'}}   (lo/hi: 10% and 90%)
  backtest(F, forecast, asof)  -> {'cases', 'from', 'to', 'error', 'direction', 'inRange'}

A quarter the JSE table dates after `asof` cannot have been reported: that company's year labels are off (CAR's run a
year ahead since it moved its year-end), so it gets no estimate and its quarters are left out of the backtest."""
import numpy as np
import pandas as pd
from tslib import LEVELS, quarter_end, report_currency

CONTEXT, MIN_KNOWN = 20, 8   # quarters the model sees, and how many of them must have a figure
AHEAD = pd.Timedelta(days=120)   # the next quarter ends within a quarter and a month of today
LO, MID, HI = (int(np.argmin(np.abs(LEVELS - p))) for p in (0.1, 0.5, 0.9))


def quarters(f):
    """{fy * 4 + quarter index: profit} for every quarter with a figure (the JSE table shows 0 for one without)."""
    return {int(fy) * 4 + qi: float(v) for fy, qs in (f.get('quarters') or {}).items()
            for qi, v in enumerate(list(qs)[:4]) if v not in (0, None)}


def context(q, k):
    """The CONTEXT quarters before quarter k (NaN where there is no figure), or None when too few have one."""
    hist = np.array([q.get(j, np.nan) for j in range(k - CONTEXT, k)])
    return hist if np.sum(~np.isnan(hist)) >= MIN_KNOWN else None


def _quantiles(forecast, contexts):
    return np.maximum.accumulate(forecast(contexts, 1)[:, 0, :], axis=1)   # crossed quantiles would invert the range


def _end(f, k):
    return quarter_end(k // 4, k % 4, (f.get('fye') or {}).get('month') or 12)


def estimates(F, forecast, asof):
    jobs = [(s, f, q, max(q) + 1) for s, f in F.items() if (q := quarters(f)) and _end(f, max(q) + 1) <= pd.Timestamp(asof) + AHEAD]
    jobs = [(s, f, q, k, c) for s, f, q, k in jobs if (c := context(q, k)) is not None]
    if not jobs:
        return {}
    out = {}
    for (s, f, q, k, _), x in zip(jobs, _quantiles(forecast, [c for *_, c in jobs])):
        end = _end(f, k)
        out[s] = {'end': str(end.date()), 'label': f"{(end - pd.DateOffset(months=2)).strftime('%b')}–{end.strftime('%b %Y')}",
                  'cur': report_currency(f), 'lo': round(float(x[LO])), 'mid': round(float(x[MID])), 'hi': round(float(x[HI])),
                  'lastYear': round(q[k - 4]) if k - 4 in q else None}
    return out


def backtest(F, forecast, asof):
    """Every past quarter with enough history and the figures the simple guesses need, against its actual profit.
    Errors are in units of the company's typical quarter (mean absolute profit over the model's context)."""
    cases = []
    for f in F.values():
        q = quarters(f)
        if q and _end(f, max(q)) > pd.Timestamp(asof):
            continue
        for k, v in q.items():
            c = context(q, k)
            if c is not None and all(j in q for j in (k - 1, k - 4, k - 5)) and np.nanmean(np.abs(c)) > 0:
                cases.append((c, v, q[k - 1], q[k - 4], q[k - 5], np.nanmean(np.abs(c)), _end(f, k)))
    if not cases:
        return None
    X = _quantiles(forecast, [x[0] for x in cases])
    v, last_q, last_y, before, scale = (np.array([x[i] for x in cases]) for i in range(1, 6))
    mid = X[:, MID]
    err = lambda guess: round(float(np.median(np.abs(guess - v) / scale)), 2)
    moved = v != last_y
    right = lambda guess: round(100 * float(np.mean(np.sign(guess[moved] - last_y[moved]) == np.sign(v[moved] - last_y[moved]))))
    ends = [x[6] for x in cases]
    return {'cases': len(cases), 'from': str(min(ends).date()), 'to': str(max(ends).date()),
            'error': {'timestral': err(mid), 'lastYear': err(last_y), 'lastQuarter': err(last_q)},
            'direction': {'timestral': right(mid), 'lastQuarterTrend': right(last_y + (last_q - before))},
            'inRange': round(100 * float(np.mean((X[:, LO] <= v) & (v <= X[:, HI]))))}
