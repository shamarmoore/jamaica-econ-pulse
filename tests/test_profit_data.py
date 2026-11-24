import json
import os
from pathlib import Path
from unittest import mock
import sys
import tempfile
import unittest

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
os.chdir(ROOT)
import balance  # noqa: E402
import tslib  # noqa: E402

TJH_Q3_2026 = 38_136_000 - 24_857_000   # nine-month profit minus six-month profit, US$, from TJH's own statements


def first_filings():
    """{(sym, period end, months): day those statements were first published}, over every checked reading. A group's
    consolidated statements win over a company-only set filed under the same symbol."""
    first = {}
    for r in json.load(open('data/financials.json'))['reports'].values():
        if r.get('ok') and r.get('period_end') and r.get('months'):
            k, rank = (r['sym'], r['period_end'], r['months']), (not r.get('consolidated'), r['pub'])
            first[k] = min(first.get(k, rank), rank)
    return {k: pub for k, (_, pub) in first.items()}


def counted(f, fy, qi):
    """(day, profit) of quarter qi (0-3) of financial year fy when it is the company's only quarter, or None if it never
    counts."""
    year = (list(f.get('quarters', {}).get(str(fy), [])) + [0] * 4)[:4]
    ev = tslib._quarter_events(dict(f, quarters={str(fy): [v if i == qi else 0 for i, v in enumerate(year)]}))
    return ev[0] if ev else None


class ProfitDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        close, _ = tslib.load_history()
        cls.px = close.ffill()
        cls.F = tslib.load_fundamentals()
        with mock.patch.dict(os.environ, {'FILL_OFF': '1'}):
            cls.printed = tslib.load_fundamentals()

    def latest(self, sym):
        return tslib.fundamental_series(self.F[sym], self.px[sym], self.px.index).iloc[-1]

    def test_us_dollar_profit_of_a_company_paying_jamaican_dividends_is_converted(self):
        self.assertTrue(0.03 <= self.latest('TJH')['ey'] <= 0.10, self.latest('TJH')['ey'])

    def test_jamaican_dividends_are_not_converted_with_the_profit(self):
        self.assertTrue(0.01 <= self.latest('TJH')['dy'] <= 0.08, self.latest('TJH')['dy'])

    def test_a_share_quoted_in_us_dollars_keeps_its_profit_unconverted(self):
        self.assertTrue(-0.2 < self.latest('PBS')['ey'] < 0.2, self.latest('PBS')['ey'])

    def test_a_filed_quarter_missing_from_the_jse_table_is_filled_from_the_statements(self):
        self.assertAlmostEqual(self.F['TJH']['quarters']['2026'][2], TJH_Q3_2026, delta=1_000)

    def test_the_group_report_beats_a_subsidiary_report_filed_under_the_same_symbol(self):
        # Mayberry Investments' own statements (a J$113,406,000 loss) are filed under MGL next to Mayberry Group's
        # consolidated ones, whose owners' share of the first-quarter loss is J$807,389,000
        self.assertEqual(self.F['MGL']['quarters']['2024'][0], -807_389_000)

    def test_the_companys_own_fourth_quarter_beats_the_table(self):
        # TJH's statements give US$36,677,000 for 2025 and 28,066,000 for its first nine months; the table's 9,836,000
        # rests on a year total that no audited report or announcement supports
        self.assertEqual(self.F['TJH']['quarters']['2025'][3], 36_677_000 - 28_066_000)

    def test_a_quarter_written_in_the_wrong_currency_is_taken_from_the_statements(self):
        # the table shows 1,198,577,000 (J$) for MJE's third quarter of 2026; its US$ statements give a nine-month loss
        # of 70,000 after a six-month loss of 7,698,000
        self.assertEqual(self.F['MJE']['quarters']['2026'][2], -70_000 - -7_698_000)

    def test_a_misprinted_quarter_and_the_fourth_quarter_derived_from_it_are_taken_from_the_statements(self):
        # the table's second quarter of 2025 is ten times the statements' figure and its fourth quarter is the year
        # less that wrong quarter; US$, owners' share
        self.assertEqual(self.F['MPCCEL']['quarters']['2025'][1], -981_692 - -60_394)
        self.assertEqual(self.F['MPCCEL']['quarters']['2025'][3], -1_308_184 - -959_826)

    def test_a_quarter_from_statements_in_two_currencies_keeps_the_table_figure(self):
        # ASBH's three months to March 2025 are in TT$ and its six months to June in US$: their difference means nothing.
        # The table's figure stays, scaled to the owners' share of the year (US$9,669,000 of 10,969,000)
        self.assertAlmostEqual(self.F['ASBH']['quarters']['2025'][1], 2_752_000 * 9_669_000 / 10_969_000, delta=1)

    def test_quarters_are_the_owners_share_of_profit(self):
        # PROVEN's owners' share of profit, US$, years to March: 3, 6 and 9 months to December 2025, then 3 and 6
        # months to September 2026. Minority holders take about an eighth of the total
        owners = [2_341_000 - -2_647_767, 1_446_000 - 2_341_000, 8_232_111, 6_841_184 - 8_232_111]
        self.assertEqual([v for _, v in tslib._quarter_events(self.F['PROVEN'])[-4:]], owners)

    def test_a_fourth_quarter_derived_from_the_year_comes_from_the_tables_own_quarters(self):
        # PJAM's statements stop at nine months for 2025, so its fourth quarter is the table's year less the table's
        # first three quarters, all total profit, then scaled by the nine months' owners' share. Taking the statements'
        # owners' share of those three instead would leave the minorities' nine months inside the fourth quarter
        q4 = 8_089_522_000 - (2_110_711_000 + 2_482_475_000 + 2_227_418_000)
        self.assertAlmostEqual(counted(self.F['PJAM'], 2025, 3)[1], q4 * 5_407_753_000 / 6_820_603_000, delta=1)

    def test_a_table_quarter_the_statements_cannot_replace_is_scaled_to_the_owners_share(self):
        # EPLY's 2025 statements stop at nine months (its year-end reading failed its checks), so its fourth quarter is
        # the table's total profit, of which the nine months say the owners kept 29%
        self.assertAlmostEqual(self.F['EPLY']['quarters']['2025'][3], 497_021_000 * 348_977_000 / 1_219_953_000, delta=1)

    def test_a_table_quarter_stays_as_printed_when_the_minorities_part_outweighs_the_groups_profit(self):
        # no company's year does this today; a group profit near zero would make the owners' share several times it
        def reading(sym, total, owners):
            return {'sym': sym, 'period_end': '2025-03-31', 'months': 3, 'currency': 'JMD', 'consolidated': True,
                    'pub': '2025-05-01', 'first_pub': '2025-05-01', 'net_profit': total, 'net_profit_attributable_to_owners': owners}
        table = {s: {'quarters': {'2025': [100, 200, 300, 400]}, 'fye': {'month': 12}} for s in ('ZZA', 'ZZB')}
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, 'jse_fundamentals.json')
            json.dump({'stocks': table}, open(path, 'w'))
            with mock.patch.object(balance, 'readings', return_value=[reading('ZZA', 10, 50), reading('ZZB', 10, 5)]):
                F = tslib.load_fundamentals(path)
        self.assertEqual(F['ZZA']['quarters']['2025'], [50, 200, 300, 400])
        self.assertEqual(F['ZZB']['quarters']['2025'], [5, 100, 150, 200])

    def test_a_company_filing_one_set_of_statements_fills_across_a_changed_consolidated_flag(self):
        # IPCL files one set of statements; its reader marked the three months to May 2026 company-only and the six
        # months to August consolidated. Only MGL files both kinds for one period
        self.assertEqual(self.F['IPCL']['quarters']['2027'][1], 59_446_407 - 32_776_516)

    def test_the_earnings_yield_uses_the_owners_share_of_profit(self):
        # on 18 November 2026 PROVEN's counted year is its nine months to December 2025 and its three months to June
        # 2026: US$1,446,000 and 8,232,111 for the owners. Its shares are quoted in J$
        day, f = pd.Timestamp('2026-11-18'), self.F['PROVEN']
        ey = tslib.fundamental_series(f, self.px['PROVEN'], self.px.index).loc[day, 'ey']
        mcap = self.px['PROVEN'][day] * f['shares']
        self.assertAlmostEqual(ey, (1_446_000 + 8_232_111) * tslib.FX_TO_JMD['USD'] / mcap, places=6)

    def test_a_filled_quarter_is_dated_like_the_same_quarter_printed_in_the_table(self):
        with mock.patch.dict(os.environ, {'FILL_OFF': '1'}):
            printed = tslib.load_fundamentals()['TJH']
        printed['quarters']['2026'][2] = TJH_Q3_2026
        self.assertEqual([d for d, _ in tslib._quarter_events(self.F['TJH'])], [d for d, _ in tslib._quarter_events(printed)])

    def test_no_quarter_counts_before_its_statements_were_filed(self):
        early = []
        for (s, end, months), pub in first_filings().items():
            f = self.F.get(s)
            fy, month = balance.fy_end(end, months)
            if not f or month != ((f.get('fye') or {}).get('month') or 12):
                continue   # a report on another year-end grid is not one of this company's table quarters
            q = counted(f, fy, months // 3 - 1)
            if q and q[0] < pd.Timestamp(pub):
                early.append((s, end, months, pub, str(q[0].date())))
        self.assertEqual(early, [])

    def test_a_filed_quarter_counts_from_its_filing_not_the_companys_usual_delay(self):
        # TJH filed its third quarter of 2026 on 12 November 2026. One slow filing gave it a 120-day usual delay, which
        # held the quarter back to 28 January 2027
        self.assertEqual(counted(self.F['TJH'], 2026, 2)[0], pd.Timestamp('2026-11-12'))

    def test_every_filed_quarter_counts_from_the_day_it_was_filed(self):
        off = []
        for (s, end, months), pub in first_filings().items():
            f = self.F.get(s)
            fy, month = balance.fy_end(end, months)
            if not f or month != ((f.get('fye') or {}).get('month') or 12):
                continue
            q = counted(f, fy, months // 3 - 1)
            if q and q[0] != pd.Timestamp(pub):
                off.append((s, end, months, pub, str(q[0].date())))
        self.assertEqual(off, [])

    def test_a_late_filer_counts_from_the_day_it_filed(self):
        # LEARN filed its second quarter to 30 June 2025 (J$445,292 profit for the owners) on 4 December 2025, 157 days later
        self.assertEqual([d for d, v in tslib._quarter_events(self.F['LEARN']) if v == 445_292], [pd.Timestamp('2025-12-04')])

    def test_a_quarter_without_read_statements_waits_the_companys_own_usual_delay(self):
        # LEARN's year-end month comes from its JSE page. Its slowest read quarterly report took 157 days, so
        # data/fiscal_years.json gives it the 120-day cap, not the 60-day default
        self.assertEqual([d for d, v in tslib._quarter_events(self.F['LEARN']) if v == 9_536_429], [pd.Timestamp('2022-06-30') + pd.Timedelta(days=120)])

    def test_a_usual_delay_under_60_days_does_not_shorten_the_wait(self):
        # GHL's saved usual delay is 50 days (data/fiscal_years.json)
        self.assertEqual([d for d, v in tslib._quarter_events(self.F['GHL']) if v == 256_336_000], [pd.Timestamp('2022-06-30') + pd.Timedelta(days=60)])

    def test_quarters_count_one_a_day_in_quarter_order(self):
        # callers take the last four counted quarters as a year and the fourth one back as the same quarter a year earlier
        bad = []
        for s, f in self.F.items():
            alone = [q for q in (counted(f, fy, qi) for fy in sorted(f.get('quarters', {})) for qi in range(4)) if q]
            ev = tslib._quarter_events(f)
            if ([v for _, v in ev] != [v for _, v in alone] or any(b <= a for (a, _), (b, _) in zip(ev, ev[1:]))
                    or any(d < a for (d, _), (a, _) in zip(ev, alone))):
                bad.append(s)
        self.assertEqual(bad, [])


if __name__ == '__main__':
    unittest.main()
