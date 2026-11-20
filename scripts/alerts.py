"""Nightly alerts file for the phone's background check (data/alerts.json). Contains no personal data: the phone
matches it against the positions saved on the device and decides what to notify.
Every buy and sell alert comes from the one Edge score (scripts/edge_v2.py) and the rule it was back-tested with: hold the
top `top`, keep a holding while it ranks within the top `keep`, decide at the 3-month review. The phone only passes on buys
while the user holds fewer than `top` kept stocks. One tested exception (pops.py): a holding outside the keep band that
just jumped is sold into the rise (popSell). Weak results, dividends and announcements are context; they never say buy or
sell on their own.
  build(out) -> dict (also written to data/alerts.json)"""
import json
from datetime import datetime, timedelta, timezone

STATE = 'data/alerts_state.json'
FORGET_DAYS = 30   # a stock off the buy list this long alerts again when it returns


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def _buys(stocks, ranks, top, keep, limit_days, today, asof):
    """Buy-list entries, each with the date it joined; a stock that left the list less than FORGET_DAYS ago keeps its date,
    so a brief dip out and back does not alert twice."""
    prev = _load(STATE, {}).get('buys', {})
    fresh = lambda p: (today - datetime.strptime(p['last'], '%Y-%m-%d')).days <= FORGET_DAYS
    buys, keepst = [], {}
    for s, r in sorted(((s, r) for s, r in ranks.items() if r <= top), key=lambda kv: kv[1]):
        p = prev.get(s)
        first = p['first'] if p and fresh(p) else asof
        keepst[s] = {'first': first, 'last': asof}
        e = stocks[s]['edge']
        how = (f"buy with a limit order at J${e['limit']:,.2f} (the quote midpoint), good for {limit_days} trading days; if it hasn’t filled, buy at the ask"
               if e.get('limit') else 'buy at the ask (no recent quotes for a limit price)')
        buys.append({'id': f'buy-{s}-{first}', 'sym': s, 'rank': r, 'since': first, 'limit': e.get('limit'),
                     'title': f'Buy list: {s} is Edge #{r}',
                     'body': f"Expected {e['net']:+.1f}% vs the market over 3 months after costs. Tested rule: {how}. Then keep it while it stays in the Edge top {keep}."})
    keepst.update({s: p for s, p in prev.items() if s not in keepst and fresh(p)})
    json.dump({'buys': keepst}, open(STATE, 'w'), separators=(',', ':'))
    return buys


def build(out):
    asof = out.get('asof'); I = out.get('ideas') or {}
    today = datetime.strptime(asof, '%Y-%m-%d')
    rule = (out.get('edgeInfo') or {}).get('rule') or {}
    top, keep, limit_days = rule.get('top', 5), rule.get('keep', 20), rule.get('limitDays', 5)
    stocks = out['stocks']
    ranks = {s: st['edge']['rank'] for s, st in stocks.items() if (st.get('edge') or {}).get('rank')}
    W = ((I.get('post_earnings_drift') or {}).get('weakResults63') or {}).get('avgExcess')
    weak = {}
    for s, st in stocks.items():
        r = (st.get('signals') or {}).get('results')
        if r and r.get('kind') == 'weak':
            pub = (today - timedelta(days=int(r.get('daysAgo') or 0))).strftime('%Y-%m-%d')
            now = f'now Edge #{ranks[s]}' if s in ranks else 'not ranked'
            weak[s] = {'id': f'weak-{s}-{pub[:7]}', 'title': f'{s} reported weak results',
                       'body': f"Profit down {abs(r.get('yoy'))}% on the year." + (f" In testing, stocks trailed the market by {abs(W)} pts over the 3 months after weak results." if W is not None else '')
                               + f" The Edge score already counts this: {now}. Keep or sell by its rank at your review."}
    buys = _buys(stocks, ranks, top, keep, limit_days, today, asof)
    # a holding outside the keep band that just jumped: the tested rule is to sell into the rise, not wait for the review
    T = (((I.get('pops') or {}).get('after') or {}).get('outsideKeepHeld63')) or {}
    pop_sell = {}
    if T.get('verdict') == 'negative edge (avoid)':
        for s, st in stocks.items():
            R = (st.get('pop') or {}).get('recent')
            if R and ranks.get(s, 0) > keep:
                e = st.get('edge') or {}
                how = f"with a limit order at J${e['limit']:,.2f} (the quote midpoint)" if e.get('limit') else 'at the bid'
                pop_sell[s] = {'id': f"popsell-{s}-{R['since']}", 'title': f"{s} jumped {R['gain']:.0f}%: consider selling",
                               'body': f"It is Edge #{ranks[s]}, outside the top {keep}. Tested: holdings outside the top {keep} that jumped like this did "
                                       f"{T['avgExcess']:+.1f} pts vs the market over the next 3 months ({T['n']} cases). Sell into the rise {how} instead of waiting for the review."}
    events, susp = [], []
    for e in out.get('events') or []:
        if e['kind'] == 'suspend':
            susp.append(e['sym'])
        # a tested dividend trade is only passed on when the Edge score agrees: the stock ranks within the keep band
        if (e.get('tested') or {}).get('action') == 'consider' and e.get('buyBy') and e['buyBy'] >= asof and ranks.get(e['sym'], 999) <= keep:
            y, by = e.get('yieldPct'), datetime.strptime(e['buyBy'], '%Y-%m-%d')
            events.append({'id': f"div-{e['sym']}-{e.get('ex')}", 'sym': e['sym'], 'buyBy': e['buyBy'], 'ex': e.get('ex'),
                           'title': f"{e['sym']} dividend{f' {y:.1f}%' if y else ''}: buy by {by:%a} {by.day} {by:%b}",
                           'body': f"Edge #{ranks[e['sym']]}. " + (e.get('tested') or {}).get('why', '')[:300]})
    # fresh announcements (last 3 days); the phone shows those for stocks you hold or that are on the buy list
    feed = _load('data/news_feed.json', {}).get('posts', [])
    since = (today - timedelta(days=3)).strftime('%Y-%m-%d')
    KIND = {'results': 'Results', 'dividend': 'Dividend', 'insider': 'Insider trade', 'meeting': 'Meeting', 'board': 'Board', 'capital': 'Capital', 'notice': 'Notice'}
    news = [{'id': f"news-{p['id']}", 'sym': p['s'], 'kind': KIND.get(p.get('k'), 'Notice'), 'title': p.get('t', '')[:140]} for p in feed if p.get('s') and p['d'][:10] >= since][:80]
    A = {'asof': asof, 'made': datetime.now(timezone.utc).isoformat(timespec='seconds'), 'top': top, 'keep': keep, 'ranks': ranks, 'weak': weak,
         'suspended': sorted(set(susp)), 'events': events, 'buys': buys, 'popSell': pop_sell, 'news': news}
    json.dump(A, open('data/alerts.json', 'w'), separators=(',', ':'))
    return A
