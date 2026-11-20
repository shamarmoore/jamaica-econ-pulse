"""Each company's largest shareholders, read from its results reports with a low-cost Gemini model.

JSE rules make listed companies print their ten largest shareholders in every quarterly report. Nothing else publishes
who owns what, so this is the only record of a big holder adding or cutting. For each report in data/reports_index.json
the script sends only the page(s) holding that list: the text of pages with a "top ten / largest shareholders" heading,
or, when no page has one, the pages that are pictures with no text layer (as a small PDF). A list is kept as checked
("ok") only when its holdings fall in order and agree with the percentages printed beside them.

  data/shareholders.json : {'reports': {post_id: {sym, date, asOf, issued, holders: [[name, units, pct]], src, ok}}}
  changes()              -> one row per pair of consecutive checked lists for a company (idea_tests.py, forecast.py)
  latest(sym)            -> the newest checked list with each holder's change since the list before it
Usage: GEMINI_API_KEY=... python scripts/shareholders.py [max=300] [--cache=DIR] [--dry-run]
--cache reads PDFs saved as DIR/<post id>.pdf instead of downloading them."""
import base64, io, json, os, re, sys, tempfile, threading, time
from concurrent.futures import ThreadPoolExecutor

MAX = int(next((a for a in sys.argv[1:] if a.isdigit()), 300))
DRY = '--dry-run' in sys.argv
CACHE = next((a[8:] for a in sys.argv[1:] if a.startswith('--cache=')), None)
sys.path.insert(0, 'scripts')
RR = None   # read_reports, loaded by main() only: the analysis functions below need no network or model

OUT = 'data/shareholders.json'
IDX = 'data/reports_index.json'
WORKERS = 4
FILE_MAX = 15 * 1024 * 1024
HEAD = re.compile(r'(top|largest)\s*(ten|10|\(10\))|ten\s*(\(10\)\s*)?largest|top\s*\d+\s*(share|stock)\s*holders|(major|substantial)\s+(share|stock)\s*holders', re.I)
PROMPT = '''This is part of a results report from a company listed on the Jamaica Stock Exchange ("{title}", published {date}).
Find the table of its largest (top ten) shareholders. Return ONLY a JSON object:
 "found": true or false,
 "as_of": "YYYY-MM-DD", the date the list is as at, or null,
 "issued_shares": the total shares in issue if printed, or null,
 "holders": [{{"name": ..., "units": ..., "pct": ...}}] in the order printed, largest first, at most 10, leaving out totals and
   the directors' and managers' own holdings tables. units = shares held, as a plain number; pct = percent of the company, or null.
Copy the numbers exactly as printed. If there is no such table, return {{"found": false, "holders": []}}.'''
_lock = threading.Lock()


def _load(p, d):
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return d


def _num(v):
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = re.sub(r'[^\d.\-]', '', str(v))
    try:
        return float(s) if s not in ('', '.', '-') else None
    except ValueError:
        return None


def pages_to_send(path, pdf):
    """(parts for the model, 'text' | 'image' | None, why) for the page(s) holding the shareholder list."""
    pages = RR.pdf_pages(path)
    hit = [i for i, t in enumerate(pages) if HEAD.search(t)]
    if hit:
        pick = sorted({j for i in hit[:2] for j in (i, i + 1) if j < len(pages)})
        return [{'text': '\n\f\n'.join(pages[j] for j in pick)[:12000]}], 'text', None
    blank = [i for i, t in enumerate(pages) if len(t.strip()) < 40]
    if not blank:
        return None, None, 'no shareholder list in the text'
    from pypdf import PdfReader, PdfWriter
    r = PdfReader(io.BytesIO(pdf))
    pick = blank[-4:] if len(blank) < len(r.pages) else list(range(max(0, len(r.pages) - 6), len(r.pages)))
    w = PdfWriter()
    for i in pick:
        if i < len(r.pages):
            w.add_page(r.pages[i])
    b = io.BytesIO(); w.write(b)
    if b.tell() > FILE_MAX:
        return None, None, 'scanned pages too large'
    return [{'inline_data': {'mime_type': 'application/pdf', 'data': base64.b64encode(b.getvalue()).decode()}}], 'image', None


def check(holders, issued):
    """A list counts only if it is in falling order and its units agree with its percentages."""
    if len(holders) < 3:
        return False
    u = [h[1] for h in holders]
    if any(x is None or x <= 0 for x in u) or any(b > a * 1.001 for a, b in zip(u, u[1:])):
        return False
    implied = [h[1] / (h[2] / 100) for h in holders if h[2]]
    if issued:
        implied.append(issued)
    if len(implied) >= 2:
        mid = sorted(implied)[len(implied) // 2]
        if sum(abs(x / mid - 1) < 0.03 for x in implied) < 0.7 * len(implied):
            return False
    return True


def read(p):
    url = p['links'][0][0]
    if CACHE and os.path.exists(os.path.join(CACHE, f"{p['id']}.pdf")):
        b = open(os.path.join(CACHE, f"{p['id']}.pdf"), 'rb').read()
    else:
        with _lock:   # one request to the JSE at a time, spaced by RR.get
            b = RR.get(url, binary=True)
    base = {'sym': p['sym'], 'date': p['date'][:10], 'title': p['title'][:160]}
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
        f.write(b); path = f.name
    try:
        parts, src, why = pages_to_send(path, b)
    finally:
        os.unlink(path)
    if not parts:
        return {**base, 'skip': why}
    if DRY:
        return {**base, 'src': src, 'dry': True, 'chars': len(parts[0].get('text', ''))}
    r = RR.ask_gemini([{'text': PROMPT.format(title=p['title'][:160], date=p['date'][:10])}] + parts)
    if not isinstance(r, dict) or not r.get('found') or not r.get('holders'):
        return {**base, 'src': src, 'skip': 'no shareholder list found'}
    holders = [[str(h.get('name') or '').strip()[:80], _num(h.get('units')), _num(h.get('pct'))] for h in r['holders'][:10] if isinstance(h, dict)]
    issued = _num(r.get('issued_shares'))
    return {**base, 'asOf': r.get('as_of'), 'issued': issued, 'holders': holders, 'src': src, 'model': RR.MODEL, 'ok': check(holders, issued)}


def main():
    global RR
    sys.argv = sys.argv[:1]   # read_reports reads its own arguments when imported
    import read_reports as RR
    if not RR.KEY and not DRY:
        print('SHAREHOLDERS skipped: no GEMINI_API_KEY'); return
    store = _load(OUT, {'reports': {}})
    todo = [p for p in _load(IDX, {'posts': []})['posts'] if p.get('sym') and p.get('links') and str(p['id']) not in store['reports']]
    if DRY and CACHE:
        todo = [p for p in todo if os.path.exists(os.path.join(CACHE, f"{p['id']}.pdf"))]
    todo = sorted(todo, key=lambda p: p['date'], reverse=True)[:MAX]
    done = [0]

    def one(p):
        try:
            r = read(p)
        except Exception as e:
            print('report failed:', p['sym'], p['date'][:10], repr(e)[:160]); return
        with _lock:
            store['reports'][str(p['id'])] = r; done[0] += 1
            if done[0] % 25 == 0 and not DRY:
                json.dump(store, open(OUT, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
                print('saved', done[0], flush=True)
    with ThreadPoolExecutor(WORKERS) as ex:
        list(ex.map(one, todo))
    if not DRY:
        json.dump(store, open(OUT, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    R = store['reports'].values()
    print(f"SHAREHOLDERS read {done[0]} of {len(todo)}; stored {len(store['reports'])}, checked {sum(1 for r in R if r.get('ok'))}, "
          f"skipped {sum(1 for r in R if r.get('skip'))}; tokens {RR.tokens}")
    with open(os.environ.get('MORE_FLAG', os.path.join(tempfile.gettempdir(), 'shareholders_more')), 'w') as f:
        f.write('yes' if len(todo) == MAX else 'no')
    if DRY:
        for p in todo[:40]:
            print(' ', json.dumps(store['reports'].get(str(p['id'])), ensure_ascii=False)[:200])


# ---------------------------------------------------------------- analysis
def _key(name):
    words = re.sub(r'[^A-Z0-9 ]', ' ', (name or '').upper()).split()
    return ' '.join(w for w in words if w not in {'LIMITED', 'LTD', 'LTD.', 'THE', 'CO', 'COMPANY', 'INC', 'A/C', 'AC'})


def _pct(h, issued):
    if h[2] is not None:
        return h[2]
    return 100 * h[1] / issued if issued else None


def lists(sym=None):
    """{sym: [checked list, oldest first]}, one per publication date."""
    out = {}
    for r in _load(OUT, {'reports': {}})['reports'].values():
        if r.get('ok') and (sym is None or r['sym'] == sym):
            out.setdefault(r['sym'], {})[r['date']] = r
    return {s: [v[d] for d in sorted(v)] for s, v in out.items()}


def changes(max_gap=200):
    """One row per pair of consecutive checked lists: the largest holder's change in % of the company (same holder by
    name), the change in the top ten's combined %, and any holder new to the list with 2%+."""
    from datetime import date
    rows = []
    for s, L in lists().items():
        for a, b in zip(L, L[1:]):
            gap = (date.fromisoformat(b['date']) - date.fromisoformat(a['date'])).days
            if gap > max_gap:
                continue
            top = max(a['holders'], key=lambda h: h[1])
            same = [h for h in b['holders'] if _key(h[0]) == _key(top[0])]
            pa, pb = _pct(top, a.get('issued')), (_pct(same[0], b.get('issued')) if same else None)
            had = {_key(h[0]) for h in a['holders']}
            tot = lambda r: sum(p for p in (_pct(h, r.get('issued')) for h in r['holders']) if p is not None)
            rows.append({'sym': s, 'date': b['date'], 'prev': a['date'], 'holder': top[0], 'largestPct': pb, 'largestChange': (pb - pa) if pa is not None and pb is not None else None,
                         'stillThere': bool(same), 'top10Change': tot(b) - tot(a),
                         'newBig': max([p for h in b['holders'] if _key(h[0]) not in had for p in [_pct(h, b.get('issued'))] if p is not None] or [0])})
    return rows


def latest(sym):
    """Newest checked list for sym: as-of date and up to five holders with their % and change since the list before."""
    L = lists(sym).get(sym)
    if not L:
        return None
    b = L[-1]; a = L[-2] if len(L) > 1 else None
    prev = {_key(h[0]): _pct(h, a.get('issued')) for h in a['holders']} if a else {}
    top = []
    for h in b['holders'][:5]:
        p = _pct(h, b.get('issued'))
        was = prev.get(_key(h[0]))
        top.append([h[0], round(p, 2) if p is not None else None, round(p - was, 2) if p is not None and was is not None else None])
    return {'asOf': b.get('asOf') or b['date'], 'published': b['date'], 'prev': a['date'] if a else None, 'top': top}


if __name__ == '__main__':
    main()
