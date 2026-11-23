"""TradingAgents' analyst committee (market, news and fundamentals analysts, bull/bear debate, risk debate, portfolio manager)
run on JSE stocks from this app's own data. Nothing is fetched from Yahoo, SEC EDGAR, FRED or Polymarket: the committee's
data tools are served from data/*.json through JseView, a point-in-time view in which every accessor takes `asof` and
returns nothing dated after it. The adapter installs itself into TradingAgents (a vendor "jse" in its router, plus the few
names its Yahoo code imports directly) at install(); TradingAgents' own files are not edited.

  python scripts/committee.py live [SYM ...]            today's committee on the Edge top 5 plus TJH -> data/committee.json
  python scripts/committee.py backtest [N] [--dry-run]  blind test of the committee's ratings on Edge's picks -> data/committee_backtest.json

Run with the TradingAgents venv (`TradingAgents/.venv`), PYTHONUTF8=1. The model runs on OpenRouter: the key is read from
OPENROUTER_API_KEY or ~/.config/openrouter/.env and never written anywhere. COMMITTEE_MODEL picks the model (default
openai/gpt-oss-120b); COMMITTEE_BUDGET (US$, default 4.50) stops a run once the key's lifetime spend reaches it.
The backtest is blind: each case hides the company behind an alias (JSE017), its name and symbol are removed from every
text the agents read, and decisions are scored on the next 63 trading days against the market, 1.5% costs each way, as in
scripts/ai_backtest.py. Re-running continues where it stopped."""
import glob, json, os, re, socket, sys, threading, time, urllib.request
from copy import deepcopy
from dataclasses import dataclass
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
from langchain_core.callbacks import BaseCallbackHandler

ROOT = Path(__file__).resolve().parents[1]
os.chdir(ROOT)   # the app's loaders read data/ relative to the repo root
sys.path.insert(0, str(ROOT / 'scripts'))
import insiders as INS
import tslib
from tradingagents.dataflows.errors import NoMarketDataError

MKT = 'JSEMKT'
EXCHANGE = 'Jamaica Stock Exchange'
MIN_TRADED = 0.20            # a stock counts in the market when it traded on this share of the last 60 days
STALE_DAYS = 10              # newest price older than this before the date asked for is no data
H, COST, STEP = 63, 0.015, 3  # holding days, cost each way, and review dates 3 Edge grid steps (63 trading days) apart
TOP = 10
HIST_PATH, STORE = 'data/edge_hist.json', 'data/committee_backtest.json'
LIVE_OUT = 'data/committee.json'
DIR = ROOT / '.committee'
ANALYSTS = ('market', 'news', 'fundamentals')
BALANCE = ('total_assets', 'total_liabilities', 'total_equity', 'equity_attributable_to_owners', 'borrowings', 'cash_and_equivalents')
INCOME = ('revenue', 'net_profit', 'net_profit_attributable_to_owners')
CASHFLOW = ('operating_cash_flow', 'capital_expenditure')
MACRO_INDEX = {'main_index': 'Index', 'combined_index': 'Combined Index', 'junior_index': 'Junior Market Index',
               'select_index': 'Select Index', 'financial_index': 'Financial Index', 'manufacturing_index': 'Manufacturing & Distribution Index',
               'usd_index': 'USD Equities Index', 'all_composite_index': 'All Jamaican Composite Index', 'cross_listed_index': 'Cross Listed Index'}
INDEX_BY_KEY = {}
DATA_HOSTS = re.compile(r'yahoo|yimg|sec\.gov|stlouisfed|polymarket|alphavantage', re.I)


def _load(path, default):
    try:
        return json.load(open(path, encoding='utf-8'))
    except Exception:
        return default


def _ts(x):
    return pd.Timestamp(x).normalize()


def _key(name):
    return re.sub(r'\W+', '_', name.lower()).strip('_')


INDEX_BY_KEY.update({**MACRO_INDEX, **{_key(v): v for v in MACRO_INDEX.values()}})


# ---------------------------------------------------------------- the point-in-time view

class JseView:
    """The app's data as it stood on any day. Built once per process; each accessor cuts at `asof` (inclusive)."""

    def __init__(self):
        close, vol = tslib.load_history()
        raw, _ = tslib._raw_history()
        self.universe = set(close.columns)
        self.syms = [s for s in close.columns if not tslib.is_pref(s)]
        self.close, self.vol = close[self.syms], vol[self.syms].fillna(0)
        raw = raw.reindex(close.index)[self.syms]
        self.factor = (self.close / raw).where(raw > 0)
        self._read_detail()
        self.fund = tslib.load_fundamentals()
        self.macro = _load('data/macro.json', {})
        self._read_posts()
        self.trades = {}
        for e in INS.events():
            if not e.get('skip') and e.get('who') != 'company' and e.get('side') in ('buy', 'sell'):
                self.trades.setdefault(e['sym'], []).append(e)
        self.reports = {}
        for r in _load('data/financials.json', {}).get('reports', {}).values():
            if r.get('ok') and r.get('sym') and r.get('pub') and r.get('period_end'):
                self.reports.setdefault(r['sym'], []).append(r)
        self._frames, self._features = {}, {}
        self.market = self._build_market()

    def _read_detail(self):
        quotes, levels = {}, {}
        for path in sorted(glob.glob('data/detail/*.json')):
            for d, day in _load(path, {}).items():
                levels[d] = day.get('i') or {}
                quotes[d] = day.get('b') or {}
        ix = pd.DatetimeIndex(sorted(quotes))

        def field(k):
            f = pd.DataFrame({d: {s: (q[k] if len(q) > k else None) for s, q in quotes[d].items()} for d in quotes}).T
            f = f.apply(pd.to_numeric, errors='coerce').where(lambda x: x > 0)
            f.index = pd.DatetimeIndex(f.index)
            return f.reindex(index=self.close.index, columns=self.syms)

        self.bid, self.ask, self.hi, self.lo = (field(k) for k in range(4))
        self.levels = pd.DataFrame(levels).T
        self.levels.index = pd.DatetimeIndex(self.levels.index)
        self.levels = self.levels.sort_index().reindex(self.close.index.union(ix)).ffill().reindex(self.close.index)

    def _read_posts(self):
        notes = {u: n for u, n in _load('data/notices.json', {}).get('notices', {}).items() if n.get('what')}
        seen, linked, posts = set(), set(), []

        def add(p, link, date_):
            key = p.get('id') or (p.get('title'), date_)
            if key in seen:
                return
            seen.add(key)
            linked.add(link)
            title, text = p.get('title', ''), p.get('text', '')
            sym = p.get('sym') or next((m for m in re.findall(r'\(\s*([A-Z0-9.]{2,12})\s*\)', title) if m in self.universe), None) \
                or INS.find_sym(title, text)
            posts.append({'date': date_, 'sym': sym, 'title': title, 'text': text, 'note': notes.get(link)})

        for name in ('events_archive', 'news', 'reports_index'):
            for p in _load(f'data/{name}.json', {}).get('posts', []):
                add(p, p.get('link'), p['date'][:10])
        for url, n in notes.items():
            if url not in linked:
                add({'title': n.get('title', ''), 'sym': n.get('sym'), 'id': url, 'text': ''}, url, n['date'][:10])
        self.posts = sorted(posts, key=lambda p: p['date'], reverse=True)

    def _build_market(self):
        P = self.close.ffill()
        r = (P / P.shift(1) - 1).where(P.shift(1) > 0).clip(-0.6, 1.5)
        member = ((self.vol > 0).rolling(60).mean() >= MIN_TRADED) & r.notna()
        level = 100 * (1 + r.where(member).mean(axis=1).fillna(0)).cumprod()
        value = (P * self.vol).where(member).sum(axis=1)
        keep = member.any(axis=1)
        return self._frame(level[keep], value[keep])

    @staticmethod
    def _frame(close, volume, hi=None, lo=None):
        """Without a quoted range (the market index) the day's range is from the previous close to the close."""
        opened = close.shift(1).fillna(close)
        c = close.values
        top = opened.values if hi is None else hi.reindex(close.index).values
        bottom = opened.values if lo is None else lo.reindex(close.index).values
        return pd.DataFrame({'Date': close.index, 'Open': opened.values, 'High': np.fmax(top, c), 'Low': np.fmin(bottom, c),
                             'Close': c, 'Volume': volume.reindex(close.index).values})

    # prices
    def resolve(self, sym):
        sym = (sym or '').strip().upper()
        if sym != MKT and sym not in self.syms:
            raise NoMarketDataError(sym, sym, 'not an ordinary share the app has JSE prices for')
        return sym

    def frame(self, sym, asof):
        """Date, Open, High, Low, Close, Volume up to asof. Close and Volume are split-adjusted; High and Low are the day's
        quoted range scaled by the same adjustment (the close where the JSE detail file has none); Open is the previous close."""
        s = self.resolve(sym)
        if s == MKT:
            full = self.market
        else:
            if s not in self._frames:
                c = self.close[s].dropna()
                c = c[c > 0]
                f = self.factor[s].reindex(c.index)
                self._frames[s] = self._frame(c, self.vol[s], self.hi[s] * f, self.lo[s] * f)
            full = self._frames[s]
        return full[full.Date <= _ts(asof)].reset_index(drop=True)

    def closes(self, sym, start, end):
        """Closes from start up to, not including, end."""
        f = self.frame(sym, _ts(end) - pd.Timedelta(days=1))
        f = f[f.Date >= _ts(start)]
        return pd.Series(f.Close.values, index=pd.DatetimeIndex(f.Date), name='Close')

    # fundamentals
    def statements(self, sym, asof):
        """One report per period (the latest published by asof), newest period first."""
        best = {}
        for r in self.reports.get(sym, []):
            if r['pub'] <= str(_ts(asof).date()):
                k = (r['period_end'], r.get('months'))
                if k not in best or r['pub'] > best[k]['pub']:
                    best[k] = r
        return sorted(best.values(), key=lambda r: (r['period_end'], r['pub']), reverse=True)

    def _feat(self, sym):
        if sym not in self._features:
            self._features[sym] = tslib.fundamental_series(self.fund.get(sym), self.close[sym].ffill(), self.close.index)
        return self._features[sym]

    def overview(self, sym, asof):
        asof = _ts(asof)
        c = self.close[sym].loc[:asof].dropna()
        if c.empty:
            raise NoMarketDataError(sym, sym, 'no prices')
        f = self.fund.get(sym) or {}
        price = c.iloc[-1]
        feat = self._feat(sym).loc[:asof].iloc[-1]
        events = [(d, v) for d, v in tslib._quarter_events(f) if d <= asof]
        fx = self._profit_fx(sym, asof)
        ttm = sum(v for _, v in events[-4:]) * fx if len(events) >= 4 else None
        value_ = float(price * f['shares']) if f.get('shares') else None
        win = slice(-60, None)
        traded = (self.vol[sym].loc[:asof].iloc[win] > 0)
        value = (self.close[sym].ffill() * self.vol[sym]).loc[:asof].iloc[-20:]
        bid, ask = self.bid[sym].loc[:asof].iloc[win], self.ask[sym].loc[:asof].iloc[win]
        spread = ((ask - bid) / ((ask + bid) / 2)).where((bid > 0) & (ask >= bid)).median()
        mkt = self.market.set_index('Date').Close.loc[:asof]

        def change(series, days):
            s = series.dropna()
            past = s.loc[:asof - pd.Timedelta(days=days)]
            return None if past.empty else float(s.iloc[-1] / past.iloc[-1] - 1)

        year = c.loc[asof - pd.Timedelta(days=365):]
        return {
            'name': f.get('name'), 'asof': asof, 'priceDate': c.index[-1], 'price': float(price),
            'marketValue': value_, 'ttmProfit': ttm, 'ey': ttm / value_ if ttm is not None and value_ else None,
            'quartersPublished': len(events), 'growth': feat.growth, 'dy': feat.dy, 'lossq': feat.lossq,
            'returns': {k: change(c, d) for k, d in (('1 month', 30), ('3 months', 91), ('6 months', 182), ('12 months', 365))},
            'vsMarket3m': None if change(c, 91) is None or change(mkt, 91) is None else change(c, 91) - change(mkt, 91),
            'year': (float(year.min()), float(year.max())),
            'tradedShare': float(traded.mean()), 'valuePerDay': float(value.mean()), 'spread': None if pd.isna(spread) else float(spread),
            'dividends': [d for d in f.get('dividends', []) if d.get('ex') and d['ex'] <= str(asof.date())][-4:],
            'sector': self.sector(sym, asof)}

    def _profit_fx(self, sym, asof):
        """Share-price currency units per unit of the currency the company reports in (its latest published report). The app's own
        feature converts by the dividend currency, which leaves a US$ reporter that pays J$ dividends (TJH) unconverted."""
        f = self.fund.get(sym) or {}
        divs = [d for d in f.get('dividends', []) if d.get('ex') and d.get('amt')]
        reports = self.statements(sym, asof)
        reports_in = reports[0].get('currency') if reports else (divs[-1]['cur'] if divs else 'JMD')
        quoted_in_dividend_currency = bool(divs) and divs[-1]['cur'] != 'JMD' and tslib.fx_rate(f, self.close[sym].ffill()) == 1.0
        return 1.0 if quoted_in_dividend_currency else tslib.FX_TO_JMD.get(reports_in, 1.0)

    def sector(self, sym, asof):
        """Which JSE sector index the stock has moved with over the 500 days to asof, as scripts/signals.py reads it."""
        ix = self.levels.loc[:_ts(asof)].iloc[-500:]
        r = self.close[sym].ffill().pct_change().where(self.vol[sym] > 0).loc[ix.index]
        need = {'Financial Index', 'Manufacturing & Distribution Index'}
        if not need <= set(ix.columns):
            return None
        fin, md = ix['Financial Index'].pct_change(), ix['Manufacturing & Distribution Index'].pct_change()
        m = r.notna() & fin.notna()
        if m.sum() < 80:
            return None
        cf, cm = r[m].corr(fin[m]), r[m].corr(md[m])
        cj = r[m].corr(ix['Junior Market Index'].pct_change()[m]) if 'Junior Market Index' in ix else -1
        cx = r[m].corr(ix['Index'].pct_change()[m]) if 'Index' in ix else -1
        return 'Financial' if cf > max(cm + 0.05, 0.12) else 'Manufacturing & Distribution' if cm > max(cf + 0.05, 0.12) \
            else 'Junior Market' if cj > max(cx + 0.05, 0.1) else None

    # news, insiders, macro
    def posts_for(self, sym, start, end):
        a, b = str(_ts(start).date()), str(_ts(end).date())
        return [p for p in self.posts if p['sym'] == sym and a <= p['date'] <= b]

    def market_posts(self, start, end):
        a, b = str(_ts(start).date()), str(_ts(end).date())
        return [p for p in self.posts if p['sym'] is None and a <= p['date'] <= b]

    def trades_for(self, sym, asof, days=365):
        a, b = str((_ts(asof) - pd.Timedelta(days=days)).date()), str(_ts(asof).date())
        return [e for e in self.trades.get(sym, []) if a <= e['date'] <= b]

    def series(self, name, asof):
        """(title, unit, pandas Series up to asof) for a macro indicator, or None when the name is unknown.
        T-bill months count only once they are over."""
        asof = _ts(asof)
        key = _key(name)
        if key in ('usd_jmd', 'fx', 'jmd', 'exchange_rate'):
            fx = pd.Series({pd.Timestamp(d): v for d, v in self.macro.get('fx', {}).items()}, dtype=float).sort_index()
            return 'USD/JMD exchange rate', 'J$ per US$', fx.loc[:asof]
        if key in ('tbill', 'tbill_3m', 'tbill_6m', 'treasury_bill', 'tbill_yield'):
            i = 1 if key == 'tbill_6m' else 0
            tb = {pd.Period(k).to_timestamp(how='end').normalize(): v[i] for k, v in self.macro.get('tbill', {}).items()
                  if v[i] is not None and pd.Period(k) < asof.to_period('M')}
            return f'Government of Jamaica {"6" if i else "3"}-month Treasury bill yield (monthly)', '% a year', pd.Series(tb, dtype=float).sort_index()
        if key in INDEX_BY_KEY:
            return f'JSE {INDEX_BY_KEY[key]}', 'index points', self.levels[INDEX_BY_KEY[key]].loc[:asof].dropna()
        return None


# ---------------------------------------------------------------- what the agents are told

@dataclass
class Context:
    """What the installed adapter serves: the view, whether companies are hidden behind aliases (blind), and the case in
    focus: its date and, when blind, the company whose name and symbol are scrubbed from every text."""
    view: JseView
    blind: bool = False
    asof: str | None = None
    hidden: str | None = None

    def __post_init__(self):
        self.alias_of = {s: f'JSE{i:03d}' for i, s in enumerate(sorted(self.view.syms))}
        self.sym_of = {a: s for s, a in self.alias_of.items()}

    def focus(self, sym, asof):
        self.asof, self.hidden = asof, sym if self.blind else None

    def alias(self, sym):
        return self.alias_of[sym] if self.blind else sym

    def resolve(self, raw):
        raw = (raw or '').strip().upper()
        if raw == MKT:
            return MKT
        return self.view.resolve(self.sym_of.get(raw, '') if self.blind else raw)

    def scrub(self, text):
        return tslib.anon(text, self.hidden, (self.view.fund.get(self.hidden) or {}).get('name')) if self.hidden else text


_ctx: Context | None = None


def ctx():
    if _ctx is None:
        raise RuntimeError('committee.install(Context(...)) first')
    return _ctx


def _big(x, unit='J$'):
    if x is None or pd.isna(x):
        return 'n/a'
    for cut, tag in ((1e9, 'B'), (1e6, 'M'), (1e3, 'K')):
        if abs(x) >= cut:
            return f'{"-" if x < 0 else ""}{unit}{abs(x) / cut:,.2f}{tag}'
    return f'{unit}{x:,.2f}'


def _pct(x, digits=1):
    return 'n/a' if x is None or pd.isna(x) else f'{x * 100:+.{digits}f}%'


def _d(x):
    return str(_ts(x).date())


def _label(raw):
    return raw.strip().upper()


def load_ohlcv(symbol, as_of_date, fill_gaps=True):
    """Stands in for TradingAgents' Yahoo load_ohlcv (same contract: Date, Open, High, Low, Close, Volume up to as_of_date)."""
    c = ctx()
    frame = c.view.frame(c.resolve(symbol), as_of_date)
    if frame.empty:
        raise NoMarketDataError(symbol, symbol, f'no price rows on or before {as_of_date}')
    late = (_ts(as_of_date) - frame.Date.iloc[-1]).days
    if late > STALE_DAYS:
        raise NoMarketDataError(symbol, symbol, f'latest row is {_d(frame.Date.iloc[-1])}, {late} days before {as_of_date} (stale)')
    return frame


def get_closes(symbol, start_date, end_date):
    """Stands in for TradingAgents' settlement closes: daily closes from start_date up to, not including, end_date."""
    try:
        return ctx().view.closes(ctx().resolve(symbol), start_date, end_date)
    except NoMarketDataError:
        return pd.Series(dtype=float)


def get_company_profile(ticker):
    c = ctx()
    sym = c.resolve(ticker)
    sector = c.view.sector(sym, c.asof or c.view.close.index[-1])
    if c.blind:
        return {'longName': f'a company listed on the {EXCHANGE}' + (f' ({sector} sector)' if sector else ''), 'exchange': EXCHANGE}
    return {'longName': c.view.fund.get(sym, {}).get('name'), 'sector': sector, 'exchange': EXCHANGE, 'quoteType': 'EQUITY'}


def stock_data(symbol, start_date, end_date):
    c = ctx()
    frame = load_ohlcv(symbol, end_date)
    rows = frame[frame.Date >= _ts(start_date)]
    if rows.empty:
        raise NoMarketDataError(symbol, symbol, f'no trading rows between {start_date} and {end_date}')
    shown = rows.tail(120)
    csv = shown.assign(Date=shown.Date.dt.strftime('%Y-%m-%d'), Volume=shown.Volume.round().astype('int64')).round(4).to_csv(index=False)
    what = ('JSE market index: equal-weight average daily return of the stocks that traded on 20%+ of the last 60 days, price only, '
            'starting at 100; Volume is J$ traded by those stocks') if c.resolve(symbol) == MKT else \
        f'prices in J$ (US$ for symbols ending USD), split-adjusted; Volume in shares'
    return (f'# Stock data for {_label(symbol)} from {start_date} to {end_date} ({EXCHANGE})\n# Total records: {len(rows)}'
            + (f' (showing the latest {len(shown)})' if len(shown) < len(rows) else '') + f'\n# {what}\n'
            '# Open is the previous close (the JSE data has no opening price). High and Low are the quoted range for the day where the '
            'JSE detail file has it, otherwise the close.\n\n' + csv)


def indicators(symbol, indicator, as_of_date, look_back_days):
    from tradingagents.dataflows.vendors.yahoo.market import get_stock_stats_indicators_window
    return get_stock_stats_indicators_window(symbol, indicator, as_of_date, look_back_days)


def _asof(as_of_date):
    return as_of_date or str(ctx().view.close.index[-1].date())


def fundamentals(ticker, as_of_date=None):
    c = ctx()
    sym, asof = c.resolve(ticker), _asof(as_of_date)
    if sym == MKT:
        raise NoMarketDataError(ticker, ticker, 'the market index has no company fundamentals')
    o = c.view.overview(sym, asof)
    L = [f'# Company overview for {_label(ticker)} ({EXCHANGE}) as of {asof}', '']
    if not c.blind and o['name']:
        L.append(f'Name: {o["name"]}')
    if o['sector']:
        L.append(f'Sector: {o["sector"]}')
    L.append(f'Last price: {o["price"]:,.2f} on {_d(o["priceDate"])}. 12-month range {o["year"][0]:,.2f} to {o["year"][1]:,.2f}. '
             'Amounts are in the share\'s quote currency (J$ for almost every JSE stock).')
    L.append('Price change: ' + ', '.join(f'{k} {_pct(v)}' for k, v in o['returns'].items()) + f'; 3 months vs the JSE market {_pct(o["vsMarket3m"])}.')
    L.append(f'Market value {_big(o["marketValue"])} (price x the latest known share count). Trailing 12-month profit {_big(o["ttmProfit"])} '
             f'(last 4 quarters published by {asof}; {o["quartersPublished"]} quarters on record).')
    L.append(f'Earnings yield (trailing profit / market value) {_pct(o["ey"])}; profit growth vs a year earlier {_pct(o["growth"], 0)}; dividend yield (last 12 months) '
             f'{_pct(o["dy"]).lstrip("+")}; loss-making quarters in the last 4: {"n/a" if pd.isna(o["lossq"]) else int(o["lossq"])}.')
    if o['dividends']:
        L.append('Recent dividends (ex-date, per share): ' + '; '.join(f'{d["ex"]} {d["cur"]} {d["amt"]:g}' for d in o['dividends']) + '.')
    else:
        L.append('No dividends on record before this date.')
    L.append(f'Liquidity: traded on {o["tradedShare"] * 100:.0f}% of the last 60 days, about {_big(o["valuePerDay"])} a day over the last 20; '
             f'typical bid/ask spread {"n/a" if o["spread"] is None else f"{o["spread"] * 100:.1f}%"}.')
    return '\n'.join(L)


def _statement(title, fields, ticker, freq, as_of_date):
    c = ctx()
    sym, asof = c.resolve(ticker), _asof(as_of_date)
    reports = [r for r in c.view.statements(sym, asof) if freq.lower() != 'annual' or r.get('months') == 12][:6]
    if not reports:
        return (f'# {title} for {_label(ticker)} ({freq}): no {"annual " if freq.lower() == "annual" else ""}statements published on or before '
                f'{asof} are in the app\'s data. Report the figures as unavailable.')
    head = ['field'] + [f'{r["period_end"]} ({r.get("months")}m {r.get("currency")}, published {r["pub"]})' for r in reports]
    rows = [[k] + ['' if r.get(k) is None else f'{r[k]:.0f}' for r in reports] for k in fields]
    return (f'# {title} data for {_label(ticker)} ({freq}), as published on the JSE by {asof}\n'
            '# Columns are reporting periods: period end, months of the financial year covered (income and cash-flow figures are '
            'cumulative for those months), currency, publication date. Amounts are in full units of that currency.\n'
            + '\n'.join(','.join(map(str, r)) for r in [head] + rows))


def balance_sheet(ticker, freq='quarterly', as_of_date=None):
    return _statement('Balance Sheet', BALANCE, ticker, freq, as_of_date)


def cashflow(ticker, freq='quarterly', as_of_date=None):
    return _statement('Cash Flow', CASHFLOW, ticker, freq, as_of_date)


def income_statement(ticker, freq='quarterly', as_of_date=None):
    return _statement('Income Statement', INCOME, ticker, freq, as_of_date)


def _note(p):
    n = p['note']
    if n:
        parts = [f'{k}: {n[k]}' for k in ('what', 'why', 'numbers', 'next', 'tone') if n.get(k)]
        return ' | '.join(parts)
    return re.sub(r'\s+', ' ', p['text'])[:300]


def news(ticker, start_date, end_date):
    c = ctx()
    posts = c.view.posts_for(c.resolve(ticker), start_date, end_date)[:12]
    if not posts:
        return f'No JSE announcements for {_label(ticker)} between {start_date} and {end_date} in the app\'s feed.'
    body = '\n\n'.join(f'### {p["date"]} {c.scrub(p["title"])}\n{c.scrub(_note(p))}' for p in posts)
    return f'## JSE announcements for {_label(ticker)}, {start_date} to {end_date} (newest first):\n\n{body}'


def global_news(as_of_date, look_back_days=None, limit=None):
    c = ctx()
    days, limit = look_back_days or 14, limit or 10
    start = _ts(as_of_date) - pd.Timedelta(days=days)
    posts = c.view.market_posts(start, as_of_date)[:limit]
    ix = c.view.levels['Index'].loc[:_ts(as_of_date)].dropna()
    then = ix.loc[:start]
    head = ''
    if len(ix):
        head = f'JSE Main Index {ix.iloc[-1]:,.0f}' + (f' ({_pct(ix.iloc[-1] / then.iloc[-1] - 1)} over {days} days)' if len(then) else '') + '.\n\n'
    if not posts:
        return head + f'No market-wide JSE notices between {_d(start)} and {as_of_date} in the app\'s feed.'
    return head + f'## Market-wide JSE notices, {_d(start)} to {as_of_date} (newest first):\n\n' + '\n\n'.join(
        f'### {p["date"]} {c.scrub(p["title"])}\n{c.scrub(_note(p))}' for p in posts)


def insider_transactions(ticker, as_of_date=None):
    c = ctx()
    sym, asof = c.resolve(ticker), _asof(as_of_date)
    trades = c.view.trades_for(sym, asof)
    if not trades:
        return f'No director or officer share trades for {_label(ticker)} in the 12 months to {asof} in the app\'s insider-notice feed.'
    buys = [e for e in trades if e['side'] == 'buy']
    sells = [e for e in trades if e['side'] == 'sell']
    lines = [f'{e["date"]} | {e["side"]} | {e["who"] or "unknown"} | {int(e["shares"] or 0):,} shares | {c.scrub(e["title"])}' for e in trades[-20:]]
    return (f'# Insider transactions for {_label(ticker)}, 12 months to {asof} (JSE notices read by the app)\n'
            f'{len(buys)} buy notices ({int(sum(e["shares"] or 0 for e in buys)):,} shares), {len(sells)} sell notices ({int(sum(e["shares"] or 0 for e in sells)):,} shares).\n'
            + '\n'.join(lines))


def macro_indicators(indicator, as_of_date, look_back_days=None):
    c = ctx()
    found = c.view.series(indicator, as_of_date)
    if found is None:
        return (f'No Jamaican series called {indicator!r}. Available: usd_jmd, tbill_3m, tbill_6m, ' + ', '.join(MACRO_INDEX)
                + '. US data such as FRED series is not available here.')
    title, unit, s = found
    days = look_back_days or 365
    s = s.loc[_ts(as_of_date) - pd.Timedelta(days=days):]
    if s.empty:
        return f'{title}: no observations in the {days} days to {as_of_date}.'
    pick = s.iloc[np.unique(np.linspace(0, len(s) - 1, min(len(s), 12)).round().astype(int))]
    return (f'## {title} ({unit}), {_d(s.index[0])} to {_d(s.index[-1])}\nLatest {s.iloc[-1]:,.4g} on {_d(s.index[-1])}; '
            f'change over the window {_pct(s.iloc[-1] / s.iloc[0] - 1) if s.iloc[0] else "n/a"}.\n\ndate,value\n'
            + '\n'.join(f'{_d(d)},{v:.4g}' for d, v in pick.items()))


def prediction_markets(topic, limit=None, as_of_date=None):
    return 'Prediction markets are not applicable to the Jamaica Stock Exchange: no market-implied probabilities exist for JSE stocks. Proceed without them.'


# One row per tool TradingAgents routes; install() puts each in the router as vendor "jse".
ROUTES = {
    'get_stock_data': stock_data, 'get_indicators': indicators, 'get_fundamentals': fundamentals,
    'get_balance_sheet': balance_sheet, 'get_cashflow': cashflow, 'get_income_statement': income_statement,
    'get_news': news, 'get_global_news': global_news, 'get_insider_transactions': insider_transactions,
    'get_macro_indicators': macro_indicators, 'get_prediction_markets': prediction_markets,
}


def install(context):
    """Serve `context` to TradingAgents: the router's "jse" vendor and the names its Yahoo code imports directly."""
    global _ctx
    from tradingagents.agents import context as agent_context
    from tradingagents.dataflows import router
    from tradingagents.dataflows.vendors.yahoo import market, snapshot
    from tradingagents.memory import settlement
    routed = {m for info in router.TOOLS_CATEGORIES.values() for m in info['tools']}
    if routed != set(ROUTES):
        raise RuntimeError(f'TradingAgents routes {sorted(routed ^ set(ROUTES))} that ROUTES does not match')
    _ctx = context
    for method, fn in ROUTES.items():
        router.VENDOR_METHODS[method]['jse'] = fn
    market.load_ohlcv = snapshot.load_ohlcv = load_ohlcv
    market.get_closes = settlement.get_closes = get_closes
    agent_context.get_company_profile = get_company_profile


def config(mode, model):
    """TradingAgents config: everything routed to "jse", analysts without social, bounded debates and output, one folder per mode."""
    from tradingagents.dataflows import router
    from tradingagents.default_config import DEFAULT_CONFIG
    cfg = deepcopy(DEFAULT_CONFIG)
    home = DIR / mode
    cfg.update(
        llm_provider='openrouter', deep_think_llm=model, quick_think_llm=model, backend_url=None, max_debate_rounds=1,
        max_risk_discuss_rounds=1, max_tool_rounds=6, max_tokens=int(os.environ.get('COMMITTEE_MAX_TOKENS', 2500)), output_language='English', holding_period_days=H,
        benchmark_ticker=MKT, results_dir=str(home / 'results'), data_cache_dir=str(DIR / 'cache'),
        memory_log_path=str(home / 'memory.md'), news_article_limit=12, global_news_article_limit=10, global_news_lookback_days=14,
        data_vendors={category: 'jse' for category in router.TOOLS_CATEGORIES}, tool_vendors={})
    return cfg


# ---------------------------------------------------------------- the model, its key and its budget

def load_key():
    key = os.environ.get('OPENROUTER_API_KEY', '').strip()
    if not key:
        path = Path.home() / '.config' / 'openrouter' / '.env'
        m = re.search(r'^OPENROUTER_API_KEY\s*=\s*(.+)$', path.read_text(encoding='utf-8') if path.exists() else '', re.M)
        key = m.group(1).strip().strip('\'"') if m else ''
    if not key:
        raise SystemExit('committee: no OPENROUTER_API_KEY in the environment or ~/.config/openrouter/.env')
    os.environ['OPENROUTER_API_KEY'] = key
    return key


class Budget:
    """The key's lifetime spend in US$. OpenRouter's usage figure trails the calls by a minute or two, so the spend this process
    has measured on the responses themselves counts too; a run refuses to start once either reaches the limit."""

    def __init__(self, key, limit):
        self.key, self.limit, self.known = key, limit, 0.0

    def usage(self):
        req = urllib.request.Request('https://openrouter.ai/api/v1/key', headers={'Authorization': f'Bearer {self.key}'})
        with urllib.request.urlopen(req, timeout=30) as r:
            return float(json.loads(r.read())['data']['usage'])

    def start(self):
        spent = max(self.usage(), self.known)
        print(f'COMMITTEE spent so far US${spent:.4f} of US${self.limit:.2f}')
        if spent >= self.limit:
            raise SystemExit(f'committee: budget reached (US${spent:.4f} >= US${self.limit:.2f}); not starting a run')
        return spent


class Spend(BaseCallbackHandler):
    """Cost in US$ and tokens of every model response, as OpenRouter reports them on the response."""

    def __init__(self):
        self.cost, self.tokens, self.lock = 0.0, 0, threading.Lock()

    def on_llm_end(self, response, **kwargs):
        usage = (response.llm_output or {}).get('token_usage') or {}
        with self.lock:
            self.cost += usage.get('cost') or 0.0
            self.tokens += usage.get('total_tokens') or 0


class Blocked:
    """Raises for any lookup of the data hosts TradingAgents would use by default, and counts the attempts."""

    def __init__(self):
        self.attempts = []

    def __enter__(self):
        self._real = socket.getaddrinfo

        def guard(host, *a, **k):
            if DATA_HOSTS.search(str(host)):
                self.attempts.append(str(host))
                raise OSError(f'blocked: {host} (the committee runs on the app\'s own data)')
            return self._real(host, *a, **k)

        socket.getaddrinfo = guard
        return self

    def __exit__(self, *exc):
        socket.getaddrinfo = self._real


def build_graph(mode, model, blind, callbacks=()):
    from tradingagents.graph.trading_graph import TradingAgentsGraph
    graph = TradingAgentsGraph(selected_analysts=list(ANALYSTS), config=config(mode, model), callbacks=list(callbacks))
    if blind:
        from tradingagents.memory.settlement import Settlement
        graph.settle_all_pending = lambda wait=True: Settlement()   # no lessons from real outcomes between blind cases
    return graph


class Committee:
    """One TradingAgents graph for a mode, with the budget, the spend and the network guard around every run."""

    def __init__(self, mode, blind):
        self.model = os.environ.get('COMMITTEE_MODEL', 'openai/gpt-oss-120b')
        self.budget = Budget(load_key(), float(os.environ.get('COMMITTEE_BUDGET', 4.5)))
        self.spend, self.blocked = Spend(), Blocked()
        self.graph = build_graph(mode, self.model, blind, [self.spend])

    def run(self, ticker, trade_date):
        """-> (state, rating, cost in US$, seconds, tokens)"""
        before, t0 = self.budget.start(), time.time()
        cost0, tokens0 = self.spend.cost, self.spend.tokens
        with self.blocked:
            state, rating = self.graph.propagate(ticker, trade_date)
        seconds, cost, tokens = time.time() - t0, self.spend.cost - cost0, self.spend.tokens - tokens0
        self.budget.known = before + cost
        print(f'COMMITTEE {ticker} {trade_date}: {rating}, US${cost:.4f}, {seconds:.0f}s, {tokens:,} tokens; running total US${self.budget.known:.4f}; '
              f'blocked data-host lookups {len(self.blocked.attempts)}')
        return state, rating, cost, seconds, tokens


# ---------------------------------------------------------------- live

def live_symbols(view, args):
    if args:
        return [view.resolve(a) for a in args]
    stocks = _load('data/forecasts.json', {}).get('stocks', {})
    ranked = sorted((v['edge']['rank'], s) for s, v in stocks.items() if (v.get('edge') or {}).get('rank') and s in view.syms)
    top = [s for _, s in ranked[:5]]
    return top + ([] if 'TJH' in top else ['TJH'])


def live(args):
    view = JseView()
    context = Context(view)
    install(context)
    syms = live_symbols(view, args)
    today = date.today().isoformat()
    committee = Committee('live', blind=False)
    forecasts = _load('data/forecasts.json', {})
    out = _load(LIVE_OUT, {})
    if out.get('asof') != today or out.get('model') != committee.model:
        out = {'asof': today, 'dataThrough': str(view.close.index[-1].date()), 'model': committee.model, 'totalCost': 0.0, 'stocks': {}}
    for s in syms:
        context.focus(s, today)
        state, rating, cost, seconds, tokens = committee.run(s, today)
        committee.graph.save_reports(state, s)
        old = out['stocks'].get(s, {})
        out['stocks'][s] = {'rating': rating, 'edgeRank': ((forecasts.get('stocks', {}).get(s) or {}).get('edge') or {}).get('rank'),
                            'decision': (state.get('final_trade_decision') or '')[:1500], 'cost': round(cost, 4), 'seconds': round(seconds), 'tokens': tokens}
        out['totalCost'] = round(out['totalCost'] - old.get('cost', 0) + cost, 4)
        json.dump(out, open(LIVE_OUT, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    print('COMMITTEE live', json.dumps({s: v['rating'] for s, v in out['stocks'].items()}), f'US${out["totalCost"]:.4f}')


# ---------------------------------------------------------------- the blind test

def plan_cases(hist_days, index, horizon=H):
    """Review dates 3 grid steps apart (63 trading days), oldest first, with the Edge top TOP on each: [(date, t, [(sym, rank)])].
    A date whose outcome window runs past the data is left out."""
    keep = [d for d in sorted(hist_days) if index.get_loc(pd.Timestamp(d)) < len(index) - horizon - 2]
    return [(d, index.get_loc(pd.Timestamp(d)), sorted(((s, v[1]) for s, v in hist_days[d].items() if v[1]), key=lambda x: x[1])[:TOP])
            for d in keep[::STEP]]


def tool_outputs(ticker, trade_date):
    """The text of every data tool for one stock on one day, as the agents would read it."""
    end = pd.Timestamp(trade_date)
    start, day = str((end - pd.Timedelta(days=60)).date()), str(end.date())
    return {'get_stock_data': stock_data(ticker, start, day), 'get_indicators': indicators(ticker, 'rsi', day, 10),
            'get_fundamentals': fundamentals(ticker, day), 'get_balance_sheet': balance_sheet(ticker, 'quarterly', day),
            'get_cashflow': cashflow(ticker, 'quarterly', day), 'get_income_statement': income_statement(ticker, 'quarterly', day),
            'get_news': news(ticker, str((end - pd.Timedelta(days=90)).date()), day), 'get_global_news': global_news(day),
            'get_insider_transactions': insider_transactions(ticker, day), 'get_macro_indicators': macro_indicators('usd_jmd', day),
            'get_prediction_markets': prediction_markets('JSE')}


HARNESS = {'jse', 'stock', 'exchange', 'shares', 'manufacturing', 'distribution', 'jmd', 'usd'}   # words the tool texts themselves use


def leaks(text, sym, name):
    """The symbol or distinctive name words still readable in `text`."""
    words = [w for w in re.findall(r'[A-Za-z0-9&]+', name or '') if w.lower() not in tslib.GENERIC | HARNESS and len(w) > 2]
    return [w for w in ([sym] if sym.lower() not in HARNESS else []) + words if re.search(rf'\b{re.escape(w)}\b', text, re.I if w != sym else 0)]


def _tstat(x):
    x = np.asarray(x, float)
    return float(x.mean() / (x.std(ddof=1) / np.sqrt(len(x)))) if len(x) > 2 and x.std(ddof=1) > 0 else 0.0


def _welch(a, b):
    a, b = np.asarray(a, float), np.asarray(b, float)
    if len(a) < 2 or len(b) < 2:
        return 0.0
    se = np.sqrt(a.var(ddof=1) / len(a) + b.var(ddof=1) / len(b))
    return float((a.mean() - b.mean()) / se) if se > 0 else 0.0


UP, DOWN = {'Buy', 'Overweight'}, {'Underweight', 'Sell'}


def _verdict(effect, t, first, second):
    holds = first is not None and second is not None and np.sign(first) == np.sign(second)
    return ('edge' if effect > 0 else 'negative edge (avoid)') if abs(t) >= 2 and holds else 'no reliable edge'


def _per_date(rows, adjust):
    """{date: [(group, value)]}; with `adjust` the excess is first cleared of what Edge's rank explains within that date."""
    by = {}
    for r in rows:
        by.setdefault(r['date'], []).append(r)
    out = {}
    for d, g in by.items():
        ex = np.array([r['excess'] for r in g], float)
        if adjust:
            rank = np.array([r['edgeRank'] for r in g], float)
            if len(g) < 4 or rank.std() == 0:
                continue
            slope = np.cov(rank, ex, bias=True)[0, 1] / rank.var()
            ex = ex - (ex.mean() + slope * (rank - rank.mean()))
        out[d] = [('up' if r['rating'] in UP else 'down' if r['rating'] in DOWN else None, v) for r, v in zip(g, ex)]
    return out


def summarize(cases):
    """Ratings against the market: counts and mean excess per rating, and the tests (each one counts toward the app's tests tried)."""
    rows = [r for r in cases if 'excess' in r]
    if not rows:
        return {'cases': 0, 'tests': {}}
    dates = sorted({r['date'] for r in rows})
    half = dates[len(dates) // 2]
    pct = lambda x: None if x is None else round(float(x) * 100, 2)

    def group(members):
        g = [r for r in rows if r['rating'] in members]
        if not g:
            return None
        by = {}
        for r in g:
            by.setdefault(r['date'], []).append(r['excess'])
        f, s = [r['excess'] for r in g if r['date'] < half], [r['excess'] for r in g if r['date'] >= half]
        mean = np.mean([r['excess'] for r in g])
        t = _tstat([np.mean(v) for v in by.values()])
        f_m, s_m = (np.mean(f) if len(f) >= 5 else None), (np.mean(s) if len(s) >= 5 else None)
        return {'n': len(g), 'avgExcess': pct(mean), 't': round(t, 2), 'firstHalf': pct(f_m), 'secondHalf': pct(s_m), 'verdict': _verdict(mean, t, f_m, s_m)}

    def pooled(sel):
        up = [r['excess'] for r in sel if r['rating'] in UP]
        down = [r['excess'] for r in sel if r['rating'] in DOWN]
        return (np.mean(up) - np.mean(down)) if len(up) >= 3 and len(down) >= 3 else None

    def spread(adjust):
        sp = {}
        for d, g in _per_date(rows, adjust).items():
            up, down = [v for k, v in g if k == 'up'], [v for k, v in g if k == 'down']
            if up and down:
                sp[d] = (np.mean(up) - np.mean(down), len(up) + len(down))
        return sp

    out = {'cases': len(rows), 'from': dates[0], 'to': dates[-1],
           'ratings': {k: {'n': sum(1 for r in rows if r['rating'] == k), 'avgExcess': pct(np.mean([r['excess'] for r in rows if r['rating'] == k]))}
                       for k in ('Buy', 'Overweight', 'Hold', 'Underweight', 'Sell', 'REVIEW') if any(r['rating'] == k for r in rows)}}
    tests = {}
    for key, members in (('buyOverweight63', UP), ('underweightSell63', DOWN)):
        if (g := group(members)):
            tests[key] = g
    up, down = [r['excess'] for r in rows if r['rating'] in UP], [r['excess'] for r in rows if r['rating'] in DOWN]
    if len(up) >= 2 and len(down) >= 2:
        f, s = pooled([r for r in rows if r['date'] < half]), pooled([r for r in rows if r['date'] >= half])
        t = _welch(up, down)
        eff = np.mean(up) - np.mean(down)
        tests['spread63'] = {'n': len(up) + len(down), 'avgExcess': pct(eff), 't': round(t, 2), 'firstHalf': pct(f), 'secondHalf': pct(s), 'verdict': _verdict(eff, t, f, s)}
    for key, adjust in (('withinDates63', False), ('beyondEdge63', True)):
        sp = spread(adjust)
        if len(sp) >= 3:
            vals = [v for v, _ in sp.values()]
            f = [v for d, (v, _) in sp.items() if d < half]
            s = [v for d, (v, _) in sp.items() if d >= half]
            t = _tstat(vals)
            tests[key] = {'n': sum(n for _, n in sp.values()), 'avgExcess': pct(np.mean(vals)), 't': round(t, 2), 'dates': len(sp),
                          'firstHalf': pct(np.mean(f)) if len(f) >= 2 else None, 'secondHalf': pct(np.mean(s)) if len(s) >= 2 else None,
                          'verdict': _verdict(np.mean(vals), t, np.mean(f) if len(f) >= 2 else None, np.mean(s) if len(s) >= 2 else None)}
    out['tests'] = tests
    return out


def ensure_hist():
    if not os.path.exists(HIST_PATH):
        print('COMMITTEE building the walk-forward Edge history (scripts/edge_v2.py)')
        import subprocess
        subprocess.run([sys.executable, 'scripts/edge_v2.py'], check=True)
    return _load(HIST_PATH, {}).get('days', {})


def backtest(max_new, dry):
    hist = ensure_hist()
    import factor_study as fs
    view = JseView()
    context = Context(view, blind=True)
    install(context)
    plan = plan_cases(hist, fs.idx)
    store = _load(STORE, {'cases': {}})
    todo = [(d, t, s, rank) for d, t, picks in plan for s, rank in picks if f'{s}|{d}' not in store['cases'] and fs.TRI[s].iloc[t + 1] > 0 and s in view.syms]
    print(f'COMMITTEE BACKTEST {len(todo)} cases waiting over {len(plan)} review dates, {len(store["cases"])} done; running {min(max_new, len(todo))}')
    if dry:
        for i, (d, t, s, rank) in enumerate(todo):
            context.focus(s, d)
            outs = tool_outputs(context.alias(s), d)
            found = {m: w for m, x in outs.items() if (w := leaks(x, s, view.fund.get(s, {}).get('name')))}
            print(f'case {context.alias(s)} {d} edge rank {rank}: {sum(map(len, outs.values())):,} characters of tool output; name or symbol leaks {found or "none"}')
            if i == 0:
                print(json.dumps(get_company_profile(context.alias(s))))
                for m, x in outs.items():
                    print(f'\n----- {m} -----\n{x}')
        return
    committee = Committee('backtest', blind=True)
    failures = 0
    for d, t, s, rank in todo[:max_new]:
        context.focus(s, d)
        try:
            state, rating, cost, seconds, tokens = committee.run(context.alias(s), d)
        except Exception as e:
            failures += 1
            print(f'COMMITTEE {context.alias(s)} {d} failed: {type(e).__name__}: {str(e)[:160]}')
            if failures >= 3:
                break
            continue
        r, ex = fs.outcome(s, t, H, COST)
        store['cases'][f'{s}|{d}'] = {'date': d, 'alias': context.alias(s), 'sym': s, 'edgeRank': rank, 'rating': rating, 'ret': round(r, 4),
                                      'excess': round(ex, 4), 'cost': round(cost, 4), 'seconds': round(seconds), 'tokens': tokens}
        store.update(model=committee.model, summary=summarize(list(store['cases'].values())),
                     totalCost=round(sum(c['cost'] for c in store['cases'].values()), 4))
        json.dump(store, open(STORE, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    print('COMMITTEE BACKTEST', json.dumps(store.get('summary')))


def main(argv):
    mode, rest = (argv[1] if len(argv) > 1 else 'live'), argv[2:]
    if mode == 'live':
        live(rest)
    elif mode == 'backtest':
        backtest(int(next((a for a in rest if a.isdigit()), 400)), '--dry-run' in rest)
    else:
        raise SystemExit(__doc__)


if __name__ == '__main__':
    main(sys.argv)
