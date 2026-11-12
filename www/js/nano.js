// On-device Gemini Nano (Android AICore) through the app's native "Nano" plugin.
// Nothing leaves the phone. Results are cached so the per-app AICore quota isn't spent twice on the same question.
const CACHE_KEY = 'ep_nano_v1';
let cache = {};
try { cache = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch (_) { cache = {}; }
const saveCache = () => {
  const ks = Object.keys(cache); if (ks.length > 120) ks.sort((a, b) => cache[a].at - cache[b].at).slice(0, ks.length - 120).forEach((k) => delete cache[k]);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch (_) { /* full */ }
};

function plugin() {
  const C = globalThis.Capacitor;
  if (!C?.isNativePlatform?.()) return null;
  try { return C.Plugins?.Nano || C.registerPlugin?.('Nano') || null; } catch (_) { return null; }
}

export const nano = { status: null, checking: null, busy: new Set() };

export async function nanoCheck(force = false) {
  const P = plugin();
  if (!P) { nano.status = { status: 'unsupported' }; return nano.status; }
  if (nano.checking && !force) return nano.checking;
  nano.checking = P.status({ force }).then((s) => { nano.status = s; return s; }).catch((e) => { nano.status = { status: 'unavailable', error: String(e?.message || e) }; return nano.status; }).finally(() => { nano.checking = null; });
  return nano.checking;
}
export async function nanoSetMode(mode) { const P = plugin(); if (!P) return null; try { nano.status = await P.setMode({ mode }); } catch (e) { nano.status = { ...(nano.status || {}), error: String(e?.message || e) }; } return nano.status; }
export const MODEL_NAME = { full: 'Nano 4 Full (preview)', fast: 'Nano 4 Fast (preview)', stable: 'Gemini Nano (stable)' };
export async function nanoDownload() { const P = plugin(); if (!P) return null; try { nano.status = await P.download(); } catch (e) { nano.status = { status: 'unavailable', error: String(e?.message || e) }; } return nano.status; }
export const nanoReady = () => nano.status?.status === 'available';
export const nanoLabel = (used) => { const k = used || nano.status?.current; return k ? `Gemini ${MODEL_NAME[k]}` : 'Gemini Nano'; };
export const nanoCached = (key) => cache[key]?.text || null;
export const nanoUsed = (key) => cache[key]?.used || null;
export const nanoForget = (key) => { delete cache[key]; saveCache(); };

export async function nanoAsk(key, prompt, { maxTokens = 450, temperature = 0.2 } = {}) {
  if (cache[key]?.text) return cache[key].text;
  const P = plugin(); if (!P) throw new Error('Gemini Nano only runs inside the Android app.');
  if (!nanoReady()) await nanoCheck(true);
  if (!nanoReady()) throw new Error(nano.status?.status === 'downloadable' ? 'Download the Gemini Nano model first (Sources → Gemini Nano).' : 'Gemini Nano isn’t ready on this phone.');
  nano.busy.add(key);
  try {
    let r;
    try { r = await P.generate({ prompt, maxTokens, temperature }); } catch (e) { nanoCheck(true); throw new Error(friendly(String(e?.message || e))); }
    const text = String(r?.text || '').trim();
    if (!text) throw new Error('Gemini Nano returned nothing — try again.');
    cache[key] = { text, used: r.used, at: Date.now() }; saveCache();
    if (r.fellBack) nanoCheck(true); // a model failed and was skipped: refresh what Sources shows
    return text;
  } finally { nano.busy.delete(key); }
}

function friendly(m) {
  if (/INFERENCE_ERROR|Inference failed|COMPUTE_ERROR/i.test(m)) return `Every Gemini Nano model on this phone failed to answer (${m.split('\n')[0].slice(0, 140)}). The preview models are still buggy — try again later, or pick “Stable” under Sources → Gemini Nano.`;
  if (/quota|BUSY|rate/i.test(m)) return 'Android’s on-device AI is busy or out of its allowance for this app — wait a minute and try again.';
  if (/background/i.test(m)) return 'Android only lets the on-device AI run while the app is open on screen.';
  return m;
}

// ---------- prompts (short: the model has a ~4,000-token window) ----------
const RULES = `Rules: use ONLY the facts given. Do not invent numbers, dates or news. Do not predict prices beyond the forecast given. Plain English, no hype, no "guaranteed". If facts conflict or are missing, say so.`;

export function explainPrompt(facts) {
  return `You help a careful private investor on the Jamaica Stock Exchange understand one stock from a research app's data. The app's signals were back-tested on JSE data; the "tested" notes say what each signal was worth.
${RULES}
Write exactly 5 short bullet points starting with "• ":
• What the numbers say overall (one line)
• The strongest reason in favour
• The biggest risk or warning
• What the tested rules suggest doing (buy / hold / avoid / wait), quoting the rule
• One thing to check before acting
FACTS:
${facts}`;
}

export function newsPrompt(sym, posts) {
  return `Summarise these Jamaica Stock Exchange announcements for ${sym} for an investor.
${RULES}
For each announcement write one line: "• [date] type — what happened, with the key numbers (dividend per share and dates, profit change, shares bought or sold and by whom)". Then one final line starting "Overall:" saying whether the news is mostly positive, negative or neutral for shareholders and why, in one sentence.
ANNOUNCEMENTS:
${posts.map((p) => `[${p.d.slice(0, 10)}] ${p.t}\n${p.x.slice(0, 500)}`).join('\n---\n')}`;
}

export function digestPrompt(posts) {
  return `Here are recent Jamaica Stock Exchange announcements for stocks an investor holds or is watching.
${RULES}
Write at most 8 bullet points starting with "• ", most important first: name the stock symbol, what happened and the key number. Put insider buying or selling, weak or strong results and dividend changes first. Skip routine meeting notices unless nothing else happened.
ANNOUNCEMENTS:
${posts.map((p) => `[${p.d.slice(0, 10)}] ${p.s || '?'}: ${p.t}${p.x ? ` — ${p.x.slice(0, 220)}` : ''}`).join('\n')}`;
}
