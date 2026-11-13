"""Nightly per-stock signals and market regime, each paired with what back-testing showed (data/idea_tests.json).
Used by forecast.py. Everything uses information up to the latest close only."""
import glob, json, os
import numpy as np
import pandas as pd
import factor_study as fs

P, V, R, idx, N, syms = fs.P, fs.V, fs.R, fs.idx, fs.N, fs.syms
T = N - 1
JV = V * P


def _detail():
    det = {}
    for f in sorted(glob.glob('data/detail/*.json')):
        det.update(json.load(open(f)))
    return det


def _macro():
    try:
        return json.load(open('data/macro.json'))
    except Exception:
        return {}


def sectors(IDXS, macro):
    out = {}
    if not {'Financial Index', 'Manufacturing & Distribution Index'} <= set(IDXS.columns):
        return out
    fin = IDXS['Financial Index'].pct_change(); md = IDXS['Manufacturing & Distribution Index'].pct_change()
    for s in syms:
        r = R[s].where(V[s] > 0).iloc[-500:]
        m = r.notna() & fin.iloc[-500:].notna()
        if m.sum() < 80:
            continue
        cf, cm = r[m].corr(fin.iloc[-500:][m]), r[m].corr(md.iloc[-500:][m])
        jr = IDXS['Junior Market Index'].pct_change().iloc[-500:] if 'Junior Market Index' in IDXS else None
        mn = IDXS['Index'].pct_change().iloc[-500:] if 'Index' in IDXS else None
        cj = r[m].corr(jr[m]) if jr is not None else -1; cx = r[m].corr(mn[m]) if mn is not None else -1
        out[s] = 'Financial' if cf > max(cm + 0.05, 0.12) else 'Manufacturing & Distribution' if cm > max(cf + 0.05, 0.12) \
            else 'Junior Market' if cj > max(cx + 0.05, 0.1) else 'Other'
    return out


SECT_IDX = {'Financial': 'Financial Index', 'Manufacturing & Distribution': 'Manufacturing & Distribution Index', 'Junior Market': 'Junior Market Index', 'Other': 'Index'}


def _insiders():
    try:
        import insiders as INS
        by = {}
        for e in INS.events():
            by.setdefault(e['sym'], []).append(e)
        return by
    except Exception:
        return {}


INS_BY = {}
INS_SINCE = ''


BS_FACTS = {}


def compute():
    global INS_BY, INS_SINCE, BS_FACTS
    try:
        import balance
        BS_FACTS = balance.latest_facts(fs, T)
    except Exception as e:
        print('balance-sheet facts skipped:', repr(e)[:120]); BS_FACTS = {}
    INS_BY = _insiders()
    INS_SINCE = (pd.Timestamp.today() - pd.Timedelta(days=90)).strftime('%Y-%m-%d')
    det, macro = _detail(), _macro()
    IDXS = pd.DataFrame({d: v.get('i', {}) for d, v in det.items()}).T if det else pd.DataFrame()
    if len(IDXS):
        IDXS.index = pd.to_datetime(IDXS.index); IDXS = IDXS.sort_index().reindex(idx).ffill()
    sect = sectors(IDXS, macro) if len(IDXS) else {}
    # latest bid/ask spread vs its 20-day norm
    spr_z = {}
    if det:
        days = sorted(det)[-25:]
        for s in syms:
            sp = []
            for d in days:
                b = det[d].get('b', {}).get(s)
                if b and b[0] and b[1] and b[1] >= b[0] > 0:
                    sp.append((b[1] - b[0]) / ((b[1] + b[0]) / 2))
                else:
                    sp.append(np.nan)
            sp = pd.Series(sp).dropna()
            if len(sp) >= 10 and sp.iloc[:-1].std() > 0:
                spr_z[s] = (round(float(sp.iloc[-1]) * 100, 2), round(float((sp.iloc[-1] - sp.iloc[:-1].mean()) / sp.iloc[:-1].std()), 2))
    out = {}
    vol63 = R.iloc[-63:].std()
    for s in syms:
        p = P[s]; v = V[s]
        if not (p.iloc[T] > 0):
            continue
        sig = {}
        # fair value: what the share would cost if it were priced like similar JSE companies (tested in idea_tests.py)
        px = float(p.iloc[T]); r_eq = float(fs.R_EQ.iloc[T])
        num = lambda v, d=2: None if v is None or pd.isna(v) else round(float(v), d)
        eps, ttm = fs.EPS_TYP[s].iloc[T], fs.FF['ttm'][s].iloc[T]
        fair = fs.FAIR_REL[s].iloc[T]
        if bool(fs.USD_QUOTED[s]):
            sig['intrinsic'] = {'none': 'usd'}
        elif pd.notna(fair) and fair > 0:
            ppe, plo, phi = fs.PEER_PE[s].iloc[T], fs.PEER_LO[s].iloc[T], fs.PEER_HI[s].iloc[T]
            ey = float(eps) / px
            prev = fs.FF['ttm_prev'][s].iloc[T]
            iv = {'fair': num(fair), 'lo': num(fair * plo / ppe), 'hi': num(fair * phi / ppe), 'mos': num((fair / px - 1) * 100, 1),
                  'onProfit': num(fs.FAIR_E[s].iloc[T]), 'onDividend': num(fs.FAIR_D[s].iloc[T]),
                  'eps': num(eps, 3), 'pe': num(px / eps, 1), 'peerPe': num(ppe, 1), 'peerLo': num(plo, 1), 'peerHi': num(phi, 1),
                  'dy': num(fs.DIV12[s].iloc[T] / px * 100, 1), 'peerDy': num(fs.PEER_DY.iloc[T] * 100, 1), 'peers': 'financial' if bool(fs.IS_FIN[s]) else 'other',
                  # the floor: what the profit is worth if it never grows and you want T-bill + 6% a year
                  'floor': num(float(eps) / r_eq), 'reqReturn': round(r_eq * 100, 1),
                  # growth the price needs: profit growth per year, for ever, that makes today's price return T-bill + 6%
                  'growthIn': num((r_eq - ey) / (1 + ey) * 100, 1),
                  'growthDone': num(np.clip((ttm - prev) / abs(prev), -1, 3) * 100, 0) if pd.notna(prev) and prev != 0 and pd.notna(ttm) else None}
            if px / float(eps) > 60:
                iv['thin'] = True      # profits too small to value the share on: the price rests on hopes of growth
            sig['intrinsic'] = iv
        elif pd.notna(ttm) or pd.notna(eps):
            sig['intrinsic'] = {'none': 'loss'}    # no steady profit to value it on
        # results
        ds, qy = fs.FF['days_since'][s].iloc[T], fs.FF['q_yoy'][s].iloc[T]
        if pd.notna(ds) and ds <= 63 and pd.notna(qy):
            sig['results'] = {'daysAgo': int(ds), 'yoy': round(float(qy) * 100), 'kind': 'weak' if qy < -0.25 else 'strong' if qy > 0.25 else 'mixed'}
        # breakout in the last 5 trading days (close above prior 60-day high on ≥2× 20-day volume)
        for t in range(T - 4, T + 1):
            ceiling = p.iloc[t - 60:t].max(); v20 = v.iloc[t - 20:t].mean()
            if p.iloc[t] > ceiling and v20 > 0 and v.iloc[t] >= 2 * v20:
                sig['breakout'] = {'daysAgo': int(T - t), 'volMult': round(float(v.iloc[t] / v20), 1)}
        # trading channel and position in it
        w = p.iloc[T - 120:T - 4]; sup, res = w.min(), w.max()
        if sup > 0 and 0.15 <= res / sup - 1 <= 0.8 and abs(np.log(w.iloc[-20:].mean() / w.iloc[:20].mean())) <= 0.5 * np.log(res / sup) \
                and (w <= sup * 1.04).sum() >= 3 and (w >= res * 0.96).sum() >= 3:
            sig['channel'] = {'support': round(float(sup), 2), 'resistance': round(float(res), 2), 'pos': round(float((p.iloc[T] - sup) / (res - sup)) * 100)}
        # liquidity & risk (for position sizing)
        adv = float(JV[s].iloc[-20:].mean())
        sig['liquidity'] = {'adv20': round(adv), 'tradedPct': round(float((v.iloc[-60:] > 0).mean()) * 100), 'vol63': round(float(vol63[s]) * 100, 2) if pd.notna(vol63[s]) else None,
                            'turnoverZ': round(float(fs.TURN_Z[s].iloc[T]), 2) if pd.notna(fs.TURN_Z[s].iloc[T]) else None}
        if s in spr_z:
            sig['spread'] = {'pct': spr_z[s][0], 'z': spr_z[s][1], 'chase': bool(spr_z[s][1] <= -1.5 and p.iloc[T] > p.iloc[T - 1])}
        if s in sect:
            sec = sect[s]; col = SECT_IDX.get(sec)
            rs = None
            if col in IDXS.columns and pd.notna(IDXS[col].iloc[T - 63]):
                rs = round(float((p.iloc[T] / p.iloc[T - 63] - 1) - (IDXS[col].iloc[T] / IDXS[col].iloc[T - 63] - 1)) * 100, 1)
            sig['sector'] = {'name': sec, 'rs63': rs}
        if s in BS_FACTS:
            sig['bs'] = BS_FACTS[s]
        ins = INS_BY.get(s)
        if ins:
            recent = [e for e in ins if e['date'] >= INS_SINCE and e['who'] != 'company']
            if recent:
                l = recent[-1]
                sig['insider'] = {'buys': sum(1 for e in recent if e['side'] == 'buy'), 'sells': sum(1 for e in recent if e['side'] == 'sell'),
                                  'last': {'date': l['date'], 'side': l['side'], 'who': l['who'], 'shares': l['shares']}}
        out[s] = sig
    # ---- market regime ----
    reg = {}
    tb = macro.get('tbill', {})
    if tb:
        ks = sorted(k for k, v in tb.items() if v[0] is not None)
        if len(ks) >= 4:
            now, before = tb[ks[-1]][0], tb[ks[-4]][0]
            chg = now - before
            reg['rates'] = {'tbill3m': now, 'month': ks[-1], 'chg3m': round(chg, 2), 'regime': 'rising' if chg > 0.25 else 'falling' if chg < -0.25 else 'steady'}
    fx = macro.get('fx', {})
    if len(fx) > 30:
        ks = sorted(fx)
        reg['fx'] = {'usdjmd': fx[ks[-1]], 'date': ks[-1], 'chg5d': round((fx[ks[-1]] / fx[ks[-6]] - 1) * 100, 2), 'chg20d': round((fx[ks[-1]] / fx[ks[-21]] - 1) * 100, 2)}
        reg['fx']['regime'] = 'J$ weakening fast' if reg['fx']['chg20d'] > 0.5 else 'J$ strengthening' if reg['fx']['chg20d'] < -0.5 else 'steady'
    # month-end window: trading days left in this month (weekdays, holidays ignored)
    today = idx[-1]
    left = len(pd.bdate_range(today + pd.Timedelta(days=1), (today + pd.offsets.MonthEnd(0))))
    reg['monthEnd'] = {'tradingDaysLeft': int(left), 'inWindow': left <= 2, 'earlyMonth': today.day <= 5}
    if len(IDXS):
        reg['sectors'] = {name: round(float(IDXS[col].iloc[T] / IDXS[col].iloc[T - 63] - 1) * 100, 1) for name, col in SECT_IDX.items() if col in IDXS.columns and pd.notna(IDXS[col].iloc[T - 63])}
    # how the whole market is priced, so one stock's numbers can be read in context
    try:
        pe = fs.PE_TYP.iloc[T].dropna(); ey = 1 / pe; r_eq = float(fs.R_EQ.iloc[T])
        mos = pd.Series({k: v['intrinsic']['mos'] for k, v in out.items() if (v.get('intrinsic') or {}).get('mos') is not None})
        reg['valuation'] = {'n': int(len(mos)), 'medianPe': round(float(pe.median()), 1), 'peLo': round(float(pe.quantile(0.25)), 1), 'peHi': round(float(pe.quantile(0.75)), 1),
                            'medianDy': round(float(fs.PEER_DY.iloc[T]) * 100, 1), 'reqReturn': round(r_eq * 100, 1), 'noGrowthPe': round(1 / r_eq, 1),
                            'growthIn': round(float(((r_eq - ey) / (1 + ey)).median()) * 100, 1), 'belowFair': int((mos > 0).sum()), 'below20': int((mos >= 20).sum()), 'above20': int((mos <= -20).sum()),
                            'belowFloor': int(sum(1 for v in out.values() if (v.get('intrinsic') or {}).get('floor') and v['intrinsic']['floor'] >= fs.P[next(k for k in out if out[k] is v)].iloc[T]))}
    except Exception as e:
        print('valuation summary skipped:', repr(e)[:150])
    return out, reg, sect
