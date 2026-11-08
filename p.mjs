const H = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36' };
const r2 = await fetch('https://www.jamstockex.com/trading/instruments/?instrument=13', { headers: H }); const h = await r2.text();
const i = h.indexOf('Shares Outstanding'); const j = h.indexOf('Corporate Actions');
const a = Math.max(0, h.lastIndexOf('<h1', i) > 0 ? h.lastIndexOf('<h1', i) : i - 6000);
console.log('RAWHTML_START'); console.log(h.slice(a, j + 3000).replace(/\s+/g, ' ').replace(/></g, '>\n<')); console.log('RAWHTML_END');
