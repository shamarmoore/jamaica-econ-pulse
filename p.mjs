const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
const T = (s) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;|&amp;/g, ' ').replace(/\s+/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let h = await (await fetch('https://www.jamstockex.com/trading/trade-quotes/?market=50&date=2026-11-06', { headers: H })).text();
const tabs = h.split(/<table/i).slice(1);
tabs.forEach((tb, k) => { const rows = (tb.match(/<tr[\s\S]*?<\/tr>/gi) || []); console.log(`TABLE ${k} rows ${rows.length}`); rows.slice(0, k === 0 ? 20 : 4).forEach((r) => console.log('   ', (r.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) || []).map(T).join(' | ').slice(0, 300))); });
const mk = [...h.matchAll(/href="([^"]*market=\d+[^"]*)"[^>]*>([^<]+)</g)].map((m) => `${T(m[2])} => ${m[1]}`); console.log('MARKETS', [...new Set(mk)].slice(0, 12).join(' || '));
for (const u of ['https://boj.org.jm/market/foreign-exchange/daily-fx-spot-trading-summary/', 'https://boj.org.jm/market/foreign-exchange/average-exchange-rates/', 'https://boj.org.jm/market/foreign-exchange/search-fx-rates-volumes/']) {
  await sleep(1500); try { const r = await fetch(u, { headers: H }); const x = await r.text(); console.log('BOJ', r.status, u, T(x).slice(0, 300)); console.log('  LINKS', [...new Set([...x.matchAll(/href="([^"]+\.(?:xlsx?|csv|pdf))"/gi)].map((m) => m[1]))].slice(0, 12).join(' | ')); console.log('  FORMS', [...x.matchAll(/<form[^>]*>/gi)].map((m) => m[0]).slice(0, 4).join(' | '), [...x.matchAll(/name="([^"]+)"/g)].map((m) => m[1]).slice(0, 20).join(',')); } catch (e) { console.log('BOJ ERR', u, e.message); }
}
