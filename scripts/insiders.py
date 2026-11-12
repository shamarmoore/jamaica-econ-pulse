"""Parse JSE announcements (data/insiders.json, data/news.json) into structured events.

Insider notices are short and formulaic ("…advised that a Director purchased 511,439 JP shares on May 24, 2024"),
so plain rules read them reliably; no language model is needed for the back-test.
  parse(post)  -> {'sym', 'side': buy|sell|mixed|None, 'who': director|officer|connected|company|None, 'shares', 'skip'}
  events()     -> list of parsed insider events (with publication date) for idea_tests.py / signals.py
  write_feed() -> data/news_feed.json for the app (last 90 days, with symbol, type and insider details)
Usage: python scripts/insiders.py   (writes the feed and prints a parsing summary)"""
import json, re
from datetime import datetime, timedelta, timezone

PREF = re.compile(r'\d\.\d|PREF|\d{2}$')
STOP = {'LIMITED', 'LTD', 'GROUP', 'COMPANY', 'CO', 'INC', 'CORPORATION', 'CORP', 'HOLDINGS', 'HOLDING', 'THE', 'PLC', 'SA', 'S.A', 'OF', 'AND', '&', 'JA', 'JAMAICA'}
_CACHE = {}


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def universe():
    """Ordinary-share symbols with their company names, from the price history and company financials."""
    if 'u' in _CACHE:
        return _CACHE['u']
    H = _load('data/jse_history.json', {}).get('dates', {})
    syms = set()
    for d in sorted(H)[-260:]:
        syms |= set(H[d])
    F = _load('data/jse_fundamentals.json', {}).get('stocks', {})
    names = {}
    for s in syms:
        n = (F.get(s) or {}).get('name')
        if n:
            words = [w for w in re.sub(r'[^A-Z0-9& ]', ' ', n.upper()).split() if w not in STOP]
            if words:
                names[s] = ' '.join(words)
    _CACHE['u'] = (syms, names)
    return syms, names


def find_sym(title, text=''):
    syms, names = universe()
    T = f'{title} {text[:300]}'
    up = re.sub(r'[^A-Z0-9& ]', ' ', T.upper())
    up = ' ' + re.sub(r'\s+', ' ', up) + ' '
    for m in re.findall(r'\(\s*[\'‘’"“]?([A-Z0-9]{2,12})[\'‘’"”]?\s*\)', T):  # "(NCBFG)", "(‘JP’)"
        if m in syms and not PREF.search(m):
            return m
    best, bl = None, 0
    for s, n in names.items():  # longest company name found in the title wins; ordinary shares preferred
        if len(n) >= 3 and f' {n} ' in up and (len(n) > bl or (len(n) == bl and best and PREF.search(best) and not PREF.search(s))):
            best, bl = s, len(n)
    if best:
        return best
    for w in set(re.findall(r'\b[A-Z][A-Z0-9]{1,11}\b', T)):  # a bare symbol in the text ("…539,787 JAMT shares")
        if w in syms and not PREF.search(w) and len(w) >= 3:
            return w
    return None


BUY = re.compile(r'\b(purchas\w*|bought|acquir\w*|buys?)\b', re.I)
SELL = re.compile(r'\b(sold|sells?|sale|dispos\w*)\b', re.I)
SKIP = re.compile(r'in lieu of|issued|allot|transferr?\w*|gift|vest\w*|exercis\w*|options?\b|bonus|ESOP|employee share|rights issue|scrip|amalgamat|settlement of', re.I)
COMPANY = re.compile(r'repurchas\w*|buy[- ]?back|share repurchase|treasury', re.I)
NUM = re.compile(r'(\d{1,3}(?:,\d{3})+|\d{3,})(?:\.\d+)?\s*(?:\(?[A-Z]{2,10}\)?\s*)?(?:ordinary\s+|stock\s+)?(?:shares|units|stock units|share units)', re.I)


def parse(p):
    title, text = p.get('title', ''), p.get('text', '')
    body = f'{title}. {text}'
    sym = find_sym(title, text)
    who = None
    if COMPANY.search(body):
        who = 'company'
    elif re.search(r'connected|related part|associated|entity|relative|spouse', body, re.I):
        who = 'connected'
    if re.search(r'\bdirector', body, re.I):
        who = 'director' if who in (None, 'connected') and not re.search(r'connected (?:with|to) (?:a|the) director|party connected|entity connected', body, re.I) else who
    if who is None and re.search(r'officer|manager|management|executive|\bCEO\b|\bCFO\b|chairman|president|secretary', body, re.I):
        who = 'officer'
    b, s = bool(BUY.search(body)), bool(SELL.search(body))
    side = 'mixed' if b and s else 'buy' if b else 'sell' if s else None
    nums = [float(x.replace(',', '')) for x in NUM.findall(body)]
    shares = max(nums) if nums else None
    if side == 'mixed':  # weigh each clause: "a Related Entity purchased 11,603 … and a Senior Manager sold 60,705 …"
        tot = {'buy': 0.0, 'sell': 0.0}
        for cl in re.split(r'[.;]\s|,\s(?=[A-Za-z])|\band\b', text or title):
            cb, cs = bool(BUY.search(cl)), bool(SELL.search(cl))
            n = [float(x.replace(',', '')) for x in NUM.findall(cl)] or [float(x.replace(',', '')) for x in re.findall(r'\d{1,3}(?:,\d{3})+', cl)]
            if cb != cs and n:
                tot['buy' if cb else 'sell'] += max(n)
        if tot['buy'] >= 3 * tot['sell'] and tot['buy'] > 0:
            side, shares = 'buy', tot['buy'] - tot['sell']
        elif tot['sell'] >= 3 * tot['buy'] and tot['sell'] > 0:
            side, shares = 'sell', tot['sell'] - tot['buy']
    if who == 'company':
        side = 'buy'
    skip = bool(SKIP.search(body)) and not b and not s
    return {'sym': sym, 'side': side, 'who': who, 'shares': shares, 'skip': skip}


def events():
    """Every parsed insider notice with a symbol and a clear side."""
    out = []
    for p in _load('data/insiders.json', {}).get('posts', []):
        e = parse(p)
        if e['sym'] and e['side'] in ('buy', 'sell') and not e['skip']:
            e.update(id=p['id'], date=p['date'][:10], time=p['date'][11:16], title=p.get('title', ''))
            out.append(e)
    return sorted(out, key=lambda e: e['date'])


KIND = [('results', re.compile(r'financial (?:statement|report|result)|interim report|unaudited|audited|quarter ended|year ended|annual report|report to (?:stock|share)holders', re.I)),
        ('dividend', re.compile(r'dividend|capital distribution', re.I)),
        ('insider', re.compile(r'trading in (?:shares|stock)|trading activity|trade in shares|purchase of shares|sale of shares|trading of shares|connected part', re.I)),
        ('meeting', re.compile(r'annual general meeting|\bAGM\b|extraordinary general meeting|board meeting|notice of meeting', re.I)),
        ('board', re.compile(r'appoint|resign|retire|director|chief executive|\bCEO\b|\bCFO\b|separat', re.I)),
        ('capital', re.compile(r'rights issue|additional public offer|\bAPO\b|\bIPO\b|prospectus|bond|notes? issue|preference share|stock split|share split|listing', re.I))]


def kind_of(p):
    k = p.get('kind')
    if k in ('insider', 'results', 'dividend'):
        return k
    T = p.get('title', '')
    for name, rx in KIND:
        if rx.search(T):
            return name
    return 'notice'


def write_feed(days=90):
    news = _load('data/news.json', {}).get('posts', [])
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%d')
    out = []
    for p in news:
        if p['date'][:10] < since:
            continue
        k = kind_of(p)
        item = {'id': p['id'], 'd': p['date'][:16].replace('T', ' '), 'k': k, 's': find_sym(p.get('title', ''), p.get('text', '')),
                't': p.get('title', ''), 'x': p.get('text', '')[:900], 'u': p.get('link')}
        if k == 'insider':
            e = parse(p)
            if not e['skip'] and e['side']:
                item['ins'] = {'side': e['side'], 'who': e['who'], 'shares': e['shares']}
        out.append(item)
    json.dump({'updated': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'days': days, 'posts': out}, open('data/news_feed.json', 'w'), separators=(',', ':'))
    return out


if __name__ == '__main__':
    E = events()
    allp = _load('data/insiders.json', {}).get('posts', [])
    parsed = [parse(p) for p in allp]
    from collections import Counter
    print('insider posts', len(allp), 'with symbol', sum(1 for e in parsed if e['sym']), 'usable events', len(E))
    print('sides', Counter(e['side'] for e in parsed), 'who', Counter(e['who'] for e in parsed))
    feed = write_feed()
    print('FEED', len(feed), 'posts;', sum(1 for x in feed if x['s']), 'with symbol;', Counter(x['k'] for x in feed))
