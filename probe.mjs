import * as XLSX from 'xlsx';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u, bin) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': '*/*' } }); if (!r.ok) throw new Error(u + ' HTTP ' + r.status); return bin ? new Uint8Array(await r.arrayBuffer()) : r.text(); };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&#8217;/g,"'").replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g, ' ');
async function step(name, fn) { console.log(`\n===== ${name}`); try { await fn(); } catch (e) { console.log('ERR', e.message); } }
await step('GOJ xlsx', async () => {
  const wb = XLSX.read(await get('https://boj.org.jm/wp-content/uploads/2020/10/IR.GOJ.00.xlsx', true));
  console.log('sheets', wb.SheetNames);
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: '' });
  console.log('rows', rows.length);
  rows.slice(0, 14).forEach((r, i) => console.log('H' + i, JSON.stringify(r).slice(0, 300)));
  rows.slice(-6).forEach((r, i) => console.log('T' + i, JSON.stringify(r).slice(0, 300)));
});
await step('Remittance compact', async () => {
  const j = JSON.parse(await get('https://boj.org.jm/wp-json/wp/v2/media?search=Remittance-Bulletin&per_page=1&orderby=date&order=desc'));
  const pdf = await getDocument({ data: await get(j[0].source_url, true), useSystemFonts: true, verbosity: 0 }).promise;
  let txt = ''; for (let p = 1; p <= pdf.numPages; p++) { const c = await (await pdf.getPage(p)).getTextContent(); txt += c.items.map((i) => i.str).join(' ') + ' '; }
  const c = txt.replace(/\s+/g, '');
  const i = c.search(/Netremittanceinflows/i); console.log('pages', pdf.numPages, 'idx', i); console.log(c.slice(i, i + 700));
  const k = c.search(/Shareof|USA|UnitedStates/); console.log('SRC', c.slice(k - 100, k + 300));
});
await step('Petrojam', async () => { const t = strip(await get('https://www.petrojam.com/')); const i = t.indexOf("This Week"); console.log(t.slice(i, i + 900)); });
await step('currency-api JPY', async () => { const j = JSON.parse(await get('https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.min.json')); console.log(j.date, 'jpy', j.usd.jpy, 'jmd', j.usd.jmd); });
