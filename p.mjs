const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const u of ['https://www.jamstockex.com/category/trading-in-shares/', 'https://www.jamstockex.com/category/trading-in-shares/page/60/', 'https://www.jamstockex.com/wp-json/wp/v2/categories?search=trading', 'https://www.jamstockex.com/wp-json/wp/v2/posts?per_page=3&_fields=id,date,title,link,excerpt,categories,tags']) {
  const r = await fetch(u, { headers: { 'user-agent': UA } }); const t = await r.text();
  console.log('=====', u, r.status, t.length);
  if (u.includes('wp-json')) { console.log(t.slice(0, 3000)); console.log('TOTAL', r.headers.get('x-wp-total'), r.headers.get('x-wp-totalpages')); }
  else {
    const i = t.indexOf('<article'); console.log(t.slice(i, i + 3500).replace(/\s+/g, ' '));
    const m = t.match(/page\/(\d+)\/?["']/g); console.log('pages', m && m.slice(-5));
  }
  await sleep(3000);
}
