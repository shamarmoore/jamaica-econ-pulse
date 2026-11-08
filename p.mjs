const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r = await fetch('https://www.jamstockex.com/trading/trade-quotes/?market=50&date=2026-11-06', { headers: H }); const t = await r.text();
const links = [...new Set([...t.matchAll(/href="([^"]*instrument[^"]*)"/gi)].map((m) => m[1]))]; console.log('INSTR LINKS', links.length, links.slice(0, 5).join(' | '));
const txt = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ').replace(/\s+/g, ' ');
for (const u of links.filter((l) => /ncbfg|gk-|jbg|wisynco|kremi/i.test(l)).slice(0, 2)) {
  await sleep(2000); const r2 = await fetch(u.startsWith('http') ? u : `https://www.jamstockex.com${u}`, { headers: H }); const h = await r2.text(); const s = txt(h);
  console.log('== PAGE', r2.status, u, s.length);
  for (const k of ['P/E', 'EPS', 'Earnings', 'Dividend', 'Book', 'Market Cap', 'Shares', 'Financial', 'Revenue', 'Profit']) { const i = s.indexOf(k); if (i >= 0) console.log(k, '::', s.slice(Math.max(0, i - 80), i + 220)); }
  const pdfs = [...new Set([...h.matchAll(/href="([^"]+\.pdf)"/gi)].map((m) => m[1]))]; console.log('PDFS', pdfs.length, pdfs.slice(0, 8).join('\n'));
  const tabs = [...new Set([...h.matchAll(/href="([^"]*(?:financial|statement|report|tab=)[^"]*)"/gi)].map((m) => m[1]))]; console.log('TABS', tabs.slice(0, 15).join('\n'));
}
