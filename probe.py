import subprocess, sys, time, json
def sh(c):
    r = subprocess.run(c, shell=True, capture_output=True, text=True); print('$', c, '->', r.returncode); print((r.stdout + r.stderr)[-1500:])
    return r.returncode
ok = sh('pip install -q timestral') == 0 or sh('pip install -q "git+https://github.com/mistralai/timestral"') == 0
sh('pip show timestral; pip list 2>/dev/null | grep -i -E "torch|timestral|hugging"')
import importlib
try:
    import timestral, inspect
    print('MODULE', timestral.__file__, [n for n in dir(timestral) if not n.startswith('_')])
    from timestral import TimestralForecaster
    print(inspect.signature(TimestralForecaster.forecast))
    import numpy as np
    for mid in ['mistralai/Timestral-5M', 'mistralai/Timestral-28M', 'mistralai/Timestral-123M', 'mistralai/Timestral-209M']:
        t = time.time()
        try:
            m = TimestralForecaster.from_pretrained(mid, device='cpu')
            ctx = np.random.default_rng(1).standard_normal((50, 1, 500)).cumsum(-1) + 100
            t1 = time.time(); f = m.forecast(ctx, prediction_length=63)
            print('OK', mid, 'load', round(t1 - t, 1), 's; 50 series fc', round(time.time() - t1, 2), 's', type(f).__name__, [a for a in dir(f) if not a.startswith('_')][:20])
            q = f.quantiles; print('quantiles', getattr(q, 'shape', None), 'levels', getattr(f, 'quantile_levels', getattr(m, 'quantile_levels', None)))
        except Exception as e: print('FAIL', mid, repr(e)[:300])
except Exception as e: print('IMPORT FAIL', repr(e)[:500])
