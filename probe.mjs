const H = { headers: { Accept: 'application/json' } };
async function show(u) { try { const r = await fetch(u, H); const t = await r.text(); console.log('==', r.status, u.slice(0, 140)); return t; } catch (e) { console.log('ERR', u, e.message); return ''; } }
let t = await show('https://api.db.nomics.world/v22/datasets/IMF/PCPS?limit=1');
console.log(t.slice(0, 600));
const dims = encodeURIComponent(JSON.stringify({ commodity: ['POILBRE', 'PNGASUS', 'PWHEAMT', 'PMAIZMT', 'PALUM', 'PFOOD'] }));
t = await show(`https://api.db.nomics.world/v22/series/IMF/PCPS?dimensions=${dims}&observations=1&limit=20`);
try { const j = JSON.parse(t); console.log(j.series?.num_found); for (const d of j.series?.docs || []) console.log(d.series_code, JSON.stringify(d.dimensions), d.period?.slice(-2), d.value?.slice(-2)); } catch (e) { console.log(t.slice(0, 400)); }
t = await show('https://api.db.nomics.world/v22/series/IMF/PCPS?q=brent&observations=0&limit=5'); try { const j = JSON.parse(t); for (const d of j.series?.docs || []) console.log(d.series_code, d.series_name); } catch (_) {}
t = await show('https://api.stlouisfed.org/fred/series/observations?series_id=DGS10&file_type=json'); console.log(t.slice(0, 200));
