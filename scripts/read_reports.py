"""Balance-sheet reader: pulls the key figures out of JSE financial reports (PDFs) with a low-cost Gemini model.

The JSE publishes profit and dividends as data, but balance sheets, cash flow and sales only inside PDF reports.
For each results announcement since late 2021 this script downloads the report, finds the statement pages and asks the
model for a fixed set of figures as JSON. Text PDFs send only the statement pages as text; scanned PDFs send the file.
Every reading is checked: assets must equal liabilities + equity, and the profit must match a figure the JSE itself
publishes for that company. Readings that fail are kept but flagged, and never used in tests or in the app.

  data/reports_index.json : results announcements with their PDF links
  data/financials.json    : {'reports': {post_id: reading}, 'skipped': {post_id: reason}}
Usage: GEMINI_API_KEY=... python scripts/read_reports.py [max_reports=40] [max_index_pages=6]
One request to the JSE site every 2.5 s; stops politely on 403/429."""
import base64, json, os, re, subprocess, sys, tempfile, time, urllib.request, urllib.error
from datetime import datetime, timezone

sys.path.insert(0, 'scripts')
import insiders as INS

KEY = os.environ.get('GEMINI_API_KEY', '').strip()
MODEL = os.environ.get('GEMINI_MODEL', 'gemini-3.5-flash-lite')
MAX = int(sys.argv[1]) if len(sys.argv) > 1 else 40
MAX_INDEX = int(sys.argv[2]) if len(sys.argv) > 2 else 6
SINCE = '2021-09-01'
UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'
IDX, OUT = 'data/reports_index.json', 'data/financials.json'
FIELDS = ['total_assets', 'total_liabilities', 'total_equity', 'equity_attributable_to_owners', 'borrowings', 'cash_and_equivalents',
          'revenue', 'net_profit', 'net_profit_attributable_to_owners', 'operating_cash_flow', 'capital_expenditure']
tokens = {'in': 0, 'out': 0}


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def get(url, binary=False, timeout=60):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
    time.sleep(2.5)
    return b if binary else b.decode('utf-8', 'replace')


# ---------------------------------------------------------------- 1) index of results announcements
def update_index():
    index = _load(IDX, {'posts': []})
    have = {p['id'] for p in index['posts']}
    added = 0
    for n in range(1, MAX_INDEX + 1):
        try:
            L = json.loads(get(f'https://www.jamstockex.com/wp-json/wp/v2/posts?categories=8&per_page=100&page={n}&orderby=date&order=desc&_fields=id,date,title,content'))
        except Exception as e:
            print('index stopped:', str(e)[:100]); break
        if not L:
            break
        fresh = 0
        for p in L:
            if p['id'] in have or p['date'] < SINCE:
                continue
            title = re.sub(r'<[^>]+>', '', p['title']['rendered']).replace('&#8211;', '–').replace('&amp;', '&').replace('&#8217;', '’').replace('&#8220;', '“').replace('&#8221;', '”')
            links = []
            for m in re.finditer(r'<a[^>]+href="([^"]+\.pdf)"[^>]*>(.*?)</a>', p['content']['rendered'], re.I | re.S):
                links.append([m.group(1), re.sub(r'<[^>]+>|\s+', ' ', m.group(2)).strip()[:80]])
            index['posts'].append({'id': p['id'], 'date': p['date'][:10], 'title': title[:160], 'sym': INS.find_sym(title), 'links': links[:5]})
            have.add(p['id']); fresh += 1; added += 1
        if L[-1]['date'] < SINCE or (not fresh and len(index['posts']) > 500):
            break
    index['posts'].sort(key=lambda p: p['date'], reverse=True)
    json.dump(index, open(IDX, 'w'), separators=(',', ':'))
    print(f'INDEX added {added}; total {len(index["posts"])}; oldest {index["posts"][-1]["date"] if index["posts"] else None}')
    return index


# ---------------------------------------------------------------- 2) PDF → statement pages
BAL = re.compile(r'statement of financial position|balance sheet', re.I)
INC = re.compile(r'profit (?:or|and) loss|comprehensive income|income statement|statement of income|statement of operations', re.I)
CFS = re.compile(r'cash ?flows?', re.I)


def pdf_pages(path):
    try:
        txt = subprocess.run(['pdftotext', '-layout', path, '-'], capture_output=True, timeout=120).stdout.decode('utf-8', 'replace')
    except Exception:
        return []
    return txt.split('\f')


def statement_pages(pages):
    """Up to 7 pages: the first two that look like each statement (group/consolidated statements normally come first)."""
    pick, got = [], {'bal': 0, 'inc': 0, 'cfs': 0}
    for i, t in enumerate(pages):
        digits = sum(c.isdigit() for c in t)
        if digits < 120:
            continue   # narrative page, not a statement
        head = t[:1500]
        kind = None
        if BAL.search(head) and re.search(r'total assets|total equity|total liabilities', t, re.I):
            kind = 'bal'
        elif CFS.search(head) and re.search(r'operating activities', t, re.I):
            kind = 'cfs'
        elif INC.search(head) and re.search(r'(profit|loss|income) (for|before|after)|net (profit|income)|revenue|turnover', t, re.I):
            kind = 'inc'
        if kind and got[kind] < 2:
            got[kind] += 1; pick.append(i)
            if kind == 'bal' and i + 1 < len(pages) and i + 1 not in pick and re.search(r'total equity|total liabilities', pages[i + 1], re.I) and not re.search(r'total equity|total liabilities and', t, re.I):
                pick.append(i + 1)   # balance sheet continued on the next page
    return sorted(set(pick))[:7], got


PROMPT = '''You are reading the financial statements of a company listed on the Jamaica Stock Exchange.
Report: "{title}" (published {date}).
From the statements below, extract figures for the CURRENT period only (the most recent period-end column, not the comparatives).
Use the GROUP / CONSOLIDATED statements when both group and company are shown. For the income statement and cash flow use the
YEAR-TO-DATE column (e.g. "nine months ended"), not the single quarter, when both are shown.
Return ONLY a JSON object with exactly these keys:
 "period_end": "YYYY-MM-DD" (the balance sheet date),
 "months": number of months covered by the year-to-date income statement (3, 6, 9 or 12),
 "currency": "JMD", "USD" or "TTD" (the currency the statements are presented in),
 "units": 1, 1000 or 1000000 (what the figures are stated in: units, thousands "$'000", or millions),
 "consolidated": true or false,
 "audited": true or false,
 "total_assets", "total_liabilities", "total_equity" (including non-controlling interests),
 "equity_attributable_to_owners",
 "borrowings" (all interest-bearing debt: loans, bonds, notes, overdrafts, lease liabilities; current + non-current; for banks exclude customer deposits; 0 if none shown),
 "cash_and_equivalents",
 "revenue" (total revenue / turnover / total operating income for a financial firm, year-to-date),
 "net_profit" (profit after tax for the period, year-to-date, including non-controlling interests),
 "net_profit_attributable_to_owners",
 "operating_cash_flow" (net cash provided by/used in operating activities, year-to-date; negative if used),
 "capital_expenditure" (purchase of property, plant, equipment and intangibles, year-to-date, as a positive number).
Give numbers exactly as printed (no scaling by units), without commas; losses and outflows in brackets are negative.
Use null for anything not shown. Do not calculate or guess figures that are not printed.'''


def ask_gemini(parts):
    body = {'contents': [{'role': 'user', 'parts': parts}], 'generationConfig': {'temperature': 0, 'maxOutputTokens': 1500, 'responseMimeType': 'application/json'}}
    url = f'https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:generateContent'
    data = json.dumps(body).encode()
    for attempt in range(4):
        req = urllib.request.Request(url, data=data, headers={'Content-Type': 'application/json', 'x-goog-api-key': KEY})
        try:
            with urllib.request.urlopen(req, timeout=180) as r:
                j = json.loads(r.read())
            u = j.get('usageMetadata', {})
            tokens['in'] += u.get('promptTokenCount', 0); tokens['out'] += u.get('candidatesTokenCount', 0) + u.get('thoughtsTokenCount', 0)
            txt = ''.join(p.get('text', '') for p in j['candidates'][0]['content']['parts'])
            m = re.search(r'\{.*\}', txt, re.S)
            return json.loads(m.group(0)) if m else None
        except urllib.error.HTTPError as e:
            msg = e.read().decode('utf-8', 'replace')[:300]
            if e.code in (429, 500, 503) and attempt < 3:
                time.sleep(20 * (attempt + 1)); continue
            raise RuntimeError(f'Gemini HTTP {e.code}: {msg}')
        except (KeyError, IndexError, json.JSONDecodeError):
            return None
    return None


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).replace(',', '').replace('$', '').strip()
    neg = s.startswith('(') and s.endswith(')')
    try:
        x = float(s.strip('()'))
        return -x if neg else x
    except ValueError:
        return None


def jse_profit_slots(sym, period_end, months):
    """The JSE's own year-to-date profit for the same period: quarters are stored per financial year, and the label can
    be the year the period ends in or the next one, so both are returned (plus last year's, to catch a relabelled year)."""
    f = (_FUND.get(sym) or {})
    if not period_end or not months:
        return []
    y = int(period_end[:4]); n = months // 3
    out = []
    for yy in (y, y + 1, y - 1):
        q = (f.get('quarters') or {}).get(str(yy)) or []
        if len(q) >= n and all(q[:n]):
            out.append(float(sum(q[:n])))
        if n == 4 and (f.get('annual') or {}).get(str(yy)):
            out.append(float(f['annual'][str(yy)]))
    return out


_FUND = _load('data/jse_fundamentals.json', {}).get('stocks') or {}


def check(sym, r):
    """Scale to full currency units and validate."""
    u = num(r.get('units')) or 1
    out = {k: (None if num(r.get(k)) is None else num(r.get(k)) * u) for k in FIELDS}
    A, L, E = out['total_assets'], out['total_liabilities'], out['total_equity']
    out['balances'] = bool(A and L is not None and E is not None and abs(A - (L + E)) <= 0.02 * abs(A))
    pe = str(r.get('period_end') or '')
    out['period_end'] = pe if re.match(r'^\d{4}-\d{2}-\d{2}$', pe) else None
    m = num(r.get('months'))
    out['months'] = int(m) if m in (3, 6, 9, 12) else None
    cands = jse_profit_slots(sym, out['period_end'], out['months'])
    ok = None   # None = the JSE hasn't published a figure for this period to compare with
    if cands:
        ok = any(p is not None and abs(p - c) <= 0.02 * abs(c) + 1 for p in (out['net_profit_attributable_to_owners'], out['net_profit']) for c in cands)
    out['profitMatchesJSE'] = ok
    out['currency'] = r.get('currency') if r.get('currency') in ('JMD', 'USD', 'TTD') else None
    out['consolidated'] = bool(r.get('consolidated')); out['audited'] = bool(r.get('audited'))
    # usable = the balance sheet adds up, and the profit agrees with the JSE's own figure when there is one to compare
    out['ok'] = bool(out['balances'] and out['period_end'] and out['months'] and out['currency'] and ok is not False)
    return out


def read_report(p):
    """-> (reading, None) or (None, reason)."""
    links = sorted(p['links'], key=lambda l: 0 if re.search(r'financ|statement|result|interim|quarter|unaudited|audited|report', l[0] + ' ' + l[1], re.I) and not re.search(r'cover|letter|notice|largest|shareholding|top.?ten|director', l[0] + ' ' + l[1], re.I) else 1)
    last, best = 'no PDF link', None
    for url, _ in links[:4]:
        try:
            b = get(url, binary=True, timeout=120)
        except Exception as e:
            if any(c in str(e) for c in ('403', '429', '503')):
                raise
            last = f'download failed: {str(e)[:60]}'; continue
        if len(b) > 30e6 or b[:4] != b'%PDF':
            last = 'too large or not a PDF'; continue
        with tempfile.NamedTemporaryFile(suffix='.pdf') as f:
            f.write(b); f.flush()
            pages = pdf_pages(f.name)
        prompt = PROMPT.format(title=p['title'], date=p['date'])
        text_chars = sum(len(x.strip()) for x in pages)
        if len(pages) <= 45 and len(b) <= 18e6:
            # the model reads the file itself (printed text and scanned pages alike)
            r = ask_gemini([{'inline_data': {'mime_type': 'application/pdf', 'data': base64.b64encode(b).decode()}}, {'text': prompt}]); src = 'pdf' if text_chars > 3000 else 'scan'
        elif text_chars > 3000:
            pick, got = statement_pages(pages)   # long report (audited accounts): send only the statement pages as text
            if not got['bal']:
                last = 'long report: balance sheet page not found'; continue
            body = '\n\n'.join(f'=== PAGE {i + 1} ===\n{pages[i][:9000]}' for i in pick)
            r = ask_gemini([{'text': prompt + '\n\nSTATEMENTS:\n' + body}]); src = 'text'
        else:
            last = 'scanned report too long to read'; continue
        if not r:
            last = 'model returned nothing usable'; continue
        out = check(p['sym'], r)
        out.update(sym=p['sym'], pub=p['date'], src=src, title=p['title'][:90])
        if out['ok']:
            return out, None
        if out['total_assets'] is not None and (best is None or best['total_assets'] is None):
            best = out   # keep a flagged reading unless another file in the post reads cleanly
        elif best is None:
            last = 'no statements in this file'
    return (best, None) if best else (None, last)


def main():
    if not KEY:
        print('REPORTS skipped: no GEMINI_API_KEY'); return
    index = update_index()
    D = _load(OUT, {'reports': {}, 'skipped': {}})
    done = set(D['reports']) | set(D['skipped'])
    todo = [p for p in index['posts'] if str(p['id']) not in done and p.get('sym') and p['links']
            and not re.search(r'annual report|delay|notice of|extension|largest|top ten|press release|media release|investor briefing|presentation', p['title'], re.I)]
    # newest report of each company first (so the app has current figures), then the rest newest → oldest
    seen, first, rest = set(), [], []
    for p in todo:
        (rest if p['sym'] in seen or any(r.get('sym') == p['sym'] for r in D['reports'].values()) else first).append(p); seen.add(p['sym'])
    todo = first + rest
    n = ok = 0
    t0 = time.time()
    for p in todo[:MAX]:
        if time.time() - t0 > 200 * 60:
            break
        try:
            r, why = read_report(p)
        except RuntimeError as e:   # model quota / key problem: stop, keep what we have
            print('REPORTS stopped:', str(e)[:200]); break
        except Exception as e:
            if any(c in str(e) for c in ('403', '429', '503')):
                print('REPORTS stopped: the JSE site asked us to slow down'); break
            r, why = None, f'error: {str(e)[:80]}'
        n += 1
        if r:
            D['reports'][str(p['id'])] = r; ok += bool(r['ok'])
        else:
            D['skipped'][str(p['id'])] = why
        if n % 20 == 0:
            json.dump(D, open(OUT, 'w'), separators=(',', ':'))
            print(f'  …{n} read, {ok} passed checks, tokens in {tokens["in"]:,} out {tokens["out"]:,}')
    D['updated'] = datetime.now(timezone.utc).isoformat(timespec='seconds')
    json.dump(D, open(OUT, 'w'), separators=(',', ':'))
    allr = list(D['reports'].values())
    print(f'REPORTS read {n} this run ({ok} passed checks); total {len(allr)} readings, {sum(1 for r in allr if r["ok"])} usable, {len(D["skipped"])} skipped; '
          f'{len(todo) - min(len(todo), MAX)} still to read; tokens in {tokens["in"]:,} out {tokens["out"]:,}')
    for r in allr[-3:]:
        print('   e.g.', r['sym'], r['pub'], r['src'], 'ok' if r['ok'] else 'FLAGGED', {k: r[k] for k in ('period_end', 'months', 'currency', 'total_assets', 'total_equity', 'borrowings', 'net_profit', 'operating_cash_flow', 'balances', 'profitMatchesJSE')})


if __name__ == '__main__':
    main()
