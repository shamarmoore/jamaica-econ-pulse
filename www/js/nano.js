// AI writing for the app: on-device Gemini Nano (Android AICore, nothing leaves the phone) and/or a low-cost cloud
// model through any OpenAI-compatible chat API with the user's own key (Gemini, Groq, OpenRouter, …).
// Results are cached so neither the AICore quota nor API credit is spent twice on the same question.
import { postJSON } from './util.js';
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
export async function nanoDownload(key) { const P = plugin(); if (!P) return null; try { nano.status = await P.download(key ? { key } : {}); } catch (e) { nano.status = { status: 'unavailable', error: String(e?.message || e) }; } return nano.status; }
export const nanoReady = () => nano.status?.status === 'available';
export const nanoLabel = (used) => { const k = used || nano.status?.current; return k ? `Gemini ${MODEL_NAME[k]}` : 'Gemini Nano'; };
export const nanoCached = (key) => cache[key]?.text || null;
export const nanoUsed = (key) => cache[key]?.used || null;
export const nanoForget = (key) => { delete cache[key]; saveCache(); };

// ---------- cloud model (user's own API key, stored only on this phone) ----------
const CLOUD_KEY = 'ep_cloudai_v1';
export const PROVIDERS = {
  gemini: { name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', model: 'gemini-3.5-flash-lite', keyUrl: 'https://aistudio.google.com/apikey',
    note: 'Has a free tier (Google may use free-tier prompts to improve its products). Paid Flash-Lite costs well under a US cent per explanation. If Google retires a model, the app switches to the one Google names.' },
  groq: { name: 'Groq', url: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys',
    note: 'Free tier with no card (rate-limited); very fast. Paid Llama 3.3 70B is about US$0.59 in / $0.79 out per million tokens.' },
  openrouter: { name: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions', model: 'google/gemini-3.5-flash-lite', keyUrl: 'https://openrouter.ai/keys',
    note: 'One key for hundreds of models. Models ending in “:free” cost nothing (50 requests a day until you’ve bought US$10 of credit).' },
  custom: { name: 'Other (OpenAI-compatible)', url: '', model: '', keyUrl: '', note: 'Any provider with an OpenAI-style /chat/completions endpoint (DeepSeek, Mistral, Together, a local server…).' },
};
const cloudDefaults = { provider: 'gemini', key: '', model: '', url: '', engine: 'auto', sharePositions: false };
export const cloud = {
  get() { try { return { ...cloudDefaults, ...(JSON.parse(localStorage.getItem(CLOUD_KEY)) || {}) }; } catch (_) { return { ...cloudDefaults }; } },
  set(patch) { const v = { ...cloud.get(), ...patch }; try { localStorage.setItem(CLOUD_KEY, JSON.stringify(v)); } catch (_) { /* full */ } return v; },
  ready() { const c = cloud.get(); return !!(c.key && (c.url || PROVIDERS[c.provider]?.url) && (c.model || PROVIDERS[c.provider]?.model)); },
  model() { const c = cloud.get(); return c.model || PROVIDERS[c.provider]?.model || ''; },
};
const engine = () => cloud.get().engine; // auto | cloud | nano
export const willUseCloud = () => engine() !== 'nano' && cloud.ready() && (engine() === 'cloud' || engine() === 'auto');
export const aiReady = () => (engine() !== 'nano' && cloud.ready()) || (engine() !== 'cloud' && nanoReady());
export const aiLabel = (used) => {
  if (used?.startsWith('cloud:')) return `${used.slice(6)} (cloud)`;
  if (used) return `Gemini ${MODEL_NAME[used] || 'Nano'} on your phone`;
  return willUseCloud() ? `${cloud.model()} (cloud)` : `Gemini ${MODEL_NAME[nano.status?.current] || 'Nano'} on your phone`;
};
async function cloudAsk(prompt, { maxTokens, temperature }) {
  const c = cloud.get(); const P = PROVIDERS[c.provider] || PROVIDERS.custom;
  const url = (c.url || P.url).trim(); let model = (c.model || P.model).trim();
  if (!c.key || !url || !model) throw new Error('Set the cloud AI provider, key and model under Sources → AI.');
  const headers = { Authorization: `Bearer ${c.key.trim()}` };
  if (c.provider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/shamarmoore/jamaica-econ-pulse'; headers['X-Title'] = 'JA Econ Pulse'; }
  const call = (m) => postJSON(url, {
    model: m, temperature,
    max_tokens: Math.max(maxTokens * 3, 1200), // headroom for models that think before answering; still well under a cent
    messages: [{ role: 'system', content: 'You are a careful, plain-spoken assistant inside a Jamaica Stock Exchange research app. Follow the user’s format exactly. Use only the facts provided.' }, { role: 'user', content: prompt }],
  }, headers, 60000);
  let j;
  try { j = await call(model); } catch (e) {
    // retired model: providers usually name the replacement ("…use models/gemini-3.5-flash-lite…") — switch and remember it
    const next = /use (?:models\/)?([a-z0-9][\w.:/-]*[a-z0-9])/i.exec(String(e.message || ''))?.[1];
    if (!(e.status === 404 || e.status === 400) || !next || next === model) throw e;
    j = await call(next); cloud.set({ model: next }); model = next;
  }
  const m = j?.choices?.[0]?.message;
  const text = (typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? m.content.map((x) => x.text || '').join('') : '').trim();
  if (!text) throw new Error(`${model} returned an empty answer${j?.choices?.[0]?.finish_reason ? ` (${j.choices[0].finish_reason})` : ''}.`);
  return { text, used: `cloud:${model}` };
}
export async function cloudTest() {
  const t0 = Date.now(); const r = await cloudAsk('Reply with exactly: OK — and nothing else.', { maxTokens: 20, temperature: 0 });
  return { ms: Date.now() - t0, text: r.text.slice(0, 60), model: r.used.slice(6) };
}

async function nanoGen(prompt, { maxTokens, temperature }) {
  const P = plugin(); if (!P) throw new Error('Gemini Nano only runs inside the Android app.');
  if (!nanoReady()) await nanoCheck(true);
  if (!nanoReady()) throw new Error(nano.status?.status === 'downloadable' ? 'Download the Gemini Nano model first (Sources → AI).' : 'Gemini Nano isn’t ready on this phone.');
  let r;
  try { r = await P.generate({ prompt, maxTokens, temperature }); } catch (e) { nanoCheck(true); throw new Error(friendly(String(e?.message || e))); }
  const text = String(r?.text || '').trim();
  if (!text) throw new Error('Gemini Nano returned nothing — try again.');
  if (r.fellBack) nanoCheck(true); // a model failed and was skipped: refresh what Sources shows
  return { text, used: r.used };
}

// Ask whichever engine the settings allow, falling back to the other one if it fails.
export async function nanoAsk(key, prompt, opts = {}) {
  const o = { maxTokens: 450, temperature: 0.2, ...opts };
  if (cache[key]?.text) return cache[key].text;
  const e = engine(); const order = [];
  if (e !== 'nano' && cloud.ready()) order.push(cloudAsk);
  if (e !== 'cloud' && plugin()) order.push(nanoGen);
  if (e === 'nano' && !plugin()) throw new Error('On-phone AI only runs inside the Android app — switch AI to Auto or Cloud under Sources.');
  if (!order.length) throw new Error('No AI is set up: add a cloud API key under Sources → AI, or use the Android app with Gemini Nano.');
  nano.busy.add(key); const errs = [];
  try {
    for (const fn of order) {
      try { const r = await fn(prompt, o); cache[key] = { text: r.text, used: r.used, at: Date.now() }; saveCache(); return r.text; } catch (err) { errs.push(String(err?.message || err)); }
    }
    throw new Error(errs.join(' · Then: '));
  } finally { nano.busy.delete(key); }
}


function friendly(m) {
  if (/INFERENCE_ERROR|Inference failed|COMPUTE_ERROR/i.test(m)) { const tried = [...m.matchAll(/(full|fast|stable):/g)].map((x) => MODEL_NAME[x[1]]); return `Gemini Nano failed (tried ${tried.join(', ') || 'the available model'}). Nano 4 Full is a buggy preview — under Sources → AI, download Nano 4 Fast and pick it.`; }
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

export function planPrompt(facts) {
  return `You are helping a careful private investor on the Jamaica Stock Exchange decide what to do this week. A research app has back-tested its signals on JSE history; every "Tested:" note says what that signal was worth after trading costs. The investor decides; you organise the evidence.
${RULES}
Only recommend an action when a Tested note with a positive verdict (edge) supports it, or for Edge-ranked picks (the Edge top 5 were the tested portfolio). Never turn an untested or "no reliable edge" item into a buy. Quote the numbers.
Write these sections, each line starting with "• ":
ACTIONS TO CONSIDER (at most 5, best first): symbol — buy / sell / hold / wait — the timing (dates) — the tested evidence in a few words — the main risk.
AVOID OR CAREFUL: up to 4 items with the reason.
IF YOU HOLD: up to 4 items for existing holders (dividends to keep for, suspensions, review dates).
JUDGEMENT CALLS (untested): up to 3 items that might be mispriced but have no tested edge — say why they are untested.
FACTS:
${facts}`;
}

export function digestPrompt(posts) {
  return `Here are recent Jamaica Stock Exchange announcements for stocks an investor holds or is watching.
${RULES}
Write at most 8 bullet points starting with "• ", most important first: name the stock symbol, what happened and the key number. Put insider buying or selling, weak or strong results and dividend changes first. Skip routine meeting notices unless nothing else happened.
ANNOUNCEMENTS:
${posts.map((p) => `[${p.d.slice(0, 10)}] ${p.s || '?'}: ${p.t}${p.x ? ` — ${p.x.slice(0, 220)}` : ''}`).join('\n')}`;
}
