const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (u) => { const r = await fetch(u, { headers: { 'user-agent': UA } }); const t = await r.text(); console.log('#####', u, r.status, 'total', r.headers.get('x-wp-total'), r.headers.get('x-wp-totalpages')); return t; };
let t = await get('https://www.jamstockex.com/wp-json/wp/v2/posts?per_page=5&_fields=id,date,title,link,excerpt,categories,tags');
console.log('J ' + t.slice(0, 2500));
const cats = new Set(); for (const p of JSON.parse(t)) p.categories.forEach((c) => cats.add(c));
await sleep(2500);
for (const c of cats) { t = await get(`https://www.jamstockex.com/wp-json/wp/v2/posts?categories=${c}&per_page=2&_fields=id,date,title`); console.log('J ' + t.slice(0, 400)); await sleep(2500); }
t = await get('https://www.jamstockex.com/wp-json/wp/v2/posts?search=connected%20party%20purchased&per_page=3&_fields=id,date,title,excerpt,categories');
console.log('J ' + t.slice(0, 1500));
await sleep(2500);
t = await get('https://www.jamstockex.com/wp-json/wp/v2/posts?per_page=100&page=2&_fields=id,date,title,categories');
console.log('J size', t.length);
