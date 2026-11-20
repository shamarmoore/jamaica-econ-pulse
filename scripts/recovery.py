"""Recovery watch: stocks far below their 2-year high, with what JSE history says about stocks in the same spot and the
facts needed to judge whether the fall was a one-off (the app's AI reads these; so can you).

A stock is in the watch when it trades 40%+ below its highest close of the last 2 years and on at least 20% of days.
groups() puts it into the situations idea_tests.py back-tests over the next 6 months (126 trading days), so the app can
quote the record for its exact situation. None of this changes the Edge score or the buy list.

  groups(fs, t, s, rank)  -> situation keys for stock s on day t (rank: its Edge rank that day, if known)
  dossiers(out, fs)       -> stocks[sym].recovery in forecasts.json for every stock in the watch today"""
import json, re
import numpy as np
import pandas as pd

DOWN = -0.40
LOOKBACK = 504          # 2 years of trading days
H = 126                 # the tests hold 6 months
MAX_NEWS = 10
ROUTINE = re.compile(r'net asset value|\bNAV\b|trading activity|consideration of dividend|considers? dividend|dividend consideration', re.I)
_cache = {}


def _frames(fs):
    """2-year high and 63-day net insider buy notices, built once per process."""
    if 'hi2' not in _cache:
        import insiders as INS
        col = {s: i for i, s in enumerate(fs.syms)}
        net = np.zeros((fs.N, len(fs.syms)))
        for e in INS.events():
            if e['sym'] in col and not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell'):
                a = int(fs.idx.searchsorted(pd.Timestamp(e['date']), side='right'))
                if a < fs.N:
                    net[a, col[e['sym']]] += 1 if e['side'] == 'buy' else -1
        _cache['hi2'] = fs.P.rolling(LOOKBACK, min_periods=252).max()
        _cache['ins'] = pd.DataFrame(net, index=fs.idx, columns=fs.syms).rolling(63, min_periods=1).sum()
        _cache['events'] = INS.events()
    return _cache


def drop(fs, t, s):
    hi = _frames(fs)['hi2'][s].iloc[t]
    return fs.P[s].iloc[t] / hi - 1 if hi > 0 else np.nan


def in_watch(fs, t, s):
    traded = (fs.V[s].iloc[max(0, t - 59):t + 1] > 0).mean() >= 0.2
    return bool(traded and fs.P[s].iloc[t] > 0 and drop(fs, t, s) <= DOWN)


def groups(fs, t, s, rank=None):
    """Situation keys (all end in 126: the tests hold 126 trading days, and the test registry reads holds from names)."""
    ttm, qy, qp = fs.FF['ttm'][s].iloc[t], fs.FF['q_yoy'][s].iloc[t], fs.FF['q_yoy_prev'][s].iloc[t]
    out = ['all126']
    if pd.notna(ttm):
        out.append('lossMaking126' if ttm < 0 else 'profitable126')
        if ttm < 0 and pd.notna(qy) and pd.notna(qp) and qy > 0 and qp > 0:
            out.append('lossesShrinking126')
    if _frames(fs)['ins'][s].iloc[t] > 0:
        out.append('insiderBuying126')
    if not fs.DIV12[s].iloc[t] > 0:
        out.append('noDividend126')
    if rank is not None:
        out.append('edgeUnranked126' if not rank else 'edgeTop20_126' if rank <= 20 else 'edge21to40_126' if rank <= 40 else 'edge41plus126')
    return out


def _news(sym, since):
    """Non-routine announcements for sym since the peak, newest first: [[date, title, link]]."""
    posts = {}
    try:
        for p in json.load(open('data/events_archive.json', encoding='utf-8')).get('posts', []):
            if p.get('date', '')[:10] >= since and re.search(rf'\({re.escape(sym)}\)', p.get('title', '')):
                posts[p['id']] = [p['date'][:10], p['title'], p.get('link')]
    except Exception:
        pass
    try:
        for p in json.load(open('data/news_feed.json', encoding='utf-8')).get('posts', []):
            if p.get('s') == sym and p.get('d', '')[:10] >= since:
                posts[p['id']] = [p['d'][:10], p.get('t', ''), p.get('u')]
    except Exception:
        pass
    keep = sorted((v for v in posts.values() if not ROUTINE.search(v[1])), key=lambda v: v[0], reverse=True)[:MAX_NEWS]
    read = _notices()
    return [v + [read[v[2]]] if v[2] in read else v for v in keep]


def _notices():
    """{announcement link: one-line summary of its PDF} from scripts/read_notices.py."""
    if 'notices' not in _cache:
        try:
            N = json.load(open('data/notices.json', encoding='utf-8')).get('notices', {})
        except Exception:
            N = {}
        _cache['notices'] = {k: ' '.join(x for x in (v.get('what'), f"Cause given: {v['why']}" if v.get('why') else None,
                                                    f"Figures: {v['numbers']}" if v.get('numbers') else None, f"Next: {v['next']}" if v.get('next') else None) if x)[:600]
                             for k, v in N.items() if v.get('what')}
    return _cache['notices']


def docs(n=3, days=400):
    """{sym: [[date, title, link, summary]], newest first}: the latest documents the notice reader summarised for each company."""
    from datetime import date, timedelta
    since = str(date.today() - timedelta(days=days))
    try:
        N = json.load(open('data/notices.json', encoding='utf-8')).get('notices', {})
    except Exception:
        N = {}
    read, out = _notices(), {}
    for link, v in sorted(N.items(), key=lambda kv: kv[1].get('date', ''), reverse=True):
        if link in read and v.get('sym') and v.get('date', '') >= since and len(out.setdefault(v['sym'], [])) < n:
            out[v['sym']].append([v['date'], v.get('title', ''), link, read[link]])
    return {k: v for k, v in out.items() if v}


def dossiers(out, fs):
    t = fs.N - 1
    F = _frames(fs)
    n = 0
    for s, st in out['stocks'].items():
        if s not in fs.P.columns or st.get('pref') or not in_watch(fs, t, s):
            continue
        w = fs.P[s].iloc[max(0, t - LOOKBACK + 1):t + 1]
        peak_day = w.idxmax()
        since = str(peak_day.date())
        divs = [d['ex'] for d in (fs.FUND.get(s) or {}).get('dividends', []) if d.get('ex')]
        ins = [e for e in F['events'] if e['sym'] == s and e['date'] >= since and not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell')]
        rank = (st.get('edge') or {}).get('rank')
        st['recovery'] = {
            'drop': round(float(drop(fs, t, s)) * 100, 1), 'peak': [since, round(float(w.max()), 2)],
            'months': int(round((fs.idx[t] - peak_day).days / 30.4)),
            'groups': groups(fs, t, s, rank or 0),
            'lastDividend': max(divs) if divs else None,
            'insiders': {'buys': sum(e['side'] == 'buy' for e in ins), 'sells': sum(e['side'] == 'sell' for e in ins),
                         'boughtShares': int(sum(e.get('shares') or 0 for e in ins if e['side'] == 'buy')),
                         'soldShares': int(sum(e.get('shares') or 0 for e in ins if e['side'] == 'sell'))},
            'news': _news(s, since),   # [date, title, link, AI summary of its PDF when read_notices.py has read it]
        }
        n += 1
    return n
