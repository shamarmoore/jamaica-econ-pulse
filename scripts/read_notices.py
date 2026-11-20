"""Reads the PDFs behind key JSE announcements with a low-cost Gemini model, so the app's AI sees what a company actually
disclosed. Many notices are only a link to a PDF, and some PDFs are scanned letters with no text layer.

Which notices: the announcements listed in the last forecasts.json for stocks on the recovery watch or that just popped
(stocks[sym].recovery.news and stocks[sym].pop.recent.news): reviews, delays, take-overs and the like first, then results,
newest first within each, at most MAX a run. Each PDF is found through
the JSE's WordPress API; its text is sent when it has a text layer, the file itself when it is scanned. The summary is kept
for good in data/notices.json, keyed by the announcement's link. The app joins summaries back to news by link.
Usage: GEMINI_API_KEY=... python scripts/read_notices.py [max=15] [--syms=JBG,DCOVE] [--dry-run]
--syms reads those stocks' announcements of the last 2 years instead of the watch lists."""
import base64, json, os, re, subprocess, sys, tempfile, urllib.parse

MAX = int(next((a for a in sys.argv[1:] if a.isdigit()), 15))
DRY = '--dry-run' in sys.argv
SYMS = [s for a in sys.argv[1:] if a.startswith('--syms=') for s in a[7:].split(',') if s]
sys.argv = sys.argv[:1]   # read_reports reads its own arguments when imported
sys.path.insert(0, 'scripts')
import read_reports as RR

OUT = 'data/notices.json'
TEXT_MIN = 1500            # fewer characters than this means a scanned PDF: send the file
PAGE_MIN = 300             # a page without a PDF needs at least this much text to be worth reading
TEXT_MAX = 40000           # long reports: the first pages carry the story and keep the cost down
FILE_MAX = 15 * 1024 * 1024
PROMPT = '''You are reading a document published by a company listed on the Jamaica Stock Exchange.
Announcement: "{title}" ({date}).
Return ONLY a JSON object with these keys:
 "what": one or two plain sentences on what the document says happened,
 "why": the cause or reason the document gives, or null if it gives none,
 "numbers": the key figures with units and dates (profit, revenue, dividend per share, amounts), as one short string, or null,
 "one_off": "yes" if it describes a one-time event or charge, "no" if it describes an ongoing problem or trend, "unclear" otherwise,
 "next": what the company says happens next (actions, timelines, reviews), or null,
 "tone": "positive", "negative" or "neutral" for shareholders.
Use only what the document says. Do not guess.'''


def _load(p, d):
    try:
        return json.load(open(p, encoding='utf-8'))
    except Exception:
        return d


def wanted():
    """[(link, sym, date, title)] in reading order, from the stocks the app watches (or --syms)."""
    if SYMS:
        import recovery
        from datetime import date, timedelta
        since = str(date.today() - timedelta(days=730))
        lists = {s: recovery._news(s, since) for s in SYMS}
    else:
        F = _load('data/forecasts.json', {})
        lists = {sym: ((st.get('recovery') or {}).get('news') or []) + (((st.get('pop') or {}).get('recent') or {}).get('news') or [])
                 for sym, st in (F.get('stocks') or {}).items()}
    seen, out = set(), []
    for sym, items in lists.items():
        for n in items:
            if len(n) >= 3 and n[2] and n[2] not in seen:
                seen.add(n[2]); out.append((n[2], sym, n[0], n[1]))
    return sorted(out, key=lambda x: (priority(x[3]), x[2]), reverse=True)


KEY = re.compile(r'review|investigat|governance|delay|restat|impair|auditor|resign|suspen|take-?over|acqui|merger|rights issue|disposal|strategic|update|going concern', re.I)
RESULTS = re.compile(r'financial statements|results|annual report', re.I)


def priority(title):
    """Disclosures that explain a big move first, then results, then everything else."""
    return 2 if KEY.search(title) else 1 if RESULTS.search(title) else 0


def page(page_url):
    """(first PDF link, plain text) of a JSE announcement page, via the WordPress API (by the page's slug)."""
    slug = [p for p in urllib.parse.urlparse(page_url).path.split('/') if p][-1]
    posts = json.loads(RR.get(f'https://www.jamstockex.com/wp-json/wp/v2/posts?slug={urllib.parse.quote(slug)}&_fields=id,content'))
    if not posts:
        return None, ''
    html = posts[0]['content']['rendered']
    m = re.search(r'href="([^"]+\.pdf)"', html, re.I)
    return (m.group(1) if m else None), re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', html)).strip()


def read(link, sym, date, title):
    pdf, body = page(link)
    prompt = PROMPT.format(title=title, date=date)
    if not pdf:   # the disclosure is written on the page itself
        if len(body) < PAGE_MIN:
            return {'sym': sym, 'date': date, 'title': title, 'skip': 'no PDF and little text on the page'}
        return summarise(sym, date, title, None, 'page', [{'text': prompt + '\n\nDOCUMENT:\n' + body[:TEXT_MAX]}], len(body), 0)
    b = RR.get(pdf, binary=True)
    with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False) as f:
        f.write(b); path = f.name
    try:
        text = '\f'.join(RR.pdf_pages(path)).strip()
    finally:
        os.unlink(path)
    if len(text) >= TEXT_MIN:
        parts, src = [{'text': prompt + '\n\nDOCUMENT:\n' + text[:TEXT_MAX]}], 'text'
    elif len(b) <= FILE_MAX:
        parts, src = [{'inline_data': {'mime_type': 'application/pdf', 'data': base64.b64encode(b).decode()}}, {'text': prompt}], 'scan'
    else:
        return {'sym': sym, 'date': date, 'title': title, 'pdf': pdf, 'skip': f'scanned PDF too large ({len(b) // 1024} KB)'}
    return summarise(sym, date, title, pdf, src, parts, len(text), len(b))


def summarise(sym, date, title, pdf, src, parts, chars, size):
    if DRY:
        return {'sym': sym, 'date': date, 'title': title, 'pdf': pdf, 'src': src, 'chars': chars, 'bytes': size, 'dry': True}
    r = RR.ask_gemini(parts)
    if not isinstance(r, dict) or not r.get('what'):
        return {'sym': sym, 'date': date, 'title': title, 'pdf': pdf, 'src': src, 'skip': 'no usable answer'}
    keep = {k: (str(r.get(k))[:400] if r.get(k) is not None else None) for k in ('what', 'why', 'numbers', 'one_off', 'next', 'tone')}
    return {'sym': sym, 'date': date, 'title': title, 'pdf': pdf, 'src': src, 'model': RR.MODEL, **keep}


def main():
    if not RR.KEY and not DRY:
        print('NOTICES skipped: no GEMINI_API_KEY'); return
    store = _load(OUT, {'notices': {}})
    todo = [w for w in wanted() if w[0] not in store['notices']][:MAX]
    done = 0
    for link, sym, date, title in todo:
        try:
            store['notices'][link] = read(link, sym, date, title); done += 1
        except Exception as e:
            print('notice failed:', sym, title[:60], repr(e)[:160])
        if not DRY:
            json.dump(store, open(OUT, 'w', encoding='utf-8'), separators=(',', ':'), ensure_ascii=False)
    print(f'NOTICES read {done} of {len(todo)} waiting; stored {len(store["notices"])}; tokens {RR.tokens}')
    if DRY:
        for link in [w[0] for w in todo]:
            print(' ', json.dumps(store['notices'].get(link), ensure_ascii=False)[:220])


if __name__ == '__main__':
    main()
