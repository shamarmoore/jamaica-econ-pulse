const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*' } }); return { status: r.status, text: await r.text() }; };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function step(n, f) { console.log(`\n===== ${n}`); try { await f(); } catch (e) { console.log('ERR', e.message); } }
await step('autoadsja selects', async () => {
  const { text } = await get('https://www.autoadsja.com/search.asp?SearchVehicleMake=20');
  console.log('selects', (text.match(/<select[^>]*name="[^"]+"/g) || []).join(' | '));
  const t = text.indexOf('>Toyota<'); console.log('toyota opt', text.slice(t - 40, t + 10));
  const m = text.indexOf('name="SearchVehicleModel"'); console.log('model sel', m >= 0 ? text.slice(m, m + 1500).replace(/\s+/g, ' ') : 'none');
  const s = text.indexOf('Sort results by'); console.log('sort', text.slice(s - 600, s + 800).replace(/\s+/g, ' '));
  console.log('found', (strip(text).match(/Cars? for sale[^-]*-\s*\d+ found/i) || [])[0]);
  const c = text.indexOf('class="thumbnail"'); console.log('CARD', text.slice(c - 200, c + 2200).replace(/\s+/g, ' '));
  console.log('paging', [...new Set(text.match(/href="[^"]*search\.asp\?[^"]*(Page|page|pg|start)[^"]*"/g) || [])].slice(0, 5), (text.match(/>\s*Next\s*</g) || []).length, text.slice(text.indexOf('>Next<') - 300, text.indexOf('>Next<') + 20).replace(/\s+/g, ' '));
});
await step('JSE trade quotes table', async () => {
  const { text } = await get('https://www.jamstockex.com/trading/trade-quotes/?market=50&date=2026-11-04');
  const tables = text.split('<table').slice(1); console.log('tables', tables.length);
  tables.slice(0, 4).forEach((tb, i) => { const head = (tb.match(/<th[^>]*>([\s\S]*?)<\/th>/g) || []).map((h) => strip(h)).join(' | '); const row = (tb.match(/<tr[\s\S]*?<\/tr>/g) || [])[1] || ''; console.log(`T${i} HEAD: ${head.slice(0, 400)}\n   ROW: ${strip(row).slice(0, 300)}\n   rows: ${(tb.match(/<tr/g) || []).length}`); });
});
