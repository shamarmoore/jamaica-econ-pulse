"""Nightly: forecast every JSE stock 63 trading days (~3 months) ahead with Timestral and score speculation.
Writes data/forecasts.json, which the app downloads with the user's read-only GitHub token."""
import json, sys, time
import numpy as np
import pandas as pd
sys.path.insert(0, 'scripts')
from tslib import load_history, forecast, hype, LEVELS, MODEL_ID

H = 63
STEPS = list(range(2, H, 3)) + [H - 1]  # every 3rd trading day, 0-based step index, always incl. the last
close, vol = load_history()
idx = close.index
ff = close.ffill()
last = idx[-1]
syms = []
for s in close.columns:
    c = close[s].dropna()
    if len(c) >= 120 and c.index[-1] >= idx[-10] and ff[s].iloc[-1] > 0:
        syms.append(s)
ctx = [ff[s].loc[close[s].first_valid_index():].values for s in syms]
t = time.time()
Q = forecast(ctx, H)
print(f'forecast {len(syms)} stocks in {time.time() - t:.1f}s')

# future trading dates (weekdays; JSE holidays are ignored, so dates can be a day or two early)
fut = pd.bdate_range(last + pd.Timedelta(days=1), periods=H)
bt = {}
try:
    bt = json.load(open('data/forecast_backtest.json'))
except Exception:
    pass

out = {'asof': str(last.date()), 'made': pd.Timestamp.utcnow().isoformat(timespec='minutes'), 'model': MODEL_ID.split('/')[-1], 'horizon': H,
       'levels': LEVELS.tolist(), 'steps': [i + 1 for i in STEPS], 'dates': [str(fut[i].date()) for i in STEPS],
       'calibration': bt.get('calibration'), 'backtest': {k: bt.get(k) for k in ('origins', 'cases', 'from', 'to', 'horizons', 'target10', 'target20', 'target30', 'hype')} if bt else None,
       'stocks': {}}
for i, s in enumerate(syms):
    c = close[s].dropna()
    q = Q[i]
    hist = c.iloc[-260:]
    v = vol[s]
    out['stocks'][s] = {
        'close': float(ff[s].iloc[-1]),
        'q': [[round(float(x), 4) for x in q[j]] for j in STEPS],
        'hist': [[str(d.date()), round(float(x), 4)] for d, x in hist.items()],
        'vol20': round(float(v.iloc[-20:].mean())),
        'hype': hype(close, vol, s),
    }
json.dump(out, open('data/forecasts.json', 'w'), separators=(',', ':'))
print('FORECASTS', len(out['stocks']), 'stocks as of', out['asof'])
top = sorted(out['stocks'].items(), key=lambda kv: -(kv[1]['q'][-1][10] / kv[1]['close']))[:5]
for s, x in top:
    print(s, x['close'], '→ median', x['q'][-1][10], '10–90%:', x['q'][-1][2], x['q'][-1][18], 'hype', (x['hype'] or {}).get('score'))
