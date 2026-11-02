import * as XLSX from 'xlsx';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u, bin) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return bin ? new Uint8Array(await r.arrayBuffer()) : r.text(); };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#8217;/g,"'").replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g, ' ');
async function step(name, fn) { console.log(`\n===== ${name}`); try { await fn(); } catch (e) { console.log('ERR', e.message); } }
const around = (t, re, n = 300) => { const m = re.exec(t); return m ? t.slice(Math.max(0, m.index - 80), m.index + n) : 'NO MATCH'; };
await step('caribbeanjobs', async () => { const h = await get('https://www.caribbeanjobs.com/Jamaica'); const t = strip(h); console.log(around(t, /\d[\d,]*\s+(jobs|Jobs|vacancies)/)); console.log((t.match(/[\d,]+\s+(?:Jobs|jobs)[^.]{0,60}/g) || []).slice(0, 5)); });
await step('jamstockex home', async () => { const t = strip(await get('https://www.jamstockex.com/')); console.log(around(t, /Combined|JSE Index|Main Index/i, 600)); });
await step('jamstockex indices', async () => { const t = strip(await get('https://www.jamstockex.com/market-data/indices/')); console.log(around(t, /Combined|JSE Index|Main/i, 900)); });
await step('jamstockex wp-json', async () => { const j = JSON.parse(await get('https://www.jamstockex.com/wp-json/wp/v2/posts?search=index&per_page=3')); j.forEach((p) => console.log(p.date, strip(p.title.rendered))); });
await step('gleaner jse summary', async () => { const x = await get('https://jamaica-gleaner.com/feed/business.xml'); const t = strip(x); console.log(around(t, /JSE (Combined|Main|Index)/i, 500)); });
await step('gleaner search jse summary', async () => { const t = strip(await get('https://jamaica-gleaner.com/business/jse-summary')); console.log(around(t, /Combined Index/i, 500)); });
await step('BOJ FX deposit xls', async () => {
  const wb = XLSX.read(await get('https://boj.org.jm/wp-content/uploads/2021/06/IR.CB.01-Commercial-Banks-Foreign-Currency-Deposit-Rates.xls', true));
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  rows.slice(8, 14).forEach((r, i) => console.log('H', JSON.stringify(r).slice(0, 400))); rows.slice(-3).forEach((r) => console.log('T', JSON.stringify(r).slice(0, 400)));
});
await step('BOJ building societies rates page', async () => { const h = await get('https://boj.org.jm/statistics/interest-rates/building-societies-interest-rates/'); console.log((h.match(/href="[^"]+\.(xlsx?)"/gi) || []).join('\n')); });
await step('BOJ commercial banks data page', async () => { const h = await get('https://boj.org.jm/statistics/financial-sector/commercial-banks/'); console.log((h.match(/href="[^"]+\.(xlsx?)"[^>]*>[^<]{0,80}/gi) || []).slice(0, 25).join('\n')); });
await step('NHT', async () => { for (const u of ['https://www.nht.gov.jm/', 'https://www.nht.gov.jm/interest-rates', 'https://www.nht.gov.jm/loans/interest-rates']) { try { const t = strip(await get(u)); console.log(u, '::', around(t, /Interest Rate|income band|per week/i, 500)); } catch (e) { console.log(u, 'ERR', e.message); } } });
await step('jamaicahomes', async () => { const t = strip(await get('https://www.jamaicahomes.com/')); console.log(around(t, /average|median|listings/i, 400)); });
await step('FRED SP500 DTB3', async () => { for (const id of ['SP500', 'DTB3', 'NASDAQCOM']) { const t = (await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2026-09-01`)).trim().split('\n'); console.log(id, t.length, t.at(-1)); } });
await step('gold', async () => { const j = JSON.parse(await get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json')); console.log('xau', j.usd.xau, '=> USD/oz', 1 / j.usd.xau); });
