"""Every test the app has run, in one file, judged by a stricter bar than each study uses on its own.

With about 160 tests, roughly 4 would pass t >= 2 by luck alone. Here a test is a proven edge (or a proven 'avoid') only if
 - its t-stat, shrunk for overlapping holding periods, is at least 3 in size
 - the effect has the same sign in the first and the second half
 - it has at least 30 cases
Tests are never removed. One that a study stops producing stays as 'retired', so the count of tests tried only grows.
Holding periods are read from test names (21, 63, 126 days); a name without one is treated as 63 days, the cautious choice.

  update(edge_v2_output)   -> data/test_registry.json (called by edge_v2.py)
  python scripts/test_registry.py   -> rebuilds from data/idea_tests.json, data/factor_study.json and data/edge_v2.json
"""
import json, re
import numpy as np

PATH = 'data/test_registry.json'
STRICT_T = 3.0
MIN_N = 30


def _load(p, d):
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return d


def _hold(name):
    for h, pat in ((126, r'126'), (63, r'63'), (21, r'21|10d|5d')):
        if re.search(pat, name):
            return h, False
    return 63, True


def _verdict(t, first, second, n):
    if t is None or n is None or n < MIN_N or first is None or second is None or np.sign(first) != np.sign(second):
        return 'not proven'
    return 'edge' if t >= STRICT_T else 'avoid' if t <= -STRICT_T else 'not proven'


def _ideas(it):
    out = []

    def walk(o, path):
        if isinstance(o, dict):
            if 'verdict' in o and o.get('t') is not None:
                name = '/'.join(path); hold, assumed = _hold(name)
                ta = o['t'] / np.sqrt(max(1, hold / 21))   # t uses monthly clusters; longer holds overlap months
                out.append({'id': f'idea/{name}', 'family': path[0], 'n': o.get('n'), 't': o['t'], 'tAdj': round(float(ta), 2), 'hold': hold, 'holdAssumed': assumed,
                            'effect': o.get('avgExcess'), 'first': o.get('firstHalf'), 'second': o.get('secondHalf'), 'studyVerdict': o['verdict']})
            for k, v in o.items():
                walk(v, path + [k])
    walk(it, [])
    return out


def _factors(fs):
    out = []
    for h in ('h21', 'h63'):
        for k, v in (fs.get(h, {}).get('features') or {}).items():
            a, f, s = v.get('all'), v.get('first'), v.get('second')
            if not a:
                continue
            ta = a['t'] / np.sqrt(3)   # three start offsets spaced a third of the hold apart are pooled
            out.append({'id': f'factor/{h}/{k}', 'family': 'factor_study', 'n': a['n'], 't': a['t'], 'tAdj': round(float(ta), 2), 'hold': int(h[1:]), 'holdAssumed': False,
                        'effect': a['ic'], 'first': (f or {}).get('ic'), 'second': (s or {}).get('ic'), 'studyVerdict': 'chosen' if abs((f or {}).get('t') or 0) >= 2 else 'not chosen'})
    return out


def _edge_v2(v2):
    out = []
    res = (v2 or {}).get('results', {})
    named = [('edge_v1/realistic_fills' if k == 'v1' else f'edge_v2/{k}', r) for k, r in res.items() if k != 'rules']
    named += [(f'edge_v2/rule/{k}', r) for k, r in res.get('rules', {}).items()]
    for name, r in named:
        w = r.get('walk') or r.get('honest')
        if not w:
            continue
        out.append({'id': name, 'family': 'edge_v2', 'n': w['periods'] * 3, 't': w['t'], 'tAdj': w['t'], 'hold': 63, 'holdAssumed': False,
                    'effect': w['avgExcess'], 'first': w['firstHalf'], 'second': w['secondHalf'], 'studyVerdict': 'walk-forward back-test'})
    return out


def update(v2=None, today=None):
    v2 = v2 if v2 is not None else _load('data/edge_v2.json', {})
    today = today or (v2 or {}).get('made') or ''
    rows = _ideas(_load('data/idea_tests.json', {})) + _factors(_load('data/factor_study.json', {})) + _edge_v2(v2)
    old = {r['id']: r for r in _load(PATH, {}).get('tests', [])}
    tests = []
    for r in rows:
        r['verdict'] = _verdict(r['tAdj'], r['first'], r['second'], r['n'])
        r['firstSeen'] = old.get(r['id'], {}).get('firstSeen', today)
        r['status'] = 'active'
        tests.append(r)
    seen = {r['id'] for r in tests}
    for k, r in old.items():
        if k not in seen:
            tests.append({**r, 'status': 'retired'})
    active = [r for r in tests if r['status'] == 'active']
    loose = [r for r in active if r['studyVerdict'] in ('edge', 'negative edge (avoid)', 'chosen')]
    summ = {'tests': len(tests), 'active': len(active), 'passLoose': len(loose),
            'edges': sorted(r['id'] for r in active if r['verdict'] == 'edge'), 'avoids': sorted(r['id'] for r in active if r['verdict'] == 'avoid'),
            'luckExpected': round(len(active) * 0.05, 1),
            'bar': f'overlap-adjusted |t| >= {STRICT_T:g}, same sign in both halves, at least {MIN_N} cases'}
    summ['passStrict'] = len(summ['edges']) + len(summ['avoids'])
    json.dump({'updated': today, 'summary': summ, 'tests': sorted(tests, key=lambda r: r['id'])}, open(PATH, 'w', encoding='utf-8'), indent=1)
    print('REGISTRY', json.dumps({k: v for k, v in summ.items() if k not in ('edges', 'avoids')}))
    return summ


if __name__ == '__main__':
    update()
