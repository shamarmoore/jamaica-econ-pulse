const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' } }); return { status: r.status, text: await r.text() }; };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
async function step(n, f) { console.log(`\n===== ${n}`); try { await f(); } catch (e) { console.log('ERR', e.message); } }
await step('xp-search.js', async () => { const { text } = await get('https://realtyhd.com/XposurePublicIncludes/client/js/xp-search.js?v=1'); console.log(text.length); console.log([...new Set(text.match(/(https?:\/\/[^"'\s]+|["'][^"'\s]*(search|Search|listing)[^"'\s]*["'])/g) || [])].slice(0, 30).join('\n')); console.log(text.slice(0, 1500)); });
await step('xposure public search', async () => { const { status, text } = await get('https://raj.xposureapp.com/jamaica/userId_23781'); console.log(status, text.length, strip(text).slice(0, 700)); console.log([...new Set(text.match(/["'][^"'\s]*(search|Search|ajax|json)[^"'\s]*["']/g) || [])].slice(0, 30).join('\n')); });
await step('propertyadsja parish select', async () => {
  const { text } = await get('https://www.propertyadsja.com/search.asp');
  const i = text.indexOf('St. Thomas'); console.log(text.slice(i - 1500, i + 200).replace(/\s+/g, ' '));
  console.log('paging', [...new Set(text.match(/href="[^"]*search\.asp\?[^"]*"/g) || [])].slice(0, 8));
});
await step('gleaner corp area houses', async () => {
  const { text } = await get('https://www.gleanerclassifieds.com/marketplace/category/550-real-estate-for-sale/559-sale-house-apts-corp-area');
  const blocks = text.split('<div id="advert_').slice(1, 5);
  for (const b of blocks) console.log('AD', strip(b).slice(0, 400), '| PRICE', (b.match(/sr_ad_price">([^<]*)</) || [])[1]);
  console.log('pager', [...new Set(text.match(/(changePage[^)]*\)|page=\d+|pageNumber[^"&]*)/gi) || [])].slice(0, 8));
});
