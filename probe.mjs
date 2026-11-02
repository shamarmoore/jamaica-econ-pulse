import * as XLSX from 'xlsx';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u, bin) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return bin ? new Uint8Array(await r.arrayBuffer()) : r.text(); };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#8211;/g,'-').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g, ' ');
async function step(name, fn) { console.log(`\n===== ${name}`); try { await fn(); } catch (e) { console.log('ERR', e.message); } }

for (const f of ['2020/10/IR.CB.02.xls', '2020/10/IR.CB.00.xls']) await step('XLS ' + f, async () => {
  const wb = XLSX.read(await get('https://boj.org.jm/wp-content/uploads/' + f, true));
  console.log('sheets', wb.SheetNames);
  for (const sn of wb.SheetNames.slice(0, 2)) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '' });
    console.log('--', sn, 'rows', rows.length);
    rows.slice(0, 12).forEach((r, i) => console.log('H' + i, JSON.stringify(r).slice(0, 400)));
    rows.slice(-8).forEach((r, i) => console.log('T' + i, JSON.stringify(r).slice(0, 400)));
  }
});
await step('GOJ rates page', async () => { const h = await get('https://boj.org.jm/statistics/interest-rates/government-of-jamaica-rates/'); console.log((h.match(/href="[^"]+\.(xlsx?|pdf)"/gi) || []).join('\n')); });
await step('WP media remittance', async () => {
  const j = JSON.parse(await get('https://boj.org.jm/wp-json/wp/v2/media?search=Remittance-Bulletin&per_page=3&orderby=date&order=desc'));
  j.forEach((m) => console.log(m.date, m.source_url));
  const pdf = await getDocument({ data: await get(j[0].source_url, true), useSystemFonts: true }).promise;
  let txt = ''; for (let p = 1; p <= Math.min(2, pdf.numPages); p++) { const c = await (await pdf.getPage(p)).getTextContent(); txt += c.items.map((i) => i.str).join(' ') + ' '; }
  console.log('TEXT', txt.replace(/\s+/g, ' ').slice(0, 1500));
  console.log('COMPACT', txt.replace(/\s+/g, '').slice(0, 900));
});
await step('WP posts CD auction', async () => {
  const j = JSON.parse(await get('https://boj.org.jm/wp-json/wp/v2/posts?search=Auction%20Results&per_page=3'));
  j.forEach((p) => console.log(p.date, strip(p.title.rendered), '|', strip(p.content.rendered).slice(0, 700)));
});
await step('WP posts T-bill', async () => {
  const j = JSON.parse(await get('https://boj.org.jm/wp-json/wp/v2/posts?search=Treasury%20Bill&per_page=3'));
  j.forEach((p) => console.log(p.date, strip(p.title.rendered), '|', strip(p.content.rendered).slice(0, 500)));
});
await step('Petrojam', async () => { const t = strip(await get('https://www.petrojam.com/')); const i = t.indexOf('Gasolene'); console.log(t.slice(Math.max(0, i - 400), i + 700)); });
await step('Tourism analytics', async () => { const t = strip(await get('https://www.tourismanalytics.com/jamaica-statistics.html')); console.log((t.match(/[^.]*(stopover arrivals|passenger movements)[^.]*\./gi) || []).slice(0, 6).join('\n')); });
await step('FRED extras', async () => {
  for (const id of ['PALUMUSDM', 'VIXCLS', 'BAMLEMHBHYCRPIOAS', 'PCU483111483111', 'IRSTCB01CAM156N', 'IRSTCB01GBM156N', 'LRUNTTTTCAM156S', 'LRUNTTTTGBM156S', 'CUSR0000SETA02', 'IR3TIB01CAM156N', 'BOERUKM']) {
    try { const t = (await get(`https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2025-01-01`)).trim().split('\n'); console.log(id, t.length, t.at(-1)); } catch (e) { console.log(id, 'ERR', e.message); }
  }
});
await step('currency-api JPY', async () => { const j = JSON.parse(await get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json')); console.log(j.date, 'jpy', j.usd.jpy, 'jmd', j.usd.jmd); });
