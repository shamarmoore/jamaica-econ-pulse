const H = { 'User-Agent': 'Mozilla/5.0 (compatible; JAEconPulse research)' };
const tries = [];
const mon = ['Jan','Feb','Mar','Apr','May','June','July','Aug','Sept','Oct','Nov','Dec'];
const mon2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
for (const [y, m, d] of [[2026, 10, 6], [2026, 10, 5], [2025, 10, 6], [2024, 5, 10], [2023, 1, 9], [2021, 3, 10], [2019, 0, 9]])
  for (const M of new Set([mon[m], mon2[m]])) for (const dir of [`Daily%20Stock%20Prices/${y}/`, 'Daily%20Stock%20Prices/']) tries.push(`https://www.jmmb.com/sites/default/files/Jamaica/Attachments/${dir}Stock_Prices_${M}_${d}_${y}.pdf`);
for (const u of tries) { try { const r = await fetch(u, { headers: H, method: 'HEAD' }); console.log(r.status, r.headers.get('content-type'), u); } catch (e) { console.log('ERR', u, e.message); } }
for (const u of ['https://www.jmmb.com/robots.txt', 'https://www.jmmb.com/research', 'https://jm.jmmb.com/research/daily-stock-prices']) { try { const r = await fetch(u, { headers: H }); const t = await r.text(); console.log('==', r.status, u); console.log(t.slice(0, 1500)); const links = [...t.matchAll(/href="([^"]*(?:Stock_Prices|stock-prices|Daily)[^"]*)"/gi)].map((m) => m[1]); console.log('LINKS', links.slice(0, 20).join('\n')); } catch (e) { console.log('ERR', u, e.message); } }
