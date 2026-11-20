// Notifications: hands the phone's background check what it needs (read-only GitHub token, the symbols and review
// dates of your positions, which alert kinds are on). The check itself is native (AlertsWorker) so it runs with the
// app closed. Position sizes and prices never leave the WebView's storage.
const KEY = 'ep_alerts_v1';
const defaults = { enabled: false, sell: true, review: true, buy: true, dividend: true, news: true };
export const ALERT_KINDS = [
  ['buy', 'New on the buy list', 'A stock you don’t hold joins the Edge buy list, with the limit price to use'],
  ['sell', 'Sell signals', 'A holding slips out of the Edge keep band (top 20), or its trading is suspended'],
  ['review', '3-month reviews', 'On the day a position’s review is due, with the keep-or-sell answer from its Edge rank'],
  ['dividend', 'Dividend buy-by dates', 'Tested high-yield dividends on stocks the Edge score also ranks in its top 20'],
  ['news', 'Announcements', 'New JSE notices and weak results on stocks you hold or that are on the buy list'],
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
