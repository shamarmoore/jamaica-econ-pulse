"""Blind test of the recovery AI: would its verdicts on past big fallers have told the recoveries from the traps?

Cases: every stock 40%+ below its 2-year high (scripts/recovery.py) on a 63-trading-day grid, so one case per stock per
quarter. For each case the script rebuilds the facts the app's AI gets, using only what was known that day: the price
drop, quarterly profits already published, dividends, insider trades and announcements since the peak, the Edge rank
when the walk-forward history has it, and History lines built only from earlier cases whose 6 months had already
passed. The company's name and symbol are removed and dates are given as "N months before", so the model can't look the
company up in its memory. The prompt is read from www/js/nano.js, the one the app ships. Each verdict is then scored by
the stock's next 6 months against the average stock, after 1.5% costs each way.

Historical cases see fewer announcements than live ones (the archive keeps dividends, splits, take-overs, rights issues,
suspensions, results and insider trades, not every notice), so this tests the AI with less to go on than it has today.

  GEMINI_API_KEY=... python scripts/ai_backtest.py [max_new_cases=400] [--dry-run]  -> data/ai_backtest.json
Re-running continues where the last run stopped; finished cases are kept."""
import json, os, re, sys, time, urllib.error, urllib.request

MAX = int(next((a for a in sys.argv[1:] if a.isdigit()), 400))
DRY = '--dry-run' in sys.argv
sys.argv = sys.argv[:1]
sys.path.insert(0, 'scripts')
import numpy as np
import pandas as pd
import factor_study as fs
import insiders as INS
import recovery
from tslib import _quarter_events

KEY = os.environ.get('GEMINI_API_KEY', '').strip()
MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.5-flash-lite')   # the app's default cloud model
OUT = 'data/ai_backtest.json'
STEP, H, COST = 63, recovery.H, 0.015
MIN_HISTORY = 200
P, TRI, idx, N, syms = fs.P, fs.TRI, fs.idx, fs.N, fs.syms
VERDICT = re.compile(r'Verdict:\s*\**\s*(Avoid|Watch|Speculative)', re.I)


def app_prompt():
    """The recovery prompt exactly as the app builds it: RULES and recoveryPrompt from www/js/nano.js."""
    js = open('www/js/nano.js', encoding='utf-8').read()
    rules = re.search(r'const RULES = `(.*?)`;', js, re.S).group(1)
    body = re.search(r'export function recoveryPrompt\(facts\) \{\s*return `(.*?)`;\s*\}', js, re.S).group(1)
    return body.replace('${RULES}', rules)


def outcome(s, t):
    r = float(np.clip(TRI[s].iloc[t + 1 + H] / TRI[s].iloc[t + 1], 0.05, 4) * (1 - COST) ** 2 - 1)
    m = (fs.V.iloc[max(0, t - 59):t + 1] > 0).mean() >= 0.2
    u = m.values & (P.iloc[t].values > 0) & (TRI.iloc[t + 1].values > 0)
    mk = float(np.nanmean(np.clip(TRI.iloc[t + 1 + H].values[u] / TRI.iloc[t + 1].values[u] - 1, -0.9, 3)))
    return r, r - mk


# ---- every episode on a 21-day grid, with its situation and outcome: the pool History lines are built from
HIST = json.load(open('data/edge_hist.json'))['days'] if os.path.exists('data/edge_hist.json') else {}


def rank_on(t):
    d = HIST.get(str(idx[t].date()))
    return d


pool = []
for t in range(277, N - H - 2, 21):
    day = rank_on(t) or {}
    for s in syms:
        if TRI[s].iloc[t + 1] > 0 and recovery.in_watch(fs, t, s):
            r, ex = outcome(s, t)
            pool.append((t, s, recovery.groups(fs, t, s, day[s][1] if s in day else None), r, ex))
LABEL = {'all126': 'any stock this far down', 'lossMaking126': 'loss-making', 'profitable126': 'still profitable',
         'lossesShrinking126': 'loss-making, losses shrinking 2 quarters running', 'insiderBuying126': 'insiders buying',
         'noDividend126': 'no dividend in the last year', 'edgeTop20_126': 'Edge ranks it in the top 20', 'edge21to40_126': 'Edge rank 21–40',
         'edge41plus126': 'Edge rank 41 or lower', 'edgeUnranked126': 'too thinly traded for an Edge rank'}


def history_lines(t, groups):
    known = [p for p in pool if p[0] + 1 + H <= t]
    out = []
    for g in groups:
        sel = [p for p in known if g in p[2]]
        if len(sel) >= 15:
            r = np.array([p[3] for p in sel]); ex = np.array([p[4] for p in sel])
            out.append(f'History, {LABEL[g]} ({len(sel)} cases): {round((r >= 0.25).mean() * 100)}% rose 25%+ and {round((r <= -0.15).mean() * 100)}% fell 15%+ over 6 months; {ex.mean() * 100:+.1f}% vs the market on average.')
    return out


# ---- announcements with text, for the facts
ARCH = json.load(open('data/events_archive.json', encoding='utf-8')).get('posts', [])
REPORTS = json.load(open('data/reports_index.json', encoding='utf-8')).get('posts', [])
INSIDE = [e for e in INS.events() if not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell')]


GENERIC = {'limited', 'ltd', 'company', 'group', 'holdings', 'jamaica', 'jamaican', 'caribbean', 'the', 'and', 'of', 'co', 'inc', 'plc', 'fund', 'funds'}


def anon(text, s):
    """Company name, symbol and years removed, so the model can't recognise the company or the date."""
    words = re.findall(r'[A-Za-z0-9&]+', (fs.FUND.get(s) or {}).get('name') or '')
    text = re.sub(rf'^.*?\(\s*{re.escape(s)}\s*\)', 'The Company', text)
    text = re.sub(rf'\b{re.escape(s)}\b', 'the Company', text)
    for w in [w for w in words if w.lower() not in GENERIC and len(w) > 2]:
        text = re.sub(rf'\b{re.escape(w)}\b', 'the Company', text, flags=re.I)
    text = re.sub(r'\b(19|20)\d\d\b', '', text)
    text = re.sub(r'(the Company[\s,\-–]*)+(limited|ltd\.?|group|holdings)?', 'the Company ', text, flags=re.I)
    return re.sub(r'\s{2,}', ' ', text).strip()


def months_before(d, t):
    return max(0, round((idx[t] - pd.Timestamp(d)).days / 30.4))


def facts(s, t):
    w = P[s].iloc[max(0, t - recovery.LOOKBACK + 1):t + 1]
    peak = w.idxmax(); since = str(peak.date()); today = str(idx[t].date())
    L = [f'Stock: the Company. Price J${P[s].iloc[t]:,.2f}, {abs(recovery.drop(fs, t, s)) * 100:.0f}% below its 2-year high of J${w.max():,.2f} ({months_before(peak, t)} months before).']
    q = [(d, v) for d, v in _quarter_events(fs.FUND.get(s) or {}) if d <= idx[t]][-8:]
    if q:
        L.append('Quarterly profit as published, oldest to newest: ' + ', '.join(f'{"−" if v < 0 else "+"}J${abs(v) / 1e6:,.0f}M' for _, v in q) + '.')
    divs = [d['ex'] for d in (fs.FUND.get(s) or {}).get('dividends', []) if d.get('ex') and d['ex'] <= today]
    L.append(f'Last dividend paid (ex-date) {months_before(max(divs), t)} months before.' if divs else 'No dividends on record.')
    ins = [e for e in INSIDE if e['sym'] == s and since <= e['date'] <= today]
    b = [e for e in ins if e['side'] == 'buy']; sl = [e for e in ins if e['side'] == 'sell']
    L.append(f'Insider trades since the peak: {len(b)} buy notices ({int(sum(e.get("shares") or 0 for e in b)):,} shares), {len(sl)} sell notices ({int(sum(e.get("shares") or 0 for e in sl)):,} shares).')
    posts = [(p['date'][:10], p.get('title', ''), p.get('text', '')) for p in ARCH if since <= p['date'][:10] <= today and re.search(rf'\({re.escape(s)}\)', p.get('title', ''))]
    posts += [(p['date'], p['title'], '') for p in REPORTS if p.get('sym') == s and since <= p['date'] <= today]
    posts.sort(reverse=True)
    if posts:
        L.append('Announcements since the peak (newest first): ' + '; '.join(f'[{months_before(d, t)} months before] {anon(ti, s)}' for d, ti, _ in posts[:8]) + '.')
        texts = [f'[{months_before(d, t)} months before] {anon(x, s)[:220]}' for d, _, x in posts if x][:3]
        if texts:
            L.append('Text of the latest announcements: ' + ' | '.join(texts))
    day = rank_on(t)
    rank = day[s][1] if day and s in day else None
    if day and s in day:
        L.append(f'Edge score {day[s][0]}/100' + (f', rank {rank} of {sum(1 for v in day.values() if v[1])}.' if rank else ' (not ranked: trades on fewer than half of days).'))
    L += history_lines(t, recovery.groups(fs, t, s, rank if day and s in day else None))
    tr = (fs.V[s].iloc[t - 59:t + 1] > 0).mean() * 100
    L.append(f'Trades on {tr:.0f}% of days, about J${(fs.JVAL[s].iloc[t - 19:t + 1].mean()) / 1e6:,.1f}M a day.')
    return '\n'.join(L)


def ask(prompt):
    body = json.dumps({'contents': [{'role': 'user', 'parts': [{'text': prompt}]}],
                       'systemInstruction': {'parts': [{'text': 'You are a careful, plain-spoken assistant inside a Jamaica Stock Exchange research app. Follow the user’s format exactly. Use only the facts provided.'}]},
                       'generationConfig': {'temperature': 0.2, 'maxOutputTokens': 1600}}).encode()
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, data=body, headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
            with urllib.request.urlopen(req, timeout=120) as r:
                j = json.loads(r.read())
            return ''.join(p.get('text', '') for p in j['candidates'][0]['content']['parts'])
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 503) and attempt < 4:
                time.sleep(15 * (attempt + 1)); continue
            raise RuntimeError(f'Gemini HTTP {e.code}: {e.read().decode("utf-8", "replace")[:200]}')
        except (KeyError, IndexError):
            return ''
    return ''


def summary(cases):
    rows = [c for c in cases.values() if 'excess' in c]
    half = sorted(c['date'] for c in rows)[len(rows) // 2] if rows else None
    out = {}
    for v in ('Avoid', 'Watch', 'Speculative', 'none'):
        g = [c for c in rows if c['verdict'] == v]
        if not g:
            continue
        ex = pd.Series([c['excess'] for c in g], index=pd.DatetimeIndex([c['date'] for c in g]))
        r = np.array([c['ret'] for c in g])
        bym = ex.groupby(ex.index.to_period('M')).mean()
        t = float(bym.mean() / (bym.std() / np.sqrt(len(bym)))) if len(bym) > 2 and bym.std() > 0 else 0.0
        f, s2 = ex[ex.index < half], ex[ex.index >= half]
        holds = len(f) >= 5 and len(s2) >= 5 and np.sign(f.mean()) == np.sign(s2.mean())
        out[v.lower() + '126'] = {'n': len(g), 'avgExcess': round(float(ex.mean()) * 100, 2), 'median': round(float(np.median(r)) * 100, 1),
                                  'bigWin': round(float((r >= 0.25).mean()) * 100), 'bigLoss': round(float((r <= -0.15).mean()) * 100), 't': round(t, 2),
                                  'firstHalf': round(float(f.mean()) * 100, 2) if len(f) >= 5 else None, 'secondHalf': round(float(s2.mean()) * 100, 2) if len(s2) >= 5 else None,
                                  'verdict': ('edge' if ex.mean() > 0 else 'negative edge (avoid)') if abs(t) >= 2 and holds else 'no reliable edge'}
    out['cases'] = len(rows)
    out['from'] = min((c['date'] for c in rows), default=None); out['to'] = max((c['date'] for c in rows), default=None)
    return out


def main():
    store = json.load(open(OUT, encoding='utf-8')) if os.path.exists(OUT) else {'cases': {}}
    template = app_prompt()
    # only days with History behind them: at least MIN_HISTORY earlier cases whose 6 months had passed
    first = next(t for t in range(300, N, 21) if sum(1 for p in pool if p[0] + 1 + H <= t) >= MIN_HISTORY)
    todo = [(t, s) for t in range(first, N - H - 2, STEP) for s in syms
            if f'{s}|{idx[t].date()}' not in store['cases'] and TRI[s].iloc[t + 1] > 0 and recovery.in_watch(fs, t, s)]
    print(f'AI BACKTEST {len(todo)} cases waiting, {len(store["cases"])} done; model {MODEL}; running {min(MAX, len(todo))}')
    if DRY:
        for t, s in todo[:2]:
            print('-----', s, idx[t].date(), '\n' + template.replace('${facts}', facts(s, t)))
        return
    if not KEY:
        print('AI BACKTEST skipped: no GEMINI_API_KEY'); return
    for i, (t, s) in enumerate(todo[:MAX]):
        text = ask(template.replace('${facts}', facts(s, t)))
        m = VERDICT.search(text)
        r, ex = outcome(s, t)
        store['cases'][f'{s}|{idx[t].date()}'] = {'sym': s, 'date': str(idx[t].date()), 'verdict': m.group(1).capitalize() if m else 'none',
                                                  'ret': round(r, 4), 'excess': round(ex, 4), 'answer': text[:900]}
        if i % 10 == 9:
            store['summary'] = summary(store['cases']); store['model'] = MODEL
            json.dump(store, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    store['summary'] = summary(store['cases']); store['model'] = MODEL
    json.dump(store, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('AI BACKTEST', json.dumps(store['summary']))


if __name__ == '__main__':
    main()
