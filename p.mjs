const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
const T = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
// 1) trade quotes table header (bid/ask?)
let h = await (await fetch('https://www.jamstockex.com/trading/trade-quotes/?market=50&date=2026-11-06', { headers: H })).text();
const tb = h.split(/<table/i)[1] || ''; const rows = (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []);
console.log('QUOTE HEADER:', (rows[0].match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(T).join(' | '));
console.log('QUOTE ROW:', (rows[1].match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(T).join(' | '));
console.log('MARKET HEADINGS:', [...h.matchAll(/<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/gi)].map((m) => T(m[1])).filter(Boolean).slice(0, 30).join(' || '));
// 2) instrument page header fields
await new Promise((r) => setTimeout(r, 2500));
h = await (await fetch('https://www.jamstockex.com/trading/instruments/?instrument=13', { headers: H })).text();
const t = T(h); const i = t.indexOf('Instrument Summary'); console.log('INSTR HEAD:', t.slice(i, i + 900));
for (const k of ['Sector', 'Industry', 'Market', 'Index', 'Free Float', 'Float']) { const j = t.indexOf(k); console.log('KEY', k, j >= 0 ? t.slice(Math.max(0, j - 60), j + 140) : '-'); }
// 3) index pages
for (const u of ['https://www.jamstockex.com/market-data/indices/', 'https://www.jamstockex.com/trading/indices/']) { await new Promise((r) => setTimeout(r, 2500)); try { const r = await fetch(u, { headers: H }); const x = T(await r.text()); console.log('IDX', r.status, u, x.slice(0, 600)); } catch (e) { console.log('IDX ERR', u, e.message); } }
