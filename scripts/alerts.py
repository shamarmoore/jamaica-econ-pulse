"""Nightly alerts file for the phone's background check (data/alerts.json). Contains no personal data: the phone
matches it against the positions saved on the device and decides what to notify.
  build(out, fs) -> dict (also written to data/alerts.json); adds signals.setup to stocks in `out`
Everything here comes from rules that were back-tested (see scripts/idea_tests.py); nothing is written by an AI."""
import json
from datetime import datetime, timedelta, timezone

import numpy as np

STATE = 'data/alerts_state.json'
FUND_COLS = ['ey', 'dy', 'growth', 'q_yoy', 'stable', 'noloss', 'iv_ddm']


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def quiet_setups(out, fs, max_rank=15):
    """Edge top-15 stocks with top-third fundamentals whose price hasn't moved: 3-month change at or below the typical
    stock and more than 10% under the 52-week high (the 'quiet' group in idea_tests.quiet_setups)."""
    t = fs.N - 1
    f = fs.features(t)
    live = [s for s in fs.syms if ((fs.V[s].iloc[t - 59:t + 1] > 0).mean() >= 0.2) and fs.P[s].iloc[t] > 0]
    ff = f.loc[live]
    ok = ff[FUND_COLS].notna().sum(axis=1) >= 4
    fund = ff[FUND_COLS].rank(pct=True).mean(axis=1)[ok]
    cut = fund.quantile(2 / 3)
    med = ff['mom63'].median()
    res = {}
    for s in fund.index:
        st = out['stocks'].get(s) or {}
        rank = (st.get('edge') or {}).get('rank')
        m, hi = ff.loc[s, 'mom63'], ff.loc[s, 'hi52']
        if np.isnan(m) or np.isnan(hi):
            continue
        info = {'fundPct': round(float(fund[s]) * 100), 'chg3m': round(float(m) * 100, 1), 'offHigh': round((float(hi) - 1) * 100, 1),
                'strong': bool(fund[s] >= cut), 'quiet': bool(m <= med and hi < 0.9)}
        if st.get('signals') is not None:
            st['signals']['setup'] = info
        if info['strong'] and info['quiet'] and rank and rank <= max_rank:
            res[s] = {**info, 'rank': rank}
    return res


def build(out, fs):
    asof = out.get('asof'); I = out.get('ideas') or {}
    today = datetime.strptime(asof, '%Y-%m-%d')
    state = _load(STATE, {'setups': {}})
    W = ((I.get('post_earnings_drift') or {}).get('weakResults63') or {}).get('avgExcess')
    Q = ((I.get('setups') or {}).get('quiet') or {})
    ranks, weak = {}, {}
    for s, st in out['stocks'].items():
        if st.get('edge'):
            ranks[s] = st['edge']['rank']
        r = (st.get('signals') or {}).get('results')
        if r and r.get('kind') == 'weak':
            pub = (today - timedelta(days=int(r.get('daysAgo') or 0))).strftime('%Y-%m-%d')
            weak[s] = {'id': f'weak-{s}-{pub[:7]}', 'title': f'Sell signal: {s} reported weak results',
                       'body': f"Profit down {abs(r.get('yoy'))}% on the year." + (f" In testing, stocks trailed the market by {abs(W)} pts over the 3 months after weak results." if W is not None else '')}
    # quiet setups, with the date each stock first qualified (a stock that drops out for 30+ days starts afresh)
    try:
        qs = quiet_setups(out, fs)
    except Exception as e:
        print('quiet setups skipped:', repr(e)[:160]); qs = {}
    prev = state.get('setups', {})
    setups, keep = [], {}
    for s, x in sorted(qs.items(), key=lambda kv: kv[1]['rank']):
        p = prev.get(s)
        first = p['first'] if p and (today - datetime.strptime(p['last'], '%Y-%m-%d')).days <= 30 else asof
        keep[s] = {'first': first, 'last': asof}
        setups.append({'id': f'setup-{s}-{first}', 'sym': s, 'rank': x['rank'], 'since': first,
                       'title': f'{s}: strong numbers, quiet price',
                       'body': f"Edge #{x['rank']}; fundamentals better than {x['fundPct']}% of stocks; price {x['chg3m']:+.0f}% in 3 months, {abs(x['offHigh']):.0f}% under its high."
                               + (f" In testing this kind of stock beat the market by {Q.get('avgExcess')} pts over 3 months before costs." if Q.get('avgExcess') is not None else '')})
    for s, p in prev.items():   # remember recent leavers so a brief dip out doesn't re-alert
        if s not in keep and (today - datetime.strptime(p['last'], '%Y-%m-%d')).days <= 30:
            keep[s] = p
    json.dump({'setups': keep}, open(STATE, 'w'), separators=(',', ':'))
    # dividend buy-by and other tested event trades
    events, susp = [], []
    for e in out.get('events') or []:
        if e['kind'] == 'suspend':
            susp.append(e['sym'])
        if (e.get('tested') or {}).get('action') == 'consider' and e.get('buyBy') and e['buyBy'] >= asof:
            y = e.get('yieldPct')
            events.append({'id': f"div-{e['sym']}-{e.get('ex')}", 'sym': e['sym'], 'buyBy': e['buyBy'], 'ex': e.get('ex'),
                           'title': f"{e['sym']} dividend{f' {y:.1f}%' if y else ''}: buy by {datetime.strptime(e['buyBy'], '%Y-%m-%d').strftime('%a %-d %b')}",
                           'body': (e.get('tested') or {}).get('why', '')[:300]})
    # fresh announcements (last 3 days); the phone shows those for stocks you hold or that are quiet setups
    feed = _load('data/news_feed.json', {}).get('posts', [])
    since = (today - timedelta(days=3)).strftime('%Y-%m-%d')
    KIND = {'results': 'Results', 'dividend': 'Dividend', 'insider': 'Insider trade', 'meeting': 'Meeting', 'board': 'Board', 'capital': 'Capital', 'notice': 'Notice'}
    news = [{'id': f"news-{p['id']}", 'sym': p['s'], 'kind': KIND.get(p.get('k'), 'Notice'), 'title': p.get('t', '')[:140]} for p in feed if p.get('s') and p['d'][:10] >= since][:80]
    A = {'asof': asof, 'made': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'ranks': ranks, 'weak': weak, 'suspended': sorted(set(susp)),
         'events': events, 'setups': setups, 'news': news}
    json.dump(A, open('data/alerts.json', 'w'), separators=(',', ':'))
    return A
