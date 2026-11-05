const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const get = async (u) => { const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/json,*/*' }, redirect: 'follow' }); return { status: r.status, url: r.url, text: await r.text() }; };
const strip = (h) => h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const urls = [
  'https://ryanmartell.realtyhd.com/', 'https://www.realtyhd.com/',
  'https://www.properstar.com/jamaica/buy', 'https://www.properstar.com/jamaica/saint-thomas/buy',
  'https://www.coldwellbankerjamaica.com/', 'https://www.century21jamaica.com/', 'https://www.jamaicasothebysrealty.com/eng/sales/jam',
  'https://www.kellerwilliamsjamaica.com/', 'https://www.remax-jamaica.com/', 'https://www.realtorsassociationjamaica.com/',
  'https://www.jamaicahomes.com/', 'https://jamaicahomes.com/listings', 'https://www.gleanerclassifieds.com/', 'https://www.jamaicaobserver.com/classifieds/',
  'https://www.realtyonegroupjamaica.com/', 'https://www.propertyadsja.com/', 'https://www.mlsjamaica.com/', 'https://www.jamaicarealty.com/',
];
for (const u of urls) {
  try {
    const r = await get(u); const t = strip(r.text);
    const prices = (t.match(/(?:J\$|JMD\s?\$?|US\$|USD\s?\$?)\s?[\d,]{6,}/g) || []).slice(0, 4);
    const listingLinks = [...new Set((r.text.match(/href="[^"]*(listing|propert|for-sale|search)[^"]*"/gi) || []))].slice(0, 8);
    console.log(`\n===== ${u} -> ${r.status} ${r.url} len ${r.text.length}\n  title: ${(r.text.match(/<title>([^<]*)/i) || [])[1]}\n  prices: ${prices.join(' | ')}\n  links: ${listingLinks.join(' ')}\n  xposure/iframe: ${(r.text.match(/(xposureapp|realtyserver|idx|iframe[^>]{0,120})/gi) || []).slice(0, 4).join(' | ')}\n  api: ${[...new Set((r.text.match(/["'](https?:\/\/[^"']*api[^"']*|\/api\/[^"']*)["']/gi) || []))].slice(0, 5).join(' ')}`);
  } catch (e) { console.log(`\n===== ${u} ERR ${e.message}`); }
}
