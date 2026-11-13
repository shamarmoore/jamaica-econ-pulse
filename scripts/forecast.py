"""Nightly: forecast every JSE stock 63 trading days (~3 months) ahead with Timestral and score speculation.
Writes data/forecasts.json, which the app downloads with the user's read-only GitHub token."""
import json, os, sys, time
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
    # Chance up: probability of being higher in 3 months (dividends included), from the tested chance model
    cm = json.load(open('data/chance_model.json'))
    w = cm['w']
    for s_, st in out['stocks'].items():
        if st.get('edge'):
            med = float(np.clip(st['q'][-1][10] / st['close'] - 1, -0.5, 0.5))
            st['chanceUp'] = round(100 / (1 + np.exp(-(w[0] + w[1] * st['edge']['score'] / 100 + w[2] * med))))
    out['chanceInfo'] = {k: cm[k] for k in ('baseUp', 'testAUC', 'testCalib', 'top10UpRate', 'top10Mean', 'allMean', 'from', 'to', 'split', 'cases')}
    print('CHANCE UP', sorted(((st['chanceUp'], k) for k, st in out['stocks'].items() if 'chanceUp' in st), reverse=True)[:8])
except Exception as e:
    print('edge score skipped:', e)
# ---- per-stock signals, market regime and tested verdicts for each idea ----
try:
    import signals as sg
    sigs, regime, sect = sg.compute()
    for s_, x in sigs.items():
        if s_ in out['stocks']:
            out['stocks'][s_]['signals'] = x
    out['regime'] = regime
    if os.path.exists('data/idea_tests.json'):
        out['ideas'] = json.load(open('data/idea_tests.json'))
    print('SIGNALS', len(sigs), 'stocks; regime', json.dumps(regime)[:300])
except Exception as e:
    print('signals skipped:', repr(e)[:200])
# ---- live track record: log tonight's picks and score every earlier night's picks ----
try:
    import factor_study as fs2, track_record as tr
    out['track'] = tr.update(out, fs2)
    print('TRACK', json.dumps({k: out['track'][k] for k in ('since', 'daysLogged', 'soFar', 'completed', 'firstFullResult')}))
except Exception as e:
    print('track record skipped:', repr(e)[:200])
# ---- actionable corporate events (dividends, splits, take-overs, rights issues, suspensions) ----
try:
    import events as evm
    _H = json.load(open('data/jse_history.json'))['dates']; _ks = sorted(_H)[-30:]
    def _px(sym):
        for k in reversed(_ks):
            v = _H[k].get(sym)
            if v and v[0] > 0:
                return float(v[0])
        return None
    out['events'] = evm.live_opportunities(out, _px, out.get('ideas', {}))
    print('EVENTS', len(out['events']), [(e['sym'], e['kind'], e['tested']['action']) for e in out['events'][:8]])
except Exception as e:
    print('events skipped:', repr(e)[:200])
# ---- alerts for the phone's background check (tested rules only; matched against positions on the device) ----
try:
    import factor_study as fs3, alerts as al
    _A = al.build(out, fs3)
    out['setups'] = _A['setups']
    print('ALERTS', {'weak': list(_A['weak']), 'events': [e['id'] for e in _A['events']], 'setups': [x['sym'] for x in _A['setups']], 'news': len(_A['news'])})
except Exception as e:
    print('alerts skipped:', repr(e)[:200])
json.dump(out, open('data/forecasts.json', 'w'), separators=(',', ':'))
print('FORECASTS', len(out['stocks']), 'stocks as of', out['asof'])
top = sorted(out['stocks'].items(), key=lambda kv: -(kv[1]['q'][-1][10] / kv[1]['close']))[:5]
for s, x in top:
    print(s, x['close'], '→ median', x['q'][-1][10], '10–90%:', x['q'][-1][2], x['q'][-1][18], 'hype', (x['hype'] or {}).get('score'))
