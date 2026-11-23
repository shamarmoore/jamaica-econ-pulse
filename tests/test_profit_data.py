import os
from pathlib import Path
from unittest import mock
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
os.chdir(ROOT)
import tslib  # noqa: E402

TJH_Q3_2026 = 38_136_000 - 24_857_000   # nine-month profit minus six-month profit, US$, from TJH's own statements


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


if __name__ == '__main__':
    unittest.main()
