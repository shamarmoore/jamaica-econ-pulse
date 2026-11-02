// Shared helpers. No DOM APIs here so the same code runs on the phone and in Node (smoke test).

const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

export async function getText(url, timeoutMs = 25000) {
  try { return await getTextOnce(url, timeoutMs); } catch (e) {
    // one retry for temporary server errors / dropped connections
    if (/HTTP 4\d\d/.test(String(e.message))) throw e;
    await new Promise((r) => setTimeout(r, 2500));
    return getTextOnce(url, timeoutMs);
  }
}

async function getTextOnce(url, timeoutMs) {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;
  const req = fetch(url, {
    headers: isNode ? { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/xml,application/json,text/csv,*/*' } : { 'Accept': '*/*' },
  }).then(async (r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text();
  });
  const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('timed out')), timeoutMs));
  return Promise.race([req, timer]);
}

export async function getJSON(url, timeoutMs) {
  const t = await getText(url, timeoutMs);
  // CapacitorHttp may already hand back parsed JSON as a string of an object; handle both.
  if (typeof t === 'object') return t;
  return JSON.parse(t);
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…' };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}

export function htmlToText(html) {
  return decodeEntities(String(html)
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';
export const MONTH_YEAR = new RegExp(`(?:${MONTHS})\\s+\\d{4}`, 'i');
export const DAY_MONTH_YEAR = new RegExp(`\\d{1,2}\\s+(?:${MONTHS})\\s+\\d{4}`, 'i');

// Find `label` in text and return the window of text that follows it.
export function after(text, label, span = 160) {
  const re = label instanceof RegExp ? label : new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const m = re.exec(text);
  if (!m) return null;
  return text.slice(m.index + m[0].length, m.index + m[0].length + span);
}

export function firstNumber(s, { percent = false } = {}) {
  if (!s) return null;
  const re = percent ? /(-?\d+(?:\.\d+)?)\s*%/ : /(-?\d[\d,]*(?:\.\d+)?)/;
  const m = re.exec(s);
  return m ? parseFloat(m[1].replace(/,/g, '')) : null;
}

export function parseRSS(xml) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks) {
    const get = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(b);
      if (!m) return '';
      return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
    };
    items.push({
      title: htmlToText(get('title')),
      link: decodeEntities(get('link')).trim(),
      pubDate: get('pubDate'),
      description: get('description'),
    });
  }
  return items;
}

export function isoDaysAgo(days, from = new Date()) {
  const d = new Date(from.getTime() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

// Series helpers: series = [{date:'YYYY-MM-DD', value:Number}] ascending
export function last(series) { return series && series.length ? series[series.length - 1] : null; }
export function valueAtOrBefore(series, isoDate) {
  if (!series) return null;
  let best = null;
  for (const p of series) { if (p.date <= isoDate) best = p; else break; }
  return best;
}
export function changeOver(series, days, mode = 'pct') {
  const l = last(series);
  if (!l) return null;
  const ref = valueAtOrBefore(series, isoDaysAgo(days, new Date(l.date + 'T00:00:00Z')));
  if (!ref || ref.value == null || ref === l) return null;
  return mode === 'pct' ? ((l.value - ref.value) / Math.abs(ref.value)) * 100 : l.value - ref.value;
}
export function yoySeries(series) {
  // monthly index -> YoY % series
  const out = [];
  for (let i = 12; i < series.length; i++) {
    out.push({ date: series[i].date, value: ((series[i].value / series[i - 12].value) - 1) * 100 });
  }
  return out;
}

export function fmt(v, d = 1) {
  if (v == null || Number.isNaN(v)) return '—';
  return Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
export function signed(v, d = 1, unit = '%') {
  if (v == null || Number.isNaN(v)) return '—';
  return (v > 0 ? '+' : v < 0 ? '−' : '±') + fmt(Math.abs(v), d) + unit;
}
