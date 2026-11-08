"""Nightly: forecast every JSE stock 63 trading days (~3 months) ahead with Timestral and score speculation.
Writes data/forecasts.json, which the app downloads with the user's read-only GitHub token."""
import json, sys, time
import numpy as np
import pandas as pd
sys.path.insert(0, 'scripts')
from tslib import is_pref, load_history, load_fundamentals, fundamental_series, forecast, hype, health, LEVELS, MODEL_ID, FEATS, FEAT_NAMES

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
FUND = load_fundamentals()
feats = {s: fundamental_series(FUND.get(s), ff[s], idx) for s in syms}
ctx, covs = [], []
for s in syms:
    a = idx.get_loc(close[s].first_valid_index())
    ctx.append(ff[s].iloc[a:].values)
    cv = feats[s].iloc[a:][FEATS].values.T.copy(); cv[3] = cv[3] / 4.0
    covs.append(cv)
t = time.time()
Q = forecast(ctx, H, cov_list=covs)  # company financial health feeds in as past covariates
print(f'forecast {len(syms)} stocks in {time.time() - t:.1f}s')

# future trading dates (weekdays; JSE holidays are ignored, so dates can be a day or two early)
fut = pd.bdate_range(last + pd.Timedelta(days=1), periods=H)
bt = {}
try:
    bt = json.load(open('data/forecast_backtest.json'))
except Exception:
    pass

def fund_summary(f):
    if not f:
        return None
    qs = sorted(f.get('quarters', {}).items())
    flat = [(fy, i + 1, v) for fy, vs in qs for i, v in enumerate(vs) if v]
    divs = f.get('dividends', [])[-4:]
    return {'name': f.get('name'), 'fyeMonth': (f.get('fye') or {}).get('month'), 'shares': f.get('shares'),
            'lastQuarters': [[f'FY{fy} Q{q}', v] for fy, q, v in flat[-8:]], 'dividends': divs}


out = {'asof': str(last.date()), 'made': pd.Timestamp.utcnow().isoformat(timespec='minutes'), 'model': MODEL_ID.split('/')[-1], 'horizon': H,
       'levels': LEVELS.tolist(), 'steps': [i + 1 for i in STEPS], 'dates': [str(fut[i].date()) for i in STEPS],
       'calibration': bt.get('calibration'), 'backtest': {k: bt.get(k) for k in ('origins', 'cases', 'from', 'to', 'basis', 'horizons', 'compare', 'target10', 'target20', 'target30', 'hype')} if bt else None,
       'inputs': ['price history'] + [FEAT_NAMES[k] for k in FEATS],
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
        'health': None if is_pref(s) else health(feats[s].iloc[-1]),
        'pref': is_pref(s),
        'fund': fund_summary(FUND.get(s)),
    }
# ---- Edge score: the tested multi-signal ranking (see scripts/factor_study.py) ----
try:
    import factor_study as fs
    study = json.load(open('data/factor_study.json'))
    chosen = study['h63']['chosen']
    edge = fs.edge_today(chosen)
    for s_, e in edge.items():
        if s_ in out['stocks']:
            out['stocks'][s_]['edge'] = e
    b = study['h63']['blends']['edge']
    out['edgeInfo'] = {'labels': {k: fs.FEATURE_LABELS.get(k, k) for k in chosen}, 'signs': chosen, 'period': study['period'], 'split': study['h63']['split'],
                       'oos': b['portfolio_oos_cost1pct'], 'all': b['portfolio_all_cost1pct'], 'oosIC': b['oosIC'], 'top5': study.get('top5'), 'byYear': study.get('byYear')}
    print('EDGE', sorted(((v['score'], k) for k, v in edge.items()), reverse=True)[:8])
except Exception as e:
    print('edge score skipped:', e)
json.dump(out, open('data/forecasts.json', 'w'), separators=(',', ':'))
print('FORECASTS', len(out['stocks']), 'stocks as of', out['asof'])
top = sorted(out['stocks'].items(), key=lambda kv: -(kv[1]['q'][-1][10] / kv[1]['close']))[:5]
for s, x in top:
    print(s, x['close'], '→ median', x['q'][-1][10], '10–90%:', x['q'][-1][2], x['q'][-1][18], 'hype', (x['hype'] or {}).get('score'))
