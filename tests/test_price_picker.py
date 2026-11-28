from pathlib import Path
import sys
import unittest

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
import price_picker as pp  # noqa: E402

H = 21
START = pd.Timestamp('2024-01-01')


def make_cases(n_origins, n_stocks, slot_for, seed=0):
    """Synthetic cases; slot_for(origin_index, feature) says which quantile slot the real price lands on."""
    rng = np.random.default_rng(seed)
    rows = []
    for i in range(n_origins):
        d = START + pd.Timedelta(days=10 * i)
        for s in range(n_stocks):
            f = float(rng.choice([-1.0, 1.0]))
            rec = {'date': str(d.date()), 'sym': f's{s}', 'c0': 100.0, 'traded': 0.9, 'stale': 0, 'vol60': 0.02,
                   'mom21': f, 'mom126': 0.0, 'hype': np.nan, 'health': np.nan,
                   f'known{H}': str((d + pd.Timedelta(days=H)).date())}
            rec.update({f'q{H}_{k}': 100.0 * (1.005 + 0.02 * (k - 10)) for k in range(21)})
            rec[f'act{H}'] = rec[f'q{H}_{slot_for(i, f)}']
            rows.append(rec)
    return pd.DataFrame(rows)


class PricePickerTests(unittest.TestCase):
    def test_learns_which_candidate_a_feature_points_to(self):
        df = make_cases(20, 30, lambda i, f: 4 if f < 0 else 16)
        t = pp.walk_forward(df, H, min_train=300)
        later = t[t['date'] >= START + pd.Timedelta(days=80)]
        hit = lambda m: (later[f'{m}_err'] <= later['closest_err'] + 1e-9).mean()
        self.assertGreater(hit('picker'), 0.9)
        self.assertLess(hit('middle'), 0.1)

    def test_does_not_use_outcomes_that_are_not_yet_known(self):
        switch = 8  # origins before this land on the 0.1 quantile, from it on the 0.9 quantile
        df = make_cases(36, 30, lambda i, f: 2 if i < switch else 18)
        t = pp.walk_forward(df, H, min_train=100)
        picked = lambda i: t.loc[t['date'] == START + pd.Timedelta(days=10 * i), 'picker']
        for i in (switch, switch + 1, switch + 2):  # post-switch outcomes not yet known on these dates
            self.assertTrue((picked(i) <= 5).all(), i)
        self.assertTrue((picked(35) >= 15).all())


if __name__ == '__main__':
    unittest.main()
