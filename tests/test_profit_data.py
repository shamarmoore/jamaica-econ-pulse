import json
import os
from pathlib import Path
from unittest import mock
import sys
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
    counts. A missing 4th quarter can be the year's profit minus the other three, so those stay."""
    year = (list(f.get('quarters', {}).get(str(fy), [])) + [0] * 4)[:4]
    keep = range(4) if qi == 3 and year[3] in (0, None) else [qi]
    alone = [v if i in keep else 0 for i, v in enumerate(year)]
    without = [0 if i == qi else v for i, v in enumerate(alone)]
    added = set(tslib._quarter_events(dict(f, quarters={str(fy): alone}))) - set(tslib._quarter_events(dict(f, quarters={str(fy): without}, annual={})))
    return min(added) if added else None


class ProfitDataTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        close, _ = tslib.load_history()
        cls.px = close.ffill()
        cls.F = tslib.load_fundamentals()

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
        # Mayberry Investments' own statements are filed under MGL next to Mayberry Group's consolidated ones
        self.assertEqual(self.F['MGL']['quarters']['2024'][0], -1_435_688_000)

    def test_a_table_quarter_that_disagrees_with_the_statements_is_kept(self):
        self.assertEqual(self.F['TJH']['quarters']['2025'][3], 9_836_000)

    def test_a_filled_quarter_is_dated_like_the_same_quarter_printed_in_the_table(self):
        with mock.patch.dict(os.environ, {'FILL_OFF': '1'}):
            printed = tslib.load_fundamentals()['TJH']
        printed['quarters']['2026'][2] = TJH_Q3_2026
        self.assertEqual(tslib._quarter_events(self.F['TJH']), tslib._quarter_events(printed))

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

    def test_a_late_filer_counts_from_the_day_it_filed(self):
        # LEARN filed its second quarter to 30 June 2025 (a J$523,453 profit) on 4 December 2025, 157 days later
        self.assertEqual([d for d, v in tslib._quarter_events(self.F['LEARN']) if v == 523_453], [pd.Timestamp('2025-12-04')])


if __name__ == '__main__':
    unittest.main()
