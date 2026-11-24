from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import next_quarter as nq  # noqa: E402
from tslib import LEVELS  # noqa: E402


def trend(contexts, h):
    """Stand-in for Timestral: the last figure plus the last step, with a band 20 wide around it."""
    out = np.zeros((len(contexts), h, len(LEVELS)))
    for i, c in enumerate(contexts):
        known = c[~np.isnan(c)]
        out[i, 0] = known[-1] + (known[-1] - known[-2]) + (LEVELS - 0.5) * 20
    return out


def company(quarters, fye=12, **extra):
    return {'quarters': quarters, 'fye': {'month': fye}, **extra}


TODAY = '2024-11-24'
GROWING = company({'2023': [100, 110, 120, 130], '2024': [140, 150, 160, 170], '2025': [180, 190]}, fye=3)


class NextQuarterTests(unittest.TestCase):
    def test_the_estimate_is_for_the_quarter_after_the_latest_one_named_by_the_companys_own_year(self):
        # a year to March: its 2025 second quarter is July to September 2024, so the next one ends in December 2024
        e = nq.estimates({'ZZ': GROWING}, trend, TODAY)['ZZ']
        self.assertEqual((e['end'], e['label']), ('2024-12-31', 'Oct–Dec 2024'))

    def test_the_estimate_is_the_forecasts_middle_with_its_10_to_90_percent_range(self):
        e = nq.estimates({'ZZ': GROWING}, trend, TODAY)['ZZ']
        self.assertEqual((e['lo'], e['mid'], e['hi']), (192, 200, 208))

    def test_the_same_quarter_a_year_earlier_comes_with_it(self):
        self.assertEqual(nq.estimates({'ZZ': GROWING}, trend, TODAY)['ZZ']['lastYear'], 160)

    def test_a_company_with_fewer_than_eight_quarters_of_figures_gets_no_estimate(self):
        short = company({'2024': [1, 2, 3, 4], '2025': [5, 6, 0, 0]})
        self.assertEqual(nq.estimates({'ZZ': short}, trend, TODAY), {})

    def test_profits_are_labelled_in_the_currency_of_the_latest_read_report(self):
        # TJH reports in US$ but pays its dividends in J$
        usd = dict(GROWING, report={'currency': 'USD'}, dividends=[{'ex': '2025-01-02', 'amt': 0.05, 'cur': 'JMD'}])
        unread = dict(GROWING, dividends=[{'ex': '2025-01-02', 'amt': 0.05, 'cur': 'USD'}])
        got = nq.estimates({'A': usd, 'B': unread, 'C': GROWING}, trend, TODAY)
        self.assertEqual([got[s]['cur'] for s in 'ABC'], ['USD', 'USD', 'JMD'])

    def test_a_company_whose_table_dates_a_quarter_after_today_gets_no_estimate(self):
        # CAR's table labels run a year ahead: its last quarter would end in December 2025, a year after today
        ahead = company({'2024': [100, 110, 120, 130], '2025': [140, 150, 160, 170]})
        self.assertEqual(nq.estimates({'CAR': ahead}, trend, TODAY), {})
        self.assertIsNone(nq.backtest({'CAR': ahead}, trend, TODAY))

    def test_the_backtest_scores_every_past_quarter_against_the_simple_guesses(self):
        # profits rise by 10 a quarter: the trend stand-in is exact, "same as last year" is 40 short every time
        bt = nq.backtest({'ZZ': GROWING}, trend, TODAY)
        self.assertEqual(bt['error']['timestral'], 0)
        self.assertGreater(bt['error']['lastYear'], bt['error']['lastQuarter'])
        self.assertEqual((bt['direction']['timestral'], bt['inRange']), (100, 100))
        self.assertEqual(bt['cases'], 2)   # only the 2025 quarters have eight quarters before them


if __name__ == '__main__':
    unittest.main()
