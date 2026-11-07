const ids = ['M.W00.POILBRE.USD', 'M.W00.PNGASUS.USD', 'M.W00.PWHEAMT.USD', 'M.W00.PMAIZMT.USD', 'M.W00.PALUM.USD', 'M.W00.PFOOD.IX'].map((c) => `IMF/PCPS/${c}`).join(',');
const r = await fetch(`https://api.db.nomics.world/v22/series?series_ids=${ids}&observations=1`);
const j = await r.json(); console.log(r.status, j.series?.num_found);
for (const d of j.series?.docs || []) console.log(d.series_code, d.indexed_at, d.period?.slice(-3), d.value?.slice(-3));
