"""Balance-sheet figures read from the PDF reports (data/financials.json, made by read_reports.py), turned into
point-in-time series for back-tests and into plain facts for the app. Only readings that passed their checks are used,
and a figure counts only from the day its report was published.

  readings()            -> usable readings, oldest first
  fiscal_months()       -> {sym: month the financial year ends}, from the reports themselves
  frames(fs)            -> dict of DataFrames (index fs.idx, columns fs.syms) for factor tests
  latest_facts(fs, T)   -> {sym: facts for the app}
Usage: python scripts/balance.py           (summary)
       python scripts/balance.py fiscal    (write data/fiscal_years.json — changes how quarterly profits are dated)"""
import json, re, sys
from collections import Counter

import numpy as np
import pandas as pd

FIN = re.compile(r'BANK|FINANC|INSUR|ASSURANCE|INVEST|CAPITAL|SAGICOR|SCOTIA|\bNCB\b|JMMB|BARITA|MAYBERRY|PROVEN|VICTORIA MUTUAL|\bVM\b|GUARDIAN|IRONROCK|GENERAL ACCIDENT|QWI|SYGNUS|EPPLEY|PORTLAND JSX|FIRST ROCK|ISP |MFS |STOCK EXCHANGE|SELECT FUNDS|KINTYRE|\bCREDIT\b|EQUITIES', re.I)
FLOWS = ('operating_cash_flow', 'net_profit', 'net_profit_attributable_to_owners', 'revenue', 'capital_expenditure')
STALE_DAYS = 400


def _load(p, d):
    try:
        return json.load(open(p))
    except Exception:
        return d


def fy_end(period_end, months):
    y, m = int(period_end[:4]), int(period_end[5:7]) + (12 - months)
    return (y + (m - 1) // 12, (m - 1) % 12 + 1)


_BBD = None
def _bbd_payers():
    """Companies that declare their dividends in Barbados dollars (so their statements are in Barbados dollars too)."""
    global _BBD
    if _BBD is None:
        try:
            from tslib import load_fundamentals
            _BBD = {s for s, f in load_fundamentals().items() if any(d.get('cur') == 'BBD' for d in (f.get('dividends') or [])[-4:])}
        except Exception:
            _BBD = set()
    return _BBD


def readings(only_ok=True):
    R = [r for r in _load('data/financials.json', {}).get('reports', {}).values() if r.get('period_end') and r.get('months') and (r.get('ok') or not only_ok)]
    # one reading per company and period: the latest publication wins (revised or audited versions)
    best = {}
    bbd = _bbd_payers()
    for r in sorted(R, key=lambda r: r['pub']):
        if r['sym'] in bbd and r.get('currency') == 'USD':
            r['currency'] = 'BBD'    # early readings only knew J$, US$ and TT$: a plain "$" on a Barbados fund's report was taken for US$
        best[(r['sym'], r['period_end'], r['months'])] = r
    return sorted(best.values(), key=lambda r: r['pub'])


def fiscal_months():
    by = {}
    for r in readings(only_ok=False):
        if r.get('balances'):
            by.setdefault(r['sym'], []).append(fy_end(r['period_end'], r['months'])[1])
    return {s: Counter(v).most_common(1)[0][0] for s, v in by.items() if Counter(v).most_common(1)[0][1] >= max(1, len(v) * 0.6)}


def reporting_lags():
    """Days each company usually takes to publish a quarterly report: its slowest observed quarter plus a 3-day margin,
    kept between 50 and 120 days. Companies with no readings fall back to the default in tslib."""
    by = {}
    for r in readings(only_ok=False):
        if r.get('balances') and r['months'] != 12:
            by.setdefault(r['sym'], []).append((pd.Timestamp(r['pub']) - pd.Timestamp(r['period_end'])).days)
    return {s: int(min(120, max(50, max(v) + 3))) for s, v in by.items()}


FX = {'JMD': 1.0, 'USD': 157.0, 'TTD': 23.2, 'BBD': 78.5}


def bs_fx(cur, eq, mcap):
    """J$ per unit of the report's currency — unless the share itself is quoted in that currency (JSE US$ market),
    which shows up as an absurdly small book-to-market ratio after converting."""
    f = FX.get(cur or 'JMD', 1.0)
    if f == 1.0 or not eq or not mcap or eq <= 0 or mcap <= 0:
        return f
    return f if eq * f / mcap <= 60 else 1.0


def is_financial(sym, fund=None):
    name = ((fund or {}).get(sym) or {}).get('name') or ''
    return bool(FIN.search(name))


def with_ttm(R):
    """Add trailing-12-month flows to each reading: this year-to-date + last full year − the same year-to-date a year
    ago; when those earlier reports aren't available, the year-to-date figure scaled to 12 months."""
    key = {}
    for r in R:
        fy = fy_end(r['period_end'], r['months'])[0]
        key[(r['sym'], fy, r['months'])] = r
    for r in R:
        fy = fy_end(r['period_end'], r['months'])[0]; m = r['months']
        full, same = key.get((r['sym'], fy - 1, 12)), key.get((r['sym'], fy - 1, m))
        for k in FLOWS:
            v = r.get(k)
            if v is None:
                r['ttm_' + k] = None
            elif m == 12:
                r['ttm_' + k] = v
            elif full and same and full.get(k) is not None and same.get(k) is not None:
                r['ttm_' + k] = v + full[k] - same[k]
            else:
                r['ttm_' + k] = v * 12 / m
    return R


def frames(fs):
    """Point-in-time factor frames. Ratios to market value use the same currency rule as the earnings yield."""
    idx, syms = fs.idx, fs.syms
    R = with_ttm(readings())
    cols = {k: pd.DataFrame(np.nan, index=idx, columns=syms) for k in ('eq', 'assets', 'debt', 'cash', 'ocf', 'np', 'rev', 'capex', 'age')}
    for r in R:
        s = r['sym']
        if s not in cols['eq'].columns:
            continue
        t = int(idx.searchsorted(pd.Timestamp(r['pub']), side='left'))   # usable from the publication day's close
        if t >= len(idx):
            continue
        eq = r.get('equity_attributable_to_owners') or r.get('total_equity')
        vals = {'eq': eq, 'assets': r.get('total_assets'), 'debt': r.get('borrowings'), 'cash': r.get('cash_and_equivalents'), 'ocf': r.get('ttm_operating_cash_flow'),
                'np': r.get('ttm_net_profit_attributable_to_owners') if r.get('ttm_net_profit_attributable_to_owners') is not None else r.get('ttm_net_profit'),
                'rev': r.get('ttm_revenue'), 'capex': r.get('ttm_capital_expenditure')}
        for k, v in vals.items():
            cols[k].iloc[t:, cols[k].columns.get_loc(s)] = np.nan if v is None else v
        cols['age'].iloc[t:, cols['age'].columns.get_loc(s)] = t
    age = pd.DataFrame(np.arange(len(idx))[:, None] - cols['age'].values, index=idx, columns=syms)
    fresh = age <= STALE_DAYS * 5 / 7
    c = {k: v.where(fresh) for k, v in cols.items() if k != 'age'}
    mcap = fs.MCAP
    last = {}
    for r in R:
        last[r['sym']] = r
    mc_now = mcap.ffill().iloc[-1]
    fx = pd.Series({s: bs_fx(last[s]['currency'], last[s].get('equity_attributable_to_owners') or last[s].get('total_equity'), mc_now.get(s)) if s in last else 1.0 for s in syms})
    fin_cols = [s for s in syms if is_financial(s, fs.FUND)]

    def nonfin(df):
        df = df.copy(); df[fin_cols] = np.nan
        return df
    eqpos = c['eq'].where(c['eq'] > 0)
    out = {
        'bp': (eqpos * fx / mcap).clip(0, 10),                                   # book value ÷ market value
        'roe': (c['np'] / eqpos).clip(-1, 1.5),                                  # profit ÷ shareholders' funds
        'lowdebt': nonfin((-(c['debt'] / eqpos)).clip(-10, 0)),    # less debt per $ of shareholders' funds
        'netcash': nonfin(((c['cash'] - c['debt']) * fx / mcap).clip(-5, 5)),
        'cashq': nonfin(((c['ocf'] - c['np']) / c['assets']).clip(-0.5, 0.5)),   # profit backed by cash
        'ocfy': nonfin((c['ocf'] * fx / mcap).clip(-1, 1)),        # operating cash ÷ market value
        'fcfy': nonfin(((c['ocf'] - c['capex'].fillna(0)) * fx / mcap).clip(-1, 1)),
        'margin': (c['np'] / c['rev'].where(c['rev'] > 0)).clip(-1, 1),
        'eq_assets': nonfin((eqpos / c['assets']).clip(0, 1)),
    }
    return out


def latest_facts(fs, T=None):
    """Plain facts from each company's latest usable report, for the stock page."""
    T = fs.N - 1 if T is None else T
    R = with_ttm(readings())
    last = {}
    for r in R:
        last[r['sym']] = r
    out = {}
    for s, r in last.items():
        if s not in fs.P.columns:
            continue
        px = float(fs.P[s].iloc[T]); sh = fs.shares.get(s)
        eq = r.get('equity_attributable_to_owners') or r.get('total_equity')
        fx = bs_fx(r['currency'], eq, px * sh if sh and px > 0 else None)
        debt, cash, A = r.get('borrowings'), r.get('cash_and_equivalents'), r.get('total_assets')
        npf = r.get('ttm_net_profit_attributable_to_owners') if r.get('ttm_net_profit_attributable_to_owners') is not None else r.get('ttm_net_profit')
        ocf, rev = r.get('ttm_operating_cash_flow'), r.get('ttm_revenue')
        fin = is_financial(s, fs.FUND)
        f = {'period': r['period_end'], 'pub': r['pub'], 'cur': r['currency'], 'fin': fin, 'src': r.get('src'), 'checked': r.get('profitMatchesJSE') is True,
             'equity': eq, 'debt': debt, 'cash': cash, 'assets': A}
        rnd = lambda v, n=2: None if v is None or not np.isfinite(v) else round(float(v), n)
        if eq and eq > 0 and sh and px > 0:
            f['bvps'] = rnd(eq * fx / sh, 2); f['pb'] = rnd(px * sh / (eq * fx), 2)
        if eq and eq > 0:
            f['de'] = rnd(debt / eq, 2) if debt is not None else None
            f['roe'] = rnd(npf / eq * 100, 1) if npf is not None else None
            f['eqAssets'] = rnd(eq / A * 100, 0) if A else None
        if npf and npf > 0 and ocf is not None:
            f['cashPerProfit'] = rnd(ocf / npf, 2)
        if rev and rev > 0 and npf is not None:
            f['margin'] = rnd(npf / rev * 100, 1)
        flags = []
        if eq is not None and eq <= 0:
            flags.append('Liabilities exceed assets (negative shareholders’ funds)')
        if not fin and f.get('de') is not None and f['de'] > 1.5:
            flags.append(f"Heavy debt: {f['de']}× shareholders’ funds")
        if not fin and npf and npf > 0 and ocf is not None and ocf < 0.5 * npf:
            flags.append('Profit not backed by cash: operations brought in less than half the reported profit')
        f['flags'] = flags
        out[s] = f
    return out


if __name__ == '__main__':
    D = _load('data/financials.json', {})
    allr = list(D.get('reports', {}).values())
    R = readings()
    cmp_ = [r for r in allr if r.get('profitMatchesJSE') is not None]
    print(f"READINGS {len(allr)} read, {len(R)} usable ({len({r['sym'] for r in R})} companies), {len(D.get('skipped', {}))} skipped")
    print(f"  balance sheet adds up {sum(1 for r in allr if r.get('balances'))}/{len(allr)}; profit equals the JSE figure {sum(1 for r in cmp_ if r['profitMatchesJSE'])}/{len(cmp_)}")
    if R:
        lag = pd.Series([(pd.Timestamp(r['pub']) - pd.Timestamp(r['period_end'])).days for r in R])
        q = lag[[r['months'] != 12 for r in R]]; a = lag[[r['months'] == 12 for r in R]]
        print(f"  days from period end to publication: quarterly median {q.median() if len(q) else None}, 90th pct {q.quantile(0.9) if len(q) else None}; year-end median {a.median() if len(a) else None}, 90th pct {a.quantile(0.9) if len(a) else None}")
        print('  years covered', dict(sorted(Counter(r['pub'][:4] for r in R).items())))
    FM = fiscal_months()
    print('  financial year ends:', dict(sorted(Counter(FM.values()).items())), f'({len(FM)} companies)')
    if len(sys.argv) > 1 and sys.argv[1] == 'fiscal':
        LG = reporting_lags()
        json.dump({s: {'month': m, 'lag': LG.get(s)} for s, m in FM.items()}, open('data/fiscal_years.json', 'w'), separators=(',', ':'), sort_keys=True)
        print('  reporting delay used (days):', pd.Series(LG).describe()[['min', '50%', 'max']].to_dict())
        print('wrote data/fiscal_years.json')
