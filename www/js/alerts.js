// Notifications: hands the phone's background check what it needs (read-only GitHub token, the symbols and review
// dates of your positions, which alert kinds are on). The check itself is native (AlertsWorker) so it runs with the
// app closed. Position sizes and prices never leave the WebView's storage.
const KEY = 'ep_alerts_v1';
const defaults = { enabled: false, sell: true, review: true, dividend: true, setup: true, news: true };
export const ALERT_KINDS = [
  ['sell', 'Sell signals', 'Weak results on a stock you hold, a holding slipping out of the Edge top 20, a suspension'],
  ['review', '3-month reviews', 'On the day a position’s review is due, with the keep-or-sell answer from the tested rule'],
  ['dividend', 'Dividend buy-by dates', 'High-yield dividends with a tested edge: when first announced and on the last day to buy'],
  ['setup', 'Strong numbers, quiet price', 'An Edge top-15 stock with strong fundamentals whose price hasn’t moved yet'],
  ['news', 'Announcements', 'New JSE notices on stocks you hold or that are quiet setups'],
];
export const alertPrefs = {
  get() { try { return { ...defaults, ...(JSON.parse(localStorage.getItem(KEY)) || {}) }; } catch (_) { return { ...defaults }; } },
  set(patch) { const v = { ...alertPrefs.get(), ...patch }; try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (_) { /* full */ } return v; },
};
function plugin() {
  const C = globalThis.Capacitor;
  if (!C?.isNativePlatform?.()) return null;
  try { return C.Plugins?.Alerts || C.registerPlugin?.('Alerts') || null; } catch (_) { return null; }
}
export const alerts = { status: null, supported: () => !!plugin() };
const wrap = async (fn) => { const P = plugin(); if (!P) { alerts.status = { unsupported: true }; return alerts.status; } try { alerts.status = await fn(P); } catch (e) { alerts.status = { ...(alerts.status || {}), error: String(e?.message || e) }; } return alerts.status; };
// positions: [{ id, sym, review }] — open positions only
export const alertsSync = (token, repo, positions) => { const p = alertPrefs.get(); const { enabled, ...kinds } = p; return wrap((P) => P.sync({ enabled, config: { token: token || '', repo, positions, ...kinds } })); };
export const alertsStatus = () => wrap((P) => P.status());
export const alertsPermission = () => wrap((P) => P.requestPermission());
export const alertsCheckNow = () => wrap((P) => P.checkNow());
export const alertsTest = () => wrap((P) => P.test());
