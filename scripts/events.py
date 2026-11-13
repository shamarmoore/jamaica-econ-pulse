"""Corporate events from JSE announcements: dividend declarations, dividend-consideration notices, share splits,
take-over offers, rights issues / additional public offers and trading suspensions.

  archive_events()    -> parsed historical events for idea_tests.py (data/events_archive.json)
  live_opportunities(F, quotes) -> what's actionable now, with the tested evidence for each kind of event
Plain rules read these notices reliably (they're formulaic); the language model only writes the narrative on the phone."""
import json, re
from datetime import datetime, timedelta, timezone

import insiders as INS

MONTHS = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*'
DATE = rf'((?:{MONTHS})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}})'
NUMW = {'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5, 'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10, 'twenty': 20}


def _date(s):
    if not s:
        return None
    s = re.sub(r'(\d)(st|nd|rd|th)', r'\1', s.replace('.', '').replace(',', ''))
    for f in ('%B %d %Y', '%b %d %Y'):
        try:
            return datetime.strptime(s.replace('Sept ', 'Sep '), f).strftime('%Y-%m-%d')
        except ValueError:
            pass
    return None


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def parse_dividend(title, text):
    """-> {'amt', 'cur', 'record', 'ex', 'pay'} or None. Ordinary shares only."""
    T = f'{title}. {text}'
    if re.search(r'preference|redeemable', title, re.I):
        return None
    amt = cur = None
    m = re.search(r'(US\s?\$|USD|J\$|JMD|TT\$|\$)\s?(\d*\.\d+|\d+)\s*(?:\)\s*)?(?:cents\s*)?(?:per|/)\s*(?:ordinary\s+)?(?:share|stock\s*unit|unit)', T, re.I) \
        or re.search(r'dividend (?:per share|amount)?\s*[–:-]+\s*(US\s?\$|USD|J\$|JMD|\$)?\s?(\d*\.\d+|\d+)', T, re.I) \
        or re.search(r'(?:dividend|payment)[^.$]{0,80}?(US\s?\$|USD|J\$|JMD|\$)\s?(\d*\.\d+|\d+)', T, re.I)
    if m:
        amt = float(m.group(2)); cur = 'USD' if m.group(1) and 'US' in m.group(1).upper() else 'TTD' if m.group(1) and 'TT' in m.group(1).upper() else 'JMD'
    else:
        c = re.search(r'(\d+(?:\.\d+)?)\s*cents', T, re.I)
        if c:
            amt = float(c.group(1)) / 100; cur = 'USD' if re.search(r'US\s?cents|US\$', T) else 'JMD'
    if not amt or amt <= 0 or amt > 50:
        return None
    amt = round(amt, 6)
    rec = re.search(rf'record[^.]{{0,40}}?(?:as at|as of|at|on|date)?\s*[–:-]?\s*(?:\w+day,?\s*)?{DATE}', T, re.I)
    ex = re.search(rf'ex[- ]?(?:dividend\s+)?date\s*(?:is|of|will be|shall be)?\s*[–:-]?\s*(?:\w+day,?\s*)?{DATE}', T, re.I)
    pay = re.search(rf'(?:payable|paid|payment date|distribution)[^.]{{0,30}}?(?:on|[–:-])\s*(?:\w+day,?\s*)?{DATE}', T, re.I)
    return {'amt': amt, 'cur': cur, 'record': _date(rec.group(1)) if rec else None, 'ex': _date(ex.group(1)) if ex else None, 'pay': _date(pay.group(1)) if pay else None}


def parse_split(text):
    m = re.search(r'(\d+|' + '|'.join(NUMW) + r')\s*(?:[-:]|for|-for-|\sfor\s)\s*(\d+|' + '|'.join(NUMW) + r')\s*(?:\(\s*\d+\s*:\s*\d+\s*\)\s*)?(?:stock|share)?\s*split', text, re.I) \
        or re.search(r'split[^.]{0,40}?(\d+)\s*:\s*(\d+)', text, re.I) or re.search(r'(\d+)\s*:\s*(\d+)\s*(?:stock|share)\s*split', text, re.I)
    if not m:
        return None
    a, b = [NUMW.get(x.lower(), None) or int(x) for x in m.groups()]
    return {'ratio': f'{a}:{b}', 'factor': a / b if b else None}


def parse_offer_price(text):
    m = re.search(r'(?:offer|bid|consideration|price)[^.]{0,80}?(US\s?\$|J\$|\$)\s?(\d+(?:\.\d+)?)\s*(?:per|for each|/)\s*(?:ordinary\s+)?(?:share|stock unit|unit)', text, re.I) \
        or re.search(r'(US\s?\$|J\$|\$)\s?(\d+(?:\.\d+)?)\s*(?:per|for each)\s*(?:ordinary\s+)?(?:share|stock unit)', text, re.I)
    if not m:
        return None
    return {'price': float(m.group(2)), 'cur': 'USD' if 'US' in m.group(1).upper() else 'JMD'}


def split_factor(splits, sym, start, end):
    f = 1.0
    for e in splits:
        if e['sym'] == sym and start < e['date'] <= end and e.get('factor') and e['factor'] > 1:
            f = e['factor']
    return f


SPLITS = []


def reference_dividend(prev, e):
    """The comparable earlier payment: the one about a year before (same season), else the latest; same currency;
    adjusted if a share split was announced in between."""
    d0 = datetime.strptime(e['date'], '%Y-%m-%d')
    same = [x for x in prev if x['cur'] == e['cur'] and x['date'] < e['date']]
    yr = [x for x in same if 300 <= (d0 - datetime.strptime(x['date'], '%Y-%m-%d')).days <= 430]
    pick = yr[-1] if yr else (same[-1] if same and (d0 - datetime.strptime(same[-1]['date'], '%Y-%m-%d')).days < 200 else None)
    if not pick:
        return None
    return pick['amt'] / split_factor(SPLITS, e['sym'], pick['date'], e['date'])


def archive_events():
    """Parsed historical events (one per notice) with symbol and publication date."""
    out = []
    for p in _load('data/events_archive.json', {}).get('posts', []):
        sym = INS.find_sym(p.get('title', ''), p.get('text', ''))
        if not sym or INS.PREF.search(sym):
            continue
        e = {'sym': sym, 'date': p['date'][:10], 'id': p['id'], 'title': p.get('title', '')}
        T = f"{p.get('title', '')}. {p.get('text', '')}"
        if 'div' in p['src'] and re.search(r'declar|approv|dividend (?:payment|notice)|pay', T, re.I):
            d = parse_dividend(p.get('title', ''), p.get('text', ''))
            if d:
                out.append({**e, 'kind': 'dividend', **d})
        if 'divcons' in p['src'] and re.search(r'consider', p.get('title', ''), re.I):
            out.append({**e, 'kind': 'divcons'})
        if 'split' in p['src'] and re.search(r'split', T, re.I) and not re.search(r'reverse|consolidat', T, re.I):
            s = parse_split(T)
            out.append({**e, 'kind': 'split', **(s or {})})
        if 'takeover' in p['src'] and re.search(r'take[- ]?over|tender offer|offer to acquire|bid', T, re.I):
            out.append({**e, 'kind': 'takeover', **(parse_offer_price(T) or {})})
        if ('rights' in p['src'] or 'apo' in p['src']) and re.search(r'rights issue|additional public offer|\bAPO\b', T, re.I) and not re.search(r'bond|note|preference', p.get('title', ''), re.I):
            out.append({**e, 'kind': 'raise'})
        if 'suspend' in p['src'] and re.search(r'suspen', T, re.I):
            out.append({**e, 'kind': 'suspend'})
    out.sort(key=lambda x: x['date'])
    SPLITS[:] = [e for e in out if e['kind'] == 'split' and e.get('factor')]
    return out


# ---------------------------------------------------------------- what's actionable now
def live_opportunities(F, price_of, ideas, days=45):
    """F: forecasts dict (stocks with edge/signals); price_of(sym)->latest close; ideas: idea_tests results.
    Returns a list of events from the last `days` days (plus dividends whose ex-date is still ahead) with numbers,
    the tested evidence for that kind of event and a suggested action."""
    news = _load('data/news.json', {}).get('posts', [])
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime('%Y-%m-%d')
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    E = (ideas or {}).get('events', {})
    hist = {}
    for e in archive_events():
        if e['kind'] == 'dividend':
            hist.setdefault(e['sym'], []).append(e)
    out, seen = [], set()
    for p in sorted(news, key=lambda x: x['date']):
        T = f"{p.get('title', '')}. {p.get('text', '')}"
        sym = INS.find_sym(p.get('title', ''), p.get('text', ''))
        if not sym or INS.PREF.search(sym) or p['date'][:10] < since:
            continue
        st = (F.get('stocks') or {}).get(sym, {})
        edge = (st.get('edge') or {}).get('rank'); px = price_of(sym)
        base = {'sym': sym, 'date': p['date'][:10], 'title': p.get('title', ''), 'url': p.get('link'), 'edgeRank': edge, 'price': px}
        kind = None
        if p.get('kind') == 'dividend' or re.search(r'dividend', p.get('title', ''), re.I):
            if re.search(r'consider', p.get('title', ''), re.I):
                kind = 'divcons'
            else:
                d = parse_dividend(p.get('title', ''), p.get('text', ''))
                if d:
                    kind = 'dividend'; base.update(d)
        elif re.search(r'\bsplit\b', T, re.I) and not re.search(r'reverse|consolidat', T, re.I):
            kind = 'split'; base.update(parse_split(T) or {})
        elif re.search(r'take[- ]?over|tender offer|offer to acquire', T, re.I):
            kind = 'takeover'; base.update(parse_offer_price(T) or {})
        elif re.search(r'rights issue|additional public offer|\bAPO\b', T, re.I) and not re.search(r'bond|note', p.get('title', ''), re.I):
            kind = 'raise'; base.update(parse_offer_price(T) or {})
        elif re.search(r'suspen', p.get('title', ''), re.I):
            kind = 'suspend'
        if not kind:
            continue
        key = (sym, kind)
        if key in seen and kind != 'dividend':
            continue
        seen.add(key)
        o = {**base, 'kind': kind}
        if kind == 'dividend':
            fx = 157.0 if base.get('cur') == 'USD' else 1.0
            y = base['amt'] * fx / px if px else None
            if y is not None and y > 0.4 and fx > 1:  # share itself quoted in US$
                y = base['amt'] / px
            o['yieldPct'] = round(y * 100, 2) if y else None
            ex = base.get('ex')
            if not ex and base.get('record'):
                ex = (datetime.strptime(base['record'], '%Y-%m-%d') - timedelta(days=1)).strftime('%Y-%m-%d'); o['exEstimated'] = True
            o['ex'] = ex
            o['daysToEx'] = (datetime.strptime(ex, '%Y-%m-%d') - datetime.strptime(today, '%Y-%m-%d')).days if ex else None
            live_splits = [{'sym': sym, 'date': x['date'][:10], **(parse_split(f"{x.get('title', '')}. {x.get('text', '')}") or {})} for x in news
                           if INS.find_sym(x.get('title', ''), x.get('text', '')) == sym and re.search(r'\bsplit\b', x.get('title', '') + x.get('text', ''), re.I)]
            SPLITS.extend(z for z in live_splits if z.get('factor'))
            ref = reference_dividend(hist.get(sym, []), {**base, 'sym': sym})
            if ref:
                o['changePct'] = round((base['amt'] / ref - 1) * 100, 1)
            if o['daysToEx'] is not None and o['daysToEx'] < 0 and (o.get('changePct') is None or abs(o['changePct']) < 10):
                continue  # already ex and no news in the size of the dividend
            o['tested'] = _dividend_verdict(o, E)
        else:
            o['tested'] = _verdict(kind, o, E, px)
        out.append(o)
    rank = {'consider': 0, 'avoid': 1, 'holders': 2, 'watch': 3, 'info': 4}
    out.sort(key=lambda o: (rank.get(o['tested']['action'], 9), o['date']), reverse=False)
    return out


def _g(E, *k):
    for x in k:
        E = (E or {}).get(x)
    return E


def _dividend_verdict(o, E):
    cap = None
    y = o.get('yieldPct')
    if y is not None:
        b = 'high' if y >= 3 else 'mid' if y >= 1.5 else 'low'
        cap = _g(E, 'dividendCapture', b)
        late = _g(E, 'dividendCaptureLate', b)
        since_decl = (datetime.now(timezone.utc).replace(tzinfo=None) - datetime.strptime(o['date'], '%Y-%m-%d')).days
        if late and since_decl > 7:
            cap = {**late, 'late': True}
    ch = o.get('changePct')
    chg = _g(E, 'dividendRaise63') if ch is not None and ch >= 10 else _g(E, 'dividendCut63') if ch is not None and ch <= -10 else None
    action, why = 'info', []
    if chg and ch is not None:
        why.append(f"Dividend {'raised' if ch > 0 else 'cut'} {abs(ch):.0f}% vs the same payment a year ago. After {'raises' if ch > 0 else 'cuts'}, stocks did {chg.get('avgExcess')} pts vs the market over 3 months after costs ({chg.get('verdict')}, {chg.get('n')} cases).")
        if chg.get('verdict') in ('edge', 'weak edge') and ch > 0:
            action = 'consider'
        if chg.get('verdict') in ('negative edge (avoid)', 'weak negative') and ch < 0:
            action = 'avoid'
    if cap and o.get('daysToEx') is not None and o['daysToEx'] >= 1:
        band = 'high (≥3%)' if y >= 3 else 'mid (1.5–3%)' if y >= 1.5 else 'low (<1.5%)'
        buy_by = (datetime.strptime(o['ex'], '%Y-%m-%d') - timedelta(days=1))
        while buy_by.weekday() >= 5:
            buy_by -= timedelta(days=1)
        o['buyBy'] = buy_by.strftime('%Y-%m-%d')
        if cap.get('avgExcess') is None:
            why.append(f"Dividend capture (buy by {o['buyBy']}, sell on the ex-date {o['ex']}): only {cap.get('n')} {band}-yield cases — too few to judge.")
        else:
            why.append(f"Dividend capture — buy by {o['buyBy']}, sell on the ex-date {o['ex']}: {'buying in the last 5 trading days before the ex-date' if cap.get('late') else 'buying right after the declaration'}, {band}-yield payments did {cap.get('avgExcess')} pts vs the market after 3% round-trip costs, winning {cap.get('winRate')}% of {cap.get('n')} cases ({cap.get('verdict')}).")
        if cap.get('verdict') in ('edge', 'weak edge') and action == 'info':
            action = 'consider'
        elif cap.get('verdict') in ('negative edge (avoid)', 'weak negative') and action == 'info':
            why.append('At this yield the costs eat the dividend — only worth it for holders, who simply collect it.')
            action = 'holders'
        elif action == 'info':
            action = 'holders'
    if not why:
        why.append('Dividend news only; no tested edge for this case.')
    return {'action': action, 'why': ' '.join(why)}


def _verdict(kind, o, E, px):
    if kind == 'divcons':
        T = _g(E, 'dividendConsideration21')
        return {'action': 'info', 'why': f"Board will consider a dividend — don’t buy on the notice itself: buying on these notices did {T.get('avgExcess')} pts vs the market over the next month after costs ({T.get('verdict')}, {T.get('n')} cases)." if T else 'Board will consider a dividend.'}
    if kind == 'split':
        T = _g(E, 'split63')
        r = f"Share split{(' ' + o['ratio']) if o.get('ratio') else ''}: more shares at a lower price, same total value; per-share dividends shrink by the same ratio."
        if T and T.get('avgExcess') is not None:
            r += f" After split notices, stocks did {T.get('avgExcess')} pts vs the market over 3 months after costs ({T.get('verdict')}, {T.get('n')} cases)."
        elif T:
            r += f" Only {T.get('n')} JSE splits since 2021 — too few to test whether they move the price."
        return {'action': 'info', 'why': r}
    if kind == 'takeover':
        msg = 'Take-over activity. Offers can be conditional or partial — read the circular.'
        if o.get('price') and px:
            prem = (o['price'] / px - 1) * 100
            o['offerGapPct'] = round(prem, 1)
            msg = f"Offer J${o['price']:,.2f} vs market J${px:,.2f} ({prem:+.1f}%). " + ('If the offer is firm and you can tender, the gap is the return — check conditions, minimum acceptance and the closing date.' if prem > 2 else 'The market price is at or above the offer: the market expects a higher bid or the offer is for another company.')
            return {'action': 'consider' if prem > 3 else 'watch', 'why': msg + ' (Too few JSE take-overs to back-test.)'}
        return {'action': 'watch', 'why': msg}
    if kind == 'raise':
        T = _g(E, 'raise63')
        msg = 'Rights issue / additional public offer: new shares, existing holders are diluted unless they take up their rights.'
        if o.get('price') and px:
            o['offerGapPct'] = round((o['price'] / px - 1) * 100, 1)
            msg += f" Offer price J${o['price']:,.2f} vs market J${px:,.2f} ({o['offerGapPct']:+.1f}%)."
        if T:
            msg += f" After these notices stocks did {T.get('avgExcess')} pts vs the market over 3 months after costs ({T.get('verdict')}, {T.get('n')} cases)."
        return {'action': 'avoid' if T and (T.get('verdict') in ('negative edge (avoid)', 'weak negative') or (T.get('n', 0) >= 15 and (T.get('avgExcess') or 0) < -5)) else 'holders', 'why': msg + (' Small sample — but consistently bad.' if T and T.get('verdict') == 'no reliable edge' and (T.get('avgExcess') or 0) < -5 else '')}
    if kind == 'suspend':
        return {'action': 'holders', 'why': 'Trading suspended: you can’t buy or sell until it lifts. Read the notice for why (reorganisation, delisting, redemption).'}
    return {'action': 'info', 'why': ''}


if __name__ == '__main__':
    from collections import Counter
    A = archive_events()
    print('ARCHIVE', len(A), Counter(e['kind'] for e in A))
    d = [e for e in A if e['kind'] == 'dividend']
    print('dividends with ex', sum(1 for e in d if e.get('ex')), 'record', sum(1 for e in d if e.get('record')), 'USD', sum(1 for e in d if e['cur'] == 'USD'))
    print('splits with ratio', sum(1 for e in A if e['kind'] == 'split' and e.get('ratio')), 'takeovers with price', sum(1 for e in A if e['kind'] == 'takeover' and e.get('price')))
