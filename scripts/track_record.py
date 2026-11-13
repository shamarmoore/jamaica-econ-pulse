"""Live track record: what the app actually showed each night, and how those picks went afterwards.

Back-tests can flatter a model; this is the forward check. Every night the Edge top 10 is logged (data/picks_log.json).
For each logged day the picks are "bought" at the NEXT trading day's close and held up to 63 trading days (3 months),
dividends included, and compared with the average JSE stock over the same days — the same rules as the back-tests.
  update(out, fs) -> dict for forecasts.json['track']
Usage (backfill from git history, run once locally): python scripts/track_record.py backfill"""
import json, os, subprocess, sys

import numpy as np
import pandas as pd

LOG = 'data/picks_log.json'
HOLD = 63
COST = 0.015


def _load():
    try:
        return json.load(open(LOG))
    except Exception:
        return {'days': {}}


def _top(stocks, n=10):
    r = sorted(((v['edge']['rank'], k, v['edge']['score'], v.get('close')) for k, v in stocks.items() if v.get('edge') and not v.get('pref')))
    return [[k, s, c] for _, k, s, c in r[:n]]


def log_today(out):
    L = _load()
    top = _top(out.get('stocks', {}))
    if top and out.get('asof'):
        L['days'][out['asof']] = top
        json.dump(L, open(LOG, 'w'), separators=(',', ':'))
    return L


def update(out, fs):
    L = log_today(out)
    idx, TRI, P, V = fs.idx, fs.TRI, fs.P, fs.V
    N = len(idx)
    univ = ((V > 0).rolling(60).mean() >= 0.2) & (P > 0)
    pos = {str(d.date()): i for i, d in enumerate(idx)}
    rows = []
    for day in sorted(L['days']):
        t = pos.get(day)
        if t is None:
            continue
        b = t + 1
        picks = [x[0] for x in L['days'][day] if x[0] in TRI.columns]
        row = {'date': day, 'picks': picks[:5], 'days': 0}
        if b < N - 1 and len(picks) >= 5:
            e = min(b + HOLD, N - 1)
            ret = lambda ss: float(np.mean([np.clip(TRI[s].iloc[e] / TRI[s].iloc[b] - 1, -0.9, 1.0) for s in ss]))
            m = univ.iloc[t].values & (TRI.iloc[b].values > 0)
            mk = float(np.nanmean(np.clip(TRI.iloc[e].values[m] / TRI.iloc[b].values[m] - 1, -0.9, 1.0)))
            done = e == b + HOLD
            row.update(days=int(e - b), done=bool(done), top5=round(ret(picks[:5]) * 100, 2), top10=round(ret(picks[:10]) * 100, 2), market=round(mk * 100, 2),
                       bought=str(idx[b].date()), to=str(idx[e].date()))
        rows.append(row)
    scored = [r for r in rows if r.get('days', 0) >= 5]
    # one cohort per month for display (the first logged day of each month), plus the very first day
    seen, cohorts = set(), []
    for r in rows:
        k = r['date'][:7]
        if k not in seen:
            seen.add(k); cohorts.append(r)
    done = [r for r in scored if r.get('done')]
    summ = None
    if scored:
        ex5 = [r['top5'] - r['market'] for r in scored]
        summ = {'n': len(scored), 'avgTop5': round(float(np.mean([r['top5'] for r in scored])), 2), 'avgMarket': round(float(np.mean([r['market'] for r in scored])), 2),
                'avgExcessTop5': round(float(np.mean(ex5)), 2), 'avgExcessTop10': round(float(np.mean([r['top10'] - r['market'] for r in scored])), 2),
                'aheadPct': round(float(np.mean([x > 0 for x in ex5])) * 100), 'avgDays': round(float(np.mean([r['days'] for r in scored])))}
    full = None
    if done:
        net = [r['top5'] - 2 * COST * 100 - r['market'] for r in done]
        full = {'n': len(done), 'avgNetExcessTop5': round(float(np.mean(net)), 2), 'aheadPct': round(float(np.mean([x > 0 for x in net])) * 100)}
    first = min(L['days']) if L['days'] else None
    first_t = pos.get(first) if first else None
    due = None
    if first_t is not None:   # date the first 3-month result completes (estimated from the calendar until it is reached)
        due = str(idx[first_t + 1 + HOLD].date()) if first_t + 1 + HOLD < N else str((idx[first_t] + pd.Timedelta(days=92)).date())
    return {'since': first, 'daysLogged': len(L['days']), 'holdDays': HOLD, 'cohorts': cohorts[-8:], 'latest': rows[-1] if rows else None,
            'soFar': summ, 'completed': full, 'firstFullResult': due,
            'explain': ('Each night’s Edge top 5 and top 10 are logged as shown in the app. Each day’s picks are “bought” at the next trading day’s close and held up to '
                        '3 months, dividends included, against the average JSE stock over the same days. “So far” averages every logged day with at least a week of '
                        'results (days overlap, so it moves slowly); completed 3-month results subtract 1.5% costs each way.')}


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == 'backfill':
    L = _load()
    shas = subprocess.run(['git', 'log', '--format=%H', '--', 'data/forecasts.json'], capture_output=True, text=True).stdout.split()
    for sha in reversed(shas):
        try:
            f = json.loads(subprocess.run(['git', 'show', f'{sha}:data/forecasts.json'], capture_output=True, text=True).stdout)
        except Exception:
            continue
        top = _top(f.get('stocks', {}))
        if top and f.get('asof'):
            L['days'][f['asof']] = top   # the last snapshot made for a day wins
    os.makedirs('data', exist_ok=True)
    json.dump(L, open(LOG, 'w'), separators=(',', ':'))
    print('PICKS LOG', {d: [x[0] for x in v[:5]] for d, v in sorted(L['days'].items())})
