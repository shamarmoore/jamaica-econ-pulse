const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u, o = {}) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*', ...(o.headers || {}) }, method: o.method || 'GET', body: o.body }); return { status: r.status, text: await r.text() }; };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function step(n, f) { console.log(`\n===== ${n}`); try { await f(); } catch (e) { console.log('ERR', e.message); } }
await step('realtyhd scripts', async () => {
  const { text: h } = await get('https://ryanmartell.realtyhd.com/');
  console.log('script srcs', (h.match(/<script[^>]+src="[^"]+"/g) || []).join('\n'));
  for (const kw of ['ajax', 'url:', 'Search', 'getJSON', 'fetch(', 'XposurePublic', 'listingsUrl', 'searchUrl', '.php', 'query']) {
    let idx = -1, n = 0; while ((idx = h.indexOf(kw, idx + 1)) >= 0 && n < 3) { console.log(`[${kw}]`, h.slice(Math.max(0, idx - 150), idx + 250).replace(/\s+/g, ' ')); n++; }
  }
  const first = h.indexOf('raj.xposureapp.com/listing/'); console.log('CARD', h.slice(first - 1200, first + 1500).replace(/\s+/g, ' '));
});
await step('gleaner lots island', async () => {
  const { status, text: h } = await get('https://www.gleanerclassifieds.com/marketplace/category/550-real-estate-for-sale/574-sale-lots-res-comm-islan');
  console.log(status, h.length); const t = strip(h); const i = t.search(/J\$|\$\s?\d/); console.log(t.slice(Math.max(0, i - 600), i + 1500));
  const ad = h.indexOf('/marketplace/ad'); console.log('AD HTML', h.slice(Math.max(0, ad - 800), ad + 1200).replace(/\s+/g, ' '));
  console.log('cats', [...new Set(h.match(/\/marketplace\/category\/550-real-estate-for-sale\/[^"']+/g) || [])].join('\n'));
  console.log('paging', [...new Set(h.match(/href="[^"]*page[^"]*"/gi) || [])].slice(0, 6));
});
await step('propertyadsja search form', async () => {
  const { text: h } = await get('https://www.propertyadsja.com/');
  const f = h.indexOf('<form'); console.log(h.slice(f, f + 3000).replace(/\s+/g, ' '));
});
await step('propertyadsja search st thomas', async () => {
  for (const u of ['https://www.propertyadsja.com/search.asp?SearchSB=5', 'https://www.propertyadsja.com/search.asp?Parish=St.%20Thomas']) {
    const { status, text: h } = await get(u); const t = strip(h); console.log(u, status, h.length); const i = t.search(/JMD/); console.log(t.slice(Math.max(0, i - 500), i + 1200));
    const c = h.indexOf('JMD'); console.log('HTML', h.slice(Math.max(0, c - 1500), c + 500).replace(/\s+/g, ' '));
  }
});
