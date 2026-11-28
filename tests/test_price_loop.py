import sys

import pandas as pd

sys.path.insert(0, 'scripts')
import events
import price_loop


def test_dividend_counts_only_if_announced_by_the_origin_and_ex_inside_the_window(monkeypatch):
    divs = [
        {'kind': 'dividend', 'sym': 'AAA', 'date': '2024-01-05', 'ex': '2024-01-20', 'amt': 0.5, 'cur': 'JMD'},  # counted
        {'kind': 'dividend', 'sym': 'AAA', 'date': '2024-01-15', 'ex': '2024-01-25', 'amt': 9.0, 'cur': 'JMD'},  # announced later
        {'kind': 'dividend', 'sym': 'AAA', 'date': '2024-01-05', 'ex': '2024-03-01', 'amt': 9.0, 'cur': 'JMD'},  # ex after window
    ]
    monkeypatch.setattr(events, 'archive_events', lambda: divs)
    df = pd.DataFrame({'sym': ['AAA'], 'date': ['2024-01-10'], 'c0': [10.0], 'known21': ['2024-02-09'], 'known63': ['2024-02-09']})
    out = price_loop.add_dividend_yield(df)
    assert out['divy21'].iloc[0] == 0.05, 'only the dividend announced by the origin and ex inside the window counts'
