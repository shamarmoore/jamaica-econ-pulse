from copy import copy, deepcopy
from pathlib import Path
from unittest import mock
import json
import re
import subprocess
import sys
import unittest

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import committee as C  # noqa: E402
import test_registry  # noqa: E402
import tslib  # noqa: E402

VIEW = None
ASOF = '2025-06-30'
SAMPLE = ['TJH', 'BIL', 'CAR', 'JBG']


def setUpModule():
    global VIEW
    VIEW = C.JseView()


def poisoned(view, asof):
    """The same data with everything dated after `asof` replaced by loud nonsense."""
    v = copy(view)
    after = view.close.index > pd.Timestamp(asof)
    for name in ('close', 'vol', 'hi', 'lo', 'bid', 'ask'):
        frame = getattr(view, name).copy()
        frame.loc[after] = frame.loc[after] * 1000 + 1
        setattr(v, name, frame)
    v.levels = view.levels.copy()
    v.levels.loc[after] = 1.0
    v.posts = sorted(view.posts + [{'date': '2030-01-01', 'sym': s, 'title': f'FUTURE {s} NEWS', 'text': 'FUTURE', 'note': None} for s in SAMPLE + [None]],
                     key=lambda p: p['date'], reverse=True)
    v.trades = {s: list(es) for s, es in view.trades.items()}
    for s in SAMPLE:
        v.trades.setdefault(s, []).append({'sym': s, 'side': 'buy', 'who': 'director', 'shares': 1e9, 'date': '2030-01-01', 'title': 'FUTURE'})
    v.reports = {s: list(rs) for s, rs in view.reports.items()}
    for s in SAMPLE:
        v.reports.setdefault(s, []).append({'sym': s, 'pub': '2030-01-01', 'period_end': '2029-12-31', 'months': 12, 'currency': 'JMD',
                                            'total_assets': 1, 'revenue': 1, 'net_profit': 1e12, 'operating_cash_flow': 1})
    v.macro = deepcopy(view.macro)
    v.macro['fx'] = {**v.macro['fx'], '2030-01-01': 1.0}
    v.macro['tbill'] = {**v.macro['tbill'], '2030-01': [99.0, 99.0]}
    v.fund = deepcopy(view.fund)
    for s in SAMPLE:
        v.fund[s]['dividends'].append({'ex': '2030-01-01', 'cur': 'JMD', 'amt': 999.0})
        v.fund[s]['quarters']['2031'] = [1e12] * 4
    v._frames, v._features = {}, {}
    v.market = v._build_market()
    return v


def outputs(view, asof, blind=False):
    context = C.Context(view, blind=blind)
    C.install(context)
    result = {}
    for s in SAMPLE:
        context.focus(s, asof)
        result[s] = C.tool_outputs(context.alias(s), asof)
    return result


class PointInTimeTests(unittest.TestCase):
    def test_nothing_after_asof_reaches_any_tool_output(self):
        for blind in (False, True):
            self.assertEqual(outputs(VIEW, ASOF, blind), outputs(poisoned(VIEW, ASOF), ASOF, blind))

    def test_nothing_after_asof_reaches_any_accessor(self):
        future = poisoned(VIEW, ASOF)
        self.assertEqual(VIEW.market[VIEW.market.Date <= ASOF].reset_index(drop=True).to_dict('list'), future.frame(C.MKT, ASOF).to_dict('list'))
        for s in SAMPLE:
            self.assertEqual(VIEW.frame(s, ASOF).to_dict('list'), future.frame(s, ASOF).to_dict('list'))
            self.assertEqual(repr(VIEW.overview(s, ASOF)), repr(future.overview(s, ASOF)))
            self.assertEqual(VIEW.statements(s, ASOF), future.statements(s, ASOF))
            self.assertEqual(VIEW.posts_for(s, '2020-01-01', ASOF), future.posts_for(s, '2020-01-01', ASOF))
            self.assertEqual(VIEW.trades_for(s, ASOF), future.trades_for(s, ASOF))
        self.assertEqual(VIEW.market_posts('2020-01-01', ASOF), future.market_posts('2020-01-01', ASOF))
        for name in ('usd_jmd', 'tbill_3m', 'main_index'):
            self.assertEqual(VIEW.series(name, ASOF)[2].to_dict(), future.series(name, ASOF)[2].to_dict())

    def test_poison_is_visible_when_the_date_moves_past_it(self):
        future = poisoned(VIEW, ASOF)
        self.assertEqual([p['title'] for p in future.posts_for('TJH', '2029-12-01', '2030-01-02')], ['FUTURE TJH NEWS'])
        self.assertGreater(future.frame('TJH', '2030-01-02').Close.iloc[-1], 1000 * VIEW.frame('TJH', ASOF).Close.iloc[-1] / 10)
        self.assertEqual(future.statements('TJH', '2030-01-02')[0]['pub'], '2030-01-01')

    def test_what_is_served_is_dated_on_or_before_asof(self):
        for s in SAMPLE:
            self.assertLessEqual(VIEW.frame(s, ASOF).Date.max(), pd.Timestamp(ASOF))
            self.assertTrue(all(r['pub'] <= ASOF for r in VIEW.statements(s, ASOF)))
            self.assertTrue(all(p['date'] <= ASOF for p in VIEW.posts_for(s, '2000-01-01', ASOF)))
            self.assertTrue(all(e['date'] <= ASOF for e in VIEW.trades_for(s, ASOF)))
        self.assertLessEqual(VIEW.series('usd_jmd', ASOF)[2].index.max(), pd.Timestamp(ASOF))
        self.assertLess(VIEW.series('tbill_3m', '2025-06-15')[2].index.max(), pd.Timestamp('2025-06-01'))

    def test_a_statement_is_withheld_until_its_publication_date(self):
        report = next(r for r in VIEW.reports['TJH'] if r['pub'] > '2024-01-01')
        before = (pd.Timestamp(report['pub']) - pd.Timedelta(days=1)).date()
        self.assertNotIn(report['pub'], [r['pub'] for r in VIEW.statements('TJH', before)])
        self.assertIn(report['pub'], [r['pub'] for r in VIEW.statements('TJH', report['pub'])])


class PriceTests(unittest.TestCase):
    def test_frame_has_the_columns_trading_agents_expects(self):
        f = VIEW.frame('TJH', ASOF)
        self.assertEqual(list(f.columns), ['Date', 'Open', 'High', 'Low', 'Close', 'Volume'])
        self.assertTrue(pd.api.types.is_datetime64_any_dtype(f.Date))

    def test_adjusted_high_and_low_bracket_the_adjusted_close_on_the_close_scale(self):
        for s in VIEW.syms:
            f = VIEW.frame(s, '2026-12-31')
            self.assertTrue((f.High >= f.Close - 1e-9).all() and (f.Low <= f.Close + 1e-9).all(), s)
            self.assertLess((f.High / f.Close).max(), 2.5, f'{s}: a high quoted before a split but not scaled by it?')
            self.assertGreater((f.Low / f.Close).min(), 0.4, s)

    def test_a_split_does_not_leave_a_cliff_in_the_adjusted_series(self):
        sym, day, factor = tslib.splits()[0]
        f = VIEW.frame(sym, '2026-12-31').set_index('Date')
        day = pd.Timestamp(day)
        prev = f.Close[f.index < day].iloc[-1]
        self.assertGreater(f.Close[f.index >= day].iloc[0] / prev, 0.6)
        self.assertGreater(factor, 1.5)

    def test_open_is_the_previous_close(self):
        f = VIEW.frame('BIL', ASOF)
        self.assertEqual(f.Open.iloc[1:].tolist(), f.Close.iloc[:-1].tolist())

    def test_market_is_the_equal_weight_average_return_of_stocks_that_traded(self):
        day = pd.Timestamp('2025-03-14')
        P = VIEW.close.ffill()
        i = P.index.get_loc(day)
        traded = (VIEW.vol.iloc[i - 59:i + 1] > 0).mean() >= C.MIN_TRADED
        r = (P.iloc[i] / P.iloc[i - 1] - 1)[traded & (P.iloc[i - 1] > 0)].clip(-0.6, 1.5)
        m = VIEW.market.set_index('Date').Close
        self.assertAlmostEqual(m.loc[day] / m.shift(1).loc[day] - 1, r.mean(), places=9)
        C.install(C.Context(VIEW))
        self.assertEqual(C.get_closes(C.MKT, '2025-03-14', '2025-03-15').index.tolist(), [day])

    def test_indicators_run_on_jse_prices(self):
        C.install(C.Context(VIEW))
        text = C.indicators('TJH', 'close_50_sma', ASOF, 5)
        last = VIEW.frame('TJH', ASOF).Close.tail(50).mean()
        self.assertIn(f'{ASOF}:', text)
        self.assertAlmostEqual(float(re.search(rf'{ASOF}: ([\d.]+)', text).group(1)), last, places=6)

    def test_no_price_is_stale_or_unknown_without_saying_so(self):
        C.install(C.Context(VIEW))
        with self.assertRaises(C.NoMarketDataError):
            C.load_ohlcv('NOSUCH', ASOF)
        with self.assertRaisesRegex(C.NoMarketDataError, 'stale'):
            C.load_ohlcv('TJH', '2027-12-31')
        with self.assertRaises(C.NoMarketDataError):
            C.load_ohlcv('TJH8.0', ASOF)


class HidingTests(unittest.TestCase):
    def setUp(self):
        self.ctx = C.Context(VIEW, blind=True)
        C.install(self.ctx)

    def test_agents_cannot_name_the_real_symbol_only_the_alias(self):
        alias = self.ctx.alias('TJH')
        self.assertRegex(alias, r'^JSE\d{3}$')
        self.assertEqual(self.ctx.resolve(alias), 'TJH')
        with self.assertRaises(C.NoMarketDataError):
            self.ctx.resolve('TJH')
        self.assertEqual(len(set(self.ctx.alias_of.values())), len(VIEW.syms))

    def test_text_the_agents_read_has_neither_the_symbol_nor_the_name(self):
        counts = {}
        for p in VIEW.posts:
            counts[p['sym']] = counts.get(p['sym'], 0) + 1
        busiest = [s for s, _ in sorted(counts.items(), key=lambda kv: -kv[1]) if s in VIEW.syms][:8]
        for s in busiest:
            self.ctx.focus(s, '2026-11-18')
            name = VIEW.fund[s]['name']
            for method, text in C.tool_outputs(self.ctx.alias(s), '2026-11-18').items():
                self.assertEqual(C.leaks(text, s, name), [], f'{s} {method}')

    def test_live_text_does_name_the_company(self):
        live = C.Context(VIEW)
        C.install(live)
        live.focus('TJH', '2026-11-18')
        text = C.tool_outputs('TJH', '2026-11-18')
        self.assertIn('TRANSJAMAICAN', text['get_fundamentals'])
        self.assertIn('TJH', text['get_news'])

    def test_identity_is_generic_plus_the_sector(self):
        self.ctx.focus('TJH', '2025-06-30')
        profile = C.get_company_profile(self.ctx.alias('TJH'))
        self.assertIn('Jamaica Stock Exchange', profile['longName'])
        self.assertNotIn('TRANSJAMAICAN', json.dumps(profile))


class WiringTests(unittest.TestCase):
    def setUp(self):
        self.ctx = C.Context(VIEW)
        C.install(self.ctx)
        self.ctx.focus('TJH', ASOF)

    def test_every_routed_method_has_a_jse_vendor_and_a_run_routes_every_category_to_it(self):
        from tradingagents.dataflows import router
        for info in router.TOOLS_CATEGORIES.values():
            for method in info['tools']:
                self.assertIn('jse', router.VENDOR_METHODS[method], method)
        cfg = C.config('live', 'm')
        self.assertEqual(cfg['data_vendors'], {category: 'jse' for category in router.TOOLS_CATEGORIES})
        self.assertEqual(cfg['benchmark_ticker'], C.MKT)
        self.assertEqual(cfg['max_debate_rounds'], 1)

    def test_the_names_yahoo_code_imported_directly_serve_jse_data(self):
        from tradingagents.agents import context as agent_context
        from tradingagents.dataflows.vendors.yahoo import market, snapshot
        from tradingagents.memory import settlement
        self.assertIs(market.load_ohlcv, C.load_ohlcv)
        self.assertIs(snapshot.load_ohlcv, C.load_ohlcv)
        self.assertIs(market.get_closes, C.get_closes)
        self.assertIs(settlement.get_closes, C.get_closes)
        self.assertIs(agent_context.get_company_profile, C.get_company_profile)

    def test_a_run_reaches_every_tool_without_any_network(self):
        from tradingagents.agents import tools
        from tradingagents.dataflows.config import run_config
        from tradingagents.dataflows.vendors.yahoo.snapshot import build_verified_market_snapshot
        from tradingagents.agents.context import resolve_instrument_identity, _identity
        _identity.cache_clear()
        raw = json.load(open(ROOT / 'data' / 'jse_history.json'))['dates']
        last_day = max(d for d in raw if d <= ASOF)
        calls = [
            (tools.get_stock_data, {'symbol': 'TJH', 'start_date': '2025-06-01', 'end_date': ASOF, 'trade_date': ASOF}),
            (tools.get_indicators, {'symbol': 'TJH', 'indicator': 'rsi', 'curr_date': ASOF, 'look_back_days': 5, 'trade_date': ASOF}),
            (tools.get_verified_market_snapshot, {'symbol': 'TJH', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_fundamentals, {'ticker': 'TJH', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_balance_sheet, {'ticker': 'TJH', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_cashflow, {'ticker': 'TJH', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_income_statement, {'ticker': 'TJH', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_news, {'ticker': 'TJH', 'start_date': '2025-05-01', 'end_date': ASOF, 'trade_date': ASOF}),
            (tools.get_global_news, {'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_insider_transactions, {'ticker': 'TJH', 'trade_date': ASOF}),
            (tools.get_macro_indicators, {'indicator': 'usd_jmd', 'curr_date': ASOF, 'trade_date': ASOF}),
            (tools.get_prediction_markets, {'topic': 'Fed', 'trade_date': ASOF}),
        ]
        with mock.patch('socket.getaddrinfo', side_effect=AssertionError('network used')), \
                mock.patch('socket.socket.connect', side_effect=AssertionError('network used')), run_config(C.config('live', 'm')):
            result = {t.name: t.invoke(args) for t, args in calls}
            identity = resolve_instrument_identity('TJH')
            snapshot = build_verified_market_snapshot('TJH', ASOF)
        for name, text in result.items():
            self.assertIsInstance(text, str, name)
            self.assertNotRegex(text, r'^(NO_DATA_AVAILABLE|DATA_UNAVAILABLE)', name)
        self.assertEqual(identity['company_name'], 'TRANSJAMAICAN HIGHWAY LIMITED')
        self.assertEqual(identity['exchange'], 'Jamaica Stock Exchange')
        self.assertIn(f'{raw[last_day]["TJH"][0]}', snapshot)
        self.assertIn(f'| {last_day} |', snapshot)

    def test_settlement_scores_a_decision_against_the_jse_market(self):
        from tradingagents.memory.settlement import fetch_returns
        with mock.patch('socket.getaddrinfo', side_effect=AssertionError('network used')):
            raw, alpha, days, resolved = fetch_returns('TJH', '2025-06-30', 5, benchmark=C.MKT)
        closes = VIEW.frame('TJH', '2026-01-01').set_index('Date').Close
        entry = closes[closes.index > '2025-06-30']
        self.assertAlmostEqual(raw, entry.iloc[5] / entry.iloc[0] - 1)
        market = VIEW.market.set_index('Date').Close
        self.assertAlmostEqual(alpha, raw - (market.asof(entry.index[5]) / market.asof(entry.index[0]) - 1))
        self.assertEqual((days, resolved), (5, str(entry.index[5].date())))

    def test_every_jse_symbol_survives_trading_agents_symbol_rules(self):
        from tradingagents.dataflows.symbols import normalize_symbol, safe_ticker_component
        context = C.Context(VIEW, blind=True)
        for s in VIEW.syms + list(context.sym_of) + [C.MKT]:
            self.assertEqual(normalize_symbol(s), s)
            self.assertEqual(safe_ticker_component(s), s)

    def test_prediction_markets_say_they_do_not_apply(self):
        self.assertIn('not applicable to the Jamaica Stock Exchange', C.prediction_markets('anything'))

    def test_an_unknown_indicator_lists_what_exists(self):
        self.assertIn('usd_jmd', C.macro_indicators('cpi', ASOF))


class CommitteeBacktestTests(unittest.TestCase):
    def test_review_dates_are_three_grid_steps_apart_and_top_ten_ranked(self):
        index = pd.bdate_range('2024-01-01', periods=700)
        days = {str(index[i].date()): {f'S{j}': [50, j] for j in range(15)} | {'OFF': [10, 0]} for i in range(100, 640, 21)}
        plan = C.plan_cases(days, index)
        dates = [d for d, _, _ in plan]
        self.assertEqual(dates, sorted(dates))
        self.assertEqual([t for _, t, _ in plan], [index.get_loc(pd.Timestamp(d)) for d in dates])
        self.assertTrue(all(b - a == 63 for a, b in zip([t for _, t, _ in plan], [t for _, t, _ in plan][1:])))
        self.assertTrue(all(t < len(index) - C.H - 2 for _, t, _ in plan))
        self.assertEqual([s for s, _ in plan[0][2]], [f'S{j}' for j in range(1, 11)])

    def rows(self, effect, seed=1, rank_driven=False):
        rng = np.random.default_rng(seed)
        out = []
        for d in pd.bdate_range('2024-01-01', periods=40, freq='63B'):
            for rank in range(1, 11):
                score = 10 - rank + rng.normal(0, 1.5) if rank_driven else rng.normal(0, 2)
                rating = 'Buy' if score > 3 else 'Overweight' if score > 1 else 'Hold' if score > -1 else 'Underweight' if score > -3 else 'Sell'
                excess = (-0.01 * rank if rank_driven else effect * score / 10) + rng.normal(0, 0.05)
                out.append({'date': str(d.date()), 'rating': rating, 'excess': excess, 'edgeRank': rank})
        return out

    def test_ratings_that_foresee_the_market_are_an_edge(self):
        t = C.summarize(self.rows(0.2))['tests']
        self.assertEqual(t['spread63']['verdict'], 'edge')
        self.assertEqual(t['withinDates63']['verdict'], 'edge')
        self.assertEqual(t['beyondEdge63']['verdict'], 'edge')

    def test_ratings_unrelated_to_returns_are_no_reliable_edge(self):
        t = C.summarize(self.rows(0.0))['tests']
        self.assertEqual({v['verdict'] for v in t.values()}, {'no reliable edge'})

    def test_ratings_that_only_repeat_edge_add_nothing_beyond_it(self):
        t = C.summarize(self.rows(0.0, rank_driven=True))['tests']
        self.assertEqual(t['spread63']['verdict'], 'edge')
        self.assertEqual(t['beyondEdge63']['verdict'], 'no reliable edge')

    def test_summary_counts_cases_per_rating(self):
        s = C.summarize(self.rows(0.2))
        self.assertEqual(s['cases'], 400)
        self.assertEqual(sum(v['n'] for v in s['ratings'].values()), 400)

    def test_every_summary_test_counts_toward_the_registry(self):
        tests = C.summarize(self.rows(0.2))['tests']
        ids = {r['id']: r for r in test_registry._ideas({'rating_spread': tests}, 'committee')}
        self.assertEqual(set(ids), {f'committee/rating_spread/{k}' for k in tests})
        self.assertEqual({r['hold'] for r in ids.values()}, {63})
        self.assertFalse(any(r['holdAssumed'] for r in ids.values()))

    def test_a_rating_nobody_could_read_is_counted_apart_from_the_five(self):
        rows = self.rows(0.2)
        rows[0]['rating'] = 'REVIEW'
        s = C.summarize(rows)
        self.assertEqual(s['ratings']['REVIEW']['n'], 1)


class BudgetAndKeyTests(unittest.TestCase):
    def test_a_run_will_not_start_once_the_key_has_spent_the_budget(self):
        budget = C.Budget('k', 4.5)
        with mock.patch.object(C.Budget, 'usage', return_value=4.5), self.assertRaisesRegex(SystemExit, 'budget reached'):
            budget.start()
        with mock.patch.object(C.Budget, 'usage', return_value=4.49):
            self.assertEqual(budget.start(), 4.49)

    def test_the_key_comes_from_the_environment_or_the_config_file(self):
        import os
        import tempfile
        with tempfile.TemporaryDirectory() as home:
            (Path(home) / '.config' / 'openrouter').mkdir(parents=True)
            (Path(home) / '.config' / 'openrouter' / '.env').write_text('OTHER=1\nOPENROUTER_API_KEY="sk-or-test"\n', encoding='utf-8')
            with mock.patch.dict(os.environ, {}, clear=False), mock.patch.object(Path, 'home', return_value=Path(home)):
                os.environ.pop('OPENROUTER_API_KEY', None)
                self.assertEqual(C.load_key(), 'sk-or-test')
                os.environ['OPENROUTER_API_KEY'] = 'from-env'
                self.assertEqual(C.load_key(), 'from-env')

    def test_no_openrouter_key_is_tracked_in_the_repo(self):
        files = subprocess.run(['git', 'ls-files'], cwd=ROOT, capture_output=True, text=True, check=True).stdout.split('\n')
        scanned = [f for f in files if f and not f.startswith(('data/', 'android/', 'www/vendor')) and f.endswith(('.py', '.md', '.yml', '.json', '.js', '.mjs', '.html', '.txt'))]
        self.assertGreater(len(scanned), 20)
        for f in scanned:
            self.assertNotRegex((ROOT / f).read_text(encoding='utf-8', errors='ignore'), r'sk-or-v1-[0-9a-f]{20}', f)

    def test_lookups_of_the_default_data_hosts_are_refused_and_counted(self):
        import socket
        with C.Blocked() as blocked:
            for host in ('query1.finance.yahoo.com', 'data.sec.gov', 'api.stlouisfed.org', 'gamma-api.polymarket.com'):
                with self.assertRaises(OSError):
                    socket.getaddrinfo(host, 443)
            self.assertEqual(len(blocked.attempts), 4)


if __name__ == '__main__':
    unittest.main()
